"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {NetworkController} = require("../src/networkController");
const {NetworkSession} = require("../src/network");
const loadWebview = require("../test-support/loadWebview");

const start = Date.parse("2026-11-22T10:00:00Z");
const entry = (suffix,time=start) => ({startedDateTime:new Date(time).toISOString(),time:15,
    request:{method:"GET",url:"https://shop.test/"+suffix},
    response:{status:503,content:{mimeType:"application/json",text:'{"retry":true}'}}});

test("imports identify individual files, including zero rows, and keep return to the original step",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"network-receipts-"));
    let file, entries;
    const bench={state:{mode:"network"},storage:{fsPath:dir},language:"en",
        context:{workspaceState:{get:(_key,fallback)=>fallback}},publish(){},errorMessage:e=>e.message};
    const vscode={window:{showOpenDialog:async()=>[{fsPath:file}]},
        workspace:{openTextDocument:async()=>({getText:()=>JSON.stringify({log:{entries}})})}};
    const controller=new NetworkController(bench,vscode);
    t.after(async()=>{await controller.close();await fs.rm(dir,{recursive:true,force:true});});
    for(const name of ["first.har","second.har","empty.har"]) {
        file=path.join(dir,name);entries=name==="empty.har"?[]:[entry("checkout")];
        await controller.handle({type:"networkImportHar"});
        assert.equal(bench.state.network.lastImport.batch.label,name);
        assert.equal(bench.state.network.lastImport.count,entries.length);
    }
    const [first,second]=bench.state.network.records;
    assert.notEqual(first.batch.id,second.batch.id);
    await controller.handle({type:"networkSaveFavorite",id:first.id});
    await controller.handle({type:"networkDeleteCapture",id:first.id});
    const receipt={path:"steps[1]",at:new Date(start+10).toISOString(),elapsedMs:10};
    bench.state.run={selected:0,steps:[receipt]};
    await controller.handle({type:"networkStep"});
    const evidence=await controller.evidenceForStep("run",receipt.path,receipt);
    assert.deepEqual(new Set(evidence.records.map(r=>r.id)),new Set([first.id,second.id]));
    await controller.handle({type:"networkAll"});
    assert.equal(bench.state.network.stepLabel,undefined);
    assert.equal(bench.state.network.originStep,receipt.path);
    assert.equal(bench.state.network.returnTo,"run");
    await controller.handle({type:"networkOpen"});
    assert.equal(bench.state.network.returnTo,undefined);
    await controller.persist();
    const saved=JSON.parse(await fs.readFile(controller.file,"utf8"));
    assert.equal(saved.lastImport.batch.label,"empty.har");
    assert.equal(saved.favorites[0].record.batch.label,"first.har");
});

test("an exploration receipt opens offline and an unavailable old report retains its return path",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"network-step-"));
    const receipt={at:new Date(start+40).toISOString(),elapsedMs:40};
    const step={id:"open",label:"Open cart",runId:"run",receipts:[receipt,{}]};
    let reads=0;
    const bench={state:{mode:"exploration",exploration:{steps:[step]}},storage:{fsPath:dir},language:"en",
        explorations:{reportAgent:()=>({call:async()=>{reads++;throw new Error("Saved report unavailable");}})},
        context:{workspaceState:{get:(_key,fallback)=>fallback}},publish(){},errorMessage:e=>e.message};
    const controller=new NetworkController(bench,{});
    t.after(async()=>{await controller.close();await fs.rm(dir,{recursive:true,force:true});});
    await controller.handle({type:"networkExplorationStep",id:"open",index:0});
    assert.equal(reads,0);
    assert.deepEqual(bench.state.network.range,{start,end:start+40});
    await controller.handle({type:"networkExplorationStep",id:"open",index:1});
    assert.equal(reads,1);
    assert.equal(bench.state.network.range,undefined);
    assert.equal(bench.state.error,"Saved report unavailable");
    assert.equal(bench.state.network.originStep,"Open cart");
    assert.equal(bench.state.network.returnTo,"exploration");
});

test("a capture can open from a filtered favorite and return; comparisons can use an archived original",async()=>{
    const session=new NetworkSession();
    session.importHar({log:{entries:[entry("archived")]}});
    const original=session.records[0];
    session.collection.save(original);
    session.removeRecord(original.id);
    session.importHar({log:{entries:[entry("retry",start+9000)]}},{source:"device",batch:{id:"capture-one",label:"debug app"}});
    const retry=session.records[0];retry.replayOf=original.id;
    const n={...session.snapshot(),logs:[],markers:[],filterVersion:"evidence-flow",stepLabel:"steps[1]",
        returnTo:"run",range:{start,end:start+100},scenarioLibrary:[]};
    const view=await loadWebview("networkView"), messages=[];
    const model={devices:[],network:n};
    const render=()=>view.networkView(model,"en");
    const click=(net,id)=>{view.networkClick({dataset:{net,id}},model,m=>messages.push(m),render);return render();};
    assert.match(render(),new RegExp('data-id="'+original.id+'" aria-selected="true"'));
    click("favoritesOnly");
    view.networkInput({id:"net-filter",dataset:{},value:"archived"},render);
    const batch=click("captureResults","capture-one");
    assert.match(batch,/Requests in this batch/);
    assert.match(batch,new RegExp('data-id="'+retry.id+'" aria-selected="true"'));
    const prior=click("previousList");
    assert.match(prior,/Saved requests/);
    assert.match(prior,/steps\[1\]/);
    assert.match(prior,/value="archived"/);
    assert.match(prior,new RegExp('data-id="'+original.id+'" aria-selected="true"'));
    assert.deepEqual(messages,[]);
    assert.doesNotMatch(prior,/net-baseline|data-id="compare"/);
    click("compareReplay",retry.id);
    assert.equal(messages.at(-1).type,"networkAll");
    n.stepLabel=n.range=undefined;n.originStep="steps[1]";
    const diff=render();
    const compared=Array.from(diff.matchAll(/data-comparison-id="([^"]+)"/g),match=>match[1]);
    assert.deepEqual(compared,[original.id,retry.id]);
    assert.match(diff,/data-net="backrun"/);
    const closed=click("closeComparison");
    assert.match(closed,new RegExp('data-net="openExchange" data-id="'+original.id+'"'));
    n.webStatus={batch:{id:"web",label:"Sample"},reason:"page-changed"};
    assert.match(render(),/page changed site/);
});
