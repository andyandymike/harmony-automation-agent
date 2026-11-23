import { vscode } from "./bridge.js";
import { updateWorkspaceRail } from "./workspaceRail.js";
import { installLiveGestures } from "./liveGestures.js";

const byId = id => document.getElementById(id);
const postLive = message => vscode.postMessage({ ...message, channel: "live" });
const screenCanvas = byId("screen");
const context = screenCanvas.getContext("2d", { alpha: false });
const navigation = ["back", "home", "recents"].map(byId);
const locationGroup = byId("record-location");
const formatGroup = byId("record-format");
const keyboard = byId("phone-keyboard");
const textForm = byId("phone-text-form");
const textField = byId("phone-text");
const sendText = byId("phone-text-send");
let state;
let frame;
let requestPending = false;
let sending;
let recordLocation = "preview";
let previewStepFormat = "controls";

const isControlRecording = () => state?.recording && state.draftFormat === "controls";

function canTouch() {
    return frame?.epoch === state?.epoch && state?.streaming && !state.picking && !state.busy && !sending &&
        (!state.draftLocation || (state.recording && state.draftLocation === "preview"));
}

function buttonText(id, text) {
    byId(id).querySelector("span").textContent = text;
}

function setPreviewExpanded(expanded) {
    byId("live-preview").dataset.expanded = String(expanded);
    byId("preview-zoom").setAttribute("aria-expanded", String(expanded));
    buttonText("preview-zoom", expanded ? state.text.stationReducePreview : state.text.stationEnlargePreview);
}

function setKeyboardOpen(open, focus = false) {
    textForm.hidden = !open;
    keyboard.setAttribute("aria-expanded", String(open));
    if (focus) (open ? textField : keyboard).focus();
}

function updateKeyboard() {
    const editable = Boolean(canTouch());
    textField.readOnly = !editable;
    sendText.disabled = !editable || !textField.value;
}

const canOfferRecording = () => state?.tool==="recordings" && !state.caseEditing && !state.draftLocation && !state.recording;

function updateRecordingOptions() {
    const t = state.text;
    const location = state.draftLocation || recordLocation;
    const phone = location === "phone";
    const format = state.draftFormat || (phone ? "coordinates" : previewStepFormat);
    locationGroup.querySelector('[value="'+location+'"]').checked = true;
    formatGroup.querySelector('[value="'+format+'"]').checked = true;
    const controlChoice = formatGroup.querySelector('[value=controls]');
    controlChoice.disabled = phone;
    controlChoice.parentElement.title = phone ? t.recordPhoneCoordinateOnly : t.recordControlsHint;
    formatGroup.querySelector('[value=coordinates]').parentElement.title = t.recordGestureHint;
    locationGroup.disabled = formatGroup.disabled =
        Boolean(!state.connected || state.busy || state.caseEditing || state.draftLocation);
    const note = byId("record-format-note");
    byId("record-choices").hidden = !canOfferRecording();
    note.hidden = !canOfferRecording() || !phone;
}

function status() {
    const t = state.text;
    const status = byId("status");
    const recordingHere = state.recording && state.draftLocation === "preview";
    const recordingControls = isControlRecording();
    const waiting = frame ? t.liveRefreshing : t.liveConnecting;
    status.textContent = state.picking ? t.stationFrozenScreen : state.error ? t.liveUnavailable : state.paused ? t.livePaused :
        !state.connected ? t.stationNoSignal : frame?.epoch !== state.epoch ? waiting :
        !canTouch() && !sending ? t.liveViewOnly : t.liveOn;
    status.dataset.live = String(Boolean(frame?.epoch === state.epoch && state.streaming));
    byId("empty").hidden = Boolean(frame || state.picking);
    byId("empty-title").textContent = state.error ? t.liveUnavailable : state.paused ? t.livePaused :
        state.connected ? t.liveConnecting : t.stationWaitingScreen;
    byId("empty-detail").textContent = state.error || (state.paused ? t.stationPauseHelp : "");
    byId("empty").dataset.offline = String(!state.connected && !state.error);
    screenCanvas.hidden = !frame || state.picking;
    screenCanvas.dataset.touch = String(Boolean(canTouch()));
    const disabled = !canTouch();
    for (const button of navigation) {
        const coordinateOnly = recordingControls && button.id !== "back";
        button.disabled = disabled || coordinateOnly;
        button.title = coordinateOnly ? t.recordingGestureOnly : button.id === "recents" ? t.stationRecentsHelp : "";
    }
    keyboard.disabled = disabled && textForm.hidden;
    byId("phone-controls").hidden = !state.connected;
    updateKeyboard();
    byId("phone-text-help").textContent = recordingControls ? t.stationControlTextHelp :
        recordingHere ? t.stationRecordedTextHelp : t.stationPhoneTextHelp;
    const record = byId("record");
    record.hidden = !(state.recording || canOfferRecording());
    record.disabled = Boolean(state.busy || (!state.recording && !state.connected));
    record.dataset.recording = String(state.recording);
    buttonText("record", state.recording ? t.finish : t.beginRecording);
    record.title = state.recording ? t.screenCounter.replace("{n}", state.steps) : "";
    byId("live-preview").dataset.recording = String(state.recording);
    byId("toggle").disabled = !state.connected || state.picking;
    buttonText("toggle", state.error ? t.liveRetry : state.paused ? t.liveResume : t.livePause);
    byId("toggle").dataset.play = String(Boolean(state.paused || state.error));
    byId("live-preview").dataset.connected = String(state.connected);
    byId("size").textContent = frame && !state.picking ? `${frame.width} × ${frame.height}` : "";
    byId("gesture-help").hidden = !(state.picking || canTouch() || sending);
    byId("gesture-help").textContent = state.picking ? t.stationPickHint :
        recordingControls ? t.stationRecordedControlHint : t.liveGestureHint;
}

function feedback(message, failure = false) {
    const line = byId("feedback");
    line.textContent = message || "";
    line.dataset.error = String(failure);
    line.hidden = !message;
}

function request() {
    if (!state.streaming || requestPending) return;
    requestPending = true;
    postLive({ type: "nextFrame", epoch: state.epoch });
}

function update(message) {
    const epochChanged = state?.epoch !== message.epoch;
    const screenChanged = epochChanged || state?.picking !== message.picking ||
        state?.recording !== message.recording || state?.draftLocation !== message.draftLocation ||
        state?.draftFormat !== message.draftFormat;
    if (!message.connected) frame = undefined;
    if (epochChanged) {
        const keepFrame = state?.device === message.device && !message.error &&
            (message.paused || state?.picking || message.picking);
        if (!keepFrame) frame = undefined;
        requestPending = false;
        resolveSend(false);
    }
    if (screenChanged) {
        feedback();
        gestures.cancel();
        setKeyboardOpen(false);
        textField.value = "";
    }
    const switchedDevice = state?.device !== message.device;
    state = message;
    const t = state.text;
    byId("live-title").textContent = t.stationPreview;
    byId("record-location-label").textContent = t.recordLocation;
    byId("record-format-label").textContent = t.recordSaveAs;
    byId("record-format-note").textContent = t.recordPhoneCoordinateOnly;
    byId("record-preview-label").textContent = t.recordLocationPreview;
    byId("record-phone-label").textContent = t.recordLocationPhone;
    byId("record-controls-label").textContent = t.recordFormatControls;
    byId("record-coordinates-label").textContent = t.recordFormatCoordinates;
    updateRecordingOptions();
    buttonText("back", t.phoneBack);
    buttonText("home", t.home);
    buttonText("recents", t.recents);
    byId("phone-navigation").setAttribute("aria-label", t.stationPhoneNavigation);
    buttonText("phone-keyboard", t.stationPhoneKeyboard);
    textField.placeholder = t.stationPhoneText;
    textField.setAttribute("aria-label", t.stationPhoneText);
    sendText.textContent = t.stationSendPhoneText;
    screenCanvas.setAttribute("aria-label", t.liveScreenAlt);
    screenCanvas.title = t.liveGestureHint;
    updateWorkspaceRail(state);
    setPreviewExpanded(!switchedDevice && byId("live-preview").dataset.expanded === "true");
    status();
    if (message.focusPreview) byId("live-title").focus();
    request();
}

async function draw(message) {
    if (!state?.streaming || state.epoch !== message.epoch) return;
    try {
        const bitmap = await createImageBitmap(new Blob([message.data], { type: message.mime }));
        if (state.epoch !== message.epoch) { bitmap.close(); return; }
        if (screenCanvas.width !== bitmap.width || screenCanvas.height !== bitmap.height) {
            screenCanvas.width = bitmap.width;
            screenCanvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const geometryChanged = frame?.epoch !== message.epoch || frame.geometry !== message.geometry;
        if (geometryChanged) gestures.cancel();
        frame = { epoch: message.epoch, geometry: message.geometry, width: message.width, height: message.height };
        if (geometryChanged) status();
        requestPending = false;
        request();
    } catch {
        postLive({ type: "decodeError", epoch: message.epoch });
    }
}

window.addEventListener("message", ({ data }) => {
    if (data.type === "state") update(data);
    if (data.type === "frame") void draw(data);
    if (data.type === "gestureResult" && state?.epoch === data.epoch) {
        resolveSend(!data.error);
        feedback(data.error || state.text.liveSent, Boolean(data.error));
        status();
    }
});

// Use the pixels actually drawn by object-fit: contain. The native touch grid
// can be larger than the decoded preview, especially on high-density phones.
function point(event, clampToFrame = false) {
    const rect = screenCanvas.getBoundingClientRect();
    const scale = Math.min(rect.width / screenCanvas.width, rect.height / screenCanvas.height);
    const w = screenCanvas.width * scale, h = screenCanvas.height * scale;
    const x = (event.clientX - rect.left - (rect.width - w) / 2) / w;
    const y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
    if (!(w > 0 && h > 0) || (!clampToFrame && !(x >= 0 && y >= 0 && x < 1 && y < 1))) return;
    return {
        x: Math.max(0, Math.min(frame.width - 1, Math.floor(x * frame.width))),
        y: Math.max(0, Math.min(frame.height - 1, Math.floor(y * frame.height))),
    };
}

function resolveSend(ok) {
    const action = sending;
    sending = undefined;
    action?.resolve(ok);
}

function send(input, anchor) {
    if (!canTouch()) return Promise.resolve(false);
    let resolve;
    const done = new Promise(finish => { resolve = finish; });
    sending = { done, resolve };
    feedback(state.text.liveSending);
    status();
    postLive({ type: "gesture", epoch: frame.epoch, geometry: frame.geometry, input, anchor });
    return done;
}

const gestures = installLiveGestures(screenCanvas, { canTouch, point, getFrame: () => frame, send, singleTap:isControlRecording });

// A tap may be waiting for its second click. Finish it before menu actions
// or the boundary of a recording.
async function afterGestures(action) {
    const {epoch,picking} = state;
    await (sending?.done || gestures.flush());
    if (state.epoch === epoch && state.picking === picking) return action();
}

byId("back").addEventListener("click", () => void afterGestures(() => send({ kind: "back" })));
byId("home").addEventListener("click", () => void afterGestures(() => send({ kind: "home" })));
byId("recents").addEventListener("click", () => {
    void afterGestures(() => {
        if (!canTouch()) return;
        const x = Math.floor(frame.width / 2);
        const y = frame.height - 2;
        return send({ kind: "recents", x, y, toX: x, toY: Math.floor(frame.height * 0.62) });
    });
});
keyboard.addEventListener("click", () => setKeyboardOpen(textForm.hidden, true));
textField.addEventListener("input", updateKeyboard);
textForm.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.isComposing) {
        event.stopPropagation();
        setKeyboardOpen(false, true);
    }
});
textForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!textField.value) return;
    const text = textField.value;
    const sent = await afterGestures(() => send({ kind: "typeText", text }));
    if (sent && textField.value === text) {
        textField.value = "";
        updateKeyboard();
    }
});
byId("toggle").addEventListener("click", () => void afterGestures(() => postLive({ type: "toggle" })));
byId("preview-zoom").addEventListener("click", () => setPreviewExpanded(byId("live-preview").dataset.expanded !== "true"));
locationGroup.addEventListener("change", event => {
    recordLocation = event.target.value;
    updateRecordingOptions();
});
formatGroup.addEventListener("change", event => {
    if (recordLocation === "preview") previewStepFormat = event.target.value;
    updateRecordingOptions();
});
byId("record").addEventListener("click", () => void afterGestures(() => {
    if (state.recording) {
        postLive({ type: "stopRecord" });
    } else if (canOfferRecording()) {
        vscode.postMessage({ type: "startRecord", location: recordLocation, stepFormat: recordLocation==="phone"?"coordinates":previewStepFormat });
    }
}));
postLive({ type: "ready" });
