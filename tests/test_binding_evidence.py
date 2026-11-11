"""Saved bound values are checked against frozen sources only when reporting."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from harmony_agent.execution import RunStore, atomic_json
from harmony_agent.observation import normalize_layout


class BindingEvidenceTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.store = RunStore(folder.name, "binding-evidence")
        self.store.begin({"version": "2", "steps": [{"stop": "done"}]},
                         {"name": "default", "epoch": "epoch", "device": "synthetic-device"})
        frame = normalize_layout({"type": "Column", "children": [
            {"id": "source", "type": "Text", "text": "Code: NEW-741"},
            {"id": "other", "type": "Text", "text": "Code: OTHER"},
            {"id": "flag", "type": "Toggle", "checked": False},
        ]}, "source-frame")
        self.store.save_frame(frame)
        self.reads = [
            {"name": "code", "selector": {"id": "source"}, "property": "text", "stripPrefix": "Code: ",
             "value": "NEW-741", "frameId": "source-frame"},
            {"name": "flag", "selector": {"id": "flag"}, "property": "checked",
             "value": False, "frameId": "source-frame"}]
        steps = [{"stepId": str(index), "path": f"steps[{index - 1}]", "kind": "read", "status": "completed",
                  "result": deepcopy(value)} for index, value in enumerate(self.reads, start=1)]
        for step in steps:
            self.store.checkpoint({"event": "step_finished", **step})
        self.store.finish({"status": "completed", "steps": steps, "runId": "binding-evidence",
                           "goalVerification": {"status": "not_requested", "assertions": []}})
        self.path = Path(folder.name) / "runs" / "binding-evidence" / "run.json"

    def corrupt(self, change):
        value = json.loads(self.path.read_text(encoding="utf-8"))
        change(value)
        atomic_json(self.path, value)

    def test_full_and_compact_report_verify_transformed_text_and_false_without_writing(self):
        before = self.path.read_bytes()
        full, compact = self.store.read(full=True), self.store.read()
        self.assertEqual(full["evidenceCheck"], compact["evidenceCheck"])
        self.assertEqual({"missingFrames": [], "assertionMismatches": [], "assertionsChecked": 0,
                          "bindingsChecked": 4, "bindingMismatches": [], "complete": True}, full["evidenceCheck"])
        self.assertIs(full["result"]["steps"][1]["result"]["value"], False)
        self.assertEqual(before, self.path.read_bytes())

    def test_tampered_value_cannot_be_reported_as_complete_binding_evidence(self):
        self.corrupt(lambda report: report["result"]["steps"][0]["result"].update(value="OTHER-VALUE"))
        before = self.path.read_bytes()
        full, compact = self.store.read(full=True), self.store.read()
        self.assertEqual(full["evidenceCheck"], compact["evidenceCheck"])
        self.assertFalse(full["evidenceCheck"]["complete"])
        self.assertEqual([{"frameId": "source-frame", "name": "code", "reason": "binding_value_mismatch"}],
                         full["evidenceCheck"]["bindingMismatches"])
        self.assertEqual("completed", full["status"])
        self.assertEqual("not_requested", full["result"]["goalVerification"]["status"])
        self.assertFalse(full["replayAllowed"])
        self.assertEqual(before, self.path.read_bytes())

    def test_boolean_value_does_not_equal_integer_zero(self):
        self.corrupt(lambda report: report["result"]["steps"][1]["result"].update(value=0))
        result = self.store.read(full=True)
        self.assertFalse(result["evidenceCheck"]["complete"])
        self.assertEqual("binding_value_mismatch", result["evidenceCheck"]["bindingMismatches"][0]["reason"])

    def test_missing_ambiguous_and_invalid_source_properties_are_incomplete(self):
        original = self.path.read_bytes()
        cases = [({"selector": {"id": "missing"}}, "binding_source_not_unique"),
                 ({"selector": {"textPrefix": "Code: "}}, "binding_source_not_unique"),
                 ({"stripPrefix": "Wrong: "}, "invalid_binding_source"),
                 ({"stripPrefix": 1}, "invalid_binding_source"),
                 ({"property": "checked"}, "invalid_binding_source"),
                 ({"property": "unsupported"}, "invalid_binding"),
                 ({"selector": {"unsupported": "field"}}, "invalid_binding_source")]
        for changes, reason in cases:
            with self.subTest(changes=changes):
                self.path.write_bytes(original)
                self.corrupt(lambda report: report["result"]["steps"][0]["result"].update(changes))
                result = self.store.read()
                self.assertFalse(result["evidenceCheck"]["complete"])
                self.assertEqual(reason, result["evidenceCheck"]["bindingMismatches"][0]["reason"])

    def test_missing_bound_value_frame_or_completed_read_result_is_not_accepted(self):
        original = self.path.read_bytes()
        for field in ("value", "frameId", "name", "selector", "property"):
            with self.subTest(field=field):
                self.path.write_bytes(original)
                self.corrupt(lambda report: report["result"]["steps"][0]["result"].pop(field))
                self.assertFalse(self.store.read()["evidenceCheck"]["complete"])
        self.path.write_bytes(original)
        self.corrupt(lambda report: report["result"]["steps"][0].pop("result"))
        self.assertEqual([{"reason": "invalid_binding"}], self.store.read()["evidenceCheck"]["bindingMismatches"])

    def test_missing_frozen_frame_uses_existing_missing_frame_semantics(self):
        self.corrupt(lambda report: report["result"]["steps"][0]["result"].update(frameId="missing-frame"))
        report = self.store.read()
        self.assertFalse(report["evidenceCheck"]["complete"])
        self.assertEqual(["missing-frame"], report["evidenceCheck"]["missingFrames"])
        self.assertEqual([], report["evidenceCheck"]["bindingMismatches"])

    def test_failed_read_without_result_keeps_failure_without_inventing_bound_values(self):
        error = {"code": "PLAN_READ_FAILED", "details": {"matches": 0}, "dispatched": "no"}
        failed = {"kind": "read", "stepId": "3", "status": "unknown", "error": error}
        def add_failure(report):
            report["status"] = report["result"]["status"] = "unknown"
            report["result"]["error"] = deepcopy(error)
            report["result"]["steps"].append(deepcopy(failed))
            report["receipts"].append({"event": "step_finished", **failed})
        self.corrupt(add_failure)
        report = self.store.read(full=True)
        self.assertEqual("unknown", report["status"])
        self.assertEqual(error, report["result"]["error"])
        self.assertEqual(4, report["evidenceCheck"]["bindingsChecked"])
        self.assertEqual([], report["evidenceCheck"]["bindingMismatches"])


if __name__ == "__main__":
    unittest.main()
