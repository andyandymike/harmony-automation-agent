const moveThreshold = 7;
const holdMs = 500;
const doubleTapMs = 290;
const doubleTapDistance = 12;
const wheelIdleMs = 65;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const viewPoint = event => ({ x: event.clientX, y: event.clientY });
const path = (from, to) => ({ ...from, toX: to.x, toY: to.y });

function pointerAction(press, at, event) {
    const elapsed = event.timeStamp - press.at;
    const travel = distance(press.view, viewPoint(event));
    if (travel <= moveThreshold) {
        if (press.movedAt !== undefined) return;
        return { kind: elapsed >= holdMs ? "longClick" : "click", ...press.from };
    }
    const held = (press.movedAt ?? event.timeStamp) - press.at >= holdMs;
    if (held) return { kind: "drag", ...path(press.from, at) };
    if (elapsed > 0 && elapsed <= 180 && travel >= 36) {
        const velocity = clamp(Math.round(1000 * distance(press.from, at) / elapsed), 600, 6000);
        return { kind: "fling", ...path(press.from, at), velocity };
    }
    return { kind: "swipe", ...path(press.from, at) };
}

function wheelSwipe(frame, anchor, dx, dy) {
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const delta = horizontal ? dx : dy;
    const size = horizontal ? frame.width : frame.height;
    if (!delta || size < 4) return;
    const travel = clamp(Math.round(size * Math.abs(delta) / 600), 1, Math.floor(size * 0.55));
    const coordinate = horizontal ? anchor.x : anchor.y;
    const shift = -Math.sign(delta) * travel;
    const start = clamp(coordinate, Math.max(1, 1 - shift), Math.min(size - 2, size - 2 - shift));
    const end = start + shift;
    return horizontal ?
        { kind: "swipe", x: start, y: anchor.y, toX: end, toY: anchor.y, velocity: 1600 } :
        { kind: "swipe", x: anchor.x, y: start, toX: anchor.x, toY: end, velocity: 1600 };
}

function wheelPinch(frame, anchor, dy) {
    if (!dy || frame.width < 10) return;
    const outer = Math.max(2, Math.round(Math.min(frame.width, frame.height) * 0.23));
    const inner = Math.max(1, Math.round(outer / 3));
    const x = clamp(anchor.x, outer, frame.width - 1 - outer);
    const from = dy < 0 ? inner : outer;
    const to = dy < 0 ? outer : inner;
    const y = anchor.y;
    return { kind: "pinch", fingers: [-1, 1].map(side => ({ x: x + side * from, y, toX: x + side * to, toY: y })) };
}

export function installLiveGestures(canvas, { canTouch, point, getFrame, send, singleTap = () => false }) {
    const presses = new Map();
    let pending;
    let multiTouch = false;
    let pair;
    let generation = 0;

    function clearPending() {
        const action = pending;
        pending = undefined;
        clearTimeout(action?.timer);
        return action;
    }

    function flush() {
        const action = clearPending();
        if (action?.input) return send(action.input, action.anchor);
    }

    function defer(action, milliseconds) {
        clearPending();
        pending = { ...action, timer: setTimeout(flush, milliseconds) };
    }

    async function dispatch(input, firstTap) {
        const current = generation;
        if (firstTap && !(await send(firstTap.input))) return;
        if (input && current === generation) await send(input);
    }

    canvas.addEventListener("pointerdown", event => {
        if (!canTouch() || event.button !== 0) return;
        if (presses.size && event.pointerType !== "touch") return;
        const at = point(event);
        if (!at) return;
        if (pending && pending.type !== "tap") {
            flush();
            return;
        }
        const press = { from: at, current: at, view: viewPoint(event), lastView: viewPoint(event), at: event.timeStamp };
        if (!presses.size) press.firstTap = clearPending();
        presses.set(event.pointerId, press);
        if (presses.size > 1) {
            multiTouch = true;
            pair = presses.size === 2 ? [...presses.values()].map(finger => ({
                finger, start: finger.current, view: finger.lastView,
            })) : undefined;
        }
        canvas.setPointerCapture(event.pointerId);
        event.preventDefault();
    });

    function update(press, event) {
        press.current = point(event, true) || press.current;
        press.lastView = viewPoint(event);
        if (press.movedAt === undefined && distance(press.view, press.lastView) > moveThreshold) {
            press.movedAt = event.timeStamp;
        }
    }

    canvas.addEventListener("pointermove", event => {
        const press = presses.get(event.pointerId);
        if (press) update(press, event);
    });

    canvas.addEventListener("pointerup", event => {
        const press = presses.get(event.pointerId);
        if (!press) return;
        update(press, event);
        presses.delete(event.pointerId);
        if (multiTouch) {
            if (pair && presses.size === 1) {
                const [a, b] = pair;
                const start = distance(a.view, b.view);
                const end = distance(a.finger.lastView, b.finger.lastView);
                if (Math.abs(end - start) > moveThreshold) {
                    void send({ kind: "pinch", fingers: pair.map(({ start, finger }) => path(start, finger.current)) });
                }
                pair = undefined;
            }
            if (!presses.size) multiTouch = false;
            return;
        }

        const input = pointerAction(press, press.current, event);
        if (input?.kind === "click") {
            if (singleTap()) {
                void send(input);
                return;
            }
            const prior = press.firstTap;
            if (prior && press.at - prior.at <= doubleTapMs &&
                distance(press.view, prior.view) <= doubleTapDistance) {
                void send({ ...prior.input, kind: "doubleClick" });
            } else if (prior) {
                void dispatch(input, prior);
            } else {
                defer({ type: "tap", input, at: event.timeStamp, view: press.view }, doubleTapMs);
            }
        } else {
            void dispatch(input, press.firstTap);
        }
    });

    function cancelPointer(event) {
        if (!presses.delete(event.pointerId)) return;
        pair = undefined;
        if (!presses.size) multiTouch = false;
    }
    canvas.addEventListener("pointercancel", cancelPointer);
    canvas.addEventListener("lostpointercapture", cancelPointer);
    canvas.addEventListener("contextmenu", event => event.preventDefault());

    canvas.addEventListener("wheel", event => {
        if (!canTouch() || presses.size) return;
        const anchor = point(event);
        if (!anchor) return;
        event.preventDefault();
        const type = event.ctrlKey ? "pinch" : "wheel";
        if (pending && pending.type !== type) {
            flush();
            return;
        }
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
        const dx = (pending?.dx || 0) + event.deltaX * unit;
        const dy = (pending?.dy || 0) + event.deltaY * unit;
        const frame = getFrame();
        const input = type === "pinch" ? wheelPinch(frame, anchor, dy) : wheelSwipe(frame, anchor, dx, dy);
        defer({ type, dx, dy, input, anchor }, wheelIdleMs);
    }, { passive: false });

    return {
        flush,
        cancel() {
            generation++;
            clearPending();
            presses.clear();
            multiTouch = false;
            pair = undefined;
        },
    };
}
