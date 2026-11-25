"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {fileURLToPath,pathToFileURL}=require("node:url");
const {CaseCompositionEditor}=require("../src/caseCompositionEditor");
const {CaseAuthoring}=require("../src/caseAuthoring");
const {readCaseMetadata,writeCaseMetadata,createBdd}=require("../src/caseLibrary");
const {compileCase,compositionRecord,authoredDocument}=require("../src/caseComposition");
const {storePresentation}=require("../src/casePresentation");
const {readWorkflow}=require("../src/workflowFile");
const {sourceDigest}=require("../src/caseRepair");
const loadMedia=require("../test-support/loadWebview");

const press=id=>({command:"press",input:{target:{id}}});
const check=id=>({selector:{id},property:"visible",equals:true});
const fileUri=filename=>({scheme:"file",fsPath:filename,toString:()=>pathToFileURL(filename).href});

async function fixture(t) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"ha-fork-"));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const vscode={Uri:{file:fileUri,parse:address=>fileUri(fileURLToPath(address))},
        workspace:{workspaceFolders:[{uri:fileUri(root)}],openTextDocument:async uri=>{
            const text=await fs.readFile(uri.fsPath,"utf8");
            return {getText:()=>text};
        }},window:{showOpenDialog:async()=>[fileUri(root)]}};
    const bench={language:"zh",state:{tool:"recordings",cases:[]},networks:{},caseLibrary:{add:writeCaseMetadata},
        refreshCases:async()=>{},setPlan:async uri=>{bench.selected=uri;}};
    const author=bench.caseAuthoring=new CaseAuthoring(bench,vscode);
    const editor=bench.composition=new CaseCompositionEditor(bench,vscode);
    const fork=fields=>editor.handle({action:"forkCase",...fields});
    return {root,bench,author,fork};
}

test("copy a nonconsecutive selection from an edited draft, save as a separate case and return to the editor",async t=>{
    const {author,bench,fork}=await fixture(t);
    const branch={if:check("ready"),then:[press("open")],else:[press("close")]};
    const reference={useCase:{caseId:"setup-case",name:"Prepare order",plan:{version:"1",steps:[press("prepare")]}}};
    const plan={version:"2",preconditions:[check("first"),check("second")],
        steps:[branch,press("skip"),reference,press("skip2")],goals:[check("unused"),check("result")]};
    author.begin({name:"Edited source",source:"workflow",plan,group:{name:"Rules",version:1,rules:[]}});
    const parent=author.candidate;
    parent.presentation.set(parent.plan.steps[0].then[0],{name:"Nested name",description:"Nested description",role:"Given"});
    parent.presentation.set(parent.plan.steps[2],{name:"Reuse setup"});
    parent.presentation.set(parent.plan.goals[1],{name:"Custom goal",role:"When"});
    parent.presentationChanged=true;
    author.update();
    const message={id:parent.id,revision:parent.revision,
        paths:["goals[1]","steps[2]","steps[0].then[0]","preconditions[1]","steps[0]","steps[0]"]};
    await fork({...message,revision:parent.revision+1});
    assert.equal(author.candidate,parent);
    await assert.rejects(fork({...message,paths:["steps[0].then[0]","steps[2]"]}),/整个条件/);
    await fork(message);
    const first=author.candidate;
    assert.notEqual(first.id,parent.id);
    assert.equal(first.edit,undefined);
    assert.deepEqual(first.plan.steps,[branch,reference]);
    assert.deepEqual(first.plan.preconditions,[check("second")]);
    assert.deepEqual(first.plan.goals,[check("result")]);
    assert.deepEqual(first.group,parent.group);
    assert.notEqual(first.group,parent.group);
    assert.equal(first.presentation.get(first.plan.goals[0]).role,"When");
    assert.equal(first.presentation.get(first.plan.steps[0].then[0]).description,"Nested description");
    assert.equal(first.presentation.get(first.plan.steps[1]).name,"Reuse setup");
    const {caseReviewView}=await loadMedia("caseAuthoring");
    const rendered=caseReviewView(bench.state,"zh","source report must stay hidden");
    assert.match(rendered,/复制自「Edited source」 · 已复制选中的 4 步/);
    assert.doesNotMatch(rendered,/source report must stay hidden/);
    first.plan.steps[0].then[0].input.target.id="new";
    author.cancel();
    assert.equal(author.candidate,parent);
    assert.deepEqual(parent.plan,plan);
    await fork(message);
    const copy=author.candidate;
    await author.save({id:copy.id,name:copy.name});
    assert.equal(author.candidate,parent);
    assert.equal(bench.selected,undefined);
    assert.deepEqual(parent.plan,plan);
    const metadata=await readCaseMetadata(copy.uri), saved=readWorkflow(await fs.readFile(copy.uri.fsPath,"utf8"));
    assert.equal(metadata.origin.parentCaseName,parent.name);
    assert.equal(metadata.origin.forkPosition,"已复制选中的 4 步");
    const restored=authoredDocument(saved,metadata);
    assert.deepEqual(restored.plan.steps,[branch,reference]);
    assert.equal(restored.presentation.get(restored.plan.steps[1]).name,"Reuse setup");
});

test("copying a boundary needs no runnable prefix and keeps linear wrapper presentation",async t=>{
    const {author,fork,bench}=await fixture(t);
    const pending={description:{id:"pending",text:"待实现"}};
    const wrapper={description:{id:"group",text:"线性操作",steps:[press("one"),press("two")]}};
    const plan={version:"2",steps:[pending,{stop:{reason:"done"}},wrapper,{if:check("ok"),then:[press("branch")]}]};
    author.begin({source:"workflow",name:"Source",plan});
    const c=author.candidate;
    c.presentation.set(c.plan.steps[2],{name:"Description group",role:"Then"});
    author.update();
    const child=bench.state.caseReview.bdd.steps[3].branches[0].steps[0];
    assert.match(child.exploration.before.copyReason,/条件或循环/);
    assert.match(child.exploration.after.copyReason,/条件或循环/);
    const message={id:c.id,revision:c.revision,side:"after"};
    await assert.rejects(fork({...message,path:child.path}),/条件、循环/);
    assert.equal(author.candidate,c);
    assert.equal(bench.state.caseReview.bdd.steps[2].exploration.after.copyReason,undefined);
    await fork({...message,path:"steps[2].description.steps[0]"});
    const copy=author.candidate;
    assert.deepEqual(copy.plan.steps,[pending,plan.steps[1],{description:{...wrapper.description,steps:[press("one")]}}]);
    assert.equal(copy.presentation.get(copy.plan.steps[2]).name,"Description group");
    assert.equal(bench.state.caseReview.issue,"description");
    assert.match(bench.state.caseReview.origin.forkPosition,/one/);
});

test("copying a step without its input read stays editable and names the missing variable",async t=>{
    const {author,bench,fork}=await fixture(t);
    const read={read:{name:"orderNumber",selector:{id:"number"},property:"text"}};
    const fill={command:"fill",input:{target:{id:"search"},text:{concat:["Order ",{var:"orderNumber"}]}}};
    author.begin({source:"workflow",name:"Find order",plan:{version:"2",steps:[read,fill]}});
    const parent=author.candidate;
    await fork({id:parent.id,revision:parent.revision,paths:["steps[1]"]});
    const copy=author.candidate;
    assert.deepEqual(copy.plan.steps,[fill]);
    assert.deepEqual(bench.state.caseReview.missingReads,["orderNumber"]);
    const {caseReviewView}=await loadMedia("caseAuthoring");
    assert.match(caseReviewView(bench.state,"zh"),/\$orderNumber。请在使用前/);
    copy.plan.steps.unshift(read);
    author.update();
    assert.equal(bench.state.caseReview.missingReads,undefined);
});

test("copy a verified saved source without entering its editor and give the new case a fresh portable id",async t=>{
    const {root,author,bench,fork}=await fixture(t);
    const source=fileUri(path.join(root,"workflow.json"));
    const plan={version:"1",preconditions:[check("begin")],steps:[
        {description:{id:"setup",text:"Prepare",steps:[press("home"),press("open")]}},press("unused")],goals:[check("end")]};
    const display=new Map([[plan.steps[0],{name:"Setup",role:"Given"}]]);
    const compiled=compileCase(plan);
    const text=JSON.stringify(compiled.plan);
    await fs.writeFile(source.fsPath,text);
    const meta=await writeCaseMetadata(source,{name:"Source",source:"workflow",
        composition:[compositionRecord(plan,compiled.plan,storePresentation(plan,display))]});
    const uri=source.toString(),digest=sourceDigest(text);
    Object.assign(bench.state,{plan:{uri,name:"Source"},activeCase:{uri,portableId:meta.id},
        planDigest:digest,caseBdd:createBdd(plan,"zh",undefined,display,compiled)});
    const message={uri,digest,path:"steps[0]",side:"after"};
    await fork({...message,uri:"elsewhere"});
    await fork({...message,digest:"stale"});
    assert.equal(author.candidate,undefined);
    await fs.writeFile(source.fsPath,text+" ");
    await assert.rejects(fork(message),/用例已更新/);
    assert.equal(author.candidate,undefined);
    await fs.writeFile(source.fsPath,text);
    const originalMeta=await fs.readFile(source.fsPath+".harmony-case.json","utf8");
    await fork(message);
    const copy=author.candidate;
    assert.deepEqual(copy.plan.steps,[plan.steps[0]]);
    assert.deepEqual(copy.plan.preconditions,plan.preconditions);
    assert.deepEqual(copy.plan.goals,[]);
    assert.equal(copy.origin.parentCaseId,meta.id);
    assert.equal(copy.origin.parentCaseDigest,digest);
    assert.equal(copy.origin.forkPosition,"Setup 之后");
    assert.equal(copy.presentation.get(copy.plan.steps[0]).role,"Given");
    await author.save({id:copy.id,name:copy.name});
    const newMeta=await readCaseMetadata(bench.selected);
    assert.notEqual(newMeta.id,meta.id);
    assert.equal(newMeta.origin.parentCaseId,meta.id);
    assert.equal(await fs.readFile(source.fsPath,"utf8"),text);
    assert.equal(await fs.readFile(source.fsPath+".harmony-case.json","utf8"),originalMeta);
});

test("an empty starting position stays empty and copied Given or Then checks alone can save and reopen",async t=>{
    const {author,fork,bench}=await fixture(t);
    author.begin({source:"workflow",name:"Source",plan:{version:"1",preconditions:[check("start")],
        steps:[press("home")],goals:[check("result"),check("done")]}});
    const c=author.candidate;
    c.presentation.set(c.plan.preconditions[0],{name:"Starting check",description:"Ready to run"});
    c.presentation.set(c.plan.goals[0],{name:"Result check"});
    author.update();
    const message={id:c.id,revision:c.revision,path:"preconditions[0]"};
    await fork({...message,side:"before"});
    assert.deepEqual(author.candidate.plan.steps,[]);
    assert.deepEqual(author.candidate.plan.preconditions,[]);
    assert.equal(author.candidate.origin.forkPosition,"用例起点");
    author.cancel();
    for (const [selection,expected,role,name] of [
        [{...message,side:"after"},check("start"),"Given","Starting check"],
        [{...message,paths:["goals[1]","goals[0]"]},check("result"),"Then","Result check"]]) {
        await fork(selection);
        const copy=author.candidate;
        assert.deepEqual(copy.plan.steps,[{assert:expected}]);
        assert.equal(bench.state.caseReview.empty,false);
        assert.equal(bench.state.caseReview.bdd.steps[0].role,role);
        await author.save({id:copy.id,name:copy.name});
        assert.equal(author.candidate,c);
        assert.deepEqual(c.plan.preconditions,[check("start")]);
        const meta=await readCaseMetadata(copy.uri);
        const saved=authoredDocument(readWorkflow(await fs.readFile(copy.uri.fsPath,"utf8")),meta);
        assert.deepEqual(saved.plan.steps,[{assert:expected}]);
        assert.equal(saved.presentation.get(saved.plan.steps[0]).name,name);
        assert.equal(createBdd(saved.plan,"zh",undefined,saved.presentation).steps[0].role,role);
        if (role==="Then") assert.deepEqual(saved.plan.goals,[check("done")]);
    }
});
