"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { messagesFor } = require("../src/strings");

const loadWebview = require("../test-support/loadWebview");
const loadView = () => loadWebview("exploration");

test("a running exploration renders actionable pause and stop controls while the device is busy", async () => {
    const view = await loadView();
    const report = { id: "test-live", status: "running", device: "test", mode: "free", goal: "Inspect menus",
        inputs: 1, maxInputs: 20, pending: { label: "Open <menu>", reason: "Untried" },
        pages: [], steps: [], findings: [], branches: [] };
    const model = { exploration: report, busy: true, device: "test", devices: ["test"] };
    const html = view.explorationView(model, messagesFor("en"));
    assert.match(html, /data-x="pause"(?! disabled)/);
    assert.match(html, /data-x="stop"(?! disabled)/);
    assert.match(html, /Open &lt;menu&gt;/);
    assert.doesNotMatch(html, /Open <menu>/);
    assert.match(html, /data-x="tab" data-id="coverage"\s+aria-selected="true" aria-controls="exploration-report-panel-coverage" tabindex="0"/);
    assert.match(html, /role="tabpanel" id="exploration-report-panel-coverage" aria-labelledby="exploration-report-tab-coverage"/);
    let message;
    view.exploreClick({ dataset: { x: "pause" } }, model, value => { message = value; }, () => {});
    assert.deepEqual(message, {type: "explorationPause", id: report.id});
});

test("reapplying an equivalent edited plan produces fresh setup markup for the new validated draft", async () => {
    const view = await loadView(), t = messagesFor("zh-CN");
    const flow = { id: "first", name: "Language", kind: "linear", plan: {version: "1", steps: [{command: "back"}]},
        checkpoints: [{index: 0, label: "返回"}], defaultCheckpoints: [0] };
    const model = { device: "test", devices: ["test"], explorationFlow: flow };
    view.exploreClick({dataset: {x: "mode", id: "flow"}}, model, () => {}, () => {});
    const first = view.explorationView(model, t);
    flow.id = "reviewed";
    const again = view.explorationView(model, t);
    assert.notEqual(first, again);
    assert.match(again, /data-checkpoint="0" checked/);
    assert.match(again, /data-x="start"(?! disabled)/);
});

test("a report counts independent retests, gates device actions and preserves editable review notes", async () => {
    const view = await loadView(), t = messagesFor("zh-CN");
    const failure = {id: "f", title: "计数器", kind: "failure", canRecheck: true};
    const review = {id: "r", title: "停留原页", kind: "review", reviewStatus: "open", note: "原备注"};
    const model = {device: "phone", devices: ["phone"], exploration: {id: "report-check", status: "completed",
        device: "phone", inputs: 1, maxInputs: 20, pages: [], steps: [], findings: [failure, review]}};
    const render = () => view.explorationView(model, t);
    assert.match(render(), /尚未独立复测/);
    failure.retests = [{status: "passed"}, {status: "reproduced"}, {status: "inconclusive", reason: "无法返回起点"}];
    assert.match(render(), /复现 1 次，通过 1 次，结果不明 1 次/);
    assert.match(render(), /无法返回起点/);
    assert.doesNotMatch(render(), /data-x="recheck"[^>]*disabled/);
    model.device = "other";
    assert.match(render(), /data-x="recheck"[^>]*disabled/);
    model.device = "phone";
    model.exploration.status = "paused";
    assert.match(render(), /data-x="recheck"[^>]*disabled/);

    let message;
    const click = x => view.exploreClick({dataset: {x, id: "r"}}, model, v => { message = v; }, () => {});
    view.exploreInput({dataset: {xNote: "r"}, value: "期望返回设置"}, model);
    click("note");
    assert.deepEqual(message, {type: "explorationTriage", id: "report-check", findingId: "r", reviewStatus: "open", note: "期望返回设置"});
    click("triage");
    assert.equal(message.reviewStatus, "ignored");
    review.reviewStatus = "ignored";
    assert.match(render(), /重新打开/);
    click("triage");
    assert.equal(message.reviewStatus, "open");
});

test("multi-step trace directs a frozen frame to its own receipt", async () => {
    const view = await loadView(), t = messagesFor("en");
    const step = {id: "s", label: "two actions", status: "completed", runId: "run", receipts: [
        {command: "press", status: "completed", before: "a", after: "b"},
        {kind: "goal", status: "failed", before: "b", after: "c"},
    ]};
    const model = {device: "phone", devices: ["phone"], exploration: {id: "report-frames", device: "phone",
        status: "completed", pages: [], steps: [step], findings: []}};
    view.explorationView(model, t);
    let message;
    const click = dataset => view.exploreClick({dataset}, model, v => { message = v; }, () => {});
    click({x: "step", id: "s"});
    assert.match(view.explorationView(model, t), /data-phase="after" data-index="1"/);
    click({x: "evidence", id: "s", phase: "after", index: "1"});
    assert.deepEqual(message, {type: "explorationEvidence", id: "report-frames", stepId: "s", phase: "after", receiptIndex: 1});
    model.explorationEvidence = {...message, page: {nodes: [{label: "frozen result"}]}};
    assert.match(view.explorationView(model, t), /data-phase="after" data-index="1"[^]*Recorded controls[^]*frozen result/);
});
