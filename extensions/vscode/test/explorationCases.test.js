"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {pathToFileURL,fileURLToPath} = require("node:url");
const {explorationCandidate,caseRoutes} = require("../src/explorationCases");
const {CaseAuthoring,caseDefinitions} = require("../src/caseAuthoring");
const {sourceDigest} = require("../src/caseRepair");
const {CaseLibrary,writeCaseMetadata} = require("../src/caseLibrary");
const {restorePresentation} = require("../src/casePresentation");
const {findCase} = require("../src/pytestCase");
const {messagesFor} = require("../src/strings");
const loadMedia = require("../test-support/loadWebview");

const press = id=>({command:"press",input:{target:{id}}});
const condition = id=>({selector:{id},property:"visible",equals:true});
const group = {version:1,name:"Stock",rules:[]};
function free() {
    const steps = ["Products","Details","Unknown"].map((id,index)=>({
        id,runId:"run-"+index,phase:"free",label:id,entryId:"entry-"+id,status:"completed",
        fromStateId:"page"+index,toStateId:"page"+(index+1),before:"before"+index,after:"after"+index,
        receipts:[{path:"steps[0]",command:"press",status:"completed",dispatched:index===2?"unknown":"acknowledged"}],
        replayStep:press(id)
    }));
    const pages = steps.map(step=>({states:[{id:step.fromStateId,entries:[
        {id:step.entryId,...press(step.id)}]}]}));
    return {id:"trace",mode:"free",status:"blocked",goal:"Browse products",steps,pages,bundle:"fixture.shop",
        mockScenario:group,branches:[],findings:[{kind:"review",id:"review",title:"Product page did not change",stepId:"Details"}]};
}

test("a free result offers only a contiguous acknowledged prefix; a review finding stays unverified", () => {
    const r=free();
    delete r.steps[0].replayStep; // Reports from 0.16 recover the selected command from the recorded state.
    assert.deepEqual(caseRoutes(r).stepIds,["Products","Details"]);
    assert.equal(explorationCandidate(r,{stepId:"Unknown"}),undefined);
    const candidate=explorationCandidate(r,{findingId:"review"});
    assert.deepEqual(candidate.plan.steps.map(s=>s.input.target),[
        {id:"Products",bundleName:"fixture.shop"},{id:"Details",bundleName:"fixture.shop"}]);
    assert.equal(candidate.plan.goals,undefined);
    assert.equal(candidate.origin.outcome,"review");
    assert.deepEqual(candidate.frames,{start:{runId:"run-0",frame:"before0"},goal:{runId:"run-1",frame:"after1"}});
    r.steps[1].fromStateId="external";
    assert.equal(explorationCandidate(r,{findingId:"review"}),undefined);
});

test("a successful observed variation from 0.16 preserves original prefix, detour, confirmed return, suffix and checks", () => {
    const plan={version:"1",steps:[press("Menu"),press("Catalog")],preconditions:[condition("Home")],goals:[condition("CatalogList")]};
    const r={id:"flow",mode:"flow",goal:"Catalog",status:"completed",bundle:"fixture.shop",plan,pages:[],findings:[],
        branches:[{id:"baseline",status:"passed"},{id:"branch",status:"passed",checkpoint:0,label:"Help detour",
            choice:{strategy:"detour",step:press("Help")}}],steps:[
            {key:"baseline",runId:"base",status:"completed",before:"home"},
            {key:"branch/act",status:"completed"},{key:"branch/return",status:"completed"},
            {key:"branch/suffix",runId:"end",status:"completed",after:"catalog"}]};
    const c=explorationCandidate(r,{branchId:"branch"});
    assert.deepEqual(c.plan.steps.map(s=>s.input?.target?.id || s.command),["Menu","Help","back","Catalog"]);
    assert.equal(c.plan.goals[0].selector.id,"CatalogList");
    assert.equal(c.origin.outcome,"checksPassed");
    r.findings.push({id:"failure",kind:"failure",stepId:"failed",title:"Catalog is missing",plan,expected:true,actual:false});
    const failed=explorationCandidate(r,{findingId:"failure"});
    assert.equal(failed.plan.goals[0].equals,true);
    assert.equal(failed.origin.outcome,"checkFailed");
    r.status="running";
    assert.equal(explorationCandidate(r,{branchId:"branch"}),undefined);
});

function uri(filename) {
    return {scheme:"file",fsPath:filename,path:filename,toString:()=>pathToFileURL(filename).href};
}
async function host(t) {
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),"ha-case-author-"));
    t.after(()=>fs.rm(directory,{recursive:true,force:true}));
    const calls=[], inputs=[], picks=[], folders=[];
    const vscode={Uri:{file:uri,parse:value=>uri(fileURLToPath(value))},workspace:{workspaceFolders:[{uri:uri(directory)}]},
        window:{showOpenDialog:async()=>folders.shift(),showInputBox:async()=>inputs.shift(),
            showQuickPick:async rows=>rows[picks.shift()]}};
    const b={language:"zh",state:{},networks:{},stateDir:directory,
        caseLibrary:{updateMetadata:CaseLibrary.prototype.updateMetadata,
            async add(file,meta){await writeCaseMetadata(file,meta);calls.push("index");}},
        async refreshCases(){calls.push("refresh");},async setPlan(file){calls.push("open");b.selected=file;}};
    const author=new CaseAuthoring(b,vscode);
    return {directory,b,author,calls,inputs,picks,folders};
}

test("free exploration is reviewable with BDD, users can supply boundary checks, and a portable runnable case retains lineage", async t => {
    const {directory,b,author,calls,folders}=await host(t);
    const c=explorationCandidate(free(),{findingId:"review"});
    c.nodes=side=>[{label:side==="start"?"Home":"Product count",selector:{id:side}}];
    author.begin(c);
    const id=b.state.caseReview.id;
    const {caseReviewView}=await loadMedia("caseAuthoring");
    const render=()=>caseReviewView(b.state,b.language);
    assert.deepEqual([...render().matchAll(/data-bdd-role="(\w+)"/g)].map(match=>match[1]),["Given","When","When"]);
    assert.match(render(),/保存用例草稿/);
    assert.match(render(),/预期结果需要确认/);
    await author.save({id}); // cancel the directory dialog
    assert.equal(b.state.caseReview.id,id);
    await author.loadTargets({id,area:"start"});
    assert.deepEqual(b.state.caseReview.targets.start,[{key:"0",label:"Home"}]);
    author.edit({id,revision:0,area:"start",index:0,target:"0",property:"visible",expected:"true"});
    author.edit({id,revision:0,area:"goal",index:0,target:"manual",controlId:"obsolete",property:"visible",expected:"true"});
    assert.equal(b.state.caseReview.issue,"goal");
    author.edit({id,revision:1,area:"goal",index:0,target:"manual",controlId:"goal",property:"text",expected:"5"});
    author.edit({id,revision:2,area:"name",name:"Browse products"});
    assert.equal(b.state.caseReview.issue,undefined);
    assert.match(render(),/下次运行时验证/);
    assert.match(render(),/Stock/);
    folders.push([uri(directory)]);
    await author.save({id,name:"Browse products"});
    assert.deepEqual(calls,["index","refresh","open"]);
    const file=JSON.parse(await fs.readFile(b.selected.fsPath,"utf8"));
    const metadata=JSON.parse(await fs.readFile(b.selected.fsPath+".harmony-case.json","utf8"));
    assert.equal(file.scenario.name,"Stock");
    assert.equal(file.workflow.goals[0].equals,"5");
    assert.equal(metadata.source,"exploration");
    assert.equal(metadata.origin.findingId,"review");
    assert.ok(await findCase(b.selected));
    assert.equal(b.state.caseReview,undefined);
});

test("a failed replay uses its frozen workflow, and a gesture report keeps only acknowledged actions and recorded delays", async t => {
    const {directory,b,author,folders,inputs}=await host(t);
    const runId="version-one", base=path.join(directory,"runs",runId);
    await fs.mkdir(base,{recursive:true});
    await fs.writeFile(path.join(base,"plan.json"),JSON.stringify({version:"1",steps:[press("Original")],
        preconditions:[condition("Home")],goals:[condition("Success")]}));
    b.planForRun=()=>({name:"Order",uri:uri(path.join(directory,"edited.json")).toString()});
    b.state.run={entry:{id:runId,plan:b.planForRun()},steps:[{}],goalStatus:"failed"};
    await author.open({fromRun:true});
    assert.equal(b.state.caseReview.origin.outcome,"checkFailed");
    assert.match(JSON.stringify(b.state.caseReview.bdd),/Original/);
    author.cancel();
    b.state.run={entry:{id:"touch-run",source:"device",plan:{name:"Touch"},gestureTimingVersion:1},
        steps:[{status:"completed",dispatched:"acknowledged",gesture:{kind:"click",x:10,y:40},delayMs:450},
            {status:"unknown",gesture:{kind:"back"}}]};
    await author.open({fromRun:true});
    assert.equal(b.state.caseReview.issue,"gestures");
    const id=b.state.caseReview.id;
    folders.push([uri(directory)]); inputs.push("Touch path");
    await author.save({id});
    const saved=JSON.parse(await fs.readFile(b.selected.fsPath,"utf8"));
    assert.equal(saved.steps.length,1);
    assert.equal(saved.steps[0].delayMs,450);
    assert.equal(await findCase(b.selected),undefined);
});

test("AI organizes nested BDD steps without changing the pytest workflow or sending entered and expected values", async t=>{
    const {directory,b,author,folders}=await host(t);
    const plan = {version:"1",preconditions:[condition("Cart")],steps:[
        {if:condition("Guest"),then:[{command:"fill",input:{target:{id:"customer",text:"Customer name"},text:"entered-value"}}]},
        press("Confirm order"),
    ],goals:[{selector:{id:"receipt"},property:"text",equals:"customer-order-value"}]};
    const proposal = [{path:"steps[0]",name:"Handle guest checkout",group:"Prepare order"},
        {path:"steps[0].then[0]",name:"Enter the customer name",role:"Given"},
        {path:"steps[1]",name:"Submit the order",group:"Place order",input:{target:{id:"invented"}}}];
    b.language="en";
    b.publish=()=>{};
    b.modelAsk=async()=>async prompt=>{
        assert.match(prompt,/Customer name/);
        assert.match(prompt,/receipt/);
        assert.doesNotMatch(prompt,/entered-value|customer-order-value/);
        const data=JSON.parse(prompt.split("\n").at(-1));
        assert.deepEqual(data.purpose,["Guest checkout"]);
        assert.equal(data.steps[1].to,undefined);
        assert.equal(data.steps[2].from,"Order review");
        assert.equal(data.steps[2].to,"Receipt");
        assert.deepEqual(data.steps[0].condition,{property:"visible",control:"Guest",expected:true});
        return JSON.stringify({steps:proposal});
    };
    author.begin({name:"Guest checkout",plan,source:"recording",stepEvidence:{
        "steps[0].then[0]":{to:"entered-value"},
        "steps[1]":{from:"Order review",to:"Receipt"},
    }});
    const id=b.state.caseReview.id;
    await author.organize({id,revision:0});
    const {caseReviewView}=await loadMedia("caseAuthoring");
    const view=caseReviewView(b.state,"en");
    assert.match(view,/<h3 class="case-step-group">Prepare order<\/h3>/);
    assert.doesNotMatch(view,/class="case-step-group">Place order/);
    assert.match(view,/Enter the customer name/);
    assert.match(view,/Tap Confirm order/);
    assert.deepEqual(author.candidate.plan,plan);
    b.modelAsk=async()=>async()=>JSON.stringify({steps:[...proposal].reverse()});
    await author.organize({id,revision:1});
    assert.ok(b.state.caseReview.organization.error);
    assert.equal(b.state.caseReview.bdd.steps.find(row=>row.path==="steps[1]").name,"Submit the order");
    b.modelAsk=async()=>async()=>JSON.stringify({steps:proposal.map(step=>step.path==="steps[1]" ? {...step,role:"Then"} : step)});
    await author.organize({id,revision:1});
    assert.ok(b.state.caseReview.organization.error);
    assert.equal(b.state.caseReview.bdd.steps.find(row=>row.path==="steps[1]").role,"When");

    folders.push([uri(directory)]);
    await author.save({id,name:"Guest checkout"});
    const saved=JSON.parse(await fs.readFile(b.selected.fsPath,"utf8"));
    assert.deepEqual(saved,plan);
    assert.ok(await findCase(b.selected));
    const {presentation}=JSON.parse(await fs.readFile(b.selected.fsPath+".harmony-case.json","utf8"));
    assert.equal(restorePresentation(saved,presentation).get(saved.steps[1]).name,"Submit the order");
    assert.deepEqual(restorePresentation(saved,presentation).get(saved.steps[1]).evidence,{from:"Order review",to:"Receipt"});
    assert.equal(restorePresentation(saved,presentation).get(saved.steps[0].then[0]).role,"Given");
    saved.steps.reverse();
    assert.equal(restorePresentation(saved,presentation).get(saved.steps[0]),undefined);
});

test("named steps can use observed compatible locators, be duplicated and restored after deletion", async t=>{
    const {directory,b,author,folders}=await host(t);
    const plan={version:"1",steps:[press("old"),{command:"back",input:{}}]};
    b.state.device="phone";
    b.state.devices=["phone"];
    b.text={};
    const calls=[];
    const bounds={left:10,top:40,right:65,bottom:70};
    b.agent={call:async command=>{calls.push(command);return {path:"current.png"};}};
    b.image=picture=>"webview/"+picture;
    b.livePanel={async withDeviceOperation(read) {calls.push("begin");await read();calls.push("end");}};
    b.observe=async(current,full)=>{
        assert.equal(current(),true);
        assert.equal(full,true);
        calls.push("observe");
        b.state.page={complete:true,nodes:[
            {label:"Pay now",id:"pay",pressable:true,visible:true,selector:{id:"pay"},attributes:{id:"pay"},bounds},
            {label:"Amount",id:"amount",pressable:false,editable:true,selector:{id:"amount"},
                attributes:{id:"amount",hint:"Amount",editable:true,type:"TextInput"},bounds},
            {label:"Shipping",ref:"shipping",attributes:{id:"shipping"},bounds},
            {label:"Express",ref:"express",attributes:{id:"express"},bounds},
            {label:"Continue",parent:"shipping",attributes:{id:"continue",text:"Continue",type:"Text"},bounds},
            {label:"Continue",parent:"express",attributes:{id:"continue",text:"Continue",type:"Text"},bounds},
            {label:"Disabled panel",ref:"disabled",attributes:{id:"disabled",enabled:false},bounds},
            {label:"Submit",parent:"disabled",attributes:{id:"submit"},bounds},
        ]};
    };
    author.begin({name:"Checkout steps",plan,source:"workflow"});
    const id=b.state.caseReview.id, step="steps[0]";
    const current=()=>({id,revision:b.state.caseReview.revision});
    await author.edit({...current(),area:"stepName",path:step,name:"Submit payment",group:"Checkout"});
    await author.loadTargets({...current(),area:"step",path:step,live:true,pick:true});
    assert.deepEqual(calls,["begin","observe","screenshot","end"]);
    assert.deepEqual(b.state.caseReview.stepTargets.matches,{count:0,complete:true});
    assert.deepEqual(b.state.caseReview.stepTargets.choices.map(choice=>choice.label),["Pay now","Amount","Shipping","Express","Continue","Continue"]);
    const nested = b.state.caseReview.stepTargets.choices.filter(choice=>choice.label==="Continue").map(choice=>JSON.parse(choice.locator));
    assert.deepEqual(nested,[{id:"continue",within:{id:"shipping"}},{id:"continue",within:{id:"express"}}]);
    assert.deepEqual(b.state.caseReview.stepTargets.choices[0].bounds,bounds);
    const picture=b.state.caseReview.stepTargets.picture;
    assert.equal(picture.src,"webview/current.png");
    assert.equal(author.endPick({...current(),picture:"stale"}),false);
    assert.equal(author.endPick({...current(),picture:picture.id}),true);
    assert.equal(b.state.caseReview.stepTargets.picture,undefined);
    await author.edit({...current(),area:"step",path:step,target:"0"});
    assert.deepEqual(author.candidate.plan.steps[0].input.target,{id:"pay"});
    await author.changeStep({...current(),action:"duplicate",path:step});
    await author.changeStep({...current(),action:"remove",path:step});
    assert.equal(b.state.caseReview.bdd.steps.length,2);
    assert.equal(b.state.caseReview.undoRemove,true);
    await author.changeStep({...current(),action:"undoRemove"});
    await author.moveStep({...current(),from:"steps[2]",to:0});
    assert.deepEqual(b.state.caseReview.bdd.steps.map(row=>row.name),[undefined,"Submit payment","Submit payment"]);
    folders.push([uri(directory)]);
    await author.save({id,name:"Checkout steps"});
    const saved=JSON.parse(await fs.readFile(b.selected.fsPath,"utf8"));
    const {presentation}=JSON.parse(await fs.readFile(b.selected.fsPath+".harmony-case.json","utf8"));
    assert.deepEqual([...restorePresentation(saved,presentation).values()].map(entry=>entry.group),["Checkout","Checkout"]);
});

test("a case can edit action parameters and insert an operation while preserving existing conditions", async t=>{
    const {directory,b,author,folders} = await host(t);
    const start = condition("cart"), goal = condition("receipt");
    const fill = {command:"fill",before:[start],input:{target:{id:"search"},text:"already saved",expect:goal}};
    author.begin({name:"Search",source:"workflow",plan:{version:"1",preconditions:[start],steps:[fill],goals:[goal]}});
    const edit = fields=>author.edit({id:b.state.caseReview.id,revision:b.state.caseReview.revision,area:"stepOperation",path:"steps[0]",...fields});
    assert.doesNotMatch(JSON.stringify(b.state.caseReview.definitions),/already saved/);
    await edit({command:"fill",target:"keep",replaceInput:false,text:"unused",timeout:"1200"});
    assert.equal(author.candidate.plan.steps[0].input.text,"already saved");
    await edit({command:"fill",target:"manual",locatorField:"id",controlId:"search-v2",replaceInput:true,text:"test input",timeout:"1200"});
    await edit({add:true,command:"wait",target:"manual",locatorField:"id",controlId:"suggestion",property:"visible",expected:"true",timeout:"2000"});
    await edit({command:"wait",target:"keep",property:"visible",expected:"true"});
    assert.equal(author.candidate.plan.steps[0].command,"fill");
    const original = author.candidate.plan;
    assert.deepEqual(original.steps,[{...fill,input:{target:{id:"search-v2"},text:"test input",timeout_ms:1200,expect:goal}},
        {command:"wait",input:{target:{id:"suggestion"},property:"visible",equals:true,timeout_ms:2000}}]);
    assert.deepEqual([original.preconditions,original.goals],[[start],[goal]]);
    folders.push([uri(directory)]);
    await author.save({id:b.state.caseReview.id,name:"Search"});
    assert.deepEqual(JSON.parse(await fs.readFile(b.selected.fsPath,"utf8")),original);
});

test("a replay case can save again beside a same-name case left on disk", async t=>{
    const {directory,b,author,folders} = await host(t);
    const plan = {version:"1",steps:[press("original")]};
    const save = async workflow=>{
        author.begin({name:"Replay",source:"recording",plan:workflow});
        folders.push([uri(directory)]);
        await author.save({id:b.state.caseReview.id,name:"Replay"});
        return b.selected;
    };
    const first=await save(plan);
    const second=await save({...plan,steps:[press("new")]});
    assert.equal(path.basename(path.dirname(second.fsPath)),"Replay-2");
    assert.deepEqual(JSON.parse(await fs.readFile(first.fsPath,"utf8")),plan);
    assert.equal(JSON.parse(await fs.readFile(second.fsPath,"utf8")).steps[0].input.target.id,"new");
});

test("gesture editing validates the saved coordinates and keeps the original input unless it is replaced", async t=>{
    const {b,author} = await host(t);
    const input = {kind:"typeText",text:"secret fixture text"};
    const plan = {format:"harmony-agent.device-recording",version:1,steps:[
        {command:"deviceGesture",input:{kind:"swipe",x:4,y:8,toX:4,toY:80,velocity:900}},
        {command:"deviceGesture",input,delayMs:500},
    ]};
    author.begin({name:"Gesture replay",source:"recording",plan});
    const edit = fields=>author.edit({id:b.state.caseReview.id,revision:b.state.caseReview.revision,area:"stepGesture",...fields});
    assert.doesNotMatch(JSON.stringify(b.state.caseReview.definitions),/secret fixture text/);
    await assert.rejects(edit({path:"steps[0]",coordinates:{x:"-1",y:"8",toX:"4",toY:"80",velocity:"900"},delay:"0"}));
    await edit({path:"steps[0]",coordinates:{x:"5",y:"8",toX:"5",toY:"80",velocity:"1200"},delay:"0"});
    await edit({path:"steps[1]",replaceInput:false,delay:"750"});
    assert.deepEqual(author.candidate.plan.steps[0].input,{kind:"swipe",x:5,y:8,toX:5,toY:80,velocity:1200});
    assert.deepEqual(author.candidate.plan.steps[1],{command:"deviceGesture",input,delayMs:750});
});

test("a check inserted after a Then runs at that position and can describe the next Given", async t=>{
    const {directory,b,author,folders}=await host(t);
    const result={assert:condition("receipt")}, next=press("Details");
    const plan={version:"1",preconditions:[condition("cart")],steps:[result,next],goals:[condition("details")]};
    b.state.device="phone";
    b.state.devices=["phone"];
    b.observe=async()=>{b.state.page={complete:true,nodes:[
        {label:"Order details",id:"order-details",pressable:false,selector:{id:"order-details"},attributes:{id:"order-details"}},
    ]};};
    author.begin({name:"Order verification",plan,source:"workflow"});
    const id=b.state.caseReview.id;
    await author.loadTargets({id,revision:0,area:"stepCheck",path:"steps[0]",add:true,live:true});
    assert.equal(b.state.caseReview.stepTargets.choices[0].label,"Order details");
    await author.edit({id,revision:0,area:"stepCheck",path:"steps[0]",add:true,target:"0",role:"Given",property:"visible",expected:"true"});
    assert.equal(author.candidate.presentationChanged,true);
    assert.deepEqual(b.state.caseReview.bdd.steps.map(step=>step.role),["Given","Then","Given","When","Then"]);
    assert.deepEqual(author.candidate.plan.steps,[result,{assert:condition("order-details")},next]);
    await author.edit({id,revision:1,area:"stepCheck",path:"steps[1]",target:"keep",role:"Given",property:"enabled",expected:"true"});
    folders.push([uri(directory)]);
    await author.save({id,name:"Order verification"});
    const saved=JSON.parse(await fs.readFile(b.selected.fsPath,"utf8"));
    assert.deepEqual(saved.steps,[result,{assert:{...condition("order-details"),property:"enabled"}},next]);
    assert.deepEqual({preconditions:saved.preconditions,goals:saved.goals},{preconditions:plan.preconditions,goals:plan.goals});
    assert.ok(await findCase(b.selected));
    const {presentation}=JSON.parse(await fs.readFile(b.selected.fsPath+".harmony-case.json","utf8"));
    assert.equal(restorePresentation(saved,presentation).get(saved.steps[1]).role,"Given");
});

test("a saved exploration draft can acquire checks, retain its case ID and become a runnable pytest case in its own folder", async t => {
    const {directory,b,author,folders,inputs,picks}=await host(t);
    author.begin(explorationCandidate(free(),{findingId:"review"}));
    folders.push([uri(directory)]);inputs.push("Draft case");
    await author.save({id:b.state.caseReview.id});
    const selected=b.selected, marker=selected.fsPath+".harmony-case.json";
    assert.equal(await findCase(selected),undefined);
    const meta=JSON.parse(await fs.readFile(marker,"utf8"));
    let buffer=await fs.readFile(selected.fsPath,"utf8");
    const doc={isDirty:false,getText:()=>buffer,positionAt:value=>value,
        async save(){await fs.writeFile(selected.fsPath,buffer);this.isDirty=false;return true;}};
    author.vscode.Uri.parse=()=>selected;
    author.vscode.workspace.openTextDocument=async()=>doc;
    author.vscode.WorkspaceEdit=class {replace(_uri,_range,value){this.value=value;}};
    author.vscode.Range=class {};
    author.vscode.workspace.applyEdit=async edit=>{buffer=edit.value;doc.isDirty=true;return true;};
    b.state.activeCase={...meta,uri:selected.toString()};
    b.planForRun=()=>({name:meta.name,uri:selected.toString()});
    await author.open({});
    const id=b.state.caseReview.id;
    assert.equal(b.state.caseReview.edit,true);
    inputs.push("home","catalog");picks.push(0,0);
    await author.addBoundary({id,source:"start"}); await author.addBoundary({id,source:"goal"});
    doc.isDirty=true;
    await assert.rejects(author.save({id}),/用例文件有其他修改/);
    assert.equal(await findCase(selected),undefined);
    doc.isDirty=false;
    await author.save({id});
    assert.equal(b.selected.fsPath,selected.fsPath);
    assert.deepEqual(JSON.parse(await fs.readFile(marker,"utf8")),meta);
    assert.ok(await findCase(selected));
    assert.equal(JSON.parse(buffer).workflow.goals[0].selector.id,"catalog");
});

test("report and finding actions launch the selected source in the case author rather than an empty generic workflow", async () => {
    const {explorationView,exploreClick}=await loadMedia("exploration");
    const r={...free(),maxInputs:4,inputs:2};
    const model={exploration:r,explorationCaseRoutes:caseRoutes(r),devices:[],explorationHistory:[]};
    const t=messagesFor("zh"), rendered=explorationView(model,t);
    assert.match(rendered,/将已执行路径保存为用例/);
    assert.match(rendered,/将此发现保存为测试用例/);
    const posted=[];
    exploreClick({dataset:{x:"caseFinding",id:"review"}},model,x=>posted.push(x),()=>{});
    assert.deepEqual(posted,[{type:"explorationCase",id:"trace",findingId:"review"}]);
});

test("dragging saved BDD steps moves a whole step inside its branch and writes only on Save",async t=>{
    const {directory,b,author}=await host(t);
    const plan={version:"2",steps:[{if:condition("cart"),then:[press("first"),{...press("second"),before:[condition("ready")]}]},
        press("outside")]};
    const file=uri(path.join(directory,"workflow.json"));
    const original=JSON.stringify(plan);
    await fs.writeFile(file.fsPath,original);
    const meta=await writeCaseMetadata(file,{name:"Checkout",source:"recording"});
    b.state.activeCase={...meta,uri:file.toString()};
    b.state.plan={name:meta.name,uri:file.toString()};
    b.planForRun=()=>b.state.plan;
    b.state.planDigest=sourceDigest(original);
    b.state.caseDefinitions=caseDefinitions(plan);
    let contents=original;
    author.vscode.Uri.parse=()=>file;
    author.vscode.workspace.openTextDocument=async()=>({isDirty:false,getText:()=>contents,positionAt:i=>i,
        async save(){await fs.writeFile(file.fsPath,contents);return true;}});
    author.vscode.WorkspaceEdit=class {replace(_file,_range,value){this.value=value;}};
    author.vscode.Range=class {};
    author.vscode.workspace.applyEdit=async edit=>{contents=edit.value;return true;};
    await author.moveStep({uri:file.toString(),digest:b.state.planDigest,from:"steps[0].then[0]",to:1});
    const {id,dirty,edit}=b.state.caseReview;
    assert.equal(dirty&&edit,true);
    await author.moveStep({id,revision:0,from:"steps[0].then[0]",to:1});
    assert.equal(await fs.readFile(file.fsPath,"utf8"),original);
    await author.save({id});
    const saved=JSON.parse(await fs.readFile(file.fsPath,"utf8"));
    assert.deepEqual(saved.steps,[{...plan.steps[0],then:[plan.steps[0].then[1],plan.steps[0].then[0]]},plan.steps[1]]);
});

test("copying a portable case saves an independent case identity and preserves the source workflow",async t=>{
    const {directory,b,author,folders,inputs,picks}=await host(t);
    author.begin(explorationCandidate(free(),{findingId:"review"}));
    await author.edit({id:b.state.caseReview.id,revision:0,area:"stepName",path:"steps[0]",name:"Browse products",group:"Catalog"});
    folders.push([uri(directory)]);inputs.push("Source");
    await author.save({id:b.state.caseReview.id});
    const original=b.selected;
    const contents=await fs.readFile(original.fsPath,"utf8");
    const marker=JSON.parse(await fs.readFile(original.fsPath+".harmony-case.json","utf8"));
    b.state.activeCase={...marker,uri:original.toString()};
    b.planForRun=()=>({name:"Source",uri:original.toString()});
    author.vscode.Uri.parse=()=>original;
    author.vscode.workspace.openTextDocument=async()=>({getText:()=>contents});
    await author.open({copy:true});
    assert.equal(b.state.caseReview.edit,false);
    assert.equal(b.state.caseReview.name,"Source 副本");
    folders.push([uri(directory)]);inputs.push("Source 副本");
    await author.save({id:b.state.caseReview.id});
    assert.notEqual(b.selected.fsPath,original.fsPath);
    assert.equal(await fs.readFile(original.fsPath,"utf8"),contents);
    const copy=JSON.parse(await fs.readFile(b.selected.fsPath+".harmony-case.json","utf8"));
    assert.notEqual(copy.id,marker.id);
    assert.equal(copy.presentation.steps["steps[0]"].name,"Browse products");
    assert.deepEqual(copy.presentation,marker.presentation);
    assert.deepEqual(JSON.parse(await fs.readFile(b.selected.fsPath,"utf8")),JSON.parse(contents));
});
