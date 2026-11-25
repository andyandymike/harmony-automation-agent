"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { runPhoneTask, explainRun } = require("../src/aiTasks");
const { localRequests, explainExchange } = require("../src/aiEvidence");
const { NetworkSession } = require("../src/network");
const { NetworkController } = require("../src/networkController");
const loadWebview = require("../test-support/loadWebview");

function screen(version, nodes, complete = true) {
    return { frameId: version, quality: { complete }, nodes: nodes.map((node, index) => ({
        ref: "@e" + (index + 1) + "~" + version, type: "Button", bundleName: "example.app",
        visible: true, enabled: true, clickable: true, ...node,
    })) };
}
const home = screen("home", [{ id: "language", text: "Language" }]);
const menu = screen("menu", [{ id: "option", text: "English" }]);

function fixture(initial, handler = () => { throw new Error("Unexpected command"); }, lifecycle = {}) {
    const calls = [];
    const events = [];
    return {
        calls, events, device: "test-phone", goal: "Test the language menu", language: "en",
        onEvent: e => events.push(e), agent: { async call(command, input) {
            calls.push({ command, input });
            if (lifecycle[command]) return lifecycle[command](input);
            if (["attach", "claim", "detach"].includes(command)) return {};
            if (command === "observe") return initial;
            return handler(command, input);
        } },
    };
}

function planned(...decisions) {
    return async prompt => {
        assert.match(prompt, /user goal/i);
        assert(decisions.length, "Unexpected model turn");
        return JSON.stringify(decisions.shift());
    };
}

test("runs a goal, checks a real property, and returns replayable evidence-based steps", async () => {
    const ctx = fixture(home, (cmd, input) => {
        if (cmd === "wait") {
            assert.deepEqual(input.target, { bundleName: "example.app", id: "option" });
            return { assertion: { status: "passed" }, observation: menu };
        }
        if (cmd === "press") assert.deepEqual(input.target, { ref: "@e1~home" });
        return { action: { dispatched: "acknowledged" }, observation: cmd === "back" ? home : menu };
    });
    const prompts = [];
    const decide = planned({ action: "press", node: 1, name: "Open language settings" },
        { action: "check", node: 1, property: "text", equals: "English", name: "Confirm language choice" },
        { action: "back" }, { action: "done", text: "The English option was present." });
    const result = await runPhoneTask({ ...ctx, ask: prompt => {
        prompts.push(prompt);
        return decide(prompt);
    } });
    assert.equal(result.status, "completed");
    assert.deepEqual(ctx.calls.map(c => c.command), ["attach", "claim", "observe", "press", "wait", "back", "detach"]);
    assert.equal(ctx.calls[0].input.device, "test-phone");
    assert.equal(new Set(ctx.calls.map(c => c.input.session)).size, 1);
    assert.deepEqual(result.draft.steps.map(s => s.command), ["press", "wait", "back"]);
    assert.equal(result.draft.steps[0].name, "Open language settings");
    const {history} = JSON.parse(prompts.at(-1).split("\n").at(-1));
    assert.equal(history[1].name, "Confirm language choice");
    assert.deepEqual(result.draft.steps[0].input.target, { bundleName: "example.app", id: "language" });
    assert(!JSON.stringify(result.draft.steps).includes("@e"));
    assert(ctx.events.some(e => /Verified.*English/.test(e.text)));
    assert.deepEqual(ctx.events.at(-1), { type: "answer", text: "AI assessment · The English option was present." });
});

test("hands off a retained replay from the same workbench before reading or acting", async () => {
    const workbenchSession = "vscode-workbench";
    let owner = workbenchSession;
    const ctx = fixture(home, undefined, {
        claim({ session }) {
            if (owner) throw Object.assign(new Error("Device owned"), { code: "DEVICE_OWNED", details: { ownerSession: owner } });
            owner = session;
        },
        release({ session }) { assert.equal(session, owner); owner = undefined; },
        detach({ session }) { assert.equal(session, owner); owner = undefined; },
    });
    const result = await runPhoneTask({ ...ctx, workbenchSession, ask: planned({ action: "done", text: "Language is visible." }) });
    assert.equal(result.status, "completed");
    assert.deepEqual(ctx.calls.map(c => c.command), ["attach", "claim", "release", "claim", "observe", "detach"]);
    assert.equal(ctx.calls[1].input.session, ctx.calls[3].input.session);
    assert.equal(ctx.calls[2].input.session, workbenchSession);
    assert.notEqual(ctx.calls[3].input.session, workbenchSession);
    assert.equal(owner, undefined);
});

test("preserves a third-party owner and propagates unrelated claim failures", async () => {
    const workbenchSession = "vscode-workbench";
    for (const [code, ownerSession] of [["DEVICE_OWNED", "external-session"], ["DEVICE_OWNED", undefined], ["DEVICE_BUSY", workbenchSession]]) {
        const error = Object.assign(new Error("Claim rejected"), { code, details: { ownerSession } });
        const ctx = fixture(home, undefined, { claim() { throw error; } });
        await assert.rejects(runPhoneTask({ ...ctx, workbenchSession, ask: planned() }), e => e === error);
        assert.deepEqual(ctx.calls.map(c => c.command), ["attach", "claim", "detach"]);
    }
});

test("stopping during an ownership handoff prevents its next command", async () => {
    const workbenchSession = "vscode-workbench";
    for (const stopAt of ["claim", "release"]) {
        const ctrl = new AbortController();
        const ctx = fixture(home, undefined, {
            claim() {
                if (stopAt === "claim") ctrl.abort();
                throw Object.assign(new Error("Device owned"), { code: "DEVICE_OWNED", details: { ownerSession: workbenchSession } });
            },
            release() { ctrl.abort(); },
        });
        await assert.rejects(runPhoneTask({ ...ctx, workbenchSession, signal: ctrl.signal, ask: planned() }), { name: "AbortError" });
        const expected = stopAt === "claim" ? ["attach", "claim", "detach"] : ["attach", "claim", "release", "detach"];
        assert.deepEqual(ctx.calls.map(c => c.command), expected);
    }
});

test("a read-only request can answer from a single page and cannot mutate the device", async () => {
    const read = fixture(home);
    const result = await runPhoneTask({ ...read, allowActions: false, ask: async prompt => {
        assert.match(prompt, /Language/); assert(!prompt.includes("@e1~home"));
        return '{"action":"done","text":"The Language button is visible."}';
    } });
    assert.deepEqual(read.calls.map(c => c.command), ["attach", "observe", "detach"]);
    assert(!result.draft);
    for (const item of [{ action: "press", node: 1 }, { action: "shell", text: "pwd" }]) {
        const ctx = fixture(home);
        await assert.rejects(runPhoneTask({ ...ctx, allowActions: false, ask: planned(item) }), /proposed operation/);
        assert.deepEqual(ctx.calls.map(c => c.command), ["attach", "observe", "detach"]);
    }
});

test("a truncated tree cannot produce an ambiguous selector in a saved draft", async () => {
    const ctx = fixture({ ...home, quality: { complete: false } }, cmd =>
        cmd === "inspect" ? { matches: 2 } : { action: { dispatched: "acknowledged" }, observation: menu });
    const result = await runPhoneTask({ ...ctx, ask: planned({ action: "press", node: 1 },
        { action: "done", text: "Menu is open." }) });
    assert.equal(result.draft, undefined);
    assert.deepEqual(ctx.calls[3].input.target, { bundleName: "example.app", id: "language" });
    assert.deepEqual(ctx.calls[4].input.target, { ref: "@e1~home" });
});

test("cancelling a pending model decision releases the device without sending the pending tap", async () => {
    const ctrl = new AbortController();
    const ctx = fixture(home);
    await assert.rejects(runPhoneTask({ ...ctx, signal: ctrl.signal, ask: async () => {
        ctrl.abort();
        return '{"action":"press","node":1}';
    } }), { name: "AbortError" });
    assert.deepEqual(ctx.calls.map(c => c.command), ["attach", "claim", "observe", "detach"]);
    assert(!ctx.events.some(e => e.type === "answer"));
});

test("uncertain gestures are never retried; a model cannot select an arbitrary session or enter invented input", async () => {
    const ctx = fixture(home, () => { throw new Error("Dispatch uncertain"); });
    await assert.rejects(runPhoneTask({ ...ctx, ask: planned({ action: "press", node: 1, session: "other" }) }), /Dispatch uncertain/);
    assert.deepEqual(ctx.calls.map(c => c.command), ["attach", "claim", "observe", "press", "detach"]);
    assert(!ctx.calls.some(c => c.input.session === "other"));
    for (const item of [{ action: "press", node: 987 }, { action: "fill", node: 1, text: "invented" }]) {
        const bad = fixture(screen("edit", [{ id: "field", editable: true }]));
        await assert.rejects(runPhoneTask({ ...bad, ask: planned(item) }), /proposed operation/);
        assert.deepEqual(bad.calls.map(c => c.command), ["attach", "claim", "observe", "detach"]);
    }
});

test("failed-run analysis uses only the selected saved report and frozen frame", async () => {
    const ctx = fixture(home, (c, input) => {
        assert.equal(input.run_id, "saved-run");
        if (c === "inspect") { assert.equal(input.frame_id, "after-failure"); return menu; }
        assert.equal(c, "report");
        return { result: { status: "failed" }, receipts: [{ path: "goals[0]", kind: "goal",
            afterFrameId: "after-failure", result: { status: "failed", expected: "abc", actual: "xyz" } }] };
    });
    await explainRun({ ...ctx, run: { entry: { id: "saved-run" }, selected: 0 }, ask: async prompt => {
        const evidence = JSON.parse(prompt.split("\n").at(-1)).evidence;
        assert.equal(evidence.selected.expected, "abc"); assert.equal(evidence.selected.actual, "xyz");
        if (!evidence.consulted.length) return JSON.stringify({action:"frame",phase:"after"});
        assert.equal(evidence.consulted[0].page.nodes[0].text, "English");
        return "goals[0] expected abc; the observed value was xyz.";
    } });
    assert.deepEqual(ctx.calls.map(c => c.command), ["report", "inspect"]);
    assert.equal(ctx.events.at(-1).type, "answer");
});

test("coordinate replay diagnosis reads receipts without claiming verification or querying the phone", async () => {
    const ctx = fixture(home);
    await explainRun({ ...ctx, run: { entry: { source: "device" }, status: "completed", selected: 0,
        steps: [{ path: "steps[0]", command: "click", dispatched: "acknowledged", status: "completed" }] },
    ask: async prompt => {
        const evidence = JSON.parse(prompt.split("\n").at(-1)).evidence;
        assert.equal(evidence.goalStatus, "not_requested");
        assert.equal(evidence.selected.dispatched, "acknowledged");
        return "One click was acknowledged.";
    } });
    assert.deepEqual(ctx.calls, []);
});

function localHistory(rows) {
    return {async init(){},net:{snapshot:()=>({records:rows}),findRecord:id=>rows.find(r=>r.id===id),collection:{recordsWithHistory:r=>r}}};
}
function exchange(id,at,status) {
    return {id,startedAt:new Date(at).toISOString(),durationMs:40,status,method:"GET",source:"fixture",ruleHit:1,
        path:"/api/orders/private-name/987654?token=PRIVATE",request:{headers:{authorization:"PRIVATE"}},response:{body:{private:"PRIVATE"}}};
}

test("a phone task uses a retained HTTP result to choose and verify a control without exporting HTTP as an assertion",async()=>{
    const ctx=fixture(home,(cmd,input)=>{
        assert.equal(cmd,"wait"); assert.equal(input.property,"text"); assert.equal(input.equals, "Language");
        return {assertion:{status:"passed"},observation:home};
    });
    const n=localHistory([exchange("unique-record",Date.now(),503),exchange("outside",Date.now()-600_000,500)]);
    const result=await runPhoneTask({...ctx,readRequests:(range,filter)=>localRequests(n,range,filter),ask:async prompt=>{
        const {history}=JSON.parse(prompt.split("\n").at(-1));
        if (!history.length) return '{"action":"http","filter":"errors"}';
        assert.equal(history[0].evidence.records[0].status,503);
        assert.doesNotMatch(prompt,/PRIVATE|private-name|987654|outside/);
        return history.length===1 ? '{"action":"check","node":1,"property":"text","equals":"Language"}' :
            '{"action":"done","text":"The language control was present after the recorded error."}';
    }});
    assert.deepEqual(result.draft.steps.map(s=>s.command),["wait"]);
    const receipt=ctx.events.find(e=>e.type==="evidence");
    assert.deepEqual(receipt.receipt.records.map(r=>r.id),["unique-record"]);
    assert.match(receipt.text,/503.*fixture.*unique-record/);
    assert.deepEqual(ctx.calls.map(c=>c.command),["attach","claim","observe","wait","detach"]);
});

test("offline step diagnosis scopes HTTP by actual overlap, shows retained sources and reads no device",async()=>{
    const at=Date.UTC(2026,0,1),from=new Date(at).toISOString(),to=new Date(at+500).toISOString();
    const agent={call:async (cmd,input)=>{
        assert.equal(cmd,"report");assert.equal(input.run_id,"one");
        return {result:{status:"failed"},receipts:[{path:"goals[0]",kind:"goal",startedAt:from,at:to,result:{status:"failed"}}]};
    }};
    const n=localHistory([exchange("overlap",at-20,404),exchange("early",at-50,404),exchange("unrelated",at+20,200)]);
    const events=[];
    await explainRun({agent,run:{entry:{id:"one"},selected:0},goal:"Which error?",language:"en",onEvent:e=>events.push(e),
        readRequests:(range,filter)=>localRequests(n,range,filter),ask:async prompt=>{
            const info=JSON.parse(prompt.split("\n").at(-1));
            assert.equal(info.question,"Which error?");
            if(!info.evidence.consulted.length)return '{"action":"http","filter":"errors"}';
            assert.deepEqual(info.evidence.consulted[0].records.map(r=>r.id),["overlap"]);
            assert.doesNotMatch(prompt,/private-name|987654|PRIVATE|unrelated/);
            return '{"action":"answer","text":"One recorded 404 overlaps the step."}';
        }});
    assert.deepEqual(events.filter(e=>e.type==="evidence").map(e=>e.receipt.kind),["step","http"]);
    assert.equal(events.at(-1).type,"answer");
    assert.equal((await localRequests(n,undefined)).status,"missingTime");
});

test("exchange explanation reads only the selected retained record and identifies missing sources",async()=>{
    const n=localHistory([exchange("chosen",Date.now(),503),exchange("other",Date.now(),401)]),events=[];
    const options={controller:n,id:"chosen",onEvent:e=>events.push(e),ask:async prompt=>{
        assert.match(prompt,/chosen/);assert.doesNotMatch(prompt,/other|PRIVATE|private-name|987654/);
        return "The recorded request returned 503.";
    }};
    await explainExchange(options);
    assert.equal(events[0].receipt.kind,"exchange");
    await assert.rejects(explainExchange({...options,id:"evicted"}),/no longer/);
});

test("an offline diagnosis opens the cited original from favorites and the detail menu offers an explanation for that exact request",async()=>{
    const net=new NetworkSession(),id="saved-exchange";
    const row={...exchange(id,Date.now(),503),request:{url:"https://test.invalid/items",headers:{},bodyState:"unavailable"},
        response:{status:503,headers:{},bodyState:"unavailable"}};
    net.collection.save(row);
    const state={mode:"run",devices:[],run:{selected:0,steps:[{path:"steps[0]"}]},aiResults:{diagnosis:{evidence:[{kind:"http",records:[{id}]}]}}};
    const host={bench:{state},net,init:async()=>{},word:en=>en,changed(){state.network={...net.snapshot(),logs:[],markers:[],returnTo:this.returnTo,
        originStep:this.originStep,filterVersion:this.filterVersion,evidenceRecord:this.evidenceRecord};}};
    await NetworkController.prototype.handle.call(host,{type:"networkEvidenceRecord",id:"not-consulted"});
    assert.equal(state.mode,"run");
    await NetworkController.prototype.handle.call(host,{type:"networkEvidenceRecord",id});
    const view=await loadWebview("networkView"), markup=view.networkView(state,"en");
    assert.equal(state.mode,"network");assert.equal(state.network.returnTo,"run");
    assert.match(markup,/data-type="explainExchange" data-id="saved-exchange"/);assert.match(markup,/Return to step/);
    assert.match(markup,/data-net="unfavorite" data-id="saved-exchange"/);
});
