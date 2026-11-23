"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises"), os=require("node:os"), path=require("node:path");
const {NetworkController}=require("../src/networkController");
const {NetworkSession}=require("../src/network");
const loadWebview=require("../test-support/loadWebview");

function sample() {
    return {startedDateTime:"2026-11-01T10:00:00Z",time:11,
        request:{method:"GET",url:"https://shop.example.test/items?tag=a&tag=b&token=private",headers:[{name:"Authorization",value:"private"}]},
        response:{status:503,headers:[],content:{mimeType:"application/json",text:'{"error":{"retryAfter":2,"accessToken":"private"},"prices":[5,12]}'}}};
}
function importRows(net,entries) {net.importHar({log:{entries}});}

test("archived exchanges reopen independently of history retention, can be renamed, previewed, replayed and unstarred",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"harmony-collection-"));
    const bench={storage:{fsPath:dir},language:"en",state:{mode:"network"},context:{workspaceState:{get:(_k,def)=>def}},publish(){},errorMessage:e=>e.message};
    const vscode={window:{showInputBox:async()=>"Checkout timeout"}};
    const first=new NetworkController(bench,vscode);
    const second=new NetworkController(bench,vscode);
    t.after(async()=>{await first.close();await second.close();await fs.rm(dir,{recursive:true,force:true});});
    await first.init();
    const complete=sample();
    complete.response.content.text='{"error":{"retryAfter":2}}';
    importRows(first.net,[complete]);
    const id=first.net.records[0].id;
    await first.handle({type:"networkSaveFavorite",id});
    await first.handle({type:"networkRenameFavorite",id});
    importRows(first.net,Array(500).fill(sample()));
    await first.persist();
    assert.equal(first.net.records.length,500);
    assert.ok(first.net.records.every(row=>row.id!==id));
    await second.init();
    const favorite=second.net.collection.items.get(id);
    assert.equal(favorite.name,"Checkout timeout");
    assert.equal(favorite.record.response.body.error.retryAfter,2);
    assert.ok(!JSON.stringify(favorite.record).includes("private"));
    const rule={id:"test",enabled:true,method:"GET",match:{type:"exact",field:"path",value:"/items"},action:"local",
        response:{status:200,headers:{"content-type":"application/json"},body:"{}"}};
    const preview=second.net.previewRule(rule,undefined,id);
    assert.equal(preview.total,501);
    assert.equal(preview.examples[0].id,id);
    await second.net.start();
    const replay=await second.net.replay({sourceId:id,method:"GET",path:"/items",headers:{}});
    assert.equal(replay.replayOf,id);
    assert.equal(replay.ruleScenarioId,second.activeScenarioId);
    assert.equal(favorite.record.status,503);
    const redacted=second.net.records.find(row=>row.response.body?.error?.accessToken==="[redacted]");
    await assert.rejects(second.handle({type:"networkFrom",id:redacted.id}),/complete JSON response/);
    await second.handle({type:"networkFrom",id});
    const draft=bench.state.networkDraft;
    assert.equal(draft.sourceId,id);
    assert.equal(draft.scenario.rules.length,second.net.scenario.rules.length+1);
    assert.equal(draft.scenario.rules[0].id,draft.focusRuleId);
    assert.equal(draft.scenario.rules[0].steps[0].response.status,503);
    assert.equal(draft.scenarioId,second.activeScenarioId);
    await second.handle({type:"networkRemoveFavorite",id});
    assert.equal(second.net.findRecord(id),undefined);
    await second.handle({type:"networkUndoFavorite",id});
    assert.deepEqual(second.net.findRecord(id),favorite.record);
});

test("deleting history preserves its snapshot and undo restores arrival order",()=>{
    const net=new NetworkSession();
    importRows(net,[sample(),sample(),sample()]);
    const ids=net.records.map(row=>row.id),id=ids[1];
    net.collection.save(net.findRecord(id));
    net.removeRecord(id);
    assert.ok(net.collection.items.has(id));
    net.undoRecordRemoval("outdated undo");
    assert.equal(net.records.length,2);
    importRows(net,[sample()]);
    net.undoRecordRemoval(id);
    assert.deepEqual(net.records.slice(0,3).map(row=>row.id),ids);
    assert.equal(net.collection.recordsWithHistory(net.records).length,4);
});

test("clearing the request list persists an empty history, preserves favorites and merges new arrivals on undo",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"harmony-clear-history-"));
    const bench={storage:{fsPath:dir},language:"en",state:{tool:"network"},context:{workspaceState:{get:(_k,fallback)=>fallback}},publish(){}};
    const controller=new NetworkController(bench,{});
    t.after(async()=>{await controller.close();await fs.rm(dir,{recursive:true,force:true});});
    await controller.init();
    const {net}=controller;
    importRows(net,[sample(),sample()]);
    const previous=net.records.map(row=>row.id);
    net.collection.save(net.findRecord(previous[0]));
    const rules=net.scenario;
    net.omittedRecords=4;
    await controller.handle({type:"networkClearTraffic"});
    const undoId=net.snapshot().clearedHistory;
    assert.ok(undoId);
    const stored=JSON.parse(await fs.readFile(controller.file,"utf8"));
    assert.deepEqual(stored.records,[]);
    assert.equal(stored.omittedRecords,0);
    assert.equal(stored.favorites[0].record.id,previous[0]);
    assert.equal(net.scenario,rules);
    assert.equal(net.findRecord(previous[1]),undefined);
    importRows(net,[sample()]);
    const later=net.records[0].id;
    await controller.handle({type:"networkUndoClearTraffic",id:"outdated"});
    assert.deepEqual(net.records.map(row=>row.id),[later]);
    await controller.handle({type:"networkUndoClearTraffic",id:undoId});
    assert.deepEqual(net.records.map(row=>row.id),[...previous,later]);
    assert.equal(net.omittedRecords,4);
    assert.equal(net.snapshot().clearedHistory,undefined);
});

test("field actions preserve array index types and duplicate query positions, omitting redacted values",async()=>{
    const {fieldSeed,jsonFields,queryFields}=await loadWebview("networkFieldActions");
    const net=new NetworkSession();
    importRows(net,[sample()]);
    const row=net.records[0],seed=(target,path)=>fieldSeed(row,{target,ref:JSON.stringify(path)});
    assert.deepEqual(seed("responseJson",["prices",1]),{target:"responseJson",path:["prices",1],op:"set",value:12});
    assert.equal(seed("responseJson",["prices","1"]),undefined);
    assert.equal(seed("query",["tag",1]).value,"b");
    assert.equal(seed("query",["tag",1]).occurrence,1);
    assert.equal(seed("query",["token",0]),undefined);
    assert.equal(seed("requestHeader",["authorization"]),undefined);
    assert.equal(seed("responseJson",["error"]),undefined);
    assert.equal(seed("responseJson",["error","accessToken"]),undefined);
    assert.match(jsonFields(row,"responseJson",en=>en),/data-ref="\[&quot;error&quot;,&quot;retryAfter&quot;\]"/);
    assert.match(queryFields(row,en=>en),/data-ref="\[&quot;tag&quot;,1\]"/);
});
