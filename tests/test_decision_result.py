"""Decision-only presentation preserves failures and the complete run journal."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from harmony_agent.execution import RunStore, decision_result
from harmony_agent.observation import normalize_layout


def command_step(index=1, command="press", **changes):
    step = {"stepId": str(index), "path": f"steps[{index - 1}]", "kind": "command",
            "command": command, "status": "completed", "elapsedMs": 12,
            "result": {"operationId": f"operation-{index}", "beforeFrameId": "frame-a",
                       "afterFrameId": "frame-b", "frameId": "frame-b",
                       "action": {"status": "completed", "dispatched": "acknowledged"},
                       "assertion": {"status": "not_requested"}, "warnings": []}}
    step.update(changes)
    return step


def completed_run(steps=None):
    steps = [command_step()] if steps is None else steps
    return {"planVersion": "1", "runId": "synthetic-run", "status": "completed", "yieldReason": None,
            "goalVerification": {"status": "not_requested", "assertions": []},
            "steps": steps, "lastResult": deepcopy(steps[-1]["result"]) if steps else {},
            "counters": {"steps": len(steps), "actions": 1, "captures": 2, "elapsedMs": 14},
            "timings": {"totalMs": 14}, "profile": {"coreWallMs": 15, "modelMs": None},
            "observation": {"frameId": "frame-b", "nodes": [{"id": "counter", "text": "1"}]},
            "observationRole": "last_captured_not_necessarily_post_action", "frameValidForActions": True,
            "replayAllowed": False, "deviceOwnership": "session_until_release_or_detach"}


class DecisionResultTests(unittest.TestCase):
    def test_success_is_summary_not_repeated_receipts_or_invented_business_success(self):
        result = completed_run([command_step(1), command_step(2, "fill")])
        projected = decision_result(result)
        self.assertEqual("harmony-run-decision/1", projected["format"])
        self.assertNotIn("steps", projected)
        self.assertNotIn("lastResult", projected)
        self.assertEqual({"total": 2, "commands": {"press": 1, "fill": 1},
                          "statuses": {"completed": 2}, "actionStatuses": {"completed": 2},
                          "actionCommands": ["press", "fill"],
                          "conditions": {"matched": 0, "notMatched": 0, "unknown": 0}, "omittedSuccessSteps": 2,
                          "retainedSteps": 0}, projected["stepsSummary"])
        self.assertEqual("not_requested", projected["goalVerification"]["status"])
        for key in ("planVersion", "runId", "status", "yieldReason", "goalVerification", "counters",
                    "timings", "profile", "observation", "observationRole", "frameValidForActions",
                    "replayAllowed", "deviceOwnership"):
            self.assertEqual(result[key], projected[key])
        self.assertEqual({"runId": "synthetic-run", "frameIds": ["frame-a", "frame-b"],
                          "fullReportAvailable": True}, projected["evidence"])

    def test_projection_does_not_mutate_or_alias_the_original(self):
        result = completed_run()
        before = deepcopy(result)
        projected = decision_result(result)
        self.assertEqual(before, result)
        projected["observation"]["nodes"][0]["text"] = "changed"
        projected["counters"]["captures"] = 999
        projected["goalVerification"]["assertions"].append({"status": "failed"})
        self.assertEqual(before, result)

    def test_each_non_success_step_and_top_level_diagnostic_remains_complete(self):
        for status in ("failed", "unknown", "cancelled", "budget_exhausted", "started"):
            with self.subTest(status=status):
                step = command_step(status=status, error={"code": "SYNTHETIC_FAILURE", "dispatched": "unknown",
                                                         "details": {"recovery": "inspect before continuing"}})
                result = completed_run([step])
                result.update(status=status, yieldReason="unresolved", error=deepcopy(step["error"]),
                              errors=[{"code": "EXTRA_DIAGNOSTIC"}], warnings=["Keep this warning."],
                              frameValidForActions=False)
                projected = decision_result(result)
                self.assertEqual([step], projected["steps"])
                for key in ("status", "yieldReason", "error", "errors", "warnings", "frameValidForActions"):
                    self.assertEqual(result[key], projected[key])
                projected["steps"][0]["error"]["details"]["recovery"] = "changed"
                self.assertEqual("inspect before continuing", step["error"]["details"]["recovery"])

    def test_completed_callback_does_not_hide_failed_or_unknown_evidence(self):
        changes = [{"assertion": {"status": "failed", "actual": "unexpected", "expected": "ready"}},
                   {"inputVerification": {"status": "unknown", "actual": None}},
                   {"guardAssertions": [{"status": "failed", "actual": False}]},
                   {"action": {"status": "completed", "dispatched": "unknown"}},
                   {"action": {"status": "not_dispatched", "dispatched": "no"}},
                   {"warnings": ["A required evidence file is missing."]}]
        for change in changes:
            with self.subTest(change=change):
                step = command_step()
                step["result"].update(change)
                result = completed_run([step])
                projected = decision_result(result)
                self.assertEqual([step], projected["steps"])
                self.assertEqual(result["lastResult"], projected["lastResult"])

    def test_terminal_missing_action_receipt_is_retained_for_unknown_outcome(self):
        step = command_step(result={"frameId": "frame-b"})
        result = completed_run([step])
        result.update(status="unknown", yieldReason="action_not_confirmed")
        projected = decision_result(result)
        self.assertEqual([step], projected["steps"])
        self.assertEqual({}, projected["stepsSummary"]["actionStatuses"])
        self.assertEqual(["press"], projected["stepsSummary"]["actionCommands"])

    def test_completed_else_branch_summarizes_normal_false_condition(self):
        condition = {"stepId": "1", "path": "steps[0]", "kind": "if", "status": "completed",
                     "result": {"status": "failed", "selector": {"id": "counter"},
                                "actual": "0", "expected": "1", "frameId": "frame-a"}}
        result = completed_run([condition, command_step(2)])
        projected = decision_result(result)
        self.assertEqual("completed", projected["status"])
        self.assertNotIn("steps", projected)
        self.assertEqual(2, projected["stepsSummary"]["omittedSuccessSteps"])
        self.assertEqual({"matched": 0, "notMatched": 1, "unknown": 0}, projected["stepsSummary"]["conditions"])

    def test_completed_repeat_false_checks_summarize_without_hiding_failed_assertions_or_diagnostics(self):
        check = {"stepId": "1", "path": "steps[0].repeat.check[0]", "kind": "repeat", "status": "completed",
                 "result": {"status": "failed", "actual": "0", "expected": "1", "frameId": "frame-a"}}
        passed = deepcopy(check)
        passed.update(stepId="2", path="steps[0].repeat.check[1]")
        passed["result"].update(status="passed", actual="1")
        result = completed_run([check, passed, command_step(3)])
        projected = decision_result(result)
        self.assertNotIn("steps", projected)
        self.assertEqual({"matched": 1, "notMatched": 1, "unknown": 0}, projected["stepsSummary"]["conditions"])
        for kind in ("assert", "precondition", "goal"):
            failed = deepcopy(check)
            failed["kind"] = kind
            with self.subTest(kind=kind):
                projected = decision_result(completed_run([failed, command_step(2)]))
                self.assertEqual([failed], projected["steps"])
        for diagnostic in ({"warnings": ["Uncertain source."]}, {"error": {"code": "UNRESOLVED"}},
                           {"nested": {"status": "unknown"}}, {"status": "unknown"}):
            uncertain = deepcopy(check)
            uncertain["result"].update(diagnostic)
            with self.subTest(diagnostic=diagnostic):
                projected = decision_result(completed_run([uncertain, command_step(2)]))
                self.assertEqual([uncertain], projected["steps"])
        result.update(status="yielded", yieldReason="repeat_limit")
        self.assertEqual([check], decision_result(result)["steps"])

    def test_read_binding_success_is_summarized_but_failed_read_is_retained(self):
        read = {"stepId": "1", "path": "steps[0]", "kind": "read", "status": "completed",
                "result": {"status": "passed", "name": "reference", "value": "sample-value", "frameId": "frame-a"}}
        result = completed_run([read, command_step(2, "fill")])
        result["planVersion"] = "2"
        projected = decision_result(result)
        self.assertNotIn("sample-value", json.dumps(projected))
        self.assertEqual(["fill"], projected["stepsSummary"]["actionCommands"])
        read["result"].update(status="unknown", reason="ambiguous_matches", matches=2)
        projected = decision_result(result)
        self.assertEqual(read, projected["steps"][0])

    def test_checkpoint_error_preserves_acknowledged_action_and_recovery_evidence(self):
        step = command_step(checkpointError={"code": "RECEIPT_WRITE_FAILED"})
        projected = decision_result(completed_run([step]))
        self.assertEqual([step], projected["steps"])
        self.assertEqual({"completed": 1}, projected["stepsSummary"]["actionStatuses"])

    def test_action_error_details_are_counted_without_counting_read_commands(self):
        step = command_step(2, "back", status="unknown", error={"code": "LOST_ACK", "details": {
            "action": {"status": "unknown", "dispatched": "unknown"}}})
        del step["result"]
        observe = {"stepId": "1", "kind": "command", "command": "observe", "status": "completed",
                   "result": {"frameId": "frame-a"}}
        result = completed_run([observe])
        result["steps"].append(step)
        result["status"] = "unknown"
        projected = decision_result(result)
        self.assertEqual(["back"], projected["stepsSummary"]["actionCommands"])
        self.assertEqual({"unknown": 1}, projected["stepsSummary"]["actionStatuses"])
        self.assertEqual({"observe": 1, "back": 1}, projected["stepsSummary"]["commands"])

    def test_unique_last_result_data_and_error_are_not_lost_during_deduplication(self):
        result = completed_run()
        result["lastResult"]["recovery"] = {"readOnly": True, "reason": "unique-information"}
        projected = decision_result(result)
        self.assertEqual({"recovery": result["lastResult"]["recovery"]}, projected["lastResult"])
        result["lastResult"]["error"] = {"code": "UNIQUE_ERROR", "details": {"dispatched": "unknown"}}
        projected = decision_result(result)
        self.assertEqual(result["lastResult"], projected["lastResult"])

    def test_different_last_operation_is_not_deduplicated_just_because_its_status_matches(self):
        result = completed_run()
        result["lastResult"]["operationId"] = "another-operation"
        projected = decision_result(result)
        self.assertEqual(result["lastResult"], projected["lastResult"])

    def test_existing_evidence_and_future_top_level_fields_are_preserved(self):
        result = completed_run()
        result["evidence"] = {"screenshots": [{"path": "synthetic-evidence.png"}]}
        result["futureMetadata"] = {"values": [False, 0, ""]}
        projected = decision_result(result)
        self.assertEqual(result["evidence"]["screenshots"], projected["evidence"]["screenshots"])
        self.assertEqual(result["futureMetadata"], projected["futureMetadata"])
        projected["futureMetadata"]["values"].append("changed")
        self.assertEqual([False, 0, ""], result["futureMetadata"]["values"])

    def test_final_goal_after_command_does_not_prevent_duplicate_last_receipt_removal(self):
        result = completed_run()
        goal = {"stepId": "2", "kind": "goal", "status": "completed", "result": {
            "status": "passed", "actual": "1", "expected": "1", "frameId": "frame-b"}}
        result["steps"].append(goal)
        result["goalVerification"] = {"status": "passed", "assertions": [goal["result"]]}
        projected = decision_result(result)
        self.assertNotIn("lastResult", projected)
        self.assertEqual(result["goalVerification"], projected["goalVerification"])

    def test_persistence_failure_retains_every_receipt_and_does_not_promise_full_report(self):
        result = completed_run([command_step(1), command_step(2)])
        result.update(status="unknown", yieldReason="receipt_persistence_failed",
                      persistenceError={"code": "RECEIPT_WRITE_FAILED", "details": {"runId": "synthetic-run"}})
        projected = decision_result(result)
        self.assertEqual(result["steps"], projected["steps"])
        self.assertEqual(result["lastResult"], projected["lastResult"])
        self.assertEqual(result["persistenceError"], projected["persistenceError"])
        self.assertFalse(projected["evidence"]["fullReportAvailable"])
        self.assertEqual(0, projected["stepsSummary"]["omittedSuccessSteps"])

    def test_complete_storage_and_compact_report_are_unchanged_by_decision_projection(self):
        with tempfile.TemporaryDirectory() as folder:
            store = RunStore(folder, "synthetic-run")
            store.begin({"version": "1", "steps": [{"stop": "finished"}]},
                        {"name": "default", "epoch": "epoch", "device": "synthetic-device"})
            frame = normalize_layout({"type": "Text", "text": "1", "id": "counter"}, "frame-b")
            frame.update(capturedAt="2026-01-01T00:00:00+00:00", sessionEpoch="epoch", device="synthetic-device")
            store.save_frame(frame)
            result = completed_run()
            result["steps"][0]["result"]["beforeFrameId"] = "frame-b"
            result["lastResult"] = deepcopy(result["steps"][0]["result"])
            result["observation"] = frame
            store.checkpoint({"event": "step_finished", **result["steps"][0]})
            store.finish(result)
            path = Path(folder) / "runs" / "synthetic-run" / "run.json"
            before = path.read_bytes()
            full = store.read(full=True)
            compact = store.read()
            projected = decision_result(result)
            self.assertNotIn("steps", projected)
            self.assertEqual(result, store.read(full=True)["result"])
            self.assertEqual(full, store.read(full=True))
            self.assertEqual(compact, store.read())
            self.assertTrue(full["evidenceCheck"]["complete"])
            self.assertEqual(before, path.read_bytes())
            self.assertEqual(frame, store.frame(projected["evidence"]["frameIds"][0]))

    def test_real_runner_projection_reduces_bytes_without_more_device_calls(self):
        from harmony_agent.core import Agent
        from tests.test_core import FakeNativeTransport

        with tempfile.TemporaryDirectory() as folder:
            transport = FakeNativeTransport()
            agent = Agent(folder, transport=transport)
            agent.execute("attach", {"device": transport.serial})
            try:
                steps = [{"command": "press", "input": {"target": {"id": "fixture.increment"},
                         "expect": {"selector": {"id": "fixture.counter"}, "equals": f"Counter: {index}"}}}
                         for index in range(1, 6)]
                result = agent.execute("run", {"run_id": "synthetic-run", "plan": {"version": "1", "steps": steps,
                    "goals": [{"selector": {"id": "fixture.counter"}, "equals": "Counter: 5"}]}})
                before = (transport.captures, deepcopy(transport.mutations), transport.counter)
                projected = decision_result(result)
                self.assertEqual(before, (transport.captures, transport.mutations, transport.counter))
                self.assertEqual(5, transport.counter)
                self.assertEqual(result["counters"], projected["counters"])
                self.assertEqual("passed", projected["goalVerification"]["status"])
                self.assertEqual(["press"] * 5, projected["stepsSummary"]["actionCommands"])
                self.assertLess(len(json.dumps(projected)), len(json.dumps(result)))
                report = agent.execute("report", {"run_id": "synthetic-run", "full": True})
                self.assertEqual(result["steps"], report["result"]["steps"])
                self.assertTrue(report["evidenceCheck"]["complete"])
            finally:
                agent.execute("detach")


if __name__ == "__main__":
    unittest.main()
