"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {compileCase,compositionRecord,authoredDocument,checkpointAfterRow,referenceStatus,signature,stageInsertion} = require("../src/caseComposition");
const {caseExplorationCheckpoints} = require("../src/planSummary");
const {CaseCompositionEditor, atInsertion,replayPrefix,samePage} = require("../src/caseCompositionEditor");
const {CaseAuthoring} = require("../src/caseAuthoring");
const {createBdd} = require("../src/caseBdd");
const {sourceDigest} = require("../src/caseRepair");
const {planWithRuleCheckpoints,ruleGroupsByPosition,ruleEnableConflict} = require("../src/caseRuleSteps");
const {launchWorkflow} = require("../src/workflowWorker");
const {storePresentation,restorePresentation} = require("../src/casePresentation");
const {deviceRecordingFormat} = require("../src/model");
const {readWorkflow,workflowForSave,requireExecutableWorkflow} = require("../src/workflowFile");
const loadWebview = require("../test-support/loadWebview");

const visible = id => ({selector:{id},property:"visible",equals:true});
const tap = id => ({command:"press",input:{target:{id}}});
const loan = (caseId,name,plan,dependencies) => ({useCase:{caseId,name,plan,digest:signature({plan}),dependencies}});
const signIn = {version:"1",preconditions:[visible("sign-in")],steps:[tap("submit")],goals:[visible("home")]};
const profile = {version:"1",preconditions:[visible("home")],steps:[tap("profile")],goals:[visible("profile-saved")]};
const link = loan("login","Sign in",signIn,[]);
const gestures = (...steps) => ({format:deviceRecordingFormat,version:1,steps});
const touch = (x, delayMs=0) => ({command:"deviceGesture",input:{kind:"click",x,y:300},delayMs});

test("adding follow-up steps always replays the selected prefix before reading controls, even for an old current-screen request",async()=>{
    const events=[];
    const plan={version:"1",preconditions:[visible("ready")],steps:[tap("origin"),tap("unused")],goals:[visible("old-end")]};
    const c={id:"test",revision:0,plan}, screen={frameId:"reached",quality:{complete:true},
        nodes:[{ref:"n1",id:"new",text:"Arrived",enabled:true,visible:true}]};
    let failed=true;
    const b={language:"en",state:{device:"d",devices:["d"]},caseAuthoring:{update(){}},publish(){},sessionFor:()=>"wb",
        async modelAsk(){events.push("model");return async()=>JSON.stringify({action:"done",text:"Finished"});},
        agent:{async call(command,params){
            events.push(command);
            if (command==="run") {
                assert.deepEqual(params.plan.steps,[tap("origin")]);assert.deepEqual(params.plan.preconditions,plan.preconditions);
                assert.ok(!params.plan.goals?.length);
                return failed ? {status:"failed",steps:[{path:"preconditions[0]",status:"failed",error:{message:"not ready"}}]} : {status:"completed"};
            }
            if (command==="observe") return screen;
            return {};
        }}};
    const editor=new CaseCompositionEditor(b,{});
    editor.draft={mode:"explore",anchor:{path:"steps[0]",side:"after"},explore:{}};
    editor.refresh=()=>{};
    editor.archivedAnchor=()=>assert.fail("the reached screen is authoritative");
    await editor.explore(c,{start:"current",goal:"Inspect the next screen"});
    assert.match(editor.draft.explore.problem,/preconditions\[0\].*not ready/);
    assert.ok(!events.includes("observe") && !events.includes("model"));
    events.length=0;failed=false;
    await editor.explore(c,{start:"current",goal:"Inspect the next screen"});
    assert.ok(events.indexOf("run")<events.indexOf("observe")&&events.indexOf("observe")<events.indexOf("model"));
    assert.deepEqual(plan.steps,[tap("origin"),tap("unused")]);
});

test("case rule steps preserve their positions and snapshots, and legacy starting groups remain editable",async t=>{
    const parent = await fs.mkdtemp(path.join(os.tmpdir(),"harmony-case-given-"));
    t.after(()=>fs.rm(parent,{recursive:true,force:true}));
    const group={version:1,name:"Inventory unavailable",paused:true,
        rules:[{id:"inventory",method:"GET",path:"/inventory",steps:[{response:{status:503}}]}]};
    const limited={...structuredClone(group),name:"Inventory throttled"};
    limited.rules[0].steps[0].response.status=429;
    const disabled={...structuredClone(group),name:"Disabled"};
    disabled.rules[0].enabled=false;
    const groups=new Map([["stock",group],["limited",limited],["disabled",disabled]]);
    const state={tool:"recordings"};
    const uri=fsPath=>({fsPath,scheme:"file",toString:()=>fsPath});
    let saved;
    const vscode={Uri:{file:uri,parse:uri},workspace:{},window:{showOpenDialog:async()=>[uri(parent)]}};
    const bench={state,language:"en",networks:{init:async()=>{},library:{
        listing:()=>[...groups].map(([id,{name}])=>({id,name})),
        get:id=>groups.get(id),
    }},caseLibrary:{add:async file=>fs.writeFile(file.fsPath+".harmony-case.json","{}")},refreshCases:async()=>{},
        setPlan:async file=>{saved=file;},planForRun:()=>state.plan,errorMessage:error=>error.message,perform:async action=>action()};
    const author=bench.caseAuthoring=new CaseAuthoring(bench,vscode);
    const editor=bench.composition=new CaseCompositionEditor(bench,vscode);
    async function insert(action, extra) {
        const {id,revision}=state.caseReview || {};
        let response;
        await editor.requestInsertion({action,session:"given",id,revision,uri:state.plan?.uri,digest:state.planDigest,
            path:"preconditions[0]",side:"before",...extra},result=>{response=result;});
        return response;
    }
    const select=({id,digest},extra)=>insert("applyRuleGroup",{groupId:id,groupDigest:digest,...extra});
    const plan={...signIn,steps:[tap("start"),{if:visible("cart"),then:[tap("submit"),tap("confirm")]},tap("done")]};
    const anchor={path:"steps[1].then[0]",side:"before"};
    const off={path:"steps[1].then[2]",side:"after",disable:true};
    author.begin({name:"Checkout",source:"workflow",plan});
    const offBeforeEnable={...anchor,disable:true};
    assert.deepEqual((await insert("ruleClosures",offBeforeEnable)).ruleGroups.options,[]);
    assert.match((await select({id:JSON.stringify(group.name)},offBeforeEnable)).error,/enabled at this position/);
    assert.equal(state.caseReview.bdd.ruleClosures,undefined);
    const {ruleGroups:{options}}=await insert("ruleGroups",anchor);
    assert.deepEqual(options.map(({id,enabled})=>[id,enabled]),[["stock",1],["limited",1]]);
    limited.rules[0].steps[0].response.status=500;
    assert.equal((await select(options[1],anchor)).changed,true);
    assert.deepEqual(author.candidate.plan,plan);
    assert.equal((await select(options[0],anchor)).path,"steps[1].then[0]");
    assert.equal(state.caseReview.insertionUndo,"steps[1].then[0]");
    assert.deepEqual(await insert("undo"),{path:"steps[1].then[0]"});
    assert.equal(state.caseReview.dirty,false);
    await select(options[0],anchor);
    const beforeEnable={path:"steps[1].then[0]",side:"before"};
    const afterEnable={path:"steps[1].then[0]",side:"after"};
    const afterBranch={path:"steps[2]",side:"before"};
    for (const [where,reason] of [[beforeEnable,"later"],[afterEnable,"active"],[afterBranch,"possible"]]) {
        const second=(await insert("ruleGroups",where)).ruleGroups.options.find(item=>item.id==="stock");
        assert.equal(second.blocked,reason);
        assert.match((await select(second,where)).error,/only be enabled once at a time/);
    }
    const {id,revision}=author.candidate;
    await assert.rejects(author.changeStep({action:"duplicate",path:anchor.path,id,revision}),/Insert a rule group/);
    assert.equal(author.candidate.plan.steps[1].then.length,3);
    const latest=(await insert("ruleGroups",anchor)).ruleGroups.options;
    await select(latest[1],{path:"steps[1].then[1]",side:"after"});
    const {ruleGroups:closable}=await insert("ruleClosures",off);
    assert.deepEqual(closable.options.map(({name})=>name),[group.name,limited.name]);
    assert.equal((await select(closable.options[0],off)).path,"steps[1].then[3]");
    const labels=state.caseReview.bdd.steps.find(row=>row.path==="steps[1]").branches[0].steps;
    assert.deepEqual(labels.map(row=>row.role),["Given","When","Given","When","When"]);
    assert.equal(labels[0].text,"Enable rule group Inventory unavailable");
    assert.equal(labels[3].text,"Turn off rule group Inventory unavailable");
    const afterClose={path:"steps[1].then[3]",side:"after",disable:true};
    assert.deepEqual((await insert("ruleClosures",afterClose)).ruleGroups.options.map(({name})=>name),[limited.name]);
    const reenable={path:afterClose.path,side:"after"};
    const again=(await insert("ruleGroups",reenable)).ruleGroups.options.find(item=>item.id==="stock");
    assert.equal(again.blocked,undefined);
    assert.equal((await select(again,reenable)).path,"steps[1].then[4]");
    await insert("undo");
    assert.equal(state.caseReview.bdd.ruleClosures["steps[2]"],undefined);
    const editClose={...afterClose,ruleEdit:"close"};
    const editOptions=(await insert("ruleClosures",editClose)).ruleGroups;
    assert.equal(editOptions.current,group.name);
    await select(editOptions.options[1],editClose);
    assert.equal(author.candidate.plan.steps[1].then[3].ruleGroup.name,limited.name);
    await insert("undo");
    const edit={...anchor,ruleEdit:"step"};
    const available=(await insert("ruleGroups",edit)).ruleGroups;
    assert.equal(available.current,group.name);
    assert.equal(available.options[0].current,true);
    assert.equal(available.options[1].blocked,"later");
    assert.match((await select(available.options[1],edit)).error,/only be enabled once at a time/);
    const replacement={...structuredClone(limited),name:"Inventory stable"};
    groups.set("replacement",replacement);
    const unused=(await insert("ruleGroups",edit)).ruleGroups.options.find(item=>item.id==="replacement");
    await select(unused,edit);
    assert.equal(author.candidate.plan.steps[1].then[0].ruleGroup.scenario.name,replacement.name);
    const changedClose=state.caseReview.bdd.steps.find(row=>row.path==="steps[1]").branches[0].steps[3];
    assert.equal(changedClose.ruleGroup.unavailable,true);
    await insert("undo");
    group.rules[0].steps[0].response.status=200;
    await author.save({id:author.candidate.id,name:"Checkout"});
    const updated = readWorkflow(await fs.readFile(saved.fsPath,"utf8"));
    assert.equal(updated.scenario,undefined);
    const [on,submit,other,disable,confirm] = updated.plan.steps[1].then;
    assert.equal(on.ruleGroup.scenario.paused,false);
    assert.equal(on.ruleGroup.scenario.rules[0].steps[0].response.status,503);
    assert.equal(other.ruleGroup.scenario.name,limited.name);
    assert.deepEqual([submit,disable,confirm],[tap("submit"),{ruleGroup:{action:"disable",name:group.name}},tap("confirm")]);

    author.begin({name:"Legacy",source:"workflow",plan:signIn,group});
    await author.save({id:author.candidate.id,name:"Legacy"});
    const file=readWorkflow(await fs.readFile(saved.fsPath,"utf8"));

    const original = await fs.readFile(saved.fsPath,"utf8");
    const bindings = {[saved.toString()]:group};
    bench.networks.clearCaseBinding=async key=>{delete bindings[key];};
    const documents = new Map();
    vscode.workspace.openTextDocument=async file=>{
        if (!documents.has(file.fsPath)) {
            const document={text:await fs.readFile(file.fsPath,"utf8"),positionAt:offset=>offset,
                getText(){return this.text;},async save(){await fs.writeFile(file.fsPath,this.text);return true;}};
            documents.set(file.fsPath,document);
        }
        return documents.get(file.fsPath);
    };
    vscode.Range=class {constructor(start,end){Object.assign(this,{start,end});}};
    vscode.WorkspaceEdit=class {replace(uri,range,text){Object.assign(this,{uri,range,text});}};
    vscode.workspace.applyEdit=async ({uri,range,text})=>{
        const doc=await vscode.workspace.openTextDocument(uri);
        doc.text=doc.text.slice(0,range.start)+text+doc.text.slice(range.end);
        return true;
    };
    state.plan=state.activeCase={uri:saved.toString(),name:"Legacy"};
    state.planDigest=sourceDigest(original);
    state.caseBdd=createBdd(file.plan,"en",file.scenario);
    state.caseDefinitions={};
    const legacy={ruleEdit:"legacy"};
    const savedChoices=(await insert("ruleGroups",legacy)).ruleGroups;
    assert.equal(savedChoices.current,group.name);
    assert.equal(savedChoices.options.some(item=>item.current),false);
    assert.equal(author.candidate,undefined);
    await select(savedChoices.options[1],legacy);
    assert.equal(state.caseReview.bdd.steps[0].text,"Use rule group Inventory throttled");
    assert.equal(state.caseReview.bdd.steps.filter(step=>step.area==="setup").length,1);
    assert.deepEqual(await insert("undo"),{path:"rule-group"});
    assert.equal(author.candidate,undefined);
    assert.equal((await insert("applyRuleGroup",{...legacy,remove:true})).path,"preconditions[0]");
    assert.equal(state.caseReview.insertionNotice,"ruleGroupRemoved");
    assert.equal(state.caseReview.bdd.steps.some(step=>step.area==="setup"),false);
    await author.save({id:author.candidate.id});
    assert.equal(readWorkflow(await fs.readFile(saved.fsPath,"utf8")).scenario,undefined);
    assert.deepEqual(bindings,{});
    const folder = path.dirname(saved.fsPath);
    const testFile = (await fs.readdir(folder)).find(name=>name.endsWith(".py"));
    assert.match(await fs.readFile(path.join(folder,testFile),"utf8"),/^REQUIRES_RULE_GROUP = False$/m);
});

test("rule checkpoints retain repeated disable steps and switch only on a live worker event",()=>{
    const scenario = {version:1,name:"Inventory",rules:[]};
    const disable = {ruleGroup:{action:"disable",name:scenario.name}};
    const enable = {ruleGroup:{action:"enable",scenario}};
    const plan = {version:"1",steps:[disable,{repeat:{limit:2,until:visible("done"),steps:[enable,tap("next"),disable]}}]};
    const staged=planWithRuleCheckpoints(plan);
    assert.deepEqual([...staged.switches.keys()],["steps[0]","steps[1].repeat.steps[0]","steps[1].repeat.steps[2]"]);
    assert.equal(staged.plan.steps[1].repeat.steps[2].command,"observe");
    assert.deepEqual(plan.steps[0],disable);
    const replies=[], changes=[];
    let emit;
    const worker=launchWorkflow((_,request,onEvent)=>{
        emit=onEvent;
        assert.equal(request.ruleSteps["steps[1].repeat.steps[2]"],"disableRuleGroup");
        return {write:message=>replies.push(message)};
    },{}, {},staged,{apply:effect=>changes.push(effect.scenario?.name || effect.name)});
    emit({type:"ruleGroup",path:"steps[1].repeat.iteration[0][0]",token:"2"});
    emit({type:"ruleGroup",path:"steps[1].repeat.iteration[0][2]",token:"4"});
    assert.deepEqual(changes,["Inventory","Inventory"]);
    assert.deepEqual(replies.map(({action,token})=>[action,token]),[["ruleGroupResult","2"],["ruleGroupResult","4"]]);
    worker.write({action:"stop"});
    emit({type:"ruleGroup",path:"steps[1].repeat.iteration[1][0]",token:"6"});
    assert.deepEqual(changes,["Inventory","Inventory"]);
    assert.deepEqual(replies.at(-1),{action:"stop"});
});

test("a rule group can be closed at a branch merge or loop position only when it is active on every route",()=>{
    const enable = name=>({ruleGroup:{action:"enable",scenario:{version:1,name,rules:[]}}});
    const disable = name=>({ruleGroup:{action:"disable",name}});
    const plan = {version:"1",steps:[
        {if:visible("checkout"),then:[enable("Shared"),enable("Only then")],else:[enable("Shared")]},
        tap("continue"),
        {repeat:{limit:2,until:visible("done"),steps:[enable("Within loop"),tap("poll"),disable("Within loop")]}},
        tap("summary"),
    ]};
    const positions=ruleGroupsByPosition(plan);
    const before=path=>[...positions.get(path).before.active];
    assert.deepEqual(before("steps[1]"),["Shared"]);
    assert.deepEqual(before("steps[2].repeat.steps[0]"),["Shared"]);
    assert.deepEqual(before("steps[2].repeat.steps[2]"),["Shared","Within loop"]);
    assert.deepEqual(before("steps[3]"),["Shared"]);
    const legacy=createBdd({version:"1",steps:[enable("Old"),{ruleGroup:{action:"disable"}}]});
    assert.equal(legacy.steps[1].text,"Turn off rule group Old");
});

test("enable conflicts account for repeat iterations, reference snapshots and separate activation intervals",()=>{
    const enable=name=>({ruleGroup:{action:"enable",scenario:{version:1,name,rules:[]}}});
    const disable=name=>({ruleGroup:{action:"disable",name}});
    const single={version:"1",steps:[{repeat:{limit:2,until:visible("done"),steps:[enable("Inventory"),tap("next")]}}]};
    const inLoop="steps[0].repeat.steps[0]";
    assert.equal(ruleEnableConflict(single,undefined,inLoop,"Inventory"),undefined);
    assert.equal(createBdd(single).steps[0].branches[0].steps[0].ruleGroup.repeated,false);
    const linked=loan("network-case","Network setup",{version:"1",steps:[enable("Inventory")]},[]);
    const overlaps={version:"1",steps:[enable("Inventory"),linked,disable("Inventory"),enable("Inventory")]};
    assert.equal(ruleEnableConflict(overlaps,undefined,"steps[0]","Inventory"),"later");
    assert.equal(ruleEnableConflict(overlaps,undefined,"steps[3]","Inventory"),undefined);
    const existing=createBdd({version:"1",steps:[enable("Inventory"),enable("Inventory")]});
    assert.equal(existing.steps[1].ruleGroup.repeated,true);
});

test("pending descriptions survive saving without creating a runnable subset of a recording",()=>{
    const original=gestures(touch(100,17),touch(150,27));
    const anchor={path:"steps[0]",side:"after"};
    const text="Confirm the profile is visible, then open language settings";
    const description={id:"profile-language",text};
    const staged=stageInsertion({plan:original,presentation:new Map()},anchor,[{description}]);
    assert.equal(staged.plan.format,deviceRecordingFormat);
    assert.deepEqual(staged.compiled.pending,[{path:"steps[1]",id:description.id}]);
    const serialized=workflowForSave(staged.compiled.plan);
    assert.equal(serialized.format,"harmony-agent.case-draft");
    assert.equal(serialized.steps,undefined);
    const draft=readWorkflow(JSON.stringify(serialized));
    assert.throws(()=>requireExecutableWorkflow(draft,"en"),/awaiting generation/);
    assert.equal(replayPrefix(draft.plan,{path:"steps[2]",side:"before"}),undefined);
    assert.deepEqual(replayPrefix(draft.plan,{path:"steps[1]",side:"before"}).steps,[touch(100,17)]);

    const implementation=[{assert:visible("profile")},tap("language")];
    const applied=stageInsertion({plan:draft.plan,presentation:new Map()},anchor,
        [{description:{...description,steps:implementation}}],{replace:"steps[1]"});
    assert.deepEqual(applied.compiled.plan.steps,[touch(100,17),...implementation,touch(150,27)]);
    const saved=readWorkflow(JSON.stringify(workflowForSave(applied.compiled.plan)));
    requireExecutableWorkflow(saved,"en");
    const restored=authoredDocument(saved,{composition:[compositionRecord(applied.plan,applied.compiled.plan)]});
    const [,row,final]=createBdd(restored.plan,"en",undefined,restored.presentation,restored).steps;
    assert.equal(row.text,text);
    assert.equal(row.branches[0].steps[0].receiptPath,"steps[1]");
    assert.equal(row.branches[0].steps[1].receiptPath,"steps[2]");
    assert.equal(final.receiptPath,"steps[3]");
});

test("a new case generates one description at a time and keeps an unmet draft row awaiting generation",async()=>{
    const state={tool:"recordings",device:"fixture",devices:["fixture"]};
    const operations=[];
    const page={frameId:"f1",quality:{complete:true},nodes:[
        {ref:"n1",id:"fixture.language",text:"English",enabled:true,visible:true}
    ]};
    let checkStatus="passed";
    const bench={state,language:"en",publish(){},sessionFor:()=>"workbench",agent:{async call(command,params){
        operations.push({command,params});
        if (command==="observe") return page;
        if (command==="run") return {status:"completed"};
        if (command==="wait") return {assertion:{status:checkStatus},observation:page};
        return {};
    }},async modelAsk(){
        let round=0;
        return async prompt=>{
            assert.match(prompt,/exactly the described case step/);
            if (!round++) return JSON.stringify({action:"check",node:1,property:"text",equals:checkStatus==="passed"?"English":"French"});
            return JSON.stringify({action:"done",text:"Language confirmed."});
        };
    }};
    const author=bench.caseAuthoring=new CaseAuthoring(bench,{});
    const editor=bench.composition=new CaseCompositionEditor(bench,{});
    author.create();
    const candidate=author.candidate;
    const part=()=>({id:candidate.id,revision:candidate.revision});
    await editor.saveDescription({...part(),path:"steps",side:"after",description:"Verify the language is English"});
    await editor.saveDescription({...part(),path:"steps[0]",side:"after",description:"Verify the language is French after switching accounts"});
    assert.equal(state.caseReview.pending.length,2);

    const first=state.caseReview.bdd.steps[0];
    await editor.handle({action:"generateDescription",...part(),path:first.path,descriptionId:first.description.id});
    assert.equal(state.tool,"exploration");
    assert.equal(state.caseComposition.canReplay,false);
    await editor.handle({action:"runExplore",...part(),start:"current",goal:"This must never replace the original description"});
    assert.equal(candidate.plan.steps[0].description.steps,undefined);
    assert.equal(state.caseComposition.result.steps[0].role,"Then");
    await editor.handle({action:"nextDescription",...part()});
    assert.equal(candidate.plan.steps[0].description.steps[0].assert.equals,"English");
    assert.equal(state.caseComposition.anchor.path,"steps[1]");
    assert.equal(state.caseComposition.canReplay,true);

    checkStatus="failed";
    await editor.handle({action:"runExplore",...part(),start:"replay"});
    assert.deepEqual(operations.find(call=>call.command==="run").params.plan.steps,candidate.plan.steps[0].description.steps);
    assert.equal(state.caseComposition.result,undefined);
    assert.match(state.caseComposition.progress.at(-1),/expected result/);
    await editor.handle({action:"addDescription",...part()});
    assert.deepEqual(state.caseReview.pending.map(row=>row.path),["steps[1]"]);
    assert.equal(operations.at(-1).command,"detach");
    await editor.handle({action:"close",...part()});
    await editor.saveDescription({...part(),path:"steps[0]",side:"after",descriptionId:first.description.id,description:"Verify a different value"});
    assert.equal(candidate.plan.steps[0].description.id,first.description.id);
    assert.equal(state.caseReview.pending.length,2);
    assert.equal(state.tool,"recordings");
});

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

test("row actions distinguish insertion into this case from the two ways to start a new case",async()=>{
    const {caseStepMenuItems}=await loadWebview("caseComposition");
    const w=(en,zh)=>zh, seen=[];
    const button=(textContent,dataset,disabled=false)=>({textContent,dataset,disabled,isConnected:true,
        matches:()=>disabled,click:()=>seen.push(textContent)});
    const entries=[
        button("编辑步骤",{caseArea:"stepDetails"}),button("用 AI 修改此步",{area:"stepFeedback"}),
        button("复制步骤",{stepAction:"duplicate"}),button("删除步骤",{stepAction:"remove"}),
        button("之前",{caseInsert:"open",side:"before"}),button("之后",{caseInsert:"open",side:"after"}),
        button("用 AI 补充当前用例",{caseContinue:"current",compose:"explore"}),button("保存片段",{compose:"section"}),
        button("复制到这里的步骤",{caseContinue:"new",compose:"forkCase"}),
        button("探索其他走法",{caseContinue:"new",type:"explorationFromCase",menuReason:"请先保存草稿。"},true),
        button("上移",{orderOffset:"-1"},true),button("下移",{orderOffset:"1"}),
    ];
    const actions=caseStepMenuItems(entries,w);
    assert.deepEqual(actions.map(item=>item.label),["编辑步骤","复制步骤","之前","之后","用 AI 补充当前用例","下移","用 AI 修改此步","保存片段","从此处新建用例","删除步骤"]);
    const ai=actions.find(item=>item.label==="从此处新建用例");
    assert.deepEqual(ai.children.map(item=>item.label),["复制到这里的步骤","探索其他走法"]);
    assert.equal(ai.children[1].disabled,true);
    assert.equal(ai.children[1].reason,"请先保存草稿。");
    assert.deepEqual(actions.filter(item=>item.children),[ai]);
    for (const item of actions.filter(item=>["复制步骤","之前","之后","保存片段"].includes(item.label))) item.run();
    ai.children[0].run();
    assert.deepEqual(seen,["复制步骤","之前","之后","保存片段","复制到这里的步骤"]);
    const middle=caseStepMenuItems([...entries.slice(0,-2),button("上移",{orderOffset:"-1"}),entries.at(-1)],w);
    assert.deepEqual(middle.find(item=>item.label==="移动步骤").children.map(item=>item.label),["上移","下移"]);
    const boundary=caseStepMenuItems([entries[0],entries[4],entries[5],entries[6],entries[8],entries[9]],w);
    assert.deepEqual(boundary.map(item=>item.label),["编辑步骤","之前","之后","用 AI 补充当前用例","从此处新建用例"]);
    assert.deepEqual(boundary.at(-1).children.map(item=>item.label),ai.children.map(item=>item.label));
});

test("guided step menus select the end of the visible case row in the runnable workflow",async()=>{
    const group={description:{id:"view",text:"Visit details and return",steps:[tap("details"),{command:"back"}]}};
    const ref=loan("options","Visit options",{version:"1",steps:[tap("options")],preconditions:[visible("profile")],goals:[visible("options")]},[]);
    const authored={version:"1",steps:[group,ref,{command:"back"}],goals:[visible("profile")]};
    const file={plan:compileCase(authored).plan};
    const document=authoredDocument(file,{composition:[compositionRecord(authored,file.plan)]});
    const positions=caseExplorationCheckpoints(file,document,"en");
    assert.deepEqual(positions,{"steps[0]":1,"steps[1]":4,"steps[2]":5,"goals[0]":6});
    assert.equal(checkpointAfterRow(document,"steps[0].description.steps[1]"),undefined);
    assert.deepEqual(file.plan.steps[positions["steps[1]"]],{assert:visible("options")});
    const opaque={plan:{...file.plan,version:"2"}};
    assert.deepEqual(caseExplorationCheckpoints(opaque,document,"en"),positions);
    assert.equal(caseExplorationCheckpoints({plan:gestures(touch(10))},{plan:gestures(touch(10))},"en"),undefined);
    assert.equal(caseExplorationCheckpoints({...file,draft:true},document,"en"),undefined);

    const {caseForkStepMenu,casePositionMenuItems}=await loadWebview("caseComposition");
    const model={plan:{uri:"file:///case"},planDigest:"latest",caseExplorationCheckpoints:positions};
    model.caseBdd=createBdd(authored,"zh",undefined,undefined,document);
    caseExplorationCheckpoints(file,document,"zh",{bdd:model.caseBdd});
    const row=model.caseBdd.steps.find(step=>step.path==="steps[1]"),zh=(_en,translation)=>translation;
    const action=caseForkStepMenu(row,model,zh);
    assert.match(action,/用 AI 补充当前用例/);
    assert.match(action,/复制到这里的步骤/);
    assert.match(action,/探索其他走法/);
    assert.match(action,/data-checkpoint="4"/);
    assert.match(action,/data-digest="latest"/);
    const finalCheck=model.caseBdd.steps.find(step=>step.path==="goals[0]");
    assert.match(caseForkStepMenu(finalCheck,model,zh),/data-checkpoint="6"/);
    const sent=[];
    const slot={dataset:{path:row.path,side:"before"},isConnected:true,click:()=>sent.push("insert")};
    const choices=casePositionMenuItems(slot,model,zh,msg=>sent.push(msg));
    assert.deepEqual(choices.map(item=>item.label),["在此插入步骤","用 AI 补充当前用例","从此处新建用例"]);
    choices[0].run();
    choices[1].run();
    choices[2].children.forEach(item=>item.run());
    assert.equal(sent[0],"insert");
    assert.equal(sent[1].path,row.path);
    assert.equal(sent[1].side,"before");
    assert.equal(sent[1].destination,"current");
    assert.equal(sent[2].action,"forkCase");
    assert.equal(sent[2].side,"before");
    assert.equal(sent[3].checkpoint,1);
    slot.dataset={path:finalCheck.path,side:"after"};
    const ending=casePositionMenuItems(slot,model,zh,msg=>sent.push(msg))[2];
    ending.children[0].run();
    assert.equal(sent.at(-1).path,finalCheck.path);
    ending.children[1].run();
    assert.equal(sent.at(-1).checkpoint,6);
    assert.match(ending.children[0].description,/新草稿/);
    assert.match(ending.children[1].description,/其他入口.*最多两处/);
    const blank={caseReview:{id:"blank",revision:0,bdd:{steps:[]},empty:true}};
    slot.dataset={path:"steps",side:"after"};
    const emptyMenu=casePositionMenuItems(slot,blank,zh,msg=>sent.push(msg));
    assert.deepEqual(emptyMenu.map(item=>item.label),["在此插入步骤","用 AI 补充当前用例"]);
    emptyMenu[1].run();
    assert.equal(sent.at(-1).id,"blank");
    assert.equal(sent.at(-1).destination,"current");
    const plain={plan:{version:"1",steps:[tap("start")]}};
    assert.deepEqual(caseExplorationCheckpoints(plain,plain,"en"),{"steps[0]":0});
    assert.equal(checkpointAfterRow(plain,"steps[1]"),undefined);
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

test("a coordinate reference saves pure gestures with the recorded delays and receipt paths",()=>{
    const source = gestures(touch(20,250),touch(30,700));
    const reference = loan("gesture-login","Open sign-in screen",source,[]);
    const authored = gestures(touch(10),reference,touch(40,200));
    const compiled = compileCase(authored);
    assert.deepEqual(compiled.plan,gestures(touch(10),...source.steps,touch(40,200)));
    assert.equal(compiled.paths.get("steps[2]"),"steps[3]");
    const metadata = {composition:[JSON.parse(JSON.stringify(compositionRecord(authored,compiled.plan)))]};
    const reopened = authoredDocument({plan:compiled.plan},metadata);
    assert.deepEqual(reopened.plan,authored);
    const linked = createBdd(reopened.plan,"en",undefined,reopened.presentation,reopened).steps[1];
    assert.deepEqual(linked.branches[0].steps.map(row=>row.receiptPath),["steps[1]","steps[2]"]);
    assert.throws(()=>compileCase(gestures(link)),/executable snapshot/);
    assert.deepEqual(compileCase({...profile,steps:[reference]}).plan.steps,source.steps);
    const invalid = loan("invalid","Unsupported gesture",gestures({...touch(10),delayMs:-1}));
    assert.throws(()=>compileCase(gestures(invalid)),/Invalid coordinate recording/);
});

test("copying a coordinate case inserts independent steps at the selected boundary",async()=>{
    const uri = "file:///fixtures/coordinates/workflow.json";
    const original = gestures(touch(10),touch(40));
    const c = {id:"coordinates",revision:1,plan:original,presentation:new Map()};
    const plan = gestures(touch(20,250),touch(30,400));
    const source = {id:"source",caseId:"source",portableId:"source",name:"Coordinate source",uri:"file:///source/workflow.json",location:"source/workflow.json",
        plan,digest:signature({plan})};
    const state = {tool:"recordings",plan:{uri},cases:[source],caseReview:{bdd:createBdd(original)}};
    const author = {candidate:c,stepDraft:async()=>c,update(){state.caseReview.bdd=createBdd(c.plan);}};
    const editor = new CaseCompositionEditor({state,caseAuthoring:author},{});
    editor.readSource = async()=>source;
    assert.equal(editor.issue(c,{...source,plan:profile}),undefined);
    const result = await editor.applyInsertion({uri,id:c.id,revision:1,path:"steps[0]",side:"after",sourceId:source.id,copy:true});
    assert.equal(result.path,"steps[1]");
    assert.deepEqual(c.plan,gestures(touch(10),...plan.steps,touch(40)));
    assert.notEqual(c.plan.steps[1],plan.steps[0]);
    assert.deepEqual(editor.undoInsertion({id:c.id,revision:2}),{path:"steps[0]"});
    assert.equal(c.plan,original);
});

test("one check editor preserves the selected position and keeps pytest boundary checks usable",async()=>{
    const uri="file:///fixtures/order/workflow.json";
    const bench={state:{tool:"recordings",plan:{uri}},language:"en"};
    const author=bench.caseAuthoring=new CaseAuthoring(bench,{});
    const editor=bench.composition=new CaseCompositionEditor(bench,{});
    const source={version:"1",steps:[tap("open"),tap("pay")]};
    author.begin({name:"Order",plan:source});
    const c=author.candidate;
    const insert=async(path,side,controlId)=>{
        const {editor:fields}=await editor.prepareStep({kind:"check",uri,id:c.id,revision:c.revision,path,side});
        await author.edit({...fields,add:true,positionedCheck:true,name:controlId,property:"visible",
            expected:"true",target:"manual",locatorField:"id",controlId});
        return c.insertionUndo.path;
    };
    assert.equal(await insert("steps[0]","before","start"),"preconditions[0]");
    assert.equal(await insert("preconditions[0]","after","ready"),"preconditions[1]");
    assert.equal(await insert("steps[1]","before","total"),"steps[1]");
    assert.equal(await insert("steps[2]","after","done"),"goals[0]");
    assert.equal(await insert("goals[0]","before","receipt"),"goals[0]");
    assert.deepEqual(c.plan.preconditions,[visible("start"),visible("ready")]);
    assert.deepEqual(c.plan.goals,[visible("receipt"),visible("done")]);
    assert.deepEqual(c.plan.steps,[tap("open"),{assert:visible("total")},tap("pay")]);
    assert.deepEqual(bench.state.caseReview.bdd.steps.map(row=>row.role),["Given","Given","When","Then","When","Then","Then"]);
    assert.deepEqual(source.steps,[tap("open"),tap("pay")]);
    author.begin({name:"Empty",emptyCase:true,plan:{version:"1",steps:[]}});
    const blank=author.candidate;
    const {editor:first}=await editor.prepareStep({kind:"check",uri,id:blank.id,revision:blank.revision,path:"steps",side:"after"});
    await author.edit({...first,add:true,positionedCheck:true,property:"visible",expected:"true",target:"manual",locatorField:"id",controlId:"home"});
    assert.deepEqual(blank.plan.steps,[{assert:visible("home")}]);
});

test("the same insertion point opens action and check editors and preserves their execution order",async()=>{
    const uri = "file:///fixtures/profile/workflow.json";
    const state = {tool:"recordings",plan:{uri}};
    const bench = {state,language:"en"};
    const author = bench.caseAuthoring = new CaseAuthoring(bench,{});
    const editor = bench.composition = new CaseCompositionEditor(bench,{});
    author.begin({name:"Profile",plan:{...profile,steps:[tap("profile"),tap("save")]}});
    const c = author.candidate;
    const open = (kind,path,side)=>editor.prepareStep({kind,uri,id:c.id,revision:c.revision,path,side});
    const {editor:check} = await open("check","steps[1]","before");
    assert.equal(check.area,"stepCheck");
    await author.edit({...check,add:true,role:"Then",property:"visible",expected:"true",target:"manual",
        locatorField:"id",controlId:"form-ready"});
    const {editor:action} = await open("action","steps[1]","after");
    assert.equal(action.area,"stepOperation");
    await author.edit({...action,add:true,command:"fill",text:"Example",target:"manual",locatorField:"id",controlId:"account-name"});
    assert.deepEqual(c.plan.steps,[tap("profile"),{assert:visible("form-ready")},
        {command:"fill",input:{target:{id:"account-name"},text:"Example"}},tap("save")]);
    assert.deepEqual(state.caseReview.bdd.steps.map(step=>step.role),["Given","When","Then","When","When","Then"]);
    assert.equal(state.caseReview.insertionUndo,"steps[2]");
    editor.undoInsertion({id:c.id,revision:c.revision});
    assert.equal(c.plan.steps[2].input.target.id,"save");
    const {editor:next} = await open("check","goals[0]","before");
    await author.edit({...next,add:true,role:"Given",property:"visible",expected:"true",target:"manual",
        locatorField:"id",controlId:"home"});
    assert.deepEqual(c.plan.goals,profile.goals);
    assert.deepEqual(state.caseReview.bdd.steps.slice(-2).map(step=>step.role),["Given","Then"]);
});

test("a coordinate workflow can add a named Given check and undo its promotion before adding a pure gesture",async()=>{
    const uri = "file:///fixtures/coordinates/workflow.json";
    const state = {tool:"recordings",plan:{uri}};
    const bench = {state,language:"en"};
    const author = bench.caseAuthoring = new CaseAuthoring(bench,{});
    const editor = bench.composition = new CaseCompositionEditor(bench,{});
    author.begin({name:"Coordinates",plan:gestures(touch(10),touch(40))});
    const c = author.candidate;
    const open = kind=>editor.prepareStep({uri,id:c.id,revision:c.revision,path:"steps[1]",side:"before",kind});
    const {editor:given} = await open("given");
    assert.equal(given.role,"Given");
    await author.edit({...given,add:true,name:"Home is ready",property:"visible",expected:"true",target:"manual",
        locatorField:"id",controlId:"home"});
    assert.equal(c.plan.format,undefined);
    assert.equal(c.plan.version,"1");
    assert.deepEqual(c.plan.steps,[touch(10),{assert:visible("home")},touch(40)]);
    assert.deepEqual(state.caseReview.bdd.steps.map(({role})=>role),["When","Given","When"]);
    assert.equal(state.caseReview.bdd.steps[1].name,"Home is ready");
    editor.undoInsertion({id:c.id,revision:c.revision});
    assert.equal(c.plan.format,deviceRecordingFormat);
    const {editor:request} = await open("action");
    assert.equal(request.area,"stepGesture");
    await author.edit({...request,add:true,kind:"pinch",delay:"75",coordinates:{
        "finger1-x":"20","finger1-y":"80","finger1-toX":"25","finger1-toY":"80",
        "finger2-x":"50","finger2-y":"80","finger2-toX":"45","finger2-toY":"80"}});
    assert.deepEqual(c.plan.steps[1],{command:"deviceGesture",delayMs:75,input:{kind:"pinch",fingers:[
        {x:20,y:80,toX:25,toY:80},{x:50,y:80,toX:45,toY:80}]}});
    assert.equal(c.plan.steps[2].input.x,40);
});

test("a Given preparation reference can carry a control case into a coordinate run",async()=>{
    const uri = "file:///fixtures/coordinates/workflow.json";
    const state = {tool:"recordings",plan:{uri}};
    const bench = {state,language:"en"};
    const author = bench.caseAuthoring = new CaseAuthoring(bench,{});
    const editor = bench.composition = new CaseCompositionEditor(bench,{});
    author.begin({name:"Coordinates",plan:gestures(touch(10))});
    const c = author.candidate;
    const source = {id:"login",caseId:"login",portableId:"login",name:"Sign in",uri:"file:///source/workflow.json",
        location:"source/workflow.json",plan:signIn,digest:signature({plan:signIn})};
    state.cases = [source];
    editor.readSource = async()=>source;
    await editor.applyInsertion({uri,id:c.id,revision:c.revision,path:"steps[0]",side:"before",sourceId:source.id,role:"Given"});
    assert.deepEqual(state.caseReview.bdd.steps.map(row=>row.role),["Given","When"]);
    const {plan} = compileCase(c.plan);
    assert.deepEqual(plan.preconditions,signIn.preconditions);
    assert.deepEqual(plan.steps,[tap("submit"),{assert:visible("home")},touch(10)]);
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

test("case insertion defaults to before the final check and leaving its page preserves earlier edits", async()=>{
    const state={tool:"recordings"};
    let editor;
    const author={
        async stepDraft() {
            this.candidate ??= {id:"profile",revision:0,plan:profile,name:"Profile",presentation:new Map()};
            this.update();
            return this.candidate;
        },
        update() {state.caseReview={bdd:createBdd(profile),dirty:Boolean(this.candidate.added)};},
        cancel() {this.candidate=undefined; state.caseReview=undefined;},
    };
    editor=new CaseCompositionEditor({state,caseAuthoring:author,publish(){}},{});
    editor.loadSources=async()=>[];
    await editor.handle({action:"open"});
    assert.deepEqual(state.caseComposition.anchor,{path:"goals[0]",side:"before"});
    await editor.handle({action:"setPosition",id:"profile",revision:0,path:"preconditions[0]",side:"after"});
    assert.deepEqual(state.caseComposition.anchor,{path:"preconditions[0]",side:"after"});
    await editor.handle({action:"close",id:"profile",revision:0});
    assert.equal(author.candidate,undefined);
    await editor.handle({action:"open"});
    author.candidate.added=true;
    author.update();
    await editor.handle({action:"close",id:"profile",revision:0});
    assert.equal(state.tool,"recordings");
    assert.equal(state.caseComposition,undefined);
    assert.ok(author.candidate.added);
});

test("a reusable section opened on the last step saves the selected continuous range",async t=>{
    const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"ha-reusable-section-")));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const steps=[tap("settings"),tap("profile"),tap("language")];
    const plan={version:"1",preconditions:[visible("start")],steps:[{if:visible("home"),then:steps,else:[tap("back")]}],
        goals:[visible("done")]};
    const c={id:"profile",revision:0,plan,name:"Profile",presentation:new Map()};
    const context={id:c.id,revision:c.revision};
    const state={tool:"recordings",caseReview:{...context,bdd:createBdd(plan)}};
    let saved;
    let folderPrompts=0;
    const vscode={workspace:{},Uri:{file:fsPath=>({fsPath})},window:{
        async showOpenDialog() { folderPrompts++; return [{scheme:"file",fsPath:directory}]; },
    }};
    const bench={state,language:"en",caseLibrary:{async add(uri,entry) { saved={uri,entry}; }},async refreshCases(){}};
    const author=bench.caseAuthoring=new CaseAuthoring(bench,vscode);
    author.candidate=c;
    const editor=new CaseCompositionEditor(bench,vscode);
    const [first,middle,last]=steps.map((_,index)=>"steps[0].then["+index+"]");
    await editor.handle({action:"section",path:last,...context});
    assert.deepEqual(state.caseComposition.range.map(row=>row.path),[first,middle,last]);

    const {compositionPage,compositionInput,compositionClick}=await loadWebview("caseComposition");
    let page;
    const render=()=>{page=compositionPage(state,"en");};
    const select=(key,value)=>compositionInput({dataset:{composeField:key},value},render);
    render();
    assert.match(page,/<summary>1 step selected<\/summary>/);
    select("from",first);
    assert.match(page,/<summary>3 steps selected<\/summary>/);
    select("through",middle);
    assert.match(page,/<summary>2 steps selected<\/summary>/);

    const fields=new Map(Object.entries({from:first,through:middle,name:"Profile steps"})
        .map(([key,value])=>[`[data-compose-field="${key}"]`,{value}]));
    const button={dataset:{compose:"sectionSave"},closest:()=>({querySelector:selector=>fields.get(selector)})};
    let message;
    compositionClick(button,state,value=>{message=value;},render);
    await assert.rejects(editor.handle({...message,from:"steps[0].else[0]"}),/Choose a continuous range/);
    await assert.rejects(editor.handle({...message,through:"steps[0].then[3]"}),/Choose a continuous range/);
    assert.equal(folderPrompts,0);
    await editor.handle(message);
    assert.equal(saved.entry.section,true);
    assert.deepEqual(readWorkflow(await fs.readFile(saved.uri.fsPath,"utf8")).plan.steps,steps.slice(0,2));

    await editor.handle({action:"section",paths:[last,first],...context});
    assert.deepEqual(state.caseComposition.sectionPaths,[first,last]);
    render();
    assert.match(page,/<summary>2 steps selected<\/summary>/);
    assert.doesNotMatch(page,/data-compose-field="(?:from|through)"/);
    await editor.handle({action:"sectionSave",name:"Selected steps",...context});
    assert.deepEqual(readWorkflow(await fs.readFile(saved.uri.fsPath,"utf8")).plan.steps,[steps[0],steps[2]]);
    await editor.handle({action:"sectionSave",name:"Selected steps",...context});
    assert.equal(folderPrompts,2);

    await editor.handle({action:"section",paths:["goals[0]",middle,"steps[0]","preconditions[0]"],...context});
    assert.deepEqual(state.caseComposition.sectionPaths,["preconditions[0]","steps[0]","goals[0]"]);
    await editor.handle({action:"sectionSave",name:"All steps",...context});
    assert.deepEqual(readWorkflow(await fs.readFile(saved.uri.fsPath,"utf8")).plan,plan);

    c.presentation.set(plan.goals[0],{name:"Order confirmed"});
    await editor.handle({action:"section",path:"goals[0]",...context});
    assert.deepEqual(state.caseComposition.range.map(row=>row.path),["preconditions[0]","steps[0]","goals[0]"]);
    await editor.handle({action:"sectionSave",through:"goals[0]",name:"One check",...context});
    assert.deepEqual(readWorkflow(await fs.readFile(saved.uri.fsPath,"utf8")).plan.steps,[{assert:plan.goals[0]}]);
    await editor.handle({action:"section",paths:["goals[0]","preconditions[0]"],...context});
    await editor.handle({action:"sectionSave",name:"Two checks",...context});
    const standalone=readWorkflow(await fs.readFile(saved.uri.fsPath,"utf8")).plan;
    assert.deepEqual(standalone,{version:"1",steps:[{assert:plan.preconditions[0]},{assert:plan.goals[0]}]});
    const labels=createBdd(standalone,"en",undefined,restorePresentation(standalone,saved.entry.presentation)).steps;
    assert.deepEqual(labels.map(row=>row.role),["Given","Then"]);
    assert.equal(labels[1].name,"Order confirmed");
});

test("the same step actions duplicate, delete, undo and reorder checks throughout the visible sequence",async()=>{
    const initial=visible("login"),goal=visible("receipt"),press=tap("submit");
    const author=new CaseAuthoring({state:{tool:"recordings"},language:"en"},{});
    author.begin({name:"Order",plan:{version:"1",preconditions:[initial],steps:[press],goals:[goal]}});
    const c=author.candidate, ctx=()=>({id:c.id,revision:c.revision});
    c.presentation.set(c.plan.preconditions[0],{name:"Signed in",evidence:{control:"original"}});
    const act=(action,path)=>author.changeStep({action,path,...ctx()});
    await act("duplicate","preconditions[0]");
    assert.deepEqual(c.plan.preconditions,[initial,initial]);
    assert.deepEqual(c.presentation.get(c.plan.preconditions[1]),{name:"Signed in"});
    await act("remove","goals[0]");
    assert.deepEqual(c.plan.goals,[]);
    await act("undoRemove");
    assert.deepEqual(c.plan.goals,[goal]);
    await author.moveStep({...ctx(),from:"preconditions[1]",to:2,timeline:true});
    assert.deepEqual(c.plan,{version:"1",preconditions:[initial],steps:[press,{assert:initial}],goals:[goal]});
    assert.deepEqual(c.presentation.get(c.plan.steps[1]),{name:"Signed in",role:"Given"});
    await author.moveStep({...ctx(),from:"goals[0]",to:1,timeline:true});
    assert.deepEqual(c.plan,{version:"1",preconditions:[initial],steps:[{assert:goal},press,{assert:initial}],goals:[]});
    // Callers without a visible timeline index still address siblings inside their own list.
    await author.moveStep({...ctx(),from:"steps[0]",to:1});
    assert.deepEqual(c.plan.steps,[press,{assert:goal},{assert:initial}]);
});

test("deleting multiple case steps updates one draft and undoes the whole edit", async()=>{
    const plan={version:"1",preconditions:[visible("start")],steps:[
        tap("menu"),
        {if:visible("home"),then:[tap("one"),tap("two"),tap("three")],else:[tap("fallback")]},
        tap("back"),
    ]};
    const bench={state:{tool:"recordings"},language:"en"};
    const author=bench.caseAuthoring=new CaseAuthoring(bench,{});
    author.begin({name:"Example",plan});
    const c=author.candidate;
    const send=(action,paths)=>author.changeStep({id:c.id,revision:c.revision,action,paths});
    await assert.rejects(send("removeSelected",["steps[1].then[0]","steps[1].then[1]","steps[1].then[2]"]),/whole branch/);
    assert.deepEqual(c.plan,plan);
    assert.equal(c.revision,0);
    await send("removeSelected",["steps[2]","steps[1].then[1]","preconditions[0]","steps[0]","steps[1].else[0]"]);
    assert.equal(c.revision,1);
    assert.equal(bench.state.caseReview.undoRemove,true);
    assert.deepEqual(c.plan.preconditions,[]);
    assert.deepEqual(c.plan.steps,[{if:visible("home"),then:[tap("one"),tap("three")],else:[]}]);
    await send("undoRemove");
    assert.deepEqual(c.plan,plan);
    assert.equal(bench.state.caseReview.undoRemove,false);
    await send("removeSelected",["steps[1].then[0]","steps[1]","steps[0]","steps[2]"]);
    assert.deepEqual(c.plan.steps,[]);
    assert.equal(bench.state.caseReview.empty,true);
    await send("undoRemove");
    assert.deepEqual(c.plan,plan);
});

test("follow-up exploration starts at the scripted checkpoint and only proposes a new case",async()=>{
    const c={id:"profile",revision:0,plan:profile,name:"Profile",presentation:new Map()};
    const state={tool:"recordings",caseReview:{bdd:createBdd(profile)}};
    const author={candidate:c,stepDraft:async()=>c,update(){}};
    const editor=new CaseCompositionEditor({state,caseAuthoring:author,explorations:{history:async()=>{}}},{});
    const part={id:"profile",revision:0};
    await assert.rejects(editor.handle({action:"explore",path:"steps[7]",side:"after"}),/choose the position again/i);
    assert.equal(state.tool,"recordings");
    assert.equal(state.caseComposition,undefined);
    await editor.handle({action:"explore",path:"steps[0]",side:"after"});
    assert.equal(state.tool,"exploration");
    editor.draft.explore.progress=["Verified the cart"];
    editor.refresh();
    const {compositionPage}=await loadWebview("caseComposition");
    const model={...state,devices:[]};
    assert.match(compositionPage(model,"en"),/What should the new steps do or verify/);
    assert.match(compositionPage(model,"en"),/Replay and explore/);
    assert.doesNotMatch(compositionPage(model,"en"),/Current phone screen|Pick on phone preview|Find a past exploration|Insert at/);
    await editor.handle({action:"exploreMethod",method:"check",...part});
    assert.equal(state.caseComposition.method,"ai");
    assert.deepEqual(state.caseComposition.progress,["Verified the cart"]);
    editor.draft.explore.result={plan:{version:"1",steps:[{command:"back"}]}};
    editor.refresh();
    const review=compositionPage({...model,caseComposition:state.caseComposition},"en");
    assert.match(review,/Review new case/);
    assert.doesNotMatch(review,/Add to case draft/);
    await editor.handle({action:"addExplore",...part});
    assert.equal(c.revision,0);
    await editor.handle({action:"close",...part});
    assert.equal(state.tool,"recordings");
    assert.equal(state.caseComposition,undefined);
});

test("current-case exploration previews the gap, inserts observed steps once, and undoes to the dirty source",async()=>{
    const group={version:1,name:"Retry",rules:[{id:"retry",method:"GET",path:"/pay",steps:[{response:{status:503}}]}]};
    const plan={...profile,steps:[tap("open"),{ruleGroup:{action:"enable",scenario:group}},tap("pay"),
        {ruleGroup:{action:"disable",name:"Retry"}}]};
    const screen={frameId:"cart",quality:{complete:true},nodes:[{ref:"n1",id:"cart",text:"Cart",visible:true}]};
    const runs=[], actions=[];
    const state={tool:"recordings",device:"test-device"};
    const bench={state,language:"en",publish(){},sessionFor:()=>"workbench",
        modelAsk:async()=>async()=>JSON.stringify(actions.shift()),
        agent:{async call(command,params){
            if (command==="run") {runs.push(params.plan);return {status:"completed"};}
            if (command==="observe") return screen;
            if (command==="back") return {observation:screen,action:{dispatched:"acknowledged"}};
            return {};
        }}};
    const author=bench.caseAuthoring=new CaseAuthoring(bench,{});
    const editor=bench.composition=new CaseCompositionEditor(bench,{});
    author.begin({source:"workflow",name:"Original",plan});
    const c=author.candidate;
    c.name="My unsaved name";
    c.presentation.set(c.plan.steps[1],{name:"Start payment retry"});
    c.presentationChanged=true;
    author.update();
    const anchor={path:"steps[0]",side:"after"};
    const open=()=>editor.handle({action:"explore",destination:"current",id:c.id,revision:c.revision,...anchor});
    const send=(action,extra)=>editor.handle({action,id:c.id,revision:c.revision,viewId:editor.draft?.viewId,...extra});
    const explore=()=>{
        actions.push({action:"back",name:"Return to cart"},{action:"done",text:"Cart displayed"});
        return send("runExplore",{goal:"Return to cart"});
    };
    const before=c.plan, originalDisplay=c.presentation;
    const {compositionPage}=await loadWebview("caseComposition");
    const page=()=>compositionPage({...state,devices:[state.device]},"zh");
    await open();
    const closed=editor.draft.viewId;
    assert.equal(state.caseComposition.followUp.destination,"current");
    assert.equal(state.caseComposition.followUp.nextLabel,"Start payment retry");
    assert.match(page(),/用 AI 补充当前用例/);
    assert.match(page(),/原下一步<\/small><strong>Start payment retry/);
    await explore();
    assert.ok(state.caseComposition.result.steps.some(row=>row.text==="Return to cart"));
    const preview=page();
    assert.match(preview,/Return to cart[\s\S]*原下一步[\s\S]*本次探索未执行/);
    assert.match(preview,/data-compose="insertFollowUp"[^>]*>插入当前用例/);
    assert.doesNotMatch(preview,/核对新用例/);
    assert.equal(c.plan,before);
    await send("close");
    assert.equal(c.plan,before);
    assert.equal(state.tool,"recordings");
    await open();
    await explore();
    await send("insertFollowUp",{viewId:closed});
    await send("insertFollowUp",{revision:c.revision-1});
    await send("reviewFollowUp");
    assert.equal(c.plan,before);
    const revision=c.revision;
    await send("insertFollowUp");
    await editor.handle({action:"insertFollowUp",id:c.id,revision});
    assert.equal(author.candidate,c);
    assert.equal(state.tool,"recordings");
    assert.equal(c.name,"My unsaved name");
    assert.equal(c.revision,revision+1);
    assert.deepEqual(c.plan,{...before,steps:[before.steps[0],{command:"back",input:{}},...before.steps.slice(1)]});
    assert.equal(c.presentation.get(c.plan.steps[1]).name,"Return to cart");
    assert.equal(c.presentation.get(c.plan.steps[2]).name,"Start payment retry");
    assert.deepEqual(runs.map(run=>run.steps),[[tap("open")],[tap("open")]]);
    assert.equal(state.caseReview.insertionUndo,"steps[1]");
    assert.deepEqual(editor.undoInsertion({id:c.id,revision:c.revision}),{path:"steps[0]"});
    assert.equal(c.plan,before);
    assert.equal(c.presentation,originalDisplay);
    assert.ok(state.caseReview.dirty);
});

test("inline insertion searches case names, indexed case details, and rule group names",async()=>{
    const {insertionMatches}=await loadWebview("caseInsert");
    const cases=[{id:"later",name:"Account overview"},{id:"login",name:"登录测试账号"},
        {id:"blocked",name:"登录",tags:["登录"]},{id:"device",name:"Activate device",tags:["smoke"]}];
    const index=new Map([["later",{search:"登录确认 Save profile"}],["blocked",{issue:"cycle"}]]);
    assert.deepEqual(insertionMatches(cases,new Map(),"登录").map(row=>row.id),["blocked","login"]);
    assert.deepEqual(insertionMatches(cases,index,"登录").map(row=>row.id),["login","later","blocked"]);
    assert.equal(insertionMatches(cases,index,"ＳＭＯＫＥ")[0].id,"device");
    const groups=[{id:"retry",name:"Checkout Retry"},{id:"timeout",name:"库存接口超时"},
        {id:"fast",name:"Retry Checkout fast"}];
    assert.deepEqual(insertionMatches(groups,undefined,"Ｒｅｔｒｙ").map(row=>row.id),["fast","retry"]);
    assert.deepEqual(insertionMatches(groups,undefined,"接口超时").map(row=>row.id),["timeout"]);
    assert.deepEqual(insertionMatches(groups,undefined,"限流"),[]);
});

test("selected steps can start a new case in timeline order with a clear reason for nested selections",async()=>{
    const {stepSelectionFor,stepSelectionControls}=await loadWebview("caseSelection");
    const {listSelectionClick}=await loadWebview("ui/listSelection");
    const plan={...profile,steps:[tap("cart"),{if:visible("retry"),then:[tap("again")]},tap("finish")]};
    const bdd=createBdd(plan,"en");
    const model={plan:{uri:"file:///profile"},planDigest:"original",caseBdd:bdd};
    const selection=stepSelectionFor(model,true);
    const sent=[],w=(_en,zh)=>zh;
    const submit=()=>listSelectionClick({dataset:{listName:"case-steps",listAction:"fork"}},message=>sent.push(message));
    selection.start();
    selection.selected=new Set(["goals[0]","steps[1].then[0]","steps[1]","preconditions[0]"]);
    assert.match(stepSelectionControls(selection,w,model),/用所选步骤新建用例/);
    submit();
    assert.deepEqual(sent,[{type:"caseCompose",action:"forkCase",id:undefined,revision:undefined,uri:model.plan.uri,digest:model.planDigest,
        paths:["preconditions[0]","steps[1]","steps[1].then[0]","goals[0]"]}]);
    model.caseReview={id:"draft",revision:4,bdd};
    stepSelectionFor(model,true);
    selection.start();
    selection.selected=new Set(["steps[1].then[0]"]);
    assert.match(stepSelectionControls(selection,w,model),/勾选它们所属的顶层分组/);
    assert.equal(selection.actions.get("save").disabled,false);
    submit();
    assert.equal(sent.length,1);
    selection.selected=new Set(["steps[2]","steps[0]"]);
    stepSelectionControls(selection,w,model);
    submit();
    assert.deepEqual(sent[1],{type:"caseCompose",action:"forkCase",id:"draft",revision:4,uri:model.plan.uri,digest:model.planDigest,
        paths:["steps[0]","steps[2]"]});
    selection.reset();
});

test("inline preview guards the selected revision and undo restores exactly the prior draft",async()=>{
    const uri="file:///fixtures/profile/workflow.json";
    const original={...profile,steps:[{if:visible("home"),then:[tap("profile")]}]};
    const c={id:"profile",revision:4,plan:original,presentation:new Map(),name:"Profile",reordered:true};
    const source={id:"login",caseId:"login",portableId:"login",name:"Sign in",location:"login/workflow.json",uri:"file:///login",
        plan:signIn,digest:link.useCase.digest};
    const state={tool:"recordings",plan:{uri},cases:[source],caseReview:{bdd:createBdd(original)}};
    const author={candidate:c,stepDraft:async()=>c,update(){state.caseReview.bdd=createBdd(c.plan);}};
    const editor=new CaseCompositionEditor({state,caseAuthoring:author},{});
    editor.readSource=async()=>source;
    const anchor={uri,id:c.id,revision:4,path:"steps[0].then[0]",side:"before",sourceId:source.id};
    const changed=await editor.applyInsertion({...anchor,sourceDigest:"an earlier version"});
    assert.equal(changed.changed,true);
    assert.equal(c.plan,original);
    const inserted=await editor.applyInsertion({...anchor,sourceDigest:source.digest});
    assert.equal(inserted.path,"steps[0].then[0]");
    assert.equal(c.plan.steps[0].then[0].useCase.caseId,"login");
    assert.equal(referenceStatus(c.plan.steps[0].then[0].useCase,editor.sources).status,"current");
    assert.equal(c.plan.steps[0].then[1].input.target.id,"profile");
    assert.deepEqual(editor.undoInsertion({id:c.id,revision:4}),{});
    assert.deepEqual(editor.undoInsertion({id:c.id,revision:5}),{path:"steps[0].then[0]"});
    assert.equal(c.plan,original);
    assert.equal(c.reordered,true);
    assert.equal(c.added,undefined);
});
