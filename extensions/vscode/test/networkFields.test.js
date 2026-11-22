"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const load=require("../test-support/loadWebview");
const {validateRule,rewriteResponse,rewriteRequest,estimate}=require("../src/networkRules");

const w=en=>en;
const record={id:"r",method:"POST",path:"/checkout",status:503,
    request:{method:"POST",url:"https://shop.test/checkout?tag=a&x=1&tag=b",headers:{},bodyState:"json",body:{cart:[2]}},
    response:{status:503,headers:{"content-type":"application/json"},bodyState:"json",body:{retryAfter:2,info:{value:"keep"},items:[3,4]}}};
const base={id:"r",method:"POST",match:{field:"path",type:"exact",value:"/checkout"},action:"rewrite"};
const rewrite=(payload,edits)=>JSON.parse(rewriteResponse({status:503,bytes:Buffer.from(JSON.stringify(payload)),headers:{"content-type":"application/json"}},validateRule({...base,edits})).bytes);
const edit=(path,value)=>({target:"responseJson",op:"set",path,value});
test("JSON rewrite keeps unrelated fields, supports numeric array and literal object keys, and matches its preview",()=>{
    const edits=[edit(["retryAfter"],5),{target:"responseJson",op:"remove",path:["items",0]}];
    const expected={retryAfter:5,info:{value:"keep"},items:[4]};
    assert.deepEqual(rewrite(record.response.body,edits),expected);
    assert.deepEqual(estimate({...base,edits},record).response.body,expected);
    assert.deepEqual(rewrite({"0":[false]},[edit(["0",0],true)]),{"0":[true]});
    assert.deepEqual(rewrite({other:1},[edit(["missing","a"],7)]),{other:1});
    assert.deepEqual(rewrite({list:[1]},[edit(["list",8],0),edit(["list",1],false)]),{list:[1,false]});
    assert.deepEqual(rewrite({},[edit(["__proto__","new"],true)]),{});
    const special=rewrite({},[edit(["__proto__"],{ok:true})]);
    assert.ok(Object.hasOwn(special,"__proto__"));assert.deepEqual(special.__proto__,{ok:true});assert.equal({}.ok,undefined);
});
test("occurrence-specific query edits keep same-name siblings and original order",()=>{
    const orig={method:"POST",url:new URL(record.request.url),headers:{},bytes:Buffer.alloc(0)};
    const rule=validateRule({...base,edits:[{target:"query",op:"set",key:"tag",occurrence:1,value:"c"}]});
    assert.equal(rewriteRequest(orig,rule).url.search,"?tag=a&x=1&tag=c");
    rule.edits[0].op="remove";
    assert.equal(rewriteRequest(orig,rule).url.search,"?tag=a&x=1");
});
test("field editor preserves types, supports header and duplicate query rows, undo and localized invalid fields",async()=>{
    const view=await load("ui/fieldEditor"),form={body:'{"ok":true,"a":[1,2]}',headers:"",query:"tag=a&tag=b"};
    const render=()=>{},show=(key,kind)=>view.fieldView(form,key,{id:key,label:key,kind},w);
    const press=(id,act,path="")=>view.fieldClick({dataset:{fe:id,net:"field-"+act,path}},render);
    const fill=(id,path,prop,val)=>view.fieldInput({id:id+"-"+path+"-"+prop,dataset:{fe:id,path,prop},value:val},render);
    show("body","json");fill("body","0","value","false");press("body","delete","1.0");
    assert.deepEqual(JSON.parse(view.readField(form,"body",w)),{ok:false,a:[2]});
    press("body","undo");assert.deepEqual(JSON.parse(view.readField(form,"body",w)),{ok:false,a:[1,2]});
    fill("body","1.1","value","x");assert.throws(()=>view.readField(form,"body",w),err=>err.fieldId==="body-1-1-value");
    assert.match(show("body","json"),/aria-invalid="true"/);
    show("query","query");fill("query","1","value","second");assert.equal(view.readField(form,"query",w),"tag=a&tag=second");
    show("headers","headers");press("headers","add");fill("headers","0","key","X-Case");fill("headers","0","value","one");
    assert.deepEqual(JSON.parse(view.readField(form,"headers",w)),{"X-Case":"one"});
    press("headers","delete","0");assert.equal(view.readField(form,"headers",w),"");
    press("headers","undo");assert.deepEqual(JSON.parse(view.readField(form,"headers",w)),{"X-Case":"one"});
    press("headers","mode");fill("headers","","raw","invalid");assert.throws(()=>view.readField(form,"headers",w),err=>err.fieldId==="headers-raw");
});
test("a rule draft seeded from a captured JSON value produces a typed reusable rule",async()=>{
    const s=await load("networkStudio"),network={scenario:{name:"a",rules:[]},records:[record],hits:[]};
    const model={network},messages=[];
    s.openStudio("rule",network,record,undefined,edit(["retryAfter"],2));
    assert.match(s.studioView(model,w),/Captured value/);
    const fe="ns-edit-0-jsonValue";
    s.studioInput({id:fe+"-root-value",dataset:{fe,prop:"value",path:""},value:"5"},()=>{});
    s.studioClick({dataset:{net:"studio-preview"}},model,m=>messages.push(m),()=>{});
    assert.deepEqual(messages[0].rule.edits,[edit(["retryAfter"],5)]);
});
test("captured and saved scalar JSON edits preserve null, false, zero and empty text",async()=>{
    const s=await load("networkStudio"),network={scenario:{name:"typed",rules:[]},records:[record],hits:[]};
    for(const original of [null,false,0,""]){
        const operation=edit(["property"],original);
        for(const existing of [false,true]){
            const rule=existing?{...base,edits:[operation]}:undefined;
            s.openStudio("rule",network,record,rule,existing?undefined:operation);
            s.studioView({network},w);
            let request;
            s.studioClick({dataset:{net:"studio-preview"}},{network},message=>{request=message;},()=>{});
            assert.deepEqual(request.rule.edits,[operation]);
        }
    }
});
test("a missing required new value focuses the add control and adding a scalar preserves its type",async()=>{
    const view=await load("ui/fieldEditor"),form={value:"null"},w=en=>en;
    const config={id:"required",label:"New value",kind:"json",required:true,scalarDefault:true};
    view.fieldView(form,"value",config,w);
    const click=net=>view.fieldClick({dataset:{fe:"required",net:"field-"+net,path:""}},()=>{});
    click("delete");
    assert.throws(()=>view.readField(form,"value",w),error=>error.fieldId==="required-root-create");
    click("create");
    assert.equal(view.readField(form,"value",w),'""');
});
