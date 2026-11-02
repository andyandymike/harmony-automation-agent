import json
import os
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harmony_agent.errors import AgentError
from harmony_agent.transport import HdcTransport


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

    def test_capture_shares_deadline_between_dump_and_transfer(self):
        budgets = []
        def receive(device, remote, local, **kwargs):
            budgets.append(kwargs["timeout_ms"])
            local.write_text('{"attributes": {}, "children": []}', encoding="utf-8")
        with patch.object(self.transport, "shell", return_value="") as shell, \
             patch.object(self.transport, "_receive", side_effect=receive), \
             patch("harmony_agent.transport.time.monotonic", side_effect=[0, 5, 6, 7]):
            self.transport.capture_layout("dev", timeout_ms=10000)
        self.assertEqual(shell.call_args_list[0].kwargs["timeout_ms"], 5000)
        self.assertEqual(budgets, [4000])

    def test_layout_cleanup_after_invalid_json(self):
        def receive(device, remote, local, **kwargs):
            local.write_text("invalid JSON", encoding="utf-8")
        with patch.object(self.transport, "shell", return_value="") as shell, patch.object(self.transport, "_receive", side_effect=receive):
            with self.assertRaises(AgentError) as caught:
                self.transport.capture_layout("dev")
        self.assertEqual(caught.exception.code, "LAYOUT_INVALID")
        dump_args = shell.call_args_list[0].args[1]
        cleanup_args = shell.call_args_list[-1].args[1]
        self.assertEqual(cleanup_args, ["rm", "-f", "--", dump_args[-1]])
        self.assertRegex(dump_args[-1], r"^/data/local/tmp/ha_[a-f0-9]{32}\.json$")

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
