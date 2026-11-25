"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const os=require("node:os"),path=require("node:path"),fs=require("node:fs/promises");
const {archiveFacts,TestRunOverviewPanel}=require("../src/testRunOverviewPanel");
const {createHash}=require("node:crypto");

test("run overview reads a matching archived journal and exposes no raw failure text",async t=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),"ha-overview-"));
    t.after(()=>fs.rm(root,{recursive:true,force:true}));
    const dir=path.join(root,"runs","abc");
    await fs.mkdir(dir,{recursive:true});
    const file=path.join(dir,"run.json");
    const record={runId:"abc",startedAt:"2026-11-24T01:00:00Z",finishedAt:"2026-11-24T01:00:02Z",
        planDigest:"snapshot",receipts:[{path:"steps[2]",error:{code:"ASSERTION_TIMEOUT",message:"private-message"}}],result:{}};
    await fs.writeFile(file,JSON.stringify(record));
    const facts=await archiveFacts({stateDir:root},{id:"abc",status:"failed"});
    assert.equal(facts.durationMs,2000);assert.equal(facts.failureCode,"ASSERTION_TIMEOUT");assert.equal(facts.failurePath,"steps[2]");
    assert.doesNotMatch(JSON.stringify(facts),/private-message/);
    await fs.writeFile(file,JSON.stringify({...record,runId:"different"}));
    assert.equal((await archiveFacts({stateDir:root},{id:"abc",status:"failed"})).failureCode,undefined);
});

test("scope and report navigation use only retained records and preserve the chosen scope on reveal",async()=>{
    const reports=[],updates=[];let receive,disposed;
    const webview={cspSource:"test",asWebviewUri:value=>value,onDidReceiveMessage:handler=>{receive=handler;},postMessage:value=>updates.push(value)};
    const panel={webview,reveal(){},onDidDispose:handler=>{disposed=handler;},dispose:()=>disposed()};
    let html;
    const vscode={window:{createWebviewPanel:()=>panel,showSaveDialog:async()=>({path:"/test.html"}),
        withProgress:(_,build)=>build(),showInformationMessage:async()=>{}},ProgressLocation:{Notification:1},
        workspace:{fs:{writeFile:async(_,buffer)=>{html=buffer.toString("utf8");}}},
        Uri:{joinPath:(...parts)=>parts.join("/"),file:val=>val},ViewColumn:{Active:1}};
    const item=id=>({id,source:"device",time:"2026-11-24T10:00:00Z",status:"passed",caseId:id,plan:{name:"<"+id+">"}});
    const bench={language:"en",state:{runs:[item("first"),item("second"),{...item("busy"),status:"running"}]},
        context:{extensionUri:"media",workspaceState:{get:()=>({runtimeMs:60})}},caseRunReports:{open:id=>reports.push(id)}};
    const view=new TestRunOverviewPanel(bench,vscode);
    await view.open();await receive({type:"ready"});
    assert.match(updates.at(-1).content,/&lt;first&gt;/);
    await receive({type:"scope",scope:"custom",ids:["first","absent"]});
    assert.deepEqual(updates.at(-1).selected,["first"]);
    assert.doesNotMatch(updates.at(-1).content,/data-record-id="second"/);
    await view.open();
    assert.equal(updates.at(-1).scope,"custom");
    await receive({type:"export",ticket:updates.at(-1).ticket});
    assert.match(html,/Selected runs/);
    assert.match(html,/data-record-id="first"/);
    assert.doesNotMatch(html,/data-record-id="second"|data-open-run=|<script src=|<link rel="stylesheet"/);
    assert.match(html,/--disclosure-angle:45deg/);
    assert.match(html,/&lt;first&gt;/);
    const script=html.match(/<script>([\s\S]+?)<\/script>/)[1];
    assert.ok(html.includes("'sha256-"+createHash("sha256").update(script).digest("base64")+"'"));
    for (const id of ["absent","busy","first"]) await receive({type:"report",id});
    assert.deepEqual(reports,["first"]);
    view.dispose();
});
