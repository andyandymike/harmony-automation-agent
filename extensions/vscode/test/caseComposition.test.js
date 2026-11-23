"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {compileCase,compositionRecord,authoredDocument,referenceStatus,signature} = require("../src/caseComposition");
const {CaseCompositionEditor, atInsertion,replayPrefix,samePage} = require("../src/caseCompositionEditor");
const {createBdd} = require("../src/caseBdd");
const {storePresentation} = require("../src/casePresentation");

const visible = id => ({selector:{id},property:"visible",equals:true});
const tap = id => ({command:"press",input:{target:{id}}});
const loan = (caseId,name,plan,dependencies) => ({useCase:{caseId,name,plan,digest:signature({plan}),dependencies}});
const signIn = {version:"1",preconditions:[visible("sign-in")],steps:[tap("submit")],goals:[visible("home")]};
const profile = {version:"1",preconditions:[visible("home")],steps:[tap("profile")],goals:[visible("profile-saved")]};
const link = loan("login","Sign in",signIn,[]);

test("inserting before the caller's original first check verifies sign-in before checking the profile entrance",()=>{
    const authored=structuredClone(profile), presentation=new Map();
    const at=atInsertion(authored,{path:"preconditions[0]",side:"before"},presentation);
    at.list.splice(at.index,0,link);
    const compiled=compileCase(authored);
    assert.deepEqual(compiled.plan,{version:"1",preconditions:signIn.preconditions,
        steps:[tap("submit"),{assert:visible("home")},{assert:visible("home")},tap("profile")],goals:profile.goals});
    const rows=createBdd(authored,"en",undefined,presentation,{...compiled,
        sources:new Map([["login",{name:"Sign in to test account",digest:link.useCase.digest}]])}).steps;
    const group=rows[0];
    assert.equal(group.text,"Sign in to test account");
    assert.equal(group.branches[0].steps[0].receiptPath,"preconditions[0]");
    assert.equal(group.branches[0].steps[2].receiptPath,"steps[1]");
    assert.equal(rows[1].role,"Given");
    assert.equal(rows[1].receiptPath,"steps[2]");
    assert.equal(rows[2].receiptPath,"steps[3]");
});

test("nested and repeated references preserve the surrounding order and isolate v2 bindings",()=>{
    const route={version:"2",steps:[{read:{selector:{id:"name"},name:"name",property:"text"}}],
        goals:[{selector:{id:"name"},property:"text",equals:{var:"name"}}]};
    const ref=loan("name-case","Read name",route,[]);
    const native={version:"2",preconditions:[visible("home")],goals:[visible("done")],
        steps:[{read:{name:"name",selector:{id:"outer"},property:"text"}},
            {if:visible("profile"),then:[ref,tap("edit")],else:[tap("back")]},
            {repeat:{limit:2,until:visible("done"),steps:[ref,tap("retry")]}}]};
    const compiled=compileCase(native);
    const branch=compiled.plan.steps[1].then, loop=compiled.plan.steps[2].repeat.steps;
    assert.notEqual(branch[0].read.name,"name");
    assert.notEqual(branch[0].read.name,loop[0].read.name);
    assert.equal(branch[1].assert.equals.var,branch[0].read.name);
    assert.equal(loop[1].assert.equals.var,loop[0].read.name);
    assert.equal(compiled.paths.get("steps[2].repeat.steps[1]"),"steps[2].repeat.steps[2]");
    assert.equal(compiled.layouts.get("steps[1].then[0]").map("goals[0]"),"steps[1].then[1]");
    assert.equal(replayPrefix(native,{path:"steps[2].repeat.steps[0]",side:"before"}),undefined);
});

test("saved revisions restore their layout independently of source renames, updates, and deletion",()=>{
    const draft={...profile,steps:[link,...profile.steps]};
    const compiled=compileCase(draft).plan;
    const display=storePresentation(draft,new Map([[draft.steps[1],{name:"Open my profile"}]]));
    const current=compositionRecord(draft,compiled,display);
    const previous=compositionRecord(profile,profile);
    const records=[current,previous];
    const reopened=authoredDocument({plan:compiled},{composition:JSON.parse(JSON.stringify(records))});
    assert.equal(reopened.plan.steps[0].useCase.caseId,"login");
    assert.equal(reopened.presentation.get(reopened.plan.steps[1]).name,"Open my profile");
    assert.deepEqual(authoredDocument({plan:profile},{composition:records}).plan,profile);
    assert.equal(authoredDocument({plan:{...compiled,steps:[tap("external-edit")]}},{composition:records}).stale,true);
    assert.equal(referenceStatus(link.useCase,new Map([["login",{name:"Renamed",digest:link.useCase.digest}]] )).status,"current");
    assert.equal(referenceStatus(link.useCase,new Map([["login",{name:"Renamed",digest:"new"}]] )).status,"update");
    assert.equal(referenceStatus(link.useCase,new Map()).status,"missing");
    assert.deepEqual(compileCase(reopened.plan).plan,compiled);
});

test("copying saved steps preserves the module's entry and result and composition blocks cycles",()=>{
    const editor=new CaseCompositionEditor({state:{activeCase:{portableId:"profile"}}},{});
    assert.equal(editor.issue({plan:profile},{caseId:"login",dependencies:["profile"]}),"cycle");
    const c={plan:profile,presentation:new Map()};
    const {steps,...local}=editor.localSteps(link.useCase,c);
    const staged=editor.staged(c,{path:"preconditions[0]",side:"before"},steps,local);
    assert.deepEqual(staged.plan.preconditions,signIn.preconditions);
    assert.deepEqual(staged.plan.steps[1],{assert:visible("home")});
    assert.deepEqual(staged.plan.steps[2],{assert:visible("home")});
    const tail=editor.staged(c,{path:"goals[0]",side:"after"},steps,local);
    assert.deepEqual(tail.plan.goals,signIn.goals);
    assert.deepEqual(tail.plan.steps[1],{assert:profile.goals[0]});
});

test("a different recorded route cannot be treated as a match based on one shared control",()=>{
    assert.equal(samePage({app:"shop",route:"sign-in",keys:["back"]},{app:"shop",route:"profile",keys:["back"]}),false);
    assert.equal(samePage({app:"shop",route:"profile",keys:["account"]},{app:"shop",route:"profile",keys:["account"]}),true);
    assert.equal(samePage(undefined,{app:"shop",route:"profile"}),undefined);
});
