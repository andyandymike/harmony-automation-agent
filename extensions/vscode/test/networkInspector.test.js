"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../media/networkInspector.js"));
const inspector = import("data:text/javascript;base64," + source.toString("base64"));

function exchange(id, pathname, status, body) {
    return {id, source:"har", method:"GET", path:pathname, status, durationMs:15,
        request:{method:"GET",url:"https://catalog.example.test"+pathname,headers:{"x-test":"needle"},bodyState:"unavailable"},
        response:{status,headers:{"content-type":"application/json"},body,bodyState:"json"}};
}
const path503 = exchange("p","/catalog/items/503",200,{"label":"needle 12"});
const actual503 = exchange("s","/catalog/items/218",503,{"label":"needle <13>"});
const records = [path503,actual503];

test("qualified and dropdown status filters use the HTTP status while a plain term searches URLs", async () => {
    const {filterRecords} = await inspector;
    const options = {query:"",method:"",status:"",source:""};
    assert.deepEqual(filterRecords(records,{...options,query:"status:503 host:catalog.example.test method:GET"}),[actual503]);
    assert.deepEqual(filterRecords(records,{...options,query:"503"}),[path503]);
    assert.deepEqual(filterRecords(records,{...options,status:"5xx",source:"har"}),[actual503]);
    assert.deepEqual(filterRecords(records,{...options,query:"method:get path:items",status:"200"}),[path503]);
    assert.deepEqual(filterRecords(records,{...options,query:"status:50"}),[]);
});

test("scoped search finds retained field ranges and escapes rendered markup", async () => {
    const {fieldText,searchFields,highlight} = await inspector;
    const requestResults=searchFields(records,{term:"needle",scope:"requestHeaders",regex:false});
    assert.deepEqual(requestResults.hits.map(hit=>[hit.id,hit.field]),[["p","requestHeaders"],["s","requestHeaders"]]);
    const {hits}=searchFields(records,{term:"<\\d+>",scope:"responseBody",regex:true});
    assert.equal(hits.length,1);
    assert.equal(hits[0].id,"s");
    assert.match(highlight(fieldText(actual503,"responseBody"),hits[0]),/<mark id="net-current-match">&lt;13&gt;<\/mark>/);
    assert.ok(searchFields(records,{term:"(",scope:"all",regex:true}).error);
    assert.equal(searchFields(records,{term:"[]",scope:"all",regex:false}).hits.length,0);
    assert.equal(searchFields(records,{term:"unavailable",scope:"requestBody",regex:false}).hits.length,0);
});

test("comparison uses only available evidence and reports changed JSON leaf values", async () => {
    const {ruleDifferences,exchangeDifferences,changedFields} = await inspector;
    assert.deepEqual(ruleDifferences(actual503),[]);
    assert.deepEqual(changedFields({a:1,b:2},{b:2,a:1}),[]);
    const rewritten={...actual503,effectiveRequest:{...actual503.request,headers:{"x-test":"changed"}},
        originalResponse:{...actual503.response,status:202,body:{"label":"before"}}};
    assert.deepEqual(ruleDifferences(rewritten).map(change=>change.path),["request.headers.x-test","response.status","response.body.label"]);
    assert.deepEqual(exchangeDifferences(path503,actual503).map(change=>change.path),["request.url","response.status","response.body.label"]);
});

test("gateway transport metadata collapses separately from app header and JSON edits", async () => {
    const {isTransportChange} = await inspector;
    assert.ok(isTransportChange({path:"request.headers.host"}));
    assert.ok(isTransportChange({path:"response.headers.content-length"}));
    assert.ok(!isTransportChange({path:"request.headers.x-app-mode"}));
    assert.ok(!isTransportChange({path:"response.body.connection"}));
});
