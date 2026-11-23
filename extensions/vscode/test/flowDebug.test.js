"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
