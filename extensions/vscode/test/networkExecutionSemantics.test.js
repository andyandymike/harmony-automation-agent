"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
const {NetworkController}=require("../src/networkController");
const {NetworkSession,scenarioFromRecord,exampleScenario}=require("../src/network");
const {workflowWithScenario,readWorkflow}=require("../src/workflowFile");
const {reverseFixture}=require("../src/deviceNetwork");
const load=require("../test-support/loadWebview");

function localRule(id,field,value,status=201){
    return {id,method:"GET",match:{field,type:"exact",value},action:"local",response:{status,headers:{},body:"ok"}};
}
async function controller(t,vscode={},options,{withGroup=true}={}){
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ha-rule-execution-")), values=new Map();
    const bench={storage:{fsPath:dir},state:{mode:"network"},language:"en",publish(){},errorMessage:e=>e.message,
        text:{chooseSavedPlan:"Select workflow",planFileInvalid:"Invalid workflow"},
        context:{workspaceState:{get:(k,d)=>values.get(k)??d,update:async(k,v)=>values.set(k,v)}}};
    const host=new NetworkController(bench,vscode,options);
    await host.init();
    if (withGroup) {
        await host.handle({type:"networkApply",scenario:exampleScenario()});
        await host.handle({type:"networkScenarioSelect",id:host.activeScenarioId});
    }
    t.after(async()=>{await host.close();await fs.rm(dir,{force:true,recursive:true});});
    return host;
}
function mappedPhones(){
    const online=new Set(["A","B"]), routes=new Map(), removed=[], refuse=new Set();
    const connectPhone=(device,_hdc,url)=>reverseFixture(device,undefined,url,18990,async args=>{
        if(!online.has(device))throw Error("device offline");
        if(args[0]==="fport"&&args[1]==="ls")return routes.has(device)?device+" tcp:18990 "+routes.get(device)+" [Reverse]":"";
        if(args[0]==="rport"){if(refuse.has(device))throw Error("mapping refused");routes.set(device,args[2]);return "";}
        assert.deepEqual(args,["fport","rm","tcp:18990",routes.get(device)]);
        removed.push(device);routes.delete(device);return "";
    });
    return {online,routes,refuse,removed,connectPhone};
}
async function useDevice(host,phones,device){
    host.bench.config={get:()=>undefined};
    host.bench.state.device=device;
    host.bench.state.devices=[...phones.online];
    await host.devicesChanged(host.bench.state.devices);
}
test("the gateway only uses a group on explicit request and restores manual rules after each case",async t=>{
    const phones=mappedPhones(),host=await controller(t,{},phones,{withGroup:false});
    await useDevice(host,phones,"A");
    const state=host.bench.state;
    assert.deepEqual(state.network.scenarioLibrary,[]);
    assert.equal(state.network.rulesEnabled,false);
    await host.handle({type:"networkUpsertRule",originalRule:null,newGroupName:"Manual",rule:exampleScenario().rules[0]});
    assert.equal(state.network.operation.error,undefined);
    assert.equal(state.network.scenarioLibrary[0].name,"Manual");
    assert.equal(state.network.rulesEnabled,false);
    await host.handle({type:"networkServer"});
    const status=async()=>{
        const response=await fetch(host.net.baseUrl+"/items");
        await response.text();
        return response.status;
    };
    assert.equal(await status(),404);
    await host.handle({type:"networkScenarioSelect",id:host.activeScenarioId});
    assert.equal(await status(),503);

    const group={version:1,name:"Only for checkout",rules:[localRule("case","path","/items",409)]};
    const release=await host.beginCaseRules(group);
    try {
        assert.equal(await status(),409);
        assert.deepEqual(state.network.caseRules.names,[group.name]);
        assert.equal(state.network.hits[0].count,1);
        assert.deepEqual(state.network.scenarioLibrary.map(item=>item.name),["Manual"]);
    } finally { await release.close(); }
    const releaseWithoutRules=await host.beginCaseRules();
    try { assert.equal(await status(),404); }
    finally { await releaseWithoutRules.close(); }
    assert.equal(await status(),200);
    await host.handle({type:"networkManualRulesOff"});
    assert.equal(await status(),404);

    await host.handle({type:"networkServer"});
    const caseOnly=await host.beginCaseRules(undefined,undefined,{prepare:true});
    try {
        assert.equal(await status(),404);
        const sequence={...group,rules:[{id:"shared",method:"GET",path:"/items",steps:[
            {response:{status:409}},{response:{status:201}},
        ]}]};
        const overlap={version:1,name:"Rate limit",rules:[{id:"shared",method:"GET",path:"/items",steps:[{response:{status:429}}]}]};
        caseOnly.apply({action:"enable",scenario:sequence});
        assert.equal(await status(),409);
        caseOnly.apply({action:"enable",scenario:overlap});
        assert.deepEqual(state.network.caseRules.names,[group.name,overlap.name]);
        assert.equal(await status(),429);
        const revised={...sequence,rules:[{...sequence.rules[0],steps:[{response:{status:418}}]}]};
        caseOnly.apply({action:"enable",scenario:revised});
        assert.deepEqual(state.network.caseRules.names,[sequence.name,overlap.name]);
        assert.equal(await status(),429);
        caseOnly.apply({action:"disable",name:"Unrelated"});
        assert.equal(await status(),429);
        caseOnly.apply({action:"disable",name:overlap.name});
        assert.equal(await status(),201);
        caseOnly.apply({action:"enable",scenario:overlap});
        caseOnly.apply({action:"disable"});
        assert.equal(await status(),201);
        caseOnly.apply({action:"disable",name:sequence.name});
        assert.equal(await status(),404);
        caseOnly.apply({action:"enable",scenario:revised});
        assert.equal(await status(),418);
    } finally { await caseOnly.close(); }
    assert.equal(host.net.baseUrl,undefined);
    assert.equal(state.network.rulesEnabled,false);
    assert.deepEqual(state.network.scenarioLibrary.map(item=>item.name),["Manual"]);
});

test("preparing B after A disconnects switches the mapping and releases the owned A pair only after A reconnects",async t=>{
    const phones=mappedPhones(),host=await controller(t,{},phones);
    await useDevice(host,phones,"A");
    await host.prepareFlow({uri:"flow"},exampleScenario());
    assert.equal(host.bench.state.network.mappedDevice,"A");
    phones.online.delete("A");
    await useDevice(host,phones,"B");
    assert.equal(host.bench.state.network.mapping,undefined);assert.deepEqual(host.bench.state.network.pendingMappingCleanup,["A"]);
    await host.prepareFlow({uri:"flow"},{...exampleScenario(),name:"B run"});
    assert.equal(host.bench.state.network.mappedDevice,"B");assert.equal(phones.routes.size,2);
    await host.handle({type:"networkTry",id:"items"});assert.equal(host.bench.state.network.sequenceTest.status,503);
    phones.online.add("A");await useDevice(host,phones,"B");
    assert.deepEqual(phones.removed,["A"]);assert.deepEqual([...phones.routes.keys()],["B"]);
    const {pendingMappingCleanup,mappedDevice,scenario}=host.bench.state.network;
    assert.deepEqual(pendingMappingCleanup,[]);assert.equal(mappedDevice,"B");assert.equal(scenario.name,"B run");
});
test("failure to map B retains A and its sequence counts; a route replaced by another tool is never removed",async t=>{
    const phones=mappedPhones(),host=await controller(t,{},phones);
    await useDevice(host,phones,"A");await host.prepareFlow({uri:"flow"},exampleScenario());
    const group=host.activeScenarioId,url=host.net.baseUrl;
    await host.handle({type:"networkTry",id:"items"});
    await useDevice(host,phones,"B");phones.refuse.add("B");
    const id="failed-run";
    const runFile=path.join(path.dirname(host.file),"scenarios",id+".json");
    await assert.rejects(host.prepareFlow({uri:"flow"},{...exampleScenario(),name:"B run"},id),/mapping refused/);
    await assert.rejects(fs.stat(runFile),{code:"ENOENT"});
    assert.equal(host.bench.state.network.mappedDevice,"A");assert.equal(host.activeScenarioId,group);
    assert.equal(host.net.baseUrl,url);assert.equal(host.net.snapshot().hits[0].count,1);
    phones.online.delete("A");await useDevice(host,phones,"B");await host.handle({type:"networkServer"});
    assert.equal(host.bench.state.network.running,false);assert.equal(host.bench.state.network.mapping,undefined);
    assert.deepEqual(host.bench.state.network.pendingMappingCleanup,["A"]);
    phones.routes.set("A","tcp:54321");phones.online.add("A");await useDevice(host,phones,"B");
    assert.deepEqual(phones.removed,[]);assert.equal(phones.routes.get("A"),"tcp:54321");assert.equal(host.bench.state.network.mapping,undefined);
});
test("a captured request can start a stopped gateway and resend without a connected phone",async t=>{
    const host=await controller(t),model=host.bench.state,ui=await load("networkStudio"),sent=[];
    const sample={id:"offline",method:"GET",path:"/items",status:200,request:{method:"GET",url:"https://capture.invalid/items",headers:{}},response:{status:200,headers:{}}};
    host.net.append([sample]);model.devices=[];
    ui.openStudio("resend",model.network,sample);const before=ui.studioView(model,x=>x);
    assert.match(before,/data-net="studio-server"[^>]*>Start gateway/);
    assert.match(before,/data-net="studio-send"[^>]*disabled/);
    const click=id=>ui.studioClick({dataset:{net:"studio-"+id}},model,m=>sent.push(m),()=>{});
    click("server");await host.handle(sent.pop());assert.ok(host.net.baseUrl);
    assert.doesNotMatch(ui.studioView(model,x=>x),/data-net="studio-send"[^>]*disabled/);
    click("send");await host.handle(sent.pop());const result=host.net.records.at(-1);
    assert.equal(result.replayOf,sample.id);assert.equal(result.status,503);assert.equal(host.mapping,undefined);
    const receipt=ui.studioView(model,x=>x);assert.match(receipt,/HTTP 503/);assert.match(receipt,/Compare with original/);
});
test("history and gateway use their own origins, and gateway preview applies actual group order and eligibility",async t=>{
    const net=new NetworkSession();
    t.after(()=>net.stop());
    const origin=await net.start();
    const captured="https://capture.example.test/items?part=1", relative="/items?part=1";
    net.importHar({log:{entries:[{startedDateTime:"2026-11-01T00:00:00Z",request:{method:"GET",url:captured,headers:[]},
        response:{status:200,headers:[],content:{mimeType:"application/json",text:"{}"}}}]}});
    const record=net.records[0], remote=localRule("remote","url",captured);
    let p=net.previewRule(remote,undefined,record.id);
    assert.deepEqual(p.matchedIds,[record.id]);assert.equal(p.examples[0].route.url,origin+relative);
    assert.deepEqual([p.gateway.gatewayMatches,p.gateway.applicable,p.examples[0].route.winner],[0,0,"items"]);
    const upstream="http://127.0.0.1:38199";
    net.setUpstream(upstream);
    const local=localRule("local","url",upstream+relative), first=localRule("first","path","/items",202);
    net.setScenario({version:1,name:"Routes",rules:[first,local]});
    p=net.previewRule(local,undefined,record.id);
    assert.deepEqual(p.matchedIds,[]);assert.equal(p.gateway.gatewayMatches,1);assert.equal(p.gateway.applicable,0);
    assert.equal(p.examples[0].route.winner,"first");
    const actual=await net.replay({method:"GET",path:relative,headers:{}});
    assert.deepEqual([actual.ruleId,actual.status],["first",202]);
    net.moveRule("local","up");
    assert.equal(net.previewRule(local,[record]).gateway.applicable,1);
    assert.equal(net.previewRule({...local,enabled:false},[record]).gateway.applicable,0);
    net.setScenarioPaused(true);
    p=net.previewRule(local,[record]);assert.equal(p.gateway.paused,true);assert.equal(p.gateway.applicable,0);
    assert.equal(p.examples[0].route.winner,undefined);
    assert.equal(net.snapshot().hits.find(h=>h.ruleId==="local").count,0);
});
test("response sequences derived from evidence preserve JSON scalars and bodyless HTTP and reject missing or redacted responses",()=>{
    const record={method:"GET",path:"/cart",status:203,response:{bodyState:"json",body:false}};
    const response=r=>scenarioFromRecord(r).rules[0].steps[0].response;
    assert.deepEqual(response(record),{status:203,json:false});
    assert.deepEqual(response({...record,status:204,response:{}}),{status:204});
    assert.deepEqual(response({...record,method:"HEAD",response:{}}),{status:203});
    assert.throws(()=>response({...record,status:0}),/status/);
    for(const bodyState of ["unavailable","omitted","form","tooLarge"])assert.throws(()=>response({...record,response:{bodyState}}),/JSON/);
    assert.throws(()=>response({...record,response:{bodyState:"json",body:{token:"[redacted]"}}}),/JSON/);
});
test("a failed capture never prepopulates HTTP 200 in a local response rule",async()=>{
    const record={id:"failed",method:"GET",path:"/no-reply",status:0,request:{method:"GET",url:"https://capture.example/no-reply",headers:{}},
        response:{status:0,bodyState:"unavailable",headers:{}}};
    const network={activeScenarioId:"group",scenario:exampleScenario(),records:[record],hits:[]};
    const view=await load("networkStudio"),m={network};
    view.openStudio("rule",network,record);
    view.studioInput({dataset:{ns:"action"},value:"local"},()=>{});
    const html=view.studioView(m,x=>x);
    assert.match(html,/No usable HTTP response was captured/);
    assert.match(html,/id="ns-responseStatus"[^>]*value=""/);
    let sent;
    view.studioClick({dataset:{net:"studio-apply"}},m,value=>{sent=value;},()=>{});
    assert.equal(sent,undefined);assert.match(view.studioView(m,x=>x),/status from 200 to 599/);
});
test("testing a sequence records and links the real winning rule and leaves the shadowed sequence untouched",async t=>{
    const host=await controller(t), model=host.bench.state, view=await load("networkScenarios");
    host.net.upsertRule(localRule("earlier","path","/items",202));
    await host.net.start();await host.handle({type:"networkTry",id:"items",scenarioId:host.activeScenarioId});
    let receipt=model.network.sequenceTest;
    assert.equal(receipt.status,202);assert.equal(receipt.winner,"earlier");assert.equal(receipt.matched,false);
    const record=host.net.findRecord(receipt.recordId);assert.equal(record.testedRuleId,"items");assert.equal(record.replayed,undefined);
    assert.equal(model.network.hits.find(h=>h.ruleId==="items").count,0);
    const html=view.scenarioView(model,x=>x);
    assert.match(html,/This sequence did not advance/);
    assert.ok(html.includes('data-net="openExchange" data-id="'+record.id+'"'));
    host.net.removeRule("earlier");await host.handle({type:"networkTry",id:"items"});
    receipt=model.network.sequenceTest;assert.deepEqual([receipt.winner,receipt.matched,receipt.status,receipt.hit],["items",true,503,1]);
});
test("mapping preparation failure restores stopped/running state, preserves rule group, counts and bindings",async t=>{
    const host=await controller(t), original=host.activeScenarioId;
    const group={...exampleScenario(),name:"Embedded"};host.mapDevice=async()=>{throw Error("fixture mapping unavailable");};
    await assert.rejects(host.prepareFlow({uri:"flow"},group),/mapping unavailable/);
    assert.equal(host.net.baseUrl,undefined);assert.equal(host.activeScenarioId,original);assert.equal(host.library.entries.size,1);
    const url=await host.net.start();
    await host.handle({type:"networkTry",id:"items"});
    await assert.rejects(host.prepareFlow({uri:"flow"},group),/mapping unavailable/);
    assert.equal(host.net.baseUrl,url);assert.equal(host.activeScenarioId,original);assert.equal(host.net.snapshot().hits[0].count,1);
});
test("checking rules previews only the last rule, without executing it or opening its editor",async t=>{
    const host=await controller(t), model=host.bench.state;
    const view=await load("networkScenarios"),{listSelectionClick,listSelectionChange}=await load("ui/listSelection");
    const local=localRule("local","path","/items",418), sc=exampleScenario();
    const sequence=sc.rules[0];
    model.network.scenario={...sc,rules:[local,sequence]};
    const render=()=>view.scenarioView(model,en=>en);
    global.document={querySelector:()=>null}; t.after(()=>{delete global.document;});
    render();
    listSelectionClick({dataset:{listName:"network-rules",listAction:"start"}},()=>assert.fail(),render);
    const check=(value,checked)=>listSelectionChange({dataset:{listPick:"network-rules"},value,checked},render);
    check("local",true);
    assert.match(render(),/sc-rule-effects[^]*?HTTP 418/);
    check(sequence.id,true);
    assert.match(render(),/<details class="sc-response-preview"[^>]* open>/);
    assert.doesNotMatch(render(),/sc-rule-effects|id="ns-enabled"|id="net-draft"|data-net="try"/);
    check(sequence.id,false);
    assert.match(render(),/sc-rule-effects[^]*?HTTP 418/);
    assert.doesNotMatch(render(),/sc-response-preview/);
});

test("embedded workflow wins over stale bindings; export explicitly chooses between effective and current snapshots",async t=>{
    const plan={steps:[{command:"back"}]}, embedded={...exampleScenario(),name:"Embedded"};
    const bound={...exampleScenario(),name:"Binding"};
    let file=JSON.stringify(plan),choose=0,written,offered,saveCalls=0;
    const vscode={Uri:{parse:x=>x},workspace:{openTextDocument:async()=>({getText:()=>file}),fs:{writeFile:async(_uri,bytes)=>{written=JSON.parse(bytes);}}},
        window:{showQuickPick:async choices=>{offered=choices;return choices[choose];},showSaveDialog:async()=>{saveCalls++;return "out";}}};
    const host=await controller(t,vscode), model=host.bench.state;
    model.plan={uri:"flow",name:"case.json"};
    host.net.setScenario(bound);await host.handle({type:"networkBind"});
    host.net.setScenario({...exampleScenario(),name:"Current"});
    file=JSON.stringify(workflowWithScenario(plan,embedded));model.planSummary={scenarioName:"Embedded"};
    await assert.rejects(host.handle({type:"networkBind"}),/embedded/);
    const view=await load("networkScenarios"), html=view.scenarioView(model,x=>x);
    assert.match(html,/data-net="saveCase"/);assert.doesNotMatch(html,/data-net="bind"|sc-workflow/);
    await host.handle({type:"networkSaveCase"});assert.equal(written.scenario.name,"Embedded");assert.equal(offered[0].value.name,"Embedded");
    choose=1;await host.handle({type:"networkSaveCase"});assert.equal(written.scenario.name,"Current");
    const reopened=readWorkflow(JSON.stringify(written)),phones=mappedPhones(),other=await controller(t,{},phones);
    await useDevice(other,phones,"B");await other.prepareFlow({uri:"copied"},reopened.scenario);
    assert.equal(other.net.scenario.name,"Current");assert.equal(other.mapping.device,"B");
    assert.deepEqual(reopened.plan,plan);
    assert.equal((await other.net.testSequence(other.net.scenario.rules[0])).status,503);
    choose=-1;await host.handle({type:"networkSaveCase"});assert.equal(saveCalls,2);
    file=JSON.stringify(plan);choose=0;await host.handle({type:"networkSaveCase"});assert.equal(written.scenario.name,"Binding");
    assert.throws(()=>readWorkflow(JSON.stringify({...workflowWithScenario(plan,embedded),scenario:undefined})),/version 1/);
});
