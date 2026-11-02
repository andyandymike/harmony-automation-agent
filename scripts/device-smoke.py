#!/usr/bin/env python3
"""Run the installed fixture-v2 through Agent; never install or authorize a device.

Only explicitly selected devices are used. The JSON summary contains fixed test
names, durations, outcomes and error codes, never device IDs, screen contents or
local artifact paths. Detailed evidence remains in the selected Agent state dir.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from harmony_agent.core import Agent  # noqa: E402
from harmony_agent.errors import AgentError  # noqa: E402


BUNDLE = "com.andyandymike.harmonyautomation.fixture"
TIMEOUT_MS = 7000


def condition(identifier, value):
    return {"selector": {"id": identifier}, "property": "text",
            "equals": value, "timeoutMs": TIMEOUT_MS}


def observation(data):
    return data.get("observation", data)


def node(data, identifier):
    matches = [item for item in observation(data).get("nodes", [])
               if item.get("id") == identifier]
    return matches[0] if len(matches) == 1 else None


def in_view(data, identifier):
    """Require a nonempty rectangle within the fixture Scroll's viewport."""
    item = node(data, identifier)
    scroll = node(data, "fixture.scroll")
    if not item or not scroll or item.get("visible") is False:
        return False
    bounds, viewport = item.get("bounds"), scroll.get("bounds")
    if not bounds or not viewport:
        return False
    return (bounds["right"] > bounds["left"] and bounds["bottom"] > bounds["top"]
            and viewport["left"] <= bounds["left"] < bounds["right"] <= viewport["right"]
            and viewport["top"] <= bounds["top"] < bounds["bottom"] <= viewport["bottom"])


def artifact_exists(path):
    try:
        return bool(path) and Path(path).is_file() and Path(path).stat().st_size > 0
    except (OSError, TypeError, ValueError):
        return False


class Smoke:
    def __init__(self, agent, device):
        self.agent = agent
        self.device = device
        self.session = "fixture-smoke-" + uuid.uuid4().hex[:12]
        self.steps = []
        self.attached = False

    def skip(self, name, reason):
        self.steps.append({"name": name, "status": "skip", "reason": reason,
                           "elapsedMs": 0})

    def command(self, name, command, params=None, *, expected_error=None, check=None):
        """Call once; never retry a mutation whose outcome is uncertain."""
        started = time.monotonic()
        row = {"name": name, "command": command, "status": "fail"}
        data = {}
        try:
            data = self.agent.execute(command, {"session": self.session, **(params or {})})
            assertion = data.get("assertion", {}).get("status")
            if assertion:
                row["assertion"] = assertion
            if expected_error:
                row["reason"] = "expected_error_not_raised"
            elif assertion not in (None, "passed", "not_requested"):
                row["reason"] = "assertion_not_passed"
            elif check is not None and not check(data):
                row["reason"] = "result_check_failed"
            else:
                row["status"] = "pass"
        except AgentError as exc:
            data = exc.details
            row["errorCode"] = exc.code
            row["dispatched"] = exc.dispatched
            if data.get("assertion", {}).get("status"):
                row["assertion"] = data["assertion"]["status"]
            if expected_error == exc.code and (check is None or check(data)):
                row["status"] = "pass"
            elif expected_error == exc.code:
                row["reason"] = "error_evidence_check_failed"
            if "evidence" in data:
                row["evidence"] = {kind: artifact_exists(data["evidence"].get(kind))
                                   for kind in ("observation", "screenshot")}
        except Exception as exc:
            # Exception messages can contain user paths or device identifiers.
            row["errorCode"] = "UNEXPECTED_ERROR"
            row["exceptionType"] = type(exc).__name__
        finally:
            row["elapsedMs"] = round((time.monotonic() - started) * 1000, 2)
            self.steps.append(row)
        return row["status"] == "pass", data

    def seek(self, label, identifier, direction, limit=4):
        ok, data = self.command(label + ".observe", "observe", {"max_nodes": 5000})
        if not ok:
            return False
        count = 0
        while not in_view(data, identifier) and count < limit:
            count += 1
            ok, _ = self.command(label + f".scroll.{count}", "scroll",
                                 {"target": "id=fixture.scroll", "direction": direction})
            if not ok:
                return False
            ok, data = self.command(label + f".observe.{count}", "observe", {"max_nodes": 5000})
            if not ok:
                return False
        found = in_view(data, identifier)
        self.steps.append({"name": label, "status": "pass" if found else "fail",
                           "assertion": "passed" if found else "failed",
                           "scrollCount": count, "elapsedMs": 0})
        return found

    def press(self, name, target, identifier, value):
        return self.command(name, "press", {"target": target,
                            "expect": condition(identifier, value)})

    def input_cases(self):
        # This is a separate path: success does not establish ordinary IME support.
        if not self.seek("native_input.top", "fixture.ready", "up"):
            self.skip("native_input", "top_not_reached")
            return
        ready, _ = self.press("native_input.reset", "id=fixture.reset",
                              "fixture.input.native", "")
        cases = [("fill_chinese", "鸿蒙测试 ABC 123"),
                 ("replace", "替换内容 XYZ 456"), ("clear", "")]
        for name, value in cases:
            if not ready:
                self.skip("native_input." + name, "previous_input_step_failed")
                if name == "fill_chinese":
                    self.skip("native_input.submit", "previous_input_step_failed")
                continue
            ready, _ = self.command("native_input." + name, "fill",
                                    {"target": "id=fixture.input.native", "text": value,
                                     "timeout_ms": TIMEOUT_MS,
                                     "expect": condition("fixture.input.value",
                                                          "Value: " + (value or "<empty>"))})
            if name == "fill_chinese":
                if ready:
                    ready, _ = self.press("native_input.submit", "id=fixture.submit",
                                          "fixture.output", "Hello, " + value)
                else:
                    self.skip("native_input.submit", "previous_input_step_failed")

    def run(self, include_input=False):
        try:
            self.attached, _ = self.command("attach", "attach", {"device": self.device})
            if not self.attached:
                self.skip("fixture_suite", "attach_failed")
                return
            opened, _ = self.command("open_fixture", "open", {"app": BUNDLE, "ability": "EntryAbility"})
            if not opened:
                self.skip("fixture_suite", "open_failed")
                return
            if not self.seek("prepare_top", "fixture.ready", "up"):
                self.skip("fixture_suite", "top_not_reached")
                return
            self.command("ready", "wait", {"target": "id=fixture.ready", "equals": "READY",
                                             "timeout_ms": TIMEOUT_MS})
            reset_ok, _ = self.press("reset", "id=fixture.reset", "fixture.counter", "Counter: 0")
            observed, frame = self.command("observe_increment", "observe", {"max_nodes": 5000})
            increment = node(frame, "fixture.increment") if observed else None
            if reset_ok and increment and increment.get("ref"):
                old_ref = increment["ref"]
                incremented, _ = self.press("increment_expect", old_ref, "fixture.counter", "Counter: 1")
                if incremented:
                    self.command("stale_ref_rejected", "press", {"target": old_ref},
                                 expected_error="STALE_REF", check=lambda data: data.get("action", {}).get("dispatched") == "no")
                else:
                    self.skip("stale_ref_rejected", "increment_failed")
            else:
                self.skip("increment_expect", "reset_or_ref_unavailable")
                self.skip("stale_ref_rejected", "increment_not_executed")
            if reset_ok:
                self.press("switch_on", "id=fixture.switch", "fixture.switch.value", "On")
            else:
                self.skip("switch_on", "initial_state_unknown")
            self.press("delayed_ready", "id=fixture.delayed.start", "fixture.delayed.status", "Ready after delay")
            self.seek("rows_visible", "fixture.row.b.choose", "down")
            self.command("ambiguous_choose_rejected", "press", {"target": "text=Choose"},
                         expected_error="TARGET_AMBIGUOUS", check=lambda data: data.get("action", {}).get("dispatched") == "no")
            self.press("choose_row_a", {"text": "Choose", "within": {"id": "fixture.row.a"}},
                       "fixture.selected", "Selected: Order A")
            end_found = self.seek("scroll_end", "fixture.scroll.end", "down", limit=4)
            if end_found:
                self.command("end_text", "wait", {"target": "id=fixture.scroll.end",
                                                   "equals": "END OF FIXTURE", "timeout_ms": TIMEOUT_MS})
            else:
                self.skip("end_text", "end_not_reached")
            self.command("screenshot", "screenshot", check=lambda data: artifact_exists(data.get("path")))
            if end_found:
                self.command("wrong_assertion_keeps_evidence", "wait",
                             {"target": "id=fixture.scroll.end", "equals": "INTENTIONALLY WRONG FIXTURE VALUE",
                              "timeout_ms": 2500}, expected_error="ASSERTION_TIMEOUT",
                             check=lambda data: data.get("assertion", {}).get("status") in {"failed", "unknown"}
                             and all(artifact_exists(data.get("evidence", {}).get(kind))
                                     for kind in ("observation", "screenshot")))
            else:
                self.skip("wrong_assertion_keeps_evidence", "end_not_reached")
            if include_input:
                self.input_cases()
        except KeyboardInterrupt:
            self.steps.append({"name": "interrupted", "status": "fail", "elapsedMs": 0})
        finally:
            if not include_input:
                self.skip("native_input", "not_requested_use_include_input")
            elif not any(step["name"].startswith("native_input") for step in self.steps):
                self.skip("native_input", "fixture_suite_not_ready")
            self.skip("standard_ime_input", "separate_operator_configured_test_required")
            if self.attached:
                self.command("detach", "detach", check=lambda data: data.get("detached") is True
                             and data.get("deviceStopped") is False)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True, help="Exact already-authorized device identifier")
    parser.add_argument("--hdc", help="Path to an installed hdc executable")
    parser.add_argument("--state-dir", help="Local Agent state/evidence directory")
    parser.add_argument("--output", default=".harmony-agent/device-smoke.json", help="Sanitized JSON report destination")
    parser.add_argument("--include-input", action="store_true", help="Also test native input without soft keyboard; may alter clipboard")
    args = parser.parse_args(argv)
    started = time.monotonic()
    smoke = Smoke(Agent(state_dir=args.state_dir, hdc_path=args.hdc), args.device)
    smoke.run(args.include_input)
    counts = {status: sum(step["status"] == status for step in smoke.steps)
              for status in ("pass", "fail", "skip")}
    summary = {"schemaVersion": 1, "suite": "fixture-v2", "at": datetime.now(timezone.utc).isoformat(),
               "status": "fail" if counts["fail"] else "pass", "counts": counts,
               "elapsedMs": round((time.monotonic() - started) * 1000, 2),
               "inputIncluded": args.include_input, "steps": smoke.steps}
    try:
        destination = Path(args.output)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        summary["status"] = "fail"
        summary["reportError"] = "REPORT_WRITE_FAILED"
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if summary["status"] == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())
