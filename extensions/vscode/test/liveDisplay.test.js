"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { jpegSize } = require("../src/liveDisplay");

// A SOF header following an APP marker, with a 1128 x 2444 frame.
const jpeg = Buffer.from("ffd8ffe000040001ffc0000b08098c046801011100ffd9", "hex");

test("frame coordinates come from JPEG dimensions and partial HDC replies are rejected", () => {
    assert.deepEqual(jpegSize(jpeg), { width: 1128, height: 2444 });
    assert.throws(() => jpegSize(jpeg.subarray(0, -1)), { code: "LIVE_CAPTURE_FAILED" });
    assert.throws(() => jpegSize(Buffer.from("[Fail] Device disconnected")), { code: "LIVE_CAPTURE_FAILED" });
});

function mockDisplay(t) {
    const calls = [];
    const original = childProcess.execFile;
    childProcess.execFile = (bin, args, _options, callback) => {
        calls.push({
            bin, args,
            complete: (image = jpeg) => callback(null, {stdout: image.toString("base64")}),
            fail: () => callback(new Error("Display service refused concurrent capture")),
        });
    };
    t.after(() => { childProcess.execFile = original; });
    const id = require.resolve("../src/liveDisplay");
    delete require.cache[id];
    t.after(() => { delete require.cache[id]; });
    const open = options => require(id).openLiveDisplay({ device: "selected-device", hdcPath: "selected-hdc", ...options });
    return { calls, open };
}

function mockClock(t) {
    let now = 1;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    return milliseconds => {
        now += milliseconds;
        t.mock.timers.tick(milliseconds);
    };
}

test("closing the preview drains the only pending capture without starting another shell", async t => {
    const { calls, open } = mockDisplay(t);
    const display = await open();
    const first = display.nextFrame();
    assert.equal(first, display.nextFrame());
    const closing = display.close();
    await assert.rejects(display.nextFrame(), { code: "LIVE_CAPTURE_FAILED" });
    calls[0].complete();
    assert.deepEqual(await first, { data: jpeg, mime: "image/jpeg", width: 1128, height: 2444 });
    await closing;
    await display.close();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, "selected-hdc");
    assert.deepEqual(calls[0].args.slice(0, 3), ["-t", "selected-device", "shell"]);
});

test("staggered capture shows the newer frame and a late old frame cannot strand a reader when closing", async t => {
    const { calls, open } = mockDisplay(t);
    const advance = mockClock(t);
    const display = await open({prefetch: true});
    const first = display.nextFrame();
    assert.equal(first, display.nextFrame());
    advance(200);
    assert.equal(calls.length, 1);
    advance(100);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].args[3], calls[1].args[3]);
    advance(100);
    assert.equal(calls.length, 2);
    const newer = Buffer.from(jpeg);
    newer.writeUInt16BE(900, 15);
    calls[1].complete(newer);
    assert.deepEqual((await first).data, newer);

    const next = display.nextFrame();
    assert.equal(calls.length, 2);
    const closing = display.close();
    const cancelled = assert.rejects(next, {code: "LIVE_CAPTURE_FAILED"});
    calls[0].complete();
    await cancelled;
    await closing;
    advance(500);
    await assert.rejects(display.nextFrame(), {code: "LIVE_CAPTURE_FAILED"});
    assert.equal(calls.length, 2);
});

test("an overlap rejected by the device leaves the successful frame available and returns to single reads", async t => {
    const { calls, open } = mockDisplay(t);
    const advance = mockClock(t);
    const display = await open({prefetch: true});
    const first = display.nextFrame();
    advance(300);
    assert.equal(calls.length, 2);
    calls[1].fail();
    calls[0].complete();
    await first;

    const following = display.nextFrame();
    advance(1000);
    assert.equal(calls.length, 3);
    calls[2].complete();
    await following;
    await display.close();
});

test("a resumed preview can skip a JPEG buffered before pausing", async t => {
    const { calls, open } = mockDisplay(t);
    const advance = mockClock(t);
    const display = await open({prefetch:true});
    const first = display.nextFrame();
    advance(300);
    calls[0].complete();
    await first;
    const buffered = Buffer.from(jpeg);
    buffered.writeUInt16BE(900, 15);
    calls[1].complete(buffered);
    await display.drain();

    const fresh = display.nextFrame({discardBuffered:true});
    assert.equal(calls.length,3);
    calls[2].complete();
    assert.deepEqual((await fresh).data,jpeg);
    await display.close();
});
