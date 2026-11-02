"""Small native execution loop: observe, act once, then verify."""
from __future__ import annotations

from copy import deepcopy
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import uuid

from . import SCHEMA_VERSION, __version__, DEFAULT_INPUT_TIMEOUT_MS
from .errors import AgentError
from .observation import (normalize_layout, project_observation, resolve_target,
                          select_nodes, diff_observations)
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

    @property
    def transport(self):
        if self._transport is None:
            from .transport import HdcTransport
            self._transport = HdcTransport(self.hdc_path)
        return self._transport

    def execute(self, command, params=None):
        params = dict(params or {})
        if "max_nodes" in params:
            positive_integer(params["max_nodes"], "max_nodes", 80, 5000)
        if "timeout_ms" in params:
            params["timeout_ms"] = positive_integer(params["timeout_ms"], "timeout_ms",
                                                     DEFAULT_INPUT_TIMEOUT_MS if command == "fill" else 5000)
        if command == "doctor":
            return self._doctor(params)
        if command == "devices":
            devices = self.transport.devices()
            return {"devices": [{"id": item} for item in devices], "count": len(devices),
                    "hint": None if devices else "Connect and authorize a device, then run devices again."}
        supported = {"attach", "detach", "open", "observe", "find", "press", "fill", "scroll", "back", "wait", "screenshot", "capabilities"}
        if command not in supported:
            raise AgentError("UNKNOWN_COMMAND", f"Unknown command: {command}", exit_code=2)
        name = session_name(params.get("session"))
        with self.store.lock(name):
            if command == "attach":
                return self._attach(name, params)
            if command == "detach":
                try:
                    session = self.store.load(name)
                except AgentError as exc:
                    if exc.code == "NO_SESSION":
                        return {"session": name, "detached": False}
                    raise
                with self.store.device_lock(session["device"]):
                    return {"session": name, "detached": self.store.detach(name), "deviceStopped": False}
            session = self.store.load(name)
            if params.get("device") and params["device"] != session["device"]:
                raise AgentError("DEVICE_MISMATCH", "This session is attached to a different device.")
            with self.store.device_lock(session["device"]), self._frame_guard(name, session):
                self._check_device(name, session)
                if command == "capabilities":
                    return self._capabilities(session)
                if command in {"observe", "find"}:
                    previous = session.get("frame")
                    observation = self._capture(session)
                    self._publish(name, session, observation)
                    public = self._project(observation, params, query=params.get("text") if command == "find" else None)
                    if previous:
                        public["diff"] = diff_observations(previous, observation)
                    return public
                if command == "wait":
                    condition = {"selector": params.get("target"), "property": params.get("property", "text"),
                                 "equals": params.get("equals"), "timeoutMs": params.get("timeout_ms", 5000)}
                    return self._wait_command(name, session, condition)
                if command == "screenshot":
                    op_id = uuid.uuid4().hex
                    destination = self.store.artifacts(name, op_id) / "screen.png"
                    self.transport.screenshot(session["device"], destination)
                    return {"path": str(destination), "capturedAt": now(), "device": session["device"]}
                return self._action(name, session, command, params)

    @contextmanager
    def _frame_guard(self, name, session):
        """A failed or interrupted read cannot keep earlier refs authorized."""
        try:
            yield
        except BaseException:
            session["frameValid"] = False
            try:
                self.store.save(name, session)
            except OSError:
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
            boot = self.transport.boot_id(device)
            session = {"schemaVersion": SCHEMA_VERSION, "name": name, "device": device,
                       "epoch": uuid.uuid4().hex, "bootId": boot, "app": None,
                       "createdAt": now(), "frame": None, "frameValid": False}
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
                "implemented": ["observe", "find", "press", "fill", "scroll", "back", "wait", "screenshot"],
                "experimental": ["native_text_input", "window_metadata"],
                "unsupported": ["model_planning", "visual_assertions", "event_watch", "automatic_recovery"],
                "bootIdentity": "available" if session.get("bootId") else "unknown",
                "note": "A command appearing in device help is not proof of semantic support on every control."}

    def _runtime_capabilities(self, device):
        return {key: value for key, value in self.transport.capabilities(device).items() if key != "help"}

    def _capture(self, session, *, timeout_ms=None):
        raw = self.transport.capture_layout(session["device"], **({"timeout_ms": timeout_ms} if timeout_ms is not None else {}))
        observation = normalize_layout(raw, uuid.uuid4().hex)
        observation.update(capturedAt=now(), sessionEpoch=session["epoch"], device=session["device"])
        return observation

    def _publish(self, name, session, observation):
        session["frame"] = observation
        session["frameValid"] = True
        self.store.save(name, session)

    def _project(self, observation, params=None, *, query=None):
        params = params or {}
        maximum = positive_integer(params.get("max_nodes"), "max_nodes", 80, 5000)
        return project_observation(observation, max_nodes=maximum, interactive=params.get("interactive", False), query=query)

    def _fresh_target(self, session, target):
        if target is None:
            raise AgentError("TARGET_REQUIRED", "An explicit selector or current ref is required.", exit_code=2)
        old = None
        is_ref = isinstance(target, str) and target.startswith("@") or isinstance(target, dict) and "ref" in target
        if is_ref:
            if not session.get("frameValid") or not session.get("frame"):
                raise AgentError("STALE_REF", "Refs are invalid after an action, timeout or disconnect; observe again.")
            old = resolve_target(session["frame"], target)
        observation = self._capture(session)
        if old is None:
            node = resolve_target(observation, target)
        else:
            keys = ("id", "type", "text", "bounds", "bundleName", "hostWindowId", "displayId")
            candidates = [n for n in observation["nodes"] if all(n.get(k) == old.get(k) for k in keys)]
            old_context = self._context_signature(session["frame"], old)
            candidates = [n for n in candidates if self._context_signature(observation, n) == old_context]
            if len(candidates) != 1:
                raise AgentError("STALE_REF", "The target changed since the referenced frame; observe and select again.")
            node = candidates[0]
        if node.get("visible") is False or node.get("enabled") is False:
            raise AgentError("TARGET_NOT_ACTIONABLE", "The target is hidden or disabled.")
        if not node.get("center") or not node.get("bounds"):
            raise AgentError("TARGET_NOT_ACTIONABLE", "The target has no usable bounds.")
        b = node["bounds"]
        if b["right"] <= b["left"] or b["bottom"] <= b["top"]:
            raise AgentError("TARGET_NOT_ACTIONABLE", "The target has empty bounds.")
        return node, observation

    @staticmethod
    def _context_signature(observation, node):
        by_ref = {item["ref"]: item for item in observation["nodes"]}
        signature = []
        child = node
        seen = set()
        while child.get("parent") in by_ref and child["parent"] not in seen:
            parent = by_ref[child["parent"]]
            seen.add(parent["ref"])
            siblings = [(n.get("id"), n.get("type"), n.get("text")) for n in observation["nodes"]
                        if n.get("parent") == parent["ref"] and n["ref"] != child["ref"]]
            signature.append(((parent.get("id"), parent.get("type"), parent.get("text"),
                               parent.get("bundleName"), parent.get("hostWindowId")), siblings))
            child = parent
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
        if isinstance(selector, str) and selector.startswith("@") or isinstance(selector, dict) and "ref" in selector:
            raise AgentError("INVALID_EXPECTATION", "Postconditions require a stable selector, not a frame ref.", exit_code=2)
        # Validate selector syntax before any mutation, even when no matching node exists.
        select_nodes({"nodes": [], "frameId": "validation"}, selector)
        timeout = positive_integer(condition.get("timeoutMs"), "timeoutMs", 5000)
        return selector, prop, expected, timeout

    def _wait(self, session, condition):
        selector, prop, expected, timeout = self._condition(condition)
        deadline = time.monotonic() + timeout / 1000
        attempts = 0
        observation = None
        actual = None
        complete = False
        while True:
            remaining = max(1, round((deadline - time.monotonic()) * 1000))
            try:
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

    def _wait_command(self, name, session, condition):
        self._condition(condition)
        operation = uuid.uuid4().hex
        started = time.monotonic()
        observation, assertion = self._wait(session, condition)
        self._publish(name, session, observation)
        result = {"operationId": operation, "assertion": assertion, "observation": self._project(observation),
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
        result = {"operationId": operation, "action": action, "assertion": initial_assertion}
        try:
            device = session["device"]
            node = None
            if command in {"press", "fill"}:
                node, observation = self._fresh_target(session, params.get("target"))
            if command == "fill":
                if not isinstance(params.get("text"), str) or "\x00" in params["text"]:
                    raise AgentError("INVALID_ARGUMENT", "fill requires a string text value without NUL characters.", exit_code=2)
                if "password" in (node.get("type") or "").lower():
                    raise AgentError("UNSUPPORTED", "Password field verification is not supported in this alpha.")
                if node.get("editable") is not True and not any(t in (node.get("type") or "").lower() for t in ("textinput", "textarea", "edittext")):
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
                    node, observation = self._fresh_target(session, params["target"])
                    if node.get("scrollable") is not True:
                        raise AgentError("TARGET_NOT_SCROLLABLE", "Select a scrollable container.")
                else:
                    observation = self._capture(session)
                    candidates = [n for n in observation["nodes"] if n.get("scrollable") is True and n.get("bounds") and n.get("visible") is not False]
                    if len(candidates) != 1:
                        raise AgentError("SCROLL_CONTAINER_REQUIRED", "Specify a scrollable container when zero or multiple containers are visible.", details={"count": len(candidates)})
                    node = candidates[0]
            # The state write must succeed before dispatch. Never restore these refs on failure.
            session["frameValid"] = False
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
                observation, assertion = self._wait(session, expectation)
                result["assertion"] = assertion
                if assertion["status"] != "passed":
                    raise AgentError("ASSERTION_TIMEOUT", "The action was acknowledged, but the expected result was not observed.", dispatched="unknown")
            elif command != "fill":
                observation = self._capture(session)
            else:
                result["assertion"] = result["inputVerification"]
            self._publish(name, session, observation)
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
                self.store.save(name, session)
            if observation is not None:
                result["observation"] = self._project(observation)
            if action["dispatched"] != "no":
                result["evidence"] = self._evidence(name, session, operation, observation)
            exc.details = {**exc.details, **result}
            raise exc from (None if exc is cause else cause)
        finally:
            result.setdefault("timings", {})["totalMs"] = round((time.monotonic() - started) * 1000, 2)
            try:
                self.store.trace(name, {"operationId": operation, "command": command, "at": now(),
                                       "action": deepcopy(action), "assertion": result["assertion"],
                                       "timings": result["timings"]})
            except OSError:
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
        except (AgentError, OSError) as exc:
            result["warnings"].append("Evidence collection was incomplete: " + (exc.code if isinstance(exc, AgentError) else "IO_ERROR"))
        return result
