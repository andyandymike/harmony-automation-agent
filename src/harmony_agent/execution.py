"""Local execution receipts. Persistence never authorizes replaying a UI action."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile

from .errors import AgentError
from .persistence import atomic_replace
from .state import loaded_frame, session_name, stored_frame


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, prefix=".pending-", delete=False) as stream:
            name = stream.name
            stream.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
            stream.flush()
            os.fsync(stream.fileno())
        atomic_replace(name, path)
    finally:
        if name is not None and os.path.exists(name):
            os.unlink(name)


class RunStore:
    """One immutable run identity, durable intents, and queryable local results."""

    def __init__(self, state_root, run_id):
        self.run_id = session_name(run_id)
        self.root = (Path(state_root) / "runs").resolve()
        self.folder = self.root / self.run_id
        if not self.folder.resolve().is_relative_to(self.root):
            raise AgentError("INVALID_RUN", "Run storage must stay within the state directory.")
        self.record = None

    def begin(self, plan, session):
        try:
            self.folder.mkdir(parents=True, exist_ok=False)
        except FileExistsError:
            raise AgentError("RUN_EXISTS", "This run ID has already been used. Query report; do not replay it.",
                             details={"runId": self.run_id}) from None
        digest = hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False,
                                          separators=(",", ":")).encode("utf-8")).hexdigest()
        self.record = {"schema": "harmony-run/1", "runId": self.run_id, "status": "running",
                       "session": session["name"], "sessionEpoch": session["epoch"],
                       "device": session["device"], "planDigest": digest,
                       "goal": plan.get("goal"), "startedAt": timestamp(),
                       "activeStep": None, "receipts": [], "frames": []}
        try:
            atomic_json(self.folder / "plan.json", plan)
        except OSError as exc:
            raise AgentError("RECEIPT_WRITE_FAILED", "Cannot persist the validated plan; no action was dispatched.") from exc
        self._save()

    def _save(self):
        try:
            atomic_json(self.folder / "run.json", self.record)
        except OSError as exc:
            raise AgentError("RECEIPT_WRITE_FAILED", "Execution state could not be persisted. Do not replay actions.",
                             details={"runId": self.run_id, "osError": exc.errno,
                                      "winError": getattr(exc, "winerror", None)}) from exc

    def checkpoint(self, event):
        event = deepcopy(event)
        event["at"] = timestamp()
        previous = self.record
        self.record = deepcopy(previous)
        if event.get("event") == "step_started" or event.get("type") == "step_started":
            self.record["activeStep"] = event
        else:
            self.record["receipts"].append(event)
            self.record["activeStep"] = None
        try:
            self._save()
        except BaseException:
            self.record = previous
            raise

    def save_frame(self, observation):
        frame_id = session_name(observation["frameId"])
        try:
            atomic_json(self.folder / "frames" / (frame_id + ".json"), stored_frame(observation))
        except OSError as exc:
            raise AgentError("EVIDENCE_WRITE_FAILED", "The captured frame could not be persisted.",
                             details={"runId": self.run_id, "frameId": frame_id}) from exc
        self.record["frames"].append(frame_id)
        # The next checkpoint/finish commits this index; the frame itself is already durable.
        return {"runId": self.run_id, "frameId": frame_id}

    def finish(self, result):
        self.record.update(status=result["status"], finishedAt=timestamp(), result=deepcopy(result))
        if result["status"] not in {"unknown", "cancelled"}:
            self.record["activeStep"] = None
        self._save()

    def read(self, *, full=False):
        """Verify the complete stored record, then return compact or full data."""
        if type(full) is not bool:
            raise AgentError("INVALID_ARGUMENT", "full must be a boolean.", exit_code=2)
        try:
            value = json.loads((self.folder / "run.json").read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise AgentError("RUN_NOT_FOUND", "No persisted report exists for this run ID.") from exc
        except (OSError, ValueError) as exc:
            raise AgentError("RUN_READ_FAILED", "Run state is unreadable; absence of a receipt does not prove no action occurred.") from exc
        if (not isinstance(value, dict) or value.get("schema") != "harmony-run/1"
                or value.get("runId") != self.run_id or not isinstance(value.get("status"), str)
                or not isinstance(value.get("frames"), list)
                or not all(isinstance(frame, str) for frame in value["frames"])):
            raise AgentError("RUN_READ_FAILED", "Invalid execution record.")
        # json.loads already owns this data. Keep verification on the complete
        # record; output projection below never rewrites the persisted file.
        result = value
        result["replayAllowed"] = False
        # A process may still be running or may have died. A read cannot decide which.
        if result["status"] == "running":
            result["outcome"] = "unresolved"
        frame_refs, assertions = set(value.get("frames", [])), []
        def collect(item):
            if isinstance(item, dict):
                for key in ("frameId", "beforeFrameId", "afterFrameId"):
                    if isinstance(item.get(key), str):
                        frame_refs.add(item[key])
                if "selector" in item and "expected" in item and "actual" in item and "frameId" in item:
                    assertions.append(item)
                for nested in item.values():
                    collect(nested)
            elif isinstance(item, list):
                for nested in item:
                    collect(nested)
        collect(value.get("receipts", []))
        collect(value.get("result", {}))
        missing, mismatches = [], []
        frames = {}
        for frame_id in sorted(frame_refs):
            try:
                frames[frame_id] = self.frame(frame_id)
            except AgentError:
                missing.append(frame_id)
        from .observation import select_nodes
        for assertion in assertions:
            frame = frames.get(assertion["frameId"])
            if frame is None:
                continue
            try:
                nodes = select_nodes(frame, assertion["selector"])
                prop = assertion.get("property", "text")
                actual = nodes[0].get(prop) if len(nodes) == 1 else (False if not nodes and prop == "visible"
                         and frame.get("quality", {}).get("complete") is True else None)
                if type(actual) is not type(assertion["actual"]) or actual != assertion["actual"]:
                    mismatches.append({"frameId": assertion["frameId"], "reason": "actual_value_mismatch"})
                if assertion.get("status") == "passed" and not (type(actual) is type(assertion["expected"]) and actual == assertion["expected"]):
                    mismatches.append({"frameId": assertion["frameId"], "reason": "passed_condition_mismatch"})
            except (AgentError, TypeError, ValueError):
                mismatches.append({"frameId": assertion["frameId"], "reason": "invalid_assertion"})
        result["evidenceCheck"] = {"missingFrames": missing, "assertionMismatches": mismatches,
                                   "assertionsChecked": len(assertions), "complete": not missing and not mismatches}
        if not full:
            self._compact_report(result)
        return result

    def _compact_report(self, report):
        """Remove presentation copies, never the only available step evidence."""
        outcome = report.get("result")
        omitted_paths, omitted_steps, retained_steps = [], 0, 0
        if isinstance(outcome, dict):
            receipts = {}
            for receipt in report.get("receipts", []):
                if isinstance(receipt, dict) and isinstance(receipt.get("stepId"), str):
                    receipts.setdefault(receipt["stepId"], []).append(receipt)
            if isinstance(outcome.get("steps"), list):
                unique = []
                for step in outcome["steps"]:
                    step_id = step.get("stepId") if isinstance(step, dict) else None
                    copies = receipts.get(step_id, []) if isinstance(step_id, str) else []
                    if copies and any(all(key in receipt and receipt[key] == value
                                          for key, value in step.items()) for receipt in copies):
                        omitted_steps += 1
                    else:
                        # A failed checkpoint may leave this as the only record
                        # of a step or its error; it is not a redundant copy.
                        unique.append(step)
                retained_steps = len(unique)
                if omitted_steps:
                    omitted_paths.append("result.steps")
                    if unique:
                        outcome["steps"] = unique
                    else:
                        del outcome["steps"]
            observation = outcome.get("observation")
            if isinstance(observation, dict) and isinstance(observation.get("frameId"), str):
                outcome["observationRef"] = {"runId": self.run_id, **{
                    key: observation[key] for key in ("frameId", "capturedAt", "sessionEpoch", "device")
                    if key in observation}}
                del outcome["observation"]
                omitted_paths.append("result.observation")
        report["projection"] = {"view": "compact-report", "fullAvailable": True,
                                "omittedPaths": omitted_paths, "omittedStepCopies": omitted_steps,
                                "retainedUnmatchedSteps": retained_steps,
                                "evidenceCheckedBeforeProjection": True}

    def frame(self, frame_id):
        frame_id = session_name(frame_id)
        path = self.folder / "frames" / (frame_id + ".json")
        if not path.resolve().is_relative_to(self.folder.resolve()):
            raise AgentError("INVALID_FRAME", "Frame path leaves the execution directory.")
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise AgentError("FRAME_NOT_FOUND", "The frozen frame is unavailable.") from exc
        try:
            value = loaded_frame(value)
        except ValueError as exc:
            raise AgentError("INVALID_FRAME", "Frozen frame storage is invalid.") from exc
        if not isinstance(value, dict) or value.get("frameId") != frame_id or not isinstance(value.get("nodes"), list):
            raise AgentError("INVALID_FRAME", "Frozen frame is invalid.")
        return value
