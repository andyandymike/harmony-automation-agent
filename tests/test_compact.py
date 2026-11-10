"""Output controls must not weaken targeting, readback or change semantics."""

from copy import deepcopy
import json
import tempfile
import unittest
from unittest.mock import patch

from harmony_agent.core import Agent
from harmony_agent.errors import AgentError
from harmony_agent.observation import normalize_layout, resolve_target
from test_core import FakeNativeTransport


class CompactTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.transport = FakeNativeTransport()
        self.agent = Agent(folder.name, transport=self.transport)
        self.agent.execute("attach", {"device": self.transport.serial})

    def test_compact_preserves_meaningful_empty_and_false_values_without_mutating_frame(self):
        frame = normalize_layout({"attributes": {
            "id": "input", "type": "TextInput", "text": "", "value": "",
            "description": "", "hint": " ", "enabled": "false", "displayId": 0,
            "bounds": "[0,0][100,100]"}}, "frame")
        before = deepcopy(frame)
        full = self.agent._project(frame)
        compact = self.agent._project(frame, {"compact": True})
        node = compact["nodes"][0]
        self.assertEqual(node["text"], "")
        self.assertEqual(node["value"], "")
        self.assertEqual(node["hint"], " ")
        self.assertIs(node["enabled"], False)
        self.assertEqual(node["displayId"], "0")
        self.assertEqual(node["bounds"]["left"], 0)
        self.assertIn("parent", node)
        self.assertIsNone(node["parent"])
        self.assertNotIn("description", node)
        self.assertNotIn("checked", node)
        self.assertIsNone(full["nodes"][0]["checked"])
        self.assertEqual(frame, before)
        self.assertEqual(compact["quality"], full["quality"])
        self.assertTrue(compact["projection"]["compact"])
        self.assertNotIn("compact", full["projection"])
        self.assertLess(len(json.dumps(compact)), len(json.dumps(full)))

    def test_compact_diff_keeps_cleared_business_value(self):
        self.agent.execute("observe", {"compact": True})
        self.transport.input_text = ""
        result = self.agent.execute("observe", {"compact": True})
        changed = next(item for item in result["diff"]["changed"]
                       if item["id"] == "fixture.input")
        self.assertEqual(changed["before"]["text"], "before")
        self.assertEqual(changed["after"]["text"], "")

    def test_action_output_budget_does_not_limit_targeting_or_assertion(self):
        found = self.agent.execute("find", {"text": "Increment", "compact": True})
        target = resolve_target(found, "id=fixture.increment")["ref"]
        captures = self.transport.captures
        result = self.agent.execute("press", {"target": target, "max_nodes": 1,
            "compact": True, "expect": {"selector": "id=fixture.counter", "equals": "Counter: 1"}})
        self.assertEqual(result["assertion"]["status"], "passed")
        self.assertEqual(self.transport.captures - captures, 2)
        self.assertEqual(len(result["observation"]["nodes"]), 1)
        self.assertTrue(result["observation"]["quality"]["truncated"])
        self.assertTrue(result["observation"]["projection"]["compact"])
        stored = self.agent.store.load("default")["frame"]
        self.assertGreater(len(stored["nodes"]), 1)
        self.assertNotIn("compact", stored["projection"])
        self.assertIn("checked", stored["nodes"][0])

    def test_wait_and_fill_keep_empty_assertion_values(self):
        filled = self.agent.execute("fill", {"target": "id=fixture.input", "text": "", "compact": True})
        self.assertEqual(filled["assertion"]["actual"], "")
        self.assertEqual(filled["assertion"]["expected"], "")
        waited = self.agent.execute("wait", {"target": "id=fixture.input", "equals": "",
                                             "compact": True, "max_nodes": 1})
        self.assertEqual(waited["assertion"]["status"], "passed")
        self.assertEqual(waited["assertion"]["actual"], "")
        self.assertEqual(len(waited["observation"]["nodes"]), 1)
        self.assertTrue(waited["observation"]["projection"]["compact"])

    def test_failure_observation_uses_requested_output_without_changing_dispatch(self):
        with self.assertRaises(AgentError) as raised:
            self.agent.execute("press", {"target": "id=fixture.increment", "compact": True,
                "max_nodes": 1, "expect": {"selector": "id=fixture.counter", "equals": "never", "timeoutMs": 1}})
        result = raised.exception.details
        self.assertEqual(result["action"]["dispatched"], "acknowledged")
        self.assertEqual(len(result["observation"]["nodes"]), 1)
        self.assertTrue(result["observation"]["projection"]["compact"])
        self.assertFalse(self.agent.store.load("default")["frameValid"])

    def test_compact_type_is_checked_before_device_use(self):
        with self.assertRaises(AgentError) as raised:
            self.agent.execute("observe", {"compact": "true"})
        self.assertEqual(raised.exception.code, "INVALID_ARGUMENT")
        self.assertEqual(self.transport.captures, 0)

    def test_fill_expect_reuses_verified_frame_and_polls_if_condition_not_yet_met(self):
        for delayed in (False, True):
            with self.subTest(delayed=delayed):
                self.transport.input_text = ""
                self.transport.counter = 0
                start = self.transport.captures
                original = self.transport.capture_layout

                def capture(*args, **kwargs):
                    if delayed and self.transport.captures - start == 3:
                        self.transport.counter = 1
                    return original(*args, **kwargs)

                condition = {"selector": "id=fixture.counter", "equals": "Counter: 1"} if delayed else {
                    "selector": "id=fixture.input", "equals": "new value"}
                with patch.object(self.transport, "capture_layout", side_effect=capture):
                    result = self.agent.execute("fill", {"target": "id=fixture.input", "text": "new value",
                                                         "expect": condition, "compact": True})
                self.assertEqual(result["inputVerification"]["status"], "passed")
                self.assertEqual(result["assertion"]["status"], "passed")
                self.assertEqual(self.transport.captures - start, 4 if delayed else 3)
                self.assertEqual(result["assertion"]["attempts"], 2 if delayed else 1)


if __name__ == "__main__":
    unittest.main()
