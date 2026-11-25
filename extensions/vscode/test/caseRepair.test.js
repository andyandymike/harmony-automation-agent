"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {createServer} = require("node:http");
const {CaseRepair,sourceDigest,replaceAt,locatorPath,candidatesFor} = require("../src/caseRepair");
const {runView,pageView} = require("../src/model");
const {diagnoseCase} = require("../src/caseDiagnosis");
const {CaseLibrary} = require("../src/caseLibrary");
const {authoredDocument,compileCase,compositionRecord} = require("../src/caseComposition");
const {NetworkController} = require("../src/networkController");
const {localRequests} = require("../src/aiEvidence");
const {storePresentation,restorePresentation} = require("../src/casePresentation");
const loadWebview = require("../test-support/loadWebview");

const plan = {version:"1",preconditions:[{selector:{id:"cart"},property:"visible",equals:true}],
    steps:[{command:"press",input:{target:{id:"submit-old"}}}],
    goals:[{selector:{id:"message"},equals:"Paid"}]};
const receipt = {path:"steps[0]",kind:"command",command:"press",status:"failed",basisFrameId:"before",
    error:{code:"TARGET_NOT_FOUND",details:{selector:{id:"submit-old"}}}};
const report = {result:{status:"failed"},receipts:[receipt]};
const frozen = {frameId:"before",quality:{complete:true},nodes:[{ref:"@1",id:"submit-new",type:"Button",
    text:"Submit",visible:true,enabled:true,clickable:true}]};

test("a local repair in a composed case runs with its rule steps and applies without losing the reference", async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"case-repair-composed-"));
    const file=path.join(dir,"workflow.json"), sidecar=file+".harmony-case.json";
    t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:50}));
    const uri={scheme:"file",fsPath:file,toString:()=>file};
    const reference={useCase:{caseId:"preparation",name:"Prepare",digest:"pinned",
        plan:{version:"1",steps:[{assert:plan.preconditions[0]}]}}};
    const enable={ruleGroup:{action:"enable",scenario:{version:1,name:"Payment",rules:[]}}};
    const disable={ruleGroup:{action:"disable",name:"Payment"}};
    const authored={...plan,steps:[reference,enable,plan.steps[0],disable]};
    const compiled=compileCase(authored).plan;
    const display=storePresentation(authored,new Map([[authored.steps[2],{name:"Submit payment"}]]));
    const metadata={format:"harmony-agent.case",version:1,id:"composed",name:"Order",source:"workflow",
        composition:[compositionRecord(authored,compiled,display)]};
    await fs.writeFile(sidecar,JSON.stringify(metadata));
    const original=JSON.stringify(compiled);
    let contents=original;
    const doc={uri,getText:()=>contents,positionAt:n=>n,save:async()=>true};
    const workspaceState={saved:new Map(),get(key,fallback){return this.saved.get(key) ?? fallback;},
        async update(key,value){this.saved.set(key,structuredClone(value));}};
    class Edit {replace(_uri,range,text){Object.assign(this,{range,text});}}
    class Range {constructor(start,end){Object.assign(this,{start,end});}}
    const vscode={Uri:{parse:()=>uri},WorkspaceEdit:Edit,Range,workspace:{openTextDocument:async()=>doc,
        applyEdit:async e=>{contents=contents.slice(0,e.range.start)+e.text+contents.slice(e.range.end);return true;}}};
    const entry={id:"failure",device:"fixture",status:"failed",sourceDigest:sourceDigest(original),plan:{uri:file}};
    const run={...runView({result:{status:"failed"},receipts:[{...receipt,path:"steps[2]"}]}),entry};
    const trial={id:"trial",status:"completed",repairOf:entry.id,repairTarget:"steps[2]"};
    let repair;
    const b={language:"zh-CN",context:{workspaceState},networks:{bindings:{}},state:{device:"fixture",run,runs:[entry]},
        caseLibrary:new CaseLibrary(vscode,{workspaceState}),persistRuns:async()=>{},refreshCases:async()=>{},refreshPlanSummary:async()=>{},
        openReport:async()=>assert.fail("A trial should not open a report"),executePlan:async(_from,candidate)=>{
            assert.equal(contents,original);
            const draft=JSON.parse(candidate.contents);
            assert.deepEqual(draft.steps[2].input.target,{id:"submit-new"});
            assert.deepEqual(draft.steps[1],enable);
            assert.equal(draft.steps.length,3);
            assert.deepEqual(draft.goals,[]);
            assert.equal(candidate.bdd.steps.find(row=>row.reference)?.text,"Prepare");
            b.state.runs.unshift(trial);
            b.state.run={entry:{...trial,status:"running"},bdd:candidate.bdd,canStop:true,steps:[{path:"steps[2]",status:"running"}]};
            const presented=repair.reportState(b.state.run);
            assert.equal(presented.run,run);
            assert.equal(presented.repairProgress.id,trial.id);
            assert.equal(presented.repairProgress.step.label,"Submit payment");
            b.state.run={entry:trial,goalStatus:"not_requested",steps:[{path:"steps[2]",status:"completed"}]};
            return trial;
        }};
    repair=new CaseRepair(b,vscode);
    const {options}=await repair.prepare({run,step:run.steps[0],failure:{kind:"locator",index:0},
        page:pageView(frozen,{elements:true})});
    assert.equal(options[0].issue,undefined);
    await repair.propose(options[0]);
    await repair.verify({id:entry.id});
    assert.equal(b.state.run,run);
    assert.equal(repair.reportState(b.state.run).repairInProgress,undefined);
    assert.equal(b.state.repair.stage,"verified");
    assert.equal(b.state.repair.result.repaired.status,"completed");
    const originalReport=b.state.run;
    b.state.repair=undefined;
    repair=new CaseRepair(b,vscode);
    await repair.show(originalReport);
    assert.equal(b.state.repair.stage,"verified");
    await repair.apply({id:trial.id});
    assert.equal(b.state.repair.stage,"applied");
    const saved=JSON.parse(await fs.readFile(sidecar,"utf8"));
    const restored=authoredDocument({plan:JSON.parse(contents)},saved);
    assert.deepEqual(restored.plan.steps[0],reference);
    assert.deepEqual([restored.plan.steps[1],restored.plan.steps[3]],[enable,disable]);
    assert.equal(restored.presentation.get(restored.plan.steps[2]).name,"Submit payment");
    assert.deepEqual(restored.plan.steps[2].input.target,{id:"submit-new"});
    assert.ok(authoredDocument({plan:compiled},saved).authored);
});

test("a missing test upstream can be verified on an isolated route and saved after forwarding is observed", async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"case-repair-route-"));
    const server=createServer((_req,res)=>res.end("ok"));
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const upstream="http://127.0.0.1:"+server.address().port;
    const requestPath="/api/payment", uri="workflow", original=JSON.stringify(plan);
    const assertStep=record=>({path:"steps[0]",kind:"command",command:"press",
        startedAt:record.startedAt,at:new Date(Date.parse(record.startedAt)+record.durationMs).toISOString(),elapsedMs:record.durationMs});
    const entry={id:"failure",status:"failed",sourceDigest:sourceDigest(original),plan:{uri},device:"test-device"};
    const vscode={Uri:{parse:value=>value},workspace:{openTextDocument:async()=>({uri,getText:()=>original})}};
    const b={language:"zh-CN",storage:{fsPath:dir},config:{get:()=>undefined},
        context:{workspaceState:{get:(_key,fallback)=>fallback,update:async()=>{}}},
        state:{device:"test-device",devices:["test-device"],runs:[entry]},publish(){},
        persistRuns:async()=>{},refreshCases:async()=>{},refreshPlanSummary:async()=>{}};
    b.networks=new NetworkController(b,{},{connectPhone:async device=>({device,close:async()=>{}})});
    t.after(async()=>{
        await b.networks.close();
        await new Promise(resolve=>server.close(resolve));
        await fs.rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:50});
    });
    const {net}=b.networks;
    let scope=await b.networks.beginCaseRules(undefined,entry.id,{prepare:true});
    const failed=await fetch(net.baseUrl+requestPath);
    assert.equal(failed.status,404);
    await failed.arrayBuffer();
    await scope.close();
    const record=net.snapshot().records[0];
    assert.equal(record.caseRunId,entry.id);
    assert.equal(record.error,"NO_TEST_UPSTREAM");
    const from=Date.parse(record.startedAt);
    const evidence=await localRequests(b.networks,{start:from,end:from+1000},"errors",entry.id);
    assert.equal(evidence.records[0].gatewayIssue,"NO_TEST_UPSTREAM");
    const run={entry,steps:[{...assertStep(record),status:"failed",errorCode:"ASSERTION_TIMEOUT",actual:"404",expected:"200"}]};
    b.state.run=run;
    b.openReport=async()=>{b.state.run=run;};
    let forwarding=false,attempt=0;
    b.executePlan=async(_from,trial)=>{
        assert.deepEqual(JSON.parse(trial.contents),{...plan,goals:[]});
        assert.equal(trial.upstream,upstream);
        assert.equal(net.upstream,"");
        const result={id:"trial-"+(++attempt),status:"completed",repairOf:entry.id,repairTarget:trial.repairTarget};
        let proof=record;
        if (forwarding) {
            scope=await b.networks.beginCaseRules(undefined,result.id,{upstream:trial.upstream});
            try {
                const response=await fetch(net.baseUrl+requestPath);
                assert.equal(await response.text(),"ok");
                proof=net.snapshot().records.at(-1);
                assert.equal(proof.originalResponse.status,200);
                assert.equal(proof.caseRunId,result.id);
                assert.equal(net.upstream,"");
            } finally {await scope.close();}
        }
        b.state.runs.unshift(result);
        b.state.run={entry:result,goalStatus:"not_requested",steps:[{...assertStep(proof),status:"completed",assertionStatus:"passed"}]};
        return result;
    };
    const repair=new CaseRepair(b,vscode);
    await repair.show(run);
    assert.equal(b.state.repair.kind,"upstream");
    const {repairView}=await loadWebview("caseRepair");
    const button=(label,type)=>type+" "+label;
    assert.match(repairView(b.state,run,"zh-CN",button),/开发上游地址/);
    await repair.verify({id:entry.id,upstream});
    assert.equal(b.state.repair.stage,"failed");
    assert.equal(b.state.repair.verificationIssue,"upstreamNotObserved");
    await repair.apply({id:"trial-1"});
    assert.equal(net.upstream,"");
    forwarding=true;
    await repair.verify({id:entry.id,upstream});
    assert.equal(b.state.repair.stage,"verified");
    assert.match(repairView(b.state,run,"zh-CN",button),/保存测试上游/);
    assert.equal(net.upstream,"");
    await repair.apply({id:"trial-2"});
    assert.equal(b.state.repair.stage,"applied");
    assert.equal(net.upstream,upstream);
    assert.equal(JSON.parse(await fs.readFile(b.networks.file,"utf8")).upstream,upstream);
});

test("only the failing nested locator is replaced, including repeated text in a rule group and BOM/CRLF", () => {
    const file = {format:"harmony-agent.workflow-scenario",scenario:{name:'old "locator"',other:{id:"old"}},
        workflow:{steps:[{repeat:{steps:[{if:{},then:[{command:"press",input:{target:{id:"old"}}}]}]}}]}};
    const source = "\uFEFF" + JSON.stringify(file,null,2).replaceAll("\n","\r\n");
    const keys = locatorPath(file.workflow,{kind:"command",path:"steps[0].repeat.iteration[2][0].then[0]",locatorFailure:true});
    const edited = replaceAt(source,["workflow",...keys],{id:"new"});
    assert.equal(edited.slice(0,source.indexOf('"workflow"')),source.slice(0,source.indexOf('"workflow"')));
    assert.deepEqual(JSON.parse(edited.slice(1)).workflow.steps[0].repeat.steps[0].then[0].input.target,{id:"new"});
    assert.equal(locatorPath(plan,{path:"__proto__[0]",locatorFailure:true}),undefined);
});

test("a matched locator with an incorrect value and a partial observation cannot trigger a locator fix", () => {
    const business={path:"goals[0]",kind:"goal",status:"completed",result:{status:"failed",matches:1,
        selector:{id:"message"},property:"text",expected:"Paid",actual:"Cancelled"}};
    assert.equal(runView({receipts:[business]}).steps[0].locatorFailure,undefined);
    const page=pageView(frozen,{elements:true});
    assert.deepEqual(candidatesFor(page,{id:"submit-new"},"press"),[]);
    assert.deepEqual(candidatesFor({...page,complete:false},{id:"submit-old"},"press"),[]);
});

test("a repeat repair needs the original iteration and can be applied after a later failure in the loop", async () => {
    const step = {command:"press",input:{target:{id:"submit-new"}}};
    const loop = {repeat:{limit:3,until:plan.goals[0],steps:[plan.steps[0],{assert:plan.goals[0]}]}};
    const workflow = {...plan,steps:[loop,{command:"back"}]};
    const source = JSON.stringify(workflow);
    const candidate = structuredClone(workflow);
    candidate.steps[0].repeat.steps[0] = step;
    const path = "steps[0].repeat.iteration[1][0]";
    const entry = {id:"original",status:"failed",plan:{uri:"workflow"},sourceDigest:sourceDigest(source)};
    const originalRun = {entry,steps:[{path,status:"failed"}]};
    const v = {Uri:{parse:s=>s},workspace:{openTextDocument:async()=>({uri:"workflow",getText:()=>source})}};
    let fixed = false;
    const b = {state:{run:originalRun,device:"fixture",runs:[entry]},networks:{bindings:{}},
        executePlan:async (_,trial)=>{
            const bounded = JSON.parse(trial.contents);
            assert.deepEqual(bounded.steps,[candidate.steps[0]]);
            assert.deepEqual(bounded.goals,[]);
            assert.equal(trial.repairTarget,path);
            const trialEntry = {id:fixed?"fixed":"retry",status:"failed",repairOf:entry.id,repairTarget:path};
            b.state.runs.unshift(trialEntry);
            b.state.run = {entry:trialEntry,steps:[
                {path:"steps[0].repeat.iteration[0][0]",status:"completed"},
                {path,status:fixed?"completed":"failed"},
                ...(fixed ? [{path:"steps[0].repeat.iteration[1][1]",status:"failed"}] : []),
            ]};
            return trialEntry;
        }};
    const repair = new CaseRepair(b,v);
    await repair.propose({kind:"locator",original:entry,path:"steps[0].repeat.steps[0]",source,candidate:JSON.stringify(candidate)});
    await repair.verify({id:entry.id});
    assert.equal(b.state.repair.stage,"failed");
    fixed = true;
    await repair.verify({id:entry.id});
    assert.equal(b.state.repair.stage,"verified");
    assert.equal(b.state.repair.result.target.path,path);
    assert.equal(b.state.repair.result.failed.path,"steps[0].repeat.iteration[1][1]");
});

test("a starting or final assertion is verified only through the assertion that was repaired", async () => {
    for (const section of ["preconditions","goals"]) {
        const candidate = {...plan,[section]:[plan[section][0],{selector:{id:"later"},equals:"Later"}]};
        const source = JSON.stringify(candidate);
        const target = section+"[0]";
        const entry = {id:"original",plan:{uri:"workflow"},sourceDigest:sourceDigest(source)};
        const v = {Uri:{parse:s=>s},workspace:{openTextDocument:async()=>({uri:"workflow",getText:()=>source})}};
        const b = {state:{run:{entry},device:"fixture"},networks:{bindings:{}},
            executePlan:async (_,trial)=>{
                const limited = JSON.parse(trial.contents);
                assert.deepEqual(limited[section],[plan[section][0]]);
                if (section==="goals") assert.deepEqual(limited.steps,plan.steps);
                else {
                    assert.ok(limited.steps[0].stop);
                    assert.deepEqual(limited.goals,[]);
                }
                const result = {id:"trial",status:"passed",repairOf:entry.id,repairTarget:target};
                b.state.run = {entry:result,steps:[{path:target,status:"passed"}]};
                return result;
            }};
        const repair = new CaseRepair(b,v);
        await repair.propose({kind:"locator",original:entry,path:target,source,candidate:source});
        await repair.verify({id:entry.id});
        assert.equal(b.state.repair.stage,"verified");
    }
});

test("AI proposes one observed target, a failed trial stays unapplied, and a passing trial respects intervening source edits", async () => {
    const later = {assert:{selector:{id:"not-part-of-the-repair"},equals:"Different"}};
    const original=JSON.stringify({...plan,steps:[...plan.steps,later]},null,2);
    let contents=original, requested=0, passes=false, reached=true;
    const doc={uri:"workflow",getText:()=>contents,positionAt:n=>n,save:async()=>true};
    class Edit {replace(uri, range, text){ Object.assign(this,{uri,range,text}); }}
    class Range {constructor(start,end){Object.assign(this,{start,end});}}
    const vscode={Uri:{parse:s=>s},WorkspaceEdit:Edit,Range,workspace:{openTextDocument:async()=>doc,
        applyEdit:async e=>{ contents=contents.slice(0,e.range.start)+e.text+contents.slice(e.range.end);return true; }}};
    const entry={id:"failed",plan:{uri:"workflow"},sourceDigest:sourceDigest(original)};
    const originalRun={...runView(report),entry,selected:10};
    const b={language:"en",state:{device:"fixture",run:originalRun,runs:[entry]},networks:{bindings:{}},
        executePlan:async (from,trial)=>{
            assert.equal(from,true);
            const candidate=JSON.parse(trial.contents);
            assert.deepEqual(candidate.steps[0].input.target,{id:"submit-new"});
            assert.deepEqual(candidate.preconditions,plan.preconditions);
            assert.deepEqual(candidate.goals,[]);
            assert.equal(candidate.steps.length,1);
            assert.equal(contents,original);
            const trialEntry={id:passes?"passed":"attempt",status:passes?"completed":"failed",
                repairOf:entry.id,repairTarget:trial.repairTarget};
            b.state.runs=[trialEntry,...b.state.runs.filter(row=>row.id!==trialEntry.id)];
            b.state.run={entry:trialEntry,goalStatus:"not_requested",
                steps:reached?[{path:"steps[0]",status:passes?"completed":"failed"}]:[]};
            return trialEntry;
        }, persistRuns:async()=>{}, refreshCases:async()=>{}, refreshPlanSummary:async()=>{}};
    const repair=new CaseRepair(b,vscode);
    const input = {run:originalRun,failure:{kind:"locator",index:0},language:"en",onEvent:()=>{},
        prepare:input=>repair.prepare(input),agent:()=>({call:async command=>{assert.equal(command,"inspect");return frozen;}})};
    const backup = await diagnoseCase({...input,ask:async()=>{throw new Error("model unavailable");}});
    assert.equal(backup.fromSavedEvidence,true);
    assert.equal(backup.proposed.proposed.id,"submit-new");
    const analysis = await diagnoseCase({...input,
        ask:async prompt=>{
            requested++;
            const data=JSON.parse(prompt.split("\n").at(-1));
            assert.equal(data.options[0].proposed.id,"submit-new");
            return JSON.stringify({summary:"The saved page contains Submit with its new ID.",next:"Run a copy with the new locator.",
                recommendation:"verifyLocator",option:1,citations:["failure","page"]});
        }});
    repair.propose(analysis.proposed);
    assert.equal(requested,1);assert.equal(b.state.repair.stage,"proposed");
    await repair.verify({id:entry.id});
    await repair.apply({id:"attempt"});
    assert.equal(contents,original);assert.equal(b.state.repair.stage,"failed");
    b.state.run=originalRun;passes=true;reached=false;
    await repair.verify({id:entry.id});
    assert.equal(b.state.repair.stage,"failed");
    assert.equal(b.state.repair.notReached,true);
    await repair.apply({id:"passed"});
    assert.equal(contents,original);
    b.state.run=originalRun;reached=true;
    await repair.verify({id:entry.id});
    assert.equal(b.state.repair.stage,"verified");
    contents+=" ";
    await assert.rejects(repair.apply({id:"passed"}),/differs/);
    contents=original;
    await repair.apply({id:"passed"});
    assert.equal(b.state.repair.stage,"applied");assert.deepEqual(JSON.parse(contents).goals,plan.goals);
    assert.deepEqual(JSON.parse(contents).steps[1],later);
});

test("the original report shows trial progress and proof inline without report links", async ()=>{
    const {repairView}=await loadWebview("caseRepair");
    const run={entry:{id:"original"}};
    const model={devices:["test"],device:"test",repairProgress:{id:"trial",canStop:true,step:{label:"提交付款"}},
        repair:{id:"original",trial:"trial",kind:"locator",stepName:"发起首次付款",label:"提交付款",stage:"verifying",
            old:{id:"obsolete"},proposed:{text:"提交付款"}}};
    const button=(label,type,{attrs}={})=>`<button data-type="${type}" data-id="${attrs?.["data-id"]}">${label}</button>`;
    const working=repairView(model,run,"zh-CN",button);
    assert.match(working,/正在试跑[\s\S]*提交付款/);
    assert.match(working,/data-type="stopRun"[^>]*data-id="trial"/);
    model.repair.stage="failed";
    model.repair.result={status:"failed",goalStatus:"not_run",repaired:{label:"发起首次付款",status:"completed"},
        failed:{label:"检查付款结果",status:"failed",expected:"200",actual:"502"},
        request:{issue:"UPSTREAM_FAILED",method:"GET",path:"/api/payment",status:502}};
    const failed=repairView(model,run,"zh-CN",button);
    assert.match(failed,/修复步骤已执行。.*试跑停在「检查付款结果」。.*测试上游未响应。/);
    assert.match(failed,/<summary>试跑详情<\/summary>[\s\S]*实际[\s\S]*502/);
    assert.match(failed,/<details id="case-repair-change"[\s\S]*在用例编辑器中调整<\/button><\/div><\/details>/);
    assert.doesNotMatch(failed,/应用到用例|查看验证报告|查看原失败报告|data-type="report"/);
    model.repair.stage="verified";
    model.repair.result={status:"passed",goals:[{label:"付款正常",status:"passed"}]};
    const passed=repairView(model,run,"zh-CN",button);
    assert.match(passed,/试跑通过[\s\S]*应用到用例/);
    assert.match(passed,/付款正常[\s\S]*>通过</);
    assert.doesNotMatch(passed,/重新试跑|在用例编辑器中调整|data-type="report"/);
    model.repair.target="steps[1]";
    model.repair.result={status:"completed",goalStatus:"not_requested",target:{label:"发起首次付款",status:"completed"}};
    const focused=repairView(model,run,"zh-CN",button);
    assert.match(focused,/原失败步骤已通过。[\s\S]*应用到用例/);
    assert.doesNotMatch(focused,/最终断言通过/);
    const {caseHistoryEntries}=await loadWebview("caseLibrary");
    assert.deepEqual(caseHistoryEntries([{id:"trial",repairOf:"original"},run.entry,{id:"older",repairOf:"expired"}])
        .map(row=>row.id),["original","older"]);
});

test("waiting for an existing target requires a saved loading state and a same-version passing page", async () => {
    const navigation = {command:"open",input:{app:"fixture.shop"}};
    const workflow = {...plan,steps:[navigation,plan.steps[0]]};
    const source = JSON.stringify(workflow);
    const step = {...runView(report).steps[0],path:"steps[1]",dispatched:"no"};
    const previous = {path:"steps[0]",command:"open",status:"completed",dispatched:"acknowledged"};
    const entry = {id:"failed",plan:{uri:"file:///workflow.json"},sourceDigest:sourceDigest(source)};
    const run = {entry,steps:[previous,step]};
    const b = {state:{run},networks:{bindings:{}}};
    const v = {Uri:{parse:s=>s},workspace:{openTextDocument:async()=>({getText:()=>source,uri:entry.plan.uri})}};
    const repair = new CaseRepair(b,v);
    const loading = {ref:"@loading",id:"checkout.loading",type:"LoadingProgress",visible:true,bundleName:"fixture.shop",pagePath:"checkout"};
    const ready = {...frozen.nodes[0],id:"submit-old",bundleName:"fixture.shop",pagePath:"checkout"};
    const frame = nodes=>pageView({...frozen,nodes},{elements:true});
    const passing = {page:frame([ready]),sameVersion:true,sameRunner:true};
    const input = {run,step,previous,failure:{kind:"locator",index:1},page:frame([loading]),passing};
    assert.equal((await repair.prepare({...input,passing:{...passing,sameVersion:false}})).options.length,0);
    assert.equal((await repair.prepare({...input,page:frame([{...loading,pagePath:"sign-in"}])})).options.length,0);
    assert.equal((await repair.prepare({...input,page:frame([{...loading,type:"Text"}])})).options.length,0);
    const {options} = await repair.prepare(input);
    assert.deepEqual(options.map(option=>option.kind),["wait"]);
    const edited = JSON.parse(options[0].candidate);
    assert.deepEqual(edited.steps[0],{...navigation,input:{...navigation.input,
        expect:{selector:{id:"submit-old"},property:"visible",equals:true,timeoutMs:3000}}});
    assert.deepEqual(edited.steps[1],workflow.steps[1]);
    assert.deepEqual(edited.goals,workflow.goals);
});

test("a navigation repair inserts one observed same-app tap and verifies that the original step still ran", async () => {
    const open = {command:"open",input:{app:"fixture.shop"}};
    const workflow = {...plan,steps:[open,plan.steps[0],{command:"back",input:{}}]};
    const source = "\uFEFF"+JSON.stringify(workflow,null,2).replaceAll("\n","\r\n");
    const step = {...runView(report).steps[0],path:"steps[1]",dispatched:"no"};
    const previous = {path:"steps[0]",command:"open",status:"completed",dispatched:"acknowledged"};
    const entry = {id:"failed",plan:{uri:"file:///workflow.json"},sourceDigest:sourceDigest(source)};
    const run = {entry,steps:[previous,step]};
    const v = {Uri:{parse:s=>s},workspace:{openTextDocument:async()=>({getText:()=>source,uri:entry.plan.uri})}};
    const observed = {...frozen,nodes:[
        {...frozen.nodes[0],id:"review.continue",text:"Continue",bundleName:"fixture.shop",pagePath:"order-review"},
        {...frozen.nodes[0],ref:"@2",id:"os.continue",text:"Continue",bundleName:"fixture.os"},
    ]};
    let reachOriginal = false;
    const b = {state:{run,device:"fixture"},networks:{bindings:{}},
        executePlan:async (from,trial)=>{
            assert.equal(from,true);
            assert.equal(trial.repairOf,entry.id);
            const candidate = JSON.parse(trial.contents);
            assert.deepEqual(candidate.preconditions,plan.preconditions);
            assert.deepEqual(candidate.goals,[]);
            assert.deepEqual(candidate.steps.slice(2),[workflow.steps[1]]);
            const trialEntry = {id:"trial",status:"completed",repairOf:entry.id,repairTarget:trial.repairTarget};
            const steps = [{path:"steps[1]",status:"completed"}];
            if (reachOriginal) steps.push({path:"steps[2]",status:"completed"});
            b.state.run = {entry:trialEntry,steps,goalStatus:"not_requested"};
            return trialEntry;
        }};
    const repair = new CaseRepair(b,v);
    const request = {run,failure:{kind:"locator",index:1},language:"en",onEvent(){},agent:()=>({call:async()=>observed}),
        prepare:input=>repair.prepare(input)};
    const diagnosis = await diagnoseCase({...request,ask:async prompt=>{
        const {options} = JSON.parse(prompt.split("\n").at(-1));
        const nav = options.filter(option=>option.kind==="navigation");
        assert.equal(nav.length,1);
        assert.deepEqual(nav[0].proposed,{command:"press",target:{id:"review.continue",bundleName:"fixture.shop"}});
        return JSON.stringify({summary:"Review now precedes the submit page.",next:"Tap Continue before Submit.",
            recommendation:"verifyNavigation",option:nav[0].number,citations:["failure","page"]});
    }});
    const item = diagnosis.proposed;
    assert.equal(item.kind,"navigation");
    assert.match(item.candidate,/\r\n/);
    const metadata = storePresentation(workflow,new Map([[workflow.steps[1],{name:"Submit order"}],[workflow.steps[2],{name:"Return to cart"}]]));
    const revised = JSON.parse(item.candidate.slice(1));
    const titles = restorePresentation(revised,repair.presentation(item,metadata));
    assert.equal(titles.get(revised.steps[2]).name,"Submit order");
    assert.equal(titles.get(revised.steps[3]).name,"Return to cart");
    assert.equal(titles.has(revised.steps[1]),false);
    repair.propose(item);
    await repair.verify({id:entry.id});
    assert.equal(b.state.repair.stage,"failed");
    assert.equal(b.state.repair.notReached,true);
    b.state.run = run;
    reachOriginal = true;
    await repair.verify({id:entry.id});
    assert.equal(b.state.repair.stage,"verified");
});

test("a current-screen replacement can enter the editor when a legacy workflow has no starting condition", async () => {
    const target = {id:"cart.apply",bundleName:"fixture.shop"};
    const source = JSON.stringify({version:"1",steps:[{command:"press",input:{target}}]});
    const run = {...runView(report),entry:{id:"old-run",status:"failed",plan:{uri:"file:///workflow.json"},sourceDigest:sourceDigest(source)}};
    let draft;
    const b = {state:{run},networks:{bindings:{}},caseAuthoring:{beginRepair:async input=>{draft=input;}}};
    const v = {Uri:{parse:s=>s},workspace:{openTextDocument:async()=>({getText:()=>source,uri:run.entry.plan.uri})}};
    const repair = new CaseRepair(b,v);
    const diagnosis = await diagnoseCase({run,failure:{kind:"locator",index:0},onEvent(){},
        agent:()=>({call:async()=>undefined}),
        readLive:async()=>({...frozen,frameId:"now",nodes:[{...frozen.nodes[0],id:"promotion.confirm",
            text:"Use discount",bundleName:"fixture.shop"}]}),
        prepare:input=>repair.prepare(input),ask:async prompt=>{
            const {options,evidence} = JSON.parse(prompt.split("\n").at(-1));
            assert.equal(evidence.livePage.frameId,"now");
            assert.equal(options[0].canVerify,false);
            assert.equal(options[0].proposed.id,"promotion.confirm");
            return '{"summary":"The Apply Coupon control is now labeled Use discount.","next":"Use its new ID.",'+
                '"recommendation":"verifyLocator","option":1,"citations":["livePage"]}';
        }});
    repair.propose(diagnosis.proposed);
    await assert.rejects(repair.verify({id:run.entry.id}),/starting condition/);
    const {repairView} = await loadWebview("caseRepair");
    const view = repairView({...b.state,devices:[]},run,"en",(label,type)=>type+" "+label);
    assert.match(view,/repairDraft/);
    assert.doesNotMatch(view,/repairVerify/);
    await repair.stage({id:run.entry.id});
    assert.deepEqual(draft.plan.steps[0].input.target,{...target,id:"promotion.confirm"});
    assert.equal(draft.source,source);
    assert.equal(b.state.repair.stage,"proposed");
    draft.onSave();
    assert.equal(b.state.repair.stage,"draftSaved");
});
