"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {stageBranchDifference} = require("../src/explorationCaseEdit");
const {caseRoutes} = require("../src/explorationCases");
const {CaseCompositionEditor} = require("../src/caseCompositionEditor");
const {sourceDigest} = require("../src/caseRepair");
const {compileCase,signature} = require("../src/caseComposition");

const press = text=>({command:"press",input:{target:{text}}});
const goal = {selector:{id:"current-language"},property:"text",equals:"English"};

function fixture(strategy="replace", version="1") {
    const plan = {version,steps:[press("Language"),{command:"back",input:{expect:goal}}],goals:[goal]};
    const original=JSON.stringify(plan);
    const uri="file:///test/workflow.json";
    const choice={strategy,step:press(strategy==="replace"?"Cancel":"Details")};
    const report={id:"session",mode:"flow",status:"completed",plan,sourceCase:{uri,digest:sourceDigest(original)},
        bundle:"fixture.settings",branches:[{id:"variant",status:"passed",choice,checkpoint:version==="2"?1:0}],
        steps:[{key:"variant/act",status:"completed"},{key:"variant/suffix",status:"completed"}],findings:[]};
    if (strategy==="detour") report.steps.push({key:"variant/return",status:"completed"});
    const presentation=new Map([[plan.steps[1],{name:"返回设置页"}]]);
    return {report,original,candidate:{id:"draft",revision:0,plan,presentation}};
}

test("an alternative exit replaces just the original Back step and retains its expectation",()=>{
    const {report,candidate}=fixture();
    const {staged,detail}=stageBranchDifference(report,"variant",candidate,"zh");
    assert.match(detail,/将第 2 步「返回设置页」替换为\n1\. 点击 Cancel/);
    assert.equal(staged.plan.steps.length,2);
    assert.deepEqual(staged.plan.steps[0],candidate.plan.steps[0]);
    assert.equal(staged.plan.steps[1].input.expect.equals,"English");
    assert.equal(staged.plan.steps[1].input.target.bundleName,report.bundle);
    assert.deepEqual(candidate.plan.steps[1],{command:"back",input:{expect:goal}});
    assert.deepEqual(caseRoutes(report).diffBranchIds,["variant"]);
    report.sourceCase.editable=false;
    assert.deepEqual(caseRoutes(report).diffBranchIds,[]);
    delete report.sourceCase;
    assert.deepEqual(caseRoutes(report).diffBranchIds,[]);
});

test("a verified detour keeps the original suffix and verifies endpoint checks on both sides of a complex detour",()=>{
    for (const version of ["1","2"]) {
        const {report,candidate}=fixture("detour",version);
        const {staged,detail}=stageBranchDifference(report,"variant",candidate,"en");
        assert.match(detail,/insert\n/);
        assert.deepEqual(staged.plan.steps.map(step=>step.command || "assert"),version==="2" ?
            ["press","back","assert","press","back"] : ["press","press","back","back"]);
        assert.deepEqual(staged.plan.goals,candidate.plan.goals);
    }
});

test("a detour after the last operation of a reference keeps its source reference intact",()=>{
    const {report,candidate}=fixture("detour");
    const fragment={version:"1",steps:[press("Settings"),press("Language")]};
    const reference={useCase:{caseId:"language",name:"Language",digest:signature({plan:fragment}),plan:fragment}};
    candidate.plan={version:"1",steps:[reference,{command:"back"}],goals:[goal]};
    candidate.presentation=new Map();
    report.plan=compileCase(candidate.plan).plan;
    report.branches[0].checkpoint=1;
    const {staged}=stageBranchDifference(report,"variant",candidate,"en");
    assert.deepEqual(staged.plan.steps[0],reference);
    assert.deepEqual(staged.plan.steps.slice(1).map(s=>s.command),["press","back","back"]);
    report.branches[0].checkpoint=0;
    assert.throws(()=>stageBranchDifference(report,"variant",candidate,"en"),/inside a composed step/);
});

test("cancel and changes during diff preview leave the source unopened; confirmation stages one undoable draft",async()=>{
    const {report,original,candidate}=fixture();
    candidate.presentation.clear();
    const item={uri:report.sourceCase.uri,editable:true,name:"Language"};
    const state={tool:"exploration",exploration:report,cases:[item]};
    let contents=original, answer, opened=0;
    const bench={language:"zh",state,refreshCases:async()=>{},explorations:{store:{load:async()=>report}},
        openCase:async()=>{opened++;},caseAuthoring:{stepDraft:async()=>candidate,update:()=>{},cancel:()=>{}}};
    const editor=new CaseCompositionEditor(bench,{Uri:{parse:()=>({})},
        workspace:{openTextDocument:async()=>({getText:()=>contents})},
        window:{showInformationMessage:async(title,options,add)=>{
            assert.equal(title,item.name);
            assert.match(options.detail,/第 2 步/);
            return answer?.(add);
        }}});
    const action={action:"reviewBranchDifference",branchId:"variant",reportId:report.id};
    await editor.handle(action);
    assert.equal(opened,0);
    answer=add=>{contents+=" "; return add;};
    await assert.rejects(editor.handle(action),/已变化/);
    assert.equal(opened,0);
    contents=original;
    answer=add=>add;
    await editor.handle(action);
    assert.equal(opened,1);
    assert.equal(state.tool,"recordings");
    assert.equal(candidate.plan.steps[1].input.target.text,"Cancel");
    assert.equal(candidate.insertionUndo.before.plan.steps[1].command,"back");
});
