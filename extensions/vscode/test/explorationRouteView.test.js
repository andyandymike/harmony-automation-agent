"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {messagesFor} = require("../src/strings");
const {summary} = require("../src/explorationStore");
const loadWebview = require("../test-support/loadWebview");

function report(id) {
    return {
        id, mode:"flow", status:"completed", source:"语言设置", goal:"确认语言", device:"phone",
        sourceCase:{uri:"file:///language.json",digest:"a-version"},
        plan:{steps:[{command:"press",input:{target:{text:"语言"}}},{command:"back"}]},
        inputs:7, maxInputs:20, pages:[], branches:[
            {id:"baseline",kind:"baseline",status:"passed"},
            {id:"a",kind:"variant",checkpoint:0,status:"failed",choice:{strategy:"replace",label:"取消"}},
            {id:"b",kind:"variant",checkpoint:0,status:"pending"}],
        checkpointDetails:[{index:0,label:"打开语言选项",nextLabel:"按系统返回",checks:["语言为 English"]}],
        steps:[{id:"ret",key:"a/suffix",status:"failed",receipts:[]}],
        findings:[{id:"mismatch",kind:"failure",stepId:"ret",canRecheck:true,
            selector:{id:"language"},expected:"English",actual:"<Changed>"}]
    };
}

test("guided reports compare paths first, preserve source and make the failed check actionable", async () => {
    const view = await loadWebview("exploration"), t = messagesFor("zh");
    const r = report("guided-results"), model = {exploration:r,device:"phone",devices:["phone"],
        explorationCaseRoutes:{main:true,branchIds:["baseline"],findingIds:["mismatch"]}};
    const render = () => view.explorationView(model,t);
    const html = render();
    assert.match(html,/exploration-report-tab-routes[^>]*aria-selected="true"/);
    assert.match(html,/有走法未通过检查/);
    assert.match(html,/打开语言选项[^]*按系统返回[^]*语言为 English[^]*取消[^]*English[^]*&lt;Changed&gt;[^]*未测/);
    assert.match(html,/已尝试 1 条其他走法/);
    assert.match(html,/data-x="recheck" data-id="mismatch"[^>]*>独立复测/);
    assert.match(html,/data-x="caseFinding" data-id="mismatch"[^>]*>另存为回归用例/);
    assert.match(html,/data-x="viewSourceCase"/);
    assert.doesNotMatch(html,/data-x="(caseMain|insertMain|insertFinding|insertBranch|applyBranchDifference)"|<Changed>/);
    model.device = "other";
    assert.match(render(),/data-x="recheck" data-id="mismatch" disabled/);
    assert.equal(summary(r).originalStatus,"passed");
    assert.deepEqual(summary(r).variationStates,["failed","pending"]);
});

test("guided progress follows device phases and route selection survives the run finishing", async () => {
    const view = await loadWebview("exploration"), t = messagesFor("en");
    const r = report("guided-live");
    Object.assign(r,{status:"running",findings:[],steps:[]});
    r.branches[1].status = "running";
    const model = {exploration:r,devices:["phone"],device:"phone"};
    const render = () => view.explorationView(model,t);
    for (const [phase,pattern] of [["anchor",/Returning to After step 1/],["variant",/Trying 取消/],
        ["return",/Returning from 取消/],["check",/Continuing the case and checking its expectations/]]) {
        r.pending = {phase}; assert.match(render(),pattern);
    }
    assert.doesNotMatch(render(),/data-x="viewSourceCase"/);
    r.status = "completed";
    r.branches[1].status = "incomplete";
    r.reason = "Time budget reached.";
    assert.match(render(),/Exploration incomplete[^]*Time budget reached[^]*Untested/);
    assert.match(render(),/exploration-report-tab-routes[^>]*aria-selected="true"/);
});

test("a fork report distinguishes a reached position from a verified case and offers review only on its branch", async () => {
    const view = await loadWebview("exploration"), t = messagesFor("zh");
    const r = report("fork-result");
    Object.assign(r,{routeMode:"fork",findings:[],steps:[],branches:[
        {id:"prefix",kind:"prefix",status:"completed"},
        {id:"help",kind:"variant",checkpoint:-1,status:"completed",choice:{label:"帮助中心"}}
    ]});
    const model = {exploration:r,devices:[],explorationCaseRoutes:{branchIds:["help"]}};
    const html = view.explorationView(model,t);
    assert.match(html,/脚本回放[^]*已到达分叉位置[^]*用例起点[^]*帮助中心[^]*data-x="caseBranch" data-id="help"[^>]*>预览为新用例/);
    assert.doesNotMatch(html,/data-x="applyBranchDifference"|继续原用例并核对预期/);
    const entry = summary(r);
    assert.equal(entry.prefixStatus,"completed");
    assert.equal(entry.originalStatus,undefined);
    assert.deepEqual(entry.variationStates,["completed"]);
    r.branches[0].status = "failed";
    r.branches[1].status = "incomplete";
    r.status = "blocked";
    r.findings = [{id:"problem",kind:"failure",branchId:"prefix",title:"订单列表未出现"}];
    model.explorationCaseRoutes = {};
    const failed = view.explorationView(model,t);
    assert.match(failed,/脚本未到达分叉位置[^]*订单列表未出现/);
    assert.doesNotMatch(failed,/class="x-route-values"|data-x="caseBranch"/);
});

test("archived routes without source metadata use recorded steps and never offer writes to an unknown source", async () => {
    const view = await loadWebview("exploration"), t = messagesFor("en");
    const r = report("guided-archive");
    delete r.sourceCase;
    delete r.checkpointDetails;
    r.branches[1].status="passed"; r.branches[2].status="skipped";
    r.branches[1].choice={label:"Open details",strategy:"detour"}; r.findings=[];
    const model={exploration:r,devices:[],explorationCaseRoutes:{branchIds:["baseline","a"]}};
    const html=view.explorationView(model,t);
    assert.match(html,/After step 1 · Press · 语言/);
    assert.match(html,/Original path[^]*Back[^]*Open details[^]*Save as a regression case/);
    assert.doesNotMatch(html,/data-x="applyBranchDifference"|data-x="viewSourceCase"/);
    r.sourceCase={uri:"file:///source",digest:"current"};
    model.explorationCaseRoutes.diffBranchIds=["a"];
    assert.match(view.explorationView(model,t),/data-x="applyBranchDifference" data-id="a"/);
    const sent=[];
    const click=(x,id)=>view.exploreClick({dataset:{x,id}},model,m=>sent.push(m),()=>{});
    click("applyBranchDifference","a"); click("viewSourceCase"); click("caseBranch","a");
    assert.deepEqual(sent,[
        {type:"caseCompose",action:"reviewBranchDifference",reportId:r.id,branchId:"a"},
        {type:"caseCompose",action:"viewExplorationSource",reportId:r.id},
        {type:"explorationCase",id:r.id,branchId:"a"}]);
});
