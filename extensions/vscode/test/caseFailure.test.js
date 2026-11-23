"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { reviewCaseFailure } = require("../src/caseFailure");
const { runView } = require("../src/model");
const { explainRun } = require("../src/aiTasks");
const loadWebview = require("../test-support/loadWebview");

const entry = { id: "fixture-run", status: "failed", plan: { uri: "file:///workflow.json" } };
const path = "steps[1]";

test("the first observed blocker separates locator, page, assertion, device and runner failures", () => {
    const first = { path: "steps[0]", kind: "command", command: "open", status: "completed" };
    const classify = issue => {
        const run = runView({result:{status:"failed"},receipts:[first,{path,kind:"command",status:"failed",...issue}]});
        return { run, review:reviewCaseFailure({...run,entry}) };
    };
    const lost = classify({error:{code:"TARGET_NOT_FOUND"},basisFrameId:"before"});
    assert.deepEqual(lost.review,{kind:"locator",index:1,code:"TARGET_NOT_FOUND",phase:undefined});
    const device = classify({kind:"goal",error:{code:"DEVICE_DISCONNECTED",details:{matches:0,status:"failed"}}});
    assert.equal(device.review.kind,"environment");
    assert.equal(device.run.steps[1].locatorFailure,undefined);
    assert.equal(classify({kind:"precondition",result:{status:"failed",expected:true,actual:false,matches:1}}).review.kind,"page");
    assert.equal(classify({kind:"goal",result:{status:"failed",expected:"Paid",actual:"Pending",matches:1}}).review.kind,"assertion");
    assert.equal(classify({status:"unknown"}).review.kind,"unknown");
    const runner = reviewCaseFailure({entry,steps:[],pytest:{phases:[{phase:"setup",outcome:"failed"}]}});
    assert.deepEqual(runner,{kind:"runner",phase:"setup",index:undefined,code:undefined});
    assert.equal(reviewCaseFailure({entry:{...entry,status:"cancelled"},steps:[{status:"cancelled"}]}),undefined);
});

test("an AI locator recommendation requires a saved frame lookup and uses the failing step rather than the viewed step", async () => {
    const run = {entry,status:"failed",selected:0,steps:[{path:"steps[0]",status:"completed"},
        {path, command:"press",status:"failed",errorCode:"TARGET_NOT_FOUND",locatorFailure:true,before:"saved-page"}]};
    const failure = reviewCaseFailure(run);
    let answer, reads = 0;
    const analyze = ask => explainRun({run,failure,language:"en",ask,onEvent:e=>{if(e.type==="answer")answer=e;},
        agent:{async call(command,input){
            reads++;
            assert.equal(command,"inspect");
            assert.equal(input.frame_id,"saved-page");
            return {frameId:"saved-page",quality:{complete:true},nodes:[{ref:"@1",id:"submit-new",type:"Button",text:"Submit",visible:true}]};
        }}});
    const recommendation = '{"action":"answer","text":"Verify the new locator.","recommendation":"verifyLocator"}';
    await analyze(async()=>recommendation);
    assert.equal(answer.recommendation,"insufficientEvidence");
    assert.equal(reads,0);
    await analyze(async prompt=>{
        const evidence=JSON.parse(prompt.split("\n").at(-1)).evidence;
        assert.equal(evidence.selected.path,path);
        assert.match(prompt,/missing control alone does not prove a selector changed/);
        return evidence.consulted.length ? recommendation : '{"action":"frame","phase":"before"}';
    });
    assert.equal(reads,1);
    assert.equal(answer.recommendation,"verifyLocator");
});

test("pytest setup can be diagnosed without a device run and the recommendation keeps the original case", async () => {
    const run = {entry:{...entry,source:"pytest"},status:"failed",steps:[],pytest:{phases:[{phase:"setup",outcome:"failed"}]}};
    const failure = reviewCaseFailure(run);
    const events = [];
    await explainRun({run,failure,language:"zh-CN",onEvent:e=>events.push(e),agent:{call(){assert.fail("No device run exists");}},
        ask:async prompt=>{
            const evidence=JSON.parse(prompt.split("\n").at(-1)).evidence;
            assert.equal(evidence.failure.phase,"setup");
            assert.equal(evidence.selected,undefined);
            return '{"action":"answer","text":"检查 fixture。","recommendation":"reviewCase"}';
        }});
    assert.equal(events.at(-1).recommendation,"keepCase");
});

test("the failure section states the next check with its own evidence action and describes the optional HTML export", async () => {
    const { failureView } = await loadWebview("caseFailure");
    const { evidenceExport } = await loadWebview("flowDebug");
    const locator=failureView({kind:"locator",index:1,code:"TARGET_NOT_FOUND"},entry.id,"zh-CN",
        {stepTitle:"点按提交",ai:{recommendation:"verifyLocator"}});
    assert.match(locator,/失败排查/);
    assert.match(locator,/到达预期页面/);
    assert.match(locator,/data-type="diagnoseFailure"[^>]*>用 AI 诊断失败/);
    assert.match(locator,/data-type="showFailureStep"[^>]*data-index="1"/);
    assert.match(locator,/在副本上验证替代定位器/);
    const runner=failureView({kind:"runner",phase:"setup"},entry.id,"zh-CN",{ai:{recommendation:"keepCase"}});
    assert.match(runner,/测试准备/);
    assert.match(runner,/先保留原用例/);
    assert.doesNotMatch(runner,/showFailureStep/);
    assert.match(evidenceExport({run:{entry,steps:[{status:"failed"}]}},"zh-CN","run"),/导出运行证据…[\s\S]*保存为 HTML…/);
});
