"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {NetworkSession} = require("../src/network");
const {readBytes} = require("../src/networkGateway");

const json = {"content-type":"application/json"};
const local = (id,path,status=200)=>({id,method:"*",match:{type:"exact",field:"path",value:path},action:"local",
    response:{status,headers:json,body:JSON.stringify({id})}});
const full = (id,path,action,config)=>({id,method:"*",match:{type:"exact",field:"path",value:path},action,...config});

async function lab(t) {
    const requests = [];
    const server = http.createServer(async(req,res)=>{
        const bytes = await readBytes(req);
        requests.push({method:req.method,path:req.url,headers:req.headers,bytes});
        if (req.url === "/blob") return res.writeHead(200,{"content-type":"application/octet-stream"}).end(bytes);
        if (req.url === "/escape") return res.writeHead(302,{location:"https://outside.invalid/"}).end();
        if (req.url === "/relative/one") return res.writeHead(302,{location:"two"}).end();
        res.writeHead(207,{...json,"x-status":"stage-12"}).end(JSON.stringify({msg:"remote demo",path:req.url}));
    });
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const origin = "http://127.0.0.1:"+server.address().port;
    const session = new NetworkSession();
    session.setUpstream(origin);
    const base = await session.start();
    t.after(async()=>{
        await session.stop();
        await new Promise(resolve=>server.close(resolve));
    });
    return {session,base,origin,requests};
}

test("regex rules apply query, header and body edits in both phases and retain the actual changes",async t=>{
    const {session,base,origin,requests} = await lab(t);
    const rule = {id:"locale",method:"POST",match:{field:"url",type:"regex",value:"^"+origin.replaceAll(".","\\.")+"/catalog/\\d+\\?"},
        action:"rewrite",edits:[
            {target:"query",key:"lang",op:"literal",find:"en",value:"zh"},
            {target:"requestHeader",key:"X-Owner",op:"set",value:"qa"},
            {target:"requestHeader",key:"X-Remove",op:"remove"},
            {target:"requestBody",op:"regex",find:"item-(\\d+)",value:"产品-$1"},
            {target:"responseHeader",key:"X-Status",op:"regex",find:"(stage)-(\\d+)",value:"local-$2"},
            {target:"responseBody",op:"literal",find:"remote demo",value:"重写结果"},
        ]};
    session.upsertRule(rule);
    const response = await fetch(base+"/catalog/42?lang=en&page=2&lang=en-US",{method:"POST",
        headers:{...json,"x-remove":"temporary"},body:'{"name":"item-12","keep":true}'});
    assert.equal(response.status,207);
    assert.equal(response.headers.get("x-status"),"local-12");
    assert.equal((await response.json()).msg,"重写结果");
    const inbound = requests[0], [record] = session.records;
    assert.deepEqual([inbound.method,inbound.path,inbound.headers["x-owner"],inbound.headers["x-remove"]],
        ["POST","/catalog/42?lang=zh&page=2&lang=zh-US","qa",undefined]);
    assert.deepEqual(JSON.parse(inbound.bytes),{name:"产品-12",keep:true});
    assert.deepEqual([record.source,record.ruleId,record.ruleHit],["gateway","locale",1]);
    assert.equal(record.request.url,origin+"/catalog/42?lang=en&page=2&lang=en-US");
    assert.deepEqual([record.request.body.name,record.effectiveRequest.body.name],["item-12","产品-12"]);
    assert.equal(record.effectiveRequest.headers["content-length"],inbound.headers["content-length"]);
    assert.equal(record.effectiveRequest.headers.host,inbound.headers.host);
    assert.deepEqual([record.originalResponse.body.msg,record.response.body.msg],["remote demo","重写结果"]);
    const preview = session.previewRule(rule);
    assert.deepEqual(preview.matchedIds,[record.id]);
    assert.equal(preview.examples[0].response.body.msg,"重写结果");
    assert.equal(preview.examples[0].effectiveRequest.body.name,"产品-12");
    assert.equal(requests.length,1);
    assert.deepEqual(session.snapshot().hits[0],{ruleId:"locale",count:1});
    const replay = await session.replay({sourceId:record.id,method:"POST",path:"/catalog/77?lang=en",headers:json,body:'{"name":"item-29"}'});
    assert.equal(requests.length,2);
    assert.equal(requests[1].headers["x-workbench-replay"],undefined);
    assert.deepEqual([replay.replayOf,replay.replayed,replay.ruleHit],[record.id,true,2]);
    assert.deepEqual(session.snapshot().records.map(r=>r.id),[record.id,replay.id]);
    assert.equal(replay.effectiveRequest.body.name,"产品-29");
});

test("full replacements, local maps and reroutes take distinct HTTP paths",async t=>{
    const {session,base,requests} = await lab(t);
    session.upsertRule(full("replace-req","/replace","replaceRequest",{request:{method:"PUT",path:"/new?id=2",
        headers:{"content-type":"text/plain","x-only":"kept"},body:"hello"}}));
    await (await fetch(base+"/replace?gone=1",{method:"POST",headers:{"x-gone":"gone"},body:"old"})).text();
    assert.deepEqual([requests[0].method,requests[0].path,requests[0].headers["x-gone"],requests[0].bytes.toString()],
        ["PUT","/new?id=2",undefined,"hello"]);
    assert.equal(session.records[0].effectiveRequest.body,"hello");
    session.upsertRule(full("replace-res","/empty","replaceResponse",{response:{status:201,headers:json,body:"[]"}}));
    const empty = await fetch(base+"/empty");
    assert.deepEqual([empty.status,empty.headers.get("x-status"),await empty.json()],[201,null,[]]);
    const replaced = session.records.at(-1);
    assert.equal(replaced.originalResponse.status,207);
    session.upsertRule(full("file","/local","local",{response:{status:203,headers:json,fileName:"catalog.json",body:'{"fixture":true}'}}));
    const mapped = await fetch(base+"/local");
    assert.deepEqual([mapped.status,await mapped.json(),session.records.at(-1).source],[203,{fixture:true},"fixture"]);
    assert.equal(session.records.at(-1).originalResponse,undefined);
    assert.equal(requests.length,2);
    session.upsertRule(full("route","/goto","reroute",{path:"/next"}));
    await (await fetch(base+"/goto?retained=yes")).text();
    assert.equal(requests.at(-1).path,"/next?retained=yes");
    assert.equal(session.records.at(-1).effectiveRequest.path,"/next");
    session.upsertRule(full("route","/goto","reroute",{path:"/next?new=1"}));
    await (await fetch(base+"/goto?old=1")).text();
    assert.equal(requests.at(-1).path,"/next?new=1");
    const bytes = Buffer.from([0,128,255,46,0]);
    const blob = await fetch(base+"/blob",{method:"POST",headers:{"content-type":"application/octet-stream"},body:bytes});
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()),bytes);
    assert.equal(session.records.at(-1).response.bodyState,"omitted");
});

test("first-match ordering, stable unrelated hit counts and portable legacy cursor survive rule CRUD",async t=>{
    const {session,base} = await lab(t);
    assert.equal((await fetch(base+"/items")).status,503);
    const broad = {...local("catalog","/unused",418),match:{field:"path",type:"glob",value:"/goods/*"}};
    session.upsertRule(broad);
    session.upsertRule(local("specific","/goods/123",204));
    assert.equal((await fetch(base+"/goods/123?q=1")).status,204);
    session.moveRule("specific","down");
    assert.equal((await fetch(base+"/goods/123?q=1")).status,418);
    session.upsertRule({...broad,enabled:false});
    assert.equal((await fetch(base+"/goods/123")).status,204);
    assert.equal(session.snapshot().hits.find(h=>h.ruleId==="catalog").count,1);
    session.removeRule("specific");
    assert.equal((await fetch(base+"/goods/123")).status,207);
    const legacy = session.scenario.rules.find(r=>r.id==="items");
    session.upsertRule({...legacy,enabled:false});
    session.upsertRule({...legacy,enabled:true});
    assert.equal((await fetch(base+"/items")).status,200);
    assert.equal(session.snapshot().hits.find(h=>h.ruleId==="items").count,2);
    const reopened = new NetworkSession();
    reopened.setScenario(JSON.stringify(session.scenario));
    assert.deepEqual(reopened.scenario,session.scenario);
    assert.equal(reopened.snapshot().upstream,"");
});

test("local gateway scope rejects remote destinations, escaped redirects and credential replay",async t=>{
    const {session,base,requests} = await lab(t);
    const port = new URL(base).port;
    for (const origin of ["https://example.com","http://u:p@127.0.0.1","file:///tmp/test","http://localhost/a",base,
        "http://localhost:"+port,"http://[::1]:"+port,"http://127.1:"+port,"http://127.0.0.2:"+port])
        assert.throws(()=>session.setUpstream(origin));
    for (const path of ["//away.invalid","/\\away.invalid","https://away.invalid","/a#hidden"])
        assert.throws(()=>session.upsertRule(full("no","/from","reroute",{path})));
    assert.throws(()=>session.upsertRule({...local("bad","/"),match:{type:"regex",field:"path",value:"("}}),/regular expression/);
    for (const draft of [{path:"/catalog?token=sensitive"},{headers:{Authorization:"Basic clean"}},
        {body:'{"nested":{"api_key":"sensitive"}}'},{path:"/?original=%5Bredacted%5D"}])
        await assert.rejects(session.replay({method:"POST",path:"/catalog",...draft}),/credentials/);
    assert.equal(requests.length,0);
    assert.equal((await fetch(base+"/escape",{redirect:"manual"})).status,502);
    const redirect = await fetch(base+"/relative/one",{redirect:"manual"});
    assert.deepEqual([redirect.status,redirect.headers.get("location")],[302,"/relative/two"]);
    assert.equal(requests.length,2);
    session.setUpstream("");
    session.upsertRule(full("no-up","/needs-up","replaceResponse",{response:{status:201,headers:json,body:"{}"}}));
    assert.equal((await fetch(base+"/needs-up")).status,503);
    const source = session.records.at(-1);
    await assert.rejects(session.replay({sourceId:source.id,method:"POST",path:"/needs-up"}),/explicitly/);
    assert.equal(requests.length,2);
});

test("previews mark missing retained body evidence without mutating a running sequence",()=>{
    const session = new NetworkSession();
    const entry = {startedDateTime:"2026-01-01T00:00:00Z",request:{method:"POST",url:"https://example.invalid/items",headers:[]},
        response:{status:200,headers:[],content:{mimeType:"application/octet-stream",text:"opaque"}}};
    session.importHar({log:{entries:[entry]}});
    const rule = full("draft","/items","rewrite",{edits:[{target:"responseBody",op:"literal",find:"find",value:"replace"}]});
    const preview = session.previewRule(rule);
    assert.equal(preview.total,1);
    assert.equal(preview.examples[0].unavailable,true);
    assert.equal(preview.examples[0].response.body,undefined);
    assert.deepEqual(session.snapshot().hits,[{ruleId:"items",count:0}]);
});
