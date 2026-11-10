import io
import json
import re
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from harmony_agent.cli import main
from harmony_agent import DEFAULT_INPUT_TIMEOUT_MS
from harmony_agent.errors import AgentError
from harmony_agent.schema import COMMANDS, request_schema, validate_params, validate_request


class FakeAgent:
    calls = []
    failure = None

    def __init__(self, **kwargs):
        self.options = kwargs

    def execute(self, command, params):
        self.calls.append((command, params, self.options))
        if self.failure:
            raise self.failure
        return {"command": command, "input": params}


class CliTests(unittest.TestCase):
    def setUp(self):
        FakeAgent.calls.clear()
        FakeAgent.failure = None

    def run_cli(self, *args):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = main(list(args), agent_factory=FakeAgent)
        return code, stdout.getvalue(), stderr.getvalue()

    def request_file(self, request):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "request.json"
        path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
        return str(path)

    def assert_error(self, args, code="INVALID_ARGUMENT"):
        status, out, err = self.run_cli(*args, "--json")
        self.assertNotEqual(status, 0)
        result = json.loads(out)
        self.assertFalse(result["success"])
        self.assertEqual(result["error"]["code"], code)
        self.assertEqual(err, "")
        self.assertEqual(FakeAgent.calls, [])
        return result

    def test_globals_before_and_after_command_are_retained(self):
        code, out, err = self.run_cli("--session", "first", "--hdc", "some hdc", "--json", "observe", "--device", "serial", "--max-nodes", "4")
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertTrue(json.loads(out)["success"])
        command, params, options = FakeAgent.calls[0]
        self.assertEqual(command, "observe")
        self.assertEqual(params["session"], "first")
        self.assertEqual(params["device"], "serial")
        self.assertEqual(params["max_nodes"], 4)
        self.assertEqual(options["hdc_path"], "some hdc")

    def test_globals_after_command_override_earlier_value(self):
        self.run_cli("--session", "before", "observe", "--session", "after", "--json")
        self.assertEqual(FakeAgent.calls[0][1]["session"], "after")

    def test_help_and_version_do_not_create_agent(self):
        for args in [("press", "--help", "--json"), ("help", "fill", "--json"), ("--version", "--json")]:
            with self.subTest(args=args):
                code, out, err = self.run_cli(*args)
                self.assertEqual(code, 0)
                self.assertTrue(json.loads(out)["success"])
                self.assertEqual(err, "")
        self.assertEqual(FakeAgent.calls, [])

    def test_unknown_parameter_is_structured(self):
        result = self.assert_error(["wait", "id=x", "--equals", "x", "--timeout", "10"])
        self.assertEqual(result["error"]["details"]["dispatched"], "no")

    def test_missing_target_does_not_execute(self):
        self.assert_error(["press"])

    def test_attach_requires_explicit_device(self):
        self.assert_error(["attach"])

    def test_number_bounds_and_direction(self):
        for args in [("observe", "--max-nodes", "0"), ("wait", "id=x", "--equals", "x", "--timeout-ms", "-1"), ("scroll", "diagonal")]:
            with self.subTest(args=args):
                self.assert_error(args)

    def test_unicode_and_empty_fill(self):
        for text in ("你好 42 🙂", ""):
            with self.subTest(text=text):
                code, out, _ = self.run_cli("fill", "id=input", text, "--json")
                self.assertEqual(code, 0)
                self.assertEqual(json.loads(out)["data"]["input"]["text"], text)

    def test_text_numeric_value_stays_string(self):
        self.run_cli("wait", "id=count", "--equals", "123", "--json")
        self.assertEqual(FakeAgent.calls[0][1]["equals"], "123")

    def test_boolean_wait_converts_cli_string(self):
        self.run_cli("wait", "id=switch", "--property", "checked", "--equals", "false", "--json")
        self.assertIs(FakeAgent.calls[0][1]["equals"], False)

    def test_bad_boolean_condition_does_not_execute(self):
        self.assert_error(["wait", "id=switch", "--property", "checked", "--equals", "maybe"])

    def test_expect_validates_nested_types(self):
        for expect in [
            {"selector": "id=x", "equals": "ok", "timeoutMs": True},
            {"selector": {"checked": "false"}, "equals": "ok"},
            {"selector": "id=x", "property": "checked", "equals": "true"},
            {"selector": "id=x", "equals": "ok", "timeout": 5},
            {"selector": "id=x", "property": "unknown", "equals": "ok"},
        ]:
            with self.subTest(expect=expect):
                self.assert_error(["press", "id=x", "--expect", json.dumps(expect)])

    def test_flat_and_nested_requests_have_equal_semantics(self):
        payload = {"target": {"id": "input", "within": {"id": "form"}}, "text": "你好", "session": "r"}
        for request in [{"command": "fill", **payload}, {"schemaVersion": "1", "command": "fill", "input": payload}]:
            path = self.request_file(request)
            code, out, err = self.run_cli("--request", path, "--json")
            self.assertEqual(code, 0)
            self.assertEqual(err, "")
            self.assertEqual(json.loads(out)["data"]["input"]["target"], payload["target"])
        self.assertEqual(FakeAgent.calls[0][1], FakeAgent.calls[1][1])

    def test_request_unknown_fields_are_rejected(self):
        for request in [{"command": "observe", "input": {"typo": 1}}, {"command": "observe", "input": {}, "session": "mixed"}, {"schemaVersion": "99", "command": "observe"}, {"command": "observe", "max_nodes": True}]:
            with self.subTest(request=request):
                self.assert_error(["--request", self.request_file(request)])

    def test_request_invalid_json_is_structured(self):
        path = self.request_file({})
        Path(path).write_text("{broken", encoding="utf-8")
        self.assert_error(["--request", path], code="INVALID_REQUEST")

    def test_request_context_can_be_supplied_or_overridden_by_cli(self):
        for request in [{"command": "attach"}, {"command": "attach", "input": {"session": "old"}}]:
            with self.subTest(request=request):
                code, out, err = self.run_cli("--request", self.request_file(request), "--device", "serial", "--session", "new", "--json")
                self.assertEqual(code, 0)
                self.assertEqual(err, "")
                self.assertEqual(json.loads(out)["data"]["input"]["device"], "serial")
                self.assertEqual(FakeAgent.calls[-1][1]["session"], "new")

    def test_core_unknown_dispatch_is_preserved(self):
        FakeAgent.failure = AgentError("TRANSPORT_TIMEOUT", "Response lost", dispatched="unknown", details={"operationId": "op1"})
        code, out, err = self.run_cli("press", "id=x", "--json")
        result = json.loads(out)
        self.assertEqual(code, 1)
        self.assertEqual(result["error"]["details"]["dispatched"], "unknown")
        self.assertEqual(result["error"]["details"]["operationId"], "op1")
        self.assertEqual(len(FakeAgent.calls), 1)
        self.assertEqual(err, "")

    def test_schema_is_derived_for_every_command(self):
        schema = request_schema()
        self.assertEqual(len(schema["oneOf"]), 2 * len(COMMANDS))
        code, out, err = self.run_cli("schema", "fill", "--json")
        self.assertEqual(code, 0)
        self.assertEqual(len(json.loads(out)["data"]["oneOf"]), 2)
        self.assertEqual(err, "")
        self.assertEqual(FakeAgent.calls, [])

    def test_original_text_selectors_are_supported_in_cli_requests_and_schema(self):
        code, out, err = self.run_cli("press", "originalText=確認", "--json")
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual("originalText=確認", json.loads(out)["data"]["input"]["target"])
        request = {"command": "wait", "input": {
            "target": {"originalText": "Visible label", "within": {"id": "panel"}},
            "equals": "Accessible label"}}
        code, out, err = self.run_cli("--request", self.request_file(request), "--json")
        self.assertEqual(code, 0)
        self.assertEqual(err, "")
        self.assertEqual(request["input"]["target"], json.loads(out)["data"]["input"]["target"])
        schema = request_schema("wait")
        for name in ("selector", "stableSelector"):
            self.assertEqual({"type": "string"}, schema["$defs"][name]["oneOf"][1]["properties"]["originalText"])

    def test_condition_schema_excludes_frame_dependencies_recursively(self):
        for command in ("wait", "press"):
            schema = request_schema(command)
            stable = schema["$defs"]["stableSelector"]
            text_pattern = stable["oneOf"][0]["pattern"]
            for value in ("@e1~frame", "ref=@e1~frame", "parent=@e1~frame",
                          "within=ref=@e1~frame", "within=within=@e1~frame"):
                self.assertIsNone(re.search(text_pattern, value), value)
            for value in ("id=counter", "text=Ready", "within=id=form"):
                self.assertIsNotNone(re.search(text_pattern, value), value)
            properties = stable["oneOf"][1]["properties"]
            self.assertNotIn("ref", properties)
            self.assertNotIn("parent", properties)
            self.assertEqual(properties["within"], {"$ref": "#/$defs/stableSelector"})
            self.assertEqual(schema["$defs"]["expect"]["properties"]["selector"],
                             {"$ref": "#/$defs/stableSelector"})
            if command == "wait":
                for variant in schema["oneOf"]:
                    props = variant["properties"]
                    fields = props["input"]["properties"] if "input" in props else props
                    self.assertEqual(fields["target"]["$ref"], "#/$defs/stableSelector")

    def test_cancellation_returns_one_json_error_and_never_retries(self):
        FakeAgent.failure = KeyboardInterrupt()
        code, out, err = self.run_cli("press", "id=x", "--json")
        result = json.loads(out)
        self.assertEqual(code, 130)
        self.assertFalse(result["success"])
        self.assertEqual(result["error"]["code"], "CANCELLED")
        self.assertEqual(result["error"]["details"]["dispatched"], "unknown")
        self.assertEqual(len(FakeAgent.calls), 1)
        self.assertEqual(err, "")

    def test_timeout_defaults_match_cli_requests_schema_and_help(self):
        self.assertEqual(DEFAULT_INPUT_TIMEOUT_MS, 15000)
        cases = [
            ("fill", {"target": "id=input", "text": "replacement"}, ["id=input", "replacement"], 15000),
            ("wait", {"target": "id=output", "equals": "done"}, ["id=output", "--equals", "done"], 5000),
            ("press", {"target": "id=submit"}, ["id=submit"], 5000),
        ]
        for command, params, arguments, expected in cases:
            with self.subTest(command=command):
                self.assertEqual(validate_params(command, params)["timeout_ms"], expected)
                for payload in ({"command": command, **params}, {"command": command, "input": params}):
                    self.assertEqual(validate_request(payload)[1]["timeout_ms"], expected)
                    code, out, err = self.run_cli("--request", self.request_file(payload), "--json")
                    self.assertEqual(code, 0)
                    self.assertEqual(json.loads(out)["data"]["input"]["timeout_ms"], expected)
                    self.assertEqual(err, "")
                code, out, err = self.run_cli(command, *arguments, "--json")
                self.assertEqual(code, 0)
                self.assertEqual(json.loads(out)["data"]["input"]["timeout_ms"], expected)
                self.assertEqual(err, "")
                schema = request_schema(command)
                for variant in schema["oneOf"]:
                    props = variant["properties"]
                    fields = props["input"]["properties"] if "input" in props else props
                    self.assertEqual(fields["timeout_ms"]["default"], expected)
                self.assertEqual(schema["$defs"]["expect"]["properties"]["timeoutMs"]["default"], 5000)
                code, out, _ = self.run_cli("help", command, "--json")
                self.assertEqual(code, 0)
                help_text = " ".join(json.loads(out)["data"]["help"].split())
                self.assertIn(f"default: {expected}", help_text)

    def test_explicit_input_and_expectation_budgets_are_preserved(self):
        expect = {"selector": "id=result", "equals": "saved", "timeoutMs": 4321}
        payload = {"command": "fill", "input": {
            "target": "id=input", "text": "replacement", "timeout_ms": 1234, "expect": expect}}
        _, params = validate_request(payload)
        self.assertEqual(params["timeout_ms"], 1234)
        self.assertEqual(params["expect"]["timeoutMs"], 4321)
        for args in (["--request", self.request_file(payload)],
                     ["fill", "id=input", "replacement", "--timeout-ms", "1234", "--expect", json.dumps(expect)]):
            with self.subTest(args=args):
                code, out, err = self.run_cli(*args, "--json")
                self.assertEqual(code, 0)
                self.assertEqual(err, "")
                actual = json.loads(out)["data"]["input"]
                self.assertEqual(actual["timeout_ms"], 1234)
                self.assertEqual(actual["expect"]["timeoutMs"], 4321)

    def test_nested_request_boolean_is_not_coerced(self):
        with self.assertRaises(AgentError):
            validate_request({"command": "wait", "target": "id=x", "property": "checked", "equals": "false"})

    def test_request_and_command_are_mutually_exclusive(self):
        self.assert_error(["observe", "--request", self.request_file({"command": "observe"})])


if __name__ == "__main__":
    unittest.main()
