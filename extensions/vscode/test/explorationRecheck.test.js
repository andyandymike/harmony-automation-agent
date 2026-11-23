"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { canRecheck, recheckFinding } = require("../src/explorationRecheck");

const selector = { bundleName: "example.app", id: "language" };
const goal = { selector, property: "text", equals: "English" };
function original() {
    const finding = { id:"f", title:"Cancel changed the language", kind:"failure", selector, property:"text",
        expected:"English", actual:"Chinese", regressionPath:"goals[0]",
        plan:{version:"1", steps:[{command:"back"}], goals:[goal]} };
    return {id:"exploration",device:"phone",language:"en",status:"completed",bundle:"example.app",pages:[],
        steps:[],findings:[finding]};
}
function saved(status, rows) {
    return {result:{status},receipts:rows};
}
const failedGoal = {kind:"goal",path:"goals[0]",status:"completed",result:{
    status:"failed",selector,property:"text",expected:"English",actual:"Chinese",frameId:"saved-frame"}};

async function recover(native) {
    const report=original(), finding=report.findings[0], calls=[];
    report.mockScenario={version:1,name:"Discovery fixture",rules:[]};
    finding.pendingRetest={id:"attempt",runId:"saved-run",ruleGroup:"Discovery fixture",startedAt:"2026-01-01T00:00:00Z"};
    const row=await recheckFinding({report,findingId:finding.id,device:report.device,
        prepareRuleGroup:()=>assert.fail("Recovery never resets a rule sequence"),agent:{async call(command,args){
        calls.push([command,args]);
        if(command==="report")return native;
        assert.equal(command,"detach");return {};
    }}});
    assert.equal(finding.pendingRetest,undefined);
    assert.deepEqual(calls.map(c=>c[0]),["report","detach"]);
    assert.equal(row.runId,"saved-run");
    assert.equal(row.ruleGroup,"Discovery fixture");
    assert.deepEqual(finding.retests,[row]);
    return row;
}

test("a recovered retest compares the exact adopted check and observed value without sending input", async () => {
    assert.equal((await recover(saved("failed",[failedGoal]))).status,"reproduced");
    const pass={...failedGoal,result:{...failedGoal.result,status:"passed",actual:"English"}};
    assert.equal((await recover(saved("completed",[pass]))).status,"passed");
});

test("a fresh independent retest restores the discovery group before the first native plan; setup failure stays inconclusive",async()=>{
    async function attempt(fail){
        const report=original(), finding=report.findings[0],calls=[];
        finding.plan.preconditions=[goal];
        report.mockScenario={version:1,name:"Original",rules:[]};
        const frame={frameId:"frame",quality:{complete:true},nodes:[{...selector,ref:"e",type:"Button",visible:true,clickable:true}]};
        const agent={async call(cmd){
            calls.push(cmd);
            if (cmd==="start")return {observation:frame};
            if (cmd==="observe" || cmd==="inspect")return frame;
            if (cmd==="run")return {status:"failed",steps:[failedGoal]};
            return {};
        }};
        const receipt=await recheckFinding({report,device:report.device,findingId:finding.id,agent,prepareRuleGroup:async group=>{
            calls.push("restore");assert.deepEqual(group,report.mockScenario);
            if(fail)throw new Error("Gateway setup unavailable");
            return group;
        }});
        return {calls,receipt};
    }
    const ok=await attempt(false);
    assert.equal(ok.receipt.status,"reproduced"); assert.equal(ok.receipt.ruleGroup,"Original");
    assert(ok.calls.indexOf("observe")<ok.calls.indexOf("restore"));assert(ok.calls.indexOf("restore")<ok.calls.indexOf("run"));
    const blocked=await attempt(true);
    assert.equal(blocked.receipt.status,"inconclusive"); assert(!blocked.calls.includes("run"));
    assert.match(blocked.receipt.reason,/Gateway setup/);assert.equal(blocked.receipt.ruleGroup,undefined);
});

test("a different failure, starting condition, unfinished run, or bare completion is inconclusive",async () => {
    for (const report of [
        saved("completed",[]), saved("running",[]), saved("failed",[{...failedGoal,kind:"precondition"}]),
        saved("failed",[{...failedGoal,path:"goals[1]"}]),
        saved("failed",[{...failedGoal,result:{...failedGoal.result,actual:"French"}}]),
        saved("failed",[{...failedGoal,result:{...failedGoal.result,selector:{id:"unrelated"}}}]),
    ]) assert.equal((await recover(report)).status,"inconclusive");
});

test("a retest needs a repeatable plan plus either explicit start conditions or recorded starting controls", async () => {
    const report=original(),finding=report.findings[0];
    assert(canRecheck(finding));
    assert(!canRecheck({...finding,kind:"review"}));
    assert(!canRecheck({...finding,plan:{version:"1",steps:[{command:"press",input:{target:{id:"submit-payment"}}}]}}));
    const agent={async call(){assert.fail("No reliable original starting state");}};
    const result=await recheckFinding({report,device:report.device,findingId:finding.id,agent});
    assert.equal(result.status,"inconclusive");assert(!result.runId);
    await assert.rejects(recheckFinding({report,device:"other-phone",findingId:finding.id,agent}),/original phone/);
    assert.equal(report.steps.length,0);
});
