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
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, args, stdout, *, stderr=b"", returncode=0, inject=False):
        flags = [str(SCRIPT), "--record-dir", str(self.folder)]
        if inject:
            flags.append("--drop-press-ack-once")
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
        self.assertFalse(any("token" in key.lower() for key in row))
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
        request = self.folder / "request.json"
        request.write_text(json.dumps({"command": "press", "input": {"target": "id=target"}}), encoding="utf-8")
        code, emitted, row = self.invoke(["--request", str(request), "--json"], success_bytes(), inject=True)
        self.assertEqual(code, 1)
        self.assertEqual(row["command"], "press")
        self.assertFalse(json.loads(emitted)["success"])

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
