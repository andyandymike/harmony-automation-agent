"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {CaseRepair,sourceDigest,replaceAt,locatorPath,candidatesFor} = require("../src/caseRepair");
const {runView,pageView} = require("../src/model");
const {diagnoseCase} = require("../src/caseDiagnosis");
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

test("AI proposes one observed target, a failed trial stays unapplied, and a passing trial respects intervening source edits", async () => {
    const original=JSON.stringify(plan,null,2);
    let contents=original, requested=0, passes=false, reached=true;
    const doc={uri:"workflow",getText:()=>contents,positionAt:n=>n,save:async()=>true};
    class Edit {replace(uri, range, text){ Object.assign(this,{uri,range,text}); }}
    class Range {constructor(start,end){Object.assign(this,{start,end});}}
    const vscode={Uri:{parse:s=>s},WorkspaceEdit:Edit,Range,workspace:{openTextDocument:async()=>doc,
        applyEdit:async e=>{ contents=contents.slice(0,e.range.start)+e.text+contents.slice(e.range.end);return true; }}};
    const entry={id:"failed",plan:{uri:"workflow"},sourceDigest:sourceDigest(original)};
    const originalRun={...runView(report),entry,selected:10};
    const b={language:"en",state:{device:"fixture",run:originalRun},networks:{bindings:{}},
        executePlan:async (from,trial)=>{
            assert.equal(from,true);
            const candidate=JSON.parse(trial.contents);
            assert.deepEqual(candidate.steps[0].input.target,{id:"submit-new"});
            assert.deepEqual(candidate.goals,plan.goals);
            assert.equal(contents,original);
            const trialEntry={id:passes?"passed":"attempt",status:passes?"passed":"failed",repairOf:entry.id};
            b.state.run={entry:trialEntry,goalStatus:trialEntry.status,
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
            const candidate = JSON.parse(trial.contents.slice(1));
            assert.deepEqual(candidate.preconditions,plan.preconditions);
            assert.deepEqual(candidate.goals,plan.goals);
            assert.deepEqual(candidate.steps.slice(2),workflow.steps.slice(1));
            const trialEntry = {id:"trial",status:"passed",repairOf:entry.id};
            const steps = [{path:"steps[1]",status:"completed"}];
            if (reachOriginal) steps.push({path:"steps[2]",status:"completed"});
            b.state.run = {entry:trialEntry,steps,goalStatus:"passed"};
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

test("a current-screen replacement can enter the editor when a legacy workflow has no final assertion", async () => {
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
    await assert.rejects(repair.verify({id:run.entry.id}),/final assertion/);
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
