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


def decision_result(result):
    """Project a finished run for the next decision without changing execution.

    Call only after attempting to persist the complete run. Successful step
    receipts remain available through ``report RUN_ID --full``; this view does
    not alter actions, checks, captures, or goal verification. In particular,
    a completed plan is not evidence that an undeclared business goal passed.
    A persistence failure retains all receipts because the public return may
    be their only complete copy.
    """
    from .plans import MUTATIONS

    def needs_attention(value):
        if isinstance(value, dict):
            if any(value.get(key) for key in
                   ("error", "errors", "warning", "warnings", "checkpointError", "persistenceError")):
                return True
            if "status" in value and value["status"] not in ("completed", "passed", "not_requested"):
                return True
            if "dispatched" in value and value["dispatched"] != "acknowledged":
                return True
            return any(needs_attention(item) for item in value.values())
        if isinstance(value, list):
            return any(needs_attention(item) for item in value)
        return False

    def increment(counts, value):
        if isinstance(value, str):
            counts[value] = counts.get(value, 0) + 1

    projected = deepcopy({key: value for key, value in result.items() if key not in {"steps", "lastResult"}})
    projected["format"] = "harmony-run-decision/1"
    steps = result.get("steps", [])
    summary = {"total": len(steps), "commands": {}, "statuses": {}, "actionStatuses": {},
               "actionCommands": [], "conditions": {"matched": 0, "notMatched": 0, "unknown": 0},
               "omittedSuccessSteps": 0, "retainedSteps": 0}
    retained = []
    persistence_failed = "persistenceError" in result
    for index, step in enumerate(steps):
        if isinstance(step, dict):
            increment(summary["commands"], step.get("command"))
            increment(summary["statuses"], step.get("status"))
            if step.get("command") in MUTATIONS:
                summary["actionCommands"].append(step["command"])
                receipt = step.get("result")
                if not isinstance(receipt, dict) or not isinstance(receipt.get("action"), dict):
                    error = step.get("error")
                    receipt = error.get("details", {}) if isinstance(error, dict) else {}
                if isinstance(receipt, dict) and isinstance(receipt.get("action"), dict):
                    increment(summary["actionStatuses"], receipt["action"].get("status"))
            attention_step = step
            condition = step.get("result")
            if step.get("kind") in {"if", "repeat"} and isinstance(condition, dict):
                condition_count = {"passed": "matched", "failed": "notMatched", "unknown": "unknown"}.get(condition.get("status"))
                if condition_count:
                    summary["conditions"][condition_count] += 1
                if (result.get("status") == "completed" and step.get("status") == "completed"
                        and condition.get("status") == "failed"):
                    # A false if/repeat condition can be ordinary control flow.
                    # Ignore only that direct status while checking every nested
                    # diagnostic; never reinterpret assertions, guards or goals.
                    attention_step = {**step, "result": {**condition, "status": "passed"}}
            successful = step.get("status") == "completed" and not needs_attention(attention_step)
        else:
            successful = False
        # A callback can complete before the runner rejects its missing or
        # invalid action/assertion. Keep the terminal evidence on any failure.
        unresolved_terminal = index == len(steps) - 1 and result.get("status") not in {"completed", "yielded"}
        if persistence_failed or not successful or unresolved_terminal:
            retained.append(deepcopy(step))
        else:
            summary["omittedSuccessSteps"] += 1
    summary["retainedSteps"] = len(retained)
    projected["stepsSummary"] = summary
    if retained:
        projected["steps"] = retained

    if "lastResult" in result:
        last = deepcopy(result["lastResult"])
        if isinstance(last, dict) and not persistence_failed and not needs_attention(last):
            last_command = next((step.get("result") for step in reversed(steps)
                                 if isinstance(step, dict) and step.get("kind") == "command"
                                 and isinstance(step.get("result"), dict)), {})
            # Remove only exact copies. Unique fields, including future
            # recovery information, are not discarded by a field allowlist.
            shared = set(last) & set(last_command)
            if shared and all(last[key] == last_command[key] for key in shared):
                last = {key: value for key, value in last.items() if key not in shared}
            if last.get("observation") == projected.get("observation"):
                last.pop("observation", None)
        if last:
            projected["lastResult"] = last

    frame_ids = set()

    def collect_frames(value):
        if isinstance(value, dict):
            for key in ("frameId", "beforeFrameId", "afterFrameId"):
                if isinstance(value.get(key), str):
                    frame_ids.add(value[key])
            for item in value.values():
                collect_frames(item)
        elif isinstance(value, list):
            for item in value:
                collect_frames(item)

    collect_frames(result)
    evidence = projected.get("evidence", {})
    projected["evidence"] = {**(evidence if isinstance(evidence, dict) else {"original": evidence}),
                             "runId": result.get("runId"), "frameIds": sorted(frame_ids),
                             "fullReportAvailable": bool(result.get("runId")) and not persistence_failed}
    return projected


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

    @staticmethod
    def _valid_workflow_receipt(value):
        if (not isinstance(value, dict) or value.get("schema") != "harmony-workflow-receipt/1"
                or not isinstance(value.get("runId"), str) or not isinstance(value.get("session"), dict)
                or not isinstance(value.get("sessionCleanup"), dict) or not isinstance(value.get("at"), str)):
            return False
        if any(not isinstance(value["session"].get(key), str) or not value["session"][key]
               for key in ("name", "device", "epoch")):
            return False
        cleanup = value["sessionCleanup"]
        if (cleanup.get("status") not in ("detached", "retained", "failed")
                or not isinstance(cleanup.get("reason"), str) or not cleanup["reason"]
                or cleanup.get("deviceStopped") is not False):
            return False
        if cleanup["status"] == "failed" and (not isinstance(cleanup.get("error"), dict)
                                              or not isinstance(cleanup["error"].get("code"), str)):
            return False
        try:
            return datetime.fromisoformat(value["at"].replace("Z", "+00:00")).tzinfo is not None
        except ValueError:
            return False

    def write_workflow_receipt(self, session, cleanup):
        """Record task closing separately, without rewriting the execution journal.

        The caller holds the session/device locks and supplies the observed
        cleanup outcome. This method performs no device calls or full report
        reads. A later report checks its identity against the saved run.
        """
        receipt = {"schema": "harmony-workflow-receipt/1", "runId": self.run_id,
                   "session": {key: session.get(key) for key in ("name", "device", "epoch")},
                   "sessionCleanup": deepcopy(cleanup), "at": timestamp()}
        if not self._valid_workflow_receipt(receipt):
            raise AgentError("WORKFLOW_RECEIPT_INVALID", "Invalid workflow closing receipt; do not replay actions.")
        try:
            if not (self.folder / "run.json").is_file():
                raise FileNotFoundError("No execution journal exists for this workflow receipt.")
            atomic_json(self.folder / "workflow.json", receipt)
        except OSError as exc:
            raise AgentError("WORKFLOW_RECEIPT_WRITE_FAILED", "Workflow closing could not be recorded; do not replay actions.",
                             details={"runId": self.run_id, "osError": exc.errno,
                                      "winError": getattr(exc, "winerror", None)}) from exc
        return {"available": True, **receipt}

    def _read_workflow_receipt(self, record):
        unknown = {"available": False, "runId": self.run_id, "sessionCleanup": {"status": "unknown"}}
        try:
            receipt = json.loads((self.folder / "workflow.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {**unknown, "reason": "not_recorded"}
        except (OSError, ValueError):
            return {**unknown, "reason": "unreadable", "error": {
                "code": "WORKFLOW_RECEIPT_READ_FAILED", "message": "Workflow closing evidence is unreadable."}}
        if not self._valid_workflow_receipt(receipt):
            return {**unknown, "reason": "invalid", "error": {
                "code": "WORKFLOW_RECEIPT_INVALID", "message": "Workflow closing evidence is invalid."}}
        expected = {"name": record.get("session"), "device": record.get("device"), "epoch": record.get("sessionEpoch")}
        if receipt["runId"] != self.run_id or receipt["session"] != expected:
            return {**unknown, "reason": "identity_mismatch", "error": {
                "code": "WORKFLOW_RECEIPT_IDENTITY_MISMATCH", "message": "Workflow closing evidence belongs to a different run or session."}}
        return {"available": True, **receipt}

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
        frame_refs, assertions, bindings = set(value.get("frames", [])), [], []
        def collect(item):
            if isinstance(item, dict):
                for key in ("frameId", "beforeFrameId", "afterFrameId"):
                    if isinstance(item.get(key), str):
                        frame_refs.add(item[key])
                if "selector" in item and "expected" in item and "actual" in item and "frameId" in item:
                    assertions.append(item)
                if item.get("kind") == "read" and ("result" in item or item.get("status") == "completed"):
                    bindings.append(item.get("result"))
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
        from .bindings import normalize_read_result
        from .schema import PROPERTIES
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
        binding_mismatches = []
        for binding in bindings:
            if (not isinstance(binding, dict) or not isinstance(binding.get("frameId"), str)
                    or not binding["frameId"] or not isinstance(binding.get("name"), str)
                    or "selector" not in binding or "value" not in binding
                    or binding.get("property") not in PROPERTIES):
                binding_mismatches.append({"reason": "invalid_binding"})
                continue
            frame_id = binding["frameId"]
            frame = frames.get(frame_id)
            if frame is None:
                # Missing frame identity is already reported by missingFrames.
                continue
            reference = {"frameId": frame_id, "name": binding["name"]}
            try:
                nodes = select_nodes(frame, binding["selector"])
                if len(nodes) != 1:
                    binding_mismatches.append({**reference, "reason": "binding_source_not_unique"})
                    continue
                actual = normalize_read_result(binding, {"value": nodes[0].get(binding["property"]), "frameId": frame_id})["value"]
                if type(actual) is not type(binding["value"]) or actual != binding["value"]:
                    binding_mismatches.append({**reference, "reason": "binding_value_mismatch"})
            except (AgentError, TypeError, ValueError, AttributeError):
                binding_mismatches.append({**reference, "reason": "invalid_binding_source"})
        result["evidenceCheck"] = {"missingFrames": missing, "assertionMismatches": mismatches,
                                   "assertionsChecked": len(assertions), "bindingsChecked": len(bindings),
                                   "bindingMismatches": binding_mismatches,
                                   "complete": not missing and not mismatches and not binding_mismatches}
        result["workflowReceipt"] = self._read_workflow_receipt(value)
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
