"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reportContext } = require("../src/caseRunReportContext");

const at = seconds => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const start = {startedAt:at(0), at:at(3)};
const blocker = {firstBlocking:true, startedAt:at(10), at:at(15), actual:"付款结果 502 undefined"};
const entry = {id:"run-a"};

function record(second, status, overrides = {}) {
    return {startedAt:at(second), caseRunId:entry.id, method:"GET", path:"/payments",
        request:{url:"https://app.test/payments?order=123"}, source:"fixture", ruleId:"pay", status, ...overrides};
}

function benchWith(records) {
    const net = {snapshot:() => ({records}), collection:{recordsWithHistory:items => items}};
    return {state:{}, networks:{async init() {}, net}};
}

test("run context traces one frozen endpoint through the failing observation in execution order", async () => {
    const records = [
        record(11, 502, {source:"gateway", ruleId:undefined, error:"UPSTREAM_FAILED"}),
        record(8, 200), record(4, 503), record(2, 503),
        record(6, 410, {request:{url:"https://other.test/payments?order=123"}}),
        record(7, 409, {request:{url:"https://app.test/payments?order=456"}}),
        record(7, 401, {method:"POST"}), record(7, 405, {path:"/inventory"}),
        record(12, 503, {caseRunId:"other"}), record(14, 404, {caseRunId:undefined}),
        record(11, 406, {replayed:true}), record(20, 404),
    ];
    const context = await reportContext(benchWith(records), {entry}, [start, blocker]);
    assert.deepEqual(context.requestTrail.map(item => item.status), [503, 503, 200, 502]);
    const last = context.requestTrail.at(-1);
    assert.equal(last.issue, "UPSTREAM_FAILED");
    assert.equal(last.upstreamStatus, undefined);
    assert.equal(last.ruleMatched, false);
    assert.deepEqual(context.requestTrail.map(item => item.ruleMatched), [true,true,true,false]);
    assert.doesNotMatch(JSON.stringify(context), /order=123|https:\/\//);
});

test("an ambiguous or uncorroborated HTTP error is not presented as the failure's request trail", async () => {
    const context = records => reportContext(benchWith(records), {entry}, [start, blocker]);
    assert.deepEqual(await context([record(11,502),record(12,503)]), {});
    assert.deepEqual(await context([record(11,503)]), {});
    assert.deepEqual(await context([record(11,502,{caseRunId:undefined})]), {});
    const unavailable = {state:{}, networks:{async init() { throw Error("archive unavailable"); }}};
    assert.deepEqual(await reportContext(unavailable, {entry}, [blocker]), {});
});

test("AI findings and the saved repair belong to this exact run or its own verification", async () => {
    const diagnosis = {key:"run-a/failure", status:"done", answer:"Finding.", next:"Inspect the upstream."};
    const view = {id:"run-a", stage:"verified", kind:"locator", trial:"trial-b", target:"steps[3]", stepName:"Pay"};
    const bench = {state:{aiResults:{diagnosis}, repair:{...view, id:"another-run", stage:"applied"}},
        caseRepair:{history:new Map([[entry.id,{view}]])}};
    const original = await reportContext(bench,{entry},[]);
    assert.deepEqual(original.diagnosis, {finding:"Finding.",next:"Inspect the upstream."});
    assert.equal(original.repair.stage, "verified");
    const verified = await reportContext(bench,{entry:{id:"trial-b",repairOf:entry.id}},[]);
    assert.deepEqual(verified.repair, original.repair);
    assert.equal(verified.diagnosis, undefined);
    const sibling = await reportContext(bench,{entry:{id:"trial-c",repairOf:entry.id,status:"completed"}},[]);
    assert.deepEqual(sibling, {});
    const applied = await reportContext(bench,{entry:{id:"trial-c",repairOf:entry.id,repairApplied:true}},[]);
    assert.equal(applied.repair.stage, "applied");
    const underway = await reportContext({state:{aiResults:{diagnosis:{...diagnosis,status:"running"}}}}, {entry}, []);
    assert.equal(underway.diagnosis, undefined);
    bench.state.runs = [{id:"trial-b", repairOf:"another-run"}];
    assert.equal((await reportContext(bench, {entry}, [])).repair, undefined);
});
