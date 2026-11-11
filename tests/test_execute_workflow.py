"""Task-level execution shares the existing run, evidence and device lifecycle."""

from copy import deepcopy
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harmony_agent.cli import main
from harmony_agent.core import Agent
from harmony_agent.errors import AgentError
from harmony_agent.execution import RunStore
from harmony_agent.mcp import McpServer
from harmony_agent.schema import request_schema, validate_params
from tests.test_core import FakeNativeTransport


def count_is(number):
    return {"selector": {"id": "fixture.counter"}, "equals": "Counter: " + str(number)}


def workflow():
    return {"version": "1", "preconditions": [count_is(0)],
            "steps": [{"command": "press", "input": {"target": {"id": "fixture.increment"}}},
                      {"command": "press", "input": {"target": {"id": "fixture.increment"}}}],
            "goals": [count_is(2)]}


class ExecuteWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.transport = FakeNativeTransport()
        self.agent = Agent(self.directory.name, transport=self.transport)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.agent.clear_cancel()
        try:
            self.agent.execute("detach", {"session": "task"})
        except AgentError:
            pass

    def execute_workflow(self, definition=None, **extra):
        return self.agent.execute("execute", {"device": self.transport.serial, "session": "task",
                                              "run_id": "attempt", "plan": definition or workflow(), **extra})

    def test_success_attaches_runs_verifies_and_detaches_in_one_call(self):
        original = RunStore.finish
        with patch.object(RunStore, "finish", autospec=True, side_effect=original) as finish:
            result = self.execute_workflow()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["goalVerification"]["status"], "passed")
        self.assertEqual(result["sessionCleanup"], {"status": "detached", "reason": "verified_completion", "deviceStopped": False})
        self.assertFalse(result["frameValidForActions"])
        self.assertEqual(result["format"], "harmony-run-decision/1")
        self.assertTrue(result["workflowReceiptAvailable"])
        self.assertEqual(finish.call_count, 1)
        self.assertEqual(self.transport.counter, 2)
        # One initial boundary capture plus the two normal post-action reads.
        self.assertEqual(self.transport.captures, 3)
        self.assertEqual(result["profile"]["counts"]["captures"], 3)
        self.assertEqual(result["counters"]["actions"], 2)
        self.assertFalse(self.agent.store.path("task").exists())
        self.assertIsNone(self.agent.store.device_owner(self.transport.serial))
        report = self.agent.execute("report", {"run_id": "attempt", "full": True})
        self.assertTrue(report["evidenceCheck"]["complete"])
        self.assertEqual(report["result"]["goalVerification"]["status"], "passed")
        self.assertNotIn("sessionCleanup", report["result"])
        self.assertTrue(report["workflowReceipt"]["available"])
        self.assertEqual(report["workflowReceipt"]["sessionCleanup"]["status"], "detached")

    def test_full_output_remains_available(self):
        result = self.execute_workflow(output="full")
        self.assertIn("steps", result)
        self.assertNotIn("format", result)
        self.assertEqual(result["sessionCleanup"]["status"], "detached")

    def test_initial_boundary_mismatch_dispatches_zero_actions_and_retains_evidence(self):
        self.transport.counter = 7
        result = self.execute_workflow()
        self.assertEqual(result["status"], "yielded")
        self.assertEqual(result["yieldReason"], "precondition_not_met")
        self.assertEqual(result["sessionCleanup"]["status"], "retained")
        self.assertEqual(self.transport.mutations, [])
        self.assertEqual(self.transport.captures, 1)
        self.assertTrue(self.agent.store.path("task").exists())
        self.assertTrue(self.agent.execute("report", {"run_id": "attempt"})["evidenceCheck"]["complete"])

    def test_unknown_mutation_preserves_session_and_never_replays(self):
        self.transport.tap_error = AgentError("HDC_TIMEOUT", "Synthetic lost acknowledgement", dispatched="unknown")
        result = self.execute_workflow()
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["sessionCleanup"]["status"], "retained")
        self.assertEqual(self.transport.counter, 1)
        session = self.agent.store.load("task")
        self.assertEqual(self.agent.store.device_owner(self.transport.serial), self.agent.store._owner_identity(session))
        self.transport.tap_error = None
        with self.assertRaises(AgentError) as caught:
            self.execute_workflow()
        self.assertEqual(caught.exception.code, "RUN_EXISTS")
        self.assertEqual(self.transport.counter, 1)

    def test_failed_goals_do_not_trigger_cleanup(self):
        definition = workflow()
        definition["goals"] = [count_is(9)]
        result = self.execute_workflow(definition)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["goalVerification"]["status"], "failed")
        self.assertEqual(result["sessionCleanup"]["reason"], "workflow_not_verified")
        self.assertTrue(self.agent.store.path("task").exists())

    def test_yield_retains_session_even_when_final_goal_was_declared(self):
        definition = workflow()
        definition["steps"] = [{"yield": "A new choice is required"}]
        result = self.execute_workflow(definition)
        self.assertEqual(result["status"], "yielded")
        self.assertEqual(result["sessionCleanup"]["status"], "retained")
        self.assertEqual(self.transport.counter, 0)

    def test_keep_session_preserves_existing_identity_and_owner(self):
        self.agent.execute("attach", {"session": "task", "device": self.transport.serial})
        self.agent.execute("claim", {"session": "task"})
        original = self.agent.store.load("task")
        owner = self.agent.store.device_owner(self.transport.serial)
        result = self.execute_workflow(keep_session=True)
        saved = self.agent.store.load("task")
        self.assertEqual(result["sessionCleanup"]["reason"], "keep_session")
        for key in ("name", "device", "epoch", "ownerToken", "createdAt"):
            self.assertEqual(saved[key], original[key])
        self.assertEqual(self.agent.store.device_owner(self.transport.serial), owner)

    def test_wrong_device_does_not_replace_session_or_contact_transport(self):
        self.agent.execute("attach", {"session": "task", "device": self.transport.serial})
        original = self.agent.store.load("task")
        with patch.object(self.transport, "devices", side_effect=AssertionError("unexpected native call")):
            with self.assertRaises(AgentError) as caught:
                self.execute_workflow(device=self.transport.serial + "-other")
        self.assertEqual(caught.exception.code, "DEVICE_MISMATCH")
        self.assertEqual(self.agent.store.load("task"), original)

    def test_foreign_owner_is_not_taken_over(self):
        with tempfile.TemporaryDirectory() as other_root:
            other = Agent(other_root, transport=self.transport)
            other.execute("attach", {"session": "owner", "device": self.transport.serial})
            other.execute("claim", {"session": "owner"})
            owner = other.store.device_owner(self.transport.serial)
            try:
                with self.assertRaises(AgentError) as caught:
                    self.execute_workflow()
                self.assertEqual(caught.exception.code, "DEVICE_OWNED")
                self.assertEqual(other.store.device_owner(self.transport.serial), owner)
                self.assertEqual(self.transport.mutations, [])
            finally:
                other.execute("detach", {"session": "owner"})

    def test_cleanup_failure_preserves_business_result_and_can_be_detached_without_actions(self):
        with patch.object(self.agent.store, "detach", side_effect=PermissionError("synthetic delete denied")):
            result = self.execute_workflow()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["goalVerification"]["status"], "passed")
        self.assertEqual(result["sessionCleanup"]["status"], "failed")
        self.assertIn("synthetic delete denied", result["sessionCleanup"]["error"]["details"]["cause"])
        self.assertFalse(result["frameValidForActions"])
        self.assertFalse(self.agent.store.load("task")["frameValid"])
        self.assertIsNone(self.agent.store.device_owner(self.transport.serial))
        before = list(self.transport.mutations)
        self.assertTrue(self.agent.execute("detach", {"session": "task"})["detached"])
        self.assertEqual(self.transport.mutations, before)
        self.assertTrue(self.agent.execute("report", {"run_id": "attempt"})["evidenceCheck"]["complete"])

    def test_release_failure_keeps_the_actual_owner_and_error(self):
        failure = AgentError("DEVICE_OWNER_WRITE_FAILED", "Synthetic release failed", details={"osError": 13})
        with patch.object(self.agent.store, "release_device", side_effect=failure):
            result = self.execute_workflow()
        self.assertEqual(result["sessionCleanup"]["error"], failure.to_dict())
        self.assertEqual(result["sessionCleanup"]["status"], "failed")
        self.assertIsNotNone(self.agent.store.device_owner(self.transport.serial))
        self.assertEqual(self.transport.counter, 2)

    def test_cleanup_receipt_failure_does_not_undo_success_or_repeat_mutations(self):
        with patch.object(RunStore, "write_workflow_receipt", side_effect=OSError("synthetic sidecar failure")):
            result = self.execute_workflow()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["goalVerification"]["status"], "passed")
        self.assertEqual(result["sessionCleanup"]["status"], "detached")
        self.assertFalse(result["workflowReceiptAvailable"])
        self.assertEqual(result["warnings"][-1]["code"], "WORKFLOW_RECEIPT_UNAVAILABLE")
        self.assertEqual(self.transport.counter, 2)
        report = self.agent.execute("report", {"run_id": "attempt"})
        self.assertFalse(report["workflowReceipt"]["available"])
        self.assertEqual(report["workflowReceipt"]["sessionCleanup"]["status"], "unknown")
        self.assertEqual(report["result"]["goalVerification"]["status"], "passed")

    def test_static_rejections_precede_session_creation_or_transport_access(self):
        invalid = []
        for boundary in ("preconditions", "goals"):
            for missing in (False, True):
                definition = workflow()
                if missing:
                    del definition[boundary]
                else:
                    definition[boundary] = []
                invalid.append({"plan": definition})
        invalid += [{"device": ""}, {"device": "-option"}, {"keep_session": "yes"},
                    {"output": "brief"}, {"run_id": "../escape"}, {"unrecognized": True}]
        with patch.object(self.transport, "devices", side_effect=AssertionError("unexpected native call")):
            for supplied in invalid:
                with self.subTest(supplied=supplied), self.assertRaises(AgentError):
                    self.execute_workflow(**supplied)
        self.assertFalse(self.agent.store.path("task").exists())
        self.assertFalse((Path(self.directory.name) / "runs").exists())

    def test_malformed_unselected_branch_is_rejected_before_attaching(self):
        definition = workflow()
        definition["steps"] = [{"if": count_is(0), "then": workflow()["steps"],
                                "else": [{"command": "press", "input": {"target": {"ref": "@old"}}}]}]
        with patch.object(self.transport, "devices", side_effect=AssertionError("unexpected native call")):
            with self.assertRaises(AgentError):
                self.execute_workflow(definition)
        self.assertFalse(self.agent.store.path("task").exists())

    def test_cli_and_mcp_expose_the_task_command_and_required_boundaries(self):
        out = io.StringIO()
        with redirect_stdout(out):
            exit_code = main(["execute", "--device", self.transport.serial, "--session", "task",
                              "--run-id", "cli-attempt", "--plan", json.dumps(workflow()), "--json"],
                             agent_factory=lambda **kwargs: self.agent)
        self.assertEqual(exit_code, 0)
        self.assertEqual(json.loads(out.getvalue())["data"]["sessionCleanup"]["status"], "detached")
        self.transport.counter = 0
        server = McpServer(agent_factory=lambda **kwargs: self.agent)
        server._ready = True
        response = server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "harmony_execute", "arguments": {"device": self.transport.serial, "session": "task",
                                                         "run_id": "mcp-attempt", "plan": workflow()}}})
        self.assertTrue(response["result"]["structuredContent"]["success"])
        self.assertEqual(response["result"]["structuredContent"]["data"]["sessionCleanup"]["status"], "detached")
        self.assertNotIn("execute", McpServer(read_only=True).commands())
        schema = request_schema("execute")
        fields = schema["oneOf"][0]["properties"]["input"]
        self.assertIn("device", fields["required"])
        self.assertEqual(fields["properties"]["output"]["default"], "decision")
        self.assertEqual(fields["properties"]["plan"]["allOf"][0]["required"], ["preconditions", "goals"])
        def check_refs(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    self.assertIn(value["$ref"].removeprefix("#/$defs/"), schema["$defs"])
                for item in value.values(): check_refs(item)
            elif isinstance(value, list):
                for item in value: check_refs(item)
        check_refs(schema)

    def test_defaults_and_known_v2_workflow_share_existing_runner(self):
        definition = workflow()
        definition["version"] = "2"
        definition["steps"] += [
            {"read": {"name": "count", "selector": {"id": "fixture.counter"}, "stripPrefix": "Counter: "}},
            {"command": "fill", "input": {"target": {"id": "fixture.input"}, "text": {"var": "count"}}}]
        definition["goals"].append({"selector": {"id": "fixture.input"}, "equals": {"var": "count"}})
        normalized = validate_params("execute", {"device": self.transport.serial, "plan": definition})
        self.assertEqual(normalized["output"], "decision")
        self.assertFalse(normalized["keep_session"])
        result = self.execute_workflow(definition)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.transport.input_text, "2")
        self.assertEqual(result["sessionCleanup"]["status"], "detached")


if __name__ == "__main__":
    unittest.main()
