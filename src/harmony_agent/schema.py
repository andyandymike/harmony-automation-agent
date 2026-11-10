"""Command definitions and validation shared by the CLI and JSON requests."""

from __future__ import annotations

from copy import deepcopy

from . import SCHEMA_VERSION, DEFAULT_INPUT_TIMEOUT_MS
from .errors import AgentError
from .observation import selector_uses_refs


PROPERTIES = ("text", "visible", "enabled", "checked", "selected", "focused")
BOOLEAN_PROPERTIES = set(PROPERTIES) - {"text"}
SELECTOR_BOOLEAN_FIELDS = {"enabled", "checked", "selected", "focused", "scrollable",
                           "clickable", "visible", "longClickable", "editable", "checkable"}
SELECTOR_STRING_FIELDS = {"id", "key", "text", "originalText", "value", "type", "ref", "description",
                          "hint", "bundleName", "app", "parent"}
SELECTOR_ID_FIELDS = {"hostWindowId", "displayId", "window", "windowId", "display"}

# A single definition drives argparse, request validation and the schema command.
FIELDS = {
    "view": {"kind": "enum", "choices": ["tree", "semantic"], "help": "Return a tree or a semantic decision view."},
    "profile": {"kind": "boolean", "help": "Include measured core stages; unavailable model/host timings remain null."},
    "plan": {"kind": "plan", "help": "Versioned bounded JSON plan. Prefer --request FILE for nested plans."},
    "run_id": {"kind": "string", "help": "Unique local execution ID; reused IDs are never replayed."},
    "frame_id": {"kind": "string", "help": "Exact immutable observation frame ID to inspect."},
    "session": {"kind": "string", "default": "default", "help": "Named local session (default: default)."},
    "device": {"kind": "string", "help": "Exact HDC device ID; required when attaching."},
    "app": {"kind": "string", "help": "Application bundle name."},
    "ability": {"kind": "string", "help": "Ability name to launch."},
    "target": {"kind": "selector", "help": "Exact selector, for example id=login, text=Submit, or @ref."},
    "text": {"kind": "text", "help": "Text to find or input; an empty string clears an input."},
    "expect": {"kind": "expect", "help": "JSON condition: stable selector, property, equals, optional timeoutMs. No frame refs."},
    "timeout_ms": {"kind": "integer", "minimum": 1, "maximum": 60000, "default": 5000,
                   "help": "Condition timeout in milliseconds (1-60000; default: 5000)."},
    "max_nodes": {"kind": "integer", "minimum": 1, "maximum": 5000, "default": 80,
                  "help": "Maximum displayed nodes (1-5000; default: 80)."},
    "interactive": {"kind": "boolean", "default": False,
                    "help": "Show interactive controls while retaining business facts."},
    "compact": {"kind": "boolean", "default": False,
                "help": "Omit unknown and empty optional node fields; preserve text values and explicit states."},
    "full": {"kind": "boolean", "default": False,
             "help": "Return the full saved report, including duplicate step copies and the saved page."},
    "direction": {"kind": "enum", "choices": ["up", "down", "left", "right"],
                  "help": "Scroll direction: up, down, left or right."},
    "property": {"kind": "enum", "choices": list(PROPERTIES), "default": "text",
                 "help": "Property to verify (default: text)."},
    "equals": {"kind": "scalar", "help": "Exact expected value; boolean properties require true or false."},
    "command_name": {"kind": "string", "help": "Command whose help/schema should be shown."},
}

COMMANDS = {
    "claim": {"help": "Reserve device mutations for this session until release or detach.", "positional": [], "options": [], "required": []},
    "release": {"help": "Release this session's device claim and invalidate cached refs.", "positional": [], "options": [], "required": []},
    "run": {"help": "Execute a bounded conditional plan under exclusive device ownership.", "positional": [], "options": ["plan", "run_id", "view", "max_nodes", "compact"], "required": ["plan"],
            "field_overrides": {"compact": {"default": True}}},
    "report": {"help": "Read a persisted run without contacting the device or replaying actions.", "positional": ["run_id"], "options": ["full"], "required": ["run_id"]},
    "inspect": {"help": "Expand a frozen frame without contacting the device.", "positional": [], "options": ["frame_id", "run_id", "target", "max_nodes"], "required": ["frame_id"]},
    "doctor": {"help": "Diagnose HDC and device readiness.", "positional": [], "options": [], "required": []},
    "devices": {"help": "List connected HDC devices.", "positional": [], "options": [], "required": []},
    "attach": {"help": "Attach a named session to an explicitly selected device.", "positional": [], "options": [], "required": ["device"]},
    "detach": {"help": "Release a session without stopping an external device.", "positional": [], "options": [], "required": []},
    "open": {"help": "Open an application in the session.", "positional": ["app"], "options": ["ability", "expect", "timeout_ms"], "required": ["app"]},
    "observe": {"help": "Capture a fresh structured UI observation.", "positional": [], "options": ["max_nodes", "interactive"], "required": []},
    "find": {"help": "Find text in the current UI with contextual information.", "positional": ["text"], "options": ["max_nodes"], "required": ["text"]},
    "press": {"help": "Press an exact target and optionally verify its effect.", "positional": ["target"], "options": ["expect", "timeout_ms"], "required": ["target"]},
    "fill": {"help": "Replace editable text and verify the resulting value.", "positional": ["target", "text"], "options": ["expect", "timeout_ms"], "required": ["target", "text"],
             "field_overrides": {"timeout_ms": {"default": DEFAULT_INPUT_TIMEOUT_MS,
                 "help": "Input preparation and readback timeout in milliseconds (1-60000; default: 15000)."}}},
    "scroll": {"help": "Scroll once, optionally within a target container.", "positional": ["direction"], "options": ["target", "expect", "timeout_ms"], "required": ["direction"]},
    "back": {"help": "Send the application Back action.", "positional": [], "options": ["expect", "timeout_ms"], "required": []},
    "wait": {"help": "Wait for an exact deterministic UI condition.", "positional": ["target"], "options": ["property", "equals", "timeout_ms"], "required": ["target", "equals"]},
    "screenshot": {"help": "Save a screenshot to session artifacts.", "positional": [], "options": [], "required": []},
    "capabilities": {"help": "Report supported, unsupported and unknown capabilities.", "positional": [], "options": [], "required": []},
    "help": {"help": "Show command help.", "positional": ["command_name"], "options": [], "required": []},
    "schema": {"help": "Show the JSON request schema.", "positional": ["command_name"], "options": [], "required": []},
}

for _spec in COMMANDS.values():
    _spec["options"].append("profile")
for _name in ("observe", "find", "open", "press", "fill", "scroll", "back", "wait"):
    COMMANDS[_name]["options"].append("view")


# Every command returning an observation supports the same output controls.
# These affect only the public view, never capture, targeting or assertions.
for _name in ("open", "observe", "find", "press", "fill", "scroll", "back", "wait"):
    for _field in ("max_nodes", "interactive", "compact"):
        if _field not in COMMANDS[_name]["options"]:
            COMMANDS[_name]["options"].append(_field)


def field_definition(name, command=None):
    return {**FIELDS[name], **COMMANDS.get(command, {}).get("field_overrides", {}).get(name, {})}


def invalid(message, **details):
    raise AgentError("INVALID_ARGUMENT", message, details=details, exit_code=2)


def validate_selector(value, *, path="target", depth=0):
    if isinstance(value, str):
        if not value.strip():
            invalid(f"{path} must not be empty.")
        return value
    if not isinstance(value, dict) or not value:
        invalid(f"{path} must be a non-empty selector string or object.")
    if depth > 8:
        invalid(f"{path} exceeds the maximum selector nesting depth.")
    allowed = SELECTOR_BOOLEAN_FIELDS | SELECTOR_STRING_FIELDS | SELECTOR_ID_FIELDS | {"within"}
    unknown = set(value) - allowed
    if unknown:
        invalid(f"{path} contains unknown selector fields.", fields=sorted(unknown))
    for field, item in value.items():
        if field == "within":
            validate_selector(item, path=f"{path}.within", depth=depth + 1)
        elif field in SELECTOR_BOOLEAN_FIELDS and type(item) is not bool:
            invalid(f"{path}.{field} must be a boolean.")
        elif field in SELECTOR_STRING_FIELDS and not isinstance(item, str):
            invalid(f"{path}.{field} must be a string.")
        elif field in SELECTOR_ID_FIELDS and type(item) not in (str, int):
            invalid(f"{path}.{field} must be a string or integer.")
    return deepcopy(value)


def validate_expect(value):
    if not isinstance(value, dict):
        invalid("expect must be a JSON object.")
    unknown = set(value) - {"selector", "property", "equals", "timeoutMs"}
    if unknown:
        invalid("expect contains unknown fields.", fields=sorted(unknown))
    if "selector" not in value or "equals" not in value:
        invalid("expect requires selector and equals.")
    result = deepcopy(value)
    result["selector"] = validate_selector(value["selector"], path="expect.selector")
    _validate_stable_selector(result["selector"])
    result.setdefault("property", "text")
    _validate_condition(result["property"], result["equals"], path="expect")
    if "timeoutMs" in result:
        _validate_field("timeout_ms", result["timeoutMs"])
    return result


def _validate_stable_selector(selector):
    if selector_uses_refs(selector):
        raise AgentError("INVALID_EXPECTATION",
                         "Conditions require stable selectors; ref and parent frame references are not allowed, including inside within.",
                         exit_code=2)


def _validate_condition(property_name, expected, *, path):
    if not isinstance(property_name, str) or property_name not in PROPERTIES:
        invalid(f"{path}.property must be one of: {', '.join(PROPERTIES)}.")
    if property_name == "text" and not isinstance(expected, str):
        invalid(f"{path}.equals must be a string for text conditions.")
    if property_name in BOOLEAN_PROPERTIES and type(expected) is not bool:
        invalid(f"{path}.equals must be a boolean for {property_name} conditions.")


def _validate_field(name, value):
    spec = FIELDS[name]
    kind = spec["kind"]
    if kind in ("string", "text"):
        if not isinstance(value, str) or (kind == "string" and not value.strip()):
            invalid(f"{name} must be {'a non-empty string' if kind == 'string' else 'a string'}.")
    elif kind == "integer":
        if type(value) is not int or not spec["minimum"] <= value <= spec["maximum"]:
            invalid(f"{name} must be an integer from {spec['minimum']} to {spec['maximum']}.")
    elif kind == "boolean":
        if type(value) is not bool:
            invalid(f"{name} must be a boolean.")
    elif kind == "enum":
        if not isinstance(value, str) or value not in spec["choices"]:
            invalid(f"{name} must be one of: {', '.join(spec['choices'])}.")
    elif kind == "selector":
        return validate_selector(value)
    elif kind == "expect":
        return validate_expect(value)
    elif kind == "plan":
        from .plans import validate_plan
        return validate_plan(value)
    elif kind == "scalar" and type(value) not in (str, bool):
        invalid(f"{name} must be a string or boolean.")
    return value


def validate_params(command, params, *, from_cli=False):
    if not isinstance(command, str) or command not in COMMANDS:
        invalid("Unknown command.", command=command, available=list(COMMANDS))
    if not isinstance(params, dict):
        invalid("Command input must be an object.")
    spec = COMMANDS[command]
    fields = ["session", "device"] + spec["positional"] + spec["options"]
    unknown = set(params) - set(fields)
    if unknown:
        invalid(f"Unknown input fields for {command}.", fields=sorted(unknown))
    result = {name: deepcopy(field_definition(name, command)["default"]) for name in fields
              if "default" in field_definition(name, command)}
    result.update(params)
    for name in spec["required"]:
        if name not in result:
            invalid(f"{command} requires {name}.")
    for name, value in result.items():
        if name != "equals":
            result[name] = _validate_field(name, value)
    if command == "find" and not result["text"].strip():
        invalid("find text must not be empty.")
    if command == "wait":
        _validate_stable_selector(result["target"])
        if from_cli and result["property"] in BOOLEAN_PROPERTIES:
            expected = result["equals"]
            if isinstance(expected, str) and expected.lower() in ("true", "false"):
                result["equals"] = expected.lower() == "true"
        _validate_condition(result["property"], result["equals"], path="wait")
    if command in ("schema", "help") and result.get("command_name") not in (None, *COMMANDS):
        invalid("Unknown help/schema command.", command=result["command_name"])
    return result


def validate_request(request):
    if not isinstance(request, dict):
        invalid("Request must be a JSON object.")
    if "schemaVersion" in request and request["schemaVersion"] != SCHEMA_VERSION:
        invalid("Unsupported schemaVersion.", supported=SCHEMA_VERSION)
    if "command" not in request:
        invalid("Request requires command.")
    command = request["command"]
    if "input" in request:
        unknown = set(request) - {"schemaVersion", "command", "input"}
        if unknown:
            invalid("Do not mix input with top-level command parameters.", fields=sorted(unknown))
        params = request["input"]
    else:
        params = {key: value for key, value in request.items() if key not in ("command", "schemaVersion")}
    return command, validate_params(command, params)


def _field_schema(name, command=None):
    spec = field_definition(name, command)
    kind = spec["kind"]
    result = {"description": spec["help"]}
    if kind in ("string", "text", "enum"):
        result["type"] = "string"
        if kind == "string":
            result["minLength"] = 1
            result["pattern"] = "\\S"
        if kind == "enum":
            result["enum"] = spec["choices"]
        if name == "command_name":
            result["enum"] = list(COMMANDS)
    elif kind in ("integer", "boolean"):
        result["type"] = kind
        for field in ("minimum", "maximum"):
            if field in spec:
                result[field] = spec[field]
    elif kind == "scalar":
        result["type"] = ["string", "boolean"]
    elif kind == "selector":
        result["$ref"] = "#/$defs/stableSelector" if command == "wait" else "#/$defs/selector"
    elif kind == "expect":
        result["$ref"] = "#/$defs/expect"
    elif kind == "plan":
        result["$ref"] = "#/$defs/plan"
    if "default" in spec:
        result["default"] = spec["default"]
    return result


def request_schema(command=None):
    if command is not None and command not in COMMANDS:
        invalid("Unknown schema command.", command=command)
    names = [command] if command else list(COMMANDS)
    variants = []
    condition_rule = {
        "if": {"properties": {"property": {"enum": sorted(BOOLEAN_PROPERTIES)}}, "required": ["property"]},
        "then": {"properties": {"equals": {"type": "boolean"}}},
        "else": {"properties": {"equals": {"type": "string"}}},
    }
    for name in names:
        spec = COMMANDS[name]
        fields = ["session", "device"] + spec["positional"] + spec["options"]
        properties = {field: _field_schema(field, name) for field in fields}
        common = {"schemaVersion": {"const": SCHEMA_VERSION}, "command": {"const": name}}
        condition = {"allOf": [condition_rule]} if name == "wait" else {}
        variants.append({"type": "object", "additionalProperties": False,
                         "properties": {**common, "input": {"type": "object", "additionalProperties": False,
                            "properties": properties, "required": spec["required"], **condition}},
                         "required": ["command", "input"]})
        variants.append({"type": "object", "additionalProperties": False,
                         "properties": {**common, **properties},
                         "required": ["command", *spec["required"]], **condition})
    selector_fields = {name: {"type": "string"} for name in SELECTOR_STRING_FIELDS}
    selector_fields.update({name: {"type": "boolean"} for name in SELECTOR_BOOLEAN_FIELDS})
    selector_fields.update({name: {"type": ["string", "integer"]} for name in SELECTOR_ID_FIELDS})
    selector_fields["within"] = {"$ref": "#/$defs/selector"}
    selector_fields["ref"]["description"] = "Current-frame target reference; not allowed in wait/expect conditions."
    selector_fields["parent"]["description"] = "Current-frame direct parent reference; use stable within selectors for conditions."
    stable_fields = {name: deepcopy(spec) for name, spec in selector_fields.items()
                     if name not in {"ref", "parent"}}
    stable_fields["within"] = {"$ref": "#/$defs/stableSelector"}
    result = {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Harmony Agent requests",
            "$defs": {
                "selector": {"oneOf": [{"type": "string", "minLength": 1, "pattern": "\\S"},
                    {"type": "object", "minProperties": 1, "additionalProperties": False, "properties": selector_fields}]},
                "stableSelector": {"oneOf": [
                    {"type": "string", "minLength": 1,
                     "pattern": "^(?!(?:within=)*(?:@|ref=|parent=))\\S"},
                    {"type": "object", "minProperties": 1, "additionalProperties": False,
                     "properties": stable_fields}]},
                "expect": {"type": "object", "additionalProperties": False,
                    "allOf": [condition_rule],
                    "required": ["selector", "equals"], "properties": {
                        "selector": {"$ref": "#/$defs/stableSelector"},
                        "property": {"type": "string", "enum": list(PROPERTIES), "default": "text"},
                        "equals": {"type": ["string", "boolean"]},
                        "timeoutMs": _field_schema("timeout_ms")}}},
            "oneOf": variants}
    if "run" in names:
        from .plans import plan_schema
        plan = plan_schema()
        def relocate(value):
            if isinstance(value, dict):
                return {key: ("#/$defs/plan_" + item[len("#/$defs/"):] if key == "$ref" and isinstance(item, str)
                              and item.startswith("#/$defs/") else relocate(item)) for key, item in value.items()}
            if isinstance(value, list):
                return [relocate(item) for item in value]
            return value
        result["$defs"].update({"plan_" + key: relocate(value) for key, value in plan.pop("$defs").items()})
        plan.pop("$schema", None)
        result["$defs"]["plan"] = relocate(plan)
    return result
