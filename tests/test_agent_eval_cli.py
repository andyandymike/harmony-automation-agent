"""The evaluation recorder must preserve evidence and never repeat an action."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/agent-eval-cli.py"
SPEC = importlib.util.spec_from_file_location("agent_eval_cli", SCRIPT)
wrapper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wrapper)


def success_bytes(*, dispatched="acknowledged"):
    payload = {"schemaVersion": "1", "version": "0.1.0a2", "success": True,
               "data": {"action": {"status": "completed", "dispatched": dispatched},
                        "assertion": {"status": "passed"}, "value": "中文结果"}}
    return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")


class AgentEvalCliTests(unittest.TestCase):
    def test_cleanup_summary_records_only_known_status_without_private_error_details(self):
        payload = {"success": True, "data": {"status": "completed", "goalVerification": {"status": "passed"},
                   "sessionCleanup": {"status": "failed", "error": {"message": "private-cleanup-details"}}}}
        for cleanup_status in ("detached", "retained", "failed", "unknown", None, "private-cleanup-details"):
            payload["data"]["sessionCleanup"]["status"] = cleanup_status
            summary = wrapper.result_summary(payload, "execute")
            self.assertEqual(cleanup_status if cleanup_status in ("detached", "retained", "failed", "unknown") else None,
                             summary["sessionCleanupStatus"])
            self.assertNotIn("private-cleanup-details", json.dumps(summary))
        del payload["data"]["sessionCleanup"]
        self.assertIsNone(wrapper.result_summary(payload, "run")["sessionCleanupStatus"])

    def test_execute_decision_retains_plan_action_order_and_status(self):
        payload = {"success": True, "version": "0.1.0a9", "data": {
            "format": "harmony-run-decision/1", "status": "completed",
            "goalVerification": {"status": "passed"}, "counters": {"actions": 2},
            "stepsSummary": {"actionCommands": ["fill", "press"]}, "steps": [],
            "profile": {"counts": {"captures": 5, "reusedTargetFrames": 1}}}}
        result = wrapper.result_summary(payload, "execute")
        self.assertEqual(result["actionCommands"], ["fill", "press"])
        self.assertEqual(result["actionCount"], 2)
        self.assertEqual(result["runStatus"], "completed")
        self.assertEqual(result["goalVerification"], "passed")
        self.assertEqual(result["captureCount"], 5)
        self.assertEqual(wrapper.command_name(["execute", "--device", "synthetic"]), "execute")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, args, stdout, *, stderr=b"", returncode=0, inject=False, installed=False, metadata_flags=None):
        flags = [str(SCRIPT), "--record-dir", str(self.folder)]
        flags.extend(metadata_flags or [])
        if inject:
            flags.append("--drop-press-ack-once")
        if installed:
            flags.extend(["--installed", "--python", "example python"])
        emitted, diagnostic = io.BytesIO(), io.BytesIO()
        completed = subprocess.CompletedProcess([], returncode, stdout, stderr)
        with patch.object(wrapper.sys, "argv", [*flags, "--", *args]), \
                patch.object(wrapper.sys, "stdout", SimpleNamespace(buffer=emitted)), \
                patch.object(wrapper.sys, "stderr", SimpleNamespace(buffer=diagnostic)), \
                patch.object(wrapper.subprocess, "run", return_value=completed) as run:
            result = wrapper.main()
        run.assert_called_once()
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        self.assertIs(run.call_args.kwargs.get("check"), False)
        self.assertEqual(run.call_args.args[0][-len(args):], args)
        if installed:
            self.assertEqual(run.call_args.args[0][0], "example python")
            self.assertNotIn("PYTHONPATH", run.call_args.kwargs["env"])
        rows = [json.loads(line) for line in (self.folder / "calls.ndjson").read_text("utf-8").splitlines()]
        row = rows[-1]
        self.assertEqual((self.folder / (row["callId"] + ".stdout")).read_bytes(), stdout)
        self.assertEqual((self.folder / (row["callId"] + ".stderr")).read_bytes(), stderr)
        self.assertEqual((self.folder / (row["callId"] + ".emitted")).read_bytes(), emitted.getvalue())
        self.assertEqual(diagnostic.getvalue(), stderr)
        return result, emitted.getvalue(), row

    def test_plain_recording_forwards_exact_bytes_and_never_estimates_tokens(self):
        raw = success_bytes()
        diagnostic = "诊断\n".encode("utf-8")
        code, emitted, row = self.invoke(["press", "id=target", "--json"], raw, stderr=diagnostic)
        self.assertEqual(code, 0)
        self.assertEqual(emitted, raw)
        self.assertEqual(row["stdoutBytes"], len(raw))
        self.assertEqual(row["stderrBytes"], len(diagnostic))
        self.assertEqual(row["emittedBytes"], len(raw))
        self.assertNotEqual(row["stdoutBytes"], len(raw.decode("utf-8")))
        self.assertIsNone(row["inputTokens"])
        self.assertIsNone(row["outputTokens"])
        self.assertIsNone(row["modelMs"])
        self.assertLessEqual(row["startedMonotonicNs"], row["endedMonotonicNs"])
        self.assertLessEqual(row["startedAt"], row["endedAt"])
        self.assertEqual(row["at"], row["endedAt"])
        self.assertEqual(row["clockSource"], "python.perf_counter_ns")
        self.assertEqual(row["elapsedMs"], round((row["endedMonotonicNs"]-row["startedMonotonicNs"])/1e6, 2))
        self.assertIsNone(row["hostCallId"])
        self.assertIsNone(row["executionMode"])
        self.assertIsNone(row["declaredPlanBoundary"])
        self.assertFalse((self.folder / "fault-used").exists())

    def test_ack_loss_emits_unknown_once_but_preserves_original_reply(self):
        raw = success_bytes()
        code, emitted, row = self.invoke(["press", "id=target", "--json"], raw, inject=True)
        self.assertEqual(code, 1)
        unknown = json.loads(emitted)
        self.assertFalse(unknown["success"])
        self.assertEqual(unknown["error"]["code"], "REMOTE_RESULT_UNKNOWN")
        self.assertEqual(unknown["error"]["details"]["dispatched"], "unknown")
        self.assertEqual(unknown["error"]["details"]["assertion"]["status"], "unknown")
        self.assertEqual(row["exitCode"], 0)
        self.assertEqual(row["emittedExitCode"], 1)
        self.assertTrue(row["injectedReplyLoss"])
        self.assertEqual((self.folder / "fault-used").read_text("utf-8"), row["callId"])
        code, emitted, second = self.invoke(["press", "id=target", "--json"], raw, inject=True)
        self.assertEqual(code, 0)
        self.assertEqual(emitted, raw)
        self.assertNotIn("injectedReplyLoss", second)
        self.assertEqual((self.folder / "fault-used").read_text("utf-8"), row["callId"])

    def test_non_press_action_does_not_consume_fault(self):
        raw = success_bytes()
        code, emitted, row = self.invoke(["open", "com.example", "--json"], raw, inject=True)
        self.assertEqual(code, 0)
        self.assertEqual(emitted, raw)
        self.assertEqual(row["command"], "open")
        self.assertFalse((self.folder / "fault-used").exists())
        self.assertEqual(self.invoke(["press", "id=target", "--json"], raw, inject=True)[0], 1)

    def test_failed_press_is_unchanged_and_does_not_consume_fault(self):
        payload = {"schemaVersion": "1", "version": "0.1.0a2", "success": False,
                   "error": {"code": "ASSERTION_TIMEOUT", "details": {
                       "dispatched": "unknown", "action": {"status": "completed", "dispatched": "acknowledged"},
                       "assertion": {"status": "failed"}}}}
        raw = json.dumps(payload).encode("utf-8")
        code, emitted, row = self.invoke(["press", "id=target", "--json"], raw, returncode=1, inject=True)
        self.assertEqual((code, emitted), (1, raw))
        self.assertEqual(row["errorCode"], "ASSERTION_TIMEOUT")
        self.assertFalse((self.folder / "fault-used").exists())
        self.assertEqual(self.invoke(["press", "id=target", "--json"], success_bytes(), inject=True)[0], 1)

    def test_request_file_press_can_trigger_fault(self):
        request = self.folder / "请求 with spaces.json"
        request.write_text(json.dumps({"command": "press", "input": {"target": "id=target"}}), encoding="utf-8")
        code, emitted, row = self.invoke(["--request", str(request), "--json"], success_bytes(), inject=True)
        self.assertEqual(code, 1)
        self.assertEqual(row["command"], "press")
        self.assertFalse(json.loads(emitted)["success"])

    def test_installed_mode_uses_selected_python_without_checkout_pythonpath(self):
        code, emitted, row = self.invoke(["schema", "run", "--json"], success_bytes(), installed=True)
        self.assertEqual(code, 0)
        self.assertEqual(row["command"], "schema")

    def test_run_summary_separates_task_status_and_keeps_only_numeric_profile(self):
        payload = {"version": "0.1.0a7", "success": True, "data": {
            "status": "failed", "goalVerification": {"status": "unknown", "text": "private-ui-marker"},
            "observation": {"nodes": [{"text": "private-ui-marker"}]},
            "counters": {"actions": 2, "captures": 3},
            "steps": [{"command": "fill", "result": {"observationSource": "reused", "text": "private-ui-marker"}},
                      {"command": "press", "result": {"observationSource": "captured"}}],
            "profile": {"coreWallMs": 0, "stagesMs": {"capture": 0, "private-ui-marker": 123},
                        "counts": {"captures": 3, "reusedFrames": 30, "reusedTargetFrames": 1},
                        "captureBreakdown": {"instrumentedCaptures": 3, "hdcCalls": 3,
                                             "nativeExportMs": 42, "transferMs": 42,
                                             "stagesMs": {"hdcProcess": 0, "private-ui-marker": 9}},
                        "inputTokens": 9999, "note": "private-ui-marker"}}}
        request = self.folder / "计划 with spaces.json"
        request.write_text(json.dumps({"command": "run", "input": {"plan": {}}}), encoding="utf-8")
        _, _, row = self.invoke(["--request", str(request), "--json"], json.dumps(payload).encode())
        self.assertTrue(row["success"])
        self.assertEqual(row["runStatus"], "failed")
        self.assertEqual(row["goalVerification"], "unknown")
        self.assertEqual(row["actionCommands"], ["fill", "press"])
        self.assertEqual(row["actionCount"], 2)
        self.assertEqual(row["captureCount"], 3)
        self.assertEqual(row["targetReuseCount"], 1)
        self.assertEqual(row["profile"]["counts"]["reusedFrames"], 30)
        self.assertIsNone(row["profile"]["captureBreakdown"]["nativeExportMs"])
        self.assertNotIn("private-ui-marker", json.dumps(row))
        self.assertIsNone(row["inputTokens"])
        self.assertEqual(row["processOutsideCoreMs"], row["elapsedMs"])

    def test_report_does_not_count_saved_actions_as_new_actions(self):
        payload = {"success": True, "data": {"status": "completed", "counters": {"actions": 9},
                                            "steps": [{"command": "press"}]}}
        _, _, row = self.invoke(["report", "example", "--json"], json.dumps(payload).encode())
        self.assertEqual(row["actionCount"], 0)
        self.assertEqual(row["actionCommands"], [])
        self.assertIsNone(row["runStatus"])

    def test_condition_frame_reuse_is_not_counted_as_target_reuse(self):
        payload = {"success": True, "data": {"status": "completed", "counters": {"actions": 1},
            "steps": [{"command": "back", "result": {"observationSource": "reused"}}],
            "profile": {"counts": {"reusedConditionFrames": 1}}}}
        result = wrapper.result_summary(payload, "run")
        self.assertEqual(result["targetReuseCount"], 0)
        payload["data"]["steps"].append({"command": "press", "result": {"observationSource": "reused"}})
        payload["data"]["profile"]["counts"]["reusedTargetFrames"] = 2
        self.assertEqual(wrapper.result_summary(payload, "run")["targetReuseCount"], 2)

    def test_metadata_parsing_needs_no_runtime_import(self):
        request = self.folder / "请求 with spaces.json"
        request.write_text(json.dumps({"command": "press"}), encoding="utf-8")
        real_import = __import__

        def without_runtime(name, *args, **kwargs):
            if name.startswith("harmony_agent"):
                raise ModuleNotFoundError(name)
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=without_runtime):
            self.assertEqual(wrapper.command_name(["--session", "press", "open", "com.example"]), "open")
            self.assertEqual(wrapper.command_name(["--request=" + str(request), "--json"]), "press")
            self.assertIsNone(wrapper.command_name(["press", "id=target", "--help"]))

    def test_optional_host_and_plan_metadata_do_not_add_child_invocations(self):
        payload = {"success": True, "data": {"status": "yielded", "counters": {"actions": 0}, "steps": []}}
        _, _, row = self.invoke(["run", "--json"], json.dumps(payload).encode(), metadata_flags=[
            "--host-call-id", "tool-call:7", "--plan-boundary", "unknown_page", "--execution-mode", "warm_continue"])
        self.assertEqual(row["hostCallId"], "tool-call:7")
        self.assertEqual(row["declaredPlanBoundary"], "unknown_page")
        self.assertEqual(row["executionMode"], "warm_continue")
        self.assertEqual(row["runStatus"], "yielded")

    def test_plan_boundary_on_non_run_fails_before_device_invocation(self):
        flags = [str(SCRIPT), "--record-dir", str(self.folder), "--plan-boundary", "goal_reached",
                 "--", "press", "id=target", "--json"]
        with patch.object(wrapper.sys, "argv", flags), patch.object(wrapper.subprocess, "run") as child, \
                patch.object(wrapper.sys, "stderr", io.StringIO()), self.assertRaises(SystemExit):
            wrapper.main()
        child.assert_not_called()

    def test_option_value_named_press_is_not_mistaken_for_command(self):
        raw = success_bytes()
        code, emitted, row = self.invoke(["--session", "press", "open", "com.example", "--json"], raw, inject=True)
        self.assertEqual((code, emitted), (0, raw))
        self.assertEqual(row["command"], "open")
        self.assertFalse((self.folder / "fault-used").exists())

    def test_non_json_failure_preserves_raw_stdout_stderr_and_exit_code(self):
        code, emitted, row = self.invoke(["press", "id=target"], b"not-json\xff", stderr=b"failure\xfe", returncode=7, inject=True)
        self.assertEqual(code, 7)
        self.assertEqual(emitted, b"not-json\xff")
        self.assertIs(row["jsonEnvelope"], False)
        self.assertEqual(row["stdoutBytes"], len(emitted))
        self.assertFalse((self.folder / "fault-used").exists())

    def test_unknown_dispatch_does_not_consume_ack_loss_fault(self):
        raw = success_bytes(dispatched="unknown")
        code, emitted, _ = self.invoke(["press", "id=target", "--json"], raw, inject=True)
        self.assertEqual((code, emitted), (0, raw))
        self.assertFalse((self.folder / "fault-used").exists())

    def test_invalid_cli_syntax_preserves_child_error_when_local_reparse_fails(self):
        payload = {"schemaVersion": "1", "version": "0.1.0a2", "success": False,
                   "error": {"code": "INVALID_ARGUMENT", "message": "unrecognized arguments: --target",
                             "details": {"dispatched": "no"}}}
        raw = (json.dumps(payload) + "\n").encode("utf-8")
        code, emitted, row = self.invoke(["press", "--target", "id=target", "--json"],
                                         raw, returncode=2, inject=True)
        self.assertEqual((code, emitted), (2, raw))
        self.assertEqual(row["errorCode"], "INVALID_ARGUMENT")
        self.assertEqual(row["exitCode"], 2)
        self.assertEqual(row["emittedExitCode"], 2)
        self.assertFalse((self.folder / "fault-used").exists())
        self.assertEqual(self.invoke(["press", "id=target", "--json"], success_bytes(), inject=True)[0], 1)


if __name__ == "__main__":
    unittest.main()
