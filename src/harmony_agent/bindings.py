"""Closed scalar data bindings for version-2 plans; never code evaluation."""

from copy import deepcopy
import re

from .errors import AgentError


NAME_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]{0,63}$"
MAX_CONCAT_PARTS = 32
MAX_BOUND_TEXT = 20000


def invalid(message, path):
    raise AgentError("INVALID_PLAN", message, details={"path": path}, exit_code=2)


def variable_name(value, path):
    if not isinstance(value, str) or re.fullmatch(NAME_PATTERN, value) is None:
        invalid("A binding name must be a 1-64 character identifier.", path)
    return value


def validate_expression(value, expected_type, path, references):
    """Validate an expression and collect its typed variable references."""
    if not isinstance(value, dict):
        invalid("Expected a closed value expression.", path)
    if set(value) == {"var"}:
        name = variable_name(value["var"], path + ".var")
        references.append((name, expected_type, path))
        return {"var": name}
    if set(value) == {"concat"}:
        if expected_type is not str:
            invalid("Concatenation can only produce a text value.", path)
        parts = value["concat"]
        if not isinstance(parts, list) or not 1 <= len(parts) <= MAX_CONCAT_PARTS:
            invalid("concat requires 1-32 literal strings or variable references.", path)
        normalized = []
        for index, part in enumerate(parts):
            location = f"{path}.concat[{index}]"
            if isinstance(part, str):
                if len(part) > MAX_BOUND_TEXT:
                    invalid("A concatenation literal is too long.", location)
                normalized.append(part)
            elif isinstance(part, dict) and set(part) == {"var"}:
                normalized.append(validate_expression(part, str, location, references))
            else:
                invalid("Concatenation accepts only literal strings and var references.", location)
        return {"concat": normalized}
    invalid("Only var and concat value expressions are supported.", path)


def check_references(references, declarations):
    for name, expected_type, path in references:
        actual_type = declarations.get(name)
        if actual_type is None:
            invalid("A value expression references an undeclared binding.", path)
        if actual_type is not expected_type:
            invalid("The declared binding type does not match this value field.", path)


def binding_failed(message, **details):
    raise AgentError("PLAN_BINDING_FAILED", message, details=details, dispatched="no")


def resolve_value(value, expected_type, values):
    """Resolve only already validated scalar expressions from this run."""
    if isinstance(value, dict):
        if "var" in value:
            name = value["var"]
            if name not in values:
                binding_failed("A binding has not been read on the executed path.", name=name)
            resolved = values[name]
        else:
            resolved = "".join(resolve_value(part, str, values) for part in value["concat"])
    else:
        resolved = value
    if type(resolved) is not expected_type:
        binding_failed("A bound value has the wrong type.")
    if isinstance(resolved, str) and len(resolved) > MAX_BOUND_TEXT:
        binding_failed("A bound text value exceeds the supported length.")
    return resolved


def normalize_read_result(spec, result):
    """Check a source scalar and retain its frame identity before binding it."""
    expected_type = str if spec["property"] == "text" else bool
    if not isinstance(result, dict) or not isinstance(result.get("frameId"), str) or not result["frameId"]:
        binding_failed("A read callback must return a value and source frame ID.", name=spec["name"])
    value = result.get("value")
    if type(value) is not expected_type:
        binding_failed("The requested source property is missing or has the wrong type.", name=spec["name"])
    if isinstance(value, str) and len(value) > MAX_BOUND_TEXT:
        binding_failed("A source text value exceeds the supported length.", name=spec["name"])
    if "stripPrefix" in spec:
        prefix = spec["stripPrefix"]
        if not value.startswith(prefix):
            binding_failed("The source text does not have the declared prefix.", name=spec["name"])
        value = value[len(prefix):]
    normalized = {"name": spec["name"], "value": value, "frameId": result["frameId"],
                  "selector": deepcopy(spec["selector"]), "property": spec["property"]}
    if "stripPrefix" in spec:
        normalized["stripPrefix"] = spec["stripPrefix"]
    if "evidenceRef" in result:
        normalized["evidenceRef"] = deepcopy(result["evidenceRef"])
    return normalized


def expression_schema():
    variable = {"type": "object", "additionalProperties": False, "required": ["var"],
                "properties": {"var": {"type": "string", "pattern": NAME_PATTERN}}}
    concat = {"type": "object", "additionalProperties": False, "required": ["concat"],
              "properties": {"concat": {"type": "array", "minItems": 1, "maxItems": MAX_CONCAT_PARTS,
                                          "items": {"oneOf": [{"type": "string", "maxLength": MAX_BOUND_TEXT},
                                                               deepcopy(variable)]}}}}
    return {"textValue": {"oneOf": [{"type": "string"}, deepcopy(variable), concat]},
            "booleanValue": {"oneOf": [{"type": "boolean"}, deepcopy(variable)]}}
