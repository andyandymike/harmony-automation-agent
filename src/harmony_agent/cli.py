"""Small stdlib CLI with machine-readable errors and versioned requests."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import SCHEMA_VERSION, __version__
from .errors import AgentError
from .schema import COMMANDS, FIELDS, field_definition, invalid, request_schema, validate_params, validate_request


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise AgentError("INVALID_ARGUMENT", message, exit_code=2)


def _json_object(value):
    try:
        result = json.loads(value)
    except (json.JSONDecodeError, ValueError) as exc:
        raise argparse.ArgumentTypeError(f"Invalid JSON: {exc}") from exc
    if not isinstance(result, dict):
        raise argparse.ArgumentTypeError("Expected a JSON object.")
    return result


def _add_globals(parser):
    options = {"default": argparse.SUPPRESS}
    parser.add_argument("--json", action="store_true", help="Write one JSON result to stdout.", **options)
    parser.add_argument("--hdc", help="Path to the HDC executable.", **options)
    parser.add_argument("--state-dir", help="Local sessions and artifacts directory.", **options)
    parser.add_argument("--session", help=FIELDS["session"]["help"], **options)
    parser.add_argument("--device", help=FIELDS["device"]["help"], **options)
    parser.add_argument("--request", metavar="FILE", help="Read a structured command request from a JSON file.", **options)
    parser.add_argument("--help", "-h", action="store_true", help="Show help.", **options)
    parser.add_argument("--version", action="store_true", help="Show version.", **options)


def build_parser():
    parser = Parser(prog="harmony-agent", description="Observe, operate and verify HarmonyOS applications.",
                    add_help=False, allow_abbrev=False)
    _add_globals(parser)
    subparsers = parser.add_subparsers(dest="command", parser_class=Parser)
    commands = {}
    for name, spec in COMMANDS.items():
        command_parser = subparsers.add_parser(name, help=spec["help"], description=spec["help"],
                                               add_help=False, allow_abbrev=False)
        _add_globals(command_parser)
        for field in spec["positional"] + spec["options"]:
            definition = field_definition(field, name)
            kwargs = {"help": definition["help"], "default": argparse.SUPPRESS}
            if field in spec["positional"]:
                kwargs["nargs"] = "?"  # Validation follows --help handling.
                flags = [field]
            else:
                flags = ["--" + field.replace("_", "-")]
            if definition["kind"] == "integer":
                kwargs["type"] = int
            elif definition["kind"] in {"expect", "plan"}:
                kwargs["type"] = _json_object
            elif definition["kind"] == "boolean":
                kwargs["action"] = "store_true"
            elif definition["kind"] == "enum":
                kwargs["choices"] = definition["choices"]
            command_parser.add_argument(*flags, **kwargs)
        commands[name] = command_parser
    return parser, commands


def _envelope(*, data=None, error=None):
    result = {"schemaVersion": SCHEMA_VERSION, "version": __version__, "success": error is None}
    result["error" if error is not None else "data"] = error if error is not None else data
    return result


def _write(result, *, json_mode):
    if json_mode:
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    elif not result["success"]:
        error = result["error"]
        print(f"{error['code']}: {error['message']}", file=sys.stderr)
        if error.get("details"):
            print(json.dumps(error["details"], ensure_ascii=False, indent=2), file=sys.stderr)
    elif isinstance(result["data"], dict) and "help" in result["data"]:
        print(result["data"]["help"], end="")
    else:
        print(json.dumps(result["data"], ensure_ascii=False, indent=2))


def main(argv=None, *, agent_factory=None):
    """Return an exit status; the entry point owns SystemExit, never the core."""
    argv = list(sys.argv[1:] if argv is None else argv)
    json_mode = "--json" in argv
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    try:
        parser, command_parsers = build_parser()
        parsed = vars(parser.parse_args(argv))
        json_mode = parsed.pop("json", False)
        if parsed.pop("version", False):
            _write(_envelope(data={"version": __version__, "schemaVersion": SCHEMA_VERSION}), json_mode=json_mode)
            return 0
        command = parsed.pop("command", None)
        if parsed.pop("help", False):
            help_parser = command_parsers.get(command, parser)
            _write(_envelope(data={"help": help_parser.format_help()}), json_mode=json_mode)
            return 0
        hdc_path = parsed.pop("hdc", None)
        state_dir = parsed.pop("state_dir", None)
        request_path = parsed.pop("request", None)
        if request_path is not None:
            if command is not None:
                invalid("Use either a command or --request FILE, not both.")
            try:
                text = Path(request_path).read_text(encoding="utf-8-sig")
                request = json.loads(text)
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise AgentError("INVALID_REQUEST", f"Cannot read request JSON: {exc}", exit_code=2) from exc
            # Merge explicit CLI context before required-field validation, so
            # `--request attach.json --device SERIAL` is a usable request.
            if isinstance(request, dict):
                if "input" in request and isinstance(request["input"], dict):
                    request["input"] = {**request["input"], **parsed}
                elif "input" not in request:
                    request = {**request, **parsed}
            command, params = validate_request(request)
        elif command is None:
            if not argv:
                _write(_envelope(data={"help": parser.format_help()}), json_mode=json_mode)
                return 0
            invalid("A command or --request FILE is required.")
        else:
            params = validate_params(command, parsed, from_cli=True)
        if command == "help":
            help_parser = command_parsers.get(params.get("command_name"), parser)
            result = {"help": help_parser.format_help()}
        elif command == "schema":
            result = request_schema(params.get("command_name"))
        else:
            if agent_factory is None:
                from .core import Agent
                agent_factory = Agent
            agent = agent_factory(state_dir=state_dir, hdc_path=hdc_path)
            result = agent.execute(command, params)
        _write(_envelope(data=result), json_mode=json_mode)
        return 0
    except AgentError as exc:
        _write(_envelope(error=exc.to_dict()), json_mode=json_mode)
        return exc.exit_code
    except KeyboardInterrupt:
        exc = AgentError("CANCELLED", "Operation interrupted. Re-observe before retrying an action.",
                         dispatched="unknown", exit_code=130)
        _write(_envelope(error=exc.to_dict()), json_mode=json_mode)
        return exc.exit_code
    except Exception as cause:
        exc = AgentError("INTERNAL_ERROR", "Unexpected failure; re-observe before retrying an action.",
                         details={"exception": type(cause).__name__}, dispatched="unknown")
        _write(_envelope(error=exc.to_dict()), json_mode=json_mode)
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
