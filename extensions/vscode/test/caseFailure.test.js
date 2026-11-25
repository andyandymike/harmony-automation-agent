"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { reviewCaseFailure } = require("../src/caseFailure");
const { runView } = require("../src/model");
const { diagnoseCase } = require("../src/caseDiagnosis");
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

test("a terminal locator error uses the page inspected before it refused to dispatch", () => {
    const failed = {path,kind:"command",command:"press",status:"failed",basisFrameId:"prior",
        error:{code:"TARGET_NOT_FOUND",details:{dispatched:"no",selector:{id:"checkout"}}}};
    const run = runView({receipts:[failed],result:{status:"failed",observation:{frameId:"lookup"}}});
    assert.equal(run.steps[0].dispatched,"no");
    assert.equal(run.steps[0].before,"lookup");
    failed.error.details.dispatched = "unknown";
    assert.equal(runView({receipts:[failed],result:{observation:{frameId:"lookup"}}}).steps[0].before,"prior");
});

test("failure diagnosis reads the failing and preceding steps, passing page and HTTP window before its one model call", async () => {
    const start = "2026-01-01T01:02:00.000Z", middle = "2026-01-01T01:02:02.000Z", end = "2026-01-01T01:02:03.000Z";
    const entryWithDigest = {...entry,sourceDigest:"current-source"};
    const previous = {path:"steps[0]",kind:"command",command:"open",status:"completed",before:"earlier-page",startedAt:start,at:middle};
    const failed = {path,kind:"command",command:"press",status:"failed",errorCode:"TARGET_NOT_FOUND",locatorFailure:true,
        before:"failure-page",startedAt:middle,at:end};
    const run = {entry:entryWithDigest,status:"failed",selected:0,steps:[previous,failed]};
    const failure = reviewCaseFailure(run);
    const reads = [], events = [], asks = [];
    const answer = await diagnoseCase({run,failure,language:"en",onEvent:e=>events.push(e),
        agent:target=>({async call(command,input) {
            assert.equal(command,"inspect");
            reads.push([target.id,input.frame_id]);
            return {frameId:input.frame_id,quality:{complete:true},nodes:[{ref:"@1",id:"pay.title",type:"Text",text:"Payment",visible:true}]};
        }}),
        baseline:async()=>({entry:{...entryWithDigest,id:"prior-run"},steps:[{...failed,status:"completed",before:"passed-page",
            after:"receipt-page",assertionStatus:"not_requested"}]}),
        readRequests:async (window,filter)=>{
            assert.deepEqual(window,{start:Date.parse(start),end:Date.parse(end)});
            assert.equal(filter,"errors");
            return {kind:"http",status:"read",window,filter,total:1,records:[{id:"request-1",method:"POST",route:"/api/payment",status:503}]};
        },
        prepare:async input=>{
            assert.equal(input.step,failed);
            assert.equal(input.previous,previous);
            assert.equal(input.page.frameId,"failure-page");
            assert.equal(input.passing.page.frameId,"passed-page");
            return {reason:"noMatch"};
        },
        ask:async prompt=>{
            const {evidence,options}=JSON.parse(prompt.split("\n").at(-1));
            asks.push(evidence);
            assert.equal(evidence.step.path,path);
            assert.equal(evidence.failurePage.title,"Payment");
            assert.equal(evidence.http[0].status,503);
            assert.deepEqual(options,[]);
            return JSON.stringify({summary:"Payment returned HTTP 503 near the failure.",next:"Open the /api/payment request.",
                recommendation:"inspectRequest",option:0,citations:["http","page","invented"]});
        },
    });
    assert.deepEqual(reads.sort(),[[entry.id,"earlier-page"],[entry.id,"failure-page"],["prior-run","passed-page"]].sort());
    assert.equal(asks.length,1);
    assert.deepEqual(answer.citations,["http","page"]);
    assert.equal(answer.recommendation,"inspectRequest");
    assert.equal(answer.proposed,undefined);
    assert.match(answer.next,/api\/payment/);
});

test("pytest setup can be diagnosed without a device run and the recommendation keeps the original case", async () => {
    const run = {entry:{...entry,source:"pytest"},status:"failed",steps:[],pytest:{phases:[
        {phase:"setup",outcome:"failed",reason:"fixture 'session_data' not found"}]}};
    const failure = reviewCaseFailure(run);
    const result = await diagnoseCase({run,failure,language:"zh-CN",onEvent:()=>{},
        agent(){assert.fail("No device run exists");},prepare:async()=>({}),
        ask:async prompt=>{
            const evidence=JSON.parse(prompt.split("\n").at(-1)).evidence;
            assert.equal(evidence.failure.phase,"setup");
            assert.match(evidence.failure.pytestMessage,/session_data/);
            assert.equal(evidence.step,undefined);
            return '{"summary":"缺少 session_data fixture。","next":"恢复 conftest.py 中的 session_data。","recommendation":"reviewCase"}';
        }});
    assert.equal(result.recommendation,"keepCase");
    assert.match(result.next,/conftest.py/);
});

test("the failure section keeps evidence inline and describes the optional HTML export", async () => {
    const { failureView } = await loadWebview("caseFailure");
    const { evidenceExport } = await loadWebview("flowDebug");
    const locator=failureView({kind:"locator",index:1,code:"TARGET_NOT_FOUND"},entry.id,"zh-CN",
        {stepTitle:"点按提交",evidence:"<p>失败页面</p>"});
    assert.match(locator,/失败排查/);
    assert.match(locator,/到达预期页面/);
    assert.match(locator,/data-type="diagnoseFailure"[^>]*>用 AI 分析失败/);
    assert.match(locator,/<summary>原失败证据<\/summary>[\s\S]*失败页面/);
    assert.doesNotMatch(locator,/showFailureStep|data-type="report"/);
    const missing=failureView({kind:"locator",index:1},entry.id,"zh-CN",{canReadLive:true,
        ai:{recommendation:"insufficientEvidence",reason:"missingPage",answer:"无法读取失败页面。",next:"打开付款页。"}});
    assert.match(missing,/data-phase="live"[^>]*>用手机当前画面补充分析/);
    const patch=failureView({kind:"locator",index:1},entry.id,"zh-CN",{
        ai:{recommendation:"verifyNavigation",answer:"订单前需要经过确认页。",next:"选择选项 2。"},repair:"<p>点按继续</p>"});
    assert.match(patch,/点按继续/);
    assert.doesNotMatch(patch,/选择选项/);
    const runner=failureView({kind:"runner",phase:"setup"},entry.id,"zh-CN",{runner:"pytest",
        ai:{recommendation:"keepCase",answer:"缺少 session_data fixture。",next:"检查 conftest.py。"}});
    assert.match(runner,/测试准备/);
    assert.match(runner,/检查 conftest\.py/);
    assert.match(runner,/data-runner="pytest"[^>]*>重跑原用例/);
    assert.doesNotMatch(runner,/showFailureStep/);
    assert.match(evidenceExport({run:{entry,steps:[{status:"failed"}]}},"zh-CN","run"),/导出运行证据[\s\S]*保存为 HTML/);
});
