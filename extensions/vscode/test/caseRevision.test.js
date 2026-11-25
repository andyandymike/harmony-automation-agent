"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {discoverCaseRevision, verifyCaseRevision} = require("../src/caseRevision");
const {CaseAuthoring} = require("../src/caseAuthoring");
const {CaseCompositionEditor} = require("../src/caseCompositionEditor");
const {compileCase} = require("../src/caseComposition");
const {readWorkflow, requireExecutableWorkflow, workflowForSave} = require("../src/workflowFile");
const loadWebview = require("../test-support/loadWebview");

const visible=id=>({selector:{id},property:"visible",equals:true});
const text=(id,equals)=>({selector:{id},property:"text",equals});
const press=id=>({command:"press",input:{target:{id}}});
const describe=(id,value)=>({description:{id,text:value}});
const startNote="Verify the starting page";
const stepNote="Open account settings and then open the profile";
const endNote="Return to the home page and check its title";
const wholeNote="Check the nickname on the profile after the existing title check";

function basePlan() {
    return {version:"2",editNote:wholeNote,preconditions:[visible("home")],goals:[visible("home")],steps:[
        describe("start",startNote),
        {useCase:{caseId:"login",name:"Login",digest:"pinned",plan:{version:"1",steps:[press("login")]}}},
        {read:{name:"user_name",selector:{id:"nickname"},property:"text"}},
        {command:"press",input:{target:{id:"old-profile"}},editNote:stepNote},
        {assert:visible("profile")},
        {assert:text("nickname",{var:"user_name"})},
        describe("end",endNote)
    ]};
}

function fixture() {
    let current = "home";
    let failedId;
    const calls=[], prompts=[];
    const pages = {
        home:[{id:"home",text:"Home"},{id:"login",clickable:true},{id:"settings",clickable:true},{id:"nickname",text:"QA User"}],
        settings:[{id:"profile-entry",clickable:true}],
        profile:[{id:"profile",text:"Profile"},{id:"nickname",text:"QA User"}],
    };
    function observation() {
        return {quality:{complete:true},nodes:pages[current].map((node,index)=>({
            ...node,ref:"node-"+index,enabled:true,visible:true
        })),frameId:"page-"+current};
    }
    function act(id) {
        if (id==="settings") current="settings";
        if (id==="profile-entry") current="profile";
    }
    function check(selector,property,expected) {
        const node=pages[current].find(item=>item.id===selector.id);
        const actual=property==="visible" ? Boolean(node) : node?.text;
        return {selector,property,expected,actual,matches:node?1:0,
            status:actual===expected && node?.id!==failedId ? "passed" : "failed"};
    }
    const bench = {language:"en",state:{device:"fixture",devices:["fixture"],tool:"recordings"},sessionFor:()=>"workbench",
        prepareFlowScenario:async()=>{}, errorMessage:error=>error.message,publish(){},
        agent:{async call(command,args){
            calls.push({command,args:structuredClone(args)});
            if (command==="observe") return observation();
            if (command==="press") {
                const node=observation().nodes.find(node=>node.ref===args.target.ref);
                act(node.id);
                return {action:{dispatched:"acknowledged"},observation:observation()};
            }
            if (command==="back") {
                current="home";
                return {action:{dispatched:"acknowledged"},observation:observation()};
            }
            if (command==="wait") return {assertion:check(args.target,args.property,args.equals),observation:observation()};
            if (command!=="run") return {};
            const steps=[], bindings=new Map();
            for (const {phase,entries} of [
                {phase:"preconditions",entries:args.plan.preconditions?.map(assert=>({assert})) || []},
                {phase:"steps",entries:args.plan.steps},
                {phase:"goals",entries:args.plan.goals?.map(assert=>({assert})) || []}
            ]) {
                for (const [i,step] of entries.entries()) {
                    const path=phase+"["+i+"]";
                    if (step.command==="press") act(step.input.target.id);
                    if (step.command==="back") current="home";
                    if (step.read) {
                        const value=pages[current].find(item=>item.id===step.read.selector.id)?.text;
                        bindings.set(step.read.name,value);
                        steps.push({kind:"read",path,result:{name:step.read.name,value},status:"completed"});
                        continue;
                    }
                    const condition=step.assert;
                    const result=condition && check(condition.selector,condition.property,
                        condition.equals?.var ? bindings.get(condition.equals.var) : condition.equals);
                    steps.push({path,kind:condition?"assert":"command",command:step.command,status:"completed",result});
                    if (result?.status==="failed") return {status:"failed",steps};
                }
            }
            return {status:"completed",steps,goalVerification:{status:args.plan.goals?.length?"passed":"not_requested"}};
        }},
        async modelAsk() {
            return async prompt=>{
                const request=JSON.parse(prompt.split("\n").at(-1));
                prompts.push(request);
                if (request.feedback) return JSON.stringify({changes:[
                    {path:"steps[4]",op:"after",text:"Check the exact nickname QA User"}]});
                const count=request.history.length;
                const find=id=>request.currentPage.nodes.find(node=>node.id===id)?.node;
                let response;
                if (request.goal===startNote && !count) response={action:"check",node:find("home"),property:"visible",equals:true};
                if (request.goal===stepNote && count===0) response={action:"press",node:find("settings")};
                if (request.goal===stepNote && count===1) response={action:"press",node:find("profile-entry")};
                if (request.goal===endNote && count===0) response={action:"back"};
                if (request.goal===endNote && count===1) response={action:"check",node:find("home"),property:"text",equals:"Home"};
                if (request.goal==="Check the exact nickname QA User" && !count)
                    response={action:"check",node:find("nickname"),property:"text",equals:"QA User"};
                return JSON.stringify(response || {action:"done",text:"Confirmed"});
            };
        }
    };
    return {bench,calls,prompts,setPage:page=>{current=page;},fail:id=>{failedId=id;}};
}

const input=()=>({plan:basePlan(),presentation:new Map()});
const options=()=>({signal:new AbortController().signal,notify(){},setPath(){}});

test("case and row feedback are saved with the original operation and remain unrunnable",()=>{
    const c=input();
    const compiled=compileCase(c.plan);
    assert.deepEqual(compiled.pending.map(item=>item.path),["case","steps[0]","steps[3]","steps[6]"]);
    const file=readWorkflow(JSON.stringify(workflowForSave(compiled.plan)));
    assert.equal(file.draft,true);
    assert.equal(file.plan.steps[3].input.target.id,"old-profile");
    assert.equal(file.plan.steps[3].editNote,stepNote);
    assert.throws(()=>requireExecutableWorkflow(file,"en"),/awaiting generation or revision/);
});

test("one exploration materializes case and step feedback around pinned references and bindings before a fresh exact replay",async()=>{
    const {bench,calls,prompts,setPage}=fixture();
    const c=input();
    const revised=await discoverCaseRevision(bench,c,options());
    assert.equal(revised.diffs.length,4);
    assert.equal(revised.diffs[1].before.length,1);
    assert.equal(revised.diffs[1].after.length,2);
    assert.equal(revised.plan.steps[1].useCase.digest,"pinned");
    assert.equal(revised.plan.steps[3].description.steps[1].input.target.id,"profile-entry");
    assert.equal(revised.compiled.pending,undefined);
    assert.equal(revised.compiled.plan.steps.at(-3).assert.equals.var,"user_name");
    assert.ok(calls.find(call=>call.command==="run" && call.args.plan.steps.some(step=>step.assert?.equals==="QA User")));
    assert.equal(c.plan.steps[3].input.target.id,"old-profile");
    assert.equal(c.plan.editNote,wholeNote);
    const sessions=new Set(calls.map(call=>call.args.session));
    assert.equal(sessions.size,1);
    assert.equal(calls.at(-1).command,"detach");

    setPage("home");
    const requestCount=prompts.length, callCount=calls.length;
    const verification=await verifyCaseRevision(bench,c,revised,options().signal);
    assert.equal(verification.complete,true);
    assert.ok(verification.steps.some(step=>step.assertionStatus==="passed" && /Verify.*nickname/.test(step.label)));
    assert.equal(prompts.length,requestCount);
    const replay=calls.slice(callCount).find(call=>call.command==="run");
    assert.ok(!sessions.has(replay.args.session));
    assert.deepEqual(replay.args.plan,revised.compiled.plan);
    assert.equal(calls.at(-1).command,"detach");
});

test("a single opinion can be applied as multiple steps while other changes stay in the draft",async()=>{
    const {bench,calls}=fixture();
    const author=bench.caseAuthoring=new CaseAuthoring(bench,{});
    const editor=bench.composition=new CaseCompositionEditor(bench,{});
    author.begin({...input(),name:"Profile",source:"workflow"});
    const c=author.candidate;
    const request=()=>({id:c.id,revision:c.revision});
    await editor.handle({...request(),action:"reviseStep",path:"steps[3]"});
    assert.equal(bench.state.tool,"exploration");
    await editor.handle({...request(),action:"revisionRun",start:"current"});
    assert.equal(bench.state.caseComposition.revisionWork.phase,"review");
    assert.equal(bench.state.caseComposition.revisionWork.diffs[0].checkedNext,true);
    assert.equal(c.plan.steps[3].editNote,stepNote);
    await editor.handle({...request(),action:"revisionApply"});
    assert.equal(bench.state.tool,"recordings");
    assert.equal(c.plan.steps[3].description.steps.length,2);
    assert.equal(c.plan.editNote,wholeNote);
    assert.equal(compileCase(c.plan).pending.length,3);
    assert.equal(calls.at(-1).command,"detach");
});

test("whole-case review requires a fresh successful replay before it writes a version",async()=>{
    const {bench,fail,setPage}=fixture();
    const author=bench.caseAuthoring=new CaseAuthoring(bench,{});
    const editor=bench.composition=new CaseCompositionEditor(bench,{});
    author.begin({...input(),name:"Profile",source:"workflow"});
    let saved;
    author.save=async({id})=>{assert.equal(id,author.candidate.id);saved=compileCase(author.candidate.plan).plan;};
    const c=author.candidate;
    const send=action=>editor.handle({action,id:c.id,revision:c.revision});
    await send("reviseCase");
    await send("revisionRun");
    assert.equal(bench.state.caseComposition.revisionWork.phase,"review");
    await send("revisionApply");
    assert.equal(saved,undefined);
    fail("profile");
    setPage("home");
    await send("revisionVerify");
    assert.equal(bench.state.caseComposition.revisionWork.phase,"failed");
    await send("revisionApply");
    assert.equal(saved,undefined);
    assert.equal(c.plan.editNote,wholeNote);
    fail(undefined);
    setPage("home");
    await send("revisionVerify");
    assert.equal(bench.state.caseComposition.revisionWork.phase,"passed");
    const {compositionPage}=await loadWebview("caseComposition");
    assert.match(compositionPage(bench.state,"en"),/Save as a replayable version|Full replay passed/);
    await send("revisionApply");
    assert.ok(saved.steps.length>7);
    assert.equal(saved.editNote,undefined);
    assert.equal(bench.state.tool,"recordings");
});
