"""Reusable plan files use the existing validation and fresh run identity."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest

from harmony_agent.cli import main
from harmony_agent.core import Agent
from harmony_agent.schema import validate_request
from harmony_agent.errors import AgentError
from tests.test_core import FakeNativeTransport


def workflow():
    return {"version": "1", "goal": "Repeatable Unicode example: 示例",
            "preconditions": [{"selector": {"id": "fixture.counter", "bundleName": "org.example.fixture"},
                               "equals": "Counter: 0"}],
            "steps": [{"command": "press", "input": {"target": {"id": "fixture.increment"}}}],
            "goals": [{"selector": {"id": "fixture.counter"}, "equals": "Counter: 1"}]}


class PlanFileTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.path = self.root / "known workflow.json"
        self.path.write_text(json.dumps(workflow(), ensure_ascii=False), encoding="utf-8-sig")
        self.constructed = []
        self.calls = []

    def fake_factory(self, **options):
        self.constructed.append(options)
        outer = self

        class EchoAgent:
            def execute(self, command, params):
                outer.calls.append((command, params))
                return params

        return EchoAgent()

    def invoke(self, *arguments, factory=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            status = main([*arguments, "--json"], agent_factory=factory or self.fake_factory)
        self.assertEqual(stderr.getvalue(), "")
        return status, json.loads(stdout.getvalue())

    def assert_rejected(self, *arguments, code="INVALID_ARGUMENT"):
        status, result = self.invoke(*arguments)
        self.assertNotEqual(status, 0)
        self.assertEqual(result["error"]["code"], code)
        self.assertEqual(self.constructed, [])
        self.assertEqual(self.calls, [])
        return result

    def test_raw_plan_file_supports_bom_unicode_and_context_for_both_commands(self):
        for command, output in (("run", "full"), ("execute", "decision")):
            with self.subTest(command=command):
                status, result = self.invoke(command, "--plan-file", str(self.path),
                                             "--device", "exact-device", "--session", "task")
                self.assertEqual(status, 0)
                params = result["data"]
                self.assertEqual(params["plan"]["goal"], workflow()["goal"])
                self.assertEqual(params["device"], "exact-device")
                self.assertEqual(params["session"], "task")
                self.assertEqual(params["output"], output)
                self.assertNotIn("plan_file", params)
                self.assertNotIn("run_id", params)

    def test_plan_file_is_mutually_exclusive_with_inline_plan_or_request(self):
        for extra in (("--plan", json.dumps(workflow())), ("--request", str(self.path))):
            with self.subTest(extra=extra):
                self.assert_rejected("execute", "--device", "exact-device", "--plan-file", str(self.path), *extra)

    def test_malformed_json_and_non_object_plan_fail_before_agent_creation(self):
        for text in ("{not json", "[]", "null", json.dumps({"command": "run", "input": {"plan": workflow()}})):
            with self.subTest(text=text):
                self.path.write_text(text, encoding="utf-8")
                self.assert_rejected("execute", "--device", "exact-device", "--plan-file", str(self.path), code="INVALID_PLAN")

    def test_missing_unreadable_and_invalid_utf8_plan_files_fail_before_agent_creation(self):
        self.path.write_bytes(b"\xff\xfe\xfa")
        for path in (self.root / "missing.json", self.root, self.path):
            with self.subTest(path=path):
                self.assert_rejected("run", "--plan-file", str(path), code="INVALID_PLAN")

    def test_invalid_unselected_branch_is_validated_before_agent_creation(self):
        plan = workflow()
        plan["steps"] = [{"if": plan["preconditions"][0], "then": [{"assert": plan["preconditions"][0]}],
                          "else": [{"command": "shell", "input": {}}]}]
        self.path.write_text(json.dumps(plan), encoding="utf-8")
        result = self.assert_rejected("execute", "--device", "exact-device", "--plan-file", str(self.path), code="INVALID_PLAN")
        self.assertEqual(result["error"]["details"]["path"], "plan.steps[0].else[0].command")

    def test_execute_boundaries_are_required_before_agent_creation(self):
        for boundary in ("preconditions", "goals"):
            with self.subTest(boundary=boundary):
                plan = workflow()
                del plan[boundary]
                self.path.write_text(json.dumps(plan), encoding="utf-8")
                self.assert_rejected("execute", "--device", "exact-device", "--plan-file", str(self.path), code="INVALID_PLAN")

    def test_file_option_is_cli_only_and_not_an_arbitrary_command_field(self):
        self.assert_rejected("observe", "--plan-file", str(self.path))
        with self.assertRaises(AgentError):
            validate_request({"command": "execute", "input": {
                "device": "exact-device", "plan": workflow(), "plan_file": str(self.path)}})

    def test_same_file_on_two_justified_tasks_gets_distinct_persisted_run_ids(self):
        transport = FakeNativeTransport()
        state = self.root / "state"
        agent = Agent(state, transport=transport)
        original_bytes = self.path.read_bytes()
        ids = []
        for _ in range(2):
            # The caller establishes a new task at the known initial state.
            # This is not an automatic retry after a missing response.
            transport.counter = 0
            status, envelope = self.invoke("execute", "--device", transport.serial,
                                           "--session", "task", "--plan-file", str(self.path),
                                           factory=lambda **options: agent)
            self.assertEqual(status, 0)
            result = envelope["data"]
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["sessionCleanup"]["status"], "detached")
            self.assertTrue(result["workflowReceiptAvailable"])
            ids.append(result["runId"])
        self.assertEqual(len(set(ids)), 2)
        for run_id in ids:
            report = agent.execute("report", {"run_id": run_id})
            self.assertEqual(report["result"]["goalVerification"]["status"], "passed")
            self.assertEqual(report["workflowReceipt"]["sessionCleanup"]["status"], "detached")
        self.assertEqual(len(transport.mutations), 2)
        self.assertEqual(transport.captures, 4)
        self.assertEqual(self.path.read_bytes(), original_bytes)


if __name__ == "__main__":
    unittest.main()
