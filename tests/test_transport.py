import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harmony_agent.errors import AgentError
from harmony_agent.transport import HdcTransport, _layout_script


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.exe = Path(self.tmp.name) / "hdc.exe"
        self.exe.write_bytes(b"placeholder")
        self.transport = HdcTransport(str(self.exe))

    @staticmethod
    def receipt(argv, **kwargs):
        marker = re.search(r"__HARMONY_EXIT_[a-f0-9]+__", argv[-1]).group()
        return subprocess.CompletedProcess(argv, 0, ("OK\n" + marker + "0\n").encode(), b"")

    @staticmethod
    def layout_body(payload):
        def response(device, args, **kwargs):
            marker = re.search(r"__HARMONY_LAYOUT_[a-f0-9]+__", args[-1]).group()
            return "Exporter succeeded\n" + marker + "\n" + payload
        return response

    def test_shell_quotes_unicode_metacharacters_without_host_shell(self):
        value = "中文 '$HOME' $(touch /tmp/pwn); `id`\nsecond line"
        with patch("harmony_agent.transport.subprocess.run", side_effect=self.receipt) as run:
            self.transport.fill("device-A", 10, 20, value)
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], [str(self.exe.resolve()), "-t", "device-A", "shell"])
        prefix = argv[4].split("; __ha_rc=$?;")[0]
        self.assertEqual(shlex.split(prefix), ["uitest", "uiInput", "inputText", "10", "20", value])
        self.assertIs(run.call_args.kwargs["shell"], False)
        self.assertEqual(run.call_count, 1)

    def test_mutation_timeout_is_unknown_and_not_retried(self):
        with patch("harmony_agent.transport.subprocess.run", side_effect=subprocess.TimeoutExpired("hdc", 1)) as run:
            with self.assertRaises(AgentError) as caught:
                self.transport.fill("dev", 1, 1, "secret-value")
        self.assertEqual(caught.exception.code, "HDC_TIMEOUT")
        self.assertEqual(caught.exception.dispatched, "unknown")
        self.assertNotIn("secret-value", str(caught.exception.to_dict()))
        self.assertEqual(run.call_count, 1)

    def test_missing_explicit_hdc_is_clear(self):
        with self.assertRaises(AgentError) as caught:
            HdcTransport(str(Path(self.tmp.name) / "does-not-exist"))
        self.assertEqual(caught.exception.code, "HDC_NOT_FOUND")
        self.assertEqual(caught.exception.dispatched, "no")

    def test_spawn_failure_definitely_not_dispatched(self):
        with patch("harmony_agent.transport.subprocess.run", side_effect=FileNotFoundError):
            with self.assertRaises(AgentError) as caught:
                self.transport.tap("dev", 1, 1)
        self.assertEqual(caught.exception.dispatched, "no")

    def test_zero_exit_with_hdc_failure_is_error(self):
        response = subprocess.CompletedProcess([], 0, b"[Fail]Device not found\n", b"")
        with patch("harmony_agent.transport.subprocess.run", return_value=response):
            with self.assertRaises(AgentError) as caught:
                self.transport.devices()
        self.assertEqual(caught.exception.code, "HDC_COMMAND_FAILED")

    def test_empty_and_deduplicated_devices(self):
        with patch("harmony_agent.transport.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"[Empty]\r\n", b"")):
            self.assertEqual(self.transport.devices(), [])
        with patch("harmony_agent.transport.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"dev1\ndev1\ndev2\n", b"")):
            self.assertEqual(self.transport.devices(), ["dev1", "dev2"])

    def test_missing_remote_receipt_is_unknown_for_action(self):
        with patch("harmony_agent.transport.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"", b"")):
            with self.assertRaises(AgentError) as caught:
                self.transport.tap("dev", 1, 2)
        self.assertEqual(caught.exception.code, "REMOTE_RESULT_UNKNOWN")
        self.assertEqual(caught.exception.dispatched, "unknown")

    def test_remote_failure_not_hidden_by_hdc_exit_zero(self):
        def response(argv, **kwargs):
            marker = re.search(r"__HARMONY_EXIT_[a-f0-9]+__", argv[-1]).group()
            return subprocess.CompletedProcess(argv, 0, ("\n" + marker + "17\n").encode(), b"")
        with patch("harmony_agent.transport.subprocess.run", side_effect=response):
            with self.assertRaises(AgentError) as caught:
                self.transport.tap("dev", 1, 2)
        self.assertEqual(caught.exception.details["remoteExitCode"], 17)

    def test_invalid_utf8_is_reported(self):
        with patch("harmony_agent.transport.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"\xff", b"")):
            with self.assertRaises(AgentError) as caught:
                self.transport.version()
        self.assertEqual(caught.exception.code, "HDC_ENCODING_ERROR")

    def test_uiinput_usage_is_not_an_action_success(self):
        def response(argv, **kwargs):
            marker = re.search(r"__HARMONY_EXIT_[a-f0-9]+__", argv[-1]).group()
            return subprocess.CompletedProcess(argv, 0, ("Missing parameter.\nUSAGE\n" + marker + "0\n").encode(), b"")
        with patch("harmony_agent.transport.subprocess.run", side_effect=response):
            with self.assertRaises(AgentError) as caught:
                self.transport.tap("dev", 1, 2)
            self.assertIn("USAGE", self.transport.shell("dev", ["uitest", "uiInput", "help"]))
        self.assertEqual(caught.exception.code, "DEVICE_COMMAND_FAILED")

    def test_native_clipboard_failure_is_not_success_with_zero_exit(self):
        for message in ("Set pasteBoard data failed.",
                        "Capability not support, clipboard service is not supported"):
            with self.subTest(message=message):
                def response(argv, **kwargs):
                    marker = re.search(r"__HARMONY_EXIT_[a-f0-9]+__", argv[-1]).group()
                    return subprocess.CompletedProcess(argv, 0, (message + "\n" + marker + "0\n").encode(), b"")
                with patch("harmony_agent.transport.subprocess.run", side_effect=response) as run:
                    with self.assertRaises(AgentError) as caught:
                        self.transport.fill("dev", 1, 2, "中文")
                self.assertEqual(caught.exception.code, "DEVICE_COMMAND_FAILED")
                self.assertEqual(caught.exception.dispatched, "unknown")
                self.assertEqual(caught.exception.details["remoteExitCode"], 0)
                self.assertEqual(run.call_count, 1)

    def test_tap_and_key_forward_remaining_time_budget(self):
        with patch("harmony_agent.transport.subprocess.run", side_effect=self.receipt) as run:
            self.transport.tap("dev", 1, 2, timeout_ms=250)
            self.assertEqual(run.call_args.kwargs["timeout"], 0.25)
            self.transport.key("dev", [2072, 2017], timeout_ms=120)
            self.assertEqual(run.call_args.kwargs["timeout"], 0.12)
            self.transport.key("dev", "Back")
            self.assertEqual(run.call_args.kwargs["timeout"], 10)

    def test_capture_passes_one_shared_budget_for_dump_transfer_cleanup(self):
        with patch.object(self.transport, "shell", side_effect=self.layout_body('{"attributes": {}}')) as shell, \
             patch("harmony_agent.transport.time.monotonic", side_effect=[0, 5]):
            self.transport.capture_layout("dev", timeout_ms=10000)
        self.assertEqual(shell.call_args.kwargs["timeout_ms"], 5000)
        self.assertEqual(shell.call_count, 1)

    def test_capture_returns_unicode_json_in_one_hdc_call(self):
        expected = {"attributes": {"text": "中文\n[Fail] is UI data"}, "children": []}
        def response(argv, **kwargs):
            marker = re.search(r"__HARMONY_EXIT_[a-f0-9]+__", argv[-1]).group()
            boundary = re.search(r"__HARMONY_LAYOUT_[a-f0-9]+__", argv[-1]).group()
            body = "Exporter succeeded\r\n" + boundary + "\r\n\ufeff" + json.dumps(expected, ensure_ascii=False) + "\r\n"
            return subprocess.CompletedProcess(argv, 0, (body + "\n" + marker + "0\n").encode(), b"")
        with patch("harmony_agent.transport.subprocess.run", side_effect=response) as run:
            self.assertEqual(self.transport.capture_layout("dev"), expected)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(self.transport.calls, 1)
        argv = run.call_args.args[0]
        args = shlex.split(argv[-1].split("; __ha_rc=$?;")[0])
        self.assertEqual(args[:2], ["sh", "-c"])
        self.assertIn("uitest dumpLayout", args[2])
        self.assertIn("trap ", args[2])
        self.assertRegex(args[2], r"/data/local/tmp/ha_[a-f0-9]{32}\.json")
        self.assertIs(run.call_args.kwargs["shell"], False)

    def test_invalid_layout_does_not_recapture_or_repeat_completed_cleanup(self):
        with patch.object(self.transport, "shell", side_effect=self.layout_body("invalid JSON")) as shell, \
             patch.object(self.transport, "_cleanup") as cleanup:
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev")
        self.assertEqual(caught.exception.code, "LAYOUT_INVALID")
        self.assertEqual(shell.call_count, 1)
        cleanup.assert_not_called()

    def test_capture_profile_retains_failure_timing_without_changing_calls(self):
        def response(argv, **kwargs):
            receipt = re.search(r"__HARMONY_EXIT_[a-f0-9]+__", argv[-1]).group()
            boundary = re.search(r"__HARMONY_LAYOUT_[a-f0-9]+__", argv[-1]).group()
            body = "\n" + boundary + "\ninvalid JSON\n" + receipt + "0\n"
            return subprocess.CompletedProcess(argv, 0, body.encode(), b"")

        with patch("harmony_agent.transport.subprocess.run", side_effect=response) as run:
            with self.transport.capture_profile() as metrics:
                with self.assertRaises(AgentError) as caught:
                    self.transport.capture_layout("dev")
            self.assertEqual(caught.exception.code, "LAYOUT_INVALID")
            self.assertEqual(run.call_count, 1)
            self.assertEqual(metrics["hdcCalls"], 1)
            self.assertEqual(set(metrics["stagesMs"]), {
                "hdcProcess", "decodeAndValidation", "shellReceiptValidation", "layoutParseAndValidation"})
            self.assertTrue(all(value >= 0 for value in metrics["stagesMs"].values()))
            self.assertIsNone(self.transport._capture_metrics)
            frozen = dict(metrics["stagesMs"])
            with self.assertRaises(AgentError):
                self.transport.capture_layout("dev")
            self.assertEqual(run.call_count, 2)
            self.assertEqual(metrics["stagesMs"], frozen)

    def test_capture_validates_root_and_utf8_byte_limit(self):
        with patch.object(self.transport, "shell", side_effect=self.layout_body('"not a layout"')):
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev")
        self.assertEqual(caught.exception.code, "LAYOUT_INVALID")
        payload = '{"text":"中文"}'
        with patch.object(self.transport, "shell", side_effect=self.layout_body(payload)), \
             patch("harmony_agent.transport._LAYOUT_LIMIT", len(payload.encode("utf-8")) - 1):
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev")
        self.assertEqual(caught.exception.code, "LAYOUT_TOO_LARGE")

    def test_capture_missing_layout_boundary_fails_without_recapture(self):
        with patch.object(self.transport, "shell", return_value='{"children":[]}') as shell, \
             patch.object(self.transport, "_cleanup") as cleanup:
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev")
        self.assertEqual(caught.exception.code, "LAYOUT_INVALID")
        self.assertEqual(shell.call_count, 1)
        cleanup.assert_not_called()

    def test_capture_rejects_exporter_zero_exit_failure_diagnostics(self):
        for source in ("stdout", "stderr"):
            with self.subTest(source=source):
                def response(argv, **kwargs):
                    receipt = re.search(r"__HARMONY_EXIT_[a-f0-9]+__", argv[-1]).group()
                    boundary = re.search(r"__HARMONY_LAYOUT_[a-f0-9]+__", argv[-1])
                    body = "\n" + receipt + "0\n"
                    error = b""
                    if boundary:
                        body = "\n" + boundary.group() + '\n{"children":[]}' + body
                        diagnostic = "[Error] private exporter diagnostic\n"
                        if source == "stdout":
                            body = diagnostic + body
                        else:
                            error = diagnostic.encode()
                    return subprocess.CompletedProcess(argv, 0, body.encode(), error)
                with patch("harmony_agent.transport.subprocess.run", side_effect=response) as run:
                    with self.assertRaises(AgentError) as caught:
                        self.transport.capture_layout("dev")
                self.assertEqual(caught.exception.code, "HDC_COMMAND_FAILED")
                self.assertNotIn("private", str(caught.exception.to_dict()))
                self.assertEqual(sum("__HARMONY_LAYOUT_" in call.args[0][-1] for call in run.call_args_list), 1)

    def test_capture_remote_failure_propagates_without_retry(self):
        failure = AgentError("DEVICE_COMMAND_FAILED", "Device command failed.", details={"remoteExitCode": 17})
        with patch.object(self.transport, "shell", side_effect=failure) as shell, \
             patch.object(self.transport, "_cleanup") as cleanup:
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev")
        self.assertIs(caught.exception, failure)
        self.assertEqual(shell.call_count, 1)
        cleanup.assert_not_called()

    def test_capture_timeout_cleanup_is_bounded_and_preserves_failure(self):
        failure = AgentError("HDC_TIMEOUT", "Timed out.")
        with patch.object(self.transport, "shell", side_effect=failure) as shell, \
             patch.object(self.transport, "_cleanup") as cleanup, \
             patch("harmony_agent.transport.time.monotonic", side_effect=[0, 9.9, 10.1]):
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev", timeout_ms=10000)
        self.assertIs(caught.exception, failure)
        self.assertEqual(shell.call_count, 1)
        self.assertAlmostEqual(shell.call_args.kwargs["timeout_ms"], 100)
        self.assertEqual(cleanup.call_args.kwargs["timeout_ms"], 1)

    def test_capture_missing_receipt_cleans_up_without_recapture(self):
        failure = AgentError("REMOTE_RESULT_UNKNOWN", "Missing receipt.")
        with patch.object(self.transport, "shell", side_effect=failure) as shell, \
             patch.object(self.transport, "_cleanup") as cleanup, \
             patch("harmony_agent.transport.time.monotonic", side_effect=[0, 1, 2]):
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev", timeout_ms=10000)
        self.assertIs(caught.exception, failure)
        self.assertEqual(shell.call_count, 1)
        cleanup.assert_called_once()
        self.assertEqual(cleanup.call_args.kwargs["timeout_ms"], 250)

    def test_capture_bad_utf8_keeps_layout_error_and_hides_payload(self):
        with patch("harmony_agent.transport.subprocess.run", return_value=subprocess.CompletedProcess([], 0, b"private\xff", b"")) as run:
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev")
        self.assertEqual(caught.exception.code, "LAYOUT_INVALID")
        self.assertNotIn("private", str(caught.exception.to_dict()))
        self.assertEqual(run.call_count, 2)  # Read plus best-effort cleanup, no recapture.

    @unittest.skipUnless(shutil.which("sh"), "POSIX shell unavailable")
    def test_capture_script_cleanup_and_original_status(self):
        target = Path(self.tmp.name) / "layout with 'quote.json"
        marker = "__HARMONY_LAYOUT_test__"
        for body, expected_code, expected_output, expected_error in (
                ('printf \'{"children":[]}\\n\' > "$3"; printf "diagnostic\\n"; printf "noise\\n" >&2',
                 0, 'diagnostic\n\n' + marker + '\n{"children":[]}\n', 'noise\n'),
                ('printf \'{"children":[]}\' > "$3"; printf "[Error] partial snapshot\\n"',
                 0, '[Error] partial snapshot\n\n' + marker + '\n{"children":[]}', ''),
                ('printf \'partial\' > "$3"; return 17', 17, '', ''),
                ('return 0', 1, '\n' + marker + '\n', '')):
            with self.subTest(expected_code=expected_code):
                script = "uitest() { " + body + "; }; " + _layout_script(target.as_posix(), marker)
                result = subprocess.run([shutil.which("sh"), "-c", script], capture_output=True, timeout=5)
                self.assertEqual(result.returncode, expected_code)
                self.assertEqual(result.stdout.decode(), expected_output)
                self.assertEqual(result.stderr.decode(), expected_error)
                self.assertFalse(target.exists())

    def test_screenshot_does_not_overwrite(self):
        destination = Path(self.tmp.name) / "existing.png"
        destination.write_bytes(b"original")
        with patch.object(self.transport, "shell") as shell:
            with self.assertRaises(AgentError) as caught:
                self.transport.screenshot("dev", destination)
        self.assertEqual(caught.exception.code, "ARTIFACT_EXISTS")
        self.assertEqual(destination.read_bytes(), b"original")
        shell.assert_not_called()

    def test_screenshot_rejects_non_image(self):
        def receive(device, remote, local):
            local.write_bytes(b"not an image")
        with patch.object(self.transport, "shell", return_value=""), patch.object(self.transport, "_receive", side_effect=receive):
            with self.assertRaises(AgentError) as caught:
                self.transport.screenshot("dev", Path(self.tmp.name) / "screen.png")
        self.assertEqual(caught.exception.code, "SCREENSHOT_INVALID")

    def test_valid_screenshot_is_saved(self):
        image = b"\x89PNG\r\n\x1a\nexample"
        def receive(device, remote, local):
            local.write_bytes(image)
        with patch.object(self.transport, "shell", return_value=""), patch.object(self.transport, "_receive", side_effect=receive):
            destination = self.transport.screenshot("dev", Path(self.tmp.name) / "screen.png")
        self.assertEqual(destination.read_bytes(), image)

    def test_bad_arguments_fail_before_spawn(self):
        with patch("harmony_agent.transport.subprocess.run") as run:
            for call in (lambda: self.transport.tap("dev", float("nan"), 1),
                         lambda: self.transport.shell("dev", "echo bad"),
                         lambda: self.transport.fill("dev", 1, 2, "\x00"),
                         lambda: self.transport.shell("-bad", ["echo", "a"]),
                         lambda: self.transport.swipe("dev", 1, 2, 3, 4, True)):
                with self.assertRaises(AgentError):
                    call()
        run.assert_not_called()

    def test_capability_failures_stay_unknown(self):
        with patch.object(self.transport, "shell", side_effect=AgentError("HDC_TIMEOUT", "timeout")):
            caps = self.transport.capabilities("dev")
        self.assertIsNone(caps["features"]["inputText"])
        self.assertEqual(len(caps["warnings"]), 3)
        self.assertEqual(caps["verification"], "command-help-only")


if __name__ == "__main__":
    unittest.main()
