"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const {saveReportHtml}=require("../src/reportHtmlFile");

test("report export builds only after a destination is chosen and preserves Unicode",async()=>{
    let destination,bytes,suggestion,builds=0,notice;
    const vscode={Uri:{file:path=>({path}),joinPath:(folder,name)=>({path:folder.path+"/"+name})},
        workspace:{workspaceFolders:[{uri:{path:"/project"}}],fs:{writeFile:async(uri,value)=>{
            assert.strictEqual(uri,destination);bytes=value;
        }}},ProgressLocation:{Notification:1},window:{
            showSaveDialog:async options=>{suggestion=options.defaultUri;return destination;},
            withProgress:async(_,work)=>work(),showInformationMessage:async msg=>{notice=msg;},
            showErrorMessage:async msg=>{notice=msg;}
        }};
    const options={title:"导出",language:"zh-CN",filename:"支付/重试?.html",build:async()=>{builds++;return "已通过";}};
    assert.equal(await saveReportHtml(vscode,options),undefined);
    assert.equal(builds,0);
    assert.equal(suggestion.path,"/project/支付-重试-.html");
    destination={path:"/chosen.html"};
    assert.strictEqual(await saveReportHtml(vscode,options),destination);
    assert.equal(bytes.toString("utf8"),"已通过");
    assert.match(notice,/已导出 chosen.html/);
    const saved=bytes;
    assert.equal(await saveReportHtml(vscode,{...options,build:async()=>{throw Error("unavailable");}}),undefined);
    assert.match(notice,/导出报告失败.*unavailable/);
    assert.strictEqual(bytes,saved);
});
