"""Atomic session files and OS-owned locks; no daemon or process-id guessing."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from . import SCHEMA_VERSION
from .errors import AgentError


_STORAGE_FORMAT = "harmony-session/indexed-frame/1"
_FRAME_STORAGE_FORMAT = "harmony-frame/indexed/1"


def _indexed_frame(frame):
    """Share the lossless node-index encoding between sessions and evidence."""
    if not isinstance(frame, dict) or not isinstance(frame.get("nodes"), list):
        return frame
    nodes = frame["nodes"]
    if any(not isinstance(node, dict) or not isinstance(node.get("ref"), str) for node in nodes):
        return frame
    by_ref = {node["ref"]: node for node in nodes}
    indexes = {}
    for key in ("controls", "facts"):
        index = frame.get(key)
        if not isinstance(index, list):
            return frame
        refs = []
        for node in index:
            # Preserve malformed input for load-time validation rather than
            # making a corrupt legacy index appear valid during serialization.
            if (not isinstance(node, dict) or not isinstance(node.get("ref"), str)
                    or node["ref"] not in by_ref or node != by_ref[node["ref"]]):
                return frame
            refs.append(node["ref"])
        indexes[key] = refs
    return {**frame, **indexes}


def _restored_frame(frame):
    if not isinstance(frame, dict) or not isinstance(frame.get("nodes"), list):
        raise ValueError("Invalid indexed frame")
    by_ref = {}
    for node in frame["nodes"]:
        if (not isinstance(node, dict) or not isinstance(node.get("ref"), str)
                or node["ref"] in by_ref):
            raise ValueError("Invalid indexed node")
        by_ref[node["ref"]] = node
    indexes = {}
    for key in ("controls", "facts"):
        refs = frame.get(key)
        if (not isinstance(refs, list)
                or any(not isinstance(ref, str) or ref not in by_ref for ref in refs)):
            raise ValueError("Invalid indexed reference")
        indexes[key] = [by_ref[ref] for ref in refs]
    return {**frame, **indexes}


def stored_frame(frame):
    """Encode a frozen frame without duplicating nodes in controls/facts."""
    if not isinstance(frame, dict) or "storageFormat" in frame:
        return frame
    indexed = _indexed_frame(frame)
    if indexed is frame:
        return frame
    return {**indexed, "storageFormat": _FRAME_STORAGE_FORMAT}


def loaded_frame(value):
    """Read indexed or legacy frozen frames into the same in-memory format."""
    if not isinstance(value, dict) or "storageFormat" not in value:
        return value
    if value["storageFormat"] != _FRAME_STORAGE_FORMAT:
        raise ValueError("Unsupported frame storage format")
    restored = _restored_frame(value)
    del restored["storageFormat"]
    return restored


def _stored_session(value):
    """Deduplicate valid node-object indexes without changing caller data."""
    if not isinstance(value, dict) or "storageFormat" in value:
        return value
    frame = value.get("frame")
    indexed = _indexed_frame(frame)
    if indexed is frame:
        return value
    return {**value, "storageFormat": _STORAGE_FORMAT, "frame": indexed}


def _loaded_session(value):
    """Restore indexed files to the existing in-memory frame interface."""
    if not isinstance(value, dict) or "storageFormat" not in value:
        return value
    if value["storageFormat"] != _STORAGE_FORMAT:
        raise ValueError("Unsupported session storage format")
    restored = {**value, "frame": _restored_frame(value.get("frame"))}
    del restored["storageFormat"]
    return restored


def session_name(value):
    value = "default" if value is None else value
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise AgentError("INVALID_SESSION", "Use 1-64 letters, digits, '_' or '-' for the session.")
    # These names also refer to Windows devices when followed by .json/.lock.
    # Reject them on every host so session directories remain portable.
    if re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])", value, re.IGNORECASE):
        raise AgentError("INVALID_SESSION", "The session name is reserved by Windows; choose another name.")
    return value


def _nonempty_text(value):
    return isinstance(value, str) and bool(value.strip()) and "\x00" not in value


def _valid_frame(frame, session):
    """Check the persisted fields consumed by ref resolution and frame diffs."""
    if not isinstance(frame, dict):
        return False
    frame_id = frame.get("frameId")
    if not _nonempty_text(frame_id) or "~" in frame_id:
        return False
    if (frame.get("device") != session["device"]
            or frame.get("sessionEpoch") != session["epoch"]
            or not _nonempty_text(frame.get("capturedAt"))):
        return False
    projection, quality = frame.get("projection"), frame.get("quality")
    if (not isinstance(projection, dict) or projection.get("schema") != "harmony-layout/1"
            or projection.get("view") != "full" or not isinstance(projection.get("scope"), dict)
            or not isinstance(quality, dict)
            or type(quality.get("complete")) is not bool or type(quality.get("truncated")) is not bool
            or not isinstance(quality.get("warnings"), list)):
        return False
    nodes = frame.get("nodes")
    if not isinstance(nodes, list):
        return False
    refs, identities = set(), set()
    for node in nodes:
        if not isinstance(node, dict):
            return False
        ref, parent, identity = node.get("ref"), node.get("parent"), node.get("identity")
        if (not isinstance(ref, str) or not re.fullmatch(r"@e[1-9][0-9]*~" + re.escape(frame_id), ref)
                or ref in refs):
            return False
        # Normalization emits parents first; this also excludes missing parents
        # and cycles, which would make stored context unsafe to reuse.
        if parent is not None and (not isinstance(parent, str) or parent not in refs):
            return False
        if identity is not None:
            if not isinstance(identity, str) or not identity or identity in identities:
                return False
            identities.add(identity)
        refs.add(ref)
    for index in (frame.get("controls"), frame.get("facts")):
        if not isinstance(index, list) or any(
                not isinstance(node, dict) or not isinstance(node.get("ref"), str)
                or node["ref"] not in refs for node in index):
            return False
    return True


def _valid_session(value, name):
    if not isinstance(value, dict) or value.get("schemaVersion") != SCHEMA_VERSION:
        return False
    if (value.get("name") != name or not _nonempty_text(value.get("device"))
            or value["device"].startswith("-") or not _nonempty_text(value.get("epoch"))
            or not _nonempty_text(value.get("createdAt")) or type(value.get("frameValid")) is not bool
            or "frame" not in value or "bootId" not in value or "app" not in value):
        return False
    if any(value[key] is not None and not _nonempty_text(value[key]) for key in ("bootId", "app")):
        return False
    frame = value["frame"]
    if frame is None:
        return value["frameValid"] is False
    return _valid_frame(frame, value)


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

    def _owner_path(self, device):
        digest = hashlib.sha256(device.encode("utf-8")).hexdigest()
        return Path(tempfile.gettempdir()) / "harmony-agent-device-locks" / (digest + ".owner.json")

    def _owner_identity(self, session):
        return {"schema": "harmony-device-owner/1", "stateRoot": str(self.root.resolve()),
                "session": session["name"], "ownerToken": session.get("ownerToken", session["createdAt"]),
                "device": session["device"]}

    def device_owner(self, device):
        try:
            value = json.loads(self._owner_path(device).read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            raise AgentError("DEVICE_OWNER_UNKNOWN", "Device ownership is unreadable; do not take over automatically.") from exc
        if not isinstance(value, dict) or value.get("schema") != "harmony-device-owner/1":
            raise AgentError("DEVICE_OWNER_UNKNOWN", "Device ownership is invalid; do not take over automatically.")
        return value

    def require_device_owner(self, session):
        owner = self.device_owner(session["device"])
        if owner is not None and owner != self._owner_identity(session):
            raise AgentError("DEVICE_OWNED", "Another task owns this device. Its owner must release or detach first.",
                             details={"ownerSession": owner.get("session")})
        return owner

    def claim_device(self, session):
        """Caller holds device_lock. The claim also spans gaps between CLI calls."""
        from .execution import atomic_json
        owner = self.require_device_owner(session)
        if owner is None:
            owner = self._owner_identity(session)
            try:
                atomic_json(self._owner_path(session["device"]), owner)
            except OSError as exc:
                raise AgentError("DEVICE_OWNER_WRITE_FAILED", "Cannot persist task ownership; no action was dispatched.") from exc
        return owner

    def release_device(self, session):
        self.require_device_owner(session)
        path = self._owner_path(session["device"])
        existed = path.exists()
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            raise AgentError("DEVICE_OWNER_WRITE_FAILED", "Cannot release task ownership.") from exc
        return existed

    def load(self, name):
        name = session_name(name)
        try:
            value = _loaded_session(json.loads(self.path(name).read_text(encoding="utf-8")))
        except FileNotFoundError as exc:
            raise AgentError("NO_SESSION", "Attach a named session to an explicit device first.") from exc
        except (ValueError, RecursionError) as exc:
            raise AgentError("INVALID_SESSION_STATE", "Session state is damaged; detach this session and attach again.") from exc
        except OSError as exc:
            raise AgentError("SESSION_READ_FAILED", "Cannot read session state; check directory access and storage, then retry. The session has not been removed.",
                             details={"osError": exc.errno}) from exc
        if not _valid_session(value, name):
            raise AgentError("INVALID_SESSION_STATE", "Session state is damaged or incompatible; detach this session and attach again.")
        return value

    def save(self, name, value):
        from .persistence import atomic_replace
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(json.dumps(_stored_session(value), ensure_ascii=False, separators=(",", ":")))
                stream.flush()
                os.fsync(stream.fileno())
            atomic_replace(temporary, path)
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
