"use strict";

const { execFile, spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const tapKinds = new Set(["click", "doubleClick", "longClick"]);
const motionKinds = new Set(["swipe", "drag", "fling"]);
const navigationKeys = new Map([["back", "Back"], ["home", "Home"]]);
const lock = "/data/local/tmp/.harmony-agent-recorder";

function recorderError(code, message) {
    return Object.assign(new Error(message), { code });
}

function hdcExecutable(explicit) {
    if (explicit || process.env.HARMONY_HDC) return explicit || process.env.HARMONY_HDC;
    const name = process.platform === "win32" ? "hdc.exe" : "hdc";
    const home = process.env.HDC_HOME;
    if (home && existsSync(home)) return statSync(home).isDirectory() ? path.join(home, name) : home;
    const sdk = process.env.HARMONY_COMMAND_LINE_TOOLS;
    if (sdk) {
        const candidate = path.join(sdk, "sdk", "default", "openharmony", "toolchains", name);
        if (existsSync(candidate)) return candidate;
    }
    return name;
}

function coordinate(value) {
    if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) return NaN;
    return Math.round(Number(value));
}

function numericCoordinate(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
}

function validateGesture(input, bounds) {
    const { kind, velocity, fingers, text } = input || {};
    if (navigationKeys.has(kind)) return;
    if (kind === "typeText") {
        if (typeof text === "string" && text.length > 0 && Buffer.byteLength(text) <= 4096 && !/[\0\r\n]/.test(text)) return;
        throw recorderError("INVALID_DEVICE_TEXT", "Enter one line of text up to 4096 UTF-8 bytes.");
    }
    const tap = tapKinds.has(kind);
    const motion = motionKinds.has(kind) || kind === "recents";
    if (!tap && !motion && kind !== "pinch") {
        throw recorderError("UNSUPPORTED_GESTURE", "This recorded gesture cannot be replayed.");
    }
    const point = (x, y) => numericCoordinate(x) && numericCoordinate(y) &&
        (!bounds || (x < bounds.width && y < bounds.height));
    const path = finger => point(finger?.x, finger?.y) && point(finger.toX, finger.toY);
    const validPoints = tap ? point(input.x, input.y) : motion ? path(input) :
        Array.isArray(fingers) && fingers.length === 2 && path(fingers[0]) && path(fingers[1]) &&
        (fingers[0].x !== fingers[1].x || fingers[0].y !== fingers[1].y);
    if (!validPoints || (velocity !== undefined &&
        (!Number.isInteger(velocity) || velocity < 200 || velocity > 40000))) {
        throw recorderError("INVALID_GESTURE", "The recorded gesture contains invalid coordinates or velocity.");
    }
}

function unsupported(event) {
    const type = typeof event === "string" && /^[a-z][a-zA-Z0-9_-]{0,24}$/.test(event) ? event : "unrecognized";
    return { command: "deviceGesture", input: { kind: "unsupported", event: type }, label: type };
}

function fingerPath(finger) {
    return { x: coordinate(finger?.X_POSI), y: coordinate(finger?.Y_POSI),
        toX: coordinate(finger?.X2_POSI), toY: coordinate(finger?.Y2_POSI) };
}

function parseRecordLine(line) {
    if (!line.trim() || line.startsWith("windowBounds,")) return undefined;
    let row;
    try { row = JSON.parse(line); } catch { return unsupported("unrecognized"); }
    const kind = row?.OP_TYPE;
    if (kind === "back" && row.EVENT_TYPE === "pointer" && Number(row.fingerNumber) === 1) {
        return { command: "deviceGesture", input: { kind }, label: "" };
    }
    if (kind === "pinch" && row.EVENT_TYPE === "pointer" && Number(row.fingerNumber) === 2 &&
        Array.isArray(row.fingerList) && row.fingerList.length === 2) {
        const input = { kind, fingers: row.fingerList.map(fingerPath) };
        try { validateGesture(input); } catch { return unsupported(kind); }
        return { command: "deviceGesture", input };
    }
    if (row?.EVENT_TYPE !== "pointer" || (!tapKinds.has(kind) && !motionKinds.has(kind))) return unsupported(kind);
    if (Number(row.fingerNumber) !== 1 || row.fingerList?.length !== 1) return unsupported("multiTouch");
    const finger = row.fingerList[0];
    if (!finger) return unsupported(kind);
    const input = { kind, x: coordinate(finger.X_POSI), y: coordinate(finger.Y_POSI) };
    let label = input.x + ", " + input.y;
    if (motionKinds.has(kind)) {
        input.toX = coordinate(finger.X2_POSI);
        input.toY = coordinate(finger.Y2_POSI);
        // Recording stores distance per second in VELO (see PointerTracker).
        const velocity = Math.round(Number(finger.VELO || row.VELO));
        if (velocity >= 200 && velocity <= 40000) input.velocity = velocity;
        label += " → " + input.toX + ", " + input.toY;
    }
    try { validateGesture(input); } catch { return unsupported(kind); }
    return { command: "deviceGesture", input, label };
}

function shellArgument(value) {
    return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function moveArgs({ x, y, toX, toY }) {
    return [x, y, toX, toY];
}

async function touchCommand(target, input) {
    let help = "";
    try { ({ stdout: help } = await deviceShell(target, "uinput -?")); } catch { /* Tool unavailable. */ }
    const touchHelp = /^-T\s+--touch\b([\s\S]*)/m.exec(help)?.[1] || "";
    if (input.kind === "recents" && /-k\s+keep time/i.test(touchHelp)) {
        return ["uinput", "-T", "-m", ...moveArgs(input), "-k", 650, 320].join(" ");
    }
    if (input.kind === "pinch" && /up to\s+(?:two|three|[23])[- ]fingers?\b/i.test(touchHelp)) {
        return ["uinput", "-T", "-m", ...input.fingers.flatMap(moveArgs), 350].join(" ");
    }
    throw recorderError("DEVICE_TOUCH_UNSUPPORTED", "This phone does not expose the required touch input command.");
}

function deviceShell({ device, hdcPath }, command) {
    return execute(hdcExecutable(hdcPath), ["-t", device, "shell", command],
        { encoding: "utf8", windowsHide: true, timeout: 12000 });
}

async function nativeGestureCommand(target, input) {
    if (input.kind === "pinch" || input.kind === "recents") return touchCommand(target, input);
    if (input.kind === "typeText") return "uitest uiInput text " + shellArgument(input.text);
    const key = navigationKeys.get(input.kind);
    if (key) return "uitest uiInput keyEvent " + key;
    const args = motionKinds.has(input.kind) ? moveArgs(input) : [input.x, input.y];
    if (input.velocity !== undefined && motionKinds.has(input.kind)) args.push(input.velocity);
    return ["uitest", "uiInput", input.kind, ...args].join(" ");
}

async function replayGesture(target, input) {
    validateGesture(input);
    if (!target.device) throw recorderError("DEVICE_REQUIRED", "Select a device.");
    const native = await nativeGestureCommand(target, input);
    if (target.isCurrent && !target.isCurrent()) throw recorderError("DEVICE_INPUT_STALE", "The device or screen changed.");
    const command = native + '; rc=$?; printf "\\nHA_RC=%s\\n" "$rc"';
    let reply;
    try {
        reply = await deviceShell(target, command);
    } catch (error) {
        // Node's native-process error includes its command line, which can contain user text.
        if (input.kind === "typeText") throw recorderError("GESTURE_REPLAY_FAILED", "UiTest did not acknowledge the text input.");
        throw error;
    }
    const { stdout, stderr } = reply;
    const receipt = /(?:^|\r?\n)HA_RC=(\d+)\s*$/.exec(stdout);
    const body = receipt ? stdout.slice(0, receipt.index) : stdout;
    const failure = /^\s*(?:\[fail\]|\[error\]|error:|hdc:\s*error|missing parameter\.|(?:invalid|illegal) (?:parameter|argument)\b|failed to\b|usage\s*:|error code\s*[:=]\s*-?0*[1-9]\d*\b)/im;
    if (!receipt || Number(receipt[1]) !== 0 || failure.test(body) || failure.test(stderr)) {
        throw recorderError("GESTURE_REPLAY_FAILED", "UiTest did not acknowledge the gesture.");
    }
}

// The foreground shell owns its child and the two known native output paths.
// It sends whole JSON rows, then restores any preexisting files before completion.
function recordingShell(token) {
    return `umask 077
lock=${lock}
own=$lock/${token}
primary=/data/local/tmp/record.csv
legacy=/data/local/tmp/layout/record.csv
mkdir "$lock" 2>/dev/null || { echo HA_BUSY; exit 1; }
mkdir "$own" || { rmdir "$lock"; exit 1; }
native=
saved=
stop_native() {
    # Huawei user builds allow signaling this child with /bin/kill -KILL.
    # The shell builtin and kill -0 can return EPERM for a live UiTest process.
    if [ -n "$native" ]; then
        /bin/kill -KILL "$native" 2>/dev/null
        wait "$native" 2>/dev/null
        native=
    fi
}
cleanup() {
    stop_native
    if [ -n "$saved" ]; then rm -f "$saved"; fi
    if [ -e "$own/primary" ]; then mv "$own/primary" "$primary" || return 1; fi
    if [ -e "$own/legacy" ]; then mv "$own/legacy" "$legacy" || return 1; fi
    rm -f "$own/log" "$own/stop" "$own/alive"
    rmdir "$own" && rmdir "$lock"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM PIPE
# The process table is readable even when /proc/<pid>/cmdline is restricted.
if ps -A -o ARGS | grep -Eq '^([^ ]*/)?uitest uiRecord record( |$)'; then echo HA_BUSY; exit 1; fi
if [ -e "$primary" ]; then mv "$primary" "$own/primary" || exit 1; fi
if [ -e "$legacy" ]; then mv "$legacy" "$own/legacy" || exit 1; fi
uitest uiRecord record -W false -c false > "$own/log" 2>&1 &
native=$!
sent=0
drain() {
    [ -f "$saved" ] || return 0
    count=$(wc -l < "$saved") || return 1
    if [ "$count" -gt "$sent" ]; then
        sed -n "$((sent+1)),$count"p "$saved" || return 1
        sent=$count
    fi
}
ready=
missed=0
while [ -d "/proc/$native" ]; do
    if [ -z "$saved" ]; then
        if [ -f "$primary" ]; then saved=$primary; elif [ -f "$legacy" ]; then saved=$legacy; fi
    fi
    if [ -z "$ready" ] && [ -n "$saved" ] && grep -iq 'started recording successfully' "$own/log"; then
        ready=yes
        echo HA_READY
    fi
    if [ -n "$ready" ]; then drain || exit 1; fi
    if [ -e "$own/alive" ]; then rm -f "$own/alive"; missed=0; fi
    missed=$((missed+1))
    # A disconnected HDC client need not terminate the remote shell.
    if [ "$missed" -ge 100 ]; then exit 1; fi
    if [ -e "$own/stop" ]; then
        # UiTest defers a single tap while distinguishing a double tap.
        sleep 0.7
        stop_native
        drain || exit 1
        trap - EXIT
        cleanup || exit 1
        echo HA_DONE
        exit 0
    fi
    sleep 0.3
done
drain
echo HA_EXITED
exit 1`;
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function startRecorder({ device, hdcPath, onStep, onError }) {
    if (!device) throw recorderError("DEVICE_REQUIRED", "Select a device.");
    const executable = hdcExecutable(hdcPath);
    const token = randomUUID();
    const own = lock + "/" + token;
    const shell = command => ["-t", device, "shell", command];
    const child = spawn(executable, shell(recordingShell(token)), { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const started = deferred();
    const closed = deferred();
    let ready = false;
    let done = false;
    let failure;
    let stopping;
    let heartbeat;
    const signal = name => execute(executable, shell("[ -d " + own + " ] && : > " + own + "/" + name),
        { windowsHide: true, timeout: 5000 });
    const unavailable = () => recorderError("DEVICE_RECORDING_UNAVAILABLE", "The device recorder could not start or was disconnected.");
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
        if (line === "HA_READY") {
            ready = true;
            started.resolve();
        } else if (line === "HA_BUSY") {
            failure = recorderError("DEVICE_RECORDER_BUSY", "Another recording already owns the device recorder.");
        } else if (line === "HA_DONE") {
            done = true;
        } else if (ready && line !== "HA_EXITED") {
            const step = parseRecordLine(line);
            if (step) onStep(step);
        }
    });
    child.on("error", error => { failure = error.code === "ENOENT" ?
        recorderError("HDC_NOT_FOUND", "The HDC executable was not found.") : unavailable(); });
    child.once("close", () => {
        clearInterval(heartbeat);
        failure ||= done ? undefined : unavailable();
        started.resolve(failure);
        closed.resolve(failure);
        if (ready && failure && !stopping) onError?.(failure);
    });
    function stop() {
        if (stopping) return stopping;
        stopping = (async () => {
            clearInterval(heartbeat);
            if (child.exitCode === null && child.signalCode === null) {
                await signal("stop").catch(() => {});
            }
            const timer = setTimeout(() => child.kill(), 8000);
            try {
                const error = await closed.promise;
                if (error) throw error;
            } finally {
                clearTimeout(timer);
            }
        })();
        return stopping;
    }
    const startupTimer = setTimeout(() => started.resolve(unavailable()), 12000);
    const startError = await started.promise;
    clearTimeout(startupTimer);
    if (startError) {
        await stop().catch(() => {});
        throw startError;
    }
    if (failure) throw failure;
    heartbeat = setInterval(() => { void signal("alive").catch(() => {}); }, 10000);
    heartbeat.unref();
    return { stop, dispose: stop };
}

module.exports = { startRecorder, validateGesture, replayGesture, parseRecordLine, hdcExecutable };
