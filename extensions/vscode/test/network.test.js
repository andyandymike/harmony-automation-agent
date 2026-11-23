"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { NetworkSession, exampleScenario, scenarioFromRecord } = require("../src/network");

test("the local HTTP endpoint progresses through a retry scenario, with independent service, history and hit controls", async t => {
    const changes = [];
    const net = new NetworkSession({onChange: s => changes.push(s.running)});
    t.after(() => net.stop());
    const [url, sameUrl] = await Promise.all([net.start(),net.start()]);
    assert.equal(url,sameUrl);
    assert.match(url,/^http:\/\/127\.0\.0\.1:\d+$/);
    const path = url + "/items?locale=zh";
    const first = await fetch(path);
    assert.equal(first.status,503);
    assert.deepEqual(await first.json(),{error:"Try again"});
    assert.deepEqual(await (await fetch(path)).json(),{items:[]});
    assert.equal((await fetch(path)).status,200);
    assert.equal((await fetch(url + "/unknown")).status,404);
    const snapshot = net.snapshot();
    assert.deepEqual(snapshot.records.map(r => [r.method,r.path,r.status,r.stepIndex]),[
        ["GET","/items",503,0],["GET","/items",200,1],["GET","/items",200,1],["GET","/unknown",404,undefined],
    ]);
    assert.deepEqual(snapshot.hits, [{ruleId:"items",count:3}]);
    assert.deepEqual(scenarioFromRecord(snapshot.records[0]).rules[0].steps[0].response,
        {status:503,json:{error:"Try again"}});
    net.clear();
    assert.equal(net.snapshot().hits[0].count,3);
    net.resetHits();
    assert.equal(net.snapshot().hits[0].count,0);
    assert.equal((await fetch(path)).status,503);
    await net.stop();
    assert.equal(changes.at(-1),false);
    await assert.rejects(fetch(path));
});

test("request overrides apply inside the fixture and the HTTP client receives the effective JSON", async t => {
    const net = new NetworkSession();
    net.setScenario({version:1,rules:[{id:"lookup",method:"post",path:"/lookup",steps:[{
        request:{headers:{"X-Env":"test"},query:{page:"2"},json:{count:4}},
        response:{status:201,headers:{"x-sample":"override"},delayMs:25,json:undefined},
    }]}]});
    t.after(() => net.stop());
    const url = await net.start();
    const response = await fetch(url + "/lookup?page=1&token=never-keep-this",{
        method:"POST",headers:{"Content-Type":"application/json","X-Env":"dev",Authorization:"Bearer never-keep-this"},
        body:JSON.stringify({count:1,name:"demo",nested:{account_number:"never-keep-this"}}),
    });
    assert.equal(response.status,201);
    assert.equal(response.headers.get("x-sample"),"override");
    const echo = await response.json();
    assert.equal(echo.headers["x-env"],"test");
    assert.equal(echo.query.page,"2");
    assert.equal(echo.body.count,4);
    const [record] = net.snapshot().records;
    assert.deepEqual([record.request.query.page,record.effectiveRequest.query.page],["1","2"]);
    assert.deepEqual([record.request.body.count,record.effectiveRequest.body.count],[1,4]);
    assert.deepEqual([record.request.headers["x-env"],record.effectiveRequest.headers["x-env"]],["dev","test"]);
    assert.ok(record.durationMs >= 23);
    assert.ok(!JSON.stringify(record).includes("never-keep-this"));
});

const entry = () => ({startedDateTime:"2026-11-03T00:00:00Z",time:23,request:{method:"POST",
    url:"https://name:never-keep-this@example.invalid/api/items?api_key=never-keep-this&page=2#never-keep-this",
    headers:[{name:"Referer",value:"https://example.invalid/?token=never-keep-this"}],
    postData:{mimeType:"application/x-www-form-urlencoded",params:[{name:"pin",value:"never-keep-this"},{name:"category",value:"example"}]}},
    response:{status:200,headers:[{name:"Set-Cookie",value:"never-keep-this"}],content:{
        encoding:"base64",mimeType:"application/json",text:Buffer.from('{"data":[{"items":7,"otp":"never-keep-this"}]}').toString("base64")}},
    timings:{dns:-1,wait:20,receive:3}});

test("imports HAR atomically, strips identities, decodes structured content and preserves source and timing offline", () => {
    const net = new NetworkSession();
    const sample = entry();
    assert.equal(net.importHar(JSON.stringify({log:{version:"1.2",entries:[sample]}})),1);
    const cursor = net.snapshot().records[0];
    assert.equal(cursor.request.path,"/api/items");
    assert.equal(cursor.request.body.category,"example");
    assert.equal(cursor.response.body.data[0].items,7);
    assert.deepEqual(cursor.timings,{wait:20,receive:3});
    assert.equal(Date.parse(cursor.startedAt),Date.parse(sample.startedDateTime));
    assert.equal(cursor.source,"har");
    assert.ok(!JSON.stringify(cursor).includes("never-keep-this"));
    net.importHar({log:{entries:[sample]}},{source:"device"});
    net.importHar({log:{entries:[sample]}},{source:"arkweb"});
    assert.throws(() => net.importHar({log:{entries:[sample,{}]}}),/entry 2/);
    assert.deepEqual(net.snapshot().records.map(r => r.source),["har","device","arkweb"]);
    const reopened = new NetworkSession();
    reopened.restoreRecords(JSON.parse(JSON.stringify(net.snapshot().records)));
    assert.deepEqual(reopened.snapshot().records,net.snapshot().records);
    assert.equal(reopened.snapshot().running,false);
});

test("binary content is omitted, and retention reports the dropped records", () => {
    const net = new NetworkSession();
    const sample = entry();
    sample.response.content = {mimeType:"application/octet-stream",text:"never-keep-this",encoding:"base64"};
    net.importHar({log:{entries:Array(501).fill(sample)}});
    const evidence = net.snapshot();
    assert.equal(evidence.records.length,500);
    assert.equal(evidence.omittedRecords,1);
    assert.equal(evidence.records[0].response.bodyState,"omitted");
    assert.ok(!JSON.stringify(evidence.records[0]).includes("never-keep-this"));
});

test("disabled rules are skipped and invalid edits leave the active scenario and hits intact", async t => {
    const net = new NetworkSession();
    const scenario = exampleScenario();
    scenario.rules.unshift({...scenario.rules[0],id:"disabled",enabled:false});
    net.setScenario(scenario);
    t.after(() => net.stop());
    const url = await net.start();
    await fetch(url + "/items");
    scenario.rules[1].steps[0].response.headers = {"bad header name":"x"};
    assert.throws(() => net.setScenario(scenario),/header/);
    assert.equal(net.snapshot().hits[0].count,0);
    assert.equal(net.snapshot().hits[1].count,1);
    assert.equal((await fetch(url + "/items")).status,200);
});
