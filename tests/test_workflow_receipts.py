"""Task closing evidence remains separate from the immutable business result."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harmony_agent.errors import AgentError
from harmony_agent.execution import RunStore, atomic_json


class WorkflowReceiptTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.session = {"name": "task", "epoch": "epoch", "device": "synthetic-device"}
        self.store = RunStore(self.root, "task-run")
        self.store.begin({"version": "1", "steps": [{"stop": "done"}]}, self.session)
        self.result = {"runId": "task-run", "status": "completed", "steps": [],
                       "goalVerification": {"status": "passed", "assertions": []}, "frameValidForActions": True}
        self.store.finish(self.result)
        self.cleanup = {"status": "detached", "reason": "verified_completion", "deviceStopped": False}
        self.path = self.store.folder / "workflow.json"

    def test_receipt_does_not_rewrite_or_reread_full_execution_result(self):
        run_path = self.store.folder / "run.json"
        original = run_path.read_bytes()
        with patch.object(RunStore, "read", side_effect=AssertionError("unexpected full report read")):
            receipt = self.store.write_workflow_receipt(self.session, self.cleanup)
        self.assertTrue(receipt["available"])
        self.assertEqual(self.session, receipt["session"])
        self.assertEqual(self.cleanup, receipt["sessionCleanup"])
        self.assertEqual("harmony-workflow-receipt/1", receipt["schema"])
        self.assertNotIn("available", json.loads(self.path.read_text(encoding="utf-8")))
        self.assertEqual(original, run_path.read_bytes())
        for full in (False, True):
            report = self.store.read(full=full)
            self.assertEqual(receipt, report["workflowReceipt"])
            self.assertEqual(self.result, report["result"])
            self.assertTrue(report["evidenceCheck"]["complete"])
        self.assertEqual(original, run_path.read_bytes())

    def test_failed_and_retained_cleanup_are_not_confused_with_closed(self):
        for cleanup in ({"status": "retained", "reason": "keep_session", "deviceStopped": False},
                        {"status": "failed", "reason": "cleanup_error", "deviceStopped": False,
                         "error": {"code": "SESSION_CLEANUP_FAILED", "details": {"phase": "release_device"}}}):
            with self.subTest(status=cleanup["status"]):
                receipt = self.store.write_workflow_receipt(self.session, cleanup)
                receipt["sessionCleanup"]["reason"] = "mutated public result"
                report = self.store.read(full=True)
                self.assertEqual(cleanup, report["workflowReceipt"]["sessionCleanup"])
                self.assertEqual("completed", report["status"])
                self.assertFalse(report["replayAllowed"])

    def test_legacy_report_without_closing_receipt_explicitly_reports_unknown(self):
        report = self.store.read(full=True)
        self.assertEqual({"available": False, "runId": "task-run", "sessionCleanup": {"status": "unknown"},
                          "reason": "not_recorded"}, report["workflowReceipt"])
        self.assertEqual(self.result, report["result"])
        self.assertTrue(report["evidenceCheck"]["complete"])

    def test_corrupt_and_unreadable_sidecar_does_not_destroy_business_report(self):
        self.path.write_text("{unfinished", encoding="utf-8")
        report = self.store.read(full=True)
        self.assertEqual("unreadable", report["workflowReceipt"]["reason"])
        self.assertEqual("unknown", report["workflowReceipt"]["sessionCleanup"]["status"])
        self.assertEqual(self.result, report["result"])
        original_read = Path.read_text
        def denied(path, *args, **kwargs):
            if path == self.path:
                raise PermissionError("synthetic closing receipt read denied")
            return original_read(path, *args, **kwargs)
        with patch.object(Path, "read_text", denied):
            report = self.store.read(full=True)
        self.assertEqual("WORKFLOW_RECEIPT_READ_FAILED", report["workflowReceipt"]["error"]["code"])
        self.assertTrue(report["evidenceCheck"]["complete"])

    def test_sidecar_schema_time_and_cleanup_shape_must_be_valid(self):
        self.store.write_workflow_receipt(self.session, self.cleanup)
        original = json.loads(self.path.read_text(encoding="utf-8"))
        mutations = [lambda item: item.update(schema="unknown"), lambda item: item.update(at="not-a-time"),
                     lambda item: item.update(at="2026-01-01T00:00:00"),
                     lambda item: item["sessionCleanup"].update(status="unknown"),
                     lambda item: item["sessionCleanup"].update(deviceStopped=True),
                     lambda item: item["sessionCleanup"].update(status="failed")]
        for mutate in mutations:
            item = deepcopy(original)
            mutate(item)
            atomic_json(self.path, item)
            report = self.store.read(full=True)
            self.assertFalse(report["workflowReceipt"]["available"])
            self.assertEqual("invalid", report["workflowReceipt"]["reason"])
            self.assertEqual(self.result, report["result"])
        atomic_json(self.path, ["not a receipt object"])
        self.assertEqual("invalid", self.store.read()["workflowReceipt"]["reason"])

    def test_sidecar_identity_must_match_run_and_session_header(self):
        self.store.write_workflow_receipt(self.session, self.cleanup)
        original = json.loads(self.path.read_text(encoding="utf-8"))
        for field in ("runId", "name", "device", "epoch"):
            with self.subTest(field=field):
                item = deepcopy(original)
                target = item if field == "runId" else item["session"]
                target[field] = "different-identity"
                atomic_json(self.path, item)
                report = self.store.read(full=True)
                self.assertFalse(report["workflowReceipt"]["available"])
                self.assertEqual("identity_mismatch", report["workflowReceipt"]["reason"])
                self.assertEqual("unknown", report["workflowReceipt"]["sessionCleanup"]["status"])
                self.assertEqual(self.result, report["result"])

    def test_write_failure_preserves_original_journal_and_does_not_claim_receipt_exists(self):
        original = (self.store.folder / "run.json").read_bytes()
        with patch("harmony_agent.execution.atomic_json", side_effect=OSError(13, "synthetic write denied")):
            with self.assertRaises(AgentError) as error:
                self.store.write_workflow_receipt(self.session, self.cleanup)
        self.assertEqual("WORKFLOW_RECEIPT_WRITE_FAILED", error.exception.code)
        self.assertEqual(original, (self.store.folder / "run.json").read_bytes())
        self.assertEqual("not_recorded", self.store.read()["workflowReceipt"]["reason"])

    def test_failed_atomic_replace_keeps_previous_receipt_and_removes_temporary_file(self):
        self.store.write_workflow_receipt(self.session, self.cleanup)
        before = self.path.read_bytes()
        with patch("harmony_agent.execution.atomic_replace", side_effect=OSError(13, "synthetic replace denied")):
            with self.assertRaises(AgentError):
                self.store.write_workflow_receipt(self.session, {"status": "retained", "reason": "keep_session", "deviceStopped": False})
        self.assertEqual(before, self.path.read_bytes())
        self.assertEqual([], list(self.store.folder.glob(".pending-*")))

    def test_write_requires_existing_business_journal_and_valid_cleanup(self):
        missing = RunStore(self.root, "no-run")
        with self.assertRaises(AgentError) as error:
            missing.write_workflow_receipt(self.session, self.cleanup)
        self.assertEqual("WORKFLOW_RECEIPT_WRITE_FAILED", error.exception.code)
        self.assertFalse(missing.folder.exists())
        with self.assertRaises(AgentError) as error:
            self.store.write_workflow_receipt(self.session, {"status": "detached"})
        self.assertEqual("WORKFLOW_RECEIPT_INVALID", error.exception.code)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
