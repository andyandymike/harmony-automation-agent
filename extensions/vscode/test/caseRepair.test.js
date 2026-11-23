"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {CaseRepair,sourceDigest,replaceAt,locatorPath,candidatesFor} = require("../src/caseRepair");
const {runView,pageView} = require("../src/model");

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
    let contents=original, requested=0, passes=false;
    const doc={uri:"workflow",getText:()=>contents,positionAt:n=>n,save:async()=>true};
    class Edit {replace(uri, range, text){ Object.assign(this,{uri,range,text}); }}
    class Range {constructor(start,end){Object.assign(this,{start,end});}}
    const vscode={Uri:{parse:s=>s},WorkspaceEdit:Edit,Range,workspace:{openTextDocument:async()=>doc,
        applyEdit:async e=>{ contents=contents.slice(0,e.range.start)+e.text+contents.slice(e.range.end);return true; }}};
    const entry={id:"failed",plan:{uri:"workflow"},sourceDigest:sourceDigest(original)};
    const originalRun={...runView(report),entry};
    const b={language:"en",state:{device:"fixture",run:originalRun},networks:{bindings:{}},
        reportAgent:()=>({call:async cmd=>cmd==="report"?report:frozen}),
        modelAsk:async()=>async prompt=>{requested++; assert.match(prompt,/submit-new/);return '{"candidate":1}';},
        executePlan:async (from,trial)=>{
            assert.equal(from,true);
            const candidate=JSON.parse(trial.contents);
            assert.deepEqual(candidate.steps[0].input.target,{id:"submit-new"});
            assert.deepEqual(candidate.goals,plan.goals);
            assert.equal(contents,original);
            const trialEntry={id:passes?"passed":"attempt",status:passes?"passed":"failed",repairOf:entry.id};
            b.state.run={entry:trialEntry,goalStatus:trialEntry.status};return trialEntry;
        }, persistRuns:async()=>{}, refreshCases:async()=>{}, refreshPlanSummary:async()=>{}};
    const repair=new CaseRepair(b,vscode);
    await repair.suggest({id:entry.id});
    assert.equal(requested,1);assert.equal(b.state.repair.stage,"proposed");
    await repair.verify({id:entry.id});
    await repair.apply({id:"attempt"});
    assert.equal(contents,original);assert.equal(b.state.repair.stage,"failed");
    b.state.run=originalRun;passes=true;
    await repair.verify({id:entry.id});
    assert.equal(b.state.repair.stage,"verified");
    contents+=" ";
    await assert.rejects(repair.apply({id:"passed"}),/differs/);
    contents=original;
    await repair.apply({id:"passed"});
    assert.equal(b.state.repair.stage,"applied");assert.deepEqual(JSON.parse(contents).goals,plan.goals);
});
