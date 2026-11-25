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
    const point=report.checkpoints[0];
    if (!options.fork) report.branches=[
        {id:"baseline",kind:"baseline",label:"Original",status:"pending"},
        ...[1,2].map(n=>({id:"checkpoint-"+point+"-"+n,checkpoint:point,kind:"variant",label:"Path "+n,status:"pending"}))];
    let scene = "settings", language = "English", paused = false;
    const states = new Map(), sends = [], prompts = [];
    const ctx = { report, sends, prompts, sync: async () => {}, guard() {}, local:en => en,
        finding:f => report.findings.push(f), stop:(status,reason) => { throw Object.assign(new Error(reason), { status }); },
        stateIdAt:async (runId,frameId) => states.get(runId+":"+frameId),
        isRepeatable:() => options.repeatable !== false,
        observe:async()=>ctx.current,
        get current() {return { id:scene,label:scene,entries:scene === "menu" ? [entry("cancel"),entry("details")] : [] };},
        ask:async prompt => {
            const q=JSON.parse(prompt.split("\n").at(-1));prompts.push(q);
            const first=options.fork ? q.entries.find(e=>e.label==="details") || q.entries[0] : q.entries[0];
            return JSON.stringify({ index:first.index, strategy:first.label==="cancel" ? "replace" : "detour", reason:first.label });
        },
        async run(segment, meta) {
            const known=report.steps.find(r=>r.key===meta.key);
            if(known)return known;
            const id=String(report.steps.length+1);
            const record={ id, runId:id, ...meta, fromStateId:scene,status:"completed",goalStatus:"not_requested",receipts:[] };
            if (options.failPrefix && meta.phase==="prefix") {
                record.status="failed";record.receipts=[{path:"preconditions[0]",status:"failed",expected:"French",actual:language}];
                report.steps.push(record);return record;
            }
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
                record.receipts.push({kind:"command",command:step.command,path:"steps["+i+"]",status:"completed",after:frameId,
                    dispatched:options.unknown && meta.phase==="variant"?"unknown":"acknowledged"});
            }
            for (const [i,g] of (segment.goals || []).entries()) {
                const expected=g.equals?.var ? "English" : g.equals;
                const ok=language===expected;
                record.goalStatus=ok ? "passed" : "failed";
                record.receipts.push({kind:"goal",path:"goals["+i+"]",status:record.goalStatus,expected,actual:language});
                if (!ok) record.status="failed";
            }
            record.toStateId=options.missingAnchor && meta.phase==="prefix" ? undefined : scene;report.steps.push(record);
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

test("new exploration dispatches the script to the checkpoint once, then uses the reached screen without executing the old suffix",async()=>{
    const ctx=fixture({fork:true,pauseAfterKey:"checkpoint-0-1/act"});
    assert.equal(await explore(ctx),"paused");
    assert.deepEqual(ctx.sends,["language","details"]);
    assert.equal(ctx.prompts[0].checkpoint,"menu");
    assert.equal(await explore(ctx),"completed");
    assert.deepEqual(ctx.sends,["language","details","back","cancel"]);
    assert.deepEqual(ctx.report.branches.map(b=>b.status),["completed","completed","completed"]);
    assert.equal(ctx.report.steps.filter(s=>s.key==="prefix").length,1);
    assert.ok(ctx.report.steps.every(s=>s.key!=="baseline"&&!s.key.endsWith("/suffix")));
});

test("a failed scripted precondition blocks AI entirely, including at the case start",async()=>{
    const ctx=fixture({fork:true,checkpoint:-1,failPrefix:true});
    assert.equal(await explore(ctx),"blocked");
    assert.deepEqual(ctx.sends,[]);assert.deepEqual(ctx.prompts,[]);
    assert.match(ctx.report.branches[0].reason,/preconditions\[0\]/);
    assert.equal(ctx.report.branches[0].status,"failed");
    assert.deepEqual([ctx.report.findings[0].expected,ctx.report.findings[0].actual],["French","English"]);
});

test("a selected check replays exactly through that row and excludes the original next navigation",async()=>{
    const open={command:"press",input:{target}}, original={command:"press",input:{target:{id:"cancel"}}};
    const source={version:"1",preconditions:[rule,rule],steps:[open,{assert:rule},original],goals:[rule,{...rule,equals:"French"}]};
    for (const [checkpoint,initial,steps,final] of [[-1,0,0,0],[0,1,0,0],[1,2,0,0],[2,2,1,0],[5,2,3,1],[6,2,3,2]]) {
        const ctx=fixture({fork:true,plan:source,checkpoint});
        ctx.report.checkpointLayout="rows";
        let prefix;
        const run=ctx.run.bind(ctx);
        ctx.run=(segment,meta)=>{
            if (meta.phase==="prefix") prefix=segment;
            return run(segment,meta);
        };
        await explore(ctx);
        assert.deepEqual(prefix.preconditions || [],source.preconditions.slice(0,initial));
        assert.deepEqual(prefix.steps,steps ? source.steps.slice(0,steps) : [{command:"observe"}]);
        assert.deepEqual(prefix.goals || [],source.goals.slice(0,final));
        if (checkpoint===2) assert.deepEqual(ctx.prompts[0].entries.map(row=>row.label),["details"]);
        if (checkpoint===6) {
            assert.equal(ctx.report.branches[0].status,"failed");
            assert.deepEqual(ctx.prompts,[]);
        }
    }
});

test("a completed script with no identifiable checkpoint is recorded as blocked and never invokes AI",async()=>{
    const ctx=fixture({fork:true,missingAnchor:true});
    assert.equal(await explore(ctx),"blocked");
    assert.equal(ctx.report.branches[0].status,"blocked");
    assert.deepEqual(ctx.prompts,[]);
});

test("a final reference runs its promoted exit checks before handing the screen to AI",async()=>{
    const ctx=fixture({fork:true});
    ctx.report.forkSource={checkpoint:0,replayExitChecks:[{...rule,equals:"reference exit"}]};
    const replay=ctx.run.bind(ctx);
    let verified=false;
    ctx.run=async(segment,meta)=>{
        if (meta.phase==="prefix") {
            assert.deepEqual(segment.goals,ctx.report.forkSource.replayExitChecks);
            verified=true;
        }
        return replay(segment,meta);
    };
    const ask=ctx.ask.bind(ctx);
    ctx.ask=prompt=>{assert.ok(verified);return ask(prompt);};
    await explore(ctx);
    assert.ok(verified);
});

test("unconfirmed branch input preserves the script evidence without publishing a completed alternative",async()=>{
    const ctx=fixture({fork:true,unknown:true});
    assert.equal(await explore(ctx),"blocked");
    assert.deepEqual(ctx.sends,["language","details"]);
    assert.equal(ctx.report.branches[1].status,"blocked");
    assert.equal(ctx.report.steps.length,2);
});
