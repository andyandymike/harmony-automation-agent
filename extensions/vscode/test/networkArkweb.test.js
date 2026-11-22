"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { discoverArkWeb,attachArkWeb } = require("../src/arkwebNetwork");
const { NetworkSession } = require("../src/network");

async function discovery(t) {
    const page = {id:"42",type:"page",url:"https://fixture.example/settings?account=hidden",title:"Fixture settings",
        webSocketDebuggerUrl:"ws://localhost/devtools/page/42"};
    const server = http.createServer((req,res) => {
        assert.equal(req.url,"/json/list");
        res.setHeader("content-type","application/json");
        res.end(JSON.stringify([page,{...page,type:"service_worker"},{...page,id:"66",webSocketDebuggerUrl:"ws://another.invalid/devtools/page/66"}]));
    }).listen(0,"127.0.0.1");
    await once(server,"listening");
    t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
    return server.address().port;
}

test("debug discovery shows inspectable pages on the selected loopback port",async t => {
    const port = await discovery(t);
    assert.deepEqual(await discoverArkWeb(port),[{id:"42",title:"Fixture settings",url:"https://fixture.example/settings",origin:"https://fixture.example"}]);
    await assert.rejects(discoverArkWeb("https://example.invalid:44"),/local/);
    await assert.rejects(attachArkWeb({port,targetId:"66"}),/Select/);
    await assert.rejects(attachArkWeb({port,targetId:"42",expectedOrigin:"https://changed.example"}),/Select/);
});

test("only observes a selected page, emits redirects, redacted JSON, and stops when the root page changes sites",async t => {
    const port = await discovery(t);
    const methods = [];
    let socket;
    class Socket extends EventTarget {
        constructor(url) {super();assert.equal(url,"ws://127.0.0.1:"+port+"/devtools/page/42");socket=this;queueMicrotask(()=>this.dispatchEvent(new Event("open")));}
        message(data) {this.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(data)}));}
        send(text) {
            const {id,method} = JSON.parse(text);
            methods.push(method);
            const result = method==="Page.getFrameTree" ? {frameTree:{frame:{id:"frame",url:"https://fixture.example/settings"}}} :
                method==="Network.getResponseBody" ? {body:'{"data":[1,2],"token":"never-keep-this"}'} : {};
            queueMicrotask(()=>this.message({id,result}));
        }
        close() {queueMicrotask(()=>this.dispatchEvent(new Event("close")));}
    }
    const original = globalThis.WebSocket;
    globalThis.WebSocket=Socket;
    t.after(()=>{globalThis.WebSocket=original;});
    const net = new NetworkSession();
    let closed;
    const capture = await attachArkWeb({port,targetId:"42",expectedOrigin:"https://fixture.example",
        onEntries:entries=>net.importHar({log:{entries}},{source:"arkweb"}),onClose:reason=>{closed=reason;}});
    const event=(method,params)=>socket.message({method:"Network."+method,params:{requestId:"r",frameId:"frame",...params}});
    const request={method:"GET",url:"https://fixture.example/lookup",headers:{Authorization:"never-keep-this"}};
    event("requestWillBeSent",{timestamp:1,wallTime:1700000000,request});
    event("requestWillBeSent",{timestamp:1.2,wallTime:1700000000.2,redirectResponse:{status:302,headers:{}},
        request:{...request,url:"https://api.example/items?token=never-keep-this"}});
    event("responseReceived",{timestamp:2,response:{status:200,headers:{},mimeType:"application/json",timing:{dnsStart:1,dnsEnd:3}}});
    event("loadingFinished",{timestamp:3,encodedDataLength:99});
    await new Promise(resolve=>setImmediate(resolve));
    const observed=net.snapshot().records;
    assert.deepEqual(observed.map(r=>[r.source,r.path,r.status]),[["arkweb","/lookup",302],["arkweb","/items",200]]);
    assert.deepEqual(observed[1].response.body.data,[1,2]);
    assert.equal(observed[1].timings.dns,2);
    assert.ok(!JSON.stringify(observed).includes("never-keep-this"));
    event("requestWillBeSent",{type:"Document",timestamp:4,request:{...request,url:"https://next.example/x"}});
    await capture.stop();
    assert.equal(closed,"page-changed");
    assert.equal(net.snapshot().records.length,2);
    assert.deepEqual(methods,["Page.enable","Page.getFrameTree","Network.enable","Network.getResponseBody"]);
});
