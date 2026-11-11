"""Integration checks for plans, ownership, local evidence and failure recovery."""
from copy import deepcopy
import json
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from harmony_agent.core import Agent
from harmony_agent.errors import AgentError
from harmony_agent.execution import RunStore
from harmony_agent.schema import request_schema, validate_request
from harmony_agent.transport import HdcTransport
from tests.test_core import FakeNativeTransport


def condition(value):
    return {"selector": {"id": "fixture.counter"}, "equals": "Counter: " + str(value)}


def press(value):
    return {"command": "press", "input": {"target": {"id": "fixture.increment"}, "expect": condition(value)}}


class ExecutionRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.transport = FakeNativeTransport()
        self.agent = Agent(self.temp.name, transport=self.transport)
        self.agent.execute("attach", {"device": self.transport.serial})
        self.addCleanup(self.cleanup_owner)

    def cleanup_owner(self):
        self.agent.clear_cancel()
        try:
            self.agent.execute("detach")
        except AgentError:
            pass

    def run_plan(self, steps, **extra):
        plan = {"version": "1", "steps": steps, **extra}
        return self.agent.execute("run", {"run_id": "trial", "plan": plan})

    def test_branch_goal_receipts_and_frozen_evidence(self):
        result = self.run_plan([press(1), {"if": condition(1), "then": [press(2)], "else": [{"yield": "unexpected"}]}],
                               preconditions=[condition(0)], goals=[condition(2)])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["goalVerification"]["status"], "passed")
        report = self.agent.execute("report", {"run_id": "trial"})
        self.assertEqual(len(report["receipts"]), len(result["steps"]))
        self.assertEqual(report["evidenceCheck"]["missingFrames"], [])
        goal = result["goalVerification"]["assertions"][0]
        captures = self.transport.captures
        frozen = self.agent.execute("inspect", {"run_id": "trial", "frame_id": goal["frameId"],
                                               "target": {"id": "fixture.counter"}})
        self.assertEqual(self.transport.captures, captures)
        self.assertEqual(next(n["text"] for n in frozen["nodes"] if n["id"] == "fixture.counter"), "Counter: 2")
        self.assertFalse(frozen["fresh"])
        self.assertFalse(frozen["quality"]["complete"])
        self.assertFalse(frozen["quality"]["absenceEvidence"])
        commands = [r for r in report["receipts"] if r["kind"] == "command"]
        self.assertNotEqual(commands[0]["beforeFrameId"], commands[0]["afterFrameId"])

    def test_run_ids_cannot_replay_mutations(self):
        self.run_plan([press(1)])
        with self.assertRaises(AgentError) as caught:
            self.run_plan([press(2)])
        self.assertEqual(caught.exception.code, "RUN_EXISTS")
        self.assertEqual(self.transport.counter, 1)

    def test_invalid_unselected_branch_has_no_device_effect(self):
        before = self.transport.captures
        with self.assertRaises(AgentError):
            self.run_plan([{"if": condition(0), "then": [press(1)], "else": [{"command": "press", "input": {"target": {"ref": "@old"}}}]}])
        self.assertEqual(self.transport.captures, before)
        self.assertFalse(self.transport.mutations)

    def test_fresh_before_guard_blocks_changed_state_without_dispatch(self):
        guarded = {**press(1), "before": [condition(0)], "refresh": True}
        capture = self.transport.capture_layout

        def changed_after_precondition(device, **kwargs):
            if self.transport.captures == 1:
                self.transport.counter = 7
            return capture(device, **kwargs)

        with patch.object(self.transport, "capture_layout", changed_after_precondition):
            result = self.run_plan([guarded, press(2)], preconditions=[condition(0)])
        self.assertEqual(result["yieldReason"], "PRECONDITION_NOT_MET")
        self.assertEqual(result["error"]["details"]["action"]["dispatched"], "no")
        self.assertFalse(self.transport.mutations)
        self.assertEqual(self.transport.captures, 2)
        details = result["error"]["details"]
        guard = details["guardAssertions"][0]
        self.assertEqual(guard["status"], "failed")
        self.assertEqual(guard["actual"], "Counter: 7")
        self.assertEqual(guard["frameId"], details["beforeFrameId"])
        self.assertNotEqual(guard["frameId"], result["steps"][0]["result"]["frameId"])
        report = self.agent.execute("report", {"run_id": "trial"})
        self.assertEqual(report["receipts"][-1]["error"]["details"]["guardAssertions"], [guard])

    def test_before_guard_reuses_fresh_target_frame(self):
        guarded = {**press(1), "before": [condition(0)]}
        result = self.run_plan([guarded], limits={"maxCaptures": 2})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.transport.counter, 1)
        # One capture resolves the target and guard; one verifies the result.
        self.assertEqual(self.transport.captures, 2)
        receipt = result["steps"][0]["result"]
        guard = receipt["guardAssertions"][0]
        self.assertEqual(guard["status"], "passed")
        self.assertEqual(guard["frameId"], receipt["beforeFrameId"])
        self.assertEqual(guard["evidenceRef"], {"runId": "trial", "frameId": receipt["beforeFrameId"]})
        self.assertNotEqual(receipt["beforeFrameId"], receipt["afterFrameId"])

    def test_capture_budget_stops_before_dispatch(self):
        result = self.run_plan([{**press(1), "refresh": True}], preconditions=[condition(0)], limits={"maxCaptures": 1})
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertFalse(self.transport.mutations)

    def test_capture_budget_after_dispatch_does_not_replay(self):
        result = self.run_plan([press(1), press(2)], limits={"maxCaptures": 1})
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(result["error"]["details"]["action"]["dispatched"], "acknowledged")
        self.assertFalse(result["frameValidForActions"])

    def test_unknown_reply_stops_and_is_persisted(self):
        self.transport.tap_error = AgentError("REMOTE_RESULT_UNKNOWN", "Synthetic lost reply", dispatched="unknown")
        result = self.run_plan([press(1), press(2)])
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(self.transport.counter, 1)
        report = self.agent.execute("report", {"run_id": "trial"})
        self.assertFalse(report["replayAllowed"])
        self.assertEqual(report["receipts"][0]["status"], "unknown")

    def test_failed_assertion_returns_latest_actual_frame(self):
        bad = press(9)
        bad["input"]["expect"]["timeoutMs"] = 2
        result = self.run_plan([bad, press(2)])
        self.assertIn(result["status"], {"failed", "unknown"})
        self.assertEqual(self.transport.counter, 1)
        self.assertFalse(result["frameValidForActions"])
        self.assertTrue(any(item.get("text") == "Counter: 1" for item in result["observation"]["nodes"]))

    def test_run_reuses_current_frames_and_projects_only_final_page(self):
        steps = [{**press(value), "before": [condition(value - 1)]} for value in range(1, 4)]
        with patch.object(self.agent, "_check_device", wraps=self.agent._check_device) as check:
            result = self.run_plan(steps, preconditions=[condition(0)], goals=[condition(3)])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.transport.captures, 4)
        self.assertEqual(check.call_count, 1)
        self.assertEqual(result["profile"]["counts"]["projections"], 1)
        self.assertEqual(result["profile"]["counts"]["reusedFrames"], 4)
        self.assertEqual(result["profile"]["counts"]["targetFrameRequests"], 3)
        self.assertEqual(result["profile"]["counts"]["reusedTargetFrames"], 3)
        self.assertEqual(result["profile"]["counts"]["conditionFrameRequests"], 2)
        self.assertEqual(result["profile"]["counts"]["reusedConditionFrames"], 1)
        self.assertEqual(result["profile"]["counts"]["beforeConditionChecks"], 3)
        self.assertTrue(result["observation"]["projection"]["compact"])
        receipts = [step["result"] for step in result["steps"] if step["kind"] == "command"]
        self.assertTrue(all(step["observationSource"] == "reused" for step in receipts))
        self.assertEqual(receipts[1]["beforeFrameId"], receipts[0]["afterFrameId"])
        self.assertEqual(result["goalVerification"]["status"], "passed")

    def test_assert_and_before_share_current_target_frame_without_extra_capture(self):
        result = self.run_plan([{"command": "observe"}, {"assert": condition(0)},
                                {**press(1), "before": [condition(0), condition(0)]}])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.transport.captures, 2)
        counts = result["profile"]["counts"]
        self.assertEqual(counts["reusedFrames"], 2)
        self.assertEqual(counts["reusedConditionFrames"], 1)
        self.assertEqual(counts["reusedTargetFrames"], 1)
        self.assertEqual(counts["beforeConditionChecks"], 2)
        assertion = result["steps"][1]["result"]
        action = result["steps"][2]["result"]
        self.assertEqual(assertion["frameId"], action["beforeFrameId"])
        self.assertTrue(all(item["frameId"] == action["beforeFrameId"] for item in action["guardAssertions"]))

    def test_run_interactive_inherits_and_last_command_explicit_value_overrides(self):
        cases = [({}, {}, False), ({"interactive": True}, {}, True),
                 ({"interactive": True}, {"interactive": False}, False),
                 ({"interactive": False}, {"interactive": True}, True)]
        for index, (top, last, expected) in enumerate(cases):
            with self.subTest(top=top, last=last):
                command, params = validate_request({"command": "run", "input": {
                    "run_id": "projection-" + str(index), **top,
                    "plan": {"version": "1", "steps": [
                        {"command": "observe", "input": {"interactive": not expected}},
                        {"command": "observe", "input": last}]}}})
                result = self.agent.execute(command, params)
                self.assertEqual(result["status"], "completed")
                self.assertIs(result["observation"]["projection"]["view"]["interactive"], expected)
                self.assertEqual(result["profile"]["counts"]["projections"], 1)
        with self.assertRaises(AgentError):
            validate_request({"command": "run", "input": {"interactive": "true",
                "plan": {"version": "1", "steps": [{"command": "observe"}]}}})

    def test_semantic_run_does_not_apply_tree_interactive_filter(self):
        pages = []
        for enabled in (False, True):
            command, params = validate_request({"command": "run", "input": {
                "run_id": "semantic-" + str(enabled), "view": "semantic", "interactive": enabled,
                "plan": {"version": "1", "steps": [{"command": "observe"}]}}})
            with patch("harmony_agent.core.project_observation", side_effect=AssertionError("Unexpected tree projection")):
                result = self.agent.execute(command, params)
            pages.append([(item.get("id"), item.get("text"), item["roles"]) for item in result["observation"]["items"]])
        self.assertTrue(pages[0])
        self.assertEqual(pages[0], pages[1])

    def test_expired_run_frame_is_captured_again(self):
        checkpoint = RunStore.checkpoint
        def expire(journal, event):
            checkpoint(journal, event)
            if event.get("event") == "step_finished" and event.get("command") == "press":
                self.agent._last_capture_time -= 2.0
        with patch.object(RunStore, "checkpoint", expire):
            result = self.run_plan([press(1), press(2)])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.transport.captures, 4)
        self.assertEqual(result["steps"][1]["result"]["observationSource"], "captured")

    def test_expired_goal_frame_cannot_prove_an_old_value(self):
        checkpoint = RunStore.checkpoint
        def expire(journal, event):
            checkpoint(journal, event)
            if event.get("event") == "step_finished" and event.get("command") == "press":
                self.agent._last_capture_time -= 2.0
                self.transport.counter = 9
        with patch.object(RunStore, "checkpoint", expire):
            result = self.run_plan([press(1)], goals=[condition(1)])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["goalVerification"]["status"], "failed")
        self.assertEqual(result["goalVerification"]["assertions"][0]["actual"], "Counter: 9")
        self.assertEqual(self.transport.captures, 3)

    def test_final_find_retains_its_query_and_projection(self):
        result = self.run_plan([{"command": "find", "input": {"text": "NoSuchLabel", "view": "semantic"}}])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["observation"]["projection"]["query"], "NoSuchLabel")
        self.assertEqual(result["observation"]["items"], [])
        self.assertEqual(result["profile"]["counts"]["projections"], 1)

    def test_new_run_does_not_reuse_previous_call_frame(self):
        self.run_plan([{"command": "observe"}])
        self.assertEqual(self.transport.captures, 1)
        result = self.agent.execute("run", {"run_id": "second", "plan": {"version": "1", "steps": [press(1)]}})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.transport.captures, 3)
        self.assertEqual(result["steps"][0]["result"]["observationSource"], "captured")

    def test_run_publishes_session_only_at_boundaries(self):
        persisted_during_actions = []
        self.transport.before_mutation = lambda: persisted_during_actions.append(self.agent.store.load("default")["frameValid"])
        with patch.object(self.agent.store, "save", wraps=self.agent.store.save) as save, \
                patch.object(self.agent.store, "trace", wraps=self.agent.store.trace) as trace:
            result = self.run_plan([press(1), press(2), press(3)])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(save.call_count, 2)
        trace.assert_not_called()
        self.assertEqual(persisted_during_actions, [False, False, False])
        self.assertTrue(self.agent.store.load("default")["frameValid"])

    def test_explicit_refresh_keeps_every_declared_guard_fresh(self):
        steps = [{**press(value), "refresh": True, "before": [condition(value - 1)]} for value in range(1, 4)]
        result = self.run_plan(steps, preconditions=[condition(0)], goals=[condition(3)])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.transport.captures, 7)
        self.assertTrue(all(step["result"]["observationSource"] == "captured"
                            for step in result["steps"] if step["kind"] == "command"))

    def test_unneeded_per_action_expectation_can_be_omitted(self):
        result = self.run_plan([{"command": "press", "input": {"target": {"id": "fixture.increment"}}}],
                               goals=[condition(1)])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["lastResult"]["assertion"]["status"], "not_requested")
        self.assertEqual(result["goalVerification"]["status"], "passed")

    def test_cancel_after_mutation_stops_without_replay(self):
        self.transport.before_mutation = self.agent.request_cancel
        result = self.run_plan([press(1), press(2)])
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(self.transport.counter, 1)
        self.assertFalse(result["frameValidForActions"])
        self.assertEqual(self.agent.execute("report", {"run_id": "trial"})["status"], "cancelled")

    def test_owner_spans_calls_and_state_directories(self):
        self.run_plan([{"yield": "planning boundary"}])
        with tempfile.TemporaryDirectory() as other_root:
            other = Agent(other_root, transport=self.transport)
            other.execute("attach", {"device": self.transport.serial})
            with self.assertRaises(AgentError) as caught:
                other.execute("press", {"target": "id=fixture.increment"})
            self.assertEqual(caught.exception.code, "DEVICE_OWNED")
            self.agent.execute("release")
            other.execute("press", {"target": "id=fixture.increment"})
            other.execute("detach")
        self.assertEqual(self.transport.counter, 1)

    def test_owner_token_survives_reboot_and_release(self):
        self.agent.execute("claim")
        original = self.agent.store.load("default")
        owner = self.agent.store.device_owner(self.transport.serial)
        self.transport.boot = "22222222-2222-2222-2222-222222222222"
        with self.assertRaises(AgentError) as caught:
            self.agent.execute("observe")
        self.assertEqual(caught.exception.code, "DEVICE_RESTARTED")
        restarted = self.agent.store.load("default")
        self.assertNotEqual(restarted["epoch"], original["epoch"])
        self.assertEqual(restarted["ownerToken"], original["ownerToken"])
        self.assertEqual(self.agent.store.device_owner(self.transport.serial), owner)
        self.assertTrue(self.agent.execute("release")["released"])
        self.assertIsNone(self.agent.store.device_owner(self.transport.serial))

    def test_owner_token_survives_reboot_and_detach(self):
        self.agent.execute("claim")
        self.transport.boot = "22222222-2222-2222-2222-222222222222"
        with self.assertRaises(AgentError) as caught:
            self.agent.execute("observe")
        self.assertEqual(caught.exception.code, "DEVICE_RESTARTED")
        self.assertTrue(self.agent.execute("detach")["detached"])
        self.assertIsNone(self.agent.store.device_owner(self.transport.serial))

    def test_initial_yield_invalidates_persisted_frame_without_capture(self):
        frame = self.agent.execute("observe")
        self.assertTrue(self.agent.store.load("default")["frameValid"])
        captures = self.transport.captures
        result = self.run_plan([{"yield": "need another planning turn"}])
        self.assertEqual(result["status"], "yielded")
        self.assertFalse(result["frameValidForActions"])
        persisted = self.agent.store.load("default")
        self.assertFalse(persisted["frameValid"])
        self.assertEqual(persisted["frame"]["frameId"], frame["frameId"])
        self.assertEqual(self.transport.captures, captures)
        self.assertFalse(self.transport.mutations)

    def test_device_lock_is_held_through_entire_plan(self):
        conflicts = []
        def contender():
            with self.assertRaises(AgentError) as caught:
                with self.agent.store.device_lock(self.transport.serial):
                    pass
            conflicts.append(caught.exception.code)
        self.transport.before_mutation = contender
        result = self.run_plan([press(1), press(2)])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(conflicts, ["DEVICE_BUSY", "DEVICE_BUSY"])

    def test_checkpoint_failure_before_action_prevents_dispatch(self):
        with patch.object(RunStore, "checkpoint", side_effect=OSError("synthetic disk full")):
            result = self.run_plan([press(1)])
        self.assertEqual(result["yieldReason"], "PLAN_CHECKPOINT_FAILED")
        self.assertFalse(self.transport.mutations)

    def test_checkpoint_failure_after_action_preserves_result(self):
        original = RunStore.checkpoint
        def fault(journal, event):
            if event["event"] == "step_finished":
                raise OSError("synthetic disk full")
            original(journal, event)
        with patch.object(RunStore, "checkpoint", fault):
            result = self.run_plan([press(1), press(2)])
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(result["lastResult"]["action"]["dispatched"], "acknowledged")
        self.assertEqual(result["yieldReason"], "PLAN_CHECKPOINT_FAILED")

    def test_final_invalid_state_save_failure_preserves_actual_result(self):
        save = self.agent.store.save
        failed_saves = []

        def fail_final_invalidation(name, value):
            if self.transport.counter == 1 and value["frame"] and not value["frameValid"]:
                failed_saves.append(deepcopy(value))
                raise OSError("synthetic state volume unavailable")
            return save(name, value)

        with patch.object(self.agent.store, "save", fail_final_invalidation):
            result = self.run_plan([press(1), {"assert": condition(9)}, press(2)])
        self.assertEqual(len(failed_saves), 1)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["yieldReason"], "assertion_not_verified")
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(len(self.transport.mutations), 1)
        self.assertEqual(result["lastResult"]["action"]["dispatched"], "acknowledged")
        self.assertEqual(result["lastResult"]["assertion"]["status"], "passed")
        self.assertEqual(result["steps"][-1]["result"]["actual"], "Counter: 1")
        self.assertFalse(result["frameValidForActions"])
        self.assertTrue(any("Failed to persist invalidated refs" in message for message in result["warnings"]))
        report = self.agent.execute("report", {"run_id": "trial"})
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["result"]["lastResult"], result["lastResult"])
        self.assertEqual(len(report["receipts"]), 2)

    def test_frozen_inspect_survives_detach_and_needs_no_transport(self):
        result = self.run_plan([{"command": "observe"}])
        frame_id = result["observation"]["frameId"]
        self.agent.execute("detach")
        offline = Agent(self.temp.name, hdc_path="missing-hdc")
        self.assertEqual(offline.execute("inspect", {"run_id": "trial", "frame_id": frame_id})["frameId"], frame_id)
        self.assertEqual(offline.execute("report", {"run_id": "trial"})["status"], "completed")

    def test_inspect_requires_exact_frame_and_marks_projection(self):
        frame = self.agent.execute("observe")
        with self.assertRaises(AgentError):
            self.agent.execute("inspect", {"frame_id": "old"})
        detail = self.agent.execute("inspect", {"frame_id": frame["frameId"], "max_nodes": 1})
        self.assertTrue(detail["quality"]["truncated"])
        self.assertFalse(detail["quality"]["complete"])

    def test_report_detects_missing_assertion_evidence(self):
        result = self.run_plan([press(1)], goals=[condition(1)])
        clean_report = self.agent.execute("report", {"run_id": "trial"})
        self.assertTrue(clean_report["evidenceCheck"]["complete"])
        frame_id = result["goalVerification"]["assertions"][0]["frameId"]
        frame_path = Path(self.temp.name) / "runs" / "trial" / "frames" / (frame_id + ".json")
        frame_path.unlink()
        captures = self.transport.captures
        report = self.agent.execute("report", {"run_id": "trial"})
        self.assertIn(frame_id, report["evidenceCheck"]["missingFrames"])
        self.assertFalse(report["evidenceCheck"]["complete"])
        self.assertFalse(report["replayAllowed"])
        self.assertEqual(self.transport.captures, captures)
        self.assertEqual(self.transport.counter, 1)

    def test_report_detects_tampered_assertion_evidence(self):
        result = self.run_plan([press(1)], goals=[condition(1)])
        frame_id = result["goalVerification"]["assertions"][0]["frameId"]
        frame_path = Path(self.temp.name) / "runs" / "trial" / "frames" / (frame_id + ".json")
        frame = json.loads(frame_path.read_text(encoding="utf-8"))
        next(node for node in frame["nodes"] if node["id"] == "fixture.counter")["text"] = "Counter: 99"
        frame_path.write_text(json.dumps(frame), encoding="utf-8")
        captures = self.transport.captures
        report = self.agent.execute("report", {"run_id": "trial"})
        check = report["evidenceCheck"]
        self.assertFalse(check["complete"])
        self.assertEqual(check["missingFrames"], [])
        self.assertGreater(check["assertionsChecked"], 0)
        self.assertIn({"frameId": frame_id, "reason": "actual_value_mismatch"}, check["assertionMismatches"])
        self.assertIn({"frameId": frame_id, "reason": "passed_condition_mismatch"}, check["assertionMismatches"])
        self.assertFalse(report["replayAllowed"])
        self.assertEqual(self.transport.captures, captures)
        self.assertEqual(self.transport.counter, 1)

    def test_profile_does_not_fabricate_model_timings(self):
        result = self.agent.execute("observe", {"view": "semantic", "profile": True})
        self.assertIsNone(result["profile"]["modelMs"])
        self.assertIsNone(result["profile"]["inputTokens"])
        self.assertGreaterEqual(result["profile"]["coreWallMs"], result["profile"]["stagesMs"]["capture"])
        details = result["profile"]["captureBreakdown"]
        self.assertEqual(details["instrumentedCaptures"], 0)
        self.assertIsNone(details["hdcCalls"])
        self.assertEqual(details["stagesMs"], {})
        self.assertIsNone(details["nativeExportMs"])
        self.assertIsNone(details["transferMs"])

    def test_native_capture_profile_is_optional_and_scoped_to_each_call(self):
        raw = self.transport.capture_layout(self.transport.serial)
        executable = Path(self.temp.name) / "hdc-placeholder"
        executable.write_bytes(b"not executed")
        native = HdcTransport(str(executable))
        self.agent._transport = native

        def response(argv, **kwargs):
            boundary = re.search(r"__HARMONY_LAYOUT_[a-f0-9]+__", argv[-1]).group()
            receipt = re.search(r"__HARMONY_EXIT_[a-f0-9]+__", argv[-1]).group()
            body = "\n" + boundary + "\n" + json.dumps(raw) + "\n" + receipt + "0\n"
            return subprocess.CompletedProcess(argv, 0, body.encode(), b"")

        with patch.object(self.agent, "_check_device"), \
                patch("harmony_agent.transport.subprocess.run", side_effect=response) as process:
            plain = self.agent.execute("observe")
            self.assertNotIn("profile", plain)
            for _ in range(2):
                profiled = self.agent.execute("observe", {"profile": True})
                details = profiled["profile"]["captureBreakdown"]
                self.assertEqual(details["instrumentedCaptures"], 1)
                self.assertEqual(details["hdcCalls"], 1)
                self.assertEqual(set(details["stagesMs"]), {
                    "hdcProcess", "decodeAndValidation", "shellReceiptValidation", "layoutParseAndValidation"})
                self.assertTrue(all(value >= 0 for value in details["stagesMs"].values()))
                self.assertIsNone(details["nativeExportMs"])
                self.assertIsNone(details["transferMs"])
                self.assertIsNone(native._capture_metrics)
            self.assertEqual(process.call_count, 3)

    def test_request_plan_schema_refs_resolve(self):
        schema = request_schema("run")
        def walk(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    ref = value["$ref"]
                    self.assertTrue(ref.startswith("#/$defs/"))
                    self.assertIn(ref[len("#/$defs/"):], schema["$defs"])
                for v in value.values(): walk(v)
            elif isinstance(value, list):
                for v in value: walk(v)
        walk(schema)
        command, params = validate_request({"command": "run", "input": {"plan": {"version": "1", "steps": [press(1)]}}})
        self.assertEqual(command, "run")
        self.assertEqual(params["plan"]["limits"]["maxActions"], 20)

    def test_report_path_traversal_rejected(self):
        for name in ("../outside", "CON", "bad/path"):
            with self.assertRaises(AgentError):
                self.agent.execute("report", {"run_id": name})


if __name__ == "__main__":
    unittest.main()
