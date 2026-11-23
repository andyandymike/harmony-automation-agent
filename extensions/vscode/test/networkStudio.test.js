"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const load=require("../test-support/loadWebview");
const en=(english)=>english, zh=(_,chinese)=>chinese;
function model() {
    const rec={id:"sample",method:"POST",path:"/items",request:{method:"POST",path:"/items",url:"https://sample.test/items?access_token=%5Bredacted%5D&page=1",
        headers:{"content-type":"application/json",authorization:"[redacted]",host:"sample.test","user-agent":"test"},bodyState:"unavailable"},
        status:200,response:{status:200,headers:{"content-type":"application/json"},body:{items:[{name:"old"}]},bodyState:"json"}};
    const network={running:true,upstream:"http://127.0.0.1:1234",baseUrl:"http://127.0.0.1:4321",scenario:{name:"Example",rules:[]},hits:[],records:[rec]};
    return {network,rec};
}
const input=(view,key,value,index)=>view.studioInput({dataset:{ns:key,...(index!=null&&{index:String(index)})},value},()=>{});
const click=(view,model,id,send)=>view.studioClick({dataset:{net:"studio-"+id}},model,send,()=>{});

test("unretained post body needs deliberate test input and redactions never enter replay drafts",async()=>{
    const {network,rec}=model(),view=await load("networkStudio"),draft=view.replayDraft(rec);
    assert.equal(draft.path,"/items?page=1");
    assert.deepEqual(JSON.parse(draft.headers),{"content-type":"application/json"});
    assert.throws(()=>view.toReplay(draft,en),/empty body/);
    draft.body='{"test":1}';
    assert.deepEqual(view.toReplay(draft,en),{method:"POST",sourceId:rec.id,path:"/items?page=1",body:draft.body,headers:{"content-type":"application/json"}});
    view.openStudio("resend",network,rec);
    assert.match(view.studioView({network},zh),/已省略脱敏查询值/);
    assert.match(view.studioView({network},zh),/使用空正文发送/);
});

test("studio composes a response regex rewrite, distinguishes matching history and gateway hits, and ignores obsolete previews",async()=>{
    const {network,rec}=model(),m={network},view=await load("networkStudio");
    const messages=[],send=x=>messages.push(x);
    view.openStudio("rule",network,rec);
    assert.match(view.studioView(m,en),/value="\/items"/);
    input(view,"op","regex",0); input(view,"target","responseBody",0);
    input(view,"find","old",0); input(view,"value","new",0);
    click(view,m,"preview",send);
    assert.equal(messages.length,1);const [request]=messages;
    assert.equal(request.type,"networkPreviewRule");
    assert.deepEqual(request.rule.edits,[{target:"responseBody",op:"regex",find:"old",value:"new"}]);
    network.operation={type:request.type,revision:request.revision,preview:{total:1,matchedIds:["sample"],examples:[
        {id:rec.id,request:rec.request,effectiveRequest:rec.request,originalResponse:rec.response,response:{...rec.response,body:{items:[{name:"new"}]}}}]}};
    const html=view.studioView(m,zh);
    assert.match(html,/1 \/ 1/);assert.match(html,/响应变更/);assert.match(html,/class="removed"/);assert.match(html,/class="added"/);
    input(view,"value","updated",0);assert.doesNotMatch(view.studioView(m,en),/History preview/);
    click(view,m,"apply",send);
    assert.equal(messages[1].type,"networkUpsertRule");assert.notEqual(messages[1].revision,request.revision);
    network.operation={type:messages[1].type,revision:messages[1].revision};
    assert.match(view.studioView(m,en),/Rule saved/);
});

test("replay dispatches exactly once while pending and links the resulting exchange",async()=>{
    const {network,rec}=model(),m={network},view=await load("networkStudio");
    const messages=[],send=x=>messages.push(x);
    view.openStudio("resend",network,rec);view.studioView(m,en);
    input(view,"body","{}");click(view,m,"send",send);click(view,m,"send",send);
    assert.equal(messages.length,1);
    const req=messages[0];assert.equal(req.type,"networkReplay");assert.equal(req.request.sourceId,rec.id);
    network.records.push({...rec,id:"resent",status:201});
    network.operation={type:req.type,revision:req.revision,recordId:"resent"};
    assert.match(view.studioView(m,en),/data-net="openExchange" data-id="resent"/);
});
test("editing sequenced fixtures roundtrips interleaved modern rules and priority",async()=>{
    const {editScenario,scenarioValue,editorAction}=await load("networkEditor");
    const modern={id:"partial",method:"*",match:{type:"glob",field:"path",value:"/items/*"},action:"reroute",path:"/stock"};
    const fix=id=>({id,method:"GET",path:"/"+id,steps:[{response:{status:201,json:{total:4}}}]});
    const sc={version:1,name:"mixed",rules:[fix("one"),modern,fix("two")]};
    const form=editScenario(sc); assert.deepEqual(form.rules.map(r=>r.id),["one","two"]);
    form.rules[1].steps[0].status="203";
    const edited=scenarioValue(form);
    assert.equal(edited.rules[2].steps[0].response.status,203);
    assert.deepEqual(edited.rules[1],modern);
    for (const code of ["204","205"]) {
        editorAction(form,{dataset:{net:"addreply",row:"1"}});
        form.rules[1].steps.at(-1).status=code;
    }
    assert.equal(editorAction(form,{dataset:{net:"moveReply",row:"1-0",to:"2"}}),true);
    assert.deepEqual(scenarioValue(form,en).rules[2].steps.map(step=>step.response.status),[204,205,203]);
});
