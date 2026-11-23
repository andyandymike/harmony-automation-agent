"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { FlowDebugger } = require("../src/flowDebug");

test("only the current, paused native step can consume the continue or single-step control", async () => {
    const state = { flowDebug:{id:"r",status:"paused",token:"4"} };
    const writes = [];
    const debug = new FlowDebugger({state,publish(){},language:"en"},{});
    debug.job = {id:"r",worker:{write:message=>writes.push(message)}};
    await debug.handle({type:"flowDebugStep",id:"old",token:"4"});
    await debug.handle({type:"flowDebugStep",id:"r",token:"2"});
    await debug.handle({type:"flowDebugProbe",id:"r",token:"4",selector:'{"id":"save"}'});
    assert.equal(state.flowDebug.status,"paused");
    await debug.handle({type:"flowDebugStep",id:"r",token:"4"});
    await debug.handle({type:"flowDebugStep",id:"r",token:"4"});
    assert.deepEqual(writes,[{action:"probe",token:"4",selector:{id:"save"}},{action:"step",token:"4"}]);
    assert.equal(state.flowDebug.status,"running");
    debug.stop();
    assert.equal(state.flowDebug.status,"stopping");
    assert.deepEqual(writes.at(-1),{action:"stop"});
});

test("a debug worker starts with the selected Python, source path and HDC", async () => {
    const runtime = { python: "project/python", src: "project/src", cli: "project/launch.py", hdc: "project/hdc" };
    const plan = { version: "1", steps: [{ command: "back", input: {} }] };
    const planRef = { uri: "file:///workflow.json", name: "workflow" };
    const state = { plan: planRef, device: "offline-device", devices: ["offline-device"], runs: [] };
    const bench = { state, panel: {}, session: "debug-session", language: "en", stateDir: "evidence",
        publish() {}, async persistRuns() {}, async openReport() {},
        projectRuntime: { configuration: runtime, async ready() {}, async verifyPython(config) { assert.equal(config,runtime); } },
        get agent() { throw new Error("Unexpected global agent lookup"); },
    };
    const vscode = { Uri: { parse: value => value }, workspace: { async openTextDocument() {
        return { getText: () => JSON.stringify(plan) };
    } } };
    let started;
    const debug = new FlowDebugger(bench, vscode, (python, request, _event, env) => {
        started = { python, request, env };
        return { done: Promise.resolve({ status: "passed" }) };
    });
    await debug.start({ breakpoints: [0] });
    assert.equal(started.python, runtime.python);
    assert.equal(started.request.hdcPath, runtime.hdc);
    assert.deepEqual(started.request.breakpoints, [0]);
    assert.equal(started.env.PYTHONPATH.split(path.delimiter)[0], runtime.src);
});
