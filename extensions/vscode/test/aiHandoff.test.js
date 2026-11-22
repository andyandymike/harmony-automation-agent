"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const test = require("node:test");
const { askAI, taskContext } = require("../src/aiHandoff");
const { messagesFor } = require("../src/strings");

const bench = {
    text: messagesFor("zh-CN"), config: { get: () => os.tmpdir() },
    state: { mode: "run", device: "demo-device", run: {
        entry: { id: "demo-run" }, selected: 0, phase: "before",
        steps: [{ path: "steps[0]", before: "saved-frame", after: "later-frame" }],
    } },
};

test("Copilot drafts refer to the selected frozen evidence without sending a message", async () => {
    let opened;
    await askAI({
        window: { showQuickPick: async () => ({ id: "copilot" }), showInputBox: async () => "解释失败" },
        commands: { executeCommand: async (command, args) => { opened = { command, args }; } },
    }, bench);
    assert.equal(opened.command, "workbench.action.chat.open");
    assert.equal(opened.args.isPartialQuery, true);
    assert.match(opened.args.query, /harmony_report/);
    assert.match(opened.args.query, /saved-frame/);
    assert.doesNotMatch(opened.args.query, /demo-device|later-frame/);
});

test("a Codex draft opened from the live screen follows its device and preserves arbitrary user text", async () => {
    const task = "读 A&B / 50% + #?";
    let opened;
    await askAI({
        window: { showQuickPick: async () => ({ id: "codex" }), showInputBox: async () => task },
        env: { openExternal: async url => { opened = new URL(url); return true; } },
    }, bench, "live");
    assert.equal(opened.protocol, "codex:");
    assert.equal(opened.searchParams.get("path"), os.tmpdir());
    const prompt = opened.searchParams.get("prompt");
    assert.equal(prompt.split("\n")[0], task);
    assert.match(prompt, /demo-device/);
    assert.doesNotMatch(prompt, /demo-run/);
});

test("coordinate replay handoffs use their own receipts and never point to a core run report", () => {
    const run = { entry: { id: "internal-id", source: "device", status: "completed" },
        steps: [{ command: "click", status: "completed", gesture: { x: 1234, y: 5678 } }] };
    const result = taskContext({ ...bench, state: { mode: "run", run } });
    assert.deepEqual(result.evidence.steps, [{ step: undefined, action: "click", status: "completed" }]);
    assert.doesNotMatch(JSON.stringify(result), /internal-id|1234|5678|harmony_report/);
});
