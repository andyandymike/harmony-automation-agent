import io
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest

from harmony_agent.errors import AgentError
from harmony_agent.mcp import McpServer, PROTOCOL_VERSION, READ_ONLY_COMMANDS, _prune_definitions, serve
from harmony_agent.schema import COMMANDS, request_schema


def request(method, params=None, request_id=1):
    value = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if request_id is not None:
        value["id"] = request_id
    return value


def initialize(server):
    result = server.handle(request("initialize", {"protocolVersion": PROTOCOL_VERSION,
                           "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}))
    server.handle(request("notifications/initialized", request_id=None))
    return result


class FakeAgent:
    def __init__(self, **kwargs):
        self.calls = []
        self.options = kwargs
        self.cancel_event = threading.Event()
        self.failure = None

    def clear_cancel(self):
        self.cancel_event.clear()

    def request_cancel(self):
        self.cancel_event.set()

    def execute(self, command, params):
        self.calls.append((command, params))
        if self.failure:
            raise self.failure
        return {"command": command, "input": params}


class McpTests(unittest.TestCase):
    def server(self, **kwargs):
        result = McpServer(agent_factory=FakeAgent, **kwargs)
        initialize(result)
        return result

    def test_initialize_negotiates_supported_version(self):
        server = McpServer()
        response = server.handle(request("initialize", {"protocolVersion": "future",
                                 "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}))
        self.assertEqual(response["result"]["protocolVersion"], PROTOCOL_VERSION)
        self.assertIn("tools", response["result"]["capabilities"])
        self.assertIsNone(server._agent)

    def test_lifecycle_and_ping(self):
        server = McpServer()
        self.assertEqual(server.handle(request("tools/list"))["error"]["code"], -32002)
        self.assertEqual(server.handle(request("ping"))["result"], {})
        initialize(server)
        self.assertEqual(server.handle(request("initialize"))["error"]["code"], -32600)
        self.assertEqual(server.handle(request("missing"))["error"]["code"], -32601)

    def test_invalid_message_and_notifications(self):
        server = self.server()
        for value in ([], None, {"method": "ping"}, request("ping", request_id=True)):
            self.assertEqual(server.handle(value)["error"]["code"], -32600)
        self.assertIsNone(server.handle(request("unknown-notification", request_id=None)))
        bad = request("ping")
        bad["params"] = []
        self.assertEqual(server.handle(bad)["error"]["code"], -32602)

    def test_tools_derive_valid_schemas_without_device(self):
        server = self.server()
        tools = server.handle(request("tools/list"))["result"]["tools"]
        self.assertEqual({x["name"] for x in tools}, {"harmony_" + x for x in COMMANDS if x != "help"})
        press = next(x for x in tools if x["name"] == "harmony_press")
        self.assertIn("target", press["inputSchema"]["required"])
        self.assertIn("selector", press["inputSchema"]["$defs"])
        self.assertFalse(press["annotations"]["readOnlyHint"])
        self.assertIsNone(server._agent)

    def test_unknown_cursor_rejected(self):
        self.assertEqual(self.server().handle(request("tools/list", {"cursor": "bad"}))["error"]["code"], -32602)

    def test_all_tool_schema_references_resolve(self):
        for tool in self.server().tools():
            schema = tool["inputSchema"]

            def visit(value):
                if isinstance(value, dict):
                    if "$ref" in value:
                        reference = value["$ref"]
                        self.assertTrue(reference.startswith("#/"), reference)
                        target = schema
                        for part in reference[2:].split("/"):
                            target = target[part.replace("~1", "/").replace("~0", "~")]
                    for item in value.values():
                        visit(item)
                elif isinstance(value, list):
                    for item in value:
                        visit(item)

            visit(schema)

    def test_tool_schemas_keep_only_reachable_definitions(self):
        for read_only in (False, True):
            tools = self.server(read_only=read_only).tools()
            for tool in tools:
                original = request_schema(tool["name"][8:])
                inputs = original["oneOf"][0]["properties"]["input"]
                schema = tool["inputSchema"]
                self.assertEqual({key: value for key, value in schema.items() if key != "$defs"}, inputs)
                for name, definition in schema.get("$defs", {}).items():
                    self.assertEqual(definition, original["$defs"][name])
            by_name = {tool["name"]: tool["inputSchema"] for tool in tools}
            self.assertNotIn("$defs", by_name["harmony_schema"])
            self.assertNotIn("$defs", by_name["harmony_report"])
            self.assertEqual(set(by_name["harmony_inspect"]["$defs"]), {"selector"})
            if not read_only:
                self.assertNotIn("$defs", by_name["harmony_claim"])

    def test_definition_pruning_retains_recursive_and_transitive_refs(self):
        schema = {"$ref": "#/$defs/a", "$defs": {
            "a": {"properties": {"child": {"$ref": "#/$defs/b/properties/value"}}},
            "b": {"properties": {"value": {"$ref": "#/$defs/a"}, "escaped": {"$ref": "#/$defs/c~1d"}}},
            "c/d": {"type": "string"}, "unused": {"type": "null"}}}
        result = _prune_definitions(schema)
        self.assertEqual(set(result["$defs"]), {"a", "b", "c/d"})
        self.assertEqual(result["$defs"]["b"]["properties"]["value"], {"$ref": "#/$defs/a"})

    def test_readonly_is_enforced_for_hidden_tools(self):
        server = self.server(read_only=True)
        names = {tool["name"] for tool in server.tools()}
        self.assertEqual(names, {"harmony_" + x for x in COMMANDS if x in READ_ONLY_COMMANDS})
        for command in ("press", "observe", "screenshot", "attach", "run", "doctor"):
            result = server.handle(request("tools/call", {"name": "harmony_" + command, "arguments": {}}))
            self.assertEqual(result["error"]["code"], -32602)
        self.assertIsNone(server._agent)

    def test_call_unicode_empty_values_and_result_parity(self):
        server = self.server(state_dir="a folder", hdc_path="sdk path/hdc")
        for value in ("", "示例"):
            response = server.handle(request("tools/call", {"name": "harmony_fill", "arguments": {
                "target": {"id": "message"}, "text": value}}))["result"]
            self.assertFalse(response["isError"])
            envelope = response["structuredContent"]
            self.assertEqual(json.loads(response["content"][0]["text"]), envelope)
            self.assertEqual(envelope["data"]["input"]["text"], value)
        self.assertEqual(server.agent.options, {"state_dir": "a folder", "hdc_path": "sdk path/hdc"})

    def test_bad_arguments_never_dispatch(self):
        server = self.server()
        response = server.handle(request("tools/call", {"name": "harmony_press", "arguments": {"wrong": 1}}))["result"]
        self.assertTrue(response["isError"])
        self.assertEqual(response["structuredContent"]["error"]["code"], "INVALID_ARGUMENT")
        self.assertIsNone(server._agent)

    def test_unknown_dispatch_error_is_preserved(self):
        server = self.server()
        server.agent.failure = AgentError("ASSERTION_TIMEOUT", "Not observed.", dispatched="unknown",
                                         details={"action": {"dispatched": "acknowledged"}})
        result = server.handle(request("tools/call", {"name": "harmony_press", "arguments": {"target": "id=next"}}))["result"]
        self.assertTrue(result["isError"])
        details = result["structuredContent"]["error"]["details"]
        self.assertEqual(details["dispatched"], "unknown")
        self.assertEqual(details["action"]["dispatched"], "acknowledged")
        self.assertEqual(len(server.agent.calls), 1)

    def test_schema_does_not_construct_agent(self):
        server = self.server(read_only=True)
        result = server.handle(request("tools/call", {"name": "harmony_schema", "arguments": {"command_name": "fill"}}))["result"]
        self.assertFalse(result["isError"])
        self.assertIsNone(server._agent)

    def test_stdio_parse_error_and_sync_requests(self):
        sink = io.StringIO()
        source = io.StringIO("bad json\n" + json.dumps(request("ping")) + "\n")
        self.assertEqual(serve(McpServer(), source, sink), 0)
        lines = [json.loads(x) for x in sink.getvalue().splitlines()]
        self.assertEqual(lines[0]["error"]["code"], -32700)
        self.assertEqual(lines[1]["result"], {})

    def test_cancellation_of_active_request_and_busy_rejection(self):
        started = threading.Event()

        class SlowAgent(FakeAgent):
            def execute(self, command, params):
                self.calls.append((command, params))
                started.set()
                if not self.cancel_event.wait(3):
                    raise AssertionError("Cancellation was not received")
                raise AgentError("CANCELLED", "Stopped before the next operation.", dispatched="unknown")

        server = McpServer(agent_factory=SlowAgent)
        initialize(server)
        messages = [request("tools/call", {"name": "harmony_observe"}, 7),
                    request("tools/call", {"name": "harmony_observe"}, 8),
                    request("notifications/cancelled", {"requestId": 99}, None),
                    request("ping", request_id=9),
                    request("notifications/cancelled", {"requestId": 7}, None)]

        class Source:
            index = 0

            def readline(self, limit):
                if self.index == 1:
                    if not started.wait(2):
                        raise AssertionError("Worker did not start")
                if self.index == 4 and server.agent.cancel_event.is_set():
                    raise AssertionError("A cancellation with a different request ID was applied")
                if self.index == len(messages):
                    return ""
                line = json.dumps(messages[self.index]) + "\n"
                self.index += 1
                return line

        sink = io.StringIO()
        self.assertEqual(serve(server, Source(), sink), 0)
        responses = {x["id"]: x for x in map(json.loads, sink.getvalue().splitlines())}
        self.assertEqual(responses[8]["error"]["code"], -32000)
        self.assertEqual(responses[9]["result"], {})
        self.assertEqual(responses[7]["result"]["structuredContent"]["error"]["code"], "CANCELLED")
        self.assertEqual(len(server.agent.calls), 1)

    def test_next_serial_call_at_response_boundary_is_not_busy(self):
        published = threading.Event()
        next_read = threading.Event()
        server = self.server()
        messages = [request("tools/call", {"name": "harmony_observe"}, 1),
                    request("tools/call", {"name": "harmony_observe"}, 2)]

        class Source:
            index = 0

            def readline(self, limit):
                if self.index == 1:
                    if not published.wait(3):
                        raise AssertionError("First response was not published")
                    next_read.set()
                if self.index == len(messages):
                    return ""
                value = json.dumps(messages[self.index]) + "\n"
                self.index += 1
                return value

        class Sink(io.StringIO):
            def flush(self):
                if not published.is_set():
                    published.set()
                    if not next_read.wait(3):
                        raise AssertionError("Client did not read the first response")

        sink = Sink()
        self.assertEqual(serve(server, Source(), sink), 0)
        responses = [json.loads(value) for value in sink.getvalue().splitlines()]
        self.assertEqual(len(responses), 2)
        self.assertTrue(all("result" in value for value in responses), responses)
        self.assertEqual(len(server.agent.calls), 2)

    def test_module_stdio_transport_without_device(self):
        messages = [request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                    "clientInfo": {"name": "probe", "version": "1"}}),
                    request("notifications/initialized", request_id=None),
                    request("tools/list", request_id=2)]
        env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
        run = subprocess.run([sys.executable, "-m", "harmony_agent.mcp", "--read-only"],
                             input="".join(json.dumps(x) + "\n" for x in messages),
                             encoding="utf-8", capture_output=True, timeout=10, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stderr, "")
        responses = [json.loads(line) for line in run.stdout.splitlines()]
        self.assertEqual(len(responses), 2)
        self.assertEqual({x["name"] for x in responses[1]["result"]["tools"]},
                         {"harmony_" + x for x in READ_ONLY_COMMANDS if x in COMMANDS})

    def test_native_runner_and_readonly_evidence_share_the_same_contract(self):
        from harmony_agent.core import Agent
        from tests.test_core import FakeNativeTransport
        transport = FakeNativeTransport()
        with tempfile.TemporaryDirectory() as folder:
            server = McpServer(state_dir=folder,
                               agent_factory=lambda **options: Agent(transport=transport, **options))
            evidence = McpServer(state_dir=folder, read_only=True)
            initialize(server)
            initialize(evidence)

            def call(server, command, arguments):
                result = server.handle(request("tools/call", {"name": "harmony_" + command,
                                       "arguments": arguments}))["result"]
                self.assertFalse(result["isError"], result)
                return result["structuredContent"]["data"]

            call(server, "attach", {"device": transport.serial})
            try:
                plan = {"version": "1", "steps": [{"command": "press", "input": {
                    "target": {"id": "fixture.increment"},
                    "expect": {"selector": {"id": "fixture.counter"}, "equals": "Counter: 1"}}}],
                    "goals": [{"selector": {"id": "fixture.counter"}, "equals": "Counter: 1"}]}
                result = call(server, "run", {"run_id": "mcp-example", "plan": plan})
                self.assertEqual(result["status"], "completed")
                self.assertEqual(result["goalVerification"]["status"], "passed")
                count = transport.captures
                report = call(evidence, "report", {"run_id": "mcp-example"})
                frame = call(evidence, "inspect", {"run_id": "mcp-example",
                             "frame_id": result["observation"]["frameId"], "target": {"id": "fixture.counter"}})
                self.assertEqual(report["status"], "completed")
                self.assertFalse(frame["fresh"])
                self.assertEqual(frame["matches"], 1)
                self.assertTrue(any(n["text"] == "Counter: 1" for n in frame["nodes"]))
                self.assertEqual(transport.captures, count)
                self.assertIsNone(evidence.agent._transport)

                # A real stdio client process, not an in-process adapter mock.
                env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")}
                process = subprocess.Popen([sys.executable, "-m", "harmony_agent.mcp", "--read-only", "--state-dir", folder],
                                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           encoding="utf-8", bufsize=1, env=env)
                responses = queue.Queue()

                def read_stdout():
                    for line in process.stdout:
                        responses.put(line)

                reader = threading.Thread(target=read_stdout, daemon=True)
                reader.start()

                def exchange(message):
                    process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
                    process.stdin.flush()
                    if "id" not in message:
                        return None
                    result = json.loads(responses.get(timeout=10))
                    self.assertEqual(result["id"], message["id"])
                    return result

                try:
                    init = exchange(request("initialize", {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                                             "clientInfo": {"name": "local-probe", "version": "1"}}, 10))
                    self.assertEqual(init["result"]["protocolVersion"], PROTOCOL_VERSION)
                    exchange(request("notifications/initialized", request_id=None))
                    schema = exchange(request("tools/call", {"name": "harmony_schema", "arguments": {"command_name": "run"}}, 11))
                    self.assertFalse(schema["result"]["isError"])
                    report_response = exchange(request("tools/call", {"name": "harmony_report", "arguments": {"run_id": "mcp-example"}}, 12))
                    self.assertEqual(report_response["result"]["structuredContent"]["data"]["status"], "completed")
                    inspected = exchange(request("tools/call", {"name": "harmony_inspect", "arguments": {
                        "run_id": "mcp-example", "frame_id": result["observation"]["frameId"], "target": {"id": "fixture.counter"}}}, 13))
                    self.assertEqual(inspected["result"]["structuredContent"]["data"]["matches"], 1)
                    denied = exchange(request("tools/call", {"name": "harmony_press", "arguments": {"target": "id=fixture.increment"}}, 14))
                    self.assertEqual(denied["error"]["code"], -32602)
                    process.stdin.close()
                    self.assertEqual(process.wait(timeout=10), 0)
                    self.assertEqual(process.stderr.read(), "")
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=10)
                    reader.join(timeout=2)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if stream is not None and not stream.closed:
                            stream.close()
            finally:
                call(server, "detach", {})


if __name__ == "__main__":
    unittest.main()
