"use strict";

const { openLiveDisplay } = require("./liveDisplay");
const { validateGesture } = require("./deviceRecorder");

class LiveDevicePanel {
    constructor(workbench, panel) {
        this.workbench = workbench;
        this.panel = panel;
        this.epoch = 0;
        this.screenRevision = Symbol();
        this.sessions = new Map();
    }

    focus() {
        this.focusPreview = true;
        this.sync();
    }

    sync() {
        if (!this.ready || this.stopped) return;
        const { state, text, language } = this.workbench;
        if (this.device !== state.device) {
            this.device = state.device;
            this.error = undefined;
            this.paused = false;
        }
        const connected = state.devices.includes(this.device);
        const picking = connected && state.tool === "inspect" && state.elements?.picking === true;
        const wanted = this.panel.visible && !this.paused && !this.error && connected ? this.device : undefined;
        if (this.feed?.device !== wanted) {
            this.retire();
            if (wanted) this.feed = { device: wanted, epoch: this.epoch, geometry: 0 };
        } else if (this.feed && this.picking !== picking) {
            // Keep the reader, but invalidate gestures and frames from the previous mode.
            this.feed.epoch = ++this.epoch;
            this.feed.geometry = 0;
            this.requestedFrame = undefined;
        }
        this.picking = picking;
        void this.panel.webview.postMessage({
            type: "state", epoch: this.epoch, streaming: Boolean(this.feed && !picking), paused: Boolean(this.paused), error: this.error,
            device: this.device, devices: state.devices, connected, picking, tool: state.tool, busy: Boolean(state.busy),
            caseEditing: Boolean(state.caseReview), focusPreview: Boolean(this.focusPreview),
            recording: Boolean(state.recording), draftLocation: state.draft?.location, draftFormat: state.draft?.stepFormat,
            steps: state.draft?.steps.length, language, text,
            aiProvider: this.workbench.aiProvider, task: state.aiResults.phone?.key === state.device ? state.aiResults.phone : undefined,
            focusTask: Boolean(this.focusTask),
        });
        this.focusTask = this.focusPreview = false;
    }

    retire() {
        const feed = this.feed;
        this.feed = undefined;
        this.requestedFrame = undefined;
        this.latestScreen = undefined;
        this.screenRevision = Symbol();
        this.epoch++;
        if (feed?.opening) {
            const close = feed.opening.then(display => display?.close(), () => {});
            this.closing = Promise.all([feed.reading, close]).catch(error => {
                console.warn("Harmony Agent display cleanup", error);
            });
        }
    }

    async receive(message) {
        if (this.stopped) return;
        const bench = this.workbench;
        switch (message.type) {
            case "refresh":
                this.error = undefined;
                await this.select(() => bench.listDevices());
                break;
            case "device":
                await this.select(() => bench.selectDevice(message.device));
                break;
            case "workbench":
                bench.open();
                break;
            case "phoneTask":
                await bench.runAI("phone", message.readOnly ? bench.text.readPageGoal : message.goal, Boolean(message.readOnly));
                break;
            case "cancelAI":
                if (bench.aiJob?.kind === "phone") bench.cancelAI();
                break;
            case "aiProvider":
                await bench.setAIProvider(message.provider);
                break;
            case "reviewTask":
                bench.reviewAITask();
                break;
            case "stopRecord":
                await bench.perform(async () => {
                    if (!bench.state.recording) return;
                    bench.state.tool = "recordings";
                    await bench.stopRecording();
                });
                break;
            case "toggle":
                this.paused = this.error ? false : !this.paused;
                this.error = undefined;
                this.sync();
                break;
            case "nextFrame":
                if (this.feed && this.feed.epoch === message.epoch) await this.frame(this.feed);
                break;
            case "decodeError":
                if (this.feed && this.feed.epoch === message.epoch) {
                    this.error = bench.text.liveDecode;
                    this.sync();
                }
                break;
            case "gesture":
                await this.gesture(message);
                break;
        }
    }

    async select(action) {
        const error = await this.workbench.perform(action);
        if (error) {
            this.error = error;
            this.sync();
        }
    }

    async withDeviceOperation(action) {
        // Keep the canvas and its geometry, while waiting for every active capture on this feed.
        this.holdFrames = true;
        const feed = this.feed;
        try {
            await Promise.all([feed?.reading, this.closing]);
            if (feed?.opening) {
                const display = await feed.opening.catch(() => undefined);
                await display?.drain();
            }
            return await action();
        } finally {
            this.holdFrames = false;
            this.flushFrameRequest();
        }
    }

    flushFrameRequest() {
        const feed = this.requestedFrame;
        if (!feed || feed.reading || this.holdFrames) return;
        this.requestedFrame = undefined;
        void this.frame(feed);
    }

    frame(feed) {
        if (this.feed !== feed || this.picking) return;
        if (this.holdFrames || (feed.reading && feed.readingEpoch !== feed.epoch)) {
            this.requestedFrame = feed;
        } else if (!feed.reading) {
            feed.readingEpoch = feed.epoch;
            feed.reading = this.readFrame(feed, feed.epoch).finally(() => {
                feed.reading = undefined;
                this.flushFrameRequest();
            });
        }
        return feed.reading;
    }

    async readFrame(feed, epoch) {
        const current = () => this.feed === feed && feed.epoch === epoch && !this.picking;
        try {
            if (!feed.opening) {
                const closing = this.closing;
                feed.opening = (async () => {
                    await closing;
                    if (this.feed === feed) return openLiveDisplay({
                        device: feed.device, hdcPath: this.workbench.config.get("hdcPath"), prefetch: true,
                    });
                })();
            }
            const display = await feed.opening;
            if (!current()) return;
            const fresh = !feed.geometry;
            if (fresh) await display.drain();
            if (!current()) return;
            const { data, mime, width, height } = await display.nextFrame({ discardBuffered: fresh });
            if (!current()) return;
            // Fresh frames are still required for touch. Compare their content so
            // an unchanged live screen can keep its paired inspector snapshot.
            if (!this.latestScreen?.equals(data)) {
                this.latestScreen = data;
                this.screenRevision = Symbol();
            }
            if (!feed.geometry || feed.width !== width || feed.height !== height) {
                feed.geometry++;
                feed.width = width;
                feed.height = height;
            }
            void this.panel.webview.postMessage({ type: "frame", epoch, geometry: feed.geometry,
                width, height, mime, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
        } catch (error) {
            if (!current()) return;
            this.error = this.workbench.errorMessage(error);
            this.sync();
        }
    }

    async gesture(message) {
        const feed = this.feed;
        const current = () => Boolean(feed?.geometry && this.feed === feed && this.panel.visible && !this.picking &&
            feed.epoch === message.epoch && feed.geometry === message.geometry);
        let error = this.workbench.text.liveChanged;
        if (this.input) {
            error = this.workbench.text.deviceBusy;
        } else if (current()) {
            try {
                validateGesture(message.input, feed);
                const anchor = message.input.kind === "swipe" && this.workbench.recordingControls ? message.anchor : undefined;
                if (anchor) validateGesture({kind:"click",x:anchor.x,y:anchor.y},feed);
                const action = this.workbench.sendLiveGesture(feed.device, message.input, current, this.sessions, anchor);
                this.input = action;
                try { error = await action; } finally { if (this.input === action) this.input = undefined; }
            } catch (failure) {
                error = this.workbench.errorMessage(failure);
            }
        }
        if (!this.stopped) void this.panel.webview.postMessage({ type: "gestureResult", epoch: message.epoch, error });
    }

    async stop() {
        this.stopped = true;
        this.retire();
        await Promise.all([this.input, this.closing]);
        const bench = this.workbench;
        for (const session of this.sessions.values()) {
            try { await bench.agent.call("detach", { session }); }
            catch (error) {
                bench.state.error = bench.errorMessage(error);
                bench.publish();
            }
        }
    }
}

module.exports = { LiveDevicePanel };
