"use strict";

const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const { hdcExecutable } = require("./deviceRecorder");

const exec = promisify(execFile);
const captureStaggerMs = 270;

function captureError() {
    return Object.assign(new Error("Could not capture the device screen."), { code: "LIVE_CAPTURE_FAILED" });
}

function jpegSize(data) {
    if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) {
        throw captureError();
    }
    let offset = 2;
    while (offset + 4 <= data.length && data[offset] === 0xff) {
        const marker = data[offset + 1];
        const length = data.readUInt16BE(offset + 2);
        if (length < 2 || offset + 2 + length > data.length) break;
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
            if (length < 8) break;
            const height = data.readUInt16BE(offset + 5);
            const width = data.readUInt16BE(offset + 7);
            if (width && height) return { width, height };
            break;
        }
        if (marker === 0xda) break;
        offset += 2 + length;
    }
    throw captureError();
}

function frameReader(capture, prefetch) {
    const jobs = new Set();
    let capacity = prefetch ? 2 : 1;
    let closed = false;
    let waiting;
    let ready;
    let timer;
    let sequence = 0;
    let latest = 0;
    let lastStart = 0;

    function cancelTimer() {
        clearTimeout(timer);
        timer = undefined;
    }

    function complete(frame, error) {
        if (!waiting) {
            if (!closed && frame) ready = frame;
            return;
        }
        const consumer = waiting;
        waiting = undefined;
        cancelTimer();
        if (error) consumer.reject(error);
        else consumer.resolve(frame);
    }

    function finished(job, frame, error) {
        jobs.delete(job);
        if (error && job.overlapped) capacity = 1;
        if (job.sequence > latest) {
            if (frame) {
                latest = job.sequence;
                complete(frame);
            } else if (!jobs.size) {
                complete(undefined, error);
            }
        }
        if (!jobs.size) {
            cancelTimer();
            if (closed && waiting) complete(undefined, captureError());
        }
        schedule();
    }

    function schedule() {
        if (closed || !waiting || timer || jobs.size >= capacity) return;
        const wait = jobs.size ? captureStaggerMs - (performance.now() - lastStart) : 0;
        if (wait > 0) {
            timer = setTimeout(() => {
                timer = undefined;
                schedule();
            }, Math.ceil(wait));
            return;
        }
        // Start at most one frame ahead of the consumer.
        const job = { sequence: ++sequence, overlapped: Boolean(jobs.size) };
        for (const current of jobs) current.overlapped = true;
        jobs.add(job);
        lastStart = performance.now();
        job.done = capture().then(frame => finished(job, frame), error => finished(job, undefined, error));
        schedule();
    }

    function drain() {
        return Promise.all([...jobs].map(job => job.done));
    }

    return {
        nextFrame({ discardBuffered = false } = {}) {
            if (closed) return Promise.reject(captureError());
            if (waiting) return waiting.promise;
            if (discardBuffered) ready = undefined;
            if (ready) {
                const frame = ready;
                ready = undefined;
                return Promise.resolve(frame);
            }
            const promise = new Promise((resolve, reject) => { waiting = { resolve, reject }; });
            waiting.promise = promise;
            schedule();
            return promise;
        },
        drain,
        close() {
            closed = true;
            ready = undefined;
            cancelTimer();
            return drain();
        },
    };
}

async function openLiveDisplay({ device, hdcPath, prefetch = false }) {
    if (!device) throw Object.assign(new Error("Select a device."), { code: "DEVICE_REQUIRED" });
    const executable = hdcExecutable(hdcPath);
    async function capture() {
        // HDC's shell channel truncates binary data at NUL. Every capture
        // owns its temporary file so overlapping commands clean up independently.
        const file = "/data/local/tmp/ha-live-" + randomUUID() + ".jpeg";
        const command = `umask 077; trap 'rm -f ${file}' EXIT; snapshot_display -f ${file} >/dev/null && base64 ${file}`;
        let stdout;
        try {
            ({ stdout } = await exec(executable, ["-t", device, "shell", command], {
                encoding: "ascii", timeout: 8000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
            }));
        } catch (error) {
            if (error.code === "ENOENT") {
                throw Object.assign(new Error("The HDC executable was not found."), { code: "HDC_NOT_FOUND" });
            }
            throw captureError();
        }
        const data = Buffer.from(stdout, "base64");
        return { data, mime: "image/jpeg", ...jpegSize(data) };
    }
    return frameReader(capture, prefetch);
}

module.exports = { openLiveDisplay, jpegSize };
