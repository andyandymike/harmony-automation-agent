"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { runGuided } = require("../src/explorationGuided");
const { regressionPlan } = require("../src/explorationFlow");

const target = { id: "language" }, rule = { selector: target, property: "text", equals: "English" };
const plan = { version: "1", preconditions: [rule], steps: [{ command: "press", input: { target } }, { command: "back" }], goals: [rule] };
const entry = name => ({ id:name, label:name, command:"press", status:"pending", input:{target:{id:name}} });

function fixture(options = {}) {
    const report = { plan: options.plan || plan, language:"en", initialStateId:"settings", checkpoints:[options.checkpoint ?? 0],
        branches:[], steps:[], findings:[] };
    let scene = "settings", language = "English", paused = false;
    const states = new Map(), sends = [], prompts = [];
    const ctx = { report, sends, prompts, sync: async () => {}, guard() {}, local:en => en,
        finding:f => report.findings.push(f), stop:(status,reason) => { throw Object.assign(new Error(reason), { status }); },
        stateIdAt:async (runId,frameId) => states.get(runId+":"+frameId),
        isRepeatable:() => options.repeatable !== false,
        get current() {return { id:scene,label:scene,entries:scene === "menu" ? [entry("cancel"),entry("details")] : [] };},
        ask:async prompt => {
            const q=JSON.parse(prompt.split("\n").at(-1));prompts.push(q);
            const first=q.entries[0];
            return JSON.stringify({ index:first.index, strategy:first.label==="cancel" ? "replace" : "detour", reason:first.label });
        },
        async run(segment, meta) {
            const known=report.steps.find(r=>r.key===meta.key);
            if(known)return known;
            const id=String(report.steps.length+1);
            const record={ id, runId:id, ...meta, fromStateId:scene,status:"completed",goalStatus:"not_requested",receipts:[] };
            for (const [i,step] of segment.steps.entries()) {
                const control=step.input?.target?.id;
                if (step.command==="press") {
                    sends.push(control);
                    if (control==="language") { assert.equal(scene,"settings");scene="menu"; }
                    if (control==="details") { assert.equal(scene,"menu");scene="info"; }
                    if (control==="cancel") {
                        assert.equal(scene,"menu");scene="settings";
                        if (options.fault)language="Chinese";
                    }
                } else if(step.command==="back") {
                    sends.push("back");scene=scene==="info" ? "menu" : "settings";
                }
                const frameId=id+"-"+i;
                states.set(id+":"+frameId,scene);
                record.receipts.push({kind:"command",command:step.command,path:"steps["+i+"]",status:"completed",after:frameId});
            }
            for (const [i,g] of (segment.goals || []).entries()) {
                const expected=g.equals?.var ? "English" : g.equals;
                const ok=language===expected;
                record.goalStatus=ok ? "passed" : "failed";
                record.receipts.push({kind:"goal",path:"goals["+i+"]",status:record.goalStatus,expected,actual:language});
                if (!ok) record.status="failed";
            }
            record.toStateId=scene;report.steps.push(record);
            if (options.pauseAfterKey===meta.key && !paused) {
                paused=true;ctx.stop("paused","simulated pause after durable native dispatch");
            }
            return record;
        },
    };
    return ctx;
}

async function explore(ctx) {
    try { await runGuided(ctx); }
    catch (e) { if (e.status) return e.status; throw e; }
}

test("guided exploration tests two reversible alternatives, verifies the anchor and runs the user's goals", async () => {
    const ctx=fixture();
    assert.equal(await explore(ctx),"completed");
    assert.deepEqual(ctx.report.branches.map(b=>b.status),["passed","passed","passed"]);
    assert.deepEqual(ctx.sends,["language","back","language","cancel","language","details","back","back"]);
    assert.equal(ctx.prompts[1].entries.some(e=>e.label==="cancel"),false);
    assert.equal(ctx.report.findings.length,0);
});

test("a fault on the alternative exit records the observed mismatch and exports only that variant", async () => {
    const ctx=fixture({fault:true});
    await explore(ctx);
    const finding=ctx.report.findings[0];
    assert.equal(finding.kind,"failure");
    assert.equal(finding.expected,"English");assert.equal(finding.actual,"Chinese");
    const reg=regressionPlan(finding);
    assert.deepEqual(reg.preconditions,plan.preconditions);assert.deepEqual(reg.goals,plan.goals);
    assert.deepEqual(reg.steps.map(s=>s.input.target.id),["language","cancel"]);
    assert.equal(ctx.report.branches[2].status,"pending");
});

test("a pause after branch dispatch resumes from the recorded operation, never sending the tap twice", async () => {
    const ctx=fixture({pauseAfterKey:"checkpoint-0-1/act"});
    assert.equal(await explore(ctx),"paused");
    assert.equal(await explore(ctx),"completed");
    assert.equal(ctx.sends.filter(s=>s==="cancel").length,1);
    assert.equal(ctx.prompts.length,2);
});

test("an unreplayable prefix blocks returning to a checkpoint without any additional phone input", async () => {
    const ctx=fixture({repeatable:false});
    assert.equal(await explore(ctx),"blocked");
    assert.deepEqual(ctx.sends,["language","back"]);
    assert.equal(ctx.report.branches[1].status,"blocked");
});

test("an opaque v2 source runs atomically and requires a verified endpoint before branching", async () => {
    const v2={version:"2",steps:[{read:{name:"original",selector:target}},...plan.steps]};
    const ctx=fixture({plan:v2,checkpoint:2});
    assert.equal(await explore(ctx),"blocked");assert.equal(ctx.report.steps.length,1);
    assert.equal(ctx.prompts.length,0);
    const verified = fixture({plan:{...v2,goals:[{selector:target,equals:{var:"original"}}]},checkpoint:2});
    assert.equal(await explore(verified),"completed");
    assert.equal(verified.report.branches[0].status,"passed");
    assert.equal(verified.report.branches[1].status,"skipped");
    assert.equal(verified.report.steps.length,1);
});
