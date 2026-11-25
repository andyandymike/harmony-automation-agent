"""Recorded device gestures that may appear inside a validated workflow."""

from __future__ import annotations

import re

from .errors import AgentError


COMMAND = "deviceGesture"
MAX_DELAY_MS = 2_147_483_647
_POINT = ("x", "y")
_PATH = (*_POINT, "toX", "toY")
_TAPS = ("click", "doubleClick", "longClick")
_MOTION = ("swipe", "drag", "fling")
_KEYS = {"back": "Back", "home": "Home"}
_FIELDS = {**dict.fromkeys(_TAPS, _POINT), **dict.fromkeys((*_MOTION, "recents"), _PATH),
           **dict.fromkeys(_KEYS, ()), "pinch": ("fingers",), "typeText": ("text",)}
_COORDINATE = {"type": "integer", "minimum": 0, "maximum": 2_147_483_647}
_VELOCITY = {"type": "integer", "minimum": 200, "maximum": 40000}


def _invalid(message):
    raise AgentError("INVALID_ARGUMENT", message, exit_code=2)


def _bounded_integer(value, limits):
    return type(value) is int and limits["minimum"] <= value <= limits["maximum"]


def validate_gesture(value):
    kind = value.get("kind")
    if not isinstance(kind, str) or kind not in _FIELDS:
        _invalid("Use a supported recorded gesture.")
    fields = _FIELDS[kind]
    allowed = {"kind", *fields}
    if kind in _MOTION or kind == "recents":
        allowed.add("velocity")
    if set(value) - allowed or any(key not in value for key in fields):
        _invalid("The gesture is missing coordinates or contains unsupported fields.")
    if "velocity" in value and not _bounded_integer(value["velocity"], _VELOCITY):
        _invalid("Gesture velocity must be between 200 and 40000.")
    if kind == "pinch":
        fingers = value["fingers"]
        if not isinstance(fingers, list) or len(fingers) != 2 or any(
            not isinstance(finger, dict) or set(finger) != set(_PATH) or
            not all(_bounded_integer(finger[key], _COORDINATE) for key in _PATH)
            for finger in fingers
        ):
            _invalid("A pinch requires two valid finger paths.")
        if all(fingers[0][key] == fingers[1][key] for key in _POINT):
            _invalid("The two fingers must start at different points.")
    elif kind == "typeText":
        text = value["text"]
        if not isinstance(text, str) or not text or any(char in text for char in "\x00\r\n") or len(text.encode("utf-8")) > 4096:
            _invalid("Enter one line of text up to 4096 UTF-8 bytes.")
    elif any(not _bounded_integer(value[key], _COORDINATE) for key in fields):
        _invalid("The gesture contains invalid coordinates.")
    return value


def gesture_schema():
    finger = {"type": "object", "additionalProperties": False, "required": list(_PATH),
              "properties": {key: dict(_COORDINATE) for key in _PATH}}
    variants = []
    for kind, fields in _FIELDS.items():
        props = {"kind": {"const": kind}}
        if kind == "pinch":
            props["fingers"] = {"type": "array", "minItems": 2, "maxItems": 2, "items": finger}
        elif kind == "typeText":
            props["text"] = {"type": "string", "minLength": 1, "maxLength": 4096, "pattern": r"^[^\x00\r\n]+$"}
        else:
            props.update({key: dict(_COORDINATE) for key in fields})
            if kind in _MOTION or kind == "recents":
                props["velocity"] = dict(_VELOCITY)
        variants.append({"type": "object", "additionalProperties": False,
                         "required": ["kind", *fields], "properties": props})
    return {"oneOf": variants}


def gesture_arguments(value, help_text=""):
    kind = value["kind"]
    if kind in _KEYS:
        return ["uitest", "uiInput", "keyEvent", _KEYS[kind]]
    if kind == "typeText":
        return ["uitest", "uiInput", "text", value["text"]]
    if kind in ("pinch", "recents"):
        touch_help = re.search(r"^-T\s+--touch\b([\s\S]*)", help_text, re.MULTILINE)
        help_text = touch_help[1] if touch_help else ""
        if kind == "recents" and re.search(r"-k\s+keep time", help_text, re.IGNORECASE):
            return ["uinput", "-T", "-m", *(str(value[key]) for key in _PATH), "-k", "650", "320"]
        if kind == "pinch" and re.search(r"up to\s+(?:two|three|[23])[- ]fingers?\b", help_text, re.IGNORECASE):
            return ["uinput", "-T", "-m", *(str(finger[key]) for finger in value["fingers"] for key in _PATH), "350"]
        raise AgentError("DEVICE_TOUCH_UNSUPPORTED", "This phone does not expose the required touch input command.", dispatched="no")
    command = ["uitest", "uiInput", kind, *(str(value[key]) for key in _FIELDS[kind])]
    if kind in _MOTION and "velocity" in value:
        command.append(str(value["velocity"]))
    return command
