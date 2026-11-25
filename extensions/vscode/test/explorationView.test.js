"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { messagesFor } = require("../src/strings");

const loadWebview = require("../test-support/loadWebview");
const loadView = () => loadWebview("exploration");

test("a running exploration renders actionable pause and stop controls while the device is busy", async () => {
    const view = await loadView();
    const report = { id: "test-live", status: "running", device: "test", mode: "free", goal: "Inspect menus",
        inputs: 1, maxInputs: 20, pending: { label: "Open <menu>", reason: "Untried" },
        pages: [], steps: [], findings: [], branches: [] };
    const model = { exploration: report, busy: true, device: "test", devices: ["test"] };
    const html = view.explorationView(model, messagesFor("en"));
    assert.match(html, /data-x="pause"(?! disabled)/);
    assert.match(html, /data-x="stop"(?! disabled)/);
    assert.match(html, /Open &lt;menu&gt;/);
    assert.doesNotMatch(html, /Open <menu>/);
    assert.match(html, /data-x="tab" data-id="coverage"\s+aria-selected="true" aria-controls="exploration-report-panel-coverage" tabindex="0"/);
    assert.match(html, /role="tabpanel" id="exploration-report-panel-coverage" aria-labelledby="exploration-report-tab-coverage"/);
    let message;
    view.exploreClick({ dataset: { x: "pause" } }, model, value => { message = value; }, () => {});
    assert.deepEqual(message, {type: "explorationPause", id: report.id});
});

test("reapplying an equivalent edited plan produces fresh setup markup for the new validated draft", async () => {
    const view = await loadView(), t = messagesFor("zh-CN");
    const flow = { id: "first", name: "Language", kind: "linear", plan: {version: "1", steps: [{command: "back"}]},
        checkpoints: [{index: 0, label: "返回"}], defaultCheckpoints: [0] };
    const model = { device: "test", devices: ["test"], explorationFlow: flow };
    view.exploreClick({dataset: {x: "mode", id: "flow"}}, model, () => {}, () => {});
    const first = view.explorationView(model, t);
    flow.id = "reviewed";
    const again = view.explorationView(model, t);
    assert.notEqual(first, again);
    assert.match(again, /name="x-checkpoint"[\s\S]*?data-checkpoint="0" checked/);
    assert.match(again, /第 1 步后 · 返回/);
    assert.match(again, /data-x="start"(?! disabled)/);
});

test("guided setup keeps all case choices visible and blocks only unavailable positions", async () => {
    const view=await loadView(),t=messagesFor("zh-CN");
    const {prepareFlow}=require("../src/explorationFlow");
    const stepNames={0:"重置页面",1:"确认订单"};
    const flow={...prepareFlow({version:"2",steps:[{command:"press",input:{target:{text:"重置用例"}}},{command:"back"}],
        goals:[{selector:{text:"提交付款"},property:"enabled",equals:true}]},"zh-CN",stepNames),
        id:"order",name:"准备测试订单",sourceUri:"file:///order",stepNames};
    const model={device:"demo",devices:["demo"],explorationFlow:flow,cases:[
        {name:"准备测试订单",uri:"file:///order"},{name:"另一用例",uri:"file:///another"}]};
    const html=view.explorationView(model,t);
    assert.match(html,/data-id="file:\/\/\/order" aria-current="true"/);
    assert.match(html,/data-id="file:\/\/\/another"[^>]*>另一用例/);
    assert.doesNotMatch(html,/<details id="x-case-source"/);
    assert.match(html,/data-checkpoint="-1" checked/);
    assert.match(html,/data-checkpoint="0"\s+disabled/);
    assert.match(html,/第 1 步后 · 重置页面/);
    assert.match(html,/用例起点/);
    assert.doesNotMatch(html,/data-x="start"[^>]* disabled/);
    assert.doesNotMatch(html,/type="checkbox"/);
});

test("selecting guided mode waits for an explicit source and a disconnected phone only blocks starting",async()=>{
    const view=await loadView(),t=messagesFor("zh-CN"),messages=[];
    const model={plan:{name:"Current",uri:"file:///current"},devices:[],cases:[{name:"Other",uri:"file:///other"}]};
    view.exploreClick({dataset:{x:"mode",id:"flow"}},model,msg=>messages.push(msg),()=>{});
    assert.deepEqual(messages,[]);
    const clickCase={dataset:{x:"flow",source:"case",id:"file:///other"}};
    view.exploreClick(clickCase,model,msg=>messages.push(msg),()=>{});
    assert.deepEqual(messages.map(m=>[m.type,m.uri]),[["explorationFlow","file:///other"]]);
    model.explorationFlow={id:"manual",name:"Other",sourceUri:"file:///other",plan:{steps:[{command:"back"}]},
        checkpoints:[{index:-1},{index:0,label:"Back"}],defaultCheckpoints:[0]};
    const html=view.explorationView(model,t);
    assert.match(html,/data-checkpoint="0" checked>/);
    assert.doesNotMatch(html,/data-checkpoint="-1"[^>]*disabled/);
    assert.match(html,/data-x="start"[^>]* disabled/);
    assert.match(html,/连接并选择设备/);
    view.exploreClick(clickCase,model,msg=>messages.push(msg),()=>{});
    assert.equal(messages.length,1);
});

test("a report counts independent retests, gates device actions and preserves editable review notes", async () => {
    const view = await loadView(), t = messagesFor("zh-CN");
    const failure = {id: "f", title: "计数器", kind: "failure", canRecheck: true};
    const review = {id: "r", title: "停留原页", kind: "review", reviewStatus: "open", note: "原备注"};
    const model = {device: "phone", devices: ["phone"], exploration: {id: "report-check", status: "completed",
        device: "phone", inputs: 1, maxInputs: 20, pages: [], steps: [], findings: [failure, review]}};
    const render = () => view.explorationView(model, t);
    assert.match(render(), /尚未独立复测/);
    failure.retests = [{status: "passed"}, {status: "reproduced"}, {status: "inconclusive", reason: "无法返回起点"}];
    assert.match(render(), /复现 1 次，通过 1 次，结果不明 1 次/);
    assert.match(render(), /无法返回起点/);
    assert.doesNotMatch(render(), /data-x="recheck"[^>]*disabled/);
    model.device = "other";
    assert.match(render(), /data-x="recheck"[^>]*disabled/);
    model.device = "phone";
    model.exploration.status = "paused";
    assert.match(render(), /data-x="recheck"[^>]*disabled/);

    let message;
    const click = x => view.exploreClick({dataset: {x, id: "r"}}, model, v => { message = v; }, () => {});
    view.exploreInput({dataset: {xNote: "r"}, value: "期望返回设置"}, model);
    click("note");
    assert.deepEqual(message, {type: "explorationTriage", id: "report-check", findingId: "r", reviewStatus: "open", note: "期望返回设置"});
    click("triage");
    assert.equal(message.reviewStatus, "ignored");
    review.reviewStatus = "ignored";
    assert.match(render(), /重新打开/);
    click("triage");
    assert.equal(message.reviewStatus, "open");
});

test("checking findings opens only the current preview and unchecking returns to the previous one",async t=>{
    const view=await loadView(), {listSelectionClick,listSelectionChange}=await loadWebview("ui/listSelection");
    const findings=["first","second"].map(id=>({id,title:id,kind:"review"}));
    const model={devices:[],exploration:{id:"select-findings",status:"completed",findings,pages:[],steps:[]}};
    const render=()=>view.explorationView(model,messagesFor("en"));
    global.document={querySelector:()=>null}; t.after(()=>{delete global.document;});
    render();
    listSelectionClick({dataset:{listName:"exploration-findings",listAction:"start"}},()=>{},render);
    const check=(id,checked)=>listSelectionChange({dataset:{listPick:"exploration-findings"},value:id,checked},render);
    const open=()=>Array.from(render().matchAll(/<details class="x-finding"[^>]*data-finding-id="([^"]+)"[^>]*\bopen\b[^>]*>/g),m=>m[1]);
    check("first",true); assert.deepEqual(open(),["first"]);
    check("second",true); assert.deepEqual(open(),["second"]);
    assert.equal(render().match(/data-list-pick="exploration-findings"[^>]+ checked/g)?.length,2);
    check("second",false); assert.deepEqual(open(),["first"]);
    check("first",false); assert.deepEqual(open(),[]);
});

test("multi-step trace directs a frozen frame to its own receipt", async () => {
    const view = await loadView(), t = messagesFor("en");
    const step = {id: "s", label: "two actions", status: "completed", runId: "run", receipts: [
        {command: "press", status: "completed", before: "a", after: "b"},
        {kind: "goal", status: "failed", before: "b", after: "c"},
    ]};
    const model = {device: "phone", devices: ["phone"], exploration: {id: "report-frames", device: "phone",
        status: "completed", pages: [], steps: [step], findings: []}};
    view.explorationView(model, t);
    let message;
    const click = dataset => view.exploreClick({dataset}, model, v => { message = v; }, () => {});
    click({x: "step", id: "s"});
    assert.match(view.explorationView(model, t), /data-phase="after" data-index="1"/);
    click({x: "evidence", id: "s", phase: "after", index: "1"});
    assert.deepEqual(message, {type: "explorationEvidence", id: "report-frames", stepId: "s", phase: "after", receiptIndex: 1});
    model.explorationEvidence = {...message, page: {nodes: [{label: "frozen result"}]}};
    assert.match(view.explorationView(model, t), /data-phase="after" data-index="1"[^]*Recorded controls[^]*frozen result/);
});
