"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { suggestRecordingCheck } = require("../src/recordingCheck");
const { recordedPlan } = require("../src/model");

const status = { ref: "@2", id: "status", label: "Status", text: "Ready",
    selector: { id: "status" }, visible: true };
const steps = [{ command: "press", input: { target: { id: "apply" } } }];

test("an AI end check saves the actual observed value for the selected stable control", async () => {
    const draft = { steps, end: [
        { ref: "@1", id: "name", text: "typed value", editable: true, selector: { id: "name" } },
        { ref: "@3", text: "unidentified" }, status,
    ] };
    const suggestion = await suggestRecordingCheck(draft, async prompt => {
        assert.doesNotMatch(prompt, /typed value|unidentified/);
        assert.match(prompt, /Ready/);
        return JSON.stringify({ index: 0, property: "text", reason: "Check the status", expected: "invented" });
    }, "en", "No check");
    const { ref, property, expected } = suggestion.check;
    const plan = recordedPlan(draft.steps, undefined, draft.end.find(n => n.ref === ref), property, expected);
    assert.deepEqual(plan.goals, [{ selector: { id: "status" }, property: "text", equals: "Ready" }]);
});

test("a recording can be saved without an AI check when the evidence or decision supplies none", async () => {
    const empty = { text: "没有合适的检查" };
    const propose = output => async () => JSON.stringify(output);
    const suggest = (nodes, ask) => suggestRecordingCheck({ steps, end: nodes }, ask, "zh-CN", empty.text);
    assert.deepEqual(await suggest([], () => assert.fail("empty endpoint should not call model")), empty);
    assert.deepEqual(await suggest([status], propose({ index: null })), empty);
    assert.deepEqual(await suggest([status], propose({ index: 3, property: "visible" })), empty);
    assert.deepEqual(await suggest([status], propose({ index: 0, property: "enabled" })), empty);
    const visible = await suggest([status], propose({ index: 0, property: "visible" }));
    assert.equal(visible.check.expected, true);
});
