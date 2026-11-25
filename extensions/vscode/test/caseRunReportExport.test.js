"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CaseRunReports } = require("../src/caseRunReport");

test("single-run export defers archived reads, writes one offline file and freezes only its own evidence", async()=>{
    const id="recorded-run";
    const uri={path:"/archive/report.html"};
    const entry={id,source:"device",status:"failed",plan:{name:'Payment </title><script>bad()</script>'}};
    const markers="</template><script>bad()</script>";
    const rows=[
        {kind:"command",path:"steps[0]",status:"completed",before:"shared",after:"shared"},
        {kind:"assert",path:"steps[1]",status:"failed",before:"shared",after:"missing",expected:"Paid",actual:markers,
            at:"2026-01-01T00:00:01Z",elapsedMs:300,screenshot:"missing.png"},
        {kind:"assert",path:"steps[2]",status:"passed",label:"Password shows ••••",expected:"sensitive-value",actual:"sensitive-value"},
    ];
    let chosen,reads=0,html;
    const frames=[];
    const bench={language:"en",state:{runs:[entry,{id:"other-trial",source:"device",repairOf:id,status:"passed"}]},
        context:{workspaceState:{get:()=>{reads++;return {steps:rows};}}},stateDir:__dirname,
        reportAgent:()=>({call:async(kind,input)=>{
            assert.equal(kind,"inspect");
            assert.equal(input.run_id,id);
            frames.push(input.frame_id);
            if (input.frame_id==="missing") throw Error("unavailable");
            return {nodes:[{text:markers}]};
        }}),networks:{evidenceForStep:async()=>({records:[
            {path:"/payment?sensitive=secret",source:"fixture",caseRunId:id,status:503},
            {path:"/other-case",caseRunId:"other-run",status:204}],logs:[{message:"Bearer private-log-token",caseRunId:id}]})}};
    const vscode={Uri:{joinPath:()=>uri},ProgressLocation:{Notification:1},
        workspace:{workspaceFolders:[{uri}],fs:{writeFile:async(_,buffer)=>{html=buffer.toString("utf8");}}},
        window:{showSaveDialog:async()=>chosen,withProgress:(_,work)=>work(),showInformationMessage:async()=>undefined,
            showErrorMessage:error=>assert.fail(error)}};
    const reports=new CaseRunReports(bench,vscode);
    await reports.export(id);
    assert.equal(reads,0);
    chosen=uri;
    assert.equal(await reports.export(id),uri);
    assert.equal(reads,1);
    assert.deepEqual(frames.sort(),["missing","shared"]);
    assert.match(html,/<html lang="en" data-archived-report>/);
    assert.match(html,/--disclosure-angle:45deg/);
    assert.match(html,/id="archived-record-1" data-before="0" data-after="1"/);
    assert.equal(html.match(/<template id="archived-tree-/g).length,2);
    assert.doesNotMatch(html,/<button[^>]+(?:data-export-report|data-related)/);
    assert.match(html,/Related runs/);
    assert.match(html,/Archived UI tree unavailable/);
    assert.match(html,/Saved screenshot unavailable/);
    assert.match(html,/<code>\/payment<\/code>/);
    assert.doesNotMatch(html,/sensitive=secret|other-case|private-log-token|sensitive-value|<script>bad\(\)<\/script>|<script\s+src=|<link\s+rel="stylesheet"/);
    assert.match(html,/&lt;\/template&gt;&lt;script&gt;/);
    const nonce=html.match(/script-src 'nonce-([^']+)'/)[1];
    assert.ok(html.includes('<script nonce="'+nonce+'">'));
});
