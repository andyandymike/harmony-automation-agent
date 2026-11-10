"""Decision-view fidelity and context tests using synthetic UI frames only."""

from copy import deepcopy
import json
from pathlib import Path
import unittest

from harmony_agent.errors import AgentError
from harmony_agent.observation import normalize_layout, resolve_target
from harmony_agent.semantic import semantic_page


def item_by_id(page, identifier):
    return next(item for item in page["items"] if item.get("id") == identifier)


def native_node(kind, children=None, **attributes):
    """Synthetic UiTest-style attributes, including ubiquitous blank/defaults."""
    attrs = {"type": kind, "text": "", "originalText": "", "description": "", "hint": "",
             "enabled": "true", "visible": "true", "clickable": "false", "longClickable": "false",
             "checkable": "false", "checked": "false", "selected": "false", "focused": "false",
             "scrollable": "false"}
    attrs.update(attributes)
    return {"attributes": attrs, "children": children or []}


def native_structural_layout():
    return native_node("Column", [native_node("Row", [
        native_node("Stack", [native_node("Text", text="Status: ready")]),
        native_node("Column", [native_node("Blank")]), native_node("SymbolGlyph"),
        native_node("TextInput", id=f"input-{index}", editable="true"),
        native_node("Button", [native_node("Text", text="Continue")], clickable="true")
    ], id=f"row-{index}") for index in range(10)])


class SemanticPageTests(unittest.TestCase):
    def setUp(self):
        raw = json.loads((Path(__file__).parent / "data" / "form-layout.json").read_text(encoding="utf-8"))
        self.frame = normalize_layout(raw, "frame-a")
        self.frame.update(capturedAt="2026-01-01T00:00:00+00:00", sessionEpoch="epoch-a", device="synthetic-device")

    def test_business_values_and_controls_survive_semantic_projection(self):
        page = semantic_page(self.frame)
        field = item_by_id(page, "fixture.input")
        counter = item_by_id(page, "fixture.counter")
        self.assertEqual("", field["text"])
        self.assertEqual("", field["value"])
        self.assertEqual("输入名字", field["label"])
        self.assertEqual("hint", field["labelSource"]["field"])
        self.assertEqual("type", field["sources"]["editable"])
        self.assertEqual("text", field["sources"]["value"])
        self.assertIn(field["ref"], page["fields"])
        self.assertIn(field["ref"], page["actions"])
        self.assertEqual("Counter: 0", counter["text"])
        self.assertIn(counter["ref"], page["facts"])
        self.assertNotIn(counter["ref"], page["actions"])

    def test_duplicate_labels_keep_separate_region_context(self):
        page = semantic_page(self.frame)
        first = item_by_id(page, "first.submit")
        second = item_by_id(page, "second.submit")
        self.assertEqual("Submit", first["label"])
        self.assertEqual("Submit", second["label"])
        self.assertNotEqual(first["region"], second["region"])
        regions = {region["ref"]: region for region in page["regions"]}
        self.assertEqual("row.first", regions[first["region"]]["id"])
        self.assertEqual("row.second", regions[second["region"]]["id"])

    def test_false_states_are_preserved_and_unknown_is_not_false(self):
        page = semantic_page(self.frame)
        toggle = item_by_id(page, "fixture.toggle")
        self.assertIs(toggle["state"]["checked"], False)
        self.assertIs(toggle["state"]["checkable"], True)
        self.assertNotIn("focused", toggle["state"])
        self.assertIs(item_by_id(page, "fixture.input")["state"]["focused"], False)

    def test_all_known_boolean_states_survive_for_a_control(self):
        attrs = {"type": "Button", "id": "button", "clickable": True,
                 "enabled": False, "visible": False, "longClickable": False,
                 "checkable": False, "checked": False, "selected": False,
                 "focused": False, "scrollable": False, "editable": False}
        item = semantic_page(normalize_layout(attrs, "f"))["items"][0]
        for field in attrs.keys() - {"type", "id"}:
            self.assertIs(item["state"][field], attrs[field])
        # An action index is a capability index, not a claim of actionability.
        self.assertIn("action", item["roles"])

    def test_state_only_false_is_evidence(self):
        frame = normalize_layout({"id": "selection", "type": "Row", "selected": False}, "f")
        page = semantic_page(frame)
        self.assertEqual(False, page["items"][0]["state"]["selected"])
        self.assertEqual([page["items"][0]["ref"]], page["facts"])

    def test_native_blank_structures_do_not_consume_the_item_budget(self):
        frame = normalize_layout(native_structural_layout(), "native")
        page = semantic_page(frame, max_items=40)
        self.assertEqual(91, len(frame["nodes"]))
        self.assertEqual(40, len(page["items"]))
        self.assertEqual(31, len(page["regions"]))
        self.assertEqual(51, page["quality"]["suppressedStructuralNodes"])
        self.assertEqual(0, page["quality"]["omittedItems"])
        self.assertFalse(page["quality"]["truncated"])
        self.assertEqual(10, len(page["fields"]))
        self.assertEqual(20, len(page["actions"]))
        for index in range(10):
            field = item_by_id(page, f"input-{index}")
            self.assertEqual("", field["text"])
            self.assertEqual("", field["value"])
            self.assertIs(field["state"]["focused"], False)
        self.assertFalse(any(item["type"] in {"Row", "Stack", "Column", "Blank", "SymbolGlyph"}
                             for item in page["items"]))
        self.assertIs(page["regions"][0]["state"]["selected"], False)
        self.assertFalse(page["quality"]["absenceEvidence"])

    def test_native_default_state_suppression_keeps_values_states_and_anonymous_controls(self):
        frame = normalize_layout(native_node("Column", [
            native_node("Row", id="zero", value=0),
            native_node("Stack", id="empty", value=""),
            native_node("Row", id="false-value", value=False),
            native_node("Row", id="selected", selected="true"),
            native_node("Stack", id="focused", focused="true"),
            native_node("Row", id="checked", checked="true"),
            native_node("SymbolGlyph", clickable="true"),
            native_node("Row", id="description", description="Status unavailable"),
            native_node("CustomState", id="custom"),
            native_node("SymbolGlyph"),
        ]), "f")
        page = semantic_page(frame)
        self.assertEqual(9, len(page["items"]))
        self.assertEqual("0", item_by_id(page, "zero")["value"])
        self.assertEqual("", item_by_id(page, "empty")["value"])
        self.assertEqual("False", item_by_id(page, "false-value")["value"])
        for state in ("selected", "focused", "checked"):
            self.assertIs(item_by_id(page, state)["state"][state], True)
        self.assertEqual("Status unavailable", item_by_id(page, "description")["label"])
        self.assertIs(item_by_id(page, "custom")["state"]["selected"], False)
        control = next(item for item in page["items"] if item["ref"] in page["actions"])
        self.assertEqual("SymbolGlyph", control["type"])
        self.assertNotIn("id", control)

    def test_suppressed_structure_remains_as_exact_ancestor_context(self):
        frame = normalize_layout(native_node("Column", [
            native_node("Row", [native_node("Text", text="Unavailable")], id="section", enabled="false")
        ]), "f")
        page = semantic_page(frame, query="section")
        self.assertEqual(1, len(page["items"]))
        regions = {region["ref"]: region for region in page["regions"]}
        parent = regions[page["items"][0]["region"]]
        self.assertEqual("section", parent["id"])
        self.assertIs(parent["state"]["enabled"], False)
        self.assertIs(parent["state"]["checked"], False)
        self.assertIs(parent["state"]["focused"], False)
        self.assertIn(parent["parent"], regions)

    def test_empty_text_fact_and_zero_value_are_not_lost(self):
        frame = normalize_layout({"type": "Column", "children": [
            {"id": "status", "type": "Text", "text": ""},
            {"id": "count", "type": "Text", "value": 0}]}, "f")
        page = semantic_page(frame)
        self.assertEqual("", item_by_id(page, "status")["text"])
        self.assertEqual("0", item_by_id(page, "count")["value"])
        self.assertEqual(2, len(page["facts"]))

    def test_ancestor_disabled_state_and_complete_chain_are_visible(self):
        frame = normalize_layout({"id": "root", "type": "Column", "enabled": False, "children": [
            {"id": "row", "type": "Row", "children": [
                {"id": "button", "type": "Button", "text": "Continue", "clickable": True}]}]}, "f")
        page = semantic_page(frame, max_items=1)
        regions = {region["id"]: region for region in page["regions"]}
        self.assertIs(regions["root"]["state"]["enabled"], False)
        self.assertEqual(regions["root"]["ref"], regions["row"]["parent"])
        self.assertEqual(regions["row"]["ref"], page["items"][0]["region"])
        self.assertEqual(0, page["quality"]["missingContextNodes"])

    def test_frame_metadata_scope_and_zero_display_are_preserved(self):
        page = semantic_page(self.frame)
        for field in ("frameId", "capturedAt", "sessionEpoch", "device"):
            self.assertEqual(self.frame[field], page[field])
        item = item_by_id(page, "first.submit")
        surface = page["context"]["surfaces"][item["surface"]]
        self.assertEqual("org.example.form", surface["bundleName"])
        self.assertEqual("21", surface["hostWindowId"])
        self.assertEqual("0", surface["displayId"])
        self.assertEqual({"kind": "screen"}, page["context"]["scope"])

    def test_multiple_surfaces_and_repeated_ids_are_not_merged(self):
        frame = normalize_layout([
            {"type": "Window", "bundleName": "org.example.one", "hostWindowId": 1,
             "children": [{"id": "same", "type": "Button", "text": "Open", "clickable": True}]},
            {"type": "Window", "bundleName": "org.example.two", "hostWindowId": 2,
             "children": [{"id": "same", "type": "Button", "text": "Open", "clickable": True}]}], "f")
        page = semantic_page(frame)
        items = page["items"]
        self.assertEqual(2, len(items))
        self.assertEqual("same", items[0]["id"])
        self.assertEqual("same", items[1]["id"])
        self.assertNotEqual(items[0]["ref"], items[1]["ref"])
        self.assertNotEqual(items[0]["surface"], items[1]["surface"])
        self.assertNotIn("identity", items[0])

    def test_anonymous_facts_remain_individually_identifiable(self):
        frame = normalize_layout({"type": "Column", "children": [
            {"type": "Text", "text": "Same"}, {"type": "Text", "text": "Same"}]}, "f")
        page = semantic_page(frame)
        self.assertEqual(2, len(page["items"]))
        self.assertNotEqual(page["items"][0]["ref"], page["items"][1]["ref"])
        self.assertTrue(all("id" not in item for item in page["items"]))

    def test_original_text_provenance_and_empty_input_are_distinct(self):
        frame = normalize_layout({"type": "Column", "children": [
            {"id": "label", "type": "Text", "text": "", "originalText": "確認"},
            {"id": "input", "type": "TextInput", "text": "", "originalText": "Placeholder"}]}, "f")
        page = semantic_page(frame)
        label = item_by_id(page, "label")
        self.assertEqual("確認", label["text"])
        self.assertEqual("originalText", label["labelSource"]["field"])
        self.assertEqual("originalText", label["textSource"])
        field = item_by_id(page, "input")
        self.assertEqual("", field["text"])
        self.assertEqual("", field["value"])
        self.assertEqual("Placeholder", field["label"])
        self.assertEqual("originalText", field["labelSource"]["field"])

    def test_derived_button_label_cites_child_without_rewriting_native_text(self):
        frame = normalize_layout({"id": "button", "type": "Column", "clickable": True, "children": [
            {"type": "Text", "text": "", "originalText": "Continue"}]}, "f")
        page = semantic_page(frame)
        button = item_by_id(page, "button")
        self.assertEqual("Continue", button["label"])
        self.assertEqual("descendantText", button["labelSource"]["kind"])
        child = resolve_target(frame, "text=Continue")
        self.assertEqual([{"ref": child["ref"], "field": "originalText"}], button["labelSource"]["parts"])
        self.assertNotIn("text", button)
        self.assertIn(child["ref"], page["facts"])

    def test_child_labels_do_not_cross_nested_action_boundaries(self):
        frame = normalize_layout({"id": "outer", "type": "Column", "clickable": True, "children": [
            {"type": "Text", "text": "Outer"},
            {"id": "inner", "type": "Button", "clickable": True, "children": [
                {"type": "Text", "text": "Inner"}]}]}, "f")
        page = semantic_page(frame)
        self.assertEqual("Outer", item_by_id(page, "outer")["label"])
        self.assertEqual("Inner", item_by_id(page, "inner")["label"])

    def test_many_descendant_labels_are_explicitly_partial_but_facts_remain(self):
        frame = normalize_layout({"id": "row", "clickable": True, "children": [
            {"type": "Text", "text": str(index)} for index in range(6)]}, "f")
        page = semantic_page(frame)
        row = item_by_id(page, "row")
        self.assertIs(row["labelTruncated"], True)
        self.assertEqual(4, len(row["labelSource"]["parts"]))
        self.assertEqual([str(index) for index in range(6)],
                         [item["text"] for item in page["items"] if "text" in item])

    def test_native_label_takes_precedence_and_whitespace_is_preserved(self):
        frame = normalize_layout({"id": "button", "text": " ", "clickable": True, "children": [
            {"type": "Text", "text": "Other"}]}, "f")
        button = item_by_id(semantic_page(frame), "button")
        self.assertEqual(" ", button["label"])
        self.assertEqual("text", button["labelSource"]["field"])

    def test_query_preserves_group_members_and_reports_excluded_facts(self):
        page = semantic_page(self.frame, query="row.second")
        self.assertEqual(["fixture.input", "second.submit"], [item["id"] for item in page["items"]])
        self.assertGreater(page["quality"]["filteredFacts"], 0)
        self.assertFalse(page["quality"]["complete"])
        self.assertFalse(page["quality"]["absenceEvidence"])
        self.assertEqual(0, page["quality"]["omittedItems"])

    def test_query_match_does_not_leak_between_siblings(self):
        page = semantic_page(self.frame, query="First form")
        self.assertEqual(["first.label"], [item["id"] for item in page["items"]])

    def test_budget_and_query_counts_distinguish_omission_from_filtering(self):
        page = semantic_page(self.frame, query="Submit", max_items=1)
        quality = page["quality"]
        self.assertEqual(1, quality["returnedItems"])
        self.assertEqual(1, quality["omittedItems"])
        self.assertGreater(quality["filteredItems"], 0)
        self.assertIs(quality["truncated"], True)
        for suffix in ("Items", "Fields", "Facts", "Controls"):
            self.assertEqual(quality["total" + suffix], quality["returned" + suffix]
                             + quality["omitted" + suffix] + quality["filtered" + suffix])

    def test_empty_query_is_not_an_absence_claim(self):
        page = semantic_page(self.frame, query="unmatched-content")
        self.assertEqual([], page["items"])
        self.assertFalse(page["quality"]["complete"])
        self.assertFalse(page["quality"]["absenceEvidence"])
        self.assertTrue(page["context"]["surfaces"])

    def test_source_incompleteness_is_never_upgraded(self):
        frame = normalize_layout({"id": "root", "children": [
            {"id": "label", "text": "Ready"}, "malformed"]}, "f")
        page = semantic_page(frame)
        self.assertFalse(page["quality"]["sourceComplete"])
        self.assertFalse(page["quality"]["complete"])
        self.assertTrue(any(w["code"] == "INVALID_NODE" for w in page["quality"]["warnings"]))

    def test_empty_surface_keeps_context_and_root(self):
        frame = normalize_layout({"type": "Window", "bundleName": "org.example.empty", "hostWindowId": 0}, "f")
        page = semantic_page(frame)
        self.assertEqual([], page["items"])
        self.assertEqual("org.example.empty", page["context"]["surfaces"][0]["bundleName"])
        self.assertEqual("0", page["context"]["surfaces"][0]["hostWindowId"])
        self.assertEqual(frame["nodes"][0]["ref"], page["regions"][0]["ref"])

    def test_empty_observation_is_supported(self):
        page = semantic_page(normalize_layout([], "f"))
        self.assertEqual([], page["items"])
        self.assertEqual([], page["regions"])
        self.assertTrue(page["quality"]["complete"])
        self.assertFalse(page["quality"]["absenceEvidence"])

    def test_scope_and_custom_context_are_retained(self):
        frame = normalize_layout({"id": "root", "bundleName": "org.example.scope", "text": "Ready"},
                                 "f", scope="org.example.scope")
        frame["context"] = {"known": ["example"]}
        page = semantic_page(frame)
        self.assertEqual(frame["projection"]["scope"], page["context"]["scope"])
        self.assertEqual(frame["context"], page["context"]["source"])

    def test_input_and_output_do_not_share_mutable_collections(self):
        before = deepcopy(self.frame)
        page = semantic_page(self.frame, max_items=1)
        page["quality"]["warnings"].append({"code": "consumer-change"})
        page["context"]["scope"]["kind"] = "changed"
        page["items"][0]["roles"].append("changed")
        self.assertEqual(before, self.frame)

    def test_invalid_limits_and_query_are_rejected(self):
        for maximum in (True, 0, -1, 5001, 1.5, "5"):
            with self.subTest(maximum=maximum), self.assertRaises(AgentError) as error:
                semantic_page(self.frame, max_items=maximum)
            self.assertEqual("INVALID_ARGUMENT", error.exception.code)
        with self.assertRaises(AgentError):
            semantic_page(self.frame, query=5)
        with self.assertRaises(AgentError):
            semantic_page({})


if __name__ == "__main__":
    unittest.main()
