"""Session durability and OS-owned locking tests using temporary local files."""

from copy import deepcopy
import errno
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
from harmony_agent.observation import normalize_layout
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
        return raised.exception

    def session_value(self, name="session", **extra):
        return {"schemaVersion": "1", "name": name, "device": self.device,
                "epoch": "session-epoch", "bootId": None, "app": None,
                "createdAt": "2026-11-10T00:00:00+00:00", "frame": None,
                "frameValid": False, **extra}

    def observed_session(self):
        value = self.session_value()
        frame = normalize_layout({"attributes": {"id": "root", "type": "Column"}, "children": [
            {"attributes": {"id": "counter", "type": "Text", "text": "Count: 0"}, "children": []}
        ]}, "frame-1")
        frame.update(device=value["device"], sessionEpoch=value["epoch"], capturedAt=value["createdAt"])
        value.update(frame=frame, frameValid=True)
        return value

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

    def test_windows_device_names_are_rejected_before_file_access(self):
        for name in ("CON", "prn", "Aux", "nul", "COM1", "com9", "LPT1", "lpt9"):
            with self.subTest(name=name):
                self.assert_error("INVALID_SESSION", lambda: self.first.path(name))
                self.assert_error("INVALID_SESSION", lambda: self.acquire(self.first.lock(name)))
                self.assert_error("INVALID_SESSION", lambda: self.first.save(name, self.session_value(name)))
        self.assertFalse(self.first.root.exists())
        for name in ("console", "null", "COM10", "LPT10", "aux-session"):
            self.assertEqual(session_name(name), name)

    def test_unicode_state_round_trip_and_no_partial_file(self):
        value = self.session_value(text="你好 🙂")
        self.first.save("session", value)
        self.assertEqual(self.first.load("session"), value)
        self.assertEqual(list((self.first.root / "sessions").glob("*.tmp")), [])

    def test_failed_atomic_replace_keeps_previous_complete_state(self):
        before = self.session_value(value="before")
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
        path.write_bytes(b"\xff")
        self.assert_error("INVALID_SESSION_STATE", lambda: self.first.load("broken"))

    def test_load_rejects_missing_or_invalid_execution_state(self):
        valid = self.session_value()
        cases = []
        for key in valid:
            missing = dict(valid)
            del missing[key]
            cases.append(("missing-" + key, missing))
        for key, incorrect in (("name", "other"), ("device", ""), ("device", "-other"),
                               ("epoch", []), ("createdAt", None), ("frameValid", 1),
                               ("bootId", {}), ("app", False), ("frame", [])):
            cases.append(("invalid-" + key, {**valid, key: incorrect}))
        cases.append(("valid-without-frame", {**valid, "frameValid": True}))
        for label, value in cases:
            with self.subTest(case=label):
                self.first.save("session", value)
                self.assert_error("INVALID_SESSION_STATE", lambda: self.first.load("session"))

    def test_observed_and_invalidated_frames_round_trip(self):
        value = self.observed_session()
        for valid in (True, False):
            with self.subTest(frameValid=valid):
                value["frameValid"] = valid
                self.first.save("session", value)
                self.assertEqual(self.first.load("session"), value)

    def test_frame_indexes_are_stored_once_and_restored_as_node_objects(self):
        value = self.observed_session()
        before = deepcopy(value)
        self.first.save("session", value)
        text = self.first.path("session").read_text(encoding="utf-8")
        stored = json.loads(text)
        self.assertEqual(stored["storageFormat"], "harmony-session/indexed-frame/1")
        self.assertEqual(stored["schemaVersion"], value["schemaVersion"])
        self.assertEqual(stored["frame"]["facts"], [node["ref"] for node in value["frame"]["facts"]])
        self.assertLess(len(text), len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))))
        restored = self.first.load("session")
        self.assertEqual(restored, value)
        self.assertNotIn("storageFormat", restored)
        by_ref = {node["ref"]: node for node in restored["frame"]["nodes"]}
        for key in ("controls", "facts"):
            for node in restored["frame"][key]:
                self.assertIs(node, by_ref[node["ref"]])
        self.assertEqual(value, before)

    def test_legacy_node_indexes_load_and_migrate_on_next_save(self):
        value = self.observed_session()
        path = self.first.path("session")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(value), encoding="utf-8")
        restored = self.first.load("session")
        self.assertEqual(restored, value)
        self.first.save("session", restored)
        self.assertIn("storageFormat", json.loads(path.read_text(encoding="utf-8")))
        self.assertEqual(self.first.load("session"), value)

    def test_load_rejects_corrupt_indexed_storage(self):
        self.first.save("session", self.observed_session())
        path = self.first.path("session")
        original = json.loads(path.read_text(encoding="utf-8"))
        changes = {
            "unknown-format": lambda v: v.update(storageFormat="harmony-session/indexed-frame/99"),
            "invalid-frame": lambda v: v.update(frame=None),
            "missing-nodes": lambda v: v["frame"].pop("nodes"),
            "invalid-node-ref": lambda v: v["frame"]["nodes"][0].update(ref=[]),
            "duplicate-node-ref": lambda v: v["frame"]["nodes"].append(deepcopy(v["frame"]["nodes"][0])),
            "missing-index": lambda v: v["frame"].pop("facts"),
            "invalid-index": lambda v: v["frame"].update(facts={}),
            "node-object-in-index": lambda v: v["frame"].update(facts=[v["frame"]["nodes"][1]]),
            "unhashable-ref": lambda v: v["frame"].update(facts=[[]]),
            "unknown-ref": lambda v: v["frame"].update(facts=["@e99~frame-1"]),
            "missing-format": lambda v: v.pop("storageFormat"),
        }
        for label, change in changes.items():
            with self.subTest(case=label):
                value = deepcopy(original)
                change(value)
                path.write_text(json.dumps(value), encoding="utf-8")
                self.assert_error("INVALID_SESSION_STATE", lambda: self.first.load("session"))

    def test_load_rejects_corrupt_frame_context_and_node_structure(self):
        original = self.observed_session()
        changes = {
            "wrong-device": lambda f: f.update(device="other"),
            "wrong-epoch": lambda f: f.update(sessionEpoch="other"),
            "wrong-frame-id": lambda f: f.update(frameId="other"),
            "missing-capture-time": lambda f: f.pop("capturedAt"),
            "missing-projection": lambda f: f.pop("projection"),
            "incomplete-projection": lambda f: f["projection"].update(view="interactive"),
            "invalid-quality": lambda f: f.update(quality=[]),
            "invalid-quality-boolean": lambda f: f["quality"].update(complete="true"),
            "missing-quality-warnings": lambda f: f["quality"].pop("warnings"),
            "invalid-quality-warnings": lambda f: f["quality"].update(warnings={}),
            "invalid-nodes": lambda f: f.update(nodes={}),
            "invalid-node": lambda f: f["nodes"].append(None),
            "duplicate-ref": lambda f: f["nodes"].append(deepcopy(f["nodes"][0])),
            "invalid-parent": lambda f: f["nodes"][1].update(parent=[]),
            "missing-parent": lambda f: f["nodes"][1].update(parent="@e99~frame-1"),
            "parent-cycle": lambda f: f["nodes"][0].update(parent=f["nodes"][1]["ref"]),
            "invalid-identity": lambda f: f["nodes"][0].update(identity=[]),
            "duplicate-identity": lambda f: f["nodes"][1].update(identity=f["nodes"][0]["identity"]),
            "invalid-index": lambda f: f.update(facts=["@e2~frame-1"]),
            "unknown-index-ref": lambda f: f.update(controls=[{"ref": "@e99~frame-1"}]),
        }
        for label, change in changes.items():
            with self.subTest(case=label):
                value = deepcopy(original)
                change(value["frame"])
                self.first.save("session", value)
                self.assert_error("INVALID_SESSION_STATE", lambda: self.first.load("session"))

    def test_read_io_errors_preserve_session_and_do_not_suggest_detach(self):
        value = self.session_value()
        self.first.save("session", value)
        original = self.first.path("session").read_bytes()
        for failure in (PermissionError(errno.EACCES, "denied"), OSError(errno.EIO, "read failed")):
            with self.subTest(error=failure.errno), patch("harmony_agent.state.Path.read_text", side_effect=failure):
                error = self.assert_error("SESSION_READ_FAILED", lambda: self.first.load("session"))
                self.assertEqual(error.details["osError"], failure.errno)
                self.assertNotIn("detach", error.message)
            self.assertEqual(self.first.path("session").read_bytes(), original)
            self.assertEqual(self.first.load("session"), value)

    def test_corrupt_state_can_be_detached_under_the_session_lock(self):
        path = self.first.path("session")
        path.parent.mkdir(parents=True)
        path.write_text("{broken", encoding="utf-8")
        with self.first.lock("session"):
            self.assert_error("INVALID_SESSION_STATE", lambda: self.first.load("session"))
            self.assertTrue(self.first.detach("session"))
        self.assertFalse(path.exists())

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
