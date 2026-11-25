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
const {pathToFileURL,fileURLToPath} = require("node:url");
const {sourceDigest} = require("../src/caseRepair");
const {writeCaseMetadata} = require("../src/caseLibrary");
const {storePresentation} = require("../src/casePresentation");

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
        findings: [{ id: "f", kind: "review", stepId: "s" },{id:"other",kind:"review",note:"Keep this note"}] };
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
    await controller.handle({type:"explorationTriage",id:report.id,findingIds:["f","other"],reviewStatus:"open"});
    const reopened=await controller.store.load(report.id);
    assert.deepEqual(reopened.findings.map(item=>[item.reviewStatus,item.note]),[
        ["open","Expected in this build."],["open","Keep this note"],
    ]);
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
    assert.deepEqual(state.explorationFlow.checkpoints.map(c => c.index), [-1, 0, 1]);
});

test("a case step opens at its own boundary, preserves a good selection, and freezes its source only for an intact case",async t=>{
    const {controller,state}=await workspace(t);
    const filename=path.join(controller.bench.storage.fsPath,"workflow.json"),address=pathToFileURL(filename).href;
    const uri={scheme:"file",fsPath:filename,toString:()=>address};
    const rule={selector:{id:"language"},property:"text",equals:"English"};
    const plan={version:"1",steps:[{command:"press",input:{target:{text:"Language"}}},{command:"back"}],goals:[rule]};
    const raw=JSON.stringify(plan);
    await fs.writeFile(filename,raw);
    const meta=await writeCaseMetadata(uri,{name:"Language",source:"workflow",
        presentation:storePresentation(plan,new Map([[plan.steps[1],{name:"Leave the menu"}]]))});
    state.plan={name:"Language",uri:address};state.cases=[{...state.plan,editable:true,portableId:meta.id}];
    controller.vscode={Uri:{parse:value=>({scheme:"file",fsPath:fileURLToPath(value),toString:()=>value})},
        workspace:{openTextDocument:async file=>({getText:()=>file.fsPath===filename ? raw : "{"})}};
    const launch={type:"explorationFromCase",uri:address,digest:sourceDigest(raw),checkpoint:1};
    await controller.handle(launch);
    const prepared=state.explorationFlow;
    assert.deepEqual(prepared.defaultCheckpoints,[1]);
    assert.equal(prepared.checkpoints.find(point=>point.index===1).label,"Leave the menu");
    assert.deepEqual(prepared.goalChecks,['language shows "English"']);
    await assert.rejects(controller.handle({...launch,checkpoint:9}),/unavailable/);
    await assert.rejects(controller.handle({...launch,digest:"old"}),/changed/);
    await controller.handle({type:"explorationFlow",source:"json",planJson:"{bad"});
    assert.equal(state.explorationFlow,prepared);
    assert.match(state.explorationSourceIssue,/JSON/);
    state.devices=["demo"];state.device="demo";
    let report;
    controller.run=async r=>{report=r;};
    const probes=[];
    controller.bench.requireGestureRuntime=async prefix=>probes.push(prefix.steps);
    await assert.rejects(controller.start({mode:"flow",flowId:prepared.id,checkpoints:[-1,1]}),/one starting position/);
    assert.equal(probes.length,0);
    await controller.start({mode:"flow",flowId:prepared.id,checkpoints:[-1]});
    assert.deepEqual(probes,[[]]);
    await controller.start({mode:"flow",flowId:prepared.id,checkpoints:[1]});
    assert.equal(report.routeMode,"fork");
    assert.deepEqual(probes.at(-1),plan.steps);
    assert.deepEqual(report.sourceCase,{uri:address,id:meta.id,digest:sourceDigest(raw)});
    assert.equal(report.checkpointDetails[0].label,"Leave the menu");
    await controller.prepare({source:"json",planJson:JSON.stringify({...plan,goals:[]})});
    assert.equal(state.explorationFlow.sourceUri,undefined);
    assert.equal(state.explorationFlow.source,"json");
    await controller.start({mode:"flow",flowId:state.explorationFlow.id});
    assert.equal(report.sourceCase,undefined);
    assert.deepEqual(report.checkpointDetails[0].checks,[]);
    state.cases.push({name:"Invalid case",uri:"file:///invalid.json"});
    await controller.handle({type:"explorationFlow",source:"case",uri:"file:///invalid.json"});
    assert.equal(state.explorationFlow.name,"Invalid case");
    assert.equal(state.explorationFlow.sourceUri,"file:///invalid.json");
    assert.ok(state.explorationFlow.blockedReason);
    assert.equal(controller.flowDocument,undefined);
    await assert.rejects(controller.start({mode:"flow",flowId:prepared.id,checkpoints:[-1]}),/Review the flow/);
});

test("case preview and returning to the selected case work without initializing a phone runtime",async t=>{
    const {controller,state,calls}=await workspace(t);
    const actions=[];
    controller.bench.perform=async (action,options)=>{assert.equal(options.runtime,false);await action();};
    state.explorationFlow={sourceUri:"file:///order"};
    state.exploration={id:"finished",mode:"flow",steps:[],branches:[],findings:[]};
    controller.reviewCase=(report,message)=>actions.push([report.id,message.branchId]);
    controller.bench.openCase=async uri=>actions.push(uri);
    controller.bench.openTool=async tab=>actions.push(tab);
    await controller.handle({type:"explorationCase",id:"finished",branchId:"branch"});
    await controller.handle({type:"explorationOpenSourceCase",uri:"file:///another"});
    await controller.handle({type:"explorationOpenSourceCase",uri:"file:///order"});
    assert.deepEqual(actions,[["finished","branch"],"file:///order","recordings"]);
    assert.deepEqual(calls,[]);
});

test("free exploration ignores legacy rule selection messages while historical findings retain their snapshot",async t=>{
    const {controller,state}=await workspace(t), bench=controller.bench;
    const original={version:1,name:"Synthetic timeout",rules:[]};
    state.device="demo"; state.devices=["demo"]; state.network={activeScenarioId:"g",scenarioVersion:7,scenario:original};
    let started;
    controller.run=async report=>{started=report;};
    bench.prepareFlowScenario=async()=>assert.fail("Exploration must not activate a rule group");
    await controller.start({mode:"free",ruleGroupId:"g",ruleGroupVersion:7});
    assert.equal(started.mockScenario,undefined);
    started.mockScenario=structuredClone(original);
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
