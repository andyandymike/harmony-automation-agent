"""Small native execution loop: observe, act once, then verify."""
from __future__ import annotations

from copy import deepcopy
from contextlib import contextmanager, nullcontext
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import uuid
import threading

from . import SCHEMA_VERSION, __version__, DEFAULT_INPUT_TIMEOUT_MS
from .errors import AgentError
from .observation import (normalize_layout, project_observation, resolve_target,
                          select_nodes, diff_observations, project_diff,
                          parse_selector, selector_uses_refs)
from .state import StateStore, session_name


def now():
    return datetime.now(timezone.utc).isoformat()


def positive_integer(value, name, default, maximum=60000):
    value = default if value is None else value
    if type(value) is not int or not 1 <= value <= maximum:
        raise AgentError("INVALID_ARGUMENT", f"{name} must be an integer from 1 to {maximum}.")
    return value


class Agent:
    def __init__(self, state_dir=None, hdc_path=None, *, transport=None):
        self.store = StateStore(state_dir)
        self.hdc_path = hdc_path
        self._transport = transport
        self.cancel_event = threading.Event()
        self._budget = None
        self._run_store = None
        self._last_capture = None
        self._last_capture_time = None
        self._metrics = {}
        self._counts = {}
        self._profile_enabled = False
        self._capture_details = {"instrumentedCaptures": 0, "hdcCalls": 0, "stagesMs": {}}

    def request_cancel(self):
        self.cancel_event.set()

    def clear_cancel(self):
        self.cancel_event.clear()

    def _interrupt(self):
        if self.cancel_event.is_set():
            raise AgentError("CANCELLED", "Execution cancelled. Observe before deciding whether to retry.")
        if self._budget is not None:
            self._budget.check()

    @contextmanager
    def _measure(self, stage):
        started = time.perf_counter()
        try:
            yield
        finally:
            self._metrics[stage] = self._metrics.get(stage, 0.0) + (time.perf_counter() - started) * 1000

    @property
    def transport(self):
        if self._transport is None:
            from .transport import HdcTransport
            self._transport = HdcTransport(self.hdc_path)
        return self._transport

    def execute(self, command, params=None):
        started = time.perf_counter()
        self._metrics = {}
        self._counts = {}
        self._profile_enabled = bool((params or {}).get("profile")) or command in {"run", "execute"}
        self._capture_details = {"instrumentedCaptures": 0, "hdcCalls": 0, "stagesMs": {}}
        try:
            result = self._execute(command, params)
        except AgentError as exc:
            if (params or {}).get("profile"):
                exc.details["profile"] = self._profile(started)
            raise
        if isinstance(result, dict) and ((params or {}).get("profile") or command in {"run", "execute"}):
            result["profile"] = self._profile(started)
        return result

    def _profile(self, started):
        return {"schema": "harmony-profile/1", "coreWallMs": round((time.perf_counter() - started) * 1000, 3),
                "stagesMs": {key: round(value, 3) for key, value in self._metrics.items()},
                "counts": dict(self._counts),
                "captureBreakdown": {
                    "instrumentedCaptures": self._capture_details["instrumentedCaptures"],
                    "hdcCalls": self._capture_details["hdcCalls"] if self._capture_details["instrumentedCaptures"] else None,
                    "stagesMs": {key: round(value, 3) for key, value in self._capture_details["stagesMs"].items()},
                    "nativeExportMs": None, "transferMs": None,
                    "note": "HDC process time combines host startup/wait, native export, transfer and remote cleanup. "
                            "Export and transfer are not measured separately; these stages are inside capture."},
                "modelMs": None, "hostSchedulingMs": None, "inputTokens": None, "outputTokens": None,
                "note": "Stages can nest. Core wall excludes CLI startup, output serialization and host/model time."}

    def _execute(self, command, params=None):
        params = dict(params or {})
        if command == "report":
            from .execution import RunStore
            if not params.get("run_id"):
                raise AgentError("INVALID_ARGUMENT", "report requires run_id.", exit_code=2)
            return RunStore(self.store.root, params["run_id"]).read(full=params.get("full", False))
        if command == "inspect" and params.get("run_id"):
            from .execution import RunStore
            if not params.get("frame_id"):
                raise AgentError("INVALID_ARGUMENT", "inspect requires frame_id.", exit_code=2)
            return self._inspect(RunStore(self.store.root, params["run_id"]).frame(params["frame_id"]), params)
        self._interrupt()
        if params.get("view", "tree") not in {"tree", "semantic"}:
            raise AgentError("INVALID_ARGUMENT", "view must be tree or semantic.", exit_code=2)
        if "max_nodes" in params:
            positive_integer(params["max_nodes"], "max_nodes", 80, 5000)
        if "compact" in params and type(params["compact"]) is not bool:
            raise AgentError("INVALID_ARGUMENT", "compact must be a boolean.", exit_code=2)
        if "interactive" in params and type(params["interactive"]) is not bool:
            raise AgentError("INVALID_ARGUMENT", "interactive must be a boolean.", exit_code=2)
        if "timeout_ms" in params:
            params["timeout_ms"] = positive_integer(params["timeout_ms"], "timeout_ms",
                                                     DEFAULT_INPUT_TIMEOUT_MS if command == "fill" else 5000)
        if command == "doctor":
            return self._doctor(params)
        if command == "devices":
            devices = self.transport.devices()
            return {"devices": [{"id": item} for item in devices], "count": len(devices),
                    "hint": None if devices else "Connect and authorize a device, then run devices again."}
        supported = {"execute", "start", "attach", "detach", "open", "observe", "find", "press", "fill", "scroll", "back", "wait", "screenshot", "capabilities", "run", "inspect", "claim", "release"}
        if command not in supported:
            raise AgentError("UNKNOWN_COMMAND", f"Unknown command: {command}", exit_code=2)
        name = session_name(params.get("session"))
        if command == "execute":
            from .schema import validate_params
            params = validate_params(command, params)
            if params.get("run_id") is not None:
                session_name(params["run_id"])
        if command == "run":
            from .plans import validate_plan
            if params.get("output", "full") not in {"full", "decision"}:
                raise AgentError("INVALID_ARGUMENT", "output must be full or decision.", exit_code=2)
            params["plan"] = validate_plan(params.get("plan"))
        with self.store.lock(name):
            if command == "execute":
                return self._execute_workflow(name, params)
            if command == "attach":
                return self._attach(name, params)
            if command == "start":
                return self._start(name, params)
            if command == "detach":
                try:
                    session = self.store.load(name)
                except AgentError as exc:
                    if exc.code == "NO_SESSION":
                        return {"session": name, "detached": False}
                    if exc.code == "INVALID_SESSION_STATE":
                        # The session lock protects this local-only recovery.
                        # A corrupt file cannot supply a trustworthy device ID.
                        return {"session": name, "detached": self.store.detach(name),
                                "deviceStopped": False, "recoveredInvalidState": True}
                    raise
                with self.store.device_lock(session["device"]):
                    owner = self.store.device_owner(session["device"])
                    if owner == self.store._owner_identity(session):
                        self.store.release_device(session)
                    return {"session": name, "detached": self.store.detach(name), "deviceStopped": False}
            session = self.store.load(name)
            if params.get("device") and params["device"] != session["device"]:
                raise AgentError("DEVICE_MISMATCH", "This session is attached to a different device.")
            if command == "inspect":
                if not session.get("frame") or params.get("frame_id") != session["frame"]["frameId"]:
                    raise AgentError("FRAME_NOT_FOUND", "The requested frame is not the cached session frame.")
                result = self._inspect(session["frame"], params)
                result["frameValidForActions"] = session["frameValid"]
                return result
            with self.store.device_lock(session["device"]), self._frame_guard(name, session):
                if command == "claim":
                    self.store.claim_device(session)
                    return {"session": name, "device": session["device"], "owned": True}
                if command == "release":
                    released = self.store.release_device(session)
                    session["frameValid"] = False
                    self.store.save(name, session)
                    return {"session": name, "released": released, "deviceStopped": False}
                if command in {"run", "open", "press", "fill", "scroll", "back"}:
                    self.store.require_device_owner(session)
                if command == "run":
                    return self._run_plan(name, session, params)
                with self._measure("preflight"):
                    self._check_device(name, session)
                return self._execute_locked(name, session, command, params)

    def _execute_workflow(self, name, params):
        """Finish a known task in one entry point, without an initial public read."""
        try:
            session = self.store.load(name)
        except AgentError as exc:
            if exc.code != "NO_SESSION":
                raise
            self._attach(name, params)
            session = self.store.load(name)
        if session["device"] != params["device"]:
            raise AgentError("DEVICE_MISMATCH", "This session is attached to a different device.")
        with self.store.device_lock(session["device"]), self._frame_guard(name, session):
            self.store.require_device_owner(session)
            result = self._run_plan(name, session, params)
            verified = (result.get("status") == "completed"
                        and result.get("goalVerification", {}).get("status") == "passed")
            cleanup = {"status": "retained", "reason": "keep_session" if params["keep_session"]
                       else "workflow_not_verified", "deviceStopped": False}
            if verified and not params["keep_session"]:
                session["frameValid"] = False
                result["frameValidForActions"] = False
                try:
                    # The run receipt is already durable. Cleanup updates only
                    # session lifecycle state and is returned separately.
                    self.store.save(name, session)
                    self.store.release_device(session)
                    self.store.detach(name)
                    cleanup = {"status": "detached", "reason": "verified_completion", "deviceStopped": False}
                except (Exception, KeyboardInterrupt) as exc:
                    error = exc.to_dict() if isinstance(exc, AgentError) else {
                        "code": "SESSION_CLEANUP_FAILED", "message": "Workflow completed but session cleanup failed.",
                        "details": {"exception": type(exc).__name__, "cause": str(exc), "dispatched": "no"}}
                    cleanup = {"status": "failed", "reason": "cleanup_error", "deviceStopped": False,
                               "error": error}
            result["sessionCleanup"] = cleanup
            try:
                from .execution import RunStore
                RunStore(self.store.root, result["runId"]).write_workflow_receipt(session, cleanup)
                result["workflowReceiptAvailable"] = True
            except (Exception, KeyboardInterrupt) as exc:
                error = exc.to_dict() if isinstance(exc, AgentError) else {
                    "code": "WORKFLOW_RECEIPT_WRITE_FAILED", "message": "Workflow cleanup receipt could not be persisted.",
                    "details": {"exception": type(exc).__name__, "cause": str(exc), "dispatched": "no"}}
                result["workflowReceiptAvailable"] = False
                result.setdefault("warnings", []).append({
                    "code": "WORKFLOW_RECEIPT_UNAVAILABLE",
                    "message": "Business execution and cleanup results are retained here; their cleanup receipt is unavailable.",
                    "error": error})
            return result

    def _start(self, name, params):
        """One read-only device entry point; keep an existing session's identity."""
        if not params.get("device"):
            raise AgentError("INVALID_ARGUMENT", "start requires an explicit device.", exit_code=2)
        attached = False
        try:
            session = self.store.load(name)
        except AgentError as exc:
            if exc.code != "NO_SESSION":
                raise
            self._attach(name, params)
            session = self.store.load(name)
            attached = True
        if session["device"] != params["device"]:
            raise AgentError("DEVICE_MISMATCH", "This session is attached to a different device.")
        with self.store.device_lock(session["device"]), self._frame_guard(name, session):
            if not attached:
                with self._measure("preflight"):
                    self._check_device(name, session)
            frame = self._capture(session)
            self._publish(name, session, frame)
            observation = self._project(frame, {"compact": True, "max_nodes": 40, **params})
            return {"session": name, "device": session["device"], "epoch": session["epoch"],
                    "resumed": not attached, "observationReady": True,
                    "contract": {"planVersions": ["1", "2"], "runOutputs": ["full", "decision"],
                                 "boundValues": ["read", "var", "concat"]},
                    "observation": observation}

    def _execute_locked(self, name, session, command, params):
        """Execute under the caller's session and device locks, never reacquiring them."""
        self._interrupt()
        if command == "capabilities":
            return self._capabilities(session)
        if command in {"observe", "find"}:
            previous = session.get("frame")
            observation = self._capture(session)
            self._publish(name, session, observation)
            query = params.get("text") if command == "find" else None
            public = self._project(observation, params, query=query)
            if previous and params.get("view") != "semantic" and not params.get("_plan_internal"):
                public["diff"] = project_diff(diff_observations(previous, observation),
                    self._project(previous, params, query=query), public, max_changes=params.get("max_nodes", 80))
            return public
        if command == "wait":
            condition = {"selector": params.get("target"), "property": params.get("property", "text"),
                         "equals": params.get("equals"), "timeoutMs": params.get("timeout_ms", 5000)}
            return self._wait_command(name, session, condition, params)
        if command == "screenshot":
            destination = self.store.artifacts(name, uuid.uuid4().hex) / "screen.png"
            self.transport.screenshot(session["device"], destination)
            return {"path": str(destination), "capturedAt": now(), "device": session["device"]}
        return self._action(name, session, command, params)

    def _inspect(self, observation, params):
        if params.get("frame_id") != observation.get("frameId"):
            raise AgentError("FRAME_NOT_FOUND", "The frozen frame does not match frame_id.")
        matches = select_nodes(observation, params["target"]) if params.get("target") else observation["nodes"]
        maximum = positive_integer(params.get("max_nodes"), "max_nodes", 80, 5000)
        refs = {node["ref"] for node in matches[:maximum]}
        by_ref = {node["ref"]: node for node in observation["nodes"]}
        ancestors = set()
        for node in matches[:maximum]:
            parent = node.get("parent")
            while parent in by_ref and parent not in ancestors:
                ancestors.add(parent)
                parent = by_ref[parent].get("parent")
        selected_nodes = [deepcopy(node) for node in observation["nodes"] if node["ref"] in refs | ancestors]
        filtered = len(matches) != len(observation["nodes"])
        omitted = max(0, len(matches) - len(refs))
        quality = {**deepcopy(observation["quality"]), "sourceComplete": observation["quality"].get("complete"),
                   "complete": observation["quality"].get("complete") is True and not filtered and not omitted,
                   "truncated": bool(omitted), "filtered": filtered, "returnedNodes": len(selected_nodes),
                   "absenceEvidence": False}
        return {"frameId": observation["frameId"], "capturedAt": observation.get("capturedAt"),
                "sessionEpoch": observation.get("sessionEpoch"), "device": observation.get("device"),
                "fresh": False, "readOnly": True, "matches": len(matches),
                "nodes": selected_nodes,
                "quality": quality,
                "projection": {"view": "frozen-detail", "returnedMatches": len(refs),
                               "omittedMatches": max(0, len(matches) - len(refs)), "ancestorCount": len(ancestors - refs)}}

    def _run_plan(self, name, session, params):
        from .execution import RunStore, decision_result
        from .plans import PlanBudget, run_plan
        run_id = params.get("run_id") or uuid.uuid4().hex
        # Resolve a lazy transport before changing run/ownership state.
        transport = self.transport
        journal = RunStore(self.store.root, run_id)
        journal.begin(params["plan"], session)
        self.store.claim_device(session)
        budget = PlanBudget(params["plan"]["limits"])
        self._budget, self._run_store = budget, journal
        self._last_capture = None
        self._last_capture_time = None
        old_guard = getattr(transport, "execution_guard", None)
        transport.execution_guard = lambda: (self._interrupt(), budget.remaining_ms())[1]
        frame_before = None
        final_projection = {"view": "tree", "compact": True, **params}
        final_query = None

        def checkpoint(event):
            nonlocal frame_before
            event = deepcopy(event)
            if event.get("event", event.get("type")) == "step_started":
                frame_before = (session.get("frame") or {}).get("frameId")
            summary = event.get("result", {})
            event["basisFrameId"] = frame_before
            event["beforeFrameId"] = summary.get("beforeFrameId")
            event["afterFrameId"] = summary.get("afterFrameId", summary.get("frameId"))
            event["runId"] = run_id
            journal.checkpoint(event)

        def executor(command, inputs):
            nonlocal final_projection, final_query
            self._interrupt()
            # The selected HDC target is explicit on every native call. A run
            # checks connectivity/boot once; don't enumerate devices before
            # each immediate local step. Explicit refresh requests recheck.
            if inputs.get("_plan_refresh"):
                with self._measure("preflight"):
                    self._check_device(name, session)
            inputs = {"view": params.get("view", "tree"), "compact": params.get("compact", True),
                      "max_nodes": params.get("max_nodes", 80), "interactive": params.get("interactive", False),
                      **inputs, "_plan_internal": True}
            final_projection = {key: value for key, value in inputs.items() if not key.startswith("_")}
            final_query = inputs.get("text") if command == "find" else None
            result = self._execute_locked(name, session, command, inputs)
            return result

        def evaluate(condition):
            self._interrupt()
            observation, source = self._run_frame(session, purpose="condition")
            if source == "captured":
                self._publish(name, session, observation)
            return self._evaluate_frame(session["frame"], condition)

        def reader(spec):
            self._interrupt()
            observation, source = self._run_frame(session, purpose="condition")
            if source == "captured":
                self._publish(name, session, observation)
            matches = select_nodes(observation, spec["selector"])
            prop = spec.get("property", "text")
            if len(matches) != 1 or matches[0].get(prop) is None:
                raise AgentError("PLAN_READ_FAILED", "A plan read needs one node with an exposed value.",
                                 details={"frameId": observation["frameId"], "selector": deepcopy(spec["selector"]),
                                          "property": prop, "matches": len(matches),
                                          "evidenceRef": {"runId": run_id, "frameId": observation["frameId"]}},
                                 dispatched="no")
            return {"value": matches[0][prop], "frameId": observation["frameId"],
                    "selector": deepcopy(spec["selector"]), "property": prop,
                    "evidenceRef": {"runId": run_id, "frameId": observation["frameId"]}}

        try:
            # A run always begins with fresh evidence; old cached state is not a precondition proof.
            session["frameValid"] = False
            with self._measure("statePersistence"):
                self.store.save(name, session)
            with self._measure("preflight"):
                self._check_device(name, session)
            result = run_plan(params["plan"], executor, evaluate, reader=reader, checkpoint=checkpoint, budget=budget)
            result.update(runId=run_id, replayAllowed=False, deviceOwnership="session_until_release_or_detach")
            if result["status"] not in {"completed", "yielded"}:
                session["frameValid"] = False
            try:
                # The on-disk session stayed invalid throughout this run.
                # Publish only its final state, not every intermediate frame.
                with self._measure("statePersistence"):
                    self.store.save(name, session)
            except (Exception, KeyboardInterrupt) as exc:
                session["frameValid"] = False
                result.setdefault("warnings", []).append("Failed to persist invalidated refs: " + type(exc).__name__)
            if self._last_capture:
                result["observation"] = self._project(self._last_capture, final_projection, query=final_query)
                result["observationRole"] = "last_captured_not_necessarily_post_action"
            result["frameValidForActions"] = session["frameValid"]
            # Keep one decision view, not a duplicate full page inside lastResult.
            if isinstance(result.get("lastResult"), dict):
                result["lastResult"] = {key: value for key, value in result["lastResult"].items()
                                        if key != "observation" and key not in {"nodes", "items", "regions", "facts", "controls", "actions", "fields"}}
            result["profile"] = {"stagesMs": {k: round(v, 3) for k, v in self._metrics.items()}, "modelMs": None}
            try:
                journal.finish(result)
            except AgentError as exc:
                result["persistenceError"] = exc.to_dict()
                result["status"] = "unknown"
                result["yieldReason"] = "receipt_persistence_failed"
            return decision_result(result) if params.get("output") == "decision" else result
        except BaseException as cause:
            error = cause.to_dict() if isinstance(cause, AgentError) else {"code": "CANCELLED" if isinstance(cause, KeyboardInterrupt) else "INTERNAL_ERROR"}
            try:
                journal.finish({"status": "unknown", "error": error, "runId": run_id})
            except (Exception, KeyboardInterrupt):
                pass
            raise
        finally:
            self._budget, self._run_store = None, None
            transport.execution_guard = old_guard

    def _evaluate_frame(self, frame, condition):
        selector, prop, expected, _ = self._condition(condition)
        nodes = select_nodes(frame, selector)
        complete = frame["quality"].get("complete") is True
        actual = nodes[0].get(prop) if len(nodes) == 1 else (False if not nodes and complete and prop == "visible" else None)
        status = "unknown" if actual is None or len(nodes) > 1 else "passed" if type(actual) is type(expected) and actual == expected else "failed"
        result = {"status": status, "frameId": frame["frameId"], "selector": deepcopy(selector),
                  "property": prop, "expected": expected, "actual": actual, "matches": len(nodes),
                  "observationComplete": complete}
        if self._run_store is not None:
            result["evidenceRef"] = {"runId": self._run_store.run_id, "frameId": frame["frameId"]}
        return result

    @contextmanager
    def _frame_guard(self, name, session):
        """A failed or interrupted read cannot keep earlier refs authorized."""
        try:
            yield
        except BaseException:
            session["frameValid"] = False
            try:
                self.store.save(name, session)
            except (Exception, KeyboardInterrupt):
                # Preserve the original failure if the state volume is unavailable.
                pass
            raise

    def _doctor(self, params):
        checks = []
        devices = []
        try:
            version = self.transport.version()
            checks.append({"name": "hdc", "status": "passed", "version": version})
            devices = self.transport.devices()
            checks.append({"name": "devices", "status": "passed" if devices else "not_ready", "count": len(devices)})
            selected = params.get("device")
            if selected:
                if selected not in devices:
                    checks.append({"name": "selectedDevice", "status": "not_ready", "code": "DEVICE_NOT_FOUND"})
                else:
                    capabilities = self._runtime_capabilities(selected)
                    checks.append({"name": "uitest", "status": "passed" if capabilities.get("uitestVersion") else "not_ready", "details": capabilities})
        except AgentError as exc:
            checks.append({"name": "environment", "status": "failed", "error": exc.to_dict()})
        return {"ready": bool(checks) and all(x["status"] == "passed" for x in checks),
                "checks": checks, "devices": devices, "version": __version__,
                "hint": "Select an exact device with attach --device <id>; device enumeration does not create a session."}

    def _attach(self, name, params):
        device = params.get("device")
        if not isinstance(device, str) or not device:
            raise AgentError("DEVICE_REQUIRED", "attach requires an explicit --device identifier.", exit_code=2)
        available = self.transport.devices()
        if device not in available:
            raise AgentError("NO_DEVICE" if not available else "DEVICE_NOT_FOUND", "The requested device is not connected or authorized.", details={"devices": available})
        with self.store.device_lock(device):
            if self.store.path(name).exists():
                old = self.store.load(name)
                if old["device"] != device:
                    raise AgentError("SESSION_EXISTS", "Detach the existing session before choosing another device.")
                if self.store.device_owner(device) == self.store._owner_identity(old):
                    raise AgentError("DEVICE_OWNED", "This session owns the device; release or detach before reattaching.")
            boot = self.transport.boot_id(device)
            session = {"schemaVersion": SCHEMA_VERSION, "name": name, "device": device,
                       "epoch": uuid.uuid4().hex, "bootId": boot, "app": None,
                       "createdAt": now(), "frame": None, "frameValid": False}
            session["ownerToken"] = uuid.uuid4().hex
            self.store.save(name, session)
            return {"session": name, "device": device, "epoch": session["epoch"],
                    "warnings": [] if boot else ["Device boot identity is unavailable; refs are rechecked against a fresh observation before actions."]}

    def _check_device(self, name, session):
        if session["device"] not in self.transport.devices():
            session["frameValid"] = False
            self.store.save(name, session)
            raise AgentError("DEVICE_DISCONNECTED", "The attached device is no longer connected. Reconnect, then observe again.")
        boot = self.transport.boot_id(session["device"])
        if boot and not session.get("bootId"):
            session.update(bootId=boot, epoch=uuid.uuid4().hex, frame=None, frameValid=False)
            self.store.save(name, session)
            raise AgentError("DEVICE_IDENTITY_CHANGED", "Device boot identity became available; observe again before acting.")
        if boot and session.get("bootId") and boot != session["bootId"]:
            session.update(bootId=boot, epoch=uuid.uuid4().hex, frame=None, frameValid=False)
            self.store.save(name, session)
            raise AgentError("DEVICE_RESTARTED", "Device restarted; observe again before acting.")

    def _capabilities(self, session):
        return {"backend": "hdc-uitest", "device": session["device"],
                "runtime": self._runtime_capabilities(session["device"]),
                "implemented": ["start", "execute", "observe", "find", "press", "fill", "scroll", "back", "wait", "screenshot",
                                "run", "inspect", "report", "claim", "release", "semantic_view"],
                "experimental": ["native_text_input", "window_metadata"],
                "unsupported": ["model_planning", "visual_assertions", "event_watch", "automatic_recovery"],
                "bootIdentity": "available" if session.get("bootId") else "unknown",
                "note": "A command appearing in device help is not proof of semantic support on every control."}

    def _runtime_capabilities(self, device):
        return {key: value for key, value in self.transport.capabilities(device).items() if key != "help"}

    def _capture(self, session, *, timeout_ms=None):
        self._interrupt()
        if self._budget is not None:
            self._budget.consume_capture()
            timeout_ms = min(timeout_ms or 60000, self._budget.remaining_ms())
        transport = self.transport
        profiler = getattr(transport, "capture_profile", None) if self._profile_enabled else None
        with (profiler() if callable(profiler) else nullcontext(None)) as details:
            try:
                with self._measure("capture"):
                    raw = transport.capture_layout(session["device"], **({"timeout_ms": timeout_ms} if timeout_ms is not None else {}))
            finally:
                if details is not None:
                    self._capture_details["instrumentedCaptures"] += 1
                    self._capture_details["hdcCalls"] += details["hdcCalls"]
                    for key, value in details["stagesMs"].items():
                        stages = self._capture_details["stagesMs"]
                        stages[key] = stages.get(key, 0.0) + value
        self._last_capture_time = time.perf_counter()
        self._counts["captures"] = self._counts.get("captures", 0) + 1
        with self._measure("normalize"):
            observation = normalize_layout(raw, uuid.uuid4().hex)
        observation.update(capturedAt=now(), sessionEpoch=session["epoch"], device=session["device"])
        self._last_capture = observation
        if self._run_store is not None:
            with self._measure("evidencePersistence"):
                self._run_store.save_frame(observation)
        return observation

    def _publish(self, name, session, observation):
        session["frame"] = observation
        session["frameValid"] = True
        if self._run_store is None:
            with self._measure("statePersistence"):
                self.store.save(name, session)

    def _project(self, observation, params=None, *, query=None):
        if (params or {}).get("_plan_internal"):
            # The runner consumes frame IDs and exact assertions. Only its
            # final result needs a rendered decision page.
            return {key: observation[key] for key in ("frameId", "capturedAt", "sessionEpoch")
                    if key in observation}
        self._counts["projections"] = self._counts.get("projections", 0) + 1
        with self._measure("projection"):
            return self._project_view(observation, params, query=query)

    def _project_view(self, observation, params=None, *, query=None):
        params = params or {}
        maximum = positive_integer(params.get("max_nodes"), "max_nodes", 80, 5000)
        if params.get("view") == "semantic":
            from .semantic import semantic_page
            return semantic_page(observation, max_items=maximum, query=query)
        public = project_observation(observation, max_nodes=maximum, interactive=params.get("interactive", False), query=query)
        if params.get("compact", False):
            public["projection"]["compact"] = True
            # Empty business values and root parent links remain explicit.
            # In optional fields, missing means unknown/empty, never false.
            public["nodes"] = [{key: value for key, value in node.items()
                                if key == "parent" or value is not None
                                and (value != "" or key in {"text", "value"})}
                               for node in public["nodes"]]
        return public

    def _run_frame(self, session, *, refresh=False, purpose="condition"):
        """Reuse only a just-published frame inside this uninterrupted run.

        This is a bounded-age observation, not a guarantee of a static UI.
        Cross-call caches, failed actions and expired observations never qualify.
        """
        request_count = "targetFrameRequests" if purpose == "target" else "conditionFrameRequests"
        self._counts[request_count] = self._counts.get(request_count, 0) + 1
        frame = session.get("frame")
        if (not refresh and self._run_store is not None and session.get("frameValid")
                and frame is not None and frame is self._last_capture
                and self._last_capture_time is not None
                and 0 <= time.perf_counter() - self._last_capture_time <= 1.0):
            self._counts["reusedFrames"] = self._counts.get("reusedFrames", 0) + 1
            reuse_count = "reusedTargetFrames" if purpose == "target" else "reusedConditionFrames"
            self._counts[reuse_count] = self._counts.get(reuse_count, 0) + 1
            return frame, "reused"
        return self._capture(session), "captured"

    def _fresh_target(self, session, target, *, refresh=False):
        if target is None:
            raise AgentError("TARGET_REQUIRED", "An explicit selector or current ref is required.", exit_code=2)
        old = None
        is_ref = selector_uses_refs(target)
        if is_ref:
            if not session.get("frameValid") or not session.get("frame"):
                raise AgentError("STALE_REF", "Refs are invalid after an action, timeout or disconnect; observe again.")
            old = resolve_target(session["frame"], target)
        observation, _ = self._run_frame(session, refresh=refresh, purpose="target")
        if old is None:
            node = resolve_target(observation, target)
        else:
            previous = session["frame"]
            context = {"previous": self._frame_index(previous), "current": self._frame_index(observation),
                       "relocated": {}}
            fresh_node = self._relocate_ref(previous, observation, old["ref"], context)
            # Rebind every frame dependency, then apply *all* original
            # predicates again (checked, focused, within, etc.).
            rebound = self._rebind_selector(previous, observation, target, context)
            matches = select_nodes(observation, rebound)
            if len(matches) != 1 or matches[0]["ref"] != fresh_node["ref"]:
                raise AgentError("STALE_REF", "The target no longer satisfies the requested conditions; observe again.")
            node = matches[0]
        self._require_actionable(node, observation)
        return node, observation

    def _relocate_ref(self, previous, current, ref, context=None):
        if context is None:
            context = {"previous": self._frame_index(previous), "current": self._frame_index(current),
                       "relocated": {}}
        if ref in context["relocated"]:
            return context["relocated"][ref]
        old = resolve_target(previous, {"ref": ref})
        keys = ("id", "type", "text", "bounds", "bundleName", "hostWindowId", "displayId")
        old_context = self._context_signature(previous, old, context["previous"])
        candidates = [node for node in current["nodes"]
                      if all(node.get(key) == old.get(key) for key in keys)
                      and self._context_signature(current, node, context["current"]) == old_context]
        if len(candidates) != 1:
            raise AgentError("STALE_REF", "The referenced target or context changed; observe and select again.")
        context["relocated"][ref] = candidates[0]
        return candidates[0]

    def _rebind_selector(self, previous, current, selector, context=None):
        if context is None:
            context = {"previous": self._frame_index(previous), "current": self._frame_index(current),
                       "relocated": {}}
        parsed = parse_selector(selector)
        for key in ("ref", "parent"):
            if parsed.get(key) is not None:
                parsed[key] = self._relocate_ref(previous, current, parsed[key], context)["ref"]
        if parsed.get("within") is not None:
            parsed["within"] = self._rebind_selector(previous, current, parsed["within"], context)
        return parsed

    @staticmethod
    def _require_actionable(node, observation):
        if node.get("visible") is False or node.get("enabled") is False:
            raise AgentError("TARGET_NOT_ACTIONABLE", "The target is hidden or disabled.")
        # Text labels can be pressed at their own bounds. A child reporting
        # enabled/visible must not bypass an explicitly disabled/hidden parent.
        by_ref = {item["ref"]: item for item in observation["nodes"]}
        parent_ref = node.get("parent")
        seen = set()
        while parent_ref in by_ref and parent_ref not in seen:
            seen.add(parent_ref)
            parent = by_ref[parent_ref]
            if parent.get("visible") is False or parent.get("enabled") is False:
                raise AgentError("TARGET_NOT_ACTIONABLE", "An ancestor of the target is hidden or disabled.",
                                 details={"ancestorRef": parent_ref})
            parent_ref = parent.get("parent")
        if not node.get("center") or not node.get("bounds"):
            raise AgentError("TARGET_NOT_ACTIONABLE", "The target has no usable bounds.")
        b = node["bounds"]
        if b["right"] <= b["left"] or b["bottom"] <= b["top"]:
            raise AgentError("TARGET_NOT_ACTIONABLE", "The target has empty bounds.")

    @staticmethod
    def _frame_index(observation):
        by_ref, children = {}, {}
        for node in observation["nodes"]:
            by_ref[node["ref"]] = node
            children.setdefault(node.get("parent"), []).append(node)
        return {"by_ref": by_ref, "children": children, "signatures": {}}

    @staticmethod
    def _context_signature(observation, node, index=None):
        index = Agent._frame_index(observation) if index is None else index
        if node["ref"] in index["signatures"]:
            return index["signatures"][node["ref"]]
        by_ref = index["by_ref"]
        signature = []
        child = node
        seen = set()
        while child.get("parent") in by_ref and child["parent"] not in seen:
            parent = by_ref[child["parent"]]
            seen.add(parent["ref"])
            siblings = [(n.get("id"), n.get("type"), n.get("text"))
                        for n in index["children"].get(parent["ref"], []) if n["ref"] != child["ref"]]
            signature.append(((parent.get("id"), parent.get("type"), parent.get("text"),
                               parent.get("bundleName"), parent.get("hostWindowId")), siblings))
            child = parent
        index["signatures"][node["ref"]] = signature
        return signature

    def _condition(self, condition):
        if not isinstance(condition, dict) or set(condition) - {"selector", "property", "equals", "timeoutMs"}:
            raise AgentError("INVALID_EXPECTATION", "Expected selector, property, equals, and optional timeoutMs.", exit_code=2)
        selector = condition.get("selector")
        prop = condition.get("property", "text")
        if selector is None or prop not in {"text", "visible", "enabled", "checked", "selected", "focused"} or "equals" not in condition:
            raise AgentError("INVALID_EXPECTATION", "A selector and supported property/equals condition are required.", exit_code=2)
        expected = condition["equals"]
        if prop == "text" and not isinstance(expected, str) or prop != "text" and type(expected) is not bool:
            raise AgentError("INVALID_EXPECTATION", "Text conditions need a string; state conditions need a boolean.", exit_code=2)
        if selector_uses_refs(selector):
            raise AgentError("INVALID_EXPECTATION", "Conditions require stable selectors; ref and parent frame references are not allowed, including inside within.", exit_code=2)
        # Validate selector syntax before any mutation, even when no matching node exists.
        select_nodes({"nodes": [], "frameId": "validation"}, selector)
        timeout = positive_integer(condition.get("timeoutMs"), "timeoutMs", 5000)
        return selector, prop, expected, timeout

    def _wait(self, session, condition, *, initial_observation=None):
        observation, assertion = self._wait_impl(session, condition, initial_observation=initial_observation)
        assertion["selector"] = deepcopy(condition["selector"])
        assertion["frameId"] = observation.get("frameId") if observation else None
        if self._run_store is not None and observation is not None:
            assertion["evidenceRef"] = {"runId": self._run_store.run_id, "frameId": observation["frameId"]}
        return observation, assertion

    def _wait_impl(self, session, condition, *, initial_observation=None):
        selector, prop, expected, timeout = self._condition(condition)
        deadline = time.monotonic() + timeout / 1000
        attempts = 0
        observation = None
        actual = None
        complete = False
        while True:
            remaining = max(1, round((deadline - time.monotonic()) * 1000))
            try:
                if initial_observation is not None:
                    observation, initial_observation = initial_observation, None
                else:
                    observation = self._capture(session, timeout_ms=remaining)
            except AgentError as exc:
                if observation is not None and "TIMEOUT" in exc.code and time.monotonic() >= deadline:
                    return observation, {"status": "unknown" if actual is None else "failed", "property": prop,
                                         "actual": actual, "expected": expected, "attempts": attempts,
                                         "reason": "deadline_reached", "observationComplete": complete}
                raise
            attempts += 1
            candidates = select_nodes(observation, selector)
            if len(candidates) > 1:
                raise AgentError("TARGET_AMBIGUOUS", "The assertion selector matches more than one element.", details={"matches": len(candidates)})
            complete = observation.get("quality", {}).get("complete") is True
            actual = candidates[0].get(prop) if candidates else (False if prop == "visible" and complete else None)
            if time.monotonic() > deadline:
                return observation, {"status": "unknown", "property": prop, "actual": actual,
                                     "expected": expected, "attempts": attempts, "reason": "observation_completed_after_deadline",
                                     "observationComplete": complete}
            passed = actual == expected and type(actual) is type(expected)
            if passed:
                return observation, {"status": "passed", "property": prop, "actual": actual, "expected": expected, "attempts": attempts}
            if time.monotonic() >= deadline:
                return observation, {"status": "unknown" if actual is None else "failed", "property": prop, "actual": actual, "expected": expected, "attempts": attempts, "observationComplete": complete}
            time.sleep(min(0.15, max(0, deadline - time.monotonic())))

    def _wait_command(self, name, session, condition, params=None):
        self._condition(condition)
        operation = uuid.uuid4().hex
        started = time.monotonic()
        observation, assertion = self._wait(session, condition)
        self._publish(name, session, observation)
        result = {"operationId": operation, "assertion": assertion, "observation": self._project(observation, params),
                  "timings": {"totalMs": round((time.monotonic() - started) * 1000, 2)}}
        if assertion["status"] != "passed":
            result["evidence"] = self._evidence(name, session, operation, observation)
            raise AgentError("ASSERTION_TIMEOUT", "The expected condition was not observed before timeout.", details=result)
        return result

    def _replace_text(self, session, node, text, timeout_ms, result):
        """Focus, clear, verify empty, then insert once. Native inputText appends."""
        deadline = time.monotonic() + timeout_ms / 1000
        selector = {key: node[key] for key in ("id", "bundleName", "hostWindowId") if node.get(key)}

        def remaining():
            value = int((deadline - time.monotonic()) * 1000)
            if value <= 0:
                raise AgentError("INPUT_TIMEOUT", "Input preparation exceeded its time budget.", dispatched="unknown")
            return value

        result["input"] = {"mode": "replace", "phase": "focusing", "clipboardMayChange": bool(text)}
        device = session["device"]
        self.transport.tap(device, round(node["center"]["x"]), round(node["center"]["y"]), timeout_ms=remaining())
        result["input"]["sideEffectAcknowledged"] = True
        focus_frame, focused = self._wait(session, {"selector": selector, "property": "focused", "equals": True, "timeoutMs": remaining()})
        result["_lastInputObservation"] = focus_frame
        if focused["status"] != "passed":
            result["input"]["focusVerification"] = focused
            raise AgentError("INPUT_FOCUS_BLOCKED", "The input did not receive focus. Inspect the evidence for a keyboard setup page or blocking window.", dispatched="unknown")
        result["input"]["phase"] = "clearing"
        focused_node = resolve_target(focus_frame, selector)
        if focused_node.get("text") != "":
            self.transport.key(device, [2072, 2017], timeout_ms=remaining())
            # A key handler can move focus. Do not delete from a different control.
            selection_frame = self._capture(session, timeout_ms=remaining())
            result["_lastInputObservation"] = selection_frame
            selection_nodes = select_nodes(selection_frame, selector)
            if len(selection_nodes) != 1 or selection_nodes[0].get("focused") is not True:
                raise AgentError("INPUT_FOCUS_LOST", "The input lost focus after selection; no delete or insertion was sent.", dispatched="unknown")
            self.transport.key(device, 2055, timeout_ms=remaining())
            clear_frame, cleared = self._wait(session, {"selector": selector, "property": "text", "equals": "", "timeoutMs": remaining()})
            result["_lastInputObservation"] = clear_frame
            if cleared["status"] != "passed":
                result["input"]["clearVerification"] = cleared
                raise AgentError("INPUT_CLEAR_FAILED", "The previous value could not be cleared; no new text was inserted.", dispatched="unknown")
            if resolve_target(clear_frame, selector).get("focused") is not True:
                raise AgentError("INPUT_FOCUS_LOST", "The cleared input lost focus; no new text was inserted.", dispatched="unknown")
        else:
            result["input"]["alreadyEmpty"] = True
        result["input"]["phase"] = "inserting" if text else "verifying"
        if text:
            self.transport.shell(device, ["uitest", "uiInput", "text", text], timeout_ms=remaining(), mutating=True)
        result["input"]["phase"] = "verifying"
        return selector, remaining()

    def _action(self, name, session, command, params):
        started = time.monotonic()
        operation = uuid.uuid4().hex
        action = {"status": "not_dispatched", "dispatched": "no"}
        observation = None
        expectation = deepcopy(params.get("expect"))
        if isinstance(expectation, dict) and command != "fill" and "timeout_ms" in params:
            expectation.setdefault("timeoutMs", params["timeout_ms"])
        if expectation is not None:
            self._condition(expectation)
        initial_assertion = {"status": "unknown" if expectation is not None or command == "fill" else "not_requested"}
        if expectation:
            initial_assertion.update(property=expectation.get("property", "text"), expected=expectation.get("equals"))
        # Keep the warning list shared with error.details when optional trace
        # writing fails in finally, after the error envelope was assembled.
        result = {"operationId": operation, "action": action, "assertion": initial_assertion, "warnings": []}
        try:
            device = session["device"]
            node = None
            previous_capture = self._last_capture
            if command in {"press", "fill"}:
                node, observation = self._fresh_target(session, params.get("target"), refresh=params.get("_plan_refresh", False))
            if command == "fill":
                if not isinstance(params.get("text"), str) or "\x00" in params["text"]:
                    raise AgentError("INVALID_ARGUMENT", "fill requires a string text value without NUL characters.", exit_code=2)
                if "password" in (node.get("type") or "").lower():
                    raise AgentError("UNSUPPORTED", "Password field verification is not supported in this alpha.")
                if node.get("editable") is not True:
                    raise AgentError("NOT_EDITABLE", "fill requires a real editable text control.")
                # Native inputText appends. Explicitly clear and verify via a stable ID.
                if not node.get("id"):
                    raise AgentError("UNSUPPORTED", "Verified fill currently requires a stable control id.")
                fill_selector = {key: node[key] for key in ("id", "bundleName", "hostWindowId") if node.get(key)}
                if len(select_nodes(observation, fill_selector)) != 1:
                    raise AgentError("UNSUPPORTED", "Verified fill requires an id unique within its application window.")
            if command == "open" and (not isinstance(params.get("app"), str) or not params["app"]):
                raise AgentError("INVALID_ARGUMENT", "open requires an application bundle name.", exit_code=2)
            if command == "scroll":
                direction = params.get("direction", "down")
                if direction not in {"up", "down", "left", "right"}:
                    raise AgentError("INVALID_ARGUMENT", "Unsupported scroll direction.", exit_code=2)
                if params.get("target"):
                    node, observation = self._fresh_target(session, params["target"], refresh=params.get("_plan_refresh", False))
                    if node.get("scrollable") is not True:
                        raise AgentError("TARGET_NOT_SCROLLABLE", "Select a scrollable container.")
                else:
                    observation, _ = self._run_frame(session, refresh=params.get("_plan_refresh", False), purpose="target")
                    candidates = [n for n in observation["nodes"] if n.get("scrollable") is True and n.get("bounds") and n.get("visible") is not False]
                    if len(candidates) != 1:
                        raise AgentError("SCROLL_CONTAINER_REQUIRED", "Specify a scrollable container when zero or multiple containers are visible.", details={"count": len(candidates)})
                    node = candidates[0]
                    self._require_actionable(node, observation)
            if observation is None and params.get("_plan_refresh"):
                observation = self._capture(session)
            if params.get("_plan_before"):
                if observation is None:
                    observation, _ = self._run_frame(session, refresh=params.get("_plan_refresh", False), purpose="condition")
                result["beforeFrameId"] = observation["frameId"]
                self._counts["beforeConditionChecks"] = self._counts.get("beforeConditionChecks", 0) + len(params["_plan_before"])
                result["guardAssertions"] = [self._evaluate_frame(observation, condition)
                                             for condition in params["_plan_before"]]
                if any(item["status"] != "passed" for item in result["guardAssertions"]):
                    raise AgentError("PRECONDITION_NOT_MET", "A step's declared precondition did not pass; action was not dispatched.")
            # The state write must succeed before dispatch. Never restore these refs on failure.
            if observation is not None:
                result["beforeFrameId"] = observation["frameId"]
                if self._run_store is not None:
                    result["observationSource"] = "reused" if observation is previous_capture else "captured"
                    result["targetFrameAgeMs"] = round((time.perf_counter() - self._last_capture_time) * 1000, 3)
            self._interrupt()
            session["frameValid"] = False
            if self._run_store is None:
                self.store.save(name, session)
            dispatch_started = time.monotonic()
            action.update(status="unknown", dispatched="unknown")
            if command == "press":
                self.transport.tap(device, round(node["center"]["x"]), round(node["center"]["y"]))
            elif command == "fill":
                input_selector, input_remaining = self._replace_text(session, node, params["text"], params.get("timeout_ms", DEFAULT_INPUT_TIMEOUT_MS), result)
                observation = result.pop("_lastInputObservation", observation)
            elif command == "open":
                self.transport.open_app(device, params["app"], params.get("ability") or "EntryAbility")
                session["app"] = params["app"]
            elif command == "back":
                self.transport.key(device, "Back")
            elif command == "scroll":
                b = node["bounds"]
                x, y = node["center"]["x"], node["center"]["y"]
                if direction in {"up", "down"}:
                    low, high = b["top"] + (b["bottom"] - b["top"]) * .25, b["top"] + (b["bottom"] - b["top"]) * .75
                    coords = (x, high, x, low) if direction == "down" else (x, low, x, high)
                else:
                    low, high = b["left"] + (b["right"] - b["left"]) * .25, b["left"] + (b["right"] - b["left"]) * .75
                    coords = (high, y, low, y) if direction == "right" else (low, y, high, y)
                self.transport.swipe(device, *(round(v) for v in coords))
            action.update(status="completed", dispatched="acknowledged")
            result["timings"] = {"actionMs": round((time.monotonic() - dispatch_started) * 1000, 2)}
            if command == "fill":
                input_condition = {"selector": input_selector, "property": "text", "equals": params["text"], "timeoutMs": input_remaining}
                observation, input_assertion = self._wait(session, input_condition)
                result["inputVerification"] = input_assertion
                result["input"]["phase"] = "completed" if input_assertion["status"] == "passed" else "verification_failed"
                if input_assertion["status"] != "passed":
                    result["assertion"] = input_assertion
                    raise AgentError("INPUT_VERIFICATION_FAILED", "The text control did not contain the requested value.", dispatched="unknown")
            if expectation:
                # Fill just verified its value from this fresh post-input
                # frame. Check the business condition on it before polling.
                observation, assertion = self._wait(session, expectation, **(
                    {"initial_observation": observation} if command == "fill" else {}))
                result["assertion"] = assertion
                if assertion["status"] != "passed":
                    raise AgentError("ASSERTION_TIMEOUT", "The action was acknowledged, but the expected result was not observed.", dispatched="unknown")
            elif command != "fill":
                observation = self._capture(session)
            else:
                result["assertion"] = result["inputVerification"]
            self._publish(name, session, observation)
            result["afterFrameId"] = observation["frameId"]
            result.pop("_lastInputObservation", None)
            result["observation"] = self._project(observation, params)
            return result
        except (Exception, KeyboardInterrupt) as cause:
            if isinstance(cause, AgentError):
                exc = cause
            elif isinstance(cause, KeyboardInterrupt):
                exc = AgentError("CANCELLED", "Operation interrupted. Observe before deciding whether to retry.",
                                 dispatched="unknown" if action["dispatched"] != "no" else "no", exit_code=130)
            else:
                exc = AgentError("INTERNAL_ERROR", "Operation failed unexpectedly. Observe before deciding whether to retry.",
                                 details={"exception": type(cause).__name__},
                                 dispatched="unknown" if action["dispatched"] != "no" else "no")
            observation = result.pop("_lastInputObservation", observation)
            if action["status"] == "unknown" and exc.dispatched == "no" and not result.get("input", {}).get("sideEffectAcknowledged"):
                action.update(status="not_dispatched", dispatched="no")
            # A later read/verification failure must not erase an acknowledged action.
            exc.dispatched = "no" if action["dispatched"] == "no" else "unknown"
            if action["dispatched"] != "no":
                session["frameValid"] = False
                try:
                    self.store.save(name, session)
                except (Exception, KeyboardInterrupt) as state_error:
                    result.setdefault("warnings", []).append(
                        "Failed to persist invalidated refs: " + type(state_error).__name__)
            if observation is not None:
                result["observation"] = self._project(observation, params)
            if action["dispatched"] != "no":
                result["evidence"] = self._evidence(name, session, operation, observation)
            exc.details = {**exc.details, **result}
            raise exc from (None if exc is cause else cause)
        finally:
            result.setdefault("timings", {})["totalMs"] = round((time.monotonic() - started) * 1000, 2)
            if self._run_store is None:
                try:
                    self.store.trace(name, {"operationId": operation, "command": command, "at": now(),
                                           "action": deepcopy(action), "assertion": result["assertion"],
                                           "timings": result["timings"]})
                except (Exception, KeyboardInterrupt):
                    result.setdefault("warnings", []).append("Trace could not be written; this does not change the action outcome.")

    def _evidence(self, name, session, operation, observation):
        result = {"warnings": []}
        try:
            folder = self.store.artifacts(name, operation)
            if observation is not None:
                tree = folder / "observation.json"
                tree.write_text(json.dumps(observation, ensure_ascii=False), encoding="utf-8")
                result["observation"] = str(tree)
                result["observationCapturedAt"] = observation.get("capturedAt")
            screenshot = folder / "screen.png"
            self.transport.screenshot(session["device"], screenshot)
            result.update(screenshot=str(screenshot), screenshotCapturedAt=now())
        except (Exception, KeyboardInterrupt) as exc:
            result["warnings"].append("Evidence collection was incomplete: " + (exc.code if isinstance(exc, AgentError) else "IO_ERROR"))
        return result
