"use strict";

const { maxBodyBytes } = require("./networkEvidence");

const timeoutMs = 4500;
const error = (en, zh) => new Error(en + " / " + zh);
const asHeaders = (map = {}) => Object.entries(map).map(([name,value]) => ({name,value:String(value)}));

function debugPort(port) {
    if (!/^\d+$/.test(String(port)) || +port < 1 || +port > 65535)
        throw error("Enter a local forwarded port (1–65535).","请输入 1 至 65535 的本机转发端口。");
    return Number(port);
}

function pageScope(value) {
    try {
        const url = new URL(value);
        if (["http:","https:"].includes(url.protocol)) return url.origin;
        if (["file:","resource:","app:","arkweb:"].includes(url.protocol)) return url.protocol + "//" + url.host + url.pathname;
    } catch { /* Ignore targets without a distinct inspectable page. */ }
    return undefined;
}

async function pageTargets(port) {
    const remote = await fetch("http://127.0.0.1:" + debugPort(port) + "/json/list", {
        redirect:"error",signal:AbortSignal.timeout(timeoutMs),
    });
    if (!remote.ok) throw error("The forwarded port did not return a page list.","该转发端口未返回页面清单。");
    const rows = await remote.json();
    if (!Array.isArray(rows)) throw error("Expected an ArkWeb/DevTools page list.","未收到 ArkWeb 页面清单。");
    return rows.flatMap(row => {
        if (!["webview","page"].includes(row.type) || !/^[\w.-]+$/.test(row.id)) return [];
        const origin = pageScope(row.url);
        if (!origin) return [];
        let ws;
        try { ws = new URL(row.webSocketDebuggerUrl); } catch { return []; }
        if (ws.protocol !== "ws:" || !["127.0.0.1","localhost","[::1]"].includes(ws.hostname) ||
            ws.pathname !== "/devtools/page/" + row.id) return [];
        // Keep the caller-selected loopback port. The advertised hostname and port are never dialed.
        const url = new URL(row.url);
        url.username = url.password = url.hash = url.search = "";
        return [{id:row.id,title:String(row.title || "").slice(0,160),url:url.href,origin}];
    });
}

async function discoverArkWeb(port) { return pageTargets(port); }

function timingView(timing) {
    if (!timing) return {};
    const timings = {};
    for (const [name, begin, end] of [
        ["dns","dnsStart","dnsEnd"],["connect","connectStart","connectEnd"],["ssl","sslStart","sslEnd"],
        ["send","sendStart","sendEnd"],["wait","sendEnd","receiveHeadersEnd"],
    ]) {
        if (timing[begin] >= 0 && timing[end] >= timing[begin]) timings[name] = timing[end] - timing[begin];
    }
    return timings;
}

function requestEntry(event) {
    const raw = event.request;
    if (!/^https?:\/\//i.test(raw.url)) return;
    const headers = asHeaders(raw.headers);
    const type = headers.find(item => item.name.toLowerCase() === "content-type")?.value || "";
    const entry = {startedDateTime:new Date(event.wallTime ? event.wallTime * 1000 : Date.now()).toISOString(),
        time:-1,request:{method:raw.method,url:raw.url,headers},
        response:{status:0,headers:[],content:{}},timings:{}};
    if (raw.postData != null) entry.request.postData = {mimeType:type,text:raw.postData};
    return {entry,start:event.timestamp};
}

function setResponse(row, raw) {
    if (!raw) return;
    row.entry.response = {status:raw.status,headers:asHeaders(raw.headers),content:{mimeType:raw.mimeType || ""}};
    row.entry.timings = timingView(raw.timing);
}

async function attachArkWeb({port,targetId,expectedOrigin,onEntries,onClose = () => {}}) {
    port = debugPort(port);
    const target = (await pageTargets(port)).find(item => item.id === targetId);
    if (!target || expectedOrigin && expectedOrigin !== target.origin) {
        throw error("The selected page changed. Select it again.","所选页面已变更，请重新选择。");
    }
    if (typeof WebSocket !== "function") throw error("Update VS Code for WebSocket support.","请更新 VS Code 以启用 WebSocket 支持。");
    const socket = new WebSocket("ws://127.0.0.1:" + port + "/devtools/page/" + target.id);
    const requests = new Map(), replies = new Map(), bodyReads = new Set();
    let sequence = 0, rootFrame, stopped, stopReason, attached = false, resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });

    function stop(reason = "stopped") {
        if (!stopped) {
            stopped = true;
            stopReason = reason;
            socket.close();
        }
        return closed;
    }

    function call(method, params = {}) {
        if (stopped) return Promise.reject(error("Page disconnected.","页面已断开。"));
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                replies.delete(id);
                reject(error("Page did not answer.","页面未响应。"));
            },timeoutMs);
            replies.set(id,{resolve,reject,timer});
            try { socket.send(JSON.stringify({id,method,params})); }
            catch (e) { clearTimeout(timer); replies.delete(id); reject(e); }
        });
    }

    function publish(row, end) {
        if (Number.isFinite(end) && Number.isFinite(row.start)) row.entry.time = Math.max(0,(end - row.start) * 1000);
        onEntries([row.entry]);
    }

    async function readBody(id,row,event) {
        const content = row.entry.response.content;
        if (/\bjson\b/i.test(content.mimeType) && event.encodedDataLength <= maxBodyBytes && row.entry.request.method !== "HEAD") {
            try {
                const value = await call("Network.getResponseBody",{requestId:id});
                if (typeof value.body === "string" && Buffer.byteLength(value.body) <= maxBodyBytes * (value.base64Encoded ? 4/3 : 1) + 4) {
                    content.text = value.body;
                    if (value.base64Encoded) content.encoding = "base64";
                }
            } catch { /* Some cached or already-evicted response bodies are unavailable. */ }
        }
        publish(row,event.timestamp);
    }

    function handle(method,p) {
        if (stopped || !rootFrame) return;
        if (method === "Page.frameNavigated" && !p.frame.parentId) {
            if (pageScope(p.frame.url) !== target.origin) { void stop("page-changed"); return; }
            rootFrame = p.frame.id;
        } else if (method === "Inspector.detached") { void stop("disconnected"); }
        else if (method === "Network.requestWillBeSent") {
            if (p.type === "Document" && p.frameId === rootFrame && pageScope(p.request.url) !== target.origin) {
                void stop("page-changed");
                return;
            }
            const previous = requests.get(p.requestId);
            if (previous) { setResponse(previous,p.redirectResponse); publish(previous,p.timestamp); requests.delete(p.requestId); }
            const row = requestEntry(p);
            if (row) requests.set(p.requestId,row);
        } else if (method === "Network.responseReceived") {
            const row = requests.get(p.requestId);
            if (row) setResponse(row,p.response);
        } else if (method === "Network.loadingFailed" || method === "Network.loadingFinished") {
            const row = requests.get(p.requestId);
            if (!row) return;
            requests.delete(p.requestId);
            if (method === "Network.loadingFailed") {
                row.entry._error = /^net::[A-Z_]+$/.test(p.errorText) ? p.errorText : "REQUEST_FAILED";
                publish(row,p.timestamp);
            } else {
                const reading = readBody(p.requestId,row,p);
                bodyReads.add(reading);
                reading.then(() => bodyReads.delete(reading), () => bodyReads.delete(reading));
            }
        }
    }

    socket.addEventListener("message", event => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.id !== undefined) {
            const pending = replies.get(msg.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            replies.delete(msg.id);
            if (msg.error) pending.reject(error("The page does not support this network observation request.","当前页面不支持该网络观测请求。"));
            else pending.resolve(msg.result);
        } else if (msg.method) handle(msg.method,msg.params || {});
    });
    socket.addEventListener("close", async () => {
        stopped = true;
        for (const item of replies.values()) { clearTimeout(item.timer); item.reject(error("Page disconnected.","页面已断开。")); }
        replies.clear();
        for (const row of requests.values()) { row.entry._error = "DETACHED"; publish(row); }
        requests.clear();
        await Promise.allSettled([...bodyReads]);
        try { if (attached) onClose(stopReason || "disconnected"); }
        finally { resolveClosed(); }
    }, {once:true});
    try {
        await new Promise((resolve,reject) => {
            const timer = setTimeout(() => reject(error("Connection timed out.","连接超时。")),timeoutMs);
            socket.addEventListener("open", () => {clearTimeout(timer); resolve();},{once:true});
            socket.addEventListener("error", () => {clearTimeout(timer); reject(error("Cannot attach to the selected page.","无法连接所选页面。"));},{once:true});
        });
        await call("Page.enable");
        const {frameTree} = await call("Page.getFrameTree");
        if (pageScope(frameTree?.frame?.url) !== target.origin) throw error("Page changed before attachment.","开始观测前页面已变更。");
        rootFrame = frameTree.frame.id;
        await call("Network.enable",{maxTotalBufferSize:8 * maxBodyBytes,maxResourceBufferSize:maxBodyBytes,maxPostDataSize:maxBodyBytes});
        attached = true;
        return {target,stop:() => stop()};
    } catch (e) { void stop(); throw e; }
}

module.exports = { discoverArkWeb, attachArkWeb };
