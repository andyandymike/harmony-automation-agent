"""Deterministic decision views over immutable, fully normalized UI frames.

The view groups related evidence without guessing a page's business meaning.
Items and regions retain frame-scoped refs; these are not permanent locators.
``actions`` indexes controls with observed capabilities, not guaranteed enabled
targets. Execution must still resolve against a fresh full observation.
"""

from __future__ import annotations

from copy import deepcopy

from .errors import AgentError
from .observation import BOOL_FIELDS, CONTEXT_FIELDS


PAGE_SCHEMA = "harmony-page/1"
_CONTENT_FIELDS = ("text", "value", "originalText", "description", "hint")
_SEARCH_FIELDS = ("id", "key", "type") + _CONTENT_FIELDS
_ACTION_FIELDS = ("clickable", "longClickable", "scrollable", "editable", "checkable")
_TEXT_TYPES = {"text", "span", "richtext"}
_STRUCTURAL_TYPES = {"blank", "column", "divider", "flex", "grid", "griditem", "image",
                     "list", "listitem", "relativecontainer", "row", "scroll", "stack",
                     "symbolglyph", "window"}


def _is_action(node):
    return any(node.get(field) is True for field in _ACTION_FIELDS)


def _default_structural_states(node):
    # Native UiTest trees commonly publish this entire false-state tuple on
    # blank layout/decorative nodes. It does not make each container a business
    # fact. Do not apply this to sparse state evidence, unknown/custom types,
    # content, explicit values (including empty), or actionable controls.
    return ((node.get("type") or "").lower() in _STRUCTURAL_TYPES
            and not _is_action(node)
            and node.get("value") is None
            and all(node.get(field) in (None, "") for field in _CONTENT_FIELDS)
            and all(node.get(field) is False for field in ("checkable", "checked", "selected", "focused")))


def _is_fact(node):
    # False checked/selected/focused states are evidence too. An empty value is
    # never replaced with a hint or display label.
    return (any(node.get(field) not in (None, "") for field in _CONTENT_FIELDS)
            or node.get("value") is not None
            or node.get("text") == "" and (node.get("type") or "").lower() in _TEXT_TYPES
            or (any(node.get(field) is not None for field in ("checked", "selected", "focused"))
                and not _default_structural_states(node))
            or node.get("checkable") is True)


def _label(node):
    fields = (("description", "hint", "text", "originalText")
              if node.get("editable") is True else
              ("text", "description", "hint", "originalText"))
    for field in fields:
        if node.get(field) not in (None, ""):
            source = node.get("textSource", "text") if field == "text" else field
            return node[field], {"ref": node["ref"], "field": source}
    return None, None


def _roles(node):
    roles = []
    if node.get("editable") is True:
        roles.append("field")
    if _is_fact(node):
        roles.append("fact")
    if _is_action(node):
        roles.append("action")
    return roles


def _descriptor(node, surface):
    result = {"ref": node["ref"], "surface": surface}
    for field in ("id", "type"):
        if node.get(field) is not None:
            result[field] = node[field]
    label, source = _label(node)
    if source is not None:
        result.update(label=label, labelSource=source)
    state = {field: node[field] for field in BOOL_FIELDS if node.get(field) is not None}
    if state:
        result["state"] = state
    return result


def semantic_page(observation, *, max_items=80, query=None):
    """Return a source-linked, region-organized view without modifying a frame.

    ``items`` stores each field/fact/control once. ``fields``, ``facts`` and
    ``actions`` are ref-only indexes. ``regions`` contains the ancestor chain
    of every returned item, including known ancestor states. ``surface`` is an
    index into ``context.surfaces`` and carries exact app/window metadata.

    A query matches candidate content or an ancestor's metadata; it never
    claims absence outside the filtered view. Quality counts distinguish
    query exclusions from item-budget omissions. ``absenceEvidence`` is always
    false: deterministic assertions must inspect the full captured frame.
    Blank structural nodes with UiTest's generic false-state tuple do not
    consume the item budget. Required ancestors and their exact known states
    remain in ``regions``; frozen inspection can expand every original node.
    """
    if type(max_items) is not int or not 1 <= max_items <= 5000:
        raise AgentError("INVALID_ARGUMENT", "max_items must be an integer from 1 to 5000.", exit_code=2)
    if query is not None and not isinstance(query, str):
        raise AgentError("INVALID_ARGUMENT", "Semantic query must be text.", exit_code=2)
    if not isinstance(observation, dict) or not isinstance(observation.get("nodes"), list):
        raise AgentError("INVALID_FRAME", "Semantic views require a normalized observation.")

    nodes = observation["nodes"]
    by_ref = {node["ref"]: node for node in nodes}
    roles = {node["ref"]: _roles(node) for node in nodes}
    candidates = [node for node in nodes if roles[node["ref"]]]
    needle = query.casefold() if query is not None else None
    match_cache = {}

    def matches(node):
        if needle is None:
            return True
        ref = node["ref"]
        trail, seen = [], set()
        while ref in by_ref and ref not in seen and ref not in match_cache:
            seen.add(ref)
            current = by_ref[ref]
            trail.append(ref)
            if any(needle in str(current.get(field) if current.get(field) is not None else "").casefold()
                   for field in _SEARCH_FIELDS):
                match_cache[ref] = True
                break
            ref = current.get("parent")
        value = match_cache.get(ref, False)
        for previous in reversed(trail):
            value = match_cache.setdefault(previous, value)
        return match_cache.get(node["ref"], False)

    eligible = [node for node in candidates if matches(node)]
    kept = eligible[:max_items]
    kept_refs = {node["ref"] for node in kept}
    eligible_refs = {node["ref"] for node in eligible}

    # Preserve complete ancestry independently of the item budget. Containers
    # remain compact descriptors, not copies of their full node attributes.
    region_refs = {node["ref"] for node in nodes if node.get("parent") is None}
    missing_refs = set()
    for node in kept:
        parent, seen = node.get("parent"), {node["ref"]}
        while parent is not None:
            if parent in seen or parent not in by_ref:
                missing_refs.add(parent)
                break
            if parent in region_refs:
                break
            seen.add(parent)
            region_refs.add(parent)
            parent = by_ref[parent].get("parent")

    surfaces, surface_ids = [], {}
    node_surfaces = {}
    for node in nodes:
        signature = tuple(node.get(field) for field in CONTEXT_FIELDS)
        if signature not in surface_ids:
            surface_ids[signature] = len(surfaces)
            surfaces.append({field: value for field, value in zip(CONTEXT_FIELDS, signature)
                             if value is not None})
        node_surfaces[node["ref"]] = surface_ids[signature]

    regions = []
    for node in nodes:
        if node["ref"] in region_refs:
            region = _descriptor(node, node_surfaces[node["ref"]])
            region["parent"] = node.get("parent")
            regions.append(region)

    # Associate leaf display text only with its nearest actionable ancestor.
    # The text remains an independent fact; derived control labels cite its
    # exact source refs rather than pretending the control exposed that label.
    control_labels = {}
    ancestor_cache = {}
    for node in nodes:
        if _is_action(node) or node.get("text") in (None, ""):
            continue
        parent, path, seen = node.get("parent"), [], set()
        while parent in by_ref and parent not in seen and parent not in ancestor_cache:
            seen.add(parent)
            if _is_action(by_ref[parent]):
                ancestor_cache[parent] = parent
                break
            path.append(parent)
            parent = by_ref[parent].get("parent")
        control = ancestor_cache.get(parent)
        for previous in path:
            ancestor_cache[previous] = control
        if control in kept_refs:
            control_labels.setdefault(control, []).append(node)

    items = []
    for node in kept:
        item = _descriptor(node, node_surfaces[node["ref"]])
        item.update(region=node.get("parent"), roles=roles[node["ref"]])
        for field in _CONTENT_FIELDS:
            if node.get(field) is not None:
                item[field] = deepcopy(node[field])
        if node.get("textSource"):
            item["textSource"] = node["textSource"]
        inferred = {field: value for field, value in node.get("sources", {}).items()
                    if value != "attribute" and field in ("editable", "value")}
        if inferred:
            item["sources"] = inferred
        if "label" not in item and control_labels.get(node["ref"]):
            labels = control_labels[node["ref"]]
            selected = labels[:4]
            item["label"] = "\n".join(label["text"] for label in selected)
            item["labelSource"] = {"kind": "descendantText", "parts": [
                {"ref": label["ref"], "field": label.get("textSource", "text")}
                for label in selected]}
            if len(labels) > len(selected):
                item["labelTruncated"] = True
        items.append(item)

    def count_role(collection, role):
        return sum(role in roles[node["ref"]] for node in collection)

    omitted = [node for node in eligible if node["ref"] not in kept_refs]
    filtered = [node for node in candidates if node["ref"] not in eligible_refs]
    source_quality = deepcopy(observation.get("quality", {}))
    source_complete = source_quality.get("complete") is True and not source_quality.get("truncated", False)
    source_returned = source_quality.pop("returnedNodes", len(nodes))
    for field in ("matchedNodes", "eligibleNodes", "omittedNodes"):
        source_quality.pop(field, None)
    quality = {**source_quality,
               "sourceComplete": source_complete,
               "complete": source_complete and not omitted and not filtered and not missing_refs,
               "truncated": bool(source_quality.get("truncated") or omitted),
               "totalNodes": source_quality.get("totalNodes", len(nodes)),
               "sourceReturnedNodes": source_returned,
               "availableNodes": len(nodes),
               "totalItems": len(candidates), "matchedItems": len(eligible),
               "returnedItems": len(items), "omittedItems": len(omitted),
               "filteredItems": len(filtered), "returnedRegions": len(regions),
               "suppressedStructuralNodes": sum(_default_structural_states(node) for node in nodes),
               "missingContextNodes": len(missing_refs),
               "absenceEvidence": False}
    for role, plural in (("field", "Fields"), ("fact", "Facts"), ("action", "Controls")):
        for prefix, collection in (("total", candidates), ("returned", kept),
                                   ("omitted", omitted), ("filtered", filtered)):
            quality[prefix + plural] = count_role(collection, role)
    warnings = quality.setdefault("warnings", [])
    if omitted:
        warnings.append({"code": "SEMANTIC_OUTPUT_TRUNCATED", "omittedItems": len(omitted)})
    if filtered:
        warnings.append({"code": "SEMANTIC_OUTPUT_FILTERED", "filteredItems": len(filtered)})
    if missing_refs:
        warnings.append({"code": "SEMANTIC_CONTEXT_INCOMPLETE", "missingContextNodes": len(missing_refs)})

    context = {"scope": deepcopy(observation.get("projection", {}).get("scope", {"kind": "screen"})),
               "surfaces": surfaces}
    if "context" in observation:
        context["source"] = deepcopy(observation["context"])
    result = {"schema": PAGE_SCHEMA,
              **{field: deepcopy(observation[field]) for field in
                 ("frameId", "capturedAt", "sessionEpoch", "device") if field in observation},
              "context": context, "regions": regions, "items": items,
              "fields": [node["ref"] for node in kept if "field" in roles[node["ref"]]],
              "facts": [node["ref"] for node in kept if "fact" in roles[node["ref"]]],
              "actions": [node["ref"] for node in kept if "action" in roles[node["ref"]]],
              "projection": {"schema": PAGE_SCHEMA, "view": "semantic", "query": query,
                             "maxItems": max_items, "scope": deepcopy(context["scope"])},
              "quality": quality}
    return result
