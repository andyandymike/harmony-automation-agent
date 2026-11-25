"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os");
const {NetworkController}=require("../src/networkController");
const {NetworkSession,exampleScenario}=require("../src/network");
const {ScenarioLibrary}=require("../src/networkScenarioLibrary");

test("migrate old active workspace and keep independent scenes and pause state after reopening",async t=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),"ha-scenes-"));
    const state={mode:"network"};
    const bench={storage:{fsPath:folder},language:"en",state,context:{workspaceState:{get:(k,v)=>v}},publish(){},errorMessage:e=>e.message};
    const old={...exampleScenario(),name:"Checkout"};
    await fs.mkdir(path.join(folder,"network"));
    await fs.writeFile(path.join(folder,"network","evidence.json"),JSON.stringify({records:[],scenario:old}));
    let host=new NetworkController(bench,{});
    t.after(async()=>{await host.close();await fs.rm(folder,{recursive:true,force:true});});
    const send=(type,extra)=>host.handle({type,revision:type,...extra});
    await send("networkOpen");
    const original=state.network.activeScenarioId;
    assert.deepEqual(state.network.scenario,old);
    await send("networkScenarioDuplicate",{scenarioId:original,id:original,name:"Fault"});
    const copy=state.network.activeScenarioId;
    assert.notEqual(copy,original);
    await send("networkScenarioRename",{id:copy,name:"Degraded"});
    await send("networkScenarioPause",{id:copy,paused:true});
    assert.equal(state.network.scenario.paused,true);
    await send("networkScenarioSelect",{id:original});
    assert.deepEqual(state.network.scenario,old);
    await send("networkApply",{scenarioId:copy,scenarioVersion:state.network.scenarioVersion,scenario:{...old,name:"Wrong"}});
    assert.ok(state.network.scenarioReceipt.error);
    await host.close();
    host=new NetworkController(bench,{});
    await send("networkOpen");
    assert.equal(state.network.activeScenarioId,original);
    assert.deepEqual(state.network.scenarioLibrary.map(s=>[s.name,s.paused]),[["Checkout",false],["Degraded",true]]);
    await send("networkScenarioSelect",{id:copy});
    await send("networkScenarioDelete",{id:copy,scenarioId:copy});
    assert.equal(state.network.activeScenarioId,original);
    await send("networkScenarioCreate",{name:"Independent"});
    assert.equal(state.network.scenario.name,"Independent");
    assert.deepEqual(state.network.scenario.rules,[]);
});

test("pausing a live scenario preserves round-robin position and each rule's enabled state",async t=>{
    const net=new NetworkSession(),sc=exampleScenario();
    sc.rules.push({...sc.rules[0],id:"off",path:"/off",enabled:false});
    net.setScenario(sc);await net.start();
    t.after(()=>net.stop());
    const get=async url=>{const resp=await fetch(net.baseUrl+url);await resp.text();return resp.status;};
    assert.equal(await get("/items"),503);
    net.setScenarioPaused(true);assert.equal(await get("/items"),404);
    net.setScenarioPaused(false);assert.equal(await get("/items"),200);assert.equal(await get("/off"),404);
    assert.equal(net.snapshot().hits[0].count,2);
});

test("browsing and editing another rule group preserves active gateway rules and their position",async t=>{
    const folder=await fs.mkdtemp(path.join(os.tmpdir(),"ha-rule-groups-"));
    const state={mode:"network"};
    const bench={storage:{fsPath:folder},language:"en",state,context:{workspaceState:{get:(k,v)=>v}},publish(){},errorMessage:e=>e.message};
    const host=new NetworkController(bench,{});
    t.after(async()=>{await host.close();await fs.rm(folder,{recursive:true,force:true});});
    const send=(type,extra)=>host.handle({type,revision:type,...extra});
    const status=async()=>{
        const response=await fetch(host.net.baseUrl+"/items");
        await response.text();
        return response.status;
    };
    await send("networkOpen");
    await send("networkApply",{scenario:exampleScenario()});
    const active=state.network.activeScenarioId;
    await send("networkScenarioSelect",{id:active});
    await send("networkServer");
    assert.equal(await status(),503);
    await send("networkScenarioCreate",{name:"Alternate",browse:true});
    const viewed=state.network.viewedGroup.id;
    assert.notEqual(viewed,active);
    const captured=host.net.records[0];
    await send("networkFrom",{id:captured.id,scenarioId:viewed});
    const draft=state.networkDraft;
    assert.equal(draft.scenarioId,viewed);
    assert.equal(draft.scenario.name,"Alternate");
    assert.equal(draft.scenario.rules.length,1);
    assert.equal(state.network.viewedGroup.id,viewed);
    assert.equal(state.network.activeScenarioId,active);
    assert.deepEqual(state.network.scenarioLibrary.find(group=>group.id===active).ruleIds,["items"]);
    await send("networkScenarioBrowse",{id:active});
    assert.equal(state.network.viewedGroup,undefined);
    await send("networkScenarioBrowse",{id:viewed});
    await send("networkScenarioRename",{id:viewed,name:"Revised"});
    assert.equal(state.network.viewedGroup.scenario.name,"Revised");
    const rule=(id,code)=>({id,method:"GET",path:"/items",steps:[{response:{status:code}}]});
    const edit=(type,options)=>send(type,{
        scenarioId:viewed,scenarioVersion:state.network.viewedGroup.version,...options
    });
    await edit("networkUpsertRule",{rule:rule("Second",202),originalRule:null});
    await edit("networkUpsertRule",{rule:rule("First",201),originalRule:null});
    const originalRule=state.network.viewedGroup.scenario.rules.find(item=>item.id==="Second");
    assert.deepEqual(state.network.viewedGroup.scenario.rules.map(item=>item.id),["First","Second"]);
    await edit("networkRuleOrder",{id:"Second",direction:0,originalRule});
    assert.equal(state.network.operation.error,undefined);
    assert.deepEqual(state.network.viewedGroup.scenario.rules.map(item=>item.id),["Second","First"]);
    assert.equal(state.network.activeScenarioId,active);
    assert.equal(await status(),200);
    await send("networkScenarioSelect",{id:viewed});
    assert.equal(state.network.activeScenarioId,viewed);
    assert.equal(await status(),202);
});

test("a bound snapshot can be replayed repeatedly without replacing an edited workspace scenario",()=>{
    const original=exampleScenario(),lib=new ScenarioLibrary(undefined,original,"Untitled");
    const originId=lib.activeId;
    lib.entries.set(originId,{...lib.active,rules:[]});
    const restored=lib.forFlow(original), restoredId=lib.activeId;
    assert.notEqual(restoredId,originId);assert.equal(restored.rules.length,1);
    assert.equal(lib.forFlow(original).name,restored.name);
    assert.equal(lib.activeId,restoredId);assert.equal(lib.entries.size,2);assert.deepEqual(lib.select(originId).rules,[]);
});
