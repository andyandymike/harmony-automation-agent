"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const loadWebview = require("../test-support/loadWebview");

async function setup(t) {
    const { installLiveGestures } = await loadWebview("liveGestures");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const handlers = new Map();
    const frame = { width: 220, height: 400 };
    const actions = [];
    let time = 0;
    const canvas = {
        addEventListener: (type, handler) => handlers.set(type, handler),
        setPointerCapture() {},
        clientHeight: frame.height,
    };
    const gestures = installLiveGestures(canvas, {
        canTouch: () => true, getFrame: () => frame,
        point: ({ clientX, clientY }) => ({ x: clientX, y: clientY }),
        send: async input => { actions.push(input); return true; },
    });
    return {
        actions, gestures,
        advance(ms) { time += ms; t.mock.timers.tick(ms); },
        pointer(type, clientX, clientY, pointerId = 1, pointerType = "mouse") {
            handlers.get(type)({ clientX, clientY, pointerId, pointerType, button: 0, timeStamp: time, preventDefault() {} });
        },
        wheel(deltaY, ctrlKey = false) {
            let consumed = false;
            handlers.get("wheel")({ clientX: 90, clientY: 100, deltaX: 0, deltaY, ctrlKey,
                deltaMode: 0, timeStamp: time, preventDefault() { consumed = true; } });
            assert.equal(consumed, true);
        },
    };
}

test("a double-click emits one double tap and the last pending single tap can be flushed when recording stops", async t => {
    const { actions, gestures, advance, pointer } = await setup(t);
    pointer("pointerdown", 42, 45);
    advance(30);
    pointer("pointerup", 42, 45);
    assert.deepEqual(actions, []);
    advance(130);
    pointer("pointerdown", 43, 45);
    pointer("pointerup", 43, 45);
    advance(350);
    assert.deepEqual(actions, [{ kind: "doubleClick", x: 42, y: 45 }]);

    pointer("pointerdown", 70, 70);
    pointer("pointerup", 70, 70);
    await gestures.flush();
    assert.deepEqual(actions.at(-1), { kind: "click", x: 70, y: 70 });
    pointer("pointerdown", 70, 70);
    pointer("pointerup", 70, 70);
    gestures.cancel();
    advance(350);
    assert.equal(actions.length, 2);
});

test("holding before movement drags, short fast movement flings, and two touchscreen fingers pinch once", async t => {
    const { actions, advance, pointer } = await setup(t);
    pointer("pointerdown", 42, 45);
    advance(550);
    pointer("pointermove", 93, 44);
    pointer("pointerup", 100, 46);
    assert.deepEqual(actions[0], { kind: "drag", x: 42, y: 45, toX: 100, toY: 46 });

    pointer("pointerdown", 28, 180);
    advance(90);
    pointer("pointerup", 28, 90);
    assert.deepEqual(actions[1], { kind: "fling", x: 28, y: 180, toX: 28, toY: 90, velocity: 1000 });

    pointer("pointerdown", 50, 110, 1, "touch");
    pointer("pointerdown", 70, 110, 2, "touch");
    pointer("pointermove", 20, 110, 1, "touch");
    pointer("pointermove", 100, 110, 2, "touch");
    pointer("pointerup", 20, 110, 1, "touch");
    pointer("pointerup", 100, 110, 2, "touch");
    advance(350);
    assert.deepEqual(actions[2], { kind: "pinch", fingers: [
        { x: 50, y: 110, toX: 20, toY: 110 }, { x: 70, y: 110, toX: 100, toY: 110 },
    ] });
    assert.equal(actions.length, 3);
});

test("wheel bursts merge into one in-bounds swipe and Ctrl+wheel generates two distinct finger paths", async t => {
    const { actions, advance, wheel } = await setup(t);
    wheel(120);
    advance(30);
    wheel(120);
    assert.deepEqual(actions, []);
    advance(65);
    assert.equal(actions[0].kind, "swipe");
    assert.equal(actions[0].x, actions[0].toX);
    assert.ok(actions[0].toY < actions[0].y);
    assert.ok(actions[0].toY >= 0 && actions[0].y < 400);
    wheel(-120, true);
    advance(65);
    assert.equal(actions[1].kind, "pinch");
    const [left, right] = actions[1].fingers;
    assert.ok(left.toX < left.x && left.toX >= 0);
    assert.ok(right.toX > right.x && right.toX < 220);
});
