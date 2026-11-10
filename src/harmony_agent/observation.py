"""Normalize Harmony UI trees without discarding non-interactive business state.

Only standard-library types cross this module's boundary. Full observations are
immutable inputs to display projection; refs are valid only for their frame.
"""
from __future__ import annotations

from collections import Counter
from copy import deepcopy
import json
import math
import re

from .errors import AgentError

BOOL_FIELDS = ("enabled", "visible", "clickable", "longClickable", "checkable",
               "checked", "selected", "focused", "scrollable", "editable")
CONTEXT_FIELDS = ("bundleName", "abilityName", "pagePath", "hostWindowId", "displayId")
TEXT_FIELDS = ("id", "key", "text", "originalText", "type", "hint", "description", "value",
               "accessibilityId", "uniqueId")
ALIASES = {"app": "bundleName", "window": "hostWindowId", "windowId": "hostWindowId",
           "display": "displayId"}
SELECTOR_FIELDS = set(BOOL_FIELDS + CONTEXT_FIELDS + TEXT_FIELDS + ("ref", "parent"))
CHANGE_FIELDS = ("text", "originalText", "textSource", "value", "hint", "description", "bounds", "type") + BOOL_FIELDS
UI_ATTRIBUTE_FIELDS = set(BOOL_FIELDS + CONTEXT_FIELDS + TEXT_FIELDS + ("bounds", "origBounds", "hierarchy"))
_REF = re.compile(r"^@e[1-9][0-9]*~(.+)$")


def _string(value):
    if value is None:
        return None
    return str(value)


def _boolean(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        if value.strip().lower() == "true":
            return True
        if value.strip().lower() == "false":
            return False
    if isinstance(value, int) and value in (0, 1):
        return bool(value)
    return None


def _bounds(value):
    """Return inclusive-source rectangle coordinates, never inventing a rect."""
    try:
        if isinstance(value, str):
            match = re.fullmatch(r"\s*\[(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\]"
                                 r"\[(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\]\s*", value)
            if not match:
                return None
            numbers = [float(part) for part in match.groups()]
        elif isinstance(value, dict):
            numbers = [float(value[k]) for k in ("left", "top", "right", "bottom")]
        elif isinstance(value, (list, tuple)) and len(value) == 4:
            numbers = [float(x) for x in value]
        else:
            return None
        if not all(math.isfinite(n) for n in numbers):
            return None
        left, top, right, bottom = numbers
        if right < left or bottom < top:
            return None
        return dict(zip(("left", "top", "right", "bottom"),
                        [int(n) if n.is_integer() else n for n in numbers]))
    except (TypeError, ValueError, KeyError, OverflowError):
        return None


def _actionable(node):
    return any(node.get(key) is True for key in
               ("clickable", "longClickable", "scrollable", "editable", "checkable"))


def _fact(node):
    return (any(node.get(k) not in (None, "") for k in ("text", "hint", "description"))
            or node.get("value") is not None or node.get("checkable") is True
            or any(node.get(k) is True for k in ("checked", "selected", "focused")))


def _node_identity(node):
    context = [node.get(k) for k in ("bundleName", "hostWindowId", "displayId")]
    for key in ("id", "uniqueId", "accessibilityId"):
        if node.get(key):
            return json.dumps([key, *context, node[key]], ensure_ascii=False, separators=(",", ":"))
    return None


def _scope(scope):
    if scope is None or scope in ("screen", "all"):
        return {"kind": "screen"}
    if isinstance(scope, str):
        return {"kind": "app", "bundleName": scope}
    if not isinstance(scope, dict):
        raise AgentError("INVALID_SCOPE", "Scope must be an app name or an object.")
    out = {}
    for key, value in scope.items():
        canonical = ALIASES.get(key, key)
        if canonical not in ("kind", "bundleName", "hostWindowId", "displayId"):
            raise AgentError("INVALID_SCOPE", f"Unsupported scope field: {key}")
        if value is not None:
            out[canonical] = str(value)
    return {"kind": out.pop("kind", "screen"), **out}


def normalize_layout(raw, frame_id, *, scope=None):
    """Normalize supported attributes from dict/list Harmony dump roots.

    bounds is a left/top/right/bottom dict; center is an x/y dict. facts and
    controls contain node objects. Anonymous nodes deliberately have no stable
    cross-frame identity: paths can change after insertion or virtual scrolling.
    """
    if not isinstance(frame_id, str) or not frame_id or "~" in frame_id:
        raise AgentError("INVALID_FRAME", "A nonempty frame id without '~' is required.")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AgentError("INVALID_LAYOUT", "The layout is not valid JSON.") from exc
    if not isinstance(raw, (dict, list)):
        raise AgentError("INVALID_LAYOUT", "Expected a layout object or list of roots.")
    if isinstance(raw, dict) and (raw.get("success") is False or raw.get("error")
                                 or raw.get("status") in ("error", "failed", "failure")):
        raise AgentError("INVALID_LAYOUT", "The layout response reports an error, not a UI tree.")
    scope_value = _scope(scope)
    nodes, warnings = [], []
    roots = raw if isinstance(raw, list) else [raw]
    # A known explicit wrapper is accepted; arbitrary dictionaries are not
    # silently traversed as trees.
    if isinstance(raw, dict) and "attributes" not in raw and "roots" in raw:
        roots = raw["roots"]
        if not isinstance(roots, list):
            raise AgentError("INVALID_LAYOUT", "Layout roots must be an array.")

    def visit(item, parent=None, context=None, path=()):
        if not isinstance(item, dict):
            warnings.append({"code": "INVALID_NODE", "path": list(path)})
            return
        attributes = item.get("attributes", item)
        if not isinstance(attributes, dict):
            warnings.append({"code": "INVALID_ATTRIBUTES", "path": list(path)})
            attributes = {}
        children = item.get("children", [])
        # Empty arrays are an explicit empty observation. An arbitrary dict,
        # including an error response, is not an empty UI tree. A structural
        # container with children is allowed, but malformed descendants keep
        # the observation incomplete so absence assertions cannot pass.
        ui_fields = UI_ATTRIBUTE_FIELDS if "attributes" in item else {
            "id", "key", "type", "bounds", "origBounds", "accessibilityId", "uniqueId"}
        if not (ui_fields.intersection(attributes)
                or isinstance(children, list) and children):
            warnings.append({"code": "UNRECOGNIZED_NODE_FORMAT", "path": list(path)})
            return
        current_context = dict(context or {})
        for name in CONTEXT_FIELDS:
            if attributes.get(name) not in (None, ""):
                current_context[name] = str(attributes[name])
        node = {name: _string(attributes.get(name)) for name in TEXT_FIELDS}
        node.update({name: _boolean(attributes.get(name)) for name in BOOL_FIELDS})
        node.update({name: current_context.get(name) for name in CONTEXT_FIELDS})
        node["id"] = node["id"] or node["key"] or None
        node["ref"] = f"@e{len(nodes) + 1}~{frame_id}"
        node["parent"] = parent
        node["path"] = list(path)
        node["bounds"] = _bounds(attributes.get("bounds"))
        rect = node["bounds"]
        node["center"] = ({"x": int((rect["left"] + rect["right"]) / 2),
                           "y": int((rect["top"] + rect["bottom"]) / 2)} if rect else None)
        known_input = (node["type"] or "").lower() in ("textinput", "textarea", "textfield", "edittext")
        if node["editable"] is None and known_input:
            node["editable"] = True
        # UiTest may leave text empty while exposing display content through
        # originalText. Do not reinterpret editable text: fill/clear/wait rely
        # on its native current value, including an explicitly empty string.
        if (not known_input and node["editable"] is not True
                and node["text"] in (None, "") and node["originalText"] not in (None, "")):
            node["text"] = node["originalText"]
            node["textSource"] = "originalText"
        if node["value"] is None and known_input:
            node["value"] = node["text"]
        node["sources"] = {"editable": "type" if _boolean(attributes.get("editable")) is None and known_input else "attribute",
                           "value": "text" if attributes.get("value") is None and known_input else "attribute"}
        nodes.append(node)
        if not isinstance(children, list):
            warnings.append({"code": "INVALID_CHILDREN", "ref": node["ref"]})
            return
        for index, child in enumerate(children):
            visit(child, node["ref"], current_context, path + (index,))

    for index, root in enumerate(roots):
        visit(root, path=(index,))
    if roots and not nodes:
        raise AgentError("INVALID_LAYOUT", "The layout contains no valid nodes.")
    filters = {k: v for k, v in scope_value.items() if k != "kind"}
    if filters:
        selected = {n["ref"] for n in nodes if all(n.get(k) == v for k, v in filters.items())}
        by_ref = {n["ref"]: n for n in nodes}
        for ref in list(selected):
            parent = by_ref[ref]["parent"]
            while parent is not None:
                selected.add(parent)
                parent = by_ref[parent]["parent"]
        nodes = [n for n in nodes if n["ref"] in selected]
    # Resource ids are context scoped. Duplicate ids never become fake stable
    # identities by appending an arbitrary occurrence index.
    counts = Counter(_node_identity(n) for n in nodes if _node_identity(n) is not None)
    for node in nodes:
        candidate = _node_identity(node)
        node["identity"] = candidate if candidate and counts[candidate] == 1 else None
    return {"frameId": frame_id, "nodes": nodes,
            "controls": [n for n in nodes if _actionable(n)],
            "facts": [n for n in nodes if _fact(n)],
            "projection": {"schema": "harmony-layout/1", "scope": scope_value, "view": "full"},
            "quality": {"complete": not warnings, "truncated": False, "warnings": warnings,
                        "totalNodes": len(nodes), "returnedNodes": len(nodes)}}


def parse_selector(selector):
    """Return a validated selector with canonical field names."""
    if isinstance(selector, str):
        if selector.startswith("@"):
            return {"ref": selector}
        key, separator, value = selector.partition("=")
        if not separator:
            raise AgentError("INVALID_SELECTOR", "Use id=..., text=..., type=..., or a frame ref.")
        selector = {key: value}
    if not isinstance(selector, dict) or not selector:
        raise AgentError("INVALID_SELECTOR", "A nonempty selector is required.")
    if selector.get("kind") == "selector" and set(selector) == {"kind", "selector"}:
        return parse_selector(selector["selector"])
    if selector.get("kind") == "ref" and set(selector) == {"kind", "ref"}:
        return parse_selector({"ref": selector["ref"]})
    parsed = {}
    for key, value in selector.items():
        name = ALIASES.get(key, key)
        if name not in SELECTOR_FIELDS and name != "within":
            raise AgentError("INVALID_SELECTOR", f"Unsupported selector field: {key}")
        if name in parsed:
            raise AgentError("INVALID_SELECTOR", f"Duplicate selector field: {name}")
        if name in BOOL_FIELDS:
            normalized = _boolean(value)
            if normalized is None and value is not None:
                raise AgentError("INVALID_SELECTOR", f"{name} requires true, false, or null.")
            value = normalized
        elif name != "within" and value is not None:
            if not isinstance(value, (str, int)) or isinstance(value, bool):
                raise AgentError("INVALID_SELECTOR", f"{name} requires a string.")
            value = str(value)
        parsed[name] = value
    return parsed


_selector = parse_selector


def selector_uses_refs(selector):
    """Whether a selector depends on refs from one observation frame."""
    parsed = parse_selector(selector)
    return (bool(parsed.get("ref")) or parsed.get("parent") is not None
            or parsed.get("within") is not None and selector_uses_refs(parsed["within"]))


def select_nodes(observation, selector):
    """Select exact matches; within restricts matches to descendants of a container."""
    parsed = parse_selector(selector)
    for field in ("ref", "parent"):
        ref = parsed.get(field)
        if ref is None:
            continue
        match = _REF.fullmatch(ref)
        if not match or match.group(1) != observation.get("frameId"):
            raise AgentError("STALE_REF", "The reference does not belong to the current frame.",
                             details={"frameId": observation.get("frameId"), "ref": ref, "field": field})
    within = parsed.pop("within", None)
    nodes = observation.get("nodes", [])
    matches = [n for n in nodes if all(n.get(k) == v for k, v in parsed.items())]
    if within is not None:
        ancestor_refs = {n["ref"] for n in select_nodes(observation, within)}
        by_ref = {n["ref"]: n for n in nodes}
        def contained(node):
            parent = node.get("parent")
            seen = set()
            while parent is not None and parent not in seen:
                if parent in ancestor_refs:
                    return True
                seen.add(parent)
                parent = by_ref.get(parent, {}).get("parent")
            return False
        matches = [n for n in matches if contained(n)]
    return matches


def _summary(node):
    return {k: node.get(k) for k in ("ref", "id", "text", "type", "parent", "bundleName", "hostWindowId", "bounds")}


def resolve_target(observation, selector):
    matches = select_nodes(observation, selector)
    if not matches:
        raise AgentError("TARGET_NOT_FOUND", "No element matches the selector.", details={"selector": selector})
    if len(matches) != 1:
        raise AgentError("TARGET_AMBIGUOUS", "More than one element matches; add context or use a current ref.",
                         details={"count": len(matches), "candidates": [_summary(n) for n in matches[:20]]})
    return matches[0]


def diff_observations(previous, current):
    """Diff only compatible complete views; anonymous node changes stay unknown."""
    if previous.get("projection") != current.get("projection"):
        return {"comparable": False, "reason": "projection-mismatch", "added": [], "removed": [], "changed": []}
    if any(not o.get("quality", {}).get("complete", False) or o.get("quality", {}).get("truncated", False)
           for o in (previous, current)):
        return {"comparable": False, "reason": "incomplete-observation", "added": [], "removed": [], "changed": []}
    identity_counts = [Counter(_node_identity(n) for n in o["nodes"]
                               if _node_identity(n) is not None) for o in (previous, current)]
    ambiguous = {identity for counts in identity_counts for identity, count in counts.items() if count > 1}
    # An identity becoming ambiguous is not evidence that its old node vanished.
    # Exclude that identity from both sides, including the formerly unique node.
    before = {n["identity"]: n for n in previous["nodes"]
              if n.get("identity") and n["identity"] not in ambiguous}
    after = {n["identity"]: n for n in current["nodes"]
             if n.get("identity") and n["identity"] not in ambiguous}
    changed = []
    for identity in before.keys() & after.keys():
        old, new = before[identity], after[identity]
        fields = [k for k in CHANGE_FIELDS if old.get(k) != new.get(k)]
        if fields:
            changed.append({"identity": identity, "id": new.get("id"), "ref": new["ref"],
                            "before": {k: old.get(k) for k in fields}, "after": {k: new.get(k) for k in fields}})
    unknown_before = sum(not n.get("identity") or n["identity"] in ambiguous for n in previous["nodes"])
    unknown_after = sum(not n.get("identity") or n["identity"] in ambiguous for n in current["nodes"])
    return {"comparable": True, "complete": not (unknown_before or unknown_after),
            "added": [_summary(after[k]) for k in sorted(after.keys() - before.keys())],
            "removed": [_summary(before[k]) for k in sorted(before.keys() - after.keys())],
            "changed": sorted(changed, key=lambda c: c["identity"]),
            "unmatched": {"previous": unknown_before, "current": unknown_after},
            "ambiguous": {"identities": len(ambiguous),
                          "previous": sum(identity_counts[0][key] for key in ambiguous),
                          "current": sum(identity_counts[1][key] for key in ambiguous)}}


def project_diff(diff, previous_public, current_public, *, max_changes):
    """Limit a full diff to displayed refs and one shared change budget.

    Added/changed refs belong to the current frame; removed refs belong to the
    previous frame. Filtering and budget omission are counted separately:
    total = matched + filtered, matched = returned + omitted. A filtered or
    truncated diff cannot claim to describe all changes in the full frames.
    """
    if type(max_changes) is not int or max_changes < 1:
        raise AgentError("INVALID_ARGUMENT", "max_changes must be a positive integer.")
    previous_refs = {n["ref"] for n in previous_public.get("nodes", [])}
    current_refs = {n["ref"] for n in current_public.get("nodes", [])}
    out = deepcopy(diff)
    total = matched = returned = 0
    for kind in ("added", "removed", "changed"):
        changes = diff.get(kind, [])
        allowed_refs = previous_refs if kind == "removed" else current_refs
        eligible = [change for change in changes if change.get("ref") in allowed_refs]
        selected = eligible[:max_changes - returned]
        out[kind] = deepcopy(selected)
        total += len(changes)
        matched += len(eligible)
        returned += len(selected)
    omitted = matched - returned
    filtered = total - matched
    complete = (diff.get("comparable") is True and diff.get("complete") is True
                and not omitted and not filtered)
    out.update(previousFrameId=previous_public.get("frameId"),
               currentFrameId=current_public.get("frameId"), complete=complete,
               quality={"total": total, "matched": matched, "returned": returned,
                        "omitted": omitted, "filtered": filtered,
                        "truncated": bool(omitted), "complete": complete})
    return out


def project_observation(observation, *, max_nodes=80, interactive=False, query=None):
    """Return bounded nodes plus ref-only controls/facts indexes.

    Nodes contain all business fields exactly once, excluding internal path,
    identity and source bookkeeping. Quality reports omitted
    nodes, facts, controls and missing ancestors so a small budget never implies
    that excluded state is absent. Full normalized observations remain intact.
    """
    if isinstance(max_nodes, bool) or not isinstance(max_nodes, int) or max_nodes < 1:
        raise AgentError("INVALID_ARGUMENT", "max_nodes must be a positive integer.")
    nodes = observation.get("nodes", [])
    by_ref = {n["ref"]: n for n in nodes}
    if query is not None:
        if not isinstance(query, str):
            raise AgentError("INVALID_ARGUMENT", "find query must be text.")
        needle = query.casefold()
        primary = [n for n in nodes if any(needle in str(n.get(k) or "").casefold()
                   for k in ("id", "text", "originalText", "type", "hint", "description", "value"))]
    else:
        primary = [n for n in nodes if _actionable(n) or _fact(n)]
    selected = {n["ref"] for n in primary}
    for node in primary:
        parent = node.get("parent")
        while parent in by_ref:
            selected.add(parent)
            parent = by_ref[parent].get("parent")
    if not interactive and query is None:
        selected = set(by_ref)
    eligible = [n for n in nodes if n["ref"] in selected]
    # Facts/actions get budget priority. Remaining ancestors/background nodes
    # are included in document order, with incompleteness explicitly marked.
    priority_refs = [n["ref"] for n in primary]
    primary_set = set(priority_refs)
    priority_refs += [n["ref"] for n in eligible if n["ref"] not in primary_set]
    kept = set(priority_refs[:max_nodes])
    out = deepcopy(observation)
    out["nodes"] = [deepcopy(n) for n in nodes if n["ref"] in kept]
    for node in out["nodes"]:
        for field in ("identity", "path", "sources"):
            node.pop(field, None)
        if node.get("key") == node.get("id"):
            node.pop("key", None)
        for field in ("uniqueId", "accessibilityId", "originalText"):
            if node.get(field) in (None, ""):
                node.pop(field, None)
    out["controls"] = [n["ref"] for n in out["nodes"] if _actionable(n)]
    out["facts"] = [n["ref"] for n in out["nodes"] if _fact(n)]
    truncated = len(eligible) > len(kept)
    missing_context = {n["parent"] for n in out["nodes"]
                       if n.get("parent") in by_ref and n["parent"] not in kept}
    out["projection"] = {**deepcopy(observation["projection"]), "view": {
        "interactive": bool(interactive), "query": query, "maxNodes": max_nodes}}
    out["quality"].update({"complete": observation["quality"].get("complete", False) and not truncated,
                          "truncated": truncated, "totalNodes": len(nodes),
                          "matchedNodes": len(primary), "eligibleNodes": len(eligible),
                          "returnedNodes": len(out["nodes"]),
                          "omittedNodes": len(eligible) - len(kept),
                          "omittedFacts": sum(_fact(n) for n in eligible) - len(out["facts"]),
                          "omittedControls": sum(_actionable(n) for n in eligible) - len(out["controls"]),
                          "missingContextNodes": len(missing_context)})
    if truncated:
        out["quality"]["warnings"].append({"code": "OUTPUT_TRUNCATED", "omittedNodes": len(eligible) - len(kept)})
    return out
