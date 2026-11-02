"""Fault-injected execution tests; no device, shell or model is used."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from harmony_agent.core import Agent
from harmony_agent.errors import AgentError
from harmony_agent.observation import resolve_target


class FakeNativeTransport:
    """Native UI tree whose state changes independently from command replies."""

    def __init__(self):
        self.serial = "fake-" + uuid.uuid4().hex
        self.connected = [self.serial, self.serial + "-other"]
        self.boot = "11111111-1111-1111-1111-111111111111"
        self.counter = 0
        self.input_text = "before"
        self.input_focused = False
        self.input_selected = False
        self.focus_blocked = False
        self.ignore_clear = False
        self.move_focus_after_clear = False
        self.move_focus_after_select_all = False
        self.other_input_focused = False
        self.other_input_text = "other value"
        self.counter_bounds = "[20,200][400,250]"
        self.button_bounds = "[20,100][220,180]"
        self.duplicate_buttons = False
        self.row_label = None
        self.toggle_checked = None
        self.mutations = []
        self.command_timeouts = []
        self.captures = 0
        self.capture_devices = []
        self.tap_error = None
        self.capture_error_after_mutation = None
        self.screenshot_error = None
        self.ignore_fill = False
        self.key_error = None
        self.shell_error = None
        self.before_mutation = None

    def version(self):
        return "test-hdc"

    def devices(self):
        return list(self.connected)

    def boot_id(self, device):
        return self.boot

    def capabilities(self, device):
        return {"uitestVersion": "test", "apiVersion": "24"}

    @staticmethod
    def node(identifier, kind, text, bounds, **attributes):
        values = {"key": identifier, "id": "", "type": kind, "text": text,
                  "bounds": bounds, "visible": "true", "enabled": "true", **attributes}
        return {"attributes": values, "children": []}

    def capture_layout(self, device, **kwargs):
        self.captures += 1
        self.capture_devices.append(device)
        if self.mutations and self.capture_error_after_mutation:
            raise self.capture_error_after_mutation
        button = self.node("fixture.increment", "Button", "Increment", self.button_bounds,
                           clickable="true")
        counter = self.node("fixture.counter", "Text", f"Counter: {self.counter}",
                            self.counter_bounds, clickable="false")
        text_input = self.node("fixture.input", "TextInput", self.input_text,
                               "[20,300][420,380]", focused="true" if self.input_focused else "false",
                               hint="请输入中文")
        toggle = self.node("fixture.toggle", "Toggle", "Toggle", "[20,420][220,500]",
                            checkable="true", clickable="true")
        if self.toggle_checked is not None:
            toggle["attributes"]["checked"] = "true" if self.toggle_checked else "false"
        children = [button, counter, text_input, toggle]
        if self.move_focus_after_clear or self.move_focus_after_select_all:
            children.append(self.node("fixture.otherinput", "TextInput", self.other_input_text,
                                      "[500,300][900,380]",
                                      focused="true" if self.other_input_focused else "false"))
        if self.row_label is not None:
            # A virtualized list can reuse the same row and button identifiers
            # and geometry while replacing the business item beside the button.
            row = self.node("fixture.row", "Row", "", "[0,80][800,190]")
            row["children"] = [self.node("fixture.row.label", "Text", self.row_label,
                                        "[230,100][700,180]"), button]
            children[0] = row
        if self.duplicate_buttons:
            children.append(self.node("fixture.other", "Button", "Increment",
                                       "[400,100][600,180]", clickable="true"))
        return {"attributes": {"key": "root", "type": "Column", "text": "",
                                "bounds": "[0,0][1000,1000]", "bundleName": "org.example.fixture",
                                "hostWindowId": "21", "displayId": "0"}, "children": children}

    def tap(self, device, x, y, *, timeout_ms=None):
        self.command_timeouts.append(("tap", timeout_ms))
        if self.before_mutation:
            self.before_mutation()
        self.mutations.append(("tap", device, x, y))
        if 20 <= x <= 420 and 300 <= y <= 380:
            self.input_focused = not self.focus_blocked
            self.input_selected = False
            self.other_input_focused = False
        else:
            self.input_focused = False
            self.counter += 1
        if self.tap_error:
            raise self.tap_error

    def shell(self, device, arguments, **kwargs):
        self.command_timeouts.append(("text", kwargs.get("timeout_ms")))
        if arguments[:3] != ["uitest", "uiInput", "text"] or len(arguments) != 4:
            raise AssertionError(f"Unexpected shell command: {arguments!r}")
        if not kwargs.get("mutating"):
            raise AssertionError("Text insertion must be marked mutating")
        if self.shell_error:
            raise self.shell_error
        if self.before_mutation:
            self.before_mutation()
        text = arguments[3]
        self.mutations.append(("text", device, text))
        if self.input_focused and not self.ignore_fill:
            # Native uiInput text pastes into the focused input. Without an
            # explicit clear step this preserves the previous value.
            self.input_text = ("" if self.input_selected else self.input_text) + text
            self.input_selected = False
        elif self.other_input_focused and not self.ignore_fill:
            self.other_input_text += text

    def open_app(self, device, app, ability):
        if self.before_mutation:
            self.before_mutation()
        self.mutations.append(("open", device, app, ability))

    def key(self, device, key, *, timeout_ms=None):
        self.command_timeouts.append(("key", timeout_ms))
        if self.key_error and key == self.key_error[0]:
            raise self.key_error[1]
        if self.before_mutation:
            self.before_mutation()
        self.mutations.append(("key", device, key))
        if self.input_focused:
            if key == [2072, 2017]:
                self.input_selected = True
                if self.move_focus_after_select_all:
                    self.input_focused = False
                    self.other_input_focused = True
            elif key == 2055 and not self.ignore_clear:
                self.input_text = "" if self.input_selected else self.input_text[:-1]
                self.input_selected = False
                if self.move_focus_after_clear:
                    self.input_focused = False
                    self.other_input_focused = True
        elif self.other_input_focused and key == 2055:
            # DEL is delivered to whichever field actually owns focus.
            self.other_input_text = self.other_input_text[:-1]

    def swipe(self, device, *coordinates):
        if self.before_mutation:
            self.before_mutation()
        self.mutations.append(("swipe", device, coordinates))

    def screenshot(self, device, destination):
        if self.screenshot_error:
            raise self.screenshot_error
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic-test-evidence")
        return destination


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.transport = FakeNativeTransport()
        self.agent = Agent(state_dir=self.folder.name, transport=self.transport)
        self.session = "case"
        self.agent.execute("attach", {"session": self.session, "device": self.transport.serial})

    def execute(self, command, **params):
        return self.agent.execute(command, {"session": self.session, **params})

    def assert_error(self, code, operation):
        with self.assertRaises(AgentError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def current_ref(self, target="id=fixture.increment"):
        return resolve_target(self.execute("observe"), target)["ref"]

    def test_attach_requires_exact_device_even_when_devices_exist(self):
        self.assert_error("DEVICE_REQUIRED", lambda: self.agent.execute("attach", {"session": "missing"}))
        second = self.transport.connected[1]
        result = self.agent.execute("attach", {"session": "second", "device": second})
        self.assertEqual(result["device"], second)
        self.agent.execute("observe", {"session": "second"})
        self.assertEqual(self.transport.capture_devices[-1], second)
        self.assertEqual(self.transport.mutations, [])

    def test_unknown_device_never_falls_back_to_first(self):
        self.assert_error("DEVICE_NOT_FOUND", lambda: self.agent.execute("attach", {"session": "bad", "device": "absent"}))
        self.assertFalse(self.agent.store.path("bad").exists())
        self.assertEqual(self.transport.mutations, [])

    def test_session_device_override_must_match(self):
        self.assert_error("DEVICE_MISMATCH", lambda: self.execute("press", target="id=fixture.increment", device=self.transport.connected[1]))
        self.assertEqual(self.transport.mutations, [])

    def test_ambiguous_label_does_not_tap_any_candidate(self):
        self.transport.duplicate_buttons = True
        error = self.assert_error("TARGET_AMBIGUOUS", lambda: self.execute("press", target="text=Increment"))
        self.assertEqual(error.dispatched, "no")
        self.assertEqual(self.transport.mutations, [])

    def test_ref_is_invalidated_on_disk_before_dispatch(self):
        old_ref = self.current_ref()
        state_during_dispatch = []
        self.transport.before_mutation = lambda: state_during_dispatch.append(self.agent.store.load(self.session)["frameValid"])
        result = self.execute("press", target=old_ref)
        self.assertEqual(state_during_dispatch, [False])
        self.assertEqual(result["action"]["status"], "completed")
        self.assertEqual(len(self.transport.mutations), 1)
        self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
        self.assertEqual(len(self.transport.mutations), 1)

    def test_moved_ref_requires_new_observation(self):
        old_ref = self.current_ref()
        self.transport.button_bounds = "[300,100][500,180]"
        self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
        self.assertEqual(self.transport.mutations, [])

    def test_recycled_row_context_rejects_identical_button_ref(self):
        self.transport.row_label = "Order A"
        old_ref = self.current_ref()
        before = resolve_target(self.agent.store.load(self.session)["frame"], old_ref)
        self.transport.row_label = "Order B"
        fresh = self.agent._capture(self.agent.store.load(self.session))
        after = resolve_target(fresh, "id=fixture.increment")
        for field in ("id", "type", "text", "bounds"):
            self.assertEqual(before[field], after[field], field)
        self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
        self.assertEqual(self.transport.mutations, [])

    def test_timeout_after_effect_is_unknown_and_never_retried(self):
        old_ref = self.current_ref()
        self.transport.tap_error = AgentError("HDC_TIMEOUT", "Response lost after tap", dispatched="unknown")
        error = self.assert_error("HDC_TIMEOUT", lambda: self.execute("press", target=old_ref))
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(len(self.transport.mutations), 1)
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["action"], {"status": "unknown", "dispatched": "unknown"})
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])
        self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
        self.assertEqual(len(self.transport.mutations), 1)

    def test_read_timeout_invalidates_previous_ref_before_any_action(self):
        commands = [("observe", {}), ("find", {"text": "Counter"}),
                    ("wait", {"target": "id=fixture.counter", "equals": "Counter: 0", "timeout_ms": 50}),
                    ("press", {})]
        for command, params in commands:
            with self.subTest(command=command):
                old_ref = self.current_ref()
                if command == "press":
                    params = {"target": old_ref}
                failure = AgentError("HDC_TIMEOUT", "UI refresh did not complete")
                with patch.object(self.transport, "capture_layout", side_effect=failure):
                    error = self.assert_error("HDC_TIMEOUT", lambda: self.execute(command, **params))
                self.assertEqual(error.dispatched, "no")
                self.assertFalse(self.agent.store.load(self.session)["frameValid"])
                self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
                self.assertEqual(self.transport.mutations, [])

    def test_read_cancellation_invalidates_previous_ref_before_any_action(self):
        commands = [("observe", {}), ("find", {"text": "Counter"}),
                    ("wait", {"target": "id=fixture.counter", "equals": "Counter: 0", "timeout_ms": 50}),
                    ("press", {})]
        for command, params in commands:
            with self.subTest(command=command):
                old_ref = self.current_ref()
                if command == "press":
                    params = {"target": old_ref}
                with patch.object(self.transport, "capture_layout", side_effect=KeyboardInterrupt), \
                        self.assertRaises((KeyboardInterrupt, AgentError)) as raised:
                    self.execute(command, **params)
                if isinstance(raised.exception, AgentError):
                    self.assertEqual(raised.exception.code, "CANCELLED")
                self.assertFalse(self.agent.store.load(self.session)["frameValid"])
                self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
                self.assertEqual(self.transport.mutations, [])

    def test_device_check_failure_invalidates_previous_ref(self):
        for method in ("devices", "boot_id"):
            for failure in (AgentError("HDC_TIMEOUT", "Device probe timed out"), KeyboardInterrupt()):
                with self.subTest(method=method, failure=type(failure).__name__):
                    old_ref = self.current_ref()
                    with patch.object(self.transport, method, side_effect=failure), \
                            self.assertRaises((KeyboardInterrupt, AgentError)) as raised:
                        self.execute("observe")
                    if isinstance(raised.exception, AgentError):
                        self.assertEqual(raised.exception.code,
                                         "HDC_TIMEOUT" if isinstance(failure, AgentError) else "CANCELLED")
                    self.assertFalse(self.agent.store.load(self.session)["frameValid"])
                    self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
                    self.assertEqual(self.transport.mutations, [])
    def test_acknowledged_tap_with_failed_expectation_stays_acknowledged(self):
        error = self.assert_error("ASSERTION_TIMEOUT", lambda: self.execute("press", target="id=fixture.increment", expect={
            "selector": "id=fixture.counter", "property": "text", "equals": "Counter: 99", "timeoutMs": 1}))
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(len(self.transport.mutations), 1)
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["action"], {"status": "completed", "dispatched": "acknowledged"})
        self.assertIn(error.details["assertion"]["status"], ("failed", "unknown"))
        self.assertEqual(error.details["assertion"]["actual"], "Counter: 1")
        self.assertTrue(Path(error.details["evidence"]["screenshot"]).is_file())

    def test_read_failure_after_acknowledged_tap_does_not_become_not_dispatched(self):
        self.transport.capture_error_after_mutation = AgentError("LAYOUT_INVALID", "Broken post-action read", dispatched="no")
        error = self.assert_error("LAYOUT_INVALID", lambda: self.execute("press", target="id=fixture.increment"))
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["action"]["status"], "completed")
        self.assertEqual(error.details["action"]["dispatched"], "acknowledged")
        self.assertEqual(len(self.transport.mutations), 1)

    def test_cancelled_tap_keeps_partial_effect_and_invalidates_refs(self):
        old_ref = self.current_ref()
        self.transport.tap_error = KeyboardInterrupt()
        error = self.assert_error("CANCELLED", lambda: self.execute("press", target=old_ref))
        self.assertEqual(error.exit_code, 130)
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["action"], {"status": "unknown", "dispatched": "unknown"})
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(len(self.transport.mutations), 1)
        self.assertTrue(Path(error.details["evidence"]["screenshot"]).is_file())
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])
        self.transport.tap_error = None
        self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
        self.assertEqual(self.transport.counter, 1)

    def test_cancelled_verification_preserves_acknowledged_action(self):
        self.transport.capture_error_after_mutation = KeyboardInterrupt()
        error = self.assert_error("CANCELLED", lambda: self.execute("press", target="id=fixture.increment", expect={
            "selector": "id=fixture.counter", "equals": "Counter: 1", "timeoutMs": 50}))
        self.assertEqual(error.exit_code, 130)
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["action"], {"status": "completed", "dispatched": "acknowledged"})
        self.assertEqual(error.details["assertion"]["status"], "unknown")
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(len(self.transport.mutations), 1)
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])
        self.assertTrue(Path(error.details["evidence"]["screenshot"]).is_file())

    def test_unexpected_verification_failure_preserves_acknowledged_action(self):
        self.transport.capture_error_after_mutation = ValueError("Synthetic decoder failure")
        error = self.assert_error("INTERNAL_ERROR", lambda: self.execute("press", target="id=fixture.increment", expect={
            "selector": "id=fixture.counter", "equals": "Counter: 1", "timeoutMs": 50}))
        self.assertEqual(error.details["exception"], "ValueError")
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["action"], {"status": "completed", "dispatched": "acknowledged"})
        self.assertEqual(error.details["assertion"]["status"], "unknown")
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(len(self.transport.mutations), 1)
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])

    def test_post_action_capture_timeout_reports_unknown_assertion(self):
        self.transport.capture_error_after_mutation = AgentError("HDC_TIMEOUT", "Post-action observation timed out", dispatched="no")
        error = self.assert_error("HDC_TIMEOUT", lambda: self.execute("press", target="id=fixture.increment", expect={
            "selector": "id=fixture.counter", "property": "text", "equals": "Counter: 1", "timeoutMs": 10}))
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(error.details["action"]["dispatched"], "acknowledged")
        self.assertEqual(error.details["assertion"]["status"], "unknown")
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(len(self.transport.mutations), 1)

    def test_invalid_expectation_is_rejected_before_tap(self):
        bad_expectations = [
            {"selector": "id=fixture.counter", "property": "checked", "equals": "false"},
            {"selector": "id=fixture.counter", "equals": "Counter: 1", "timeoutMs": True},
            {"selector": {"typo": "fixture.counter"}, "equals": "Counter: 1"},
            {"selector": "@e1~old", "equals": "Counter: 1"},
        ]
        for expect in bad_expectations:
            with self.subTest(expect=expect), self.assertRaises(AgentError) as raised:
                self.execute("press", target="id=fixture.increment", expect=expect)
            self.assertEqual(raised.exception.dispatched, "no")
            self.assertEqual(self.transport.mutations, [])

    def test_unknown_boolean_is_not_a_false_assertion(self):
        error = self.assert_error("ASSERTION_TIMEOUT", lambda: self.execute("wait", target="id=fixture.toggle", property="checked", equals=False, timeout_ms=1))
        self.assertIsNone(error.details["assertion"]["actual"])
        self.assertEqual(error.details["assertion"]["status"], "unknown")
        self.assertEqual(self.transport.mutations, [])
        self.transport.toggle_checked = False
        passed = self.execute("wait", target="id=fixture.toggle", property="checked", equals=False, timeout_ms=1)
        self.assertEqual(passed["assertion"]["status"], "passed")

    def test_missing_element_in_incomplete_observation_does_not_prove_invisibility(self):
        observation = self.agent._capture(self.agent.store.load(self.session))
        observation["quality"]["complete"] = False
        observation["quality"]["warnings"].append("Synthetic partial window tree")
        with patch.object(self.agent, "_capture", return_value=observation):
            error = self.assert_error("ASSERTION_TIMEOUT", lambda: self.execute("wait", target="id=not-in-this-tree", property="visible", equals=False, timeout_ms=1))
        self.assertIsNone(error.details["assertion"]["actual"])
        self.assertEqual(error.details["assertion"]["status"], "unknown")
        self.assertEqual(self.transport.mutations, [])

    def test_missing_element_in_complete_observation_can_prove_invisibility(self):
        result = self.execute("wait", target="id=not-in-this-tree", property="visible", equals=False, timeout_ms=1)
        self.assertEqual(result["assertion"]["status"], "passed")
        self.assertIs(result["assertion"]["actual"], False)
        self.assertEqual(self.transport.mutations, [])

    def test_matching_observation_completed_after_deadline_does_not_pass(self):
        observation = self.agent._capture(self.agent.store.load(self.session))
        clock = [100.0]

        def slow_capture(session, **kwargs):
            clock[0] += 0.020  # A matching response arrives after a 10 ms budget.
            return observation

        with patch("harmony_agent.core.time.monotonic", side_effect=lambda: clock[0]), \
                patch.object(self.agent, "_capture", side_effect=slow_capture):
            error = self.assert_error("ASSERTION_TIMEOUT", lambda: self.execute("wait", target="id=fixture.counter", property="text", equals="Counter: 0", timeout_ms=10))
        self.assertEqual(error.details["assertion"]["actual"], "Counter: 0")
        self.assertEqual(error.details["assertion"]["status"], "unknown")
        self.assertEqual(error.details["assertion"]["reason"], "observation_completed_after_deadline")
        self.assertEqual(self.transport.mutations, [])

    def test_unicode_replace_and_empty_clear_are_read_back(self):
        for text in ("你好 abc 42 🙂", ""):
            with self.subTest(text=text):
                previous_captures = self.transport.captures
                previous_mutations = len(self.transport.mutations)
                result = self.execute("fill", target="id=fixture.input", text=text, timeout_ms=1000)
                self.assertEqual(result["inputVerification"]["status"], "passed")
                self.assertEqual(result["inputVerification"]["actual"], text)
                self.assertEqual(self.transport.input_text, text)
                self.assertGreaterEqual(self.transport.captures - previous_captures, 4)
                sequence = [("tap", self.transport.serial, 220, 340),
                            ("key", self.transport.serial, [2072, 2017]),
                            ("key", self.transport.serial, 2055)]
                if text:
                    sequence.append(("text", self.transport.serial, text))
                self.assertEqual(self.transport.mutations[previous_mutations:], sequence)
                self.assertEqual(result["input"]["phase"], "completed")
                self.assertNotIn("_lastInputObservation", json.dumps(result))
        for command, budget in self.transport.command_timeouts:
            with self.subTest(command=command, budget=budget):
                self.assertIs(type(budget), int)
                self.assertGreater(budget, 0)
                self.assertLessEqual(budget, 1000)

    def test_direct_api_default_fill_allows_preparation_longer_than_five_seconds(self):
        clock = [100.0]
        self.transport.input_text = ""
        native_tap = self.transport.tap

        def slow_tap(*args, **kwargs):
            native_tap(*args, **kwargs)
            clock[0] += 6.0

        with patch("harmony_agent.core.time.monotonic", side_effect=lambda: clock[0]), \
                patch.object(self.transport, "tap", side_effect=slow_tap):
            result = self.execute("fill", target="id=fixture.input", text="replacement")
        self.assertEqual(result["inputVerification"]["status"], "passed")
        self.assertEqual(self.transport.input_text, "replacement")
        self.assertEqual(self.transport.command_timeouts[0], ("tap", 15000))
        self.assertEqual(self.transport.command_timeouts[-1], ("text", 9000))

    def test_direct_api_explicit_short_fill_budget_is_not_extended(self):
        clock = [100.0]
        native_tap = self.transport.tap

        def slow_tap(*args, **kwargs):
            native_tap(*args, **kwargs)
            clock[0] += 2.0

        with patch("harmony_agent.core.time.monotonic", side_effect=lambda: clock[0]), \
                patch.object(self.transport, "tap", side_effect=slow_tap):
            error = self.assert_error("INPUT_TIMEOUT", lambda: self.execute(
                "fill", target="id=fixture.input", text="replacement", timeout_ms=1000))
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(self.transport.command_timeouts, [("tap", 1000)])
        self.assertEqual([item[0] for item in self.transport.mutations], ["tap"])
        self.assertEqual(self.transport.input_text, "before")

    def test_action_expectation_budget_uses_top_level_only_when_not_explicit(self):
        cases = [({}, 1234), ({"timeoutMs": 4321}, 4321)]
        for nested, expected_budget in cases:
            with self.subTest(nested=nested):
                self.transport.counter = 0
                expectation = {"selector": "id=fixture.counter", "equals": "Counter: 1", **nested}
                original = deepcopy(expectation)
                with patch.object(self.agent, "_wait", wraps=self.agent._wait) as wait:
                    result = self.execute("press", target="id=fixture.increment",
                                          timeout_ms=1234, expect=expectation)
                self.assertEqual(result["assertion"]["status"], "passed")
                self.assertEqual(wait.call_args.args[1]["timeoutMs"], expected_budget)
                self.assertEqual(expectation, original)

    def test_fill_budget_does_not_replace_independent_expectation_budget(self):
        for nested, expected_budget in (({}, 5000), ({"timeoutMs": 4321}, 4321)):
            with self.subTest(nested=nested):
                expectation = {"selector": "id=fixture.input", "equals": "replacement", **nested}
                original = deepcopy(expectation)
                with patch.object(self.agent, "_wait", wraps=self.agent._wait) as wait:
                    result = self.execute("fill", target="id=fixture.input", text="replacement",
                                          timeout_ms=1234, expect=expectation)
                final_condition = wait.call_args.args[1]
                self.assertEqual(self.agent._condition(final_condition)[3], expected_budget)
                self.assertEqual(result["assertion"]["status"], "passed")
                self.assertEqual(expectation, original)

    def test_input_ack_without_actual_change_fails_verification(self):
        self.transport.ignore_fill = True
        error = self.assert_error("INPUT_VERIFICATION_FAILED", lambda: self.execute("fill", target="id=fixture.input", text="新值", timeout_ms=50))
        self.assertEqual(error.details["action"]["dispatched"], "acknowledged")
        self.assertEqual(error.details["inputVerification"]["actual"], "")
        self.assertEqual(len(self.transport.mutations), 4)
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])

    def test_fill_blocked_focus_does_not_clear_or_insert(self):
        self.transport.focus_blocked = True
        error = self.assert_error("INPUT_FOCUS_BLOCKED", lambda: self.execute(
            "fill", target="id=fixture.input", text="replacement", timeout_ms=50))
        self.assertEqual(self.transport.input_text, "before")
        self.assertEqual(self.transport.mutations, [("tap", self.transport.serial, 220, 340)])
        self.assertEqual(error.details["input"]["phase"], "focusing")
        self.assertIs(error.details["input"]["focusVerification"]["actual"], False)
        self.assertEqual(error.dispatched, "unknown")

    def test_fill_clear_failure_does_not_append_replacement(self):
        self.transport.ignore_clear = True
        initial = self.execute("observe")
        error = self.assert_error("INPUT_CLEAR_FAILED", lambda: self.execute(
            "fill", target="id=fixture.input", text="replacement", timeout_ms=50))
        self.assertEqual(self.transport.input_text, "before")
        self.assertEqual([entry[0] for entry in self.transport.mutations], ["tap", "key", "key"])
        self.assertEqual(error.details["input"]["phase"], "clearing")
        self.assertEqual(error.details["input"]["clearVerification"]["actual"], "before")
        self.assertEqual(error.dispatched, "unknown")
        self.assertNotIn("_lastInputObservation", json.dumps(error.details))
        evidence = json.loads(Path(error.details["evidence"]["observation"]).read_text(encoding="utf-8"))
        self.assertNotEqual(evidence["frameId"], initial["frameId"])
        self.assertEqual(evidence["frameId"], error.details["observation"]["frameId"])
        self.assertIs(resolve_target(evidence, "id=fixture.input")["focused"], True)
        self.assertIs(resolve_target(initial, "id=fixture.input")["focused"], False)

    def test_empty_fill_clears_existing_text_without_pasting_empty_string(self):
        self.transport.input_text = "existing value"
        result = self.execute("fill", target="id=fixture.input", text="", timeout_ms=1000)
        self.assertEqual(self.transport.input_text, "")
        self.assertEqual(self.transport.mutations, [
            ("tap", self.transport.serial, 220, 340),
            ("key", self.transport.serial, [2072, 2017]),
            ("key", self.transport.serial, 2055),
        ])
        self.assertEqual(result["inputVerification"]["actual"], "")
        self.assertEqual(result["inputVerification"]["status"], "passed")

    def test_fill_focus_moved_by_clear_does_not_insert_into_other_input(self):
        self.transport.move_focus_after_clear = True
        error = self.assert_error("INPUT_FOCUS_LOST", lambda: self.execute(
            "fill", target="id=fixture.input", text="replacement", timeout_ms=1000))
        self.assertEqual(self.transport.input_text, "")
        self.assertIs(self.transport.input_focused, False)
        self.assertIs(self.transport.other_input_focused, True)
        self.assertEqual(self.transport.other_input_text, "other value")
        self.assertEqual(self.transport.mutations, [
            ("tap", self.transport.serial, 220, 340),
            ("key", self.transport.serial, [2072, 2017]),
            ("key", self.transport.serial, 2055),
        ])
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["input"]["phase"], "clearing")
        self.assertEqual(error.details["action"]["dispatched"], "unknown")
        evidence = json.loads(Path(error.details["evidence"]["observation"]).read_text(encoding="utf-8"))
        self.assertIs(resolve_target(evidence, "id=fixture.input")["focused"], False)
        self.assertIs(resolve_target(evidence, "id=fixture.otherinput")["focused"], True)
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])

    def test_fill_focus_moved_by_select_all_does_not_delete_other_input(self):
        self.transport.move_focus_after_select_all = True
        error = self.assert_error("INPUT_FOCUS_LOST", lambda: self.execute(
            "fill", target="id=fixture.input", text="replacement", timeout_ms=1000))
        self.assertEqual(self.transport.input_text, "before")
        self.assertIs(self.transport.input_focused, False)
        self.assertIs(self.transport.other_input_focused, True)
        self.assertEqual(self.transport.other_input_text, "other value")
        self.assertEqual(self.transport.mutations, [
            ("tap", self.transport.serial, 220, 340),
            ("key", self.transport.serial, [2072, 2017]),
        ])
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["action"]["dispatched"], "unknown")
        evidence = json.loads(Path(error.details["evidence"]["observation"]).read_text(encoding="utf-8"))
        self.assertIs(resolve_target(evidence, "id=fixture.input")["focused"], False)
        self.assertEqual(resolve_target(evidence, "id=fixture.otherinput")["text"], "other value")
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])

    def test_fill_budget_exhausted_after_select_all_does_not_dispatch_delete(self):
        clock = [100.0]
        native_key = self.transport.key

        def delayed_select_all(device, key, **kwargs):
            native_key(device, key, **kwargs)
            if key == [2072, 2017]:
                clock[0] += 1.1

        with patch("harmony_agent.core.time.monotonic", side_effect=lambda: clock[0]), \
                patch.object(self.transport, "key", side_effect=delayed_select_all):
            error = self.assert_error("INPUT_TIMEOUT", lambda: self.execute(
                "fill", target="id=fixture.input", text="replacement", timeout_ms=1000))
        self.assertEqual(self.transport.mutations, [
            ("tap", self.transport.serial, 220, 340),
            ("key", self.transport.serial, [2072, 2017]),
        ])
        self.assertEqual(self.transport.input_text, "before")
        self.assertIs(self.transport.input_selected, True)
        self.assertEqual(error.dispatched, "unknown")
        self.assertEqual(error.details["action"]["dispatched"], "unknown")
        self.assertEqual(error.details["input"]["phase"], "clearing")
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])

    def test_already_empty_input_skips_clear_keys_for_empty_and_nonempty_text(self):
        for requested in ("", "replacement"):
            with self.subTest(text=requested):
                self.transport.input_text = ""
                self.transport.input_focused = False
                self.transport.mutations.clear()
                captures_before = self.transport.captures
                result = self.execute("fill", target="id=fixture.input", text=requested, timeout_ms=1000)
                expected = [("tap", self.transport.serial, 220, 340)]
                if requested:
                    expected.append(("text", self.transport.serial, requested))
                self.assertEqual(self.transport.mutations, expected)
                self.assertEqual(self.transport.input_text, requested)
                self.assertIs(result["input"]["alreadyEmpty"], True)
                self.assertEqual(result["inputVerification"]["status"], "passed")
                self.assertEqual(self.transport.captures - captures_before, 3)
                self.assertNotIn("_lastInputObservation", json.dumps(result))

    def test_failed_final_input_verification_evidence_uses_latest_observation(self):
        native_shell = self.transport.shell

        def insert_changed_value(*args, **kwargs):
            native_shell(*args, **kwargs)
            self.transport.input_text = "changed by application"

        with patch.object(self.transport, "shell", side_effect=insert_changed_value):
            error = self.assert_error("INPUT_VERIFICATION_FAILED", lambda: self.execute(
                "fill", target="id=fixture.input", text="replacement", timeout_ms=50))
        self.assertEqual(error.details["inputVerification"]["actual"], "changed by application")
        evidence = json.loads(Path(error.details["evidence"]["observation"]).read_text(encoding="utf-8"))
        self.assertEqual(resolve_target(evidence, "id=fixture.input")["text"], "changed by application")
        self.assertEqual(resolve_target(error.details["observation"], "id=fixture.input")["text"], "changed by application")
        self.assertNotIn("_lastInputObservation", json.dumps(error.details))

    def test_fill_later_pre_dispatch_failure_does_not_erase_earlier_mutations(self):
        for failing_phase, expected_count, expected_text in (
                ("select_all", 1, "before"), ("delete", 2, "before"), ("insert", 3, "")):
            with self.subTest(phase=failing_phase):
                self.transport.input_text = "before"
                self.transport.input_focused = False
                self.transport.input_selected = False
                self.transport.mutations.clear()
                failure = AgentError("HDC_EXEC_FAILED", "Subcommand failed before dispatch", dispatched="no")
                self.transport.key_error = ([2072, 2017] if failing_phase == "select_all" else 2055, failure) if failing_phase != "insert" else None
                self.transport.shell_error = failure if failing_phase == "insert" else None
                error = self.assert_error("HDC_EXEC_FAILED", lambda: self.execute(
                    "fill", target="id=fixture.input", text="replacement", timeout_ms=1000))
                self.assertEqual(len(self.transport.mutations), expected_count)
                self.assertEqual(self.transport.input_text, expected_text)
                self.assertEqual(error.dispatched, "unknown")
                self.assertNotEqual(error.details["action"]["status"], "not_dispatched")
                self.assertNotEqual(error.details["action"]["dispatched"], "no")
                self.assertFalse(self.agent.store.load(self.session)["frameValid"])

    def test_fill_nul_is_rejected_before_any_tap(self):
        error = self.assert_error("INVALID_ARGUMENT", lambda: self.execute(
            "fill", target="id=fixture.input", text="before\x00after", timeout_ms=1000))
        self.assertEqual(error.dispatched, "no")
        self.assertEqual(self.transport.mutations, [])
        self.assertEqual(self.transport.input_text, "before")

    def test_fill_invalid_timeout_is_rejected_before_dispatch(self):
        for invalid_timeout in (True, 0):
            with self.subTest(timeout=invalid_timeout):
                error = self.assert_error("INVALID_ARGUMENT", lambda: self.execute("fill", target="id=fixture.input", text="不应写入", timeout_ms=invalid_timeout))
                self.assertEqual(error.dispatched, "no")
                self.assertEqual(self.transport.mutations, [])
                self.assertEqual(self.transport.input_text, "before")

    def test_fill_rejects_old_button_key_event_fixture(self):
        self.assert_error("NOT_EDITABLE", lambda: self.execute("fill", target="id=fixture.increment", text="hello"))
        self.assertEqual(self.transport.mutations, [])

    def test_fill_duplicate_input_id_rejects_ambiguous_verification_before_tap(self):
        native_capture = self.transport.capture_layout

        def duplicate_input_groups(device, **kwargs):
            tree = native_capture(device, **kwargs)
            original = next(child for child in tree["children"]
                            if child["attributes"]["key"] == "fixture.input")
            tree["children"].remove(original)
            for identifier in ("fixture.group.first", "fixture.group.second"):
                group = self.transport.node(identifier, "Column", "", "[0,280][1000,400]")
                group["children"] = [deepcopy(original)]
                tree["children"].append(group)
            return tree

        target = {"id": "fixture.input", "within": {"id": "fixture.group.first"}}
        with patch.object(self.transport, "capture_layout", side_effect=duplicate_input_groups):
            observation = self.execute("observe")
            self.assertEqual(resolve_target(observation, target)["id"], "fixture.input")
            error = self.assert_error("UNSUPPORTED", lambda: self.execute(
                "fill", target=target, text="replacement", timeout_ms=1000))
        self.assertEqual(error.dispatched, "no")
        self.assertEqual(error.details["action"]["status"], "not_dispatched")
        self.assertEqual(self.transport.mutations, [])
        self.assertEqual(self.transport.input_text, "before")

    def test_device_restart_invalidates_epoch_and_old_refs(self):
        old_ref = self.current_ref()
        previous_epoch = self.agent.store.load(self.session)["epoch"]
        self.transport.boot = "22222222-2222-2222-2222-222222222222"
        self.assert_error("DEVICE_RESTARTED", lambda: self.execute("press", target=old_ref))
        state = self.agent.store.load(self.session)
        self.assertNotEqual(previous_epoch, state["epoch"])
        self.assertFalse(state["frameValid"])
        self.assertIsNone(state["frame"])
        self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
        self.assertEqual(self.transport.mutations, [])

    def test_newly_available_boot_identity_is_saved_before_later_restart(self):
        self.transport.boot = None
        self.execute("attach", device=self.transport.serial)
        old_ref = self.current_ref()
        previous_epoch = self.agent.store.load(self.session)["epoch"]
        self.transport.boot = "11111111-1111-1111-1111-111111111111"
        error = self.assert_error("DEVICE_IDENTITY_CHANGED", lambda: self.execute("press", target=old_ref))
        self.assertEqual(error.dispatched, "no")
        state = self.agent.store.load(self.session)
        self.assertEqual(state["bootId"], self.transport.boot)
        self.assertNotEqual(state["epoch"], previous_epoch)
        self.assertFalse(state["frameValid"])
        self.assertIsNone(state["frame"])
        self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
        new_ref = self.current_ref()
        self.transport.boot = "22222222-2222-2222-2222-222222222222"
        self.assert_error("DEVICE_RESTARTED", lambda: self.execute("press", target=new_ref))
        self.assertEqual(self.agent.store.load(self.session)["bootId"], self.transport.boot)
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])
        self.assertEqual(self.transport.mutations, [])

    def test_disconnect_then_reconnect_does_not_reauthorize_old_ref(self):
        old_ref = self.current_ref()
        connected = self.transport.connected
        self.transport.connected = []
        self.assert_error("DEVICE_DISCONNECTED", lambda: self.execute("press", target=old_ref))
        self.transport.connected = connected
        self.assert_error("STALE_REF", lambda: self.execute("press", target=old_ref))
        self.assertEqual(self.transport.mutations, [])

    def test_evidence_failure_does_not_hide_action_outcome(self):
        self.transport.tap_error = AgentError("HDC_TIMEOUT", "Response lost", dispatched="unknown")
        self.transport.screenshot_error = AgentError("SCREENSHOT_INVALID", "No screenshot")
        error = self.assert_error("HDC_TIMEOUT", lambda: self.execute("press", target="id=fixture.increment"))
        self.assertEqual(error.dispatched, "unknown")
        self.assertTrue(error.details["evidence"]["warnings"])
        self.assertEqual(len(self.transport.mutations), 1)

    def test_trace_write_failure_does_not_repeat_successful_action(self):
        with patch.object(self.agent.store, "trace", side_effect=OSError("disk full")):
            result = self.execute("press", target="id=fixture.increment")
        self.assertEqual(result["action"]["status"], "completed")
        self.assertTrue(result["warnings"])
        self.assertEqual(len(self.transport.mutations), 1)

    def test_detach_releases_state_without_stopping_device(self):
        result = self.execute("detach")
        self.assertTrue(result["detached"])
        self.assertFalse(result["deviceStopped"])
        self.assertEqual(self.transport.mutations, [])
        self.assertFalse(self.agent.store.path(self.session).exists())
        self.assertFalse(self.execute("detach")["detached"])


if __name__ == "__main__":
    unittest.main()
