"use strict";

const test=require("node:test"), assert=require("node:assert/strict");
const {createBdd}=require("../src/caseBdd");
const {compileCase,signature}=require("../src/caseComposition");
const {caseExplorationCheckpoints}=require("../src/caseExplorationMenu");
const {forkSourceSnapshot}=require("../src/explorationCases");
const {timelinePrefix,prepareCaseFlow}=require("../src/caseExplorationTimeline");
const check=id=>({selector:{id},property:"visible",equals:true});
const tap=id=>({command:"press",input:{target:{id}}});

function menu(plan,options) {
    const compiled=compileCase(plan), bdd=createBdd(plan,"zh",undefined,undefined,compiled);
    caseExplorationCheckpoints(compiled,{...compiled,execution:compiled.plan,plan},"zh",{bdd,...options});
    return bdd.steps;
}

test("row and gap actions use the actual side of setup checks, references, rules and final checks",()=>{
    const linked={version:"1",steps:[tap("prepare")],goals:[check("ready")]};
    const ref={useCase:{caseId:"setup",name:"Setup",plan:linked,digest:signature({plan:linked}),dependencies:[]}};
    const plan={version:"1",preconditions:[check("a"),check("b")],steps:[ref,
        {ruleGroup:{action:"enable",scenario:{version:1,name:"fault",rules:[]}}},tap("retry")],goals:[check("done")]};
    const [a,b,reference,rule,last,goal]=menu(plan);
    assert.deepEqual(a.exploration.before,{checkpoint:-1});
    assert.deepEqual(a.exploration.after,{checkpoint:0});
    assert.deepEqual(b.exploration.before,a.exploration.after);
    assert.deepEqual(b.exploration.after,reference.exploration.before);
    assert.deepEqual(reference.exploration.before,{checkpoint:1});
    assert.deepEqual(reference.exploration.after,{checkpoint:3});
    assert.deepEqual(rule.exploration.before,reference.exploration.after);
    assert.match(rule.exploration.after.pathsReason,/规则组/);
    assert.equal(rule.exploration.after.followUpReason,undefined);
    assert.deepEqual(goal.exploration.before,last.exploration.after);
    assert.match(goal.exploration.after.pathsReason,/规则组/);
    assert.equal(goal.exploration.after.checkpoint,undefined);
    assert.ok(reference.branches[0].steps.every(row=>!row.exploration));
});

test("nested menu positions distinguish generated sequences from conditional or loop arms",()=>{
    const plan={version:"2",steps:[tap("one"),{description:{id:"d",text:"去订单页",steps:[tap("two"),tap("three")]}},
        {if:check("enabled"),then:[tap("detail")]},{repeat:{limit:2,until:check("ready"),steps:[tap("refresh")]}}],
        goals:[check("done")]};
    const [one,description,condition,loop,goal]=menu(plan);
    const [two,three]=description.branches[0].steps;
    assert.deepEqual(two.exploration.before,one.exploration.after);
    assert.equal(two.exploration.after.followUpReason,undefined);
    assert.match(two.exploration.after.pathsReason,/整个描述步骤/);
    assert.deepEqual(two.exploration.after,three.exploration.before);
    assert.deepEqual(three.exploration.after,condition.exploration.before);
    for (const row of [condition,loop]) {
        assert.ok(Number.isInteger(row.exploration.after.checkpoint));
        assert.match(row.branches[0].steps[0].exploration.after.followUpReason,/条件或循环/);
    }
    assert.deepEqual(goal.exploration.before,loop.exploration.after);
    assert.deepEqual(goal.exploration.after,{checkpoint:5});
});

test("drafts keep executable follow-up positions before a pending step, and offer an actionable guided recovery",()=>{
    const plan={version:"1",steps:[tap("order"),{description:{id:"pending",text:"核对付款"}},tap("retry")]};
    const [first,pending,last]=menu(plan,{review:"draft"});
    assert.equal(first.exploration.after.followUpReason,undefined);
    assert.deepEqual(pending.exploration.before,first.exploration.after);
    assert.match(pending.exploration.after.followUpReason,/待生成/);
    assert.deepEqual(last.exploration.before,pending.exploration.after);
    assert.match(first.exploration.after.pathsReason,/保存用例/);
    const saved={version:"1",steps:[tap("order")]};
    assert.match(menu(saved,{review:"clean"})[0].exploration.after.pathsReason,/返回用例/);
    assert.match(menu(saved,{editable:false})[0].exploration.after.followUpReason,/可编辑用例/);
    assert.deepEqual(menu(saved)[0].exploration.after,{checkpoint:0});
});

test("forking after a reference keeps its authored row and all its own exit checks",()=>{
    const linked={version:"1",steps:[tap("prepare")],preconditions:[check("begin")],goals:[check("ready")]};
    const row={useCase:{caseId:"setup",name:"Setup",plan:linked,digest:signature({plan:linked}),dependencies:[]}};
    for (const steps of [[row],[row,tap("unrun")]]) {
        const plan={version:"1",steps}, compiled=compileCase(plan);
        const doc={...compiled,plan,execution:compiled.plan,presentation:new Map()};
        const snapshot=forkSourceSnapshot(doc,compiled.boundaries.get("steps[0]"));
        assert.deepEqual(snapshot.steps,[row]);
        assert.equal(snapshot.referenceProvidesStart,true);
        assert.deepEqual(snapshot.replayExitChecks,steps.length===1 ? linked.goals : undefined);
        const flow=prepareCaseFlow(compiled.plan,"zh",doc);
        assert.equal(flow.checkpoints[1].index,2);
        assert.deepEqual(flow.checkpoints.map(point=>point.position),steps.length===1 ? [0,1] : [0,1,2]);
        const start=forkSourceSnapshot(doc,-1,"rows"), after=forkSourceSnapshot(doc,2,"rows");
        assert.deepEqual([start.preconditions,start.steps],[[],[]]);
        assert.deepEqual([after.preconditions,after.steps],[[],[row]]);
        const replay=timelinePrefix(compiled.plan,2);
        assert.deepEqual(replay.preconditions,linked.preconditions);
        assert.deepEqual(replay.goals,steps.length===1 ? linked.goals : undefined);
        assert.deepEqual(replay.steps,steps.length===1 ? linked.steps : [...linked.steps,{assert:linked.goals[0]}]);
    }
});

test("saving a branch retains only the checks actually reached, with their edited display names",()=>{
    const plan={version:"1",preconditions:[check("one"),check("two")],steps:[tap("open")],goals:[check("three"),check("four")]};
    const display=new Map([[plan.goals[0],{name:"页面已打开"}]]);
    const doc={plan,execution:plan,presentation:display};
    const first=forkSourceSnapshot(doc,0,"rows"), tail=forkSourceSnapshot(doc,3,"rows");
    assert.deepEqual(first.preconditions,plan.preconditions.slice(0,1));
    assert.deepEqual(first.steps,[]);
    assert.deepEqual(tail.preconditions,plan.preconditions);
    assert.deepEqual(tail.steps,[...plan.steps,{assert:plan.goals[0]}]);
    assert.equal(tail.presentation.steps["steps[1]"].name,"页面已打开");
    const checksOnly={version:"1",steps:[],goals:[check("four")]};
    assert.deepEqual(prepareCaseFlow(JSON.stringify(checksOnly),"zh").checkpoints.map(row=>row.index),[-1,0]);
});
