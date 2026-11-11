#!/usr/bin/env python3
"""Run one CLI command and privately record latency and output byte counts.

Usage: python scripts/agent-eval-cli.py --record-dir .harmony-agent/eval -- <CLI args>
Raw output stays local. This wrapper never estimates model tokens or retries.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

MUTATIONS = {"press", "fill", "scroll", "back", "open"}
PLAN_COMMANDS = {"run", "execute"}
TARGET_ACTIONS = {"press", "fill", "scroll"}
COMMAND_NAMES = {"execute", "start", "claim", "release", "run", "report", "inspect", "doctor", "devices", "attach", "detach",
                 "open", "observe", "find", "press", "fill", "scroll", "back", "wait", "screenshot",
                 "capabilities", "help", "schema"}
STATUSES = {"passed", "failed", "unknown", "completed", "acknowledged", "not_requested",
            "not_run", "running", "cancelled", "budget_exhausted", "yielded", "started"}
PROFILE_STAGES = {"preflight", "capture", "normalize", "statePersistence", "evidencePersistence",
                  "projection", "nativeDump", "hdcTransfer", "transport", "layoutDecode",
                  "jsonSerialization", "stdoutWrite", "requestValidation", "cliStartup"}
PROFILE_COUNTS = {"captures", "reusedFrames", "projections", "actions", "targetReuses",
                  "targetCaptures", "conditionReuses", "conditionCaptures", "targetFrameRequests",
                  "reusedTargetFrames", "conditionFrameRequests", "reusedConditionFrames", "beforeConditionChecks"}
CAPTURE_STAGES = {"hdcProcess", "decodeAndValidation", "shellReceiptValidation", "layoutParseAndValidation"}
PLAN_BOUNDARIES = ("known_sequence", "unknown_page", "human_decision", "required_screenshot",
                   "goal_reached", "budget_limit", "recovery", "other")
EXECUTION_MODES = ("cold_setup", "warm_continue")


def opaque_id(value):
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", value):
        raise argparse.ArgumentTypeError("Use an opaque ID of 1-128 ASCII letters, digits, '.', '_', ':' or '-'.")
    return value


def number(value):
    return value if type(value) in (int, float) and 0 <= value < float("inf") else None


def status(value):
    return value if isinstance(value, str) and value in STATUSES else None


def mapping(value):
    return value if isinstance(value, dict) else {}


def result_summary(payload, command):
    """Copy measured numbers and known states, never UI values or request text."""
    success = payload.get("success") if type(payload.get("success")) is bool else None
    error = mapping(payload.get("error"))
    details = mapping(payload.get("data") if success else error.get("details"))
    action = mapping(details.get("action"))
    code = error.get("code")
    profile = mapping(details.get("profile"))
    counters = mapping(details.get("counters")) if command in PLAN_COMMANDS else {}
    stages = mapping(profile.get("stagesMs"))
    counts = mapping(profile.get("counts"))
    breakdown = mapping(profile.get("captureBreakdown"))
    capture_stages = mapping(breakdown.get("stagesMs"))
    cleanup_status = mapping(details.get("sessionCleanup")).get("status")
    commands, reused_targets = [], 0
    if command in PLAN_COMMANDS:
        for step in details.get("steps", []) if isinstance(details.get("steps"), list) else []:
            step = mapping(step)
            if isinstance(step.get("command"), str) and step["command"] in MUTATIONS:
                commands.append(step["command"])
                if step["command"] in TARGET_ACTIONS and mapping(step.get("result")).get("observationSource") == "reused":
                    reused_targets += 1
        if details.get("format") == "harmony-run-decision/1":
            sequence = mapping(details.get("stepsSummary")).get("actionCommands")
            if isinstance(sequence, list) and all(isinstance(item, str) and item in MUTATIONS for item in sequence):
                commands = list(sequence)
    elif command in MUTATIONS:
        commands.append(command)
    result = {"success": success,
              "packageVersion": payload.get("version") if isinstance(payload.get("version"), str)
              and re.fullmatch(r"[0-9A-Za-z.+-]{1,40}", payload["version"]) else None,
              "errorCode": code if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", code) else None,
              "assertion": status(mapping(details.get("assertion")).get("status")),
              "action": status(action.get("status")),
              "dispatched": action.get("dispatched") if isinstance(action.get("dispatched"), str)
              and action["dispatched"] in {"no", "unknown", "acknowledged"} else None,
              "runStatus": status(details.get("status")) if command in PLAN_COMMANDS else None,
              "goalVerification": status(mapping(details.get("goalVerification")).get("status")) if command in PLAN_COMMANDS else None,
              "sessionCleanupStatus": cleanup_status if command in PLAN_COMMANDS
              and cleanup_status in ("detached", "retained", "failed", "unknown") else None,
              "actionCommands": commands,
              "actionCount": number(counters.get("actions")) if command in PLAN_COMMANDS else len(commands),
              "captureCount": number(counts.get("captures", counters.get("captures"))),
              "targetReuseCount": (number(counts.get("reusedTargetFrames"))
                                   if number(counts.get("reusedTargetFrames")) is not None else reused_targets)
              if command in PLAN_COMMANDS else None,
              "profile": {"coreWallMs": number(profile.get("coreWallMs")),
                          "stagesMs": {key: stages[key] for key in PROFILE_STAGES if number(stages.get(key)) is not None},
                          "counts": {key: counts[key] for key in PROFILE_COUNTS if number(counts.get(key)) is not None},
                          "captureBreakdown": {"instrumentedCaptures": number(breakdown.get("instrumentedCaptures")),
                                               "hdcCalls": number(breakdown.get("hdcCalls")),
                                               "nativeExportMs": None, "transferMs": None,
                                               "stagesMs": {key: capture_stages[key] for key in CAPTURE_STAGES
                                                            if number(capture_stages.get(key)) is not None}}},
              "modelMs": None, "hostSchedulingMs": None, "inputTokens": None, "outputTokens": None}
    return result


def command_name(args):
    # Parse only enough metadata to identify known commands. Do not import the
    # runtime: an offline bundle may run an installed CLI in another Python.
    # The child remains authoritative for all argument validation.
    if any(flag in args for flag in ("--version", "--help", "-h")):
        return None
    command, request_path, index = None, None, 0
    while index < len(args):
        token, separator, value = args[index].partition("=")
        if token in {"--hdc", "--state-dir", "--session", "--device", "--request"}:
            if not separator:
                index += 1
                value = args[index] if index < len(args) else None
            if token == "--request":
                request_path = value
        elif token == "--json":
            pass
        elif token in COMMAND_NAMES:
            command = token
            break
        else:
            return None
        index += 1
    if request_path:
        try:
            request = json.loads(Path(request_path).read_text(encoding="utf-8-sig"))
            command = mapping(request).get("command")
        except (OSError, ValueError, UnicodeError):
            pass
    return command if isinstance(command, str) and command in COMMAND_NAMES else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-dir", required=True)
    parser.add_argument("--python", default=sys.executable,
                        help="Python executable for the measured CLI process")
    parser.add_argument("--installed", action="store_true",
                        help="Use that Python's installed package instead of this checkout's src")
    parser.add_argument("--host-call-id", type=opaque_id,
                        help="Caller-supplied host tool call ID; one ID may contain multiple CLI processes")
    parser.add_argument("--plan-boundary", choices=PLAN_BOUNDARIES,
                        help="Declared reason for ending this run segment; not inferred from the runtime")
    parser.add_argument("--execution-mode", choices=EXECUTION_MODES,
                        help="Declared cold-setup or warm-continuation trial condition")
    parser.add_argument("--drop-press-ack-once", action="store_true",
                        help="Evaluation only: replace one acknowledged press reply with an unknown result")
    parser.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    args = options.args[1:] if options.args[:1] == ["--"] else options.args
    if not args:
        parser.error("CLI arguments after -- are required")
    command = command_name(args)
    if options.plan_boundary and command not in PLAN_COMMANDS:
        parser.error("--plan-boundary applies only to a known run or execute command")
    folder = Path(options.record_dir).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    if options.installed:
        env.pop("PYTHONPATH", None)
    else:
        env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    env["PYTHONIOENCODING"] = "utf-8"
    started_at = datetime.now(timezone.utc).isoformat()
    started_monotonic = time.perf_counter_ns()
    outcome = subprocess.run([options.python, "-m", "harmony_agent", *args],
                             env=env, capture_output=True, check=False)
    ended_monotonic = time.perf_counter_ns()
    elapsed = round((ended_monotonic - started_monotonic) / 1e6, 2)
    ended_at = datetime.now(timezone.utc).isoformat()
    call_id = uuid.uuid4().hex
    (folder / (call_id + ".stdout")).write_bytes(outcome.stdout)
    (folder / (call_id + ".stderr")).write_bytes(outcome.stderr)
    row = {"callId": call_id, "at": ended_at, "recordVersion": 3,
           "startedAt": started_at, "endedAt": ended_at,
           "startedMonotonicNs": started_monotonic, "endedMonotonicNs": ended_monotonic,
           "clockSource": "python.perf_counter_ns",
           "command": command, "modelMs": None, "hostSchedulingMs": None,
           "hostCallId": options.host_call_id, "executionMode": options.execution_mode,
           "declaredPlanBoundary": options.plan_boundary,
           "inputTokens": None, "outputTokens": None,
           "elapsedMs": elapsed, "exitCode": outcome.returncode,
           "stdoutBytes": len(outcome.stdout), "stderrBytes": len(outcome.stderr)}
    emitted = outcome.stdout
    exit_code = outcome.returncode
    try:
        payload = json.loads(outcome.stdout)
        if not isinstance(payload, dict):
            raise ValueError("Not an envelope")
        row.update(result_summary(payload, command))
        row["jsonEnvelope"] = type(payload.get("success")) is bool
        core_ms = row["profile"]["coreWallMs"]
        row["processOutsideCoreMs"] = round(elapsed - core_ms, 3) if core_ms is not None and core_ms <= elapsed else None
        details = mapping(payload.get("data"))
        if (options.drop_press_ack_once and command == "press" and row["success"] and row["action"] == "completed"
                and details.get("action", {}).get("dispatched") == "acknowledged"):
            try:
                with (folder / "fault-used").open("x", encoding="utf-8") as marker:
                    marker.write(call_id)
            except FileExistsError:
                pass
            else:
                payload = {"schemaVersion": payload["schemaVersion"], "version": payload["version"], "success": False,
                           "error": {"code": "REMOTE_RESULT_UNKNOWN", "message": "The action reply was unavailable. Observe before deciding whether to retry.",
                                     "details": {"dispatched": "unknown", "action": {"status": "unknown", "dispatched": "unknown"},
                                                 "assertion": {"status": "unknown"}}}}
                emitted = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
                exit_code = 1
                row["injectedReplyLoss"] = True
    except (ValueError, AttributeError):
        row["jsonEnvelope"] = False
    row["emittedBytes"] = len(emitted)
    row["emittedExitCode"] = exit_code
    (folder / (call_id + ".emitted")).write_bytes(emitted)
    with (folder / "calls.ndjson").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(row, separators=(",", ":")) + "\n")
    sys.stdout.buffer.write(emitted)
    sys.stderr.buffer.write(outcome.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
