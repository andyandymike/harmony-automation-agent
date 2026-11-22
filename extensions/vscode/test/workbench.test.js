"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { pageView, recordedPlan, runView, compareRuns } = require("../src/model");
const { messagesFor } = require("../src/strings");

test("recorded selectors stay app-scoped and omit transient frame refs", () => {
    const nodes = [
        { id: "row-a", text: "Choose", ref: "@a", bundleName: "app.fixture", clickable: true },
        { id: "row-b", text: "Choose", ref: "@b", bundleName: "app.fixture", clickable: true },
        { id: "result", text: "Selected: Order B", ref: "@result", bundleName: "app.fixture" },
        { text: "Choose", ref: "@ambiguous", bundleName: "app.fixture" },
    ];
    const page = pageView({ frameId: "frame", nodes });
    assert.deepEqual(page.nodes[1].selector, { id: "row-b", bundleName: "app.fixture" });
    assert.equal(page.nodes[3].selector, undefined);
    const plan = recordedPlan([{ command: "press", input: { target: page.nodes[1].selector }, label: "Choose" }],
        page.nodes[1], page.nodes[2], "text", page.nodes[2].text);
    assert.equal(plan.preconditions[0].equals, true);
    assert.equal(plan.goals[0].equals, "Selected: Order B");
    assert.equal(plan.steps[0].input.target.ref, undefined);
    assert.equal(plan.steps[0].label, undefined);
});

test("the first failed assertion is selected even if the condition step returned normally", () => {
    const view = runView({
        result: { status: "failed", goalVerification: { status: "failed" } },
        receipts: [
            {
                kind: "command", status: "completed", command: "press", path: "steps[0]",
                beforeFrameId: "first", afterFrameId: "second",
                result: { action: { dispatched: "acknowledged", target: { id: "row-b" } } },
            },
            {
                kind: "goal", status: "completed", path: "goals[0]",
                result: { status: "failed", frameId: "second", selector: { id: "result" }, expected: "B", actual: "A" },
            },
        ],
    });
    assert.equal(view.status, "failed");
    assert.equal(view.steps[0].dispatched, "acknowledged");
    assert.equal(view.selected, 1);
    assert.equal(view.steps[1].after, "second");
    assert.equal(view.steps[1].actual, "A");
    const passing = { steps: [view.steps[0], { ...view.steps[1], status: "passed", actual: "B" }] };
    assert.deepEqual(compareRuns(view, passing), { current: view.steps[1], earlier: passing.steps[1] });
});

test("an unresolved action exposes its basis frame and does not infer a post-action frame", () => {
    const report = {
        status: "running", receipts: [{
            kind: "command", command: "press", path: "steps[0]", status: "unknown", basisFrameId: "first",
            error: { message: "response lost", details: { action: { dispatched: "unknown" } } },
        }],
    };
    const view = runView(report);
    assert.equal(view.status, "unknown");
    assert.equal(view.steps[0].before, "first");
    assert.equal(view.steps[0].after, undefined);
});

test("both workbench languages have the same user-facing keys", () => {
    const english = messagesFor("en");
    const chinese = messagesFor("zh-cn");
    assert.deepEqual(Object.keys(english), Object.keys(chinese));
    assert.equal(english.startRecording, "Record");
    assert.equal(chinese.startRecording, "录制");
    assert.equal(messagesFor("fr").run, "Run");
});
