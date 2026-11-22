"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {NetworkController} = require("../src/networkController");

test("studio preview, save and one-off resend keep separate receipts across a workspace restart", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),"ha-network-workspace-"));
    const bench = {storage:{fsPath:dir},language:"en",state:{mode:"network"},
        context:{workspaceState:{get:(_key,fallback)=>fallback}},publish(){},errorMessage:e=>e.message};
    const controller = new NetworkController(bench,{});
    t.after(async () => {await controller.close();await fs.rm(dir,{recursive:true,force:true});});
    const handle = message => controller.handle(message);
    await handle({type:"networkOpen"});
    await handle({type:"networkServer"});
    await handle({type:"networkTry",id:"items"});
    const sample = bench.state.network.records[0];
    const rule = {id:"mobile fixture",method:"GET",match:{type:"glob",field:"path",value:"/item*"},
        action:"local",response:{status:202,headers:{"content-type":"application/json"},body:'{"fixture":true}'}};
    await handle({type:"networkPreviewRule",rule,revision:"preview",seedId:sample.id});
    const preview = bench.state.network.operation.preview;
    assert.deepEqual(preview.matchedIds,[sample.id]);
    assert.equal(bench.state.network.records.length,1);
    assert.equal(bench.state.network.hits[0].count,1);

    await handle({type:"networkUpsertRule",rule,revision:"save",scenarioId:bench.state.network.activeScenarioId,originalRule:null});
    assert.equal(bench.state.network.operation.revision,"save");
    assert.deepEqual(bench.state.network.scenario.rules.map(r=>r.id),["mobile fixture","items"]);
    const replay = {type:"networkReplay",request:{path:"/items",method:"GET",headers:{},sourceId:sample.id},revision:"one send"};
    await Promise.all([handle(replay),handle(replay)]);
    await handle(replay);
    const receipt = bench.state.network.operation;
    assert.equal(receipt.revision,"one send");
    assert.equal(bench.state.network.records.length,2);
    assert.equal(bench.state.network.records[1].id,receipt.recordId);
    assert.equal(bench.state.network.records[1].replayOf,sample.id);
    assert.equal(bench.state.network.records[1].status,202);

    await handle({type:"networkUpstream",origin:"http://127.0.0.1:32000",revision:"route"});
    await handle({type:"networkServer"});
    await controller.persist();
    const reopened = new NetworkController(bench,{});
    try {
        await reopened.handle({type:"networkOpen"});
        assert.equal(bench.state.network.upstream,"http://127.0.0.1:32000");
        assert.equal(bench.state.network.running,false);
        assert.equal(bench.state.network.records[1].replayOf,sample.id);
        assert.equal(bench.state.network.operation,undefined);
    } finally {await reopened.close();}
});

test("scenario edits receive correlated host results, survive errors and reject stale drafts", async t => {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ha-scenario-edit-"));
    const bench={storage:{fsPath:dir},language:"en",state:{mode:"network"},
        context:{workspaceState:{get:(_key,fallback)=>fallback}},publish(){},errorMessage:e=>e.message};
    const vscode={workspace:{workspaceFolders:[]},window:{showOpenDialog:async()=>[],showSaveDialog:async()=>undefined}};
    const controller=new NetworkController(bench,vscode);
    t.after(async()=>{await controller.close();await fs.rm(dir,{recursive:true,force:true});});
    const handle=(type,revision,extra={})=>controller.handle({type,revision,...extra});
    await handle("networkOpen");
    const base=bench.state.network.scenarioVersion;
    await handle("networkApply","invalid",{scenarioVersion:base,scenario:{version:1,rules:[{}]}});
    assert.equal(bench.state.network.scenarioReceipt.revision,"invalid");
    assert.ok(bench.state.network.scenarioReceipt.error);
    assert.equal(bench.state.network.scenarioVersion,base);
    const edited={...bench.state.network.scenario,name:"Edited fixture"};
    await handle("networkApply","applied",{scenarioVersion:base,scenario:edited});
    assert.equal(bench.state.network.scenario.name,"Edited fixture");
    assert.deepEqual(bench.state.network.scenarioReceipt,{type:"networkApply",revision:"applied"});
    const next=bench.state.network.scenarioVersion;
    assert.notEqual(next,base);
    await handle("networkApply","stale",{scenarioVersion:base,scenario:{...edited,name:"Stale"}});
    assert.match(bench.state.network.scenarioReceipt.error,/changed/);
    assert.equal(bench.state.network.scenario.name,"Edited fixture");
    await handle("networkSaveScenario","cancel-save");
    assert.deepEqual(bench.state.network.scenarioReceipt,{type:"networkSaveScenario",revision:"cancel-save",cancelled:true});
    await handle("networkLoadScenario","cancel-open");
    assert.deepEqual(bench.state.network.scenarioReceipt,{type:"networkLoadScenario",revision:"cancel-open",cancelled:true});
    assert.equal(bench.state.network.scenarioVersion,next);
});
