"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createExploration, runExploration } = require("../src/explorationEngine");

const bundle = "org.example.test";
const button = (id, text = id) => ({ id, text, clickable: true, type: "Button" });
function device(pages, next) {
    let current = "home", seq = 0;
    const calls = [], runs = new Map(), frames = new Map();
    function frame() {
        const def = pages[current];
        const nodes = def().map((n,i) => ({ bundleName: bundle, pagePath: current, visible: true, enabled: true,
            ref: "@e" + (i + 1) + "~" + seq, ...n }));
        const result = { nodes, frameId: "frame-" + seq++, capturedAt: new Date().toISOString(), quality: { complete: true } };
        frames.set(result.frameId, result);
        return result;
    }
    return { calls, runs, frames, get location() { return current; }, set location(v) { current = v; },
        async call(command, input) {
            calls.push([command,input]);
            if (command === "start") return { observation: frame() };
            if (command === "observe") return frame();
            if (command === "report") return runs.get(input.run_id);
            if (command === "inspect") return frames.get(input.frame_id);
            if (command !== "run") return {};
            const before = frame(), step = input.plan.steps[0];
            current = next(current, step, input) || current;
            const after = frame();
            const result = { status: "completed", counters: { actions: 1 }, observation: after,
                goalVerification: { status: "not_requested" }, steps: [{ path: "steps[0]", kind: "command",
                    command: step.command, status: "completed", result: { beforeFrameId: before.frameId, afterFrameId: after.frameId,
                        action: { dispatched: "acknowledged" } } }] };
            runs.set(input.run_id, { result, receipts: result.steps });
            return result;
        } };
}

function make(options) { return createExploration({ device: "phone", mode: "free", ...options }); }
function chooser(labels = []) {
    return async prompt => {
        const data = JSON.parse(prompt.split("\n").at(-1));
        const wanted = labels.map(text => data.candidates.find(c => c.label === text)).find(Boolean);
        return JSON.stringify({ id: wanted?.id || null, reason: wanted ? "Visit " + wanted.label : "Outside this task" });
    };
}
const label = node => node.input?.target?.id;

test("free exploration revisits known navigation to finish another frontier, without duplicating page identities", async () => {
    let tick = 0;
    const fixture = device({
        home: () => [button("settings"), button("pay", "Pay now"), { type: "Text", id: "clock", text: String(tick++) }],
        settings: () => [button("home"), button("help")], help: () => [button("topic")],
    }, (state, step) => step.command === "back" ? (state === "help" ? "settings" : "home") :
        ({ settings:"settings", home:"home", help:"help" })[label(step)]);
    const report = make();
    await runExploration({ report, agent:fixture, ask:chooser(["settings","home","help","topic"]) });
    assert.equal(report.status, "completed", report.reason);
    assert.equal(report.pages.length, 3);
    assert(report.steps.filter(s => s.label === "settings").length >= 2);
    assert.equal(report.findings.filter(f => f.kind === "review").length, 1);
    const entries = report.pages.flatMap(p => p.states.flatMap(s => s.entries));
    assert.equal(entries.find(e => e.label === "Pay now").status, "skipped");
    assert.equal(entries.filter(e => e.status === "tried").length, 4);
    assert(report.steps.every(s => s.before && s.after && s.runId));
    assert.equal(fixture.calls.at(-1)[0], "detach");
});

test("a budget applies to navigation and does not count unsafe or untried controls", async () => {
    const fixture = device({ home: () => [button("A"), button("B"), button("sign_in", "Sign In")] }, () => undefined);
    const report = make({maxInputs:1});
    await runExploration({report,agent:fixture,ask:chooser(["A","B"])});
    assert.equal(report.inputs,1); assert.match(report.reason,/budget/);
    assert.equal(report.pages[0].states[0].entries.find(e=>e.label==="B").status,"pending");
    const native = fixture.calls.find(([c])=>c==="run")[1];
    assert.equal(native.plan.limits.maxActions,1);assert(native.plan.limits.timeoutMs>0);
    assert.equal(native.plan.steps[0].input.target.bundleName, bundle);
});

test("a lost response is recovered by the prewritten run ID; a confirmed native action is not repeated", async () => {
    const fixture = device({home:()=>[button("Open")],detail:()=>[button("unused")]},(_,s)=>s.command==="back"?"home":"detail");
    const call=fixture.call.bind(fixture);let submitted=false, intended;
    fixture.call=async(c,i)=>{const value=await call(c,i);if(c==="run"&&!submitted){submitted=true;assert.equal(intended,i.run_id);throw Error("connection lost");}return value;};
    const report=make({maxInputs:1});await runExploration({report,agent:fixture,ask:chooser(["Open"]),
        onUpdate:async r=>{if(r.pending)intended=r.pending.runId;}});
    assert.equal(report.inputs,1);assert.equal(report.steps.filter(s=>s.label==="Open").length,1);
    assert(fixture.calls.some(([c])=>c==="report"));assert.equal(report.pending,undefined);
});

test("after a host crash an unknown pending native input is never sent again", async () => {
    const fixture=device({home:()=>[button("Open")]},()=>undefined);
    const report=make();report.pending={id:"step",runId:"old-run",key:"free-0",label:"Open"};
    await runExploration({report,agent:fixture,ask:()=>assert.fail("unexpected model request")});
    assert.equal(report.status,"blocked");assert.equal(report.steps[0].status,"unknown");
    assert(!fixture.calls.some(([c])=>c==="run"));
});

test("pause releases the device, then resume observes the actual page before giving the model control", async () => {
    const fixture=device({home:()=>[button("Open")],different:()=>[button("Other")]},()=>undefined);
    const report=make(), controller=new AbortController();
    await runExploration({report,agent:fixture,signal:controller.signal,ask:async()=>{controller.abort("pause");return new Promise(()=>{});}});
    assert.equal(report.status,"paused");assert.equal(fixture.calls.at(-1)[0],"detach");
    fixture.location="different";
    await runExploration({report,agent:fixture,ask:()=>assert.fail("must stop on a different page")});
    assert.equal(report.status,"paused");assert.match(report.reason,/moved/);
    assert(!fixture.calls.some(([c])=>c==="run"));
    fixture.location="home";
    await runExploration({report,agent:fixture,ask:chooser([])});
    assert.equal(report.status,"completed");
});

test("changing a menu overlay adds a state and returning does not create an extra page", async () => {
    let opened=false;
    const fixture=device({home:()=>[button("Language"), ...(opened?[{type:"Menu", id:"languages"},button("Cancel","Cancel")].map((n,i)=>i?{...n,type:"Option"}:n):[])]},
        (_,s)=>{opened=label(s)==="Language";});
    const report=make();await runExploration({report,agent:fixture,ask:chooser(["Language","Cancel"])});
    assert.equal(report.pages.length,1);
    assert.equal(report.pages[0].states.length,2);
    assert.equal(report.inputs,2);assert.equal(report.status,"completed",report.reason);
});

test("the model cannot dispatch an unoffered command, a stale candidate or a cross-app control", async () => {
    const fixture=device({home:()=>[button("Open")]},()=>undefined);
    const report=make();
    await runExploration({report,agent:fixture,ask:async()=>'{"id":"shell","reason":"unknown"}'});
    assert.equal(report.status,"blocked");assert(!fixture.calls.some(([c])=>c==="run"));
    let active=bundle;
    const changed=device({home:()=>[{...button("Open"),bundleName:active}]},()=>undefined);
    const moved=make();
    await runExploration({report:moved,agent:changed,ask:async prompt=>{active="org.example.other";return chooser(["Open"])(prompt);}});
    assert.equal(moved.status,"blocked");assert(!changed.calls.some(([c])=>c==="run"));
});

test("the scripted prefix runs once with its own input limit; only acknowledged alternatives spend the AI budget", async () => {
    const fixture = device({home:()=>[button("reset")],detail:()=>[button("Info"),button("More")]},()=>"detail");
    const report=make({mode:"flow",plan:{version:"1",steps:[{command:"press",input:{target:{id:"reset"}}},{command:"back"}]},
        checkpoints:[0],maxInputs:1});
    report.sourceCase={uri:"file:///saved-case"};
    let calls=0;
    await runExploration({report,agent:fixture,ask:async prompt=>{
        calls++;assert.equal(fixture.location,"detail");
        return JSON.stringify({index:0,reason:"inspect another screen"});
    }});
    assert.equal(report.status,"completed", report.reason);
    assert.equal(calls,1);
    assert.equal(report.prefixInputs,1);
    assert.equal(report.inputs,1);
    assert.deepEqual(report.branches.map(b=>b.status),["completed","completed","incomplete"]);
    assert.equal(report.branches[2].reason,report.reason);
    assert.equal(report.steps[1].replayStep.input.target.bundleName,bundle);
    assert.deepEqual(fixture.calls.filter(([cmd])=>cmd==="run").map(([,params])=>params.plan.steps.length),[1,1]);
});

test("the active guided branch can be paused, then resumed or ended by the user", async () => {
    const {finishExplorationBranches}=require("../src/explorationEngine");
    const fixture=device({home:()=>[button("Open")],detail:()=>[button("Info")]},()=>"detail");
    const report=make({mode:"flow",plan:{version:"1",steps:[{command:"press",input:{target:{id:"Open"}}}]},checkpoints:[0]});
    const controller=new AbortController();
    await runExploration({report,agent:fixture,signal:controller.signal,ask:async()=>{controller.abort("pause");return new Promise(()=>{});}});
    assert.equal(report.status,"paused");assert.equal(report.branches[1].status,"paused");
    const stopped=structuredClone(report);stopped.status="stopped";stopped.reason="Ended by user.";finishExplorationBranches(stopped);
    assert.equal(stopped.branches[1].status,"incomplete");assert.equal(stopped.branches[2].status,"pending");
    await runExploration({report,agent:fixture,ask:async()=>JSON.stringify({index:null,reason:"No remaining relevant entries"})});
    assert.equal(report.status,"completed",report.reason);assert.equal(report.branches[1].status,"skipped");
    assert.equal(fixture.calls.filter(([c])=>c==="run").length,1);
});
