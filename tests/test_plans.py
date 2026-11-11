"""Declarative control-flow and fault-boundary checks without a device/model."""

from copy import deepcopy
import json
import unittest

from harmony_agent.errors import AgentError
from harmony_agent.plans import PlanBudget, plan_schema, run_plan, validate_plan


def count_is(value):
    return {"selector": {"id": "counter"}, "equals": str(value)}


def press():
    return {"command": "press", "input": {"target": {"id": "increment"}, "expect": {
        "selector": {"id": "increment"}, "property": "visible", "equals": True}}}


def plan(*steps, **kwargs):
    return {"version": "1", "steps": list(steps), **kwargs}


class FakeClock:
    def __init__(self):
        self.now = 10.0

    def __call__(self):
        return self.now


class FakeDevice:
    def __init__(self):
        self.count = 0
        self.calls = []
        self.conditions = []
        self.error = None
        self.condition_status = None
        self.budget = None
        self.clock = None
        self.advance = 0

    def evaluate(self, condition):
        self.conditions.append(condition)
        expected = condition["equals"]
        actual = self.count if condition["selector"] == {"id": "counter"} else True
        if type(expected) is str:
            actual = str(actual)
        return {"status": self.condition_status or ("passed" if type(actual) is type(expected) and actual == expected else "failed"),
                "actual": actual, "expected": expected, "frameId": "frame-" + str(self.count)}

    def execute(self, command, params):
        self.calls.append((command, params))
        if self.budget:
            self.budget.consume_capture()
        guards = [self.evaluate(condition) for condition in params.get("_plan_before", [])]
        if any(item["status"] != "passed" for item in guards):
            raise AgentError("PLAN_GUARD_FAILED", "Current state does not satisfy action guards.",
                             details={"guardAssertions": guards})
        if command == "press":
            self.count += 1
        if self.error:
            raise self.error
        if self.clock:
            self.clock.now += self.advance
        observation = {"frameId": "frame-" + str(self.count), "nodes": [{"text": str(self.count)}]}
        if command == "observe":
            return observation
        return {"operationId": "operation-" + str(self.count),
                "beforeFrameId": "frame-" + str(max(0, self.count - 1)), "afterFrameId": observation["frameId"],
                "observationSource": "captured", "targetFrameAgeMs": 0,
                "action": {"status": "completed", "dispatched": "acknowledged"},
                "assertion": self.evaluate(params["expect"]) if "expect" in params else {"status": "not_requested"},
                "guardAssertions": guards, "observation": observation}


class PlanValidationTests(unittest.TestCase):
    def test_defaults_and_copy_do_not_change_input(self):
        original = plan(press(), goals=[count_is(1)])
        saved = deepcopy(original)
        validated = validate_plan(original)
        self.assertEqual(original, saved)
        self.assertEqual(validated["limits"]["maxCaptures"], 100)
        self.assertNotIn("session", validated["steps"][0]["input"])
        validated["steps"][0]["input"]["target"]["id"] = "changed"
        self.assertEqual(original, saved)

    def test_every_branch_validates_before_any_callback(self):
        device = FakeDevice()
        invalid = plan({"if": count_is(0), "then": [press()], "else": [{"command": "press", "input": {}}]})
        with self.assertRaises(AgentError):
            run_plan(invalid, device.execute, device.evaluate)
        self.assertEqual(device.calls, [])
        self.assertEqual(device.conditions, [])

    def test_mutations_allow_omitted_expect_without_inventing_one(self):
        steps = [{"command": "press", "input": {"target": "id=next"}},
                 {"command": "fill", "input": {"target": "id=message", "text": "hello"}},
                 {"command": "scroll", "input": {"direction": "down"}}, {"command": "back"},
                 {"command": "open", "input": {"app": "org.example.fixture"}}]
        normalized = validate_plan(plan(*steps))
        self.assertTrue(all("expect" not in step["input"] for step in normalized["steps"]))
        variants = {item["properties"]["command"]["const"]: item for item in plan_schema()["$defs"]["step"]["oneOf"]
                    if "command" in item["properties"]}
        for step in steps:
            self.assertNotIn("expect", variants[step["command"]]["properties"]["input"]["required"])

    def test_refresh_is_boolean_mutation_only_and_cannot_inject_internal_fields(self):
        accepted = validate_plan(plan({**press(), "refresh": True}, {**press(), "refresh": False}, press()))
        self.assertIs(accepted["steps"][0]["refresh"], True)
        self.assertIs(accepted["steps"][1]["refresh"], False)
        self.assertNotIn("refresh", accepted["steps"][2])
        invalid_steps = [{**press(), "refresh": value} for value in (None, 1, 0, "true", [], {})]
        invalid_steps += [{"command": "observe", "refresh": False},
                         {"assert": count_is(0), "refresh": True},
                         {**press(), "input": {**press()["input"], "_plan_refresh": True}}]
        device = FakeDevice()
        for step in invalid_steps:
            with self.subTest(step=step), self.assertRaises(AgentError):
                run_plan(plan({"if": count_is(0), "then": [press()], "else": [step]}),
                         device.execute, device.evaluate)
        self.assertEqual(device.calls, [])
        self.assertEqual(device.conditions, [])

    def test_projection_settings_inherit_run_unless_explicit(self):
        normalized = validate_plan(plan({"command": "observe"},
            {"command": "observe", "input": {"max_nodes": 12, "compact": False, "view": "tree", "interactive": False}}))
        first, second = normalized["steps"]
        self.assertNotIn("max_nodes", first["input"])
        self.assertNotIn("compact", first["input"])
        self.assertNotIn("view", first["input"])
        self.assertNotIn("interactive", first["input"])
        self.assertEqual(second["input"]["max_nodes"], 12)
        self.assertIs(second["input"]["compact"], False)
        self.assertIs(second["input"]["interactive"], False)
        self.assertEqual(second["input"]["view"], "tree")

    def test_rejects_foreign_context_commands_refs_and_bad_conditions(self):
        cases = [
            plan({"command": "attach", "input": {"device": "other"}}),
            plan({"command": "observe", "input": {"session": "other"}}),
            plan({"command": "observe", "input": {"device": "other"}}),
            plan({"command": "press", "input": {"target": "@e1~old", "expect": count_is(1)}}),
            plan({"command": "press", "input": {"target": {"id": "x", "within": {"parent": "@e1~old"}}, "expect": count_is(1)}}),
            plan({"assert": {"selector": {"ref": "@e1~old"}, "equals": "1"}}),
            plan({"assert": {"selector": "bad syntax", "equals": "1"}}),
            plan({"assert": {"selector": {"id": "x"}, "property": "visible", "equals": "false"}}),
            plan({"command": "observe", "input": {"unsupported": 1}}),
            plan({"yield": "why", "stop": "other"}),
            plan({"if": count_is(0), "then": [press()], "unsupported": True}),
            plan({"repeat": {"limit": True, "until": count_is(0), "steps": [press()]}}),
            plan({"stop": ""}),
            plan({"stop": "done"}, unknown=True),
            plan({"stop": "done"}, limits={"maxSteps": False}),
            plan({"stop": "done"}, limits={"timeoutMs": 600001}),
            plan({"stop": "done"}, goals=[{"selector": {"id": "x"}}]),
        ]
        for example in cases:
            with self.subTest(example=example), self.assertRaises(AgentError) as captured:
                validate_plan(example)
            self.assertEqual(captured.exception.code, "INVALID_PLAN")

    def test_definition_size_depth_and_cycles_are_bounded(self):
        for example in [plan(*[{"stop": "x"}] * 201), {"version": 1, "steps": [{"stop": "x"}]}, plan()]:
            with self.assertRaises(AgentError):
                validate_plan(example)
        cycle = {"if": count_is(0)}
        cycle["then"] = [cycle]
        with self.assertRaisesRegex(AgentError, "nesting"):
            validate_plan(plan(cycle))

    def test_schema_is_json_serializable_and_refs_resolve(self):
        schema = json.loads(json.dumps(plan_schema()))
        self.assertEqual(schema["properties"]["version"]["enum"], ["1", "2"])
        self.assertFalse(schema["additionalProperties"])

        def check(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    target = schema
                    for part in value["$ref"].split("/")[1:]:
                        target = target[part]
                for item in value.values():
                    check(item)
            elif isinstance(value, list):
                for item in value:
                    check(item)
        check(schema)


class PlanExecutionTests(unittest.TestCase):
    def setUp(self):
        self.device = FakeDevice()

    def run_plan(self, definition, **kwargs):
        return run_plan(definition, self.device.execute, self.device.evaluate, **kwargs)

    def test_sequence_goals_and_compact_step_records(self):
        events = []
        result = self.run_plan(plan({"command": "observe"}, press(), {"assert": count_is(1)},
                                    goals=[count_is(1)]), checkpoint=events.append)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["goalVerification"]["status"], "passed")
        self.assertEqual(result["counters"]["actions"], 1)
        self.assertEqual(len(result["steps"]), 4)
        self.assertEqual(len(events), 8)
        self.assertNotIn("observation", result["steps"][1]["result"])
        self.assertEqual(result["steps"][1]["result"]["beforeFrameId"], "frame-0")
        self.assertEqual(result["steps"][1]["result"]["afterFrameId"], "frame-1")
        self.assertEqual(result["steps"][1]["result"]["observationSource"], "captured")
        self.assertEqual(result["steps"][1]["result"]["targetFrameAgeMs"], 0)
        self.assertEqual(result["lastResult"]["observation"]["frameId"], "frame-1")

    def test_completion_is_not_implicit_task_success(self):
        result = self.run_plan(plan({"command": "observe"}))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["goalVerification"]["status"], "not_requested")
        self.assertNotIn("taskSuccess", result)

    def test_missing_expect_can_mix_with_explicit_checks_and_final_goals(self):
        unchecked = {"command": "press", "input": {"target": "id=increment"}}
        result = self.run_plan(plan(unchecked, press(), {"command": "back"}, goals=[count_is(2)]))
        self.assertEqual(result["status"], "completed")
        self.assertEqual([step["result"]["assertion"]["status"] for step in result["steps"][:3]],
                         ["not_requested", "passed", "not_requested"])
        self.assertEqual(result["goalVerification"]["status"], "passed")
        self.assertNotIn("taskSuccess", result)
        result = self.run_plan(plan(unchecked))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["goalVerification"]["status"], "not_requested")
        self.assertEqual(result["lastResult"]["assertion"]["status"], "not_requested")

    def test_refresh_true_is_forwarded_only_on_its_step(self):
        result = self.run_plan(plan({**press(), "refresh": True}, {**press(), "refresh": False}, press()))
        self.assertEqual(result["status"], "completed")
        self.assertIs(self.device.calls[0][1]["_plan_refresh"], True)
        self.assertNotIn("_plan_refresh", self.device.calls[1][1])
        self.assertNotIn("_plan_refresh", self.device.calls[2][1])

    def test_fill_always_requires_verified_readback_with_or_without_expect(self):
        fill = {"command": "fill", "input": {"target": "id=message", "text": "hello"}}
        expected = {"selector": {"id": "message"}, "equals": "hello"}
        for explicit in (False, True):
            for status in ("passed", "failed", "unknown", None):
                with self.subTest(explicit=explicit, status=status):
                    calls = []
                    step = deepcopy(fill)
                    if explicit:
                        step["input"]["expect"] = expected

                    def execute(command, params):
                        calls.append(command)
                        result = {"action": {"status": "completed", "dispatched": "acknowledged"},
                                  "assertion": {"status": "passed"}}
                        if status is not None:
                            result["inputVerification"] = {"status": status}
                        return result

                    result = run_plan(plan(step, {"command": "back"}), execute, self.device.evaluate)
                    self.assertEqual(result["status"], "completed" if status == "passed" else "failed" if status == "failed" else "unknown")
                    self.assertEqual(len(calls), 2 if status == "passed" else 1)
                    if status != "passed":
                        self.assertEqual(result["yieldReason"], "input_not_verified")

    def test_unknown_or_missing_postcondition_never_continues(self):
        for explicit in (False, True):
            for status in ("unknown", "failed", None, "not_requested"):
                with self.subTest(explicit=explicit, status=status):
                    calls = []
                    step = press()
                    if not explicit:
                        step["input"].pop("expect")

                    def execute(command, params):
                        calls.append(command)
                        result = {"action": {"status": "completed", "dispatched": "acknowledged"}}
                        if status is not None:
                            result["assertion"] = {"status": status}
                        return result

                    result = run_plan(plan(step, step), execute, self.device.evaluate)
                    accepted = not explicit and status == "not_requested"
                    self.assertEqual(result["status"], "completed" if accepted else "failed" if status == "failed" else "unknown")
                    self.assertEqual(len(calls), 2 if accepted else 1)
                    if not accepted:
                        self.assertEqual(result["yieldReason"], "postcondition_not_verified")

    def test_false_branch_and_explicit_yield(self):
        result = self.run_plan(plan({"if": count_is(2), "then": [press()], "else": [{"yield": "needs a new plan"}]}, press()))
        self.assertEqual(result["status"], "yielded")
        self.assertEqual(result["yieldReason"], "needs a new plan")
        self.assertEqual(self.device.count, 0)

    def test_unknown_branch_never_guesses(self):
        self.device.condition_status = "unknown"
        result = self.run_plan(plan({"if": count_is(0), "then": [press()], "else": [press()]}))
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(self.device.calls, [])

    def test_precondition_failure_prevents_all_commands(self):
        result = self.run_plan(plan(press(), preconditions=[count_is(2)], goals=[count_is(3)]))
        self.assertEqual(result["status"], "yielded")
        self.assertEqual(result["goalVerification"]["status"], "not_run")
        self.assertEqual(self.device.calls, [])

    def test_repeat_evaluates_after_last_iteration(self):
        result = self.run_plan(plan({"repeat": {"limit": 3, "until": count_is(3), "steps": [press()]}}, goals=[count_is(3)]))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.device.count, 3)
        self.assertEqual(result["counters"]["actions"], 3)

    def test_repeat_limit_and_unknown_stop_without_more_actions(self):
        result = self.run_plan(plan({"repeat": {"limit": 2, "until": count_is(3), "steps": [press()]}}, press()))
        self.assertEqual((result["status"], result["yieldReason"]), ("yielded", "repeat_limit"))
        self.assertEqual(self.device.count, 2)
        self.device.condition_status = "unknown"
        result = self.run_plan(plan({"repeat": {"limit": 2, "until": count_is(3), "steps": [press()]}}))
        self.assertEqual(result["yieldReason"], "repeat_condition_unknown")
        self.assertEqual(self.device.count, 2)

    def test_stop_still_checks_goals(self):
        result = self.run_plan(plan({"stop": "enough"}, press(), goals=[count_is(1)]))
        self.assertEqual((result["status"], result["yieldReason"]), ("failed", "goal_not_verified"))
        self.assertEqual(self.device.calls, [])

    def test_step_and_action_budgets_stop_before_later_dispatch(self):
        for limit in ("maxSteps", "maxActions"):
            self.device = FakeDevice()
            result = self.run_plan(plan(press(), press(), limits={limit: 1}))
            self.assertEqual(result["status"], "budget_exhausted")
            self.assertEqual(self.device.count, 1)

    def test_capture_budget_is_shared_with_executor(self):
        definition = plan(press(), press(), limits={"maxCaptures": 1})
        budget = PlanBudget(validate_plan(definition)["limits"])
        self.device.budget = budget
        result = self.run_plan(definition, budget=budget)
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertEqual(result["counters"]["captures"], 1)
        self.assertEqual(self.device.count, 1)

    def test_deadline_preserves_completed_action_and_stops(self):
        clock = FakeClock()
        self.device.clock, self.device.advance = clock, .1
        result = self.run_plan(plan(press(), press(), limits={"timeoutMs": 50}), clock=clock)
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertEqual(self.device.count, 1)
        self.assertEqual(result["steps"][0]["status"], "completed")
        self.assertEqual(result["lastResult"]["action"]["dispatched"], "acknowledged")

    def test_unknown_dispatch_is_not_retried_and_receipt_is_preserved(self):
        self.device.error = AgentError("NATIVE_TIMEOUT", "response missing", dispatched="unknown",
                                       details={"action": {"dispatched": "unknown"}})
        events = []
        result = self.run_plan(plan(press(), press()), checkpoint=events.append)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(self.device.count, 1)
        self.assertEqual(result["error"]["details"]["dispatched"], "unknown")
        self.assertEqual(events[-1]["event"], "step_finished")
        self.assertEqual(events[-1]["error"]["code"], "NATIVE_TIMEOUT")

    def test_returned_postcondition_failure_stops(self):
        self.device.condition_status = "failed"
        result = self.run_plan(plan(press(), press()))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["lastResult"]["assertion"]["status"], "failed")
        self.assertEqual(self.device.count, 1)

    def test_missing_action_confirmation_is_unknown(self):
        result = run_plan(plan(press()), lambda *_: {}, self.device.evaluate)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["yieldReason"], "action_not_confirmed")

    def test_cancelled_and_external_budget_errors_are_mapped(self):
        for error, expected in [(AgentError("CANCELLED", "cancel", dispatched="unknown"), "cancelled"),
                                (AgentError("BUDGET_EXCEEDED", "stop"), "budget_exhausted"),
                                (KeyboardInterrupt(), "cancelled")]:
            self.device = FakeDevice()
            self.device.error = error
            result = self.run_plan(plan(press(), press()))
            self.assertEqual(result["status"], expected)
            self.assertEqual(self.device.count, 1)

    def test_checkpoint_failure_before_dispatch_prevents_action(self):
        def checkpoint(event):
            raise OSError("disk unavailable")
        result = self.run_plan(plan(press()), checkpoint=checkpoint)
        self.assertEqual(result["error"]["code"], "PLAN_CHECKPOINT_FAILED")
        self.assertEqual(self.device.calls, [])
        self.assertEqual(result["counters"]["actions"], 0)

    def test_checkpoint_failure_after_dispatch_keeps_actual_result(self):
        def checkpoint(event):
            if event["event"] == "step_finished":
                raise OSError("disk unavailable")
        result = self.run_plan(plan(press(), press()), checkpoint=checkpoint)
        self.assertEqual(result["error"]["code"], "PLAN_CHECKPOINT_FAILED")
        self.assertEqual(self.device.count, 1)
        self.assertEqual(result["steps"][0]["status"], "completed")
        self.assertEqual(result["lastResult"]["action"]["dispatched"], "acknowledged")
        self.assertEqual(result["error"]["details"]["action"]["dispatched"], "acknowledged")
        self.assertEqual(result["error"]["details"]["dispatched"], "unknown")

    def test_checkpoint_failure_does_not_erase_original_device_error(self):
        self.device.error = AgentError("NATIVE_TIMEOUT", "reply lost", dispatched="unknown")
        def checkpoint(event):
            if event["event"] == "step_finished":
                raise OSError("disk unavailable")
        result = self.run_plan(plan(press(), press()), checkpoint=checkpoint)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["error"]["code"], "NATIVE_TIMEOUT")
        self.assertTrue(result["warnings"])
        self.assertEqual(self.device.count, 1)

    def test_invalid_condition_response_cannot_select_else_branch(self):
        result = run_plan(plan({"if": count_is(0), "then": [press()], "else": [press()]}),
                          self.device.execute, lambda _: False)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.device.calls, [])

    def test_before_guards_reach_executor_and_stop_after_state_changes(self):
        guarded = {**press(), "before": [count_is(0)]}
        result = self.run_plan(plan(guarded, guarded, press()))
        self.assertEqual(result["status"], "failed")
        self.assertEqual(self.device.count, 1)
        self.assertEqual(len(self.device.calls), 2)
        self.assertEqual(self.device.calls[0][1]["_plan_before"][0]["equals"], "0")
        self.assertEqual(result["steps"][0]["result"]["guardAssertions"][0]["status"], "passed")
        self.assertEqual(result["error"]["details"]["dispatched"], "no")

    def test_before_guards_validate_all_branches_before_execution(self):
        for invalid in [
            {**press(), "before": {"selector": {"id": "x"}, "equals": "yes"}},
            {**press(), "before": [count_is(0)] * 17},
            {**press(), "before": [{"selector": {"ref": "@e1~old"}, "equals": "yes"}]},
            {"command": "observe", "before": [count_is(0)]},
            {**press(), "input": {**press()["input"], "_plan_before": [count_is(0)]}},
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(AgentError):
                self.run_plan(plan({"if": count_is(0), "then": [press()], "else": [invalid]}))
        self.assertEqual(self.device.calls, [])
        self.assertEqual(self.device.conditions, [])


if __name__ == "__main__":
    unittest.main()
