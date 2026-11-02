"""Session durability and OS-owned locking tests using temporary local files."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

from harmony_agent.errors import AgentError
from harmony_agent.state import StateStore, session_name


class StateTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.base = Path(self.folder.name)
        self.first = StateStore(self.base / "first")
        self.second = StateStore(self.base / "second")
        self.device = "state-test-" + uuid.uuid4().hex

    def assert_error(self, code, operation):
        with self.assertRaises(AgentError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)

    @staticmethod
    def acquire(context):
        with context:
            pass

    def test_session_name_cannot_escape_state_directory(self):
        for name in ("../escape", "a/b", "a\\b", "/absolute", "C:\\absolute", "a" * 65, "a b", "", False, 0):
            with self.subTest(name=name):
                self.assert_error("INVALID_SESSION", lambda: self.first.path(name))
        self.assertEqual(session_name(None), "default")
        self.assertEqual(session_name("valid_name-42"), "valid_name-42")

    def test_unicode_state_round_trip_and_no_partial_file(self):
        value = {"schemaVersion": "1", "device": self.device, "text": "你好 🙂"}
        self.first.save("session", value)
        self.assertEqual(self.first.load("session"), value)
        self.assertEqual(list((self.first.root / "sessions").glob("*.tmp")), [])

    def test_failed_atomic_replace_keeps_previous_complete_state(self):
        before = {"schemaVersion": "1", "device": self.device, "value": "before"}
        self.first.save("session", before)
        with patch("harmony_agent.state.os.replace", side_effect=OSError("simulated replacement failure")):
            with self.assertRaises(OSError):
                self.first.save("session", {**before, "value": "after"})
        self.assertEqual(self.first.load("session"), before)
        self.assertEqual(list((self.first.root / "sessions").glob("*.tmp")), [])

    def test_corrupt_or_missing_state_is_structured(self):
        self.assert_error("NO_SESSION", lambda: self.first.load("missing"))
        path = self.first.path("broken")
        path.parent.mkdir(parents=True)
        for text in ("{broken", "[]", '{"schemaVersion":"99","device":"x"}'):
            with self.subTest(text=text):
                path.write_text(text, encoding="utf-8")
                self.assert_error("INVALID_SESSION_STATE", lambda: self.first.load("broken"))

    def test_same_session_lock_excludes_overlapping_operation(self):
        with self.first.lock("shared"):
            self.assert_error("SESSION_BUSY", lambda: self.acquire(self.first.lock("shared")))
            with self.first.lock("another"):
                pass
        with self.first.lock("shared"):
            pass

    def test_exception_releases_session_lock(self):
        with self.assertRaisesRegex(RuntimeError, "test exception"):
            with self.first.lock("shared"):
                raise RuntimeError("test exception")
        with self.first.lock("shared"):
            pass

    def test_device_lock_is_global_across_state_roots(self):
        with self.first.device_lock(self.device):
            self.assert_error("DEVICE_BUSY", lambda: self.acquire(self.second.device_lock(self.device)))
            with self.second.device_lock(self.device + "-different"):
                pass
        with self.second.device_lock(self.device):
            pass

    def test_exception_releases_global_device_lock(self):
        with self.assertRaises(RuntimeError):
            with self.first.device_lock(self.device):
                raise RuntimeError("test exception")
        with self.second.device_lock(self.device):
            pass

    def test_process_exit_releases_global_device_lock(self):
        ready = self.base / "child-ready"
        script = (
            "import sys\n"
            "from pathlib import Path\n"
            "from harmony_agent.state import StateStore\n"
            "with StateStore(sys.argv[1]).device_lock(sys.argv[2]):\n"
            "    Path(sys.argv[3]).write_text('ready', encoding='utf-8')\n"
            "    sys.stdin.read(1)\n"
        )
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
        process = subprocess.Popen([sys.executable, "-c", script, str(self.first.root), self.device, str(ready)],
                                   stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                   env=environment)
        try:
            deadline = time.monotonic() + 8
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.02)
            if not ready.exists():
                if process.poll() is None:
                    process.kill()
                _, error = process.communicate(timeout=5)
                self.fail("Child did not acquire lock: " + error.decode("utf-8", errors="replace"))
            self.assert_error("DEVICE_BUSY", lambda: self.acquire(self.second.device_lock(self.device)))
            # Abruptly exit our own test child, exercising OS lock release rather
            # than an application cleanup handler or a stale-PID heuristic.
            process.kill()
            process.communicate(timeout=5)
            with self.second.device_lock(self.device):
                pass
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
            if process.stdin:
                process.stdin.close()
            if process.stderr:
                process.stderr.close()

    def test_artifact_operation_cannot_escape_directory(self):
        self.assert_error("INVALID_OPERATION_ID", lambda: self.first.artifacts("session", "../escape"))
        path = self.first.artifacts("session", "operation-1")
        self.assertTrue(path.is_dir())
        self.assertTrue(path.is_relative_to(self.first.root))

    def test_trace_appends_distinct_attempts(self):
        self.first.trace("session", {"operationId": "first", "actual": "你好"})
        self.first.trace("session", {"operationId": "second", "actual": "再试"})
        records = [json.loads(line) for line in (self.first.root / "traces" / "session.ndjson").read_text(encoding="utf-8").splitlines()]
        self.assertEqual([r["operationId"] for r in records], ["first", "second"])


if __name__ == "__main__":
    unittest.main()
