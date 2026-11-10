"""Review regressions at the public request/core boundary; no device is used."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harmony_agent.cli import main
from harmony_agent.core import Agent
from harmony_agent.errors import AgentError
from harmony_agent.observation import resolve_target
from tests.test_core import FakeNativeTransport


class ReviewRegressionTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.transport = FakeNativeTransport()
        self.agent = Agent(state_dir=self.folder.name, transport=self.transport)
        self.session = "review"
        self.execute("attach", device=self.transport.serial)

    def execute(self, command, **params):
        return self.agent.execute(command, {"session": self.session, **params})

    def cli_request(self, command, **params):
        path = Path(self.folder.name) / "request.json"
        path.write_text(json.dumps({"command": command, "input": {
            "session": self.session, **params}}, ensure_ascii=False), encoding="utf-8")
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            code = main(["--request", str(path), "--json"],
                        agent_factory=lambda **kwargs: self.agent)
        self.assertEqual(errors.getvalue(), "")
        return code, json.loads(output.getvalue())

    def assert_agent_error(self, operation, code=None):
        with self.assertRaises(AgentError) as raised:
            operation()
        if code is not None:
            self.assertEqual(raised.exception.code, code)
        return raised.exception

    def observe_refs(self):
        observation = self.execute("observe")
        return (resolve_target(observation, "id=fixture.increment")["ref"],
                resolve_target(observation, "id=root")["ref"])

    @staticmethod
    def dependent_selectors(button_ref, root_ref):
        return [
            button_ref,
            "ref=" + button_ref,
            {"ref": button_ref},
            "parent=" + root_ref,
            {"id": "fixture.increment", "parent": root_ref},
            {"id": "fixture.increment", "within": root_ref},
            {"id": "fixture.increment", "within": "ref=" + root_ref},
            {"id": "fixture.increment", "within": {"ref": root_ref}},
            {"id": "fixture.increment", "within": {"parent": root_ref}},
            {"id": "fixture.increment", "within": {
                "type": "Column", "within": {"ref": root_ref}}},
        ]

    def test_frame_dependent_expectations_are_rejected_before_dispatch(self):
        button_ref, root_ref = self.observe_refs()
        for selector in self.dependent_selectors(button_ref, root_ref):
            with self.subTest(selector=selector):
                error = self.assert_agent_error(lambda: self.execute(
                    "press", target="id=fixture.increment", expect={
                        "selector": selector, "property": "visible", "equals": True,
                        "timeoutMs": 10}), "INVALID_EXPECTATION")
                self.assertEqual(error.dispatched, "no")
                self.assertEqual(self.transport.mutations, [])

    def test_wait_rejects_frame_dependent_conditions_without_polling(self):
        button_ref, root_ref = self.observe_refs()
        for selector in self.dependent_selectors(button_ref, root_ref):
            with self.subTest(selector=selector):
                captures = self.transport.captures
                error = self.assert_agent_error(lambda: self.execute(
                    "wait", target=selector, property="visible", equals=True,
                    timeout_ms=10), "INVALID_EXPECTATION")
                self.assertEqual(error.dispatched, "no")
                self.assertEqual(self.transport.captures, captures)
                self.assertEqual(self.transport.mutations, [])

    def test_cli_rejects_nested_frame_dependent_expectation_before_dispatch(self):
        _, root_ref = self.observe_refs()
        code, result = self.cli_request("press", target="id=fixture.increment", expect={
            "selector": {"id": "fixture.increment", "within": {"ref": root_ref}},
            "property": "visible", "equals": True, "timeoutMs": 10})
        self.assertNotEqual(code, 0)
        self.assertFalse(result["success"])
        self.assertEqual(result["error"]["code"], "INVALID_EXPECTATION")
        self.assertEqual(result["error"]["details"]["dispatched"], "no")
        self.assertEqual(self.transport.mutations, [])

    def test_ref_predicates_are_rechecked_in_the_fresh_observation(self):
        native_capture = self.transport.capture_layout
        for field, old_value, new_value in [
                ("checked", False, True), ("selected", False, True),
                ("description", "first", "second"), ("value", "old", "new")]:
            state = [old_value]

            def capture(device, **kwargs):
                raw = native_capture(device, **kwargs)
                toggle = next(node for node in raw["children"]
                              if node["attributes"]["key"] == "fixture.toggle")
                toggle["attributes"][field] = state[0]
                return raw

            with self.subTest(field=field), patch.object(
                    self.transport, "capture_layout", side_effect=capture):
                observation = self.execute("observe")
                ref = resolve_target(observation, "id=fixture.toggle")["ref"]
                state[0] = new_value
                error = self.assert_agent_error(lambda: self.execute(
                    "press", target={"ref": ref, field: old_value}), "STALE_REF")
                self.assertEqual(error.dispatched, "no")
                self.assertEqual(self.transport.mutations, [])

    def test_current_frame_parent_and_within_targets_are_rebound(self):
        target_builders = [
            lambda ref, parent: "ref=" + ref,
            lambda ref, parent: {"id": "fixture.increment", "parent": parent},
            lambda ref, parent: {"id": "fixture.increment", "within": parent},
            lambda ref, parent: {"id": "fixture.increment", "within": "ref=" + parent},
            lambda ref, parent: {"id": "fixture.increment", "within": {"ref": parent}},
            lambda ref, parent: {"id": "fixture.increment", "within": {
                "ref": parent, "type": "Column"}},
        ]
        for build_target in target_builders:
            button_ref, root_ref = self.observe_refs()
            target = build_target(button_ref, root_ref)
            mutations = len(self.transport.mutations)
            with self.subTest(target=target):
                result = self.execute("press", target=target)
                self.assertEqual(result["action"], {
                    "status": "completed", "dispatched": "acknowledged"})
                self.assertEqual(len(self.transport.mutations), mutations + 1)
                self.assertEqual(self.transport.mutations[-1][0], "tap")

    def test_string_parent_target_rebinds_when_it_identifies_one_child(self):
        native_capture = self.transport.capture_layout

        def capture(device, **kwargs):
            raw = native_capture(device, **kwargs)
            raw["children"] = [node for node in raw["children"]
                               if node["attributes"]["key"] == "fixture.increment"]
            return raw

        with patch.object(self.transport, "capture_layout", side_effect=capture):
            _, root_ref = self.observe_refs()
            result = self.execute("press", target="parent=" + root_ref)
        self.assertEqual(result["action"]["dispatched"], "acknowledged")
        self.assertEqual(len(self.transport.mutations), 1)

    def test_previous_frame_refs_in_targets_are_not_rebound(self):
        builders = [
            lambda ref, parent: ref,
            lambda ref, parent: "ref=" + ref,
            lambda ref, parent: {"ref": ref},
            lambda ref, parent: {"id": "fixture.increment", "parent": parent},
            lambda ref, parent: {"id": "fixture.increment", "within": parent},
            lambda ref, parent: {"id": "fixture.increment", "within": {"ref": parent}},
        ]
        for build_target in builders:
            old_ref, old_parent = self.observe_refs()
            self.execute("observe")
            target = build_target(old_ref, old_parent)
            with self.subTest(target=target):
                error = self.assert_agent_error(lambda: self.execute(
                    "press", target=target), "STALE_REF")
                self.assertEqual(error.dispatched, "no")
                self.assertEqual(self.transport.mutations, [])

    def test_cli_current_parent_target_uses_fresh_rebinding(self):
        _, root_ref = self.observe_refs()
        code, result = self.cli_request("press", target={
            "id": "fixture.increment", "parent": root_ref})
        self.assertEqual(code, 0)
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["action"]["dispatched"], "acknowledged")
        self.assertEqual(len(self.transport.mutations), 1)

    def test_explicit_noneditable_textinput_is_rejected_before_focus(self):
        native_capture = self.transport.capture_layout

        def capture(device, **kwargs):
            raw = native_capture(device, **kwargs)
            target = next(node for node in raw["children"]
                          if node["attributes"]["key"] == "fixture.input")
            target["attributes"]["editable"] = False
            return raw

        with patch.object(self.transport, "capture_layout", side_effect=capture):
            error = self.assert_agent_error(lambda: self.execute(
                "fill", target="id=fixture.input", text="replacement"), "NOT_EDITABLE")
        self.assertEqual(error.dispatched, "no")
        self.assertEqual(self.transport.mutations, [])
        self.assertEqual(self.transport.input_text, "before")

    def test_corrupt_session_can_be_detached_then_reattached(self):
        for contents in ("{broken", "{}", '{"schemaVersion":"99","device":"old"}'):
            with self.subTest(contents=contents):
                self.agent.store.path(self.session).write_text(contents, encoding="utf-8")
                detached = self.execute("detach")
                self.assertTrue(detached["detached"])
                self.assertFalse(detached["deviceStopped"])
                self.assertFalse(self.agent.store.path(self.session).exists())
                attached = self.execute("attach", device=self.transport.serial)
                self.assertEqual(attached["device"], self.transport.serial)
                self.assertEqual(self.agent.store.load(self.session)["device"], self.transport.serial)
                self.assertEqual(self.transport.mutations, [])

    def test_cli_corrupt_session_recovery_does_not_need_device_commands(self):
        self.agent.store.path(self.session).write_text("{broken", encoding="utf-8")
        with patch.object(self.transport, "devices", side_effect=AssertionError(
                "Detach must not enumerate devices to delete corrupt local state")):
            code, result = self.cli_request("detach")
        self.assertEqual(code, 0)
        self.assertTrue(result["data"]["detached"])
        self.assertEqual(self.transport.mutations, [])
        code, result = self.cli_request("attach", device=self.transport.serial)
        self.assertEqual(code, 0)
        self.assertEqual(result["data"]["device"], self.transport.serial)

    def test_persistent_save_failure_preserves_acknowledged_action(self):
        native_save = self.agent.store.save
        writes = [0]

        def save(name, value):
            writes[0] += 1
            if writes[0] > 1:
                raise OSError("Synthetic persistent disk failure after dispatch")
            return native_save(name, value)

        with patch.object(self.agent.store, "save", side_effect=save):
            error = self.assert_agent_error(lambda: self.execute(
                "press", target="id=fixture.increment", expect={
                    "selector": "id=fixture.counter", "equals": "Counter: 1"}))
        self.assertEqual(error.dispatched, "unknown")
        self.assertTrue(error.details["operationId"])
        self.assertEqual(error.details["action"], {
            "status": "completed", "dispatched": "acknowledged"})
        self.assertEqual(error.details["assertion"]["status"], "passed")
        self.assertEqual(self.transport.counter, 1)
        self.assertEqual(len(self.transport.mutations), 1)
        self.assertFalse(self.agent.store.load(self.session)["frameValid"])

    def test_cli_persistent_save_failure_keeps_the_known_action_receipt(self):
        native_save = self.agent.store.save
        writes = [0]

        def save(name, value):
            writes[0] += 1
            if writes[0] > 1:
                raise OSError("Synthetic persistent disk failure after dispatch")
            return native_save(name, value)

        with patch.object(self.agent.store, "save", side_effect=save):
            code, result = self.cli_request("press", target="id=fixture.increment")
        self.assertNotEqual(code, 0)
        details = result["error"]["details"]
        self.assertEqual(details["dispatched"], "unknown")
        self.assertTrue(details["operationId"])
        self.assertEqual(details["action"], {
            "status": "completed", "dispatched": "acknowledged"})
        self.assertEqual(len(self.transport.mutations), 1)

    def test_state_write_failure_before_dispatch_stays_not_dispatched(self):
        with patch.object(self.agent.store, "save", side_effect=OSError("Disk unavailable")):
            error = self.assert_agent_error(lambda: self.execute(
                "press", target="id=fixture.increment"))
        self.assertEqual(error.dispatched, "no")
        self.assertTrue(error.details["operationId"])
        self.assertEqual(error.details["action"], {
            "status": "not_dispatched", "dispatched": "no"})
        self.assertEqual(self.transport.mutations, [])

    def test_cli_state_write_failure_before_dispatch_is_not_unknown(self):
        with patch.object(self.agent.store, "save", side_effect=OSError("Disk unavailable")):
            code, result = self.cli_request("press", target="id=fixture.increment")
        self.assertNotEqual(code, 0)
        details = result["error"]["details"]
        self.assertEqual(details["dispatched"], "no")
        self.assertTrue(details["operationId"])
        self.assertEqual(details["action"]["status"], "not_dispatched")
        self.assertEqual(self.transport.mutations, [])

    def test_evidence_failure_does_not_replace_an_acknowledged_action_error(self):
        for failure in (OSError("Disk full"), ValueError("Unexpected evidence failure"),
                        KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                self.transport.mutations.clear()
                self.transport.capture_error_after_mutation = AgentError(
                    "LAYOUT_INVALID", "The post-action layout is malformed")
                self.transport.screenshot_error = failure
                error = self.assert_agent_error(lambda: self.execute(
                    "press", target="id=fixture.increment"), "LAYOUT_INVALID")
                self.assertEqual(error.dispatched, "unknown")
                self.assertTrue(error.details["operationId"])
                self.assertEqual(error.details["action"], {
                    "status": "completed", "dispatched": "acknowledged"})
                self.assertEqual(len(self.transport.mutations), 1)
                self.assertTrue(error.details["evidence"]["warnings"])

    def test_trace_failure_does_not_replace_success_or_a_primary_error(self):
        for primary_error in (False, True):
            with self.subTest(primary_error=primary_error):
                self.transport.mutations.clear()
                self.transport.capture_error_after_mutation = (
                    AgentError("LAYOUT_INVALID", "Invalid post-action layout")
                    if primary_error else None)
                with patch.object(self.agent.store, "trace", side_effect=ValueError(
                        "Unexpected trace encoder failure")):
                    if primary_error:
                        error = self.assert_agent_error(lambda: self.execute(
                            "press", target="id=fixture.increment"), "LAYOUT_INVALID")
                        result = error.details
                        self.assertEqual(error.dispatched, "unknown")
                    else:
                        result = self.execute("press", target="id=fixture.increment")
                self.assertTrue(result["operationId"])
                self.assertEqual(result["action"], {
                    "status": "completed", "dispatched": "acknowledged"})
                self.assertEqual(len(self.transport.mutations), 1)
                self.assertTrue(result["warnings"])

    def test_find_diff_filters_large_frame_changes_to_the_returned_current_ref(self):
        native_capture = self.transport.capture_layout
        phase = ["before"]

        def capture(device, **kwargs):
            raw = native_capture(device, **kwargs)
            raw["children"] = [self.transport.node(
                f"bulk.{index:03d}", "Text", f"{phase[0]} {index}",
                f"[0,{index * 20}][200,{index * 20 + 20}]") for index in range(300)]
            return raw

        with patch.object(self.transport, "capture_layout", side_effect=capture):
            previous = self.execute("observe", max_nodes=301)
            phase[0] = "after"
            current = self.execute("find", text="bulk.173", max_nodes=1)

        self.assertEqual(previous["quality"]["totalNodes"], 301)
        self.assertEqual(len(previous["nodes"]), 301)
        self.assertEqual(current["quality"]["totalNodes"], 301)
        self.assertEqual([node["id"] for node in current["nodes"]], ["bulk.173"])
        diff = current["diff"]
        self.assertTrue(diff["comparable"])
        self.assertEqual(diff["added"], [])
        self.assertEqual(diff["removed"], [])
        self.assertEqual(len(diff["changed"]), 1)
        change = diff["changed"][0]
        self.assertEqual(change["id"], "bulk.173")
        self.assertEqual(change["ref"], current["nodes"][0]["ref"])
        self.assertEqual(change["before"], {"text": "before 173"})
        self.assertEqual(change["after"], {"text": "after 173"})
        self.assertEqual(diff["previousFrameId"], previous["frameId"])
        self.assertEqual(diff["currentFrameId"], current["frameId"])
        self.assertEqual(diff["quality"], {
            "total": 300, "matched": 1, "returned": 1, "omitted": 0,
            "filtered": 299, "truncated": False, "complete": False})
        self.assertFalse(diff["complete"])
        self.assertEqual(len(self.agent.store.load(self.session)["frame"]["nodes"]), 301)
        self.assertEqual(self.transport.mutations, [])

    def test_observe_budget_changes_do_not_invent_added_or_removed_nodes(self):
        previous = self.execute("observe", max_nodes=5)
        self.assertEqual(len(previous["nodes"]), 5)
        for budget in (1, 3, 5, 1):
            with self.subTest(max_nodes=budget):
                current = self.execute("observe", max_nodes=budget)
                self.assertEqual(len(current["nodes"]), budget)
                diff = current["diff"]
                self.assertTrue(diff["comparable"])
                self.assertTrue(diff["complete"])
                self.assertEqual(diff["added"], [])
                self.assertEqual(diff["removed"], [])
                self.assertEqual(diff["changed"], [])
                self.assertEqual(diff["quality"]["total"], 0)
                self.assertEqual(diff["quality"]["filtered"], 0)
                self.assertEqual(diff["previousFrameId"], previous["frameId"])
                self.assertEqual(diff["currentFrameId"], current["frameId"])
                self.assertEqual(len(self.agent.store.load(self.session)["frame"]["nodes"]), 5)
                previous = current
        self.assertEqual(self.transport.mutations, [])

    def test_duplicate_id_count_changes_do_not_invent_additions_or_removals(self):
        native_capture = self.transport.capture_layout
        count = [1]

        def capture(device, **kwargs):
            raw = native_capture(device, **kwargs)
            raw["children"] = [self.transport.node(
                "review.shared", "Text", "Shared", f"[0,{index * 20}][200,{index * 20 + 20}]")
                for index in range(count[0])]
            raw["children"].append(self.transport.node(
                "review.stable", "Text", f"Count: {count[0]}", "[0,100][200,120]"))
            return raw

        with patch.object(self.transport, "capture_layout", side_effect=capture):
            self.execute("observe", max_nodes=10)
            previous_count = 1
            for next_count in (2, 1):
                with self.subTest(previous=previous_count, current=next_count):
                    count[0] = next_count
                    current = self.execute("observe", max_nodes=10)
                    diff = current["diff"]
                    self.assertTrue(diff["comparable"])
                    self.assertEqual(diff["added"], [])
                    self.assertEqual(diff["removed"], [])
                    self.assertEqual([change["id"] for change in diff["changed"]], ["review.stable"])
                    self.assertEqual(diff["changed"][0]["ref"],
                                     resolve_target(current, "id=review.stable")["ref"])
                    self.assertEqual(diff["changed"][0]["before"], {"text": f"Count: {previous_count}"})
                    self.assertEqual(diff["changed"][0]["after"], {"text": f"Count: {next_count}"})
                    self.assertFalse(diff["complete"])
                    self.assertFalse(diff["quality"]["complete"])
                    self.assertEqual(diff["unmatched"], {"previous": previous_count, "current": next_count})
                    self.assertEqual(diff["ambiguous"], {
                        "identities": 1, "previous": previous_count, "current": next_count})
                    previous_count = next_count
        self.assertEqual(self.transport.mutations, [])


if __name__ == "__main__":
    unittest.main()
