"""Closed data flow executes known workflows without another model decision."""

from copy import deepcopy
import json
import unittest

from harmony_agent.errors import AgentError
from harmony_agent.plans import plan_schema, run_plan, validate_plan


def read(name="token", target="source", **extra):
    return {"read": {"name": name, "selector": {"id": target}, **extra}}


def fill(value, target="destination", **extra):
    return {"command": "fill", "input": {"target": {"id": target}, "text": value}, **extra}


def condition(value, target="destination", **extra):
    return {"selector": {"id": target}, "equals": value, **extra}


def plan(*steps, **extra):
    return {"version": "2", "steps": list(steps), **extra}


class DataDevice:
    def __init__(self, **values):
        self.values = {"source": "Code: NEW-741", "destination": "", "count": "0", "ready": False, **values}
        self.reads, self.commands, self.conditions = [], [], []

    def read(self, spec):
        self.reads.append(deepcopy(spec))
        return {"value": self.values[spec["selector"]["id"]], "frameId": "frame-" + str(len(self.reads)),
                "evidenceRef": {"local": "frame-evidence"}}

    def evaluate(self, value):
        self.conditions.append(deepcopy(value))
        actual = self.values[value["selector"]["id"]]
        passed = type(actual) is type(value["equals"]) and actual == value["equals"]
        return {"status": "passed" if passed else "failed", "actual": actual, "expected": value["equals"]}

    def execute(self, command, inputs):
        self.commands.append((command, deepcopy(inputs)))
        for item in inputs.get("_plan_before", []):
            if self.evaluate(item)["status"] != "passed":
                raise AgentError("PLAN_GUARD_FAILED", "A supplied condition did not pass.")
        if command == "fill":
            self.values[inputs["target"]["id"]] = inputs["text"]
        elif command == "press":
            self.values["count"] = str(int(self.values["count"]) + 1)
        assertion = self.evaluate(inputs["expect"]) if "expect" in inputs else {"status": "passed" if command in {"fill", "wait"} else "not_requested"}
        return {"action": {"status": "completed", "dispatched": "acknowledged"},
                "assertion": assertion, "inputVerification": {"status": "passed"},
                "afterFrameId": "after-action"}


class PlanBindingsTests(unittest.TestCase):
    def run_workflow(self, definition, device=None, **options):
        device = device or DataDevice()
        return run_plan(definition, device.execute, device.evaluate, reader=device.read, **options), device

    def test_dynamic_text_is_read_copied_and_verified_in_one_run(self):
        definition = plan(read(stripPrefix="Code: "), fill({"var": "token"}),
                          goals=[condition({"var": "token"})])
        for value in ("Code: FIRST-123", "Code: ", "Code: 中文确认", "Code: ${not_a_template}"):
            with self.subTest(value=value):
                result, device = self.run_workflow(definition, DataDevice(source=value))
                self.assertEqual(result["status"], "completed")
                self.assertEqual(result["goalVerification"]["status"], "passed")
                self.assertEqual(device.values["destination"], value[len("Code: "):])
                self.assertEqual(len(device.reads), 1)
                self.assertEqual(len(device.commands), 1)
                self.assertEqual(result["planVersion"], "2")

    def test_concat_and_repeat_use_a_runtime_read_target(self):
        definition = plan(read("needed", "required", stripPrefix="Required: "),
                          {"repeat": {"limit": 5, "until": condition({"var": "needed"}, "count"),
                                      "steps": [{"command": "press", "input": {"target": {"id": "increment"}}}]}},
                          fill({"concat": ["Reached ", {"var": "needed"}, " items"]}),
                          goals=[condition({"concat": ["Reached ", {"var": "needed"}, " items"]})])
        result, device = self.run_workflow(definition, DataDevice(required="Required: 3"))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(device.values["count"], "3")
        self.assertEqual(device.values["destination"], "Reached 3 items")
        self.assertEqual(result["counters"]["actions"], 4)

    def test_bool_false_remains_false_in_if_wait_before_and_expect(self):
        definition = plan(read("flag", "ready", property="checked"),
                          {"if": condition({"var": "flag"}, "ready", property="checked"),
                           "then": [{"command": "wait", "input": {"target": {"id": "ready"},
                                      "property": "checked", "equals": {"var": "flag"}}}],
                           "else": [{"stop": "wrong branch"}]},
                          {"command": "press", "input": {"target": {"id": "increment"},
                           "expect": condition({"var": "flag"}, "ready", property="checked")},
                           "before": [condition({"var": "flag"}, "ready", property="checked")]},
                          goals=[condition({"var": "flag"}, "ready", property="checked")])
        result, device = self.run_workflow(definition)
        self.assertEqual(result["status"], "completed")
        self.assertIs(device.commands[0][1]["equals"], False)
        self.assertIs(device.commands[1][1]["expect"]["equals"], False)
        self.assertIs(device.commands[1][1]["_plan_before"][0]["equals"], False)

    def test_read_rebinding_observes_new_values_on_each_repeat(self):
        definition = plan({"repeat": {"limit": 3, "until": condition("2", "count"), "steps": [
            read("current", "count"), fill({"var": "current"}),
            {"command": "press", "input": {"target": {"id": "increment"}}}]}},
            goals=[condition("1")])
        result, device = self.run_workflow(definition)
        self.assertEqual(result["status"], "completed")
        self.assertEqual([inputs["text"] for cmd, inputs in device.commands if cmd == "fill"], ["0", "1"])

    def test_unexecuted_binding_branch_stops_before_using_its_value(self):
        definition = plan({"if": condition(True, "ready", property="checked"),
                           "then": [read()], "else": []}, fill({"var": "token"}))
        result, device = self.run_workflow(definition)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["error"]["code"], "PLAN_BINDING_FAILED")
        self.assertEqual(device.commands, [])
        self.assertEqual(device.reads, [])

    def test_references_are_run_local(self):
        device = DataDevice()
        self.run_workflow(plan(read(), fill({"var": "token"})), device)
        device.commands.clear()
        result, _ = self.run_workflow(plan(fill({"var": "token"}), read()), device)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(device.commands, [])

    def test_undeclared_reference_in_unselected_branch_rejected_before_callbacks(self):
        definition = plan({"if": condition(False, "ready", property="checked"),
                           "then": [fill("literal")], "else": [fill({"var": "missing"})]})
        device = DataDevice()
        with self.assertRaises(AgentError) as caught:
            self.run_workflow(definition, device)
        self.assertEqual(caught.exception.code, "INVALID_PLAN")
        self.assertEqual((device.reads, device.commands, device.conditions), ([], [], []))

    def test_type_conflicts_and_executable_expression_shapes_rejected_statically(self):
        invalid_steps = [
            [read("token", "ready", property="checked"), fill({"var": "token"})],
            [read(), {"assert": condition({"var": "token"}, "ready", property="checked")}],
            [read(), fill({"concat": [{"concat": ["nested"]}]})],
            [read(), fill({"eval": "1+1"})],
            [read(), fill({"var": "token", "code": "run()"})],
            [read(), {"command": {"var": "token"}, "input": {}}],
            [read(), {"command": "press", "input": {"target": {"var": "token"}}}],
            [read(), {"command": "open", "input": {"app": {"var": "token"}}}],
            [read(), read("token", "ready", property="checked")],
            [read("bad.name")],
            [read("x" * 65)],
            [read(property="checked", stripPrefix="prefix")],
            [read(stripPrefix={"var": "token"})],
            [read(), fill({"concat": []})],
            [read(), fill({"concat": ["x"] * 33})],
        ]
        for steps in invalid_steps:
            with self.subTest(steps=steps):
                device = DataDevice()
                with self.assertRaises(AgentError):
                    self.run_workflow(plan(*steps), device)
                self.assertEqual(device.reads + device.commands + device.conditions, [])

    def test_version_one_rejects_read_and_expressions(self):
        for definition in (plan(read()), plan(fill({"var": "token"})),
                           plan({"assert": condition({"var": "token"})})):
            definition["version"] = "1"
            with self.subTest(definition=definition), self.assertRaises(AgentError):
                validate_plan(definition)

    def test_literal_behavior_remains_unchanged_in_both_versions(self):
        for version in ("1", "2"):
            literal = "${token} __import__('os') " + "x" * 20001
            definition = plan(fill(literal), goals=[condition(literal)])
            definition["version"] = version
            result, device = self.run_workflow(definition)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["planVersion"], version)
            self.assertEqual(device.values["destination"], literal)

    def test_prefix_mismatch_and_bad_source_types_stop_without_a_mutation(self):
        for value in ("code: lower-case", "text Code: not-start", None, False, 1):
            with self.subTest(value=value):
                result, device = self.run_workflow(plan(read(stripPrefix="Code: "), fill({"var": "token"})),
                                                   DataDevice(source=value))
                self.assertEqual(result["status"], "unknown")
                self.assertEqual(result["error"]["code"], "PLAN_BINDING_FAILED")
                self.assertEqual(device.commands, [])

    def test_missing_reader_or_missing_frame_never_dispatched(self):
        definition = plan(read(), fill({"var": "token"}))
        device = DataDevice()
        no_reader = run_plan(definition, device.execute, device.evaluate)
        self.assertEqual(no_reader["status"], "unknown")
        bad_frame = run_plan(definition, device.execute, device.evaluate, reader=lambda spec: {"value": "x"})
        self.assertEqual(bad_frame["status"], "unknown")
        self.assertEqual(device.commands, [])

    def test_reader_ambiguity_preserves_error_and_stops_subsequent_actions(self):
        device = DataDevice()
        def ambiguous(spec):
            raise AgentError("PLAN_READ_FAILED", "More than one source matches.",
                             details={"matches": 2}, dispatched="no")
        result = run_plan(plan(read(), fill({"var": "token"})), device.execute, device.evaluate, reader=ambiguous)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["error"]["details"]["matches"], 2)
        self.assertEqual(device.commands, [])

    def test_read_counts_one_step_and_zero_actions_and_obeys_budget(self):
        result, device = self.run_workflow(plan(read(), fill({"var": "token"}), limits={"maxSteps": 1}))
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertEqual(result["counters"]["steps"], 1)
        self.assertEqual(result["counters"]["actions"], 0)
        self.assertEqual(device.commands, [])

    def test_read_journal_retains_source_identity_and_transformed_value(self):
        events = []
        result, device = self.run_workflow(plan(read(stripPrefix="Code: "), fill({"var": "token"})), checkpoint=events.append)
        self.assertEqual(result["status"], "completed")
        start, end = events[:2]
        self.assertEqual((start["kind"], start["event"]), ("read", "step_started"))
        self.assertEqual(end["result"], {"name": "token", "value": "NEW-741", "frameId": "frame-1",
                         "selector": {"id": "source"}, "property": "text", "stripPrefix": "Code: ",
                         "evidenceRef": {"local": "frame-evidence"}})

    def test_read_checkpoint_failure_does_not_allow_following_mutation(self):
        for failed_event in ("step_started", "step_finished"):
            device = DataDevice()
            def checkpoint(event):
                if event["kind"] == "read" and event["event"] == failed_event:
                    raise OSError("synthetic journal failure")
            result, _ = self.run_workflow(plan(read(), fill({"var": "token"})), device, checkpoint=checkpoint)
            self.assertEqual(result["status"], "failed")
            self.assertEqual(device.commands, [])
            self.assertEqual(len(device.reads), int(failed_event == "step_finished"))

    def test_normalization_does_not_mutate_original_and_all_refs_resolve(self):
        definition = plan(read(stripPrefix="Code: "), fill({"var": "token"}), goals=[condition({"var": "token"})])
        original = deepcopy(definition)
        normalized = validate_plan(definition)
        self.assertEqual(definition, original)
        self.assertEqual(normalized["steps"][1]["input"]["text"], {"var": "token"})
        schema = json.loads(json.dumps(plan_schema()))
        self.assertEqual(schema["properties"]["version"]["enum"], ["1", "2"])
        self.assertTrue(any("read" in item["properties"] for item in schema["$defs"]["step"]["oneOf"]))
        self.assertFalse(any("read" in item["properties"] for item in schema["$defs"]["v1Step"]["oneOf"]))
        def check(value):
            if isinstance(value, dict):
                if "$ref" in value:
                    self.assertIn(value["$ref"].removeprefix("#/$defs/"), schema["$defs"])
                for item in value.values(): check(item)
            elif isinstance(value, list):
                for item in value: check(item)
        check(schema)


if __name__ == "__main__":
    unittest.main()
