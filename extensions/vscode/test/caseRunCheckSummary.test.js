"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runView } = require("../src/model");
const { summarizeRunChecks } = require("../src/caseRunCheckSummary");

const empty = {passed:0,failed:0,unknown:0,goalsNotRun:0,goalsOutOfScope:0};

test("counts the outcome of each executed check, including repeated actions but excluding control flow",()=>{
    const rows = runView({receipts:[
        {kind:"precondition",status:"completed",result:{status:"passed"}},
        {kind:"command",command:"press",status:"completed",result:{assertion:{status:"not_requested"}}},
        {kind:"if",status:"completed",result:{status:"passed"}},
        {kind:"repeat",status:"completed",result:{status:"failed"}},
        {kind:"command",command:"wait",status:"completed",result:{assertion:{status:"passed",attempts:3}}},
        {kind:"repeat",status:"completed",result:{status:"passed"}},
        {kind:"command",command:"wait",status:"completed",result:{assertion:{status:"passed"}}},
        {kind:"assert",status:"completed",result:{status:"unknown"}},
        {kind:"command",command:"press",status:"failed",error:{code:"ASSERTION_TIMEOUT",details:{assertion:{status:"failed",attempts:3}}}},
    ]}).steps;
    const goals = [{path:"goals[0]",indices:[],status:"not_run"},{path:"goals[1]",indices:[],status:"not_run"}];
    assert.deepEqual(summarizeRunChecks(rows,{goals},{}),{...empty,passed:3,failed:1,unknown:1,goalsNotRun:2});
});

test("combines goal receipts and archived terminal assertions without counting the same goal twice",()=>{
    const rows = [
        {kind:"goal",path:"goals[0]",assertionStatus:"passed"},
        {kind:"unreachedGoals",status:"failed"},
    ];
    const goals = [
        {path:"goals[0]",status:"passed",indices:[0]},
        {path:"goals[1]",status:"failed",indices:[]},
        {path:"goals[2]",status:"not_run",indices:[]},
    ];
    const run = {finalAssertions:[{status:"passed"},{status:"failed"}]};
    assert.deepEqual(summarizeRunChecks(rows,{goals},run),{...empty,passed:1,failed:1,goalsNotRun:1});
    assert.deepEqual(summarizeRunChecks([],{goals:[]},run),{...empty,passed:1,failed:1});
});

test("keeps goals outside a targeted trial separate from its executed checks",()=>{
    const rows = [{kind:"assert",assertionStatus:"passed"}];
    const goals = [{path:"goals[0]",status:"out_of_scope",indices:[]}];
    assert.deepEqual(summarizeRunChecks(rows,{goals},{goalStatus:"not_requested"}),
        {...empty,passed:1,goalsOutOfScope:1});
});

test("cancelled and unverified execution statuses alone do not imply an assertion result",()=>{
    const rows = [{kind:"assert",status:"cancelled"}, {kind:"command",status:"failed",errorCode:"TARGET_NOT_FOUND"},
        {kind:"goal",status:"unknown",path:"goals[0]"}];
    const goals = [{path:"goals[0]",status:"unknown",indices:[2]}];
    assert.deepEqual(summarizeRunChecks(rows,{goals},{}),empty);
    assert.deepEqual(summarizeRunChecks([],undefined,{goalStatus:"not_requested"}),empty);
    assert.deepEqual(summarizeRunChecks([],{goals:[{path:"goals[0]",status:"not_run"}]},
        {goalStatus:"not_requested"}),empty);
});
