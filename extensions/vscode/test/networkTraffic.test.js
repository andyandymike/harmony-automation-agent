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

test("empty intersections keep the failures filter and collection changes restore the original investigation",async()=>{
    const view=await traffic,state=network([exchange("stock",200),exchange("payment",502)]);
    state.favorites=[{name:"Saved stock",record:state.records[0]}];
    view.resetTraffic();
    const render=()=>view.trafficView(offline,state,english,"en");
    const click=(net,id)=>{view.trafficClick({dataset:{net,id}},render);return render();};
    click("failures");
    view.trafficInput({id:"net-filter",value:"stock"},render);
    assert.match(render(),/0 failures<\/button>/);
    assert.match(render(),/No requests match these filters/);
    assert.doesNotMatch(render(),/data-selection-id|data-net="clearTraffic"/);
    view.trafficInput({id:"net-filter",value:"payment"},render);
    click("toggleFind");
    view.trafficInput({id:"net-find",value:"502"},render);
    click("findGo");
    assert.match(click("favoritesOnly"),/Saved stock/);
    const restored=click("favoritesOnly");
    assert.match(restored,/aria-pressed="true"[^>]*>1 failure<\/button>/);
    assert.match(restored,/id="net-filter"[^>]*value="payment"/);
    assert.match(restored,/id="net-find"[^>]*value="502"/);
    assert.equal(selected(restored),"payment");
});

test("history menus remove only retained requests in the named scope including content matches",async()=>{
    const view=await traffic;
    const batch={id:"batch-a",label:"Capture A"};
    const rows=[exchange("a",503),exchange("another",502),exchange("outside",200)];
    for (const row of rows.slice(0,2)) row.batch=batch;
    const state=network(rows);
    state.favorites=[{name:"Archived",record:{...exchange("archived",200),batch}}];
    view.resetTraffic();
    const render=()=>view.trafficView(offline,state,english,"en");
    const messages=[];
    const click=(net,id)=>{view.trafficClick({dataset:{net,id}},render,value=>messages.push(value));return render();};
    assert.match(render(),/data-item-actions="history"[\s\S]*?Clear all request history \(3\)/);
    view.inspectBatch(state,batch.id);
    assert.match(render(),/Remove 2 requests in this capture/);
    assert.doesNotMatch(render(),/data-net="clearTraffic"/);
    click("removeVisible");
    assert.deepEqual(messages.at(-1),{type:"networkSelectedRequests",action:"remove",ids:["another","a"]});
    click("previousList",batch.id);
    click("toggleFind");
    view.trafficInput({id:"net-find",value:"502"},render);
    click("findGo");
    assert.match(render(),/Remove 1 content match/);
    click("removeVisible");
    assert.deepEqual(messages.at(-1).ids,["another"]);
});

test("sort toggles are stable and restore time order; repeated Enter and Shift Enter move among hits",async()=>{
    const view=await traffic;
    const rows=[exchange("late",502),exchange("early",200),exchange("unknown",201)];
    rows[0].startedAt="2026-01-03T00:00:00Z";rows[1].durationMs=300;rows[0].durationMs=2;
    rows[2].startedAt="2026-01-02T00:00:00Z";
    const state=network(rows);
    view.resetTraffic();
    const render=()=>view.trafficView(offline,state,english,"en");
    const click=(net,id)=>{view.trafficClick({dataset:{net,id}},render);return render();};
    const ids=markup=>Array.from(markup.matchAll(/data-selection-id="([^"]+)"/g),m=>m[1]);
    assert.deepEqual(ids(render()),["late","unknown","early"]);
    assert.deepEqual(ids(click("sort","durationMs")),["early","late","unknown"]);
    assert.deepEqual(ids(click("sort","durationMs")),["late","early","unknown"]);
    assert.deepEqual(ids(click("sort","status")),["late","unknown","early"]);
    assert.deepEqual(ids(click("sort","status")),["early","unknown","late"]);
    assert.deepEqual(ids(click("sort","startedAt")),["late","unknown","early"]);
    click("toggleFind");
    view.trafficInput({id:"net-find",value:"example.test"},render);
    const enter=shiftKey=>{view.trafficKeydown({target:{id:"net-find"},key:"Enter",shiftKey,preventDefault(){}},render);return render();};
    assert.match(enter(false),/1 \/ 3/);
    assert.match(enter(false),/2 \/ 3/);
    assert.match(enter(true),/1 \/ 3/);
    assert.match(enter(true),/3 \/ 3/);
});

test("modified clicks select ordered ranges and toggle individual requests",async()=>{
    const {ListSelection}=await loadWebview("ui/listSelection");
    const list=new ListSelection("traffic-test",{modifiers:true});
    list.update("history",["c","b","a","d"],false);
    list.anchor="c";
    list.selectModified("a",true,false,"c");
    assert.deepEqual(list.values,["c","b","a"]);
    list.selectModified("b",false,true);
    assert.deepEqual(list.values,["c","a"]);
    list.selectModified("d",true,true);
    assert.equal(list.all,true);
    list.update("filtered",["c","d"],false);
    assert.equal(list.active,false);
    list.selectModified("c",false,true,"c");
    assert.deepEqual(list.values,["c"]);
    list.reset();
});

test("request comparison uses two visible picks in pick order and preserves selection on return",async t=>{
    const view=await traffic;
    const {listSelectionClick,listSelectionChange}=await loadWebview("ui/listSelection");
    const rows=[exchange("a",200),exchange("b",201),exchange("c",503)];
    const state=network(rows);
    state.favorites=rows.slice(0,2).map(record=>({name:record.path,record}));
    const oldDocument=global.document;
    global.document={querySelector:()=>null,getElementById:()=>null};
    t.after(()=>{global.document=oldDocument;view.resetTraffic();});
    view.resetTraffic();
    const render=()=>view.trafficView(offline,state,english,"en");
    const action=listAction=>listSelectionClick({dataset:{listName:"requests",listAction}},()=>assert.fail("Local read"),render);
    const pick=(value,checked)=>listSelectionChange({dataset:{listPick:"requests"},value,checked},render);
    const compareButton=()=>render().match(/<button[^>]*data-list-action="compare"[^>]*>/)?.[0];
    const ids=()=>Array.from(render().matchAll(/data-comparison-id="([^"]+)"/g),match=>match[1]);
    const detail=()=>render().match(/data-record-detail="true" data-record-id="([^"]+)"/)?.[1];
    assert.equal(compareButton(),undefined);
    assert.doesNotMatch(render(),/net-baseline|data-id="compare"/);
    action("start");
    assert.match(compareButton(),/disabled/);
    pick("a",true);
    assert.equal(detail(),"a");
    assert.match(compareButton(),/disabled/);
    pick("b",true);
    assert.equal(detail(),"b");
    assert.doesNotMatch(compareButton(),/disabled/);
    assert.match(render(),/id="net-detail-body" data-list-name="requests"/);
    assert.match(render(),/data-net="detail" data-id="request" data-list-name="requests"/);
    action("compare");
    assert.deepEqual(ids(),["a","b"]);
    assert.match(render(),/class="net-detail net-comparison" data-list-name="requests"/);
    assert.match(render(),/response.body.status/);
    state.records.push(exchange("new",200));
    assert.deepEqual(ids(),["a","b"]);
    view.trafficClick({dataset:{net:"closeComparison"}},render);
    assert.deepEqual(ids(),[]);
    assert.equal(detail(),"b");
    assert.equal((render().match(/data-selection-checked/g)||[]).length,2);
    action("compare");
    pick("c",true);
    assert.deepEqual(ids(),[]);
    assert.equal(detail(),"c");
    assert.match(compareButton(),/disabled/);
    action("compare");
    assert.deepEqual(ids(),[]);
    pick("c",false);
    assert.equal(detail(),"b");
    action("compare");
    state.records=state.records.filter(row=>row.id!=="b");
    assert.deepEqual(ids(),[]);
    assert.equal(detail(),"a");
    view.trafficClick({dataset:{net:"favoritesOnly"}},render);
    assert.equal(compareButton(),undefined);
    action("start");
    pick("b",true);
    pick("a",true);
    action("compare");
    assert.deepEqual(ids(),["b","a"]);
});
