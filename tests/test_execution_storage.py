"""Lossless evidence storage and atomic publication, using synthetic frames."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harmony_agent.errors import AgentError
from harmony_agent.execution import RunStore, atomic_json
from harmony_agent.observation import normalize_layout
from harmony_agent.state import loaded_frame, stored_frame


class ExecutionStorageTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.store = RunStore(self.root, "synthetic")
        self.store.begin({"version": "1", "steps": [{"stop": "done"}]},
                         {"name": "default", "epoch": "epoch", "device": "synthetic-device"})
        self.frame = normalize_layout({"type": "Column", "children": [
            {"id": "input", "type": "TextInput", "text": "", "hint": "Name", "focused": False},
            {"id": "counter", "type": "Text", "text": "Count: 0", "value": 0},
            {"id": "toggle", "type": "Toggle", "text": "Remember", "checkable": True, "checked": False},
            {"id": "button", "type": "Button", "text": "Continue", "clickable": True},
        ]}, "frame-a")
        self.frame.update(capturedAt="2026-01-01T00:00:00+00:00", sessionEpoch="epoch", device="synthetic-device")

    def frame_path(self):
        return self.store.folder / "frames" / "frame-a.json"

    def finish_report(self):
        self.store.save_frame(self.frame)
        assertion = {"selector": {"id": "counter"}, "property": "text", "expected": "Count: 0",
                     "actual": "Count: 0", "status": "passed", "frameId": "frame-a"}
        action = {"status": "completed", "dispatched": "acknowledged"}
        step = {"stepId": "1", "kind": "command", "status": "completed", "elapsedMs": 1,
                "result": {"action": action, "assertion": assertion, "frameId": "frame-a"}}
        self.store.checkpoint({"event": "step_finished", **deepcopy(step)})
        self.store.finish({"status": "completed", "steps": [step], "observation": self.frame,
                           "lastResult": {"action": action, "assertion": assertion},
                           "goalVerification": {"status": "passed", "assertions": [assertion]}})
        return step

    def test_frozen_frame_stores_nodes_once_and_restores_exact_evidence(self):
        before = deepcopy(self.frame)
        self.store.save_frame(self.frame)
        text = self.frame_path().read_text(encoding="utf-8")
        stored = json.loads(text)
        self.assertEqual("harmony-frame/indexed/1", stored["storageFormat"])
        self.assertEqual(self.frame["nodes"], stored["nodes"])
        self.assertTrue(all(isinstance(ref, str) for ref in stored["facts"] + stored["controls"]))
        self.assertLess(len(text), len(json.dumps(self.frame, ensure_ascii=False, separators=(",", ":"))))
        restored = self.store.frame("frame-a")
        self.assertEqual(before, restored)
        by_ref = {node["ref"]: node for node in restored["nodes"]}
        for key in ("controls", "facts"):
            for node in restored[key]:
                self.assertIs(node, by_ref[node["ref"]])
        self.assertEqual(before, self.frame)

    def test_legacy_frozen_frame_remains_readable_and_upgrades_on_save(self):
        self.frame_path().parent.mkdir(parents=True)
        self.frame_path().write_text(json.dumps(self.frame, ensure_ascii=False), encoding="utf-8")
        restored = self.store.frame("frame-a")
        self.assertEqual(self.frame, restored)
        self.store.save_frame(restored)
        self.assertIn("storageFormat", json.loads(self.frame_path().read_text(encoding="utf-8")))
        self.assertEqual(self.frame, self.store.frame("frame-a"))

    def test_indexed_frame_corruption_is_not_silently_accepted(self):
        self.store.save_frame(self.frame)
        original = json.loads(self.frame_path().read_text(encoding="utf-8"))
        changes = {
            "unknown-format": lambda value: value.update(storageFormat="harmony-frame/indexed/99"),
            "duplicate-node": lambda value: value["nodes"].append(deepcopy(value["nodes"][0])),
            "missing-node": lambda value: value.update(facts=["@e999~frame-a"]),
            "invalid-reference": lambda value: value.update(controls=[[]]),
            "missing-index": lambda value: value.pop("facts"),
        }
        for name, change in changes.items():
            with self.subTest(name=name):
                value = deepcopy(original)
                change(value)
                self.frame_path().write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(AgentError) as error:
                    self.store.frame("frame-a")
                self.assertEqual("INVALID_FRAME", error.exception.code)

    def test_codec_preserves_empty_false_and_zero_values_without_mutation(self):
        before = deepcopy(self.frame)
        restored = loaded_frame(json.loads(json.dumps(stored_frame(self.frame))))
        self.assertEqual(before, restored)
        nodes = {node["id"]: node for node in restored["nodes"]}
        self.assertEqual("", nodes["input"]["value"])
        self.assertIs(nodes["input"]["focused"], False)
        self.assertIs(nodes["toggle"]["checked"], False)
        self.assertEqual("0", nodes["counter"]["value"])
        self.assertEqual(before, self.frame)

    def test_atomic_json_retains_exact_unicode_and_compact_encoding(self):
        path = self.root / "unicode.json"
        value = {"message": "\u4f60\u597d \U0001f642\nnext", "empty": "", "checked": False, "count": 0}
        atomic_json(path, value)
        self.assertEqual(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), path.read_bytes())
        self.assertEqual(value, json.loads(path.read_text(encoding="utf-8")))

    def test_flush_or_replace_failure_keeps_previous_file_and_removes_temporary_file(self):
        path = self.root / "atomic.json"
        atomic_json(path, {"value": "before"})
        original = path.read_bytes()
        for operation in ("os.fsync", "atomic_replace"):
            with self.subTest(operation=operation):
                with patch("harmony_agent.execution." + operation, side_effect=OSError("synthetic failure")):
                    with self.assertRaises(OSError):
                        atomic_json(path, {"value": "after"})
                self.assertEqual(original, path.read_bytes())
                self.assertEqual([], list(self.root.glob(".pending-*")))

    def test_compact_report_keeps_receipts_goals_and_frame_links_without_rewriting_evidence(self):
        self.finish_report()
        record_path = self.store.folder / "run.json"
        before = record_path.read_bytes()
        full = self.store.read(full=True)
        compact = self.store.read()
        self.assertNotIn("steps", compact["result"])
        self.assertNotIn("observation", compact["result"])
        self.assertEqual(full["receipts"], compact["receipts"])
        self.assertEqual(full["result"]["goalVerification"], compact["result"]["goalVerification"])
        self.assertEqual(full["result"]["lastResult"], compact["result"]["lastResult"])
        self.assertEqual(full["frames"], compact["frames"])
        self.assertEqual(full["evidenceCheck"], compact["evidenceCheck"])
        self.assertTrue(compact["evidenceCheck"]["complete"])
        self.assertFalse(compact["replayAllowed"])
        self.assertEqual("frame-a", compact["result"]["observationRef"]["frameId"])
        self.assertEqual("synthetic", compact["result"]["observationRef"]["runId"])
        self.assertEqual(["result.steps", "result.observation"], compact["projection"]["omittedPaths"])
        self.assertEqual(1, compact["projection"]["omittedStepCopies"])
        self.assertNotIn("projection", full)
        self.assertEqual(before, record_path.read_bytes())
        self.assertEqual(json.loads(before)["result"], self.store.read(full=True)["result"])

    def test_compact_report_retains_steps_without_identical_durable_receipts(self):
        step = self.finish_report()
        unique = deepcopy(step)
        unique.update(stepId="2", status="unknown", checkpointError={"code": "RECEIPT_WRITE_FAILED"})
        outcome = deepcopy(self.store.record["result"])
        outcome["steps"].append(unique)
        self.store.finish(outcome)
        compact = self.store.read()
        self.assertEqual([unique], compact["result"]["steps"])
        self.assertEqual(1, compact["projection"]["omittedStepCopies"])
        self.assertEqual(1, compact["projection"]["retainedUnmatchedSteps"])

    def test_evidence_check_reads_full_record_before_projection(self):
        step = self.finish_report()
        outcome = deepcopy(self.store.record["result"])
        outcome["steps"][0]["result"]["assertion"]["actual"] = "tampered"
        self.store.finish(outcome)
        compact = self.store.read()
        full = self.store.read(full=True)
        self.assertEqual(full["evidenceCheck"], compact["evidenceCheck"])
        self.assertFalse(compact["evidenceCheck"]["complete"])
        self.assertIn({"frameId": "frame-a", "reason": "actual_value_mismatch"},
                      compact["evidenceCheck"]["assertionMismatches"])
        self.assertEqual(0, compact["projection"]["omittedStepCopies"])
        self.assertEqual(1, compact["projection"]["retainedUnmatchedSteps"])
        self.assertEqual(step["result"]["assertion"], compact["receipts"][0]["result"]["assertion"])

    def test_missing_evidence_and_unresolved_execution_are_not_hidden_by_compaction(self):
        self.finish_report()
        self.frame_path().unlink()
        compact = self.store.read()
        self.assertFalse(compact["evidenceCheck"]["complete"])
        self.assertEqual(["frame-a"], compact["evidenceCheck"]["missingFrames"])
        self.assertFalse(compact["replayAllowed"])
        self.store.record.update(status="running", activeStep={"stepId": "2", "status": "started"})
        self.store._save()
        compact = self.store.read()
        self.assertEqual("unresolved", compact["outcome"])
        self.assertEqual({"stepId": "2", "status": "started"}, compact["activeStep"])


if __name__ == "__main__":
    unittest.main()
