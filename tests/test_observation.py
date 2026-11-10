"""Semantic observation tests run without a device or model."""
from copy import deepcopy
import json
from pathlib import Path
import unittest

from harmony_agent.errors import AgentError
from harmony_agent.observation import (
    normalize_layout, select_nodes, resolve_target, diff_observations, project_observation, project_diff,
    parse_selector, selector_uses_refs,
)


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.raw = json.loads((Path(__file__).parent / "data" / "form-layout.json").read_text(encoding="utf-8"))
        self.observation = normalize_layout(self.raw, "f1")

    def assertAgentError(self, code, callback):
        with self.assertRaises(AgentError) as error:
            callback()
        self.assertEqual(code, error.exception.code)
        return error.exception

    def test_unknown_boolean_is_not_false(self):
        root = self.observation["nodes"][0]
        self.assertIsNone(root["checked"])
        self.assertIsNone(root["clickable"])
        toggle = resolve_target(self.observation, "id=fixture.toggle")
        self.assertIs(toggle["checked"], False)
        self.assertIs(toggle["checkable"], True)
        self.assertEqual([toggle], select_nodes(self.observation, {"checked": False}))

    def test_key_fallback_bounds_and_inherited_context(self):
        button = resolve_target(self.observation, "id=first.submit")
        self.assertEqual("first.submit", button["key"])
        self.assertEqual({"left": 20, "top": 300, "right": 300, "bottom": 400}, button["bounds"])
        self.assertEqual({"x": 160, "y": 350}, button["center"])
        self.assertEqual("org.example.form", button["bundleName"])
        self.assertEqual("21", button["hostWindowId"])
        self.assertEqual("0", button["displayId"])

    def test_duplicate_labels_require_context(self):
        error = self.assertAgentError("TARGET_AMBIGUOUS", lambda: resolve_target(self.observation, "text=Submit"))
        self.assertEqual(2, error.details["count"])
        self.assertTrue(all(c["parent"] for c in error.details["candidates"]))
        selected = resolve_target(self.observation, {"text": "Submit", "within": "id=row.second"})
        self.assertEqual("second.submit", selected["id"])

    def test_container_selector_does_not_mutate_request(self):
        request = {"text": "Submit", "within": {"id": "row.first"}}
        before = deepcopy(request)
        select_nodes(self.observation, request)
        self.assertEqual(before, request)

    def test_ref_is_valid_only_in_issuing_frame(self):
        ref = resolve_target(self.observation, "id=first.submit")["ref"]
        self.assertEqual("first.submit", resolve_target(self.observation, ref)["id"])
        current = normalize_layout(self.raw, "f2")
        self.assertAgentError("STALE_REF", lambda: resolve_target(current, ref))
        self.assertAgentError("STALE_REF", lambda: resolve_target(current, "@e1"))

    def test_unknown_ref_in_current_frame_is_not_found(self):
        self.assertAgentError("TARGET_NOT_FOUND", lambda: resolve_target(self.observation, "@e999~f1"))

    def test_parent_ref_is_valid_only_in_issuing_frame(self):
        parent = resolve_target(self.observation, "id=row.first")["ref"]
        selector = {"text": "Submit", "parent": parent}
        self.assertEqual("first.submit", resolve_target(self.observation, selector)["id"])
        current = normalize_layout(self.raw, "f2")
        error = self.assertAgentError("STALE_REF", lambda: select_nodes(current, selector))
        self.assertEqual("parent", error.details["field"])
        self.assertAgentError("STALE_REF", lambda: select_nodes(self.observation, {"parent": "broken"}))

    def test_recursive_ref_detection_covers_within_and_parent(self):
        for selector in ("@e1~f1", {"ref": "@e1~f1"}, {"parent": "@e1~f1"},
                         {"id": "x", "within": {"text": "row", "within": "@e1~f1"}},
                         {"id": "x", "within": {"parent": "@e1~f1"}},
                         {"kind": "selector", "selector": {"parent": "@e1~f1"}}):
            with self.subTest(selector=selector):
                self.assertTrue(selector_uses_refs(selector))
        for selector in ("id=x", {"text": "Submit", "within": {"id": "row.first"}}, {"parent": None}):
            with self.subTest(selector=selector):
                self.assertFalse(selector_uses_refs(selector))

    def test_public_selector_parser_canonicalizes_without_mutating_input(self):
        selector = {"app": "org.example.form", "window": 21, "enabled": "true", "within": {"id": "row.first"}}
        before = deepcopy(selector)
        parsed = parse_selector(selector)
        self.assertEqual({"bundleName": "org.example.form", "hostWindowId": "21", "enabled": True,
                          "within": {"id": "row.first"}}, parsed)
        self.assertEqual(before, selector)

    def test_counter_survives_interactive_projection(self):
        view = project_observation(self.observation, interactive=True)
        self.assertEqual("Counter: 0", resolve_target(view, "id=fixture.counter")["text"])
        counter_ref = resolve_target(view, "id=fixture.counter")["ref"]
        self.assertIn(counter_ref, view["facts"])
        self.assertNotIn(counter_ref, view["controls"])

    def test_input_value_does_not_use_hint(self):
        node = resolve_target(self.observation, "id=fixture.input")
        self.assertEqual("", node["value"])
        self.assertEqual("输入名字", node["hint"])
        self.assertIs(node["editable"], True)
        self.assertIn(node, self.observation["controls"])

    def test_original_text_recovers_display_content_with_public_provenance(self):
        for native_text in ({}, {"text": None}, {"text": ""}):
            with self.subTest(native_text=native_text):
                raw = {"attributes": {"id": "label", "type": "Text", **native_text,
                                      "originalText": "確認 🙂", "description": "Help", "hint": "Hint"}}
                before = deepcopy(raw)
                observation = normalize_layout(raw, "f1")
                view = project_observation(observation)
                node = resolve_target(view, "text=確認 🙂")
                self.assertEqual("確認 🙂", node["originalText"])
                self.assertEqual("originalText", node["textSource"])
                self.assertEqual("Help", node["description"])
                self.assertEqual("Hint", node["hint"])
                self.assertIn(node["ref"], view["facts"])
                self.assertEqual(before, raw)

    def test_nonempty_native_text_takes_precedence_without_trimming(self):
        for native_text in ("Accessible label", " ", "\t"):
            with self.subTest(native_text=native_text):
                observation = normalize_layout({"id": "label", "type": "Text", "text": native_text,
                                                "originalText": "Visible label"}, "f1")
                view = project_observation(observation)
                node = resolve_target(view, {"text": native_text})
                self.assertEqual("Visible label", node["originalText"])
                self.assertNotIn("textSource", node)
                self.assertEqual([node], select_nodes(view, "originalText=Visible label"))
                found = project_observation(observation, query="visible LABEL")
                self.assertEqual(["label"], [n["id"] for n in found["nodes"]])

    def test_empty_original_text_does_not_add_public_metadata(self):
        for original in ({}, {"originalText": None}, {"originalText": ""}):
            with self.subTest(original=original):
                view = project_observation(normalize_layout({"id": "label", "text": "", **original}, "f1"))
                node = view["nodes"][0]
                self.assertEqual("", node["text"])
                self.assertNotIn("originalText", node)
                self.assertNotIn("textSource", node)

    def test_original_text_does_not_reinterpret_empty_editable_text(self):
        controls = [{"type": kind} for kind in ("TextInput", "TextArea", "TextField", "EditText")]
        controls += [{"type": "CustomInput", "editable": "true"},
                     {"type": "TextInput", "editable": "false"}]
        for control in controls:
            with self.subTest(control=control):
                observation = normalize_layout({"id": "input", **control, "text": "",
                                                "originalText": "Visible placeholder"}, "f1")
                node = resolve_target(project_observation(observation), "id=input")
                self.assertEqual("", node["text"])
                self.assertNotIn("textSource", node)
                self.assertEqual("Visible placeholder", node["originalText"])
                if control["type"] != "CustomInput":
                    self.assertEqual("", node["value"])
                else:
                    self.assertIsNone(node["value"])
                self.assertAgentError("TARGET_NOT_FOUND", lambda: resolve_target(observation, "text=Visible placeholder"))
                found = project_observation(observation, query="Visible placeholder")
                self.assertEqual(["input"], [n["id"] for n in found["nodes"]])

    def test_original_text_keeps_explicit_input_values_and_missing_text(self):
        explicit = normalize_layout({"id": "input", "type": "TextInput", "text": "",
                                     "value": "authoritative", "originalText": "Display"}, "f1")["nodes"][0]
        self.assertEqual("authoritative", explicit["value"])
        self.assertEqual("", explicit["text"])
        missing = normalize_layout({"id": "input", "type": "TextInput", "originalText": "Display"}, "f2")["nodes"][0]
        self.assertIsNone(missing["text"])
        self.assertIsNone(missing["value"])

    def test_recovered_child_label_retains_context_and_compact_fact_priority(self):
        raw = {"id": "root", "type": "Column", "children": [{"type": "Column"} for _ in range(100)] + [
            {"id": "confirm", "type": "Column", "clickable": "true", "children": [
                {"type": "Text", "text": "", "originalText": "Confirm"}]}]}
        observation = normalize_layout(raw, "f1")
        full = project_observation(observation, max_nodes=500)
        label = resolve_target(full, {"text": "Confirm", "within": "id=confirm"})
        button = resolve_target(full, "id=confirm")
        self.assertEqual(button["ref"], label["parent"])
        self.assertIsNone(button["text"])
        found = project_observation(observation, query="Confirm")
        self.assertEqual(["root", "confirm", None], [n["id"] for n in found["nodes"]])
        compact = project_observation(observation, max_nodes=2, interactive=True)
        self.assertEqual("Confirm", resolve_target(compact, "text=Confirm")["text"])
        self.assertIn(label["ref"], compact["facts"])
        self.assertIn(button["ref"], compact["controls"])
        self.assertEqual(0, compact["quality"]["omittedFacts"])
        self.assertTrue(compact["quality"]["truncated"])

    def test_original_text_changes_and_source_switch_are_visible_in_diff(self):
        old = normalize_layout({"id": "status", "text": "", "originalText": "Ready"}, "f1")
        new = normalize_layout({"id": "status", "text": "", "originalText": "Done"}, "f2")
        diff = diff_observations(old, new)
        self.assertEqual({"text": "Ready", "originalText": "Ready"}, diff["changed"][0]["before"])
        self.assertEqual({"text": "Done", "originalText": "Done"}, diff["changed"][0]["after"])
        native = normalize_layout({"id": "status", "text": "Done", "originalText": "Done"}, "f3")
        switched = diff_observations(new, native)["changed"][0]
        self.assertEqual({"textSource": "originalText"}, switched["before"])
        self.assertEqual({"textSource": None}, switched["after"])
        alternate = normalize_layout({"id": "status", "text": "Done", "originalText": "Completed"}, "f4")
        self.assertEqual({"originalText": "Completed"}, diff_observations(native, alternate)["changed"][0]["after"])

    def test_diff_detects_counter_change_without_ref_churn(self):
        updated = deepcopy(self.raw)
        updated["children"][2]["attributes"]["text"] = "Counter: 1"
        current = normalize_layout(updated, "f2")
        diff = diff_observations(self.observation, current)
        self.assertTrue(diff["comparable"])
        self.assertEqual([], diff["added"])
        self.assertEqual([], diff["removed"])
        self.assertEqual(1, len(diff["changed"]))
        self.assertEqual({"text": "Counter: 0"}, diff["changed"][0]["before"])
        self.assertEqual({"text": "Counter: 1"}, diff["changed"][0]["after"])

    def test_full_to_interactive_never_reports_false_removals(self):
        interactive = project_observation(self.observation, interactive=True)
        diff = diff_observations(self.observation, interactive)
        self.assertFalse(diff["comparable"])
        self.assertEqual("projection-mismatch", diff["reason"])
        self.assertEqual([], diff["removed"])

    def test_anonymous_insertion_does_not_invent_stable_identity(self):
        old = normalize_layout({"type": "Column", "children": [{"type": "Text", "text": "A"}]}, "f1")
        new = normalize_layout({"type": "Column", "children": [{"type": "Text", "text": "B"}, {"type": "Text", "text": "A"}]}, "f2")
        diff = diff_observations(old, new)
        self.assertTrue(diff["comparable"])
        self.assertFalse(diff["complete"])
        self.assertEqual([], diff["removed"])
        self.assertEqual([], diff["changed"])
        self.assertEqual({"previous": 2, "current": 3}, diff["unmatched"])

    def test_duplicate_ids_have_no_invented_occurrence_identity(self):
        raw = [{"id": "same", "text": "first"}, {"id": "same", "text": "second"}]
        result = normalize_layout(raw, "f1")
        self.assertTrue(all(n["identity"] is None for n in result["nodes"]))
        self.assertAgentError("TARGET_AMBIGUOUS", lambda: resolve_target(result, "id=same"))

    def test_diff_duplicate_identity_never_invents_addition_or_removal(self):
        unique = normalize_layout([{"id": "same", "text": "A"}], "f1")
        duplicate = normalize_layout([{"id": "same", "text": "A"}, {"id": "same", "text": "B"}], "f2")
        for old, new, counts in ((unique, duplicate, (1, 2)), (duplicate, unique, (2, 1))):
            with self.subTest(counts=counts):
                diff = diff_observations(old, new)
                self.assertTrue(diff["comparable"])
                self.assertFalse(diff["complete"])
                self.assertEqual([], diff["added"])
                self.assertEqual([], diff["removed"])
                self.assertEqual([], diff["changed"])
                self.assertEqual({"previous": counts[0], "current": counts[1]}, diff["unmatched"])
                self.assertEqual({"identities": 1, "previous": counts[0], "current": counts[1]}, diff["ambiguous"])

    def test_diff_ambiguity_keeps_unrelated_real_deletions(self):
        old = normalize_layout([{"id": "same", "text": "A"}, {"id": "gone", "text": "Delete me"}], "f1")
        new = normalize_layout([{"id": "same", "text": "A"}, {"id": "same", "text": "B"}], "f2")
        diff = diff_observations(old, new)
        self.assertEqual(["gone"], [node["id"] for node in diff["removed"]])
        self.assertEqual([], diff["added"])
        self.assertFalse(diff["complete"])

    def test_project_diff_empty_result_retains_frame_ids(self):
        old = normalize_layout([], "f1")
        new = normalize_layout([], "f2")
        diff = project_diff(diff_observations(old, new), project_observation(old),
                            project_observation(new), max_changes=1)
        self.assertEqual("f1", diff["previousFrameId"])
        self.assertEqual("f2", diff["currentFrameId"])
        self.assertTrue(diff["complete"])
        self.assertEqual({"total": 0, "matched": 0, "returned": 0, "omitted": 0,
                          "filtered": 0, "truncated": False, "complete": True}, diff["quality"])

    def test_project_diff_filters_each_kind_to_its_displayed_frame(self):
        old = normalize_layout([
            {"id": "shown-removed", "text": "shown"}, {"id": "hidden-removed", "text": "hidden"},
            {"id": "shown-changed", "text": "before"}, {"id": "hidden-changed", "text": "before"}], "f1")
        new = normalize_layout([
            {"id": "shown-added", "text": "shown"}, {"id": "hidden-added", "text": "hidden"},
            {"id": "shown-changed", "text": "after"}, {"id": "hidden-changed", "text": "after"}], "f2")
        full_diff = diff_observations(old, new)
        old_view = project_observation(old, query="shown")
        new_view = project_observation(new, query="shown")
        before = deepcopy((full_diff, old_view, new_view))
        diff = project_diff(full_diff, old_view, new_view, max_changes=10)
        for kind in ("added", "removed", "changed"):
            self.assertEqual(["shown-" + kind], [node["id"] for node in diff[kind]])
        self.assertEqual({"total": 6, "matched": 3, "returned": 3, "omitted": 0,
                          "filtered": 3, "truncated": False, "complete": False}, diff["quality"])
        self.assertFalse(diff["complete"])
        self.assertEqual(before, (full_diff, old_view, new_view))

    def test_project_diff_uses_one_budget_across_change_kinds(self):
        old = normalize_layout([{"id": "removed"}, {"id": "changed", "text": "before"}], "f1")
        new = normalize_layout([{"id": "added"}, {"id": "changed", "text": "after"}], "f2")
        diff = project_diff(diff_observations(old, new), project_observation(old),
                            project_observation(new), max_changes=2)
        self.assertEqual(2, sum(len(diff[kind]) for kind in ("added", "removed", "changed")))
        self.assertEqual({"total": 3, "matched": 3, "returned": 2, "omitted": 1,
                          "filtered": 0, "truncated": True, "complete": False}, diff["quality"])
        self.assertFalse(diff["complete"])

    def test_project_diff_keeps_unknown_status_without_exposing_ambiguous_nodes(self):
        old = normalize_layout([{"id": "same"}], "f1")
        new = normalize_layout([{"id": "same"}, {"id": "same"}], "f2")
        diff = project_diff(diff_observations(old, new), project_observation(old),
                            project_observation(new), max_changes=1)
        self.assertFalse(diff["quality"]["complete"])
        self.assertEqual({"identities": 1, "previous": 1, "current": 2}, diff["ambiguous"])
        incomplete = deepcopy(new)
        incomplete["quality"]["complete"] = False
        diff = project_diff(diff_observations(old, incomplete), project_observation(old),
                            project_observation(incomplete), max_changes=1)
        self.assertFalse(diff["comparable"])
        self.assertFalse(diff["complete"])
        self.assertEqual("incomplete-observation", diff["reason"])

    def test_project_diff_rejects_invalid_budget(self):
        empty = normalize_layout([], "f1")
        for maximum in (0, -1, True, 1.5):
            with self.subTest(maximum=maximum):
                self.assertAgentError("INVALID_ARGUMENT", lambda: project_diff(
                    diff_observations(empty, empty), project_observation(empty),
                    project_observation(empty), max_changes=maximum))

    def test_projection_is_bounded_and_does_not_mutate_full_frame(self):
        before = deepcopy(self.observation)
        view = project_observation(self.observation, max_nodes=2)
        self.assertEqual(2, len(view["nodes"]))
        self.assertTrue(view["quality"]["truncated"])
        self.assertFalse(view["quality"]["complete"])
        returned_refs = {n["ref"] for n in view["nodes"]}
        self.assertTrue(set(view["controls"]).issubset(returned_refs))
        self.assertTrue(set(view["facts"]).issubset(returned_refs))
        self.assertEqual(len(before["nodes"]) - 2, view["quality"]["omittedNodes"])
        self.assertEqual(len(before["facts"]) - len(view["facts"]), view["quality"]["omittedFacts"])
        self.assertEqual(len(before["controls"]) - len(view["controls"]), view["quality"]["omittedControls"])
        self.assertEqual(before, self.observation)
        self.assertFalse(diff_observations(view, view)["comparable"])

    def test_budget_prefers_state_over_empty_containers(self):
        raw = {"type": "Column", "children": [{"type": "Column"} for _ in range(100)] + [
            {"type": "Text", "key": "counter", "text": "Counter: 3"}]}
        view = project_observation(normalize_layout(raw, "f1"), max_nodes=1)
        self.assertEqual("counter", view["nodes"][0]["id"])
        self.assertTrue(view["quality"]["truncated"])
        self.assertEqual(1, view["quality"]["missingContextNodes"])
        self.assertEqual(0, view["quality"]["omittedFacts"])

    def test_find_includes_ancestor_context(self):
        view = project_observation(self.observation, query="输入名字")
        self.assertEqual({None, "row.second", "fixture.input"}, {n["id"] for n in view["nodes"]})
        self.assertFalse(view["quality"]["truncated"])

    def test_app_scope_excludes_other_apps_and_retains_context(self):
        raw = {"type": "Root", "children": [
            {"bundleName": "app.one", "id": "one", "children": [{"id": "child"}]},
            {"bundleName": "app.two", "id": "two"}]}
        view = normalize_layout(raw, "f1", scope={"app": "app.one"})
        self.assertEqual({None, "one", "child"}, {n["id"] for n in view["nodes"]})
        self.assertEqual("app.one", resolve_target(view, "id=child")["bundleName"])

    def test_scopes_are_part_of_diff_contract(self):
        scoped = normalize_layout(self.raw, "f2", scope="org.example.form")
        self.assertFalse(diff_observations(self.observation, scoped)["comparable"])

    def test_unknown_selector_keys_do_not_match_everything(self):
        self.assertAgentError("INVALID_SELECTOR", lambda: select_nodes(self.observation, {"test": "x"}))
        self.assertAgentError("INVALID_SELECTOR", lambda: select_nodes(self.observation, {}))
        self.assertAgentError("INVALID_SELECTOR", lambda: select_nodes(self.observation, "Submit"))
        self.assertAgentError("INVALID_SELECTOR", lambda: select_nodes(self.observation, {"enabled": "maybe"}))

    def test_boolean_string_and_context_aliases(self):
        nodes = select_nodes(self.observation, {"text": "Submit", "enabled": "true", "app": "org.example.form", "window": 21})
        self.assertEqual(2, len(nodes))

    def test_invalid_bounds_are_unknown(self):
        for bounds in ("broken", "[5,5][1,1]", [0, 0, float("nan"), 1], {"left": 0}):
            with self.subTest(bounds=bounds):
                node = normalize_layout({"id": "x", "bounds": bounds}, "f1")["nodes"][0]
                self.assertIsNone(node["bounds"])
                self.assertIsNone(node["center"])

    def test_malformed_children_mark_incomplete(self):
        result = normalize_layout({"id": "root", "children": "bad"}, "f1")
        self.assertFalse(result["quality"]["complete"])
        self.assertEqual("INVALID_CHILDREN", result["quality"]["warnings"][0]["code"])

    def test_wrapped_roots_and_json_text(self):
        result = normalize_layout(json.dumps({"roots": [{"id": "one"}, {"id": "two"}]}), "f1")
        self.assertEqual(2, len(result["nodes"]))

    def test_empty_dump_is_explicit_empty_observation(self):
        result = normalize_layout([], "f1")
        self.assertEqual([], result["nodes"])
        self.assertEqual(0, result["quality"]["totalNodes"])
        self.assertAgentError("INVALID_LAYOUT", lambda: normalize_layout("broken", "f1"))
        self.assertAgentError("INVALID_LAYOUT", lambda: normalize_layout(None, "f1"))

    def test_error_and_unknown_roots_cannot_look_like_complete_empty_tree(self):
        for raw in ({"error": "dump failed"}, {"success": False, "roots": []},
                    {"status": "failed", "roots": []}, {"text": "dump failed", "code": 5},
                    {"roots": [], "error": "device disconnected"}, {"unexpected": "payload"},
                    {}, {"attributes": {}}, {"children": []}, [{"error": "dump failed"}]):
            with self.subTest(raw=raw):
                self.assertAgentError("INVALID_LAYOUT", lambda: normalize_layout(raw, "f1"))

    def test_unrecognized_child_marks_partial_layout_incomplete(self):
        raw = {"attributes": {"type": "Column"}, "children": [
            {"attributes": {"id": "valid", "text": "OK"}}, {"error": "partial dump failed"}]}
        result = normalize_layout(raw, "f1")
        self.assertFalse(result["quality"]["complete"])
        self.assertEqual("OK", resolve_target(result, "id=valid")["text"])
        self.assertEqual("UNRECOGNIZED_NODE_FORMAT", result["quality"]["warnings"][0]["code"])
        self.assertFalse(diff_observations(result, result)["comparable"])

    def test_explicit_empty_roots_and_structure_only_parent_are_supported(self):
        empty = normalize_layout({"roots": []}, "f1")
        self.assertEqual([], empty["nodes"])
        self.assertTrue(empty["quality"]["complete"])
        container = normalize_layout({"children": [{"id": "valid"}]}, "f1")
        self.assertEqual(2, len(container["nodes"]))
        self.assertTrue(container["quality"]["complete"])

    def test_public_projection_removes_only_internal_or_duplicate_fields(self):
        view = project_observation(self.observation)
        old = resolve_target(self.observation, "id=fixture.counter")
        current = resolve_target(view, "id=fixture.counter")
        for internal in ("identity", "path", "sources"):
            self.assertIn(internal, old)
            self.assertNotIn(internal, current)
        self.assertEqual("fixture.counter", old["key"])
        self.assertNotIn("key", current)
        self.assertEqual(old["text"], current["text"])
        self.assertIsNone(current["checked"])
        self.assertIs(current["clickable"], False)
        self.assertEqual(old["bundleName"], current["bundleName"])
        self.assertEqual(old["bounds"], current["bounds"])
        self.assertEqual(old["parent"], current["parent"])
        distinct = normalize_layout({"id": "id", "key": "different-key", "text": ""}, "f3")
        self.assertEqual("different-key", project_observation(distinct)["nodes"][0]["key"])


if __name__ == "__main__":
    unittest.main()
