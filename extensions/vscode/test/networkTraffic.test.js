"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const loadWebview = require("../test-support/loadWebview");

const traffic = loadWebview("networkTraffic");
const english = text => text;
const offline = {devices:[],device:""};
function exchange(id,status) {
    return {id,status,source:"har",method:"GET",path:"/"+id,startedAt:"2026-01-01T00:00:00Z",
        request:{url:"https://example.test/"+id},response:{bodyState:"json",body:{status}}};
}
function network(records) { return {records,logs:[],scenario:{rules:[]}}; }
function selected(markup) { return markup.match(/data-id="([^"]+)" aria-selected="true" tabindex="0"/)?.[1]; }

test("offline intake offers local HAR first and past steps keep their own empty state",async()=>{
    const view=await traffic;
    view.resetTraffic();
    const snapshots=network([]);
    const render=()=>view.trafficView(offline,snapshots,english,"en");
    assert.match(render(),/class="net-source-list"><button type="button" data-net="har"/);
    assert.doesNotMatch(render(),/id="net-filter"/);
    snapshots.stepLabel="Recorded step";
    assert.match(render(),/No timestamp for this step/);
    assert.doesNotMatch(render(),/class="net-intake"/);
});

test("incoming records keep the inspected request through failures and base URL filters",async()=>{
    const view=await traffic;
    view.resetTraffic();
    const state=network([exchange("aborted",0),exchange("missing",404),exchange("error",503),exchange("good",200)]);
    const render=()=>view.trafficView(offline,state,english,"en");
    assert.equal(selected(render()),"good");
    assert.match(render(),/>3 failures<\/button>/);
    view.trafficClick({dataset:{net:"failures"}},render);
    assert.equal(selected(render()),"error");
    assert.equal((render().match(/role="option"/g)||[]).length,3);
    state.records.push(exchange("new-error",500));
    assert.equal(selected(render()),"error");
    view.trafficClick({dataset:{net:"failures"}},render);
    assert.equal(selected(render()),"good");
    view.trafficInput({id:"net-filter",value:"path:missing"},render);
    assert.match(render(),/>1 failure<\/button>/);
    assert.equal(selected(render()),"missing");
    view.trafficInput({id:"net-filter",value:"path:good"},render);
    assert.doesNotMatch(render(),/data-net="failures"/);
    view.trafficInput({id:"net-filter",value:"absent"},render);
    assert.match(render(),/No requests match these filters/);
    view.trafficInput({id:"net-filter",value:""},render);
    assert.equal(selected(render()),"good");
});

test("retained JSON syntax escapes payloads, preserves text and leaves active matches intact",async()=>{
    const {detailView}=await loadWebview("networkDetail");
    const row=exchange("detail",200), body={note:'<img onerror="x"> & test',missing:null,amount:-12.5,enabled:true};
    row.response.body=body;
    const render=hit=>detailView(row,[row],{tab:"response"},hit,english,"en",false);
    const markup=render();
    for (const token of ["key","string","number","literal"]) assert.match(markup,new RegExp('class="net-json-'+token+'"'));
    assert.doesNotMatch(markup,/<img/);
    const bodyHtml=markup.match(/<pre class="net-field-value">(.*?)<\/pre>/s)[1];
    const decoded=bodyHtml.replace(/<[^>]*>/g,"").replaceAll("&quot;",'"').replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&amp;","&");
    assert.equal(decoded,JSON.stringify(body,null,2));
    const start=decoded.indexOf("test");
    assert.match(render({field:"responseBody",start,end:start+4}),/<mark id="net-current-match">test<\/mark>/);
    row.response={bodyState:"text",body:'{"ordinary":2}'};
    assert.doesNotMatch(render(),/class="net-json-/);
});
