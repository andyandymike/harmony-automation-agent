"""Bounded, model-free execution of declarative UI plans.

The caller owns the device/session lock and supplies fresh-state command and
condition callbacks. This module never replays a command or executes arbitrary
code. Its deadline is cooperative: native calls must use ``PlanBudget`` too.
"""

from __future__ import annotations

from copy import deepcopy
import time

from .errors import AgentError
from .observation import selector_uses_refs, select_nodes
from .bindings import (check_references, expression_schema, normalize_read_result,
                       resolve_value, validate_expression, variable_name)


PLAN_VERSION = "1"
PLAN_VERSIONS = ("1", "2")
COMMANDS = frozenset({"observe", "find", "press", "fill", "scroll", "back", "wait", "open"})
MUTATIONS = frozenset({"press", "fill", "scroll", "back", "open"})
LIMITS = {"maxSteps": (50, 1, 500), "maxActions": (20, 1, 100),
          "timeoutMs": (60000, 1, 600000), "maxCaptures": (100, 1, 1000)}
MAX_DEFINITION_STEPS = 200
MAX_DEPTH = 8


def _invalid(message, path="plan"):
    raise AgentError("INVALID_PLAN", message, details={"path": path}, exit_code=2)


def _object(value, allowed, path):
    if not isinstance(value, dict):
        _invalid("Expected an object.", path)
    if any(not isinstance(key, str) for key in value) or set(value) - set(allowed):
        _invalid("Object contains unsupported fields.", path)


def _integer(value, minimum, maximum, path):
    if type(value) is not int or not minimum <= value <= maximum:
        _invalid(f"Expected an integer from {minimum} to {maximum}.", path)
    return value


def _text(value, path, maximum=4000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        _invalid(f"Expected nonempty text of at most {maximum} characters.", path)
    return value


def _condition(value, path, *, version="1", references=None):
    # Lazy imports allow schema.py to expose this module's schema/validator.
    from .schema import validate_expect
    checked = deepcopy(value)
    expression = None
    if version == "2" and isinstance(checked, dict) and isinstance(checked.get("equals"), dict):
        expected_type = str if checked.get("property", "text") == "text" else bool
        expression = validate_expression(checked["equals"], expected_type, path + ".equals", references)
        checked["equals"] = "" if expected_type is str else False
    try:
        result = validate_expect(checked)
        select_nodes({"nodes": [], "frameId": "validation"}, result["selector"])
    except (AgentError, RecursionError, TypeError, ValueError) as exc:
        _invalid("Invalid stable condition: " + str(exc), path)
    if expression is not None:
        result["equals"] = expression
    return result


def validate_plan(plan):
    """Validate every branch before any callback can execute; return a copy."""
    from .schema import validate_params
    _object(plan, {"version", "goal", "limits", "preconditions", "goals", "steps"}, "plan")
    version = plan.get("version")
    if version not in PLAN_VERSIONS:
        _invalid("Plan version must be the string '1' or '2'.", "plan.version")
    result = {"version": version}
    references, declarations = [], {}

    def condition(value, path):
        return _condition(value, path, version=version, references=references)
    if "goal" in plan:
        result["goal"] = _text(plan["goal"], "plan.goal")
    supplied_limits = plan.get("limits", {})
    _object(supplied_limits, LIMITS, "plan.limits")
    result["limits"] = {name: _integer(supplied_limits.get(name, default), low, high,
                                      "plan.limits." + name)
                        for name, (default, low, high) in LIMITS.items()}
    for name in ("preconditions", "goals"):
        conditions = plan.get(name, [])
        if not isinstance(conditions, list) or len(conditions) > 16:
            _invalid("Expected a list of at most 16 conditions.", "plan." + name)
        result[name] = [condition(item, f"plan.{name}[{i}]") for i, item in enumerate(conditions)]
    defined = 0

    def steps(values, path, depth=0, allow_empty=False):
        nonlocal defined
        if depth > MAX_DEPTH:
            _invalid("Plan nesting exceeds the supported depth.", path)
        if not isinstance(values, list) or (not values and not allow_empty):
            _invalid("Expected a nonempty list of steps.", path)
        normalized = []
        for index, step in enumerate(values):
            location = f"{path}[{index}]"
            defined += 1
            if defined > MAX_DEFINITION_STEPS:
                _invalid("Plan contains too many defined steps.", location)
            supported = {"command", "assert", "if", "repeat", "yield", "stop"}
            if version == "2":
                supported.add("read")
            _object(step, supported | {"input", "before", "refresh", "then", "else"}, location)
            kinds = set(step) & supported
            if len(kinds) != 1:
                _invalid("Each step must contain exactly one operation.", location)
            kind = next(iter(kinds))
            allowed = {"command", "input", "before", "refresh"} if kind == "command" else {"if", "then", "else"} if kind == "if" else {kind}
            _object(step, allowed, location)
            if kind == "command":
                command = step["command"]
                if not isinstance(command, str) or command not in COMMANDS:
                    _invalid("Command is not allowed inside a plan.", location + ".command")
                params = step.get("input", {})
                if not isinstance(params, dict) or "session" in params or "device" in params:
                    _invalid("Plan steps inherit the attached session and device.", location + ".input")
                try:
                    params = deepcopy(params)
                    explicit_fields = set(params)
                    expressions, expectation = {}, None
                    if version == "2":
                        field = "text" if command == "fill" else "equals" if command == "wait" else None
                        if field and isinstance(params.get(field), dict):
                            expected_type = str if field == "text" or params.get("property", "text") == "text" else bool
                            expressions[field] = validate_expression(params[field], expected_type,
                                                                      location + ".input." + field, references)
                            params[field] = "" if expected_type is str else False
                        if "expect" in params:
                            expectation = condition(params["expect"], location + ".input.expect")
                            params["expect"] = deepcopy(expectation)
                            if isinstance(params["expect"]["equals"], dict):
                                params["expect"]["equals"] = "" if params["expect"]["property"] == "text" else False
                    params = validate_params(command, params)
                    params.update(expressions)
                    params.pop("session", None)
                    # Unspecified public-view options inherit the run's view.
                    # Inserting CLI defaults here would silently override it.
                    for projection in ("view", "max_nodes", "interactive", "compact", "profile"):
                        if projection not in explicit_fields:
                            params.pop(projection, None)
                    if "target" in params:
                        if selector_uses_refs(params["target"]):
                            _invalid("Plan selectors must not contain frame refs or parent refs.", location + ".input.target")
                        select_nodes({"nodes": [], "frameId": "validation"}, params["target"])
                    if "expect" in params:
                        params["expect"] = expectation if expectation is not None else condition(params["expect"], location + ".input.expect")
                except AgentError as exc:
                    if exc.code == "INVALID_PLAN":
                        raise
                    _invalid(str(exc), location + ".input")
                except (RecursionError, TypeError, ValueError) as exc:
                    _invalid("Invalid command input: " + str(exc), location + ".input")
                normalized_step = {"command": command, "input": params}
                if "refresh" in step:
                    if command not in MUTATIONS or type(step["refresh"]) is not bool:
                        _invalid("refresh must be a boolean on a mutating command.", location + ".refresh")
                    normalized_step["refresh"] = step["refresh"]
                if "before" in step:
                    if command not in MUTATIONS:
                        _invalid("before guards are supported only on mutating commands.", location + ".before")
                    guards = step["before"]
                    if not isinstance(guards, list) or len(guards) > 16:
                        _invalid("Expected a list of at most 16 conditions.", location + ".before")
                    normalized_step["before"] = [condition(guard, f"{location}.before[{i}]")
                                                 for i, guard in enumerate(guards)]
                normalized.append(normalized_step)
            elif kind == "read":
                spec = step["read"]
                _object(spec, {"name", "selector", "property", "stripPrefix"}, location + ".read")
                name = variable_name(spec.get("name"), location + ".read.name")
                prop = spec.get("property", "text")
                expected_type = str if prop == "text" else bool
                checked = condition({"selector": spec.get("selector"), "property": prop,
                                     "equals": "" if expected_type is str else False}, location + ".read")
                if name in declarations and declarations[name] is not expected_type:
                    _invalid("A binding cannot be read with different property types.", location + ".read.name")
                declarations[name] = expected_type
                normalized_read = {"name": name, "selector": checked["selector"], "property": prop}
                if "stripPrefix" in spec:
                    prefix = spec["stripPrefix"]
                    if prop != "text" or not isinstance(prefix, str) or len(prefix) > 4000:
                        _invalid("stripPrefix requires a text read and a literal of at most 4000 characters.", location + ".read.stripPrefix")
                    normalized_read["stripPrefix"] = prefix
                normalized.append({"read": normalized_read})
            elif kind == "assert":
                normalized.append({"assert": condition(step[kind], location + ".assert")})
            elif kind == "if":
                normalized.append({"if": condition(step[kind], location + ".if"),
                                   "then": steps(step.get("then"), location + ".then", depth + 1),
                                   "else": steps(step.get("else", []), location + ".else", depth + 1, True)})
            elif kind == "repeat":
                repeat = step[kind]
                _object(repeat, {"limit", "until", "steps"}, location + ".repeat")
                normalized.append({"repeat": {
                    "limit": _integer(repeat.get("limit"), 1, 100, location + ".repeat.limit"),
                    "until": condition(repeat.get("until"), location + ".repeat.until"),
                    "steps": steps(repeat.get("steps"), location + ".repeat.steps", depth + 1)}})
            else:
                normalized.append({kind: _text(step[kind], location + "." + kind)})
        return normalized

    result["steps"] = steps(plan.get("steps"), "plan.steps")
    check_references(references, declarations)
    return result


def _literal_plan_schema():
    """Return a standalone JSON Schema; runtime validation also limits nesting."""
    from .schema import (PROPERTIES, BOOLEAN_PROPERTIES, SELECTOR_STRING_FIELDS,
                         SELECTOR_BOOLEAN_FIELDS, SELECTOR_ID_FIELDS,
                         COMMANDS as COMMAND_DEFINITIONS, _field_schema)
    selector_fields = {name: {"type": "string"} for name in SELECTOR_STRING_FIELDS - {"ref", "parent"}}
    selector_fields.update({name: {"type": "boolean"} for name in SELECTOR_BOOLEAN_FIELDS})
    selector_fields.update({name: {"type": ["string", "integer"]} for name in SELECTOR_ID_FIELDS})
    selector_fields["within"] = {"$ref": "#/$defs/stableSelector"}
    defs = {"stableSelector": {"oneOf": [
        {"type": "string", "minLength": 1, "pattern": "^(?!(?:within=)*(?:@|ref=|parent=))[^=]+="},
        {"type": "object", "minProperties": 1, "additionalProperties": False, "properties": selector_fields}]}}
    condition_rule = {"if": {"properties": {"property": {"enum": sorted(BOOLEAN_PROPERTIES)}}, "required": ["property"]},
                      "then": {"properties": {"equals": {"type": "boolean"}}},
                      "else": {"properties": {"equals": {"type": "string"}}}}
    defs["expect"] = {"type": "object", "additionalProperties": False,
                      "required": ["selector", "equals"], "allOf": [condition_rule], "properties": {
                          "selector": {"$ref": "#/$defs/stableSelector"},
                          "property": {"type": "string", "enum": list(PROPERTIES), "default": "text"},
                          "equals": {"type": ["string", "boolean"]},
                          "timeoutMs": {"type": "integer", "minimum": 1, "maximum": 60000}}}
    variants = []
    for command in sorted(COMMANDS):
        spec = COMMAND_DEFINITIONS[command]
        fields = spec["positional"] + spec["options"]
        properties = {name: _field_schema(name, command) for name in fields}
        for projection in ("view", "max_nodes", "interactive", "compact", "profile"):
            if projection in properties:
                properties[projection].pop("default", None)
        if "target" in properties:
            properties["target"]["$ref"] = "#/$defs/stableSelector"
        required = list(spec["required"])
        input_schema = {"type": "object", "additionalProperties": False,
                        "properties": properties, "required": required}
        if command == "wait":
            input_schema["allOf"] = [condition_rule]
        step_properties = {"command": {"const": command}, "input": input_schema}
        if command in MUTATIONS:
            step_properties["refresh"] = {"type": "boolean", "default": False}
            step_properties["before"] = {"type": "array", "maxItems": 16,
                                         "items": {"$ref": "#/$defs/expect"}}
        variants.append({"type": "object", "additionalProperties": False,
                         "required": ["command"] + (["input"] if required else []),
                         "properties": step_properties})
    step_list = {"type": "array", "minItems": 1, "maxItems": MAX_DEFINITION_STEPS,
                 "items": {"$ref": "#/$defs/step"}}
    variants.extend([
        {"type": "object", "additionalProperties": False, "required": ["assert"],
         "properties": {"assert": {"$ref": "#/$defs/expect"}}},
        {"type": "object", "additionalProperties": False, "required": ["if", "then"],
         "properties": {"if": {"$ref": "#/$defs/expect"}, "then": deepcopy(step_list),
                        "else": {**deepcopy(step_list), "minItems": 0}}},
        {"type": "object", "additionalProperties": False, "required": ["repeat"],
         "properties": {"repeat": {"type": "object", "additionalProperties": False,
             "required": ["limit", "until", "steps"], "properties": {
                 "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                 "until": {"$ref": "#/$defs/expect"}, "steps": deepcopy(step_list)}}}},
        *[{"type": "object", "additionalProperties": False, "required": [kind],
           "properties": {kind: {"type": "string", "minLength": 1, "maxLength": 4000, "pattern": "\\S"}}}
          for kind in ("yield", "stop")],
    ])
    defs["step"] = {"oneOf": variants}
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Harmony bounded plan",
            "type": "object", "additionalProperties": False, "required": ["version", "steps"],
            "properties": {"version": {"const": PLAN_VERSION},
                "goal": {"type": "string", "minLength": 1, "maxLength": 4000, "pattern": "\\S"},
                "limits": {"type": "object", "additionalProperties": False, "properties": {
                    name: {"type": "integer", "default": default, "minimum": low, "maximum": high}
                    for name, (default, low, high) in LIMITS.items()}},
                "preconditions": {"type": "array", "maxItems": 16, "items": {"$ref": "#/$defs/expect"}},
                "goals": {"type": "array", "maxItems": 16, "items": {"$ref": "#/$defs/expect"}},
                "steps": step_list}, "$defs": defs,
            "$comment": "Runtime additionally checks selector syntax, total definition steps and nesting depth."}


def plan_schema():
    """Describe both versions, keeping v1 restricted to literal-value steps."""
    from .bindings import NAME_PATTERN
    from .schema import PROPERTIES, BOOLEAN_PROPERTIES
    legacy = _literal_plan_schema()
    result = deepcopy(legacy)
    result["properties"]["version"] = {"enum": list(PLAN_VERSIONS)}
    definitions = result["$defs"]
    selector_fields = definitions["stableSelector"]["oneOf"][1]["properties"]
    if "textPrefix" in selector_fields:
        selector_fields["textPrefix"]["minLength"] = 1
    definitions.update(expression_schema())

    def legacy_refs(value):
        if isinstance(value, list):
            return [legacy_refs(item) for item in value]
        if isinstance(value, dict):
            return {key: ("#/$defs/v1Expect" if item == "#/$defs/expect" else
                          "#/$defs/v1Step" if item == "#/$defs/step" else item)
                    if key == "$ref" else legacy_refs(item) for key, item in value.items()}
        return value

    definitions["v1Expect"] = legacy_refs(legacy["$defs"]["expect"])
    definitions["v1Step"] = legacy_refs(legacy["$defs"]["step"])
    value_schema = {"anyOf": [{"$ref": "#/$defs/textValue"}, {"$ref": "#/$defs/booleanValue"}]}
    condition_rule = {
        "if": {"properties": {"property": {"enum": sorted(BOOLEAN_PROPERTIES)}}, "required": ["property"]},
        "then": {"properties": {"equals": {"$ref": "#/$defs/booleanValue"}}},
        "else": {"properties": {"equals": {"$ref": "#/$defs/textValue"}}},
    }
    definitions["expect"]["properties"]["equals"] = deepcopy(value_schema)
    definitions["expect"]["allOf"] = [deepcopy(condition_rule)]
    for variant in definitions["step"]["oneOf"]:
        command = variant["properties"].get("command", {}).get("const")
        if command == "fill":
            variant["properties"]["input"]["properties"]["text"] = {"$ref": "#/$defs/textValue"}
        elif command == "wait":
            variant["properties"]["input"]["properties"]["equals"] = deepcopy(value_schema)
            variant["properties"]["input"]["allOf"] = [deepcopy(condition_rule)]
    definitions["step"]["oneOf"].append({
        "type": "object", "additionalProperties": False, "required": ["read"], "properties": {
            "read": {"type": "object", "additionalProperties": False,
                     "required": ["name", "selector"], "properties": {
                         "name": {"type": "string", "pattern": NAME_PATTERN},
                         "selector": {"$ref": "#/$defs/stableSelector"},
                         "property": {"type": "string", "enum": list(PROPERTIES), "default": "text"},
                         "stripPrefix": {"type": "string", "maxLength": 4000}},
                     "allOf": [{"if": {"properties": {"property": {"enum": sorted(BOOLEAN_PROPERTIES)}},
                                        "required": ["property"]},
                                "then": {"not": {"required": ["stripPrefix"]}}}]}}})
    result["allOf"] = [{"if": {"properties": {"version": {"const": "1"}}, "required": ["version"]},
                        "then": {"properties": {
                            "steps": {"items": {"$ref": "#/$defs/v1Step"}},
                            "preconditions": {"items": {"$ref": "#/$defs/v1Expect"}},
                            "goals": {"items": {"$ref": "#/$defs/v1Expect"}}}}}]
    result["$comment"] += " Version 2 supports closed scalar bindings; runtime also checks declared names and types."
    return result


class PlanBudget:
    """Shared cooperative deadline and counters, including native captures."""

    def __init__(self, limits=None, *, clock=time.monotonic):
        supplied = {} if limits is None else limits
        _object(supplied, LIMITS, "plan.limits")
        self.limits = {name: _integer(supplied.get(name, default), low, high, "plan.limits." + name)
                       for name, (default, low, high) in LIMITS.items()}
        self.clock = clock
        self.started = clock()
        self.deadline = self.started + self.limits["timeoutMs"] / 1000
        self.steps = self.actions = self.captures = 0

    def _exhausted(self, reason):
        raise AgentError("PLAN_BUDGET_EXHAUSTED", "Plan execution budget exhausted.",
                         details={"reason": reason, "counters": self.snapshot()})

    def check(self):
        if self.clock() >= self.deadline:
            self._exhausted("timeoutMs")

    def remaining_ms(self):
        self.check()
        return max(1, int((self.deadline - self.clock()) * 1000))

    def consume_step(self):
        self.check()
        if self.steps >= self.limits["maxSteps"]:
            self._exhausted("maxSteps")
        self.steps += 1

    def consume_action(self):
        self.check()
        if self.actions >= self.limits["maxActions"]:
            self._exhausted("maxActions")
        self.actions += 1

    def consume_capture(self):
        self.check()
        if self.captures >= self.limits["maxCaptures"]:
            self._exhausted("maxCaptures")
        self.captures += 1

    def snapshot(self):
        return {"steps": self.steps, "actions": self.actions, "captures": self.captures,
                "elapsedMs": round(max(0, self.clock() - self.started) * 1000, 2)}


class _Halt(Exception):
    def __init__(self, status, reason):
        self.status, self.reason = status, reason


def _error_status(error):
    if error.code == "CANCELLED":
        return "cancelled"
    if error.code in {"BUDGET_EXCEEDED", "PLAN_BUDGET_EXHAUSTED"}:
        return "budget_exhausted"
    if error.code in {"PLAN_READ_FAILED", "PLAN_BINDING_FAILED"}:
        return "unknown"
    if error.code == "PLAN_CHECKPOINT_FAILED":
        # Persistence failed, not necessarily the device operation. Its actual
        # action/assertion remain attached to the error and step result.
        return "failed"
    action = error.details.get("action", {})
    assertion = error.details.get("assertion", {})
    if action.get("dispatched") == "acknowledged" and assertion.get("status") == "failed":
        return "failed"
    if error.dispatched == "unknown" or action.get("dispatched") == "unknown":
        return "unknown"
    return "failed"


def _summary(result):
    summary = {key: deepcopy(result[key]) for key in
               ("operationId", "beforeFrameId", "afterFrameId", "observationSource", "targetFrameAgeMs",
                "action", "assertion", "guardAssertions", "inputVerification",
                "timings", "evidence", "warnings", "receipt")
               if key in result}
    observation = result.get("observation", result)
    if isinstance(observation, dict) and observation.get("frameId"):
        summary["frameId"] = observation["frameId"]
    return summary


def run_plan(plan, executor, evaluate, *, checkpoint=None, budget=None, clock=time.monotonic, reader=None):
    """Run a validated bounded plan without retrying any callback.

    ``executor(command, input)`` returns core data, not a CLI envelope. Validated
    mutation guards are passed as internal ``_plan_before`` input; the executor
    must check them on the same observation used to resolve the action. A step's
    ``refresh=true`` becomes ``_plan_refresh=true`` and requires a fresh capture.
    ``evaluate(condition)`` returns ``status`` passed/failed/unknown and evidence;
    it must not infer absence from a filtered/truncated public projection.
    ``checkpoint(event)`` receives step_started before dispatch and step_finished
    afterwards. Failure before dispatch prevents it; failure afterwards preserves
    the actual result and stops subsequent work. Neither implies rollback.
    Version 2 additionally accepts ``reader(spec)`` returning a scalar ``value``
    and its ``frameId``. Read values are data only; the runner performs the
    declared literal-prefix removal and resolves closed var/concat expressions.
    """
    definition = validate_plan(plan)
    budget = budget or PlanBudget(definition["limits"], clock=clock)
    if budget.limits != definition["limits"]:
        _invalid("The supplied budget must match the validated plan limits.", "plan.limits")
    output = {"planVersion": definition["version"], "status": "running", "yieldReason": None,
              "steps": [], "goalVerification": {
                  "status": "not_run" if definition["goals"] else "not_requested", "assertions": []}}
    last_result = None
    bindings = {}

    def emit(event):
        if checkpoint is not None:
            try:
                checkpoint(deepcopy(event))
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                source = event.get("result", {})
                if not source:
                    source = event.get("error", {}).get("details", {})
                action = source.get("action", {})
                dispatch = "unknown" if action.get("dispatched") in {"acknowledged", "unknown"} else "no"
                known = {key: deepcopy(source[key]) for key in ("action", "assertion", "beforeFrameId", "afterFrameId")
                         if key in source}
                if isinstance(exc, AgentError):
                    known["cause"] = exc.to_dict()
                raise AgentError("PLAN_CHECKPOINT_FAILED", "Plan record could not be persisted; do not replay actions.",
                                 details={"phase": event["event"], "stepId": event["stepId"],
                                          "exception": type(exc).__name__, **known}, dispatched=dispatch) from exc

    def run_step(kind, path, work, *, is_action=False, command=None):
        budget.consume_step()
        record = {"stepId": str(budget.steps), "path": path, "kind": kind, "status": "started"}
        if command:
            record["command"] = command
        started = budget.clock()
        pending_error = None
        began = False
        try:
            emit({"event": "step_started", **record})
            began = True
            if is_action:
                budget.consume_action()
            value = work()
            record["result"] = deepcopy(value)
            record["status"] = "completed"
        except KeyboardInterrupt as exc:
            record.update(status="cancelled", error={"code": "CANCELLED", "message": "Plan interrupted; observe before continuing."})
            pending_error = exc
        except AgentError as exc:
            record.update(status=_error_status(exc), error=exc.to_dict())
            pending_error = exc
        except Exception as exc:
            # Arbitrary executor exceptions may occur after a device mutation.
            error = AgentError("PLAN_EXECUTION_FAILED", "Unexpected plan callback failure; inspect current state before continuing.",
                               details={"exception": type(exc).__name__}, dispatched="unknown" if is_action else "no")
            record.update(status=_error_status(error), error=error.to_dict())
            pending_error = error
        finally:
            record["elapsedMs"] = round(max(0, budget.clock() - started) * 1000, 2)
            output["steps"].append(record)
        if began:
            try:
                emit({"event": "step_finished", **record})
            except (AgentError, KeyboardInterrupt) as checkpoint_error:
                if pending_error is None:
                    raise
                # Keep the original device outcome if its error receipt also
                # cannot be written; missing durable evidence is not a retry.
                output.setdefault("warnings", []).append("Failed to persist the final step record.")
                record["checkpointError"] = (checkpoint_error.to_dict() if isinstance(checkpoint_error, AgentError)
                                             else {"code": "CANCELLED"})
        if pending_error is not None:
            raise pending_error
        budget.check()
        return value

    def resolved_condition(value):
        result = deepcopy(value)
        if isinstance(result["equals"], dict):
            expected_type = str if result.get("property", "text") == "text" else bool
            result["equals"] = resolve_value(result["equals"], expected_type, bindings)
        return result

    def condition(value):
        budget.check()
        result = evaluate(resolved_condition(value))
        if not isinstance(result, dict) or result.get("status") not in {"passed", "failed", "unknown"}:
            raise AgentError("INVALID_PLAN_RESULT", "Condition callback must return passed, failed or unknown.")
        return result

    def checked_condition(value, path, kind):
        return run_step(kind, path, lambda: condition(value))

    def commands(step, path):
        nonlocal last_result
        command = step["command"]

        def execute():
            nonlocal last_result
            params = deepcopy(step["input"])
            value_field = "text" if command == "fill" else "equals" if command == "wait" else None
            if value_field and isinstance(params.get(value_field), dict):
                expected_type = str if value_field == "text" or params.get("property", "text") == "text" else bool
                params[value_field] = resolve_value(params[value_field], expected_type, bindings)
            if "expect" in params:
                params["expect"] = resolved_condition(params["expect"])
            if step.get("before"):
                params["_plan_before"] = [resolved_condition(item) for item in step["before"]]
            if step.get("refresh"):
                params["_plan_refresh"] = True
            result = executor(command, params)
            if not isinstance(result, dict):
                raise AgentError("INVALID_PLAN_RESULT", "Command callback must return a result object.",
                                 dispatched="unknown" if command in MUTATIONS else "no")
            last_result = result
            return _summary(result)

        result = run_step("command", path, execute, is_action=command in MUTATIONS, command=command)
        if command in MUTATIONS:
            action = result.get("action", {})
            if action.get("status") != "completed" or action.get("dispatched") != "acknowledged":
                raise _Halt("unknown", "action_not_confirmed")
        if command == "fill":
            status = result.get("inputVerification", {}).get("status")
            if status != "passed":
                raise _Halt("failed" if status == "failed" else "unknown", "input_not_verified")
        if command in MUTATIONS or command == "wait":
            status = result.get("assertion", {}).get("status")
            accepted = {"passed"} if "expect" in step["input"] or command in {"fill", "wait"} else {"passed", "not_requested"}
            if status not in accepted:
                raise _Halt("failed" if status == "failed" else "unknown", "postcondition_not_verified")

    def read(spec, path):
        def collect():
            if reader is None:
                raise AgentError("PLAN_READ_FAILED", "The executor has no bound-value reader.", dispatched="no")
            result = normalize_read_result(spec, reader(deepcopy(spec)))
            bindings[spec["name"]] = result["value"]
            return result
        return run_step("read", path, collect)

    def walk(values, path):
        for index, step in enumerate(values):
            location = f"{path}[{index}]"
            budget.check()
            if "command" in step:
                commands(step, location)
            elif "read" in step:
                read(step["read"], location)
            elif "assert" in step:
                result = checked_condition(step["assert"], location, "assert")
                if result["status"] != "passed":
                    raise _Halt("unknown" if result["status"] == "unknown" else "failed", "assertion_not_verified")
            elif "if" in step:
                result = checked_condition(step["if"], location, "if")
                if result["status"] == "unknown":
                    raise _Halt("unknown", "branch_condition_unknown")
                branch = "then" if result["status"] == "passed" else "else"
                walk(step[branch], location + "." + branch)
            elif "repeat" in step:
                repeat = step["repeat"]
                for attempt in range(repeat["limit"] + 1):
                    result = checked_condition(repeat["until"], f"{location}.repeat.check[{attempt}]", "repeat")
                    if result["status"] == "passed":
                        break
                    if result["status"] == "unknown":
                        raise _Halt("unknown", "repeat_condition_unknown")
                    if attempt == repeat["limit"]:
                        raise _Halt("yielded", "repeat_limit")
                    walk(repeat["steps"], f"{location}.repeat.iteration[{attempt}]")
            else:
                kind = "yield" if "yield" in step else "stop"
                run_step(kind, location, lambda: {"reason": step[kind]})
                raise _Halt("yielded" if kind == "yield" else "completed", step[kind])

    def verify_goals():
        if not definition["goals"]:
            return
        verification = output["goalVerification"]
        verification["status"] = "unknown"
        for index, goal in enumerate(definition["goals"]):
            result = checked_condition(goal, f"goals[{index}]", "goal")
            verification["assertions"].append(deepcopy(result))
            if result["status"] != "passed":
                verification["status"] = result["status"]
                raise _Halt("unknown" if result["status"] == "unknown" else "failed", "goal_not_verified")
        verification["status"] = "passed"

    try:
        for index, precondition in enumerate(definition["preconditions"]):
            result = checked_condition(precondition, f"preconditions[{index}]", "precondition")
            if result["status"] != "passed":
                raise _Halt("unknown" if result["status"] == "unknown" else "yielded", "precondition_not_met")
        try:
            walk(definition["steps"], "steps")
        except _Halt as stop:
            if stop.status != "completed":
                raise
            output["yieldReason"] = stop.reason
        verify_goals()
        output["status"] = "completed"
    except _Halt as stop:
        output.update(status=stop.status, yieldReason=stop.reason)
    except KeyboardInterrupt:
        output.update(status="cancelled", yieldReason="cancelled",
                      error={"code": "CANCELLED", "message": "Plan interrupted; observe before continuing."})
    except AgentError as exc:
        output.update(status=_error_status(exc), yieldReason=exc.code, error=exc.to_dict())
    output["counters"] = budget.snapshot()
    output["timings"] = {"totalMs": output["counters"]["elapsedMs"]}
    if last_result is not None:
        output["lastResult"] = last_result
    return output
