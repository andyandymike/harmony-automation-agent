"""Optional stdio MCP adapter; all device semantics remain in the native core.

One active tool call owns the Agent. Cancellation is cooperative: it prevents
later work, but cannot undo a command already dispatched to the device.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
import sys
import threading

from . import SCHEMA_VERSION, __version__
from .errors import AgentError
from .schema import COMMANDS, request_schema, validate_params


PROTOCOL_VERSION = "2025-06-18"
MAX_MESSAGE_BYTES = 4 * 1024 * 1024
READ_ONLY_COMMANDS = frozenset({"schema", "inspect", "report"})


def _prune_definitions(schema):
    """Keep only definitions reachable from this tool's own input contract."""
    definitions = schema.pop("$defs", {})
    required, pending = set(), [schema]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            reference = value.get("$ref")
            if isinstance(reference, str) and reference.startswith("#/$defs/"):
                name = reference[len("#/$defs/"):].split("/", 1)[0].replace("~1", "/").replace("~0", "~")
                if name in definitions and name not in required:
                    required.add(name)
                    pending.append(definitions[name])
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    if required:
        schema["$defs"] = {name: value for name, value in definitions.items() if name in required}
    return schema


def _result(data=None, error=None):
    value = {"schemaVersion": SCHEMA_VERSION, "version": __version__, "success": error is None}
    value["data" if error is None else "error"] = data if error is None else error
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False, separators=(",", ":"))}],
            "structuredContent": value, "isError": error is not None}


class McpServer:
    """Small protocol surface with a real server-side read-only allowlist."""

    def __init__(self, *, state_dir=None, hdc_path=None, read_only=False, agent_factory=None):
        self.state_dir = state_dir
        self.hdc_path = hdc_path
        self.read_only = read_only
        self.agent_factory = agent_factory
        self._agent = None
        self._initialized = False
        self._ready = False

    @property
    def agent(self):
        if self._agent is None:
            if self.agent_factory is None:
                from .core import Agent
                self.agent_factory = Agent
            self._agent = self.agent_factory(state_dir=self.state_dir, hdc_path=self.hdc_path)
        return self._agent

    def commands(self):
        return [name for name in COMMANDS if name != "help"
                and (not self.read_only or name in READ_ONLY_COMMANDS)]

    def tools(self):
        items = []
        for name in self.commands():
            schema = request_schema(name)
            inputs = deepcopy(schema["oneOf"][0]["properties"]["input"])
            inputs["$defs"] = deepcopy(schema["$defs"])
            items.append({"name": "harmony_" + name, "description": COMMANDS[name]["help"],
                          "inputSchema": _prune_definitions(inputs),
                          "annotations": {"readOnlyHint": name in READ_ONLY_COMMANDS,
                                          "openWorldHint": name not in READ_ONLY_COMMANDS}})
        return items

    @staticmethod
    def error(request_id, code, message):
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    def handle(self, request):
        """Handle one message. Tool calls are serialized by the transport."""
        if not isinstance(request, dict):
            return self.error(None, -32600, "Expected one JSON-RPC object; batches are not supported.")
        request_id = request.get("id")
        has_id = "id" in request
        if (request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str)
                or has_id and (type(request_id) not in (str, int))):
            return self.error(None, -32600, "Invalid JSON-RPC request.")
        method = request["method"]
        params = request.get("params", {})
        if not isinstance(params, dict):
            return self.error(request_id, -32602, "params must be an object.") if has_id else None
        if not has_id:
            if method == "notifications/initialized" and self._initialized:
                self._ready = True
            return None
        if method == "initialize":
            if self._initialized:
                return self.error(request_id, -32600, "Already initialized.")
            client = params.get("clientInfo")
            if (not isinstance(params.get("protocolVersion"), str)
                    or not isinstance(params.get("capabilities"), dict)
                    or not isinstance(client, dict)
                    or not isinstance(client.get("name"), str)
                    or not isinstance(client.get("version"), str)):
                return self.error(request_id, -32602, "initialize requires protocolVersion, capabilities and clientInfo.")
            self._initialized = True
            result = {"protocolVersion": PROTOCOL_VERSION, "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "harmony-agent", "version": __version__},
                      "instructions": ("Read-only evidence server: inspect existing frames and run reports; no device calls."
                                       if self.read_only else
                                       "Select an exact device. Reuse returned observations. Inspect action and assertion separately. "
                                       "Run bounded plans; uncertain actions must not be automatically replayed.")}
        elif method == "ping":
            result = {}
        elif not self._ready:
            return self.error(request_id, -32002, "Initialize and send notifications/initialized first.")
        elif method == "tools/list":
            if params.get("cursor") is not None:
                return self.error(request_id, -32602, "This server has one tool page; no cursor is valid.")
            result = {"tools": self.tools()}
        elif method == "tools/call":
            name = params.get("name")
            if not isinstance(name, str) or not name.startswith("harmony_") or name[8:] not in self.commands():
                return self.error(request_id, -32602, "Unknown or unavailable tool.")
            command = name[8:]
            arguments = params.get("arguments", {})
            try:
                validated = validate_params(command, arguments)
                if command == "schema":
                    data = request_schema(validated.get("command_name"))
                else:
                    data = self.agent.execute(command, validated)
                result = _result(data)
            except AgentError as exc:
                result = _result(error=exc.to_dict())
            except (Exception, KeyboardInterrupt) as exc:
                result = _result(error=AgentError(
                    "CANCELLED" if isinstance(exc, KeyboardInterrupt) else "INTERNAL_ERROR",
                    "Tool execution interrupted or failed. Inspect the current state before retrying an action.",
                    details={"exception": type(exc).__name__}, dispatched="unknown").to_dict())
        else:
            return self.error(request_id, -32601, "Method not found.")
        return {"jsonrpc": "2.0", "id": request_id, "result": result}


def serve(server, source, sink):
    """Read UTF-8 JSON lines, keeping cancellation responsive during a tool."""
    output_lock = threading.Lock()
    active_lock = threading.Lock()
    active = {"thread": None, "id": None}

    def send(message):
        if message is None:
            return
        with output_lock:
            sink.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
            sink.flush()

    def worker(message):
        try:
            response = server.handle(message)
        except Exception:
            response = server.error(message.get("id"), -32603, "Internal protocol error.")
        # Publish completion and release ownership under the same lock. A
        # client may send its next call as soon as it reads this response;
        # the reader must wait for ownership release before checking busy.
        with active_lock:
            try:
                send(response)
            finally:
                active["thread"] = None
                active["id"] = None

    def cancel():
        if server._agent is not None:
            server._agent.request_cancel()

    status = 0
    try:
        while True:
            line = source.readline(MAX_MESSAGE_BYTES + 1)
            if not line:
                break
            if len(line.encode("utf-8")) > MAX_MESSAGE_BYTES:
                send(server.error(None, -32600, "Message exceeds the 4 MiB limit."))
                status = 2
                break
            try:
                message = json.loads(line)
            except (ValueError, RecursionError):
                send(server.error(None, -32700, "Invalid JSON."))
                continue
            if (isinstance(message, dict) and message.get("jsonrpc") == "2.0"
                    and "id" not in message and message.get("method") == "notifications/cancelled"):
                params = message.get("params", {})
                with active_lock:
                    if (isinstance(params, dict) and type(params.get("requestId")) in (str, int)
                            and params["requestId"] == active["id"] and active["thread"] is not None):
                        cancel()
                continue
            if (isinstance(message, dict) and message.get("method") == "tools/call" and "id" in message):
                with active_lock:
                    if active["thread"] is not None:
                        send(server.error(message["id"], -32000, "Another tool is running. Wait for its result; do not replay an uncertain action."))
                        continue
                    # Clear before starting: a cancellation arriving immediately
                    # after worker start must not be lost inside the worker.
                    server.agent.clear_cancel()
                    thread = threading.Thread(target=worker, args=(message,), name="harmony-mcp-tool")
                    active.update(thread=thread, id=message["id"])
                    thread.start()
            else:
                send(server.handle(message))
    except KeyboardInterrupt:
        status = 130
    except (BrokenPipeError, OSError):
        status = 1
    finally:
        with active_lock:
            thread = active["thread"]
            if thread is not None:
                cancel()
        if thread is not None:
            thread.join()
    return status


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve Harmony Agent tools over local MCP stdio.")
    parser.add_argument("--state-dir", help="Shared local state and evidence directory.")
    parser.add_argument("--hdc", help="Path to the HDC executable.")
    parser.add_argument("--read-only", action="store_true", help="Expose only existing frame inspection, reports and schemas.")
    args = parser.parse_args(argv)
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    return serve(McpServer(state_dir=args.state_dir, hdc_path=args.hdc, read_only=args.read_only), sys.stdin, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
