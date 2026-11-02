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
import subprocess
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record-dir", required=True)
    parser.add_argument("--drop-press-ack-once", action="store_true",
                        help="Evaluation only: replace one acknowledged press reply with an unknown result")
    parser.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args()
    args = options.args[1:] if options.args[:1] == ["--"] else options.args
    if not args:
        parser.error("CLI arguments after -- are required")
    folder = Path(options.record_dir).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    env["PYTHONIOENCODING"] = "utf-8"
    started = time.perf_counter()
    outcome = subprocess.run([sys.executable, "-m", "harmony_agent", *args],
                             env=env, capture_output=True, check=False)
    elapsed = round((time.perf_counter() - started) * 1000, 2)
    call_id = uuid.uuid4().hex
    (folder / (call_id + ".stdout")).write_bytes(outcome.stdout)
    (folder / (call_id + ".stderr")).write_bytes(outcome.stderr)
    row = {"callId": call_id, "at": datetime.now(timezone.utc).isoformat(),
           "elapsedMs": elapsed, "exitCode": outcome.returncode,
           "stdoutBytes": len(outcome.stdout), "stderrBytes": len(outcome.stderr)}
    emitted = outcome.stdout
    exit_code = outcome.returncode
    try:
        payload = json.loads(outcome.stdout)
        row["success"] = payload.get("success")
        details = payload.get("data", {}) if row["success"] else payload.get("error", {}).get("details", {})
        row["errorCode"] = payload.get("error", {}).get("code")
        row["assertion"] = details.get("assertion", {}).get("status")
        row["action"] = details.get("action", {}).get("status")
        from harmony_agent.cli import build_parser
        from harmony_agent.errors import AgentError
        try:
            parsed = vars(build_parser()[0].parse_args(args))
        except AgentError:
            # The real CLI already produced its structured validation error.
            parsed = {}
        command = parsed.get("command")
        if parsed.get("request"):
            try:
                request = json.loads(Path(parsed["request"]).read_text(encoding="utf-8-sig"))
                command = request.get("command")
            except (OSError, ValueError, IndexError):
                pass
        row["command"] = command
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
