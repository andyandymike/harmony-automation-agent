"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { ExplorationController } = require("../src/explorationController");
const { readWorkflow } = require("../src/workflowFile");
const {NetworkSession} = require("../src/network");

async function workspace(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "exploration-workspace-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const calls = [];
    const bench = {
        language: "en", storage: { fsPath: directory }, stateDir: directory, panel: {}, publish() {},
        state: { explorationHistory: [], devices: [] },
        perform: action => action(),
        get agent() {
            return { call: async (command, input) => {
                calls.push({ command, input });
                assert.equal(command, "inspect");
                return { frameId: input.frame_id, nodes: [{ ref: "@1", text: "Frozen evidence" }] };
            } };
        },
    };
    const controller = new ExplorationController(bench, {});
    return { controller, state: bench.state, calls };
}

test("offline history reads the specific nested receipt and persists manual triage without dispatching inputs", async t => {
    const { controller, state, calls } = await workspace(t);
    const report = { id: randomUUID(), mode: "free", goal: "Check help", createdAt: new Date().toISOString(),
        status: "completed", pages: [], steps: [{ id: "s", runId: "r", after: "last",
            receipts: [{ after: "changed" }, { after: "last" }] }],
        findings: [{ id: "f", kind: "review", stepId: "s" }] };
    await controller.save(report);
    await controller.handle({ type: "explorationOpen" });
    assert.equal(state.explorationHistory[0].id, report.id);
    await controller.handle({ type: "explorationReport", id: report.id });
    await controller.handle({ type: "explorationEvidence", id: report.id, stepId: "s", receiptIndex: 0, phase: "after" });
    assert.deepEqual(calls, [{ command: "inspect", input: { run_id: "r", frame_id: "changed", max_nodes: 180 } }]);
    assert.equal(state.explorationEvidence.page.nodes[0].label, "Frozen evidence");
    await controller.handle({ type: "explorationTriage", id: report.id, findingId: "f", reviewStatus: "ignored", note: "Expected in this build." });
    const saved = await controller.store.load(report.id);
    assert.equal(saved.findings[0].note, "Expected in this build.");
    assert.equal(saved.findings[0].reviewStatus, "ignored");
    assert.equal(saved.findings[0].kind, "review");
    assert.equal(calls.length, 1);
});

test("edited flow checkpoints are prepared from the current draft and preserve its source", async t => {
    const { controller, state } = await workspace(t);
    const plan = { version: "1", steps: [{ command: "back" }] };
    state.explorationFlow = { id: "old", source: "text", description: "Go back.", name: "Go back.", plan };
    await controller.handle({ type: "explorationFlow", source: "json", planJson: JSON.stringify({
        ...plan, steps: [{ command: "press", input: { target: { id: "options" } } }, ...plan.steps],
    }) });
    assert.equal(state.explorationFlow.description, "Go back.");
    assert.equal(state.explorationFlow.source, "text");
    assert.notEqual(state.explorationFlow.id, "old");
    assert.deepEqual(state.explorationFlow.checkpoints.map(c => c.index), [0, 1]);
});

test("free exploration can select the reviewed group and export a finding with that snapshot after the workspace group changes",async t=>{
    const {controller,state}=await workspace(t), bench=controller.bench;
    const original={version:1,name:"Synthetic timeout",rules:[]};
    state.device="demo"; state.devices=["demo"]; state.network={activeScenarioId:"g",scenarioVersion:7,scenario:original};
    let started;
    controller.run=async report=>{started=report;};
    bench.prepareFlowScenario=async (_plan,group)=>structuredClone(group);
    await assert.rejects(controller.start({mode:"free",ruleGroupId:"g",ruleGroupVersion:6}),/rule group changed/);
    await controller.start({mode:"free",ruleGroupId:"g",ruleGroupVersion:7});
    assert.deepEqual(started.mockScenario,original);
    state.network.scenario.name="Edited elsewhere";
    const plan={version:"1",steps:[{command:"back"}]};
    started.findings=[{id:"finding",kind:"failure",plan}];state.exploration=started;
    let saved;
    controller.vscode={window:{showSaveDialog:async()=>"memory.json"},workspace:{fs:{writeFile:async(_uri,buffer)=>{saved=buffer.toString();}}}};
    bench.setPlan=async uri=>assert.equal(uri,"memory.json");
    await controller.exportFinding({id:started.id,findingId:"finding"});
    const file=readWorkflow(saved);
    assert.equal(file.scenario.name,"Synthetic timeout");assert.deepEqual(file.plan,plan);
});

test("resuming a paused exploration restores its rule group and confirmed sequence position while old ambiguous sequences stop",async t=>{
    const {controller,state}=await workspace(t),bench=controller.bench,net=new NetworkSession();
    const group={version:1,name:"Sequence",rules:[{id:"seq",method:"GET",path:"/items",steps:[{response:{status:503}},{response:{status:200}}]}]};
    const saved=[{ruleId:"seq",count:1}],report={device:"demo",mockScenario:group,ruleGroupProgress:saved};
    const restore=[];
    bench.prepareFlowScenario=async (_scope,scenario,_id,hits)=>{restore.push(hits);net.setScenario(scenario,hits);};
    state.network={running:false};
    await controller.resumeRuleGroup(report);
    assert.deepEqual(net.snapshot().hits,saved);
    state.network={...net.snapshot(),running:true,mappedDevice:"demo"};
    await controller.resumeRuleGroup(report);
    assert.equal(restore.length,1);
    state.network.running=false;
    await assert.rejects(controller.resumeRuleGroup({...report,pending:{runId:"in-flight"}}),/cannot be confirmed/);
    await assert.rejects(controller.resumeRuleGroup({...report,ruleGroupProgress:undefined}),/cannot be confirmed/);
    assert.equal(restore.length,1);
});
