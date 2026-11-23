"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { parseRecordLine, validateGesture, replayGesture } = require("../src/deviceRecorder");

const finger = { X_POSI: "310", Y_POSI: "642", X2_POSI: "255", Y2_POSI: "364", VELO: "721.12" };
function pointer(kind, extra = {}) {
    return JSON.stringify({ EVENT_TYPE: "pointer", OP_TYPE: kind, fingerNumber: "1", fingerList: [finger], ...extra });
}

test("UiTest records become replayable device gestures with coordinate-only labels", () => {
    const step = parseRecordLine(pointer("click", { BUNDLE: "sample.private",
        fingerList: [{ ...finger, W1_Text: "private field value" }] }));
    assert.deepEqual(step, { command: "deviceGesture", input: { kind: "click", x: 310, y: 642 }, label: "310, 642" });
    for (const kind of ["swipe", "fling", "drag"]) {
        assert.deepEqual(parseRecordLine(pointer(kind)).input,
            { kind, x: 310, y: 642, toX: 255, toY: 364, velocity: 721 });
    }
    assert.deepEqual(parseRecordLine(pointer("back")).input, { kind: "back" });
    for (const kind of ["doubleClick", "longClick"]) assert.equal(parseRecordLine(pointer(kind)).input.kind, kind);
    const other = { ...finger, X_POSI: "430", X2_POSI: "475" };
    const pinch = parseRecordLine(pointer("pinch", { fingerNumber: "2", fingerList: [finger, other] }));
    assert.deepEqual(pinch.input, { kind: "pinch", fingers: [
        { x: 310, y: 642, toX: 255, toY: 364 }, { x: 430, y: 642, toX: 475, toY: 364 },
    ] });
});

test("unsupported or unreadable rows stay visible and never retain raw keys or execute", async () => {
    assert.equal(parseRecordLine("windowBounds,0,0,320,640"), undefined);
    for (const line of [pointer("pinch"), pointer("click", { fingerNumber: "2" }),
        JSON.stringify({ OP_TYPE: "key", KeyCode1: "secret" }), "malformed", "null",
        pointer("drag", { fingerList: [{ ...finger, X2_POSI: "" }] })]) {
        const step = parseRecordLine(line);
        assert.equal(step.input.kind, "unsupported");
        assert.doesNotMatch(JSON.stringify(step), /secret/);
        assert.throws(() => validateGesture(step.input), {code: "UNSUPPORTED_GESTURE"});
    }
    await assert.rejects(replayGesture({ device: "mock", hdcPath: "unused" },
        { kind: "click", x: "12; echo unwanted", y: 2 }), { code: "INVALID_GESTURE" });
    assert.throws(() => validateGesture({ kind: "swipe", x: 1, y: 2, toX: 3, toY: -1 }), {code: "INVALID_GESTURE"});
});

function fakeHdc(t, replayResponse) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => { throw Error("Unexpected kill"); };
    const calls = [];
    const finish = () => {
        child.stdout.end();
        child.exitCode = 0;
        child.emit("close", 0);
    };
    t.mock.method(childProcess, "spawn", (_exe, args) => { calls.push(args); return child; });
    const originalExecFile = childProcess.execFile;
    childProcess.execFile = (_exe, args, _options, complete) => {
        calls.push(args);
        if (replayResponse) return complete(null, typeof replayResponse === "function" ? replayResponse(args[3]) : replayResponse);
        child.stdout.write(pointer("longClick") + "\nHA_DONE\n");
        complete(null, "", "");
        finish();
    };
    t.after(() => { childProcess.execFile = originalExecFile; });
    // The adapter captures the child_process functions when the extension activates.
    const moduleId = require.resolve("../src/deviceRecorder");
    delete require.cache[moduleId];
    const adapter = require(moduleId);
    t.after(() => { delete require.cache[moduleId]; });
    return { adapter, child, calls, finish };
}

test("replay reads the final remote receipt even when UiTest prints without a trailing newline", async t => {
    const reply = { stdout: "gesture sent (error count: 0, invalid: 0)\r\nHA_RC=0\r\n", stderr: "error code: 0" };
    const { adapter, calls } = fakeHdc(t, reply);
    const replay = () => adapter.replayGesture({ device: "mock", hdcPath: "stub" }, { kind: "click", x: 8, y: 6 });
    await replay();
    assert.equal(calls[0][3], 'uitest uiInput click 8 6; rc=$?; printf "\\nHA_RC=%s\\n" "$rc"');
    for (const [stdout, stderr] of [
        ["HA_RC=3\n", ""], ["gesture sent", ""], ["HA_RC=0\ntrailing output", ""],
        ["Missing parameter.\nHA_RC=0\n", ""], ["Illegal argument: gesture\nHA_RC=0\n", ""],
        ["error code: 9\nHA_RC=0\n", ""], ["HA_RC=0\n", "[Fail] transport closed"],
    ]) {
        Object.assign(reply, { stdout, stderr });
        await assert.rejects(replay(), { code: "GESTURE_REPLAY_FAILED" });
    }
});

test("new phone actions use their native commands and old touch drivers cannot run a partial pinch", async t => {
    let touchHelp = "-T  --touch\n -m <x1> <y1> <x2> <y2> [-k keep time]\n Supports up to three finger movement";
    const { adapter, calls } = fakeHdc(t, command => ({
        stdout: command === "uinput -?" ? touchHelp : "HA_RC=0\n", stderr: "",
    }));
    const target = { device: "mock", hdcPath: "stub" };
    const pinch = { kind: "pinch", fingers: [
        { x: 10, y: 14, toX: 4, toY: 14 }, { x: 20, y: 14, toX: 26, toY: 14 },
    ] };
    await adapter.replayGesture(target, { kind: "home" });
    await adapter.replayGesture(target, { kind: "recents", x: 30, y: 98, toX: 30, toY: 60 });
    await adapter.replayGesture(target, pinch);
    await adapter.replayGesture(target, { kind: "typeText", text: "中文 'quoted' $(literal)" });
    assert.deepEqual(calls.map(args => args[3].split("; rc=")[0]), [
        "uitest uiInput keyEvent Home",
        "uinput -?", "uinput -T -m 30 98 30 60 -k 650 320",
        "uinput -?", "uinput -T -m 10 14 4 14 20 14 26 14 350",
        "uitest uiInput text '中文 '\"'\"'quoted'\"'\"' $(literal)'",
    ]);
    await assert.rejects(adapter.replayGesture({ ...target, isCurrent: () => false }, pinch), { code: "DEVICE_INPUT_STALE" });
    assert.equal(calls.at(-1)[3], "uinput -?");
    touchHelp = "-T  --touch\n -m <x1> <y1> <x2> <y2>";
    await assert.rejects(adapter.replayGesture(target, pinch), { code: "DEVICE_TOUCH_UNSUPPORTED" });
    assert.equal(calls.at(-1)[3], "uinput -?");
});

test("start waits for native readiness and stop drains the final step once across dispose", async t => {
    const { adapter, child, calls } = fakeHdc(t);
    const steps = [];
    const unexpected = [];
    const starting = adapter.startRecorder({ device: "target only", hdcPath: "mock",
        onStep: step => steps.push(step), onError: error => unexpected.push(error) });
    child.stdout.write("HA_READY\r\n" + pointer("click") + "\r\n");
    const handle = await starting;
    assert.equal(steps[0].input.kind, "click");
    await Promise.all([handle.stop(), handle.dispose()]);
    assert.deepEqual(steps.map(step => step.input.kind), ["click", "longClick"]);
    assert.deepEqual(unexpected, []);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 3), ["-t", "target only", "shell"]);
    assert.match(calls[0][3], /uiRecord record -W false -c false/);
    assert.match(calls[1][3], /\/[a-f0-9-]{36}\/stop/);
});

test("a busy native recorder fails before readiness without a foreign stop", async t => {
    const { adapter, child, calls, finish } = fakeHdc(t);
    const starting = adapter.startRecorder({ device: "mock", hdcPath: "stub", onStep: assert.fail });
    child.stdout.write("HA_BUSY\n");
    finish();
    await assert.rejects(starting, { code: "DEVICE_RECORDER_BUSY" });
    assert.equal(calls.length, 1);
});
