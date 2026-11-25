"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CaseRunReports, buildRunReportData, cropForAssertion, scopedRequests } = require("../src/caseRunReport");
const { renderEvidence } = require("../src/caseRunReportView");
const { renderDurationChart } = require("../src/caseRunReportChart");
const { gatewayIssue } = require("../src/aiEvidence");

test("the run outline uses editor steps and preserves all receipts from references and retries",()=>{
    const root = {entry:{time:"2026-01-01T00:00:00Z",status:"failed"},plan:{goals:[{property:"text",equals:"Paid"}]},
        bdd:{steps:[
            {area:"step",path:"steps[0]",text:"Prepare order",reference:{},branches:[{steps:[
                {path:"steps[0].linked.steps[0]",receiptPath:"steps[0]",text:"Create order"},
                {path:"steps[0].linked.steps[1]",receiptPath:"steps[1]",text:"Confirm order"},
            ]}]},
            {area:"step",path:"steps[1]",receiptPath:"steps[2]",name:"Retry payment",branches:[{steps:[
                {path:"steps[1].repeat.steps[0]",receiptPath:"steps[2].repeat.steps[0]",text:"Pay"},
            ]}]},
            {area:"step",path:"steps[2]",receiptPath:"steps[3]",name:"Verify upstream"},
            {area:"step",path:"steps[3]",receiptPath:"steps[4]",name:"Verify stock"},
            {area:"goal",path:"goals[0]",text:"Payment successful"},
        ]},steps:[
            {kind:"command",path:"steps[0]",status:"completed"},
            {kind:"command",path:"steps[1]",status:"completed"},
            {kind:"repeat",path:"steps[2].repeat.check[0]",status:"failed",condition:"failed"},
            {kind:"command",path:"steps[2].repeat.iteration[0][0]",status:"completed"},
            {kind:"command",path:"steps[2].repeat.iteration[1][0]",status:"completed"},
            {kind:"command",path:"steps[3]",status:"failed",errorCode:"ASSERTION_TIMEOUT"},
        ]};
    const {rows,outline} = buildRunReportData(root,"en");
    assert.deepEqual(rows.map(row=>row.title),["Create order","Confirm order","Retry payment","Pay","Pay","Verify upstream"]);
    assert.deepEqual(rows.slice(3,5).map(row=>row.iteration),[1,2]);
    assert.equal(rows[2].isBlocking,false);
    assert.equal(rows[5].businessNumber,3);
    assert.equal(outline.focusIndex,5);
    assert.deepEqual(outline.groups.map(group=>group.indices),[[0,1],[2,3,4],[5],[],[]]);
    assert.deepEqual(outline.groups.map(group=>group.status),["completed","completed","failed","not_run","not_run"]);
    assert.equal(outline.goals[0].caption,"Paid");

    const trial = {...root,entry:{...root.entry,status:"completed",repairTarget:"steps[2].repeat.iteration[1][0]"},steps:root.steps.slice(0,5)};
    const {outline:scoped} = buildRunReportData(trial,"en");
    assert.equal(scoped.targetIndex,4);
    assert.equal(scoped.focusIndex,4);
    assert.equal(scoped.targetGroup.number,2);
    assert.equal(scoped.groups[2].status,"out_of_scope");
    assert.equal(scoped.goals[0].status,"out_of_scope");
});

test("goal receipts and older assertion summaries remain distinct from missing coverage",()=>{
    const bdd = {steps:[{area:"start",path:"preconditions[0]",text:"Ready"},
        {area:"goal",path:"goals[0]",text:"Payment"}, {area:"goal",path:"goals[1]",text:"Stock"}]};
    const run = {entry:{status:"passed"},bdd,steps:[
        {kind:"precondition",path:"preconditions[0]",status:"passed"},
        {kind:"goal",path:"goals[0]",status:"passed",expected:"Paid"},
    ],finalAssertions:[{status:"passed",expected:"Paid"},{status:"passed",expected:"Available"}]};
    const {rows,outline} = buildRunReportData(run,"en");
    assert.equal(rows.length,2);
    assert.equal(outline.focusIndex,1);
    assert.deepEqual(outline.goals.map(group=>[group.caption,group.status]),[["Paid","passed"],["Available","passed"]]);
    const unknown = buildRunReportData({...run,steps:[],finalAssertions:undefined},"en");
    assert.deepEqual(unknown.outline.goals.map(group=>group.status),["unknown","unknown"]);
});

test("an ambiguous or stale frozen UI match keeps the original screenshot",()=>{
    const screen = {bounds:{left:0,top:0,right:1080,bottom:2400}};
    const match = {type:"paragraph",text:"Payment 502",bounds:{left:40,top:1240,right:1030,bottom:1310}};
    const row = {actual:match.text,property:"text",assertionStatus:"failed",selector:{type:"paragraph"},
        screenshotAt:"2026-01-01T00:00:02Z"};
    const frame = {capturedAt:"2026-01-01T00:00:00Z",nodes:[screen,match]};
    const crop = cropForAssertion(row,frame);
    assert.ok(crop.top<=match.bounds.top && crop.top+crop.height>=match.bounds.bottom);
    assert.deepEqual(crop.screen,{width:1080,height:2400});
    assert.equal(cropForAssertion(row,{...frame,nodes:[screen,match,{...match}]}),undefined);
    assert.equal(cropForAssertion({...row,screenshotAt:"2026-01-01T00:01:00Z"},frame),undefined);
});

test("reopening a retained report refreshes its diagnosis and keeps the chosen receipt", async () => {
    const documents = [], messages = [];
    let receive;
    const id = "device-replay";
    const entry = {id,source:"device",status:"failed"};
    const replay = {steps:[
        {kind:"command",path:"steps[0]",status:"failed",errorCode:"ASSERTION_TIMEOUT"},
        {kind:"command",path:"steps[1]",status:"completed"},
    ]};
    const bench = {language:"en",state:{runs:[entry],aiResults:{}},
        context:{extensionUri:"extension",workspaceState:{get:()=>replay}}, errorMessage:error=>error.message};
    const webview = {cspSource:"test",asWebviewUri:uri=>uri,postMessage:message=>messages.push(message),
        onDidReceiveMessage:handler=>{receive=handler;},set html(value){documents.push(value);}};
    const panel = {webview,onDidDispose(){},reveal(){}};
    const reports = new CaseRunReports(bench,{Uri:{joinPath:(...parts)=>parts.join("/")},
        ViewColumn:{Active:1},window:{createWebviewPanel:()=>panel}});
    await reports.open(id);
    assert.match(documents.at(-1),/id="report-evidence" data-step="0"/);
    const initialDocuments = documents.length;
    await receive({type:"evidence",request:1,index:1});
    await reports.open(id);
    assert.equal(documents.length,initialDocuments);

    bench.state.aiResults.diagnosis = {key:id+"/failure",status:"done",answer:"Fresh scoped finding"};
    await reports.open(id);
    assert.equal(documents.length,initialDocuments+1);
    assert.match(documents.at(-1),/Fresh scoped finding/);
    assert.match(documents.at(-1),/id="report-evidence" data-step="1"/);
    await reports.open(id,0);
    assert.equal(documents.length,initialDocuments+1);
    assert.deepEqual(messages.at(-1),{type:"focus",index:0});
});

test("request receipts exclude other runs and distinguish untagged records from matched requests",()=>{
    const matching = {caseRunId:"a",source:"gateway",method:"GET",path:"/pay?token=hidden",status:502,error:"UPSTREAM_FAILED"};
    const untagged = {source:"fixture",method:"GET",path:"/fixture/<tag>",status:503};
    const requests = scopedRequests([untagged,{...matching,caseRunId:"b",path:"/other"},matching],"a");
    assert.deepEqual(requests,[matching,untagged]);
    const html = renderEvidence({title:"<unsafe>",isBlocking:true},{requests,runId:"a",gatewayIssue},"en");
    assert.match(html,/UPSTREAM_FAILED/);
    assert.match(html,/Time overlap only/);
    assert.match(html,/&lt;unsafe&gt;/);
    assert.match(html,/\/fixture\/&lt;tag&gt;/);
    assert.doesNotMatch(html,/\/other|token=hidden|<unsafe>/);
});

test("gesture report includes the recorded pause but only loads network evidence for the dispatched action",async()=>{
    const entry={id:"timed-gesture",source:"device",status:"completed"};
    const at="2026-01-01T00:00:01.250Z";
    const receipt={kind:"command",path:"steps[0]",status:"completed",at,elapsedMs:50,
        stepStartedAt:"2026-01-01T00:00:00Z",stepElapsedMs:1250};
    const replay={steps:[receipt],bdd:{steps:[{area:"step",path:"steps[0]",text:"Tap"}]}};
    let html,receive,networkTiming,evidence;
    const bench={language:"en",state:{runs:[entry]},context:{extensionUri:"extension",workspaceState:{get:()=>replay}},
        networks:{async evidenceForStep(id,path,timing){networkTiming=timing;return {records:[],logs:[]};}}};
    const webview={cspSource:"test",asWebviewUri:uri=>uri,set html(value){html=value;},
        onDidReceiveMessage:handler=>receive=handler,postMessage:message=>evidence=message.html};
    const vscode={Uri:{joinPath:(...parts)=>parts.join("/")},ViewColumn:{Active:1},
        window:{createWebviewPanel:()=>({webview,onDidDispose(){}})}};
    await new CaseRunReports(bench,vscode).open(entry.id);
    assert.match(html,/Longest step/);
    assert.match(html,/1\.25 s/);
    await receive({type:"evidence",index:0,request:1});
    assert.deepEqual(networkTiming,{at,elapsedMs:50});
    assert.match(evidence,/Step duration<\/dt><dd>1\.25 s/);
    assert.match(evidence,/Action time<\/dt><dd>50 ms/);

    delete receipt.stepElapsedMs;
    await new CaseRunReports(bench,vscode).open(entry.id);
    assert.match(html,/Longest timed action/);
    assert.match(html,/<span>Action time<\/span>/);
    assert.doesNotMatch(html,/1\.25 s/);
});

test("the duration profile measures real receipts and preserves untimed entries",()=>{
    const rows = [
        {index:0,title:"A & B",elapsedMs:0,status:"completed"},
        {index:1,title:"Missing timing",status:"completed"},
        {index:2,title:"Assertion timeout",elapsedMs:6312,isBlocking:true},
        {index:3,kind:"unreachedGoals"},
    ];
    const plot = renderDurationChart(rows,2,"en");
    assert.equal((plot.match(/data-chart-step=/g) || []).length,3);
    assert.match(plot,/data-chart-step="0"[^>]*data-ratio="0"[^>]*aria-label="[^"]*0 ms/);
    assert.match(plot,/data-chart-step="1"[^>]*data-untimed/);
    assert.match(plot,/data-chart-step="2"[^>]*data-ratio="1"[^>]*aria-pressed="true"/);
    assert.match(plot,/Max 6.31 s/);
    assert.match(plot,/A &amp; B/);
    assert.equal(renderDurationChart(rows.slice(1,2),1,"en"),"");
});

test("the report distinguishes execution order from the authored step during retries",()=>{
    const row = {title:"Payment",index:21,path:"steps[13]",businessNumber:8,isBlocking:true,firstBlocking:true,elapsedMs:6312};
    const html = renderEvidence(row,{},"en");
    assert.match(html,/Case step 8/);
    assert.match(html,/First blocking step/);
    assert.doesNotMatch(renderEvidence({...row,path:"preconditions[0]",businessNumber:undefined},{},"en"),/Case step/);
});
