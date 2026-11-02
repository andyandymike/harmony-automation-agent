"""Atomic session files and OS-owned locks; no daemon or process-id guessing."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from .errors import AgentError


def session_name(value):
    value = "default" if value is None else value
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise AgentError("INVALID_SESSION", "Use 1-64 letters, digits, '_' or '-' for the session.")
    return value


@contextmanager
def file_lock(path, *, code="SESSION_BUSY"):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    acquired = False
    try:
        if path.stat().st_size == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError as exc:
            raise AgentError(code, "Another operation owns this session or device; retry after it finishes.") from exc
        yield
    finally:
        if acquired:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


class StateStore:
    def __init__(self, root=None):
        self.root = Path(root or os.environ.get("HARMONY_AGENT_STATE_DIR") or Path.cwd() / ".harmony-agent").expanduser().resolve()

    def path(self, name):
        return self.root / "sessions" / (session_name(name) + ".json")

    def lock(self, name):
        return file_lock(self.root / "locks" / (session_name(name) + ".lock"))

    def device_lock(self, device):
        digest = hashlib.sha256(device.encode("utf-8")).hexdigest()
        # Shared across project state directories. OS releases this lock on crash.
        return file_lock(Path(tempfile.gettempdir()) / "harmony-agent-device-locks" / (digest + ".lock"), code="DEVICE_BUSY")

    def load(self, name):
        try:
            value = json.loads(self.path(name).read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise AgentError("NO_SESSION", "Attach a named session to an explicit device first.") from exc
        except (ValueError, OSError) as exc:
            raise AgentError("INVALID_SESSION_STATE", "Session state is unreadable; detach and attach again.") from exc
        if not isinstance(value, dict) or value.get("schemaVersion") != "1" or not isinstance(value.get("device"), str):
            raise AgentError("INVALID_SESSION_STATE", "Unsupported session state format.")
        return value

    def save(self, name, value):
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def detach(self, name):
        path = self.path(name)
        existed = path.exists()
        path.unlink(missing_ok=True)
        return existed

    def artifacts(self, name, operation_id):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", operation_id):
            raise AgentError("INVALID_OPERATION_ID", "Invalid operation identifier.")
        path = self.root / "artifacts" / session_name(name) / operation_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def trace(self, name, record):
        path = self.root / "traces" / (session_name(name) + ".ndjson")
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
