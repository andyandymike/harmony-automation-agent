"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {readWorkflow,workflowWithScenario}=require("../src/workflowFile");
const {NetworkSession,exampleScenario}=require("../src/network");
const {NetworkController,timeRange}=require("../src/networkController");
const {ScenarioLibrary}=require("../src/networkScenarioLibrary");

test("the portable workflow resets an embedded response sequence when reopened in another workspace",async t=>{
    const workflow={version:"2",steps:[{read:{name:"value",selector:{id:"v"},property:"text"}}]};
    const portable=JSON.stringify(workflowWithScenario(workflow,exampleScenario()));
    assert.deepEqual(readWorkflow("\uFEFF"+JSON.stringify(workflow)),{plan:workflow});
    const opened=readWorkflow(portable);
    assert.deepEqual(opened.plan,workflow);
    const net=new NetworkSession();
    t.after(()=>net.stop());
    const controller={net,library:new ScenarioLibrary(undefined,exampleScenario(),"Untitled"),bindings:{},init:async()=>{},bench:{state:{device:"phone"}},mapDevice:async function(){this.mapping={device:"phone"};}};
    async function replay(){await NetworkController.prototype.prepareFlow.call(controller,{uri:"file:///elsewhere/case.json"},opened.scenario);}
    await replay();
    for(const expected of [503,200]){const response=await fetch(net.baseUrl+"/items");assert.equal(response.status,expected);await response.text();}
    await replay();const again=await fetch(net.baseUrl+"/items");assert.equal(again.status,503);await again.text();
    assert.deepEqual(net.snapshot().records.map(r=>r.status),[503,200,503]);
});
test("a debugger pause is excluded from the network time window",()=>{
    const at="2026-11-21T00:02:00.000Z",startedAt="2026-11-21T00:01:59.500Z";
    assert.deepEqual(timeRange({at,startedAt,elapsedMs:90000}),{start:Date.parse(startedAt),end:Date.parse(at)});
});
