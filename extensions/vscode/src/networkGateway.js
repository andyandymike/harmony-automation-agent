"use strict";

const http = require("node:http");
const https = require("node:https");
const { safeValue, maxBodyBytes } = require("./networkEvidence");
const { reserved, methodName, localPath, checkedHeaders, rewriteRequest, rewriteResponse, reqView, resView } = require("./networkRules");

const maxMessageBytes = 8 * 1024 * 1024;
const error = (status,message) => Object.assign(new Error(message),{status});

function upstreamOrigin(value) {
    if (!value) return "";
    let url;
    try {url = new URL(value);} catch { /* Show one origin-format error for all invalid forms. */ }
    if (!url || !["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        url.pathname !== "/" || !/^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(url.hostname))
        throw new Error("Use a local HTTP(S) test origin, e.g. http://127.0.0.1:3000. / 请填写本机 HTTP(S) 测试源，例如 http://127.0.0.1:3000。");
    return url.origin;
}

function transportHeaders(input) {
    const drop = new Set([...reserved,...String(input.connection || "").toLowerCase().split(",").map(s=>s.trim())]);
    return Object.fromEntries(Object.entries(input).filter(([key])=>!drop.has(key.toLowerCase())));
}

async function readBytes(stream,{drain=false}={}) {
    const chunks = [];
    let length = 0;
    for await (const chunk of stream.iterator({destroyOnReturn:false})) {
        length += chunk.length;
        if (length > maxMessageBytes) {
            if (drain) stream.resume(); else stream.destroy();
            throw error(413,"HTTP message exceeds the 8 MiB gateway limit. / HTTP 消息超过网关 8 MiB 上限。");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function wireHeaders(request) {
    const headers = transportHeaders(request.headers);
    headers.host = request.url.host;
    headers.connection = "close";
    headers["accept-encoding"] = "identity";
    if (request.bytes.length || !["HEAD","GET"].includes(request.method)) headers["content-length"] = String(request.bytes.length);
    return headers;
}

async function forward(request, signal) {
    const {url,method,bytes,headers} = request;
    const transport = url.protocol === "https:" ? https : http;
    const abort = AbortSignal.any([signal,AbortSignal.timeout(30000)]);
    return new Promise((resolve,reject)=>{
        const outgoing = transport.request(url,{method,headers,signal:abort},async incoming=>{
            try {
                const bytes = await readBytes(incoming);
                resolve({status:incoming.statusCode,headers:transportHeaders(incoming.headers),bytes});
            } catch (e) {reject(error(502,e.message));}
        });
        outgoing.once("error",()=>reject(error(502,"Could not reach the local test upstream. / 无法连接本机测试上游。")));
        outgoing.end(bytes);
    });
}

function clientResponse(message,clientMethod,target) {
    const headers = transportHeaders(message.headers);
    if (headers.location) {
        const location = new URL(headers.location,target);
        if (location.origin !== target.origin) throw error(502,"Redirect leaves the local test origin. / 重定向超出本机测试源。");
        headers.location = localPath(location.pathname+location.search);
    }
    const noBody = clientMethod === "HEAD" || [204,205,304].includes(message.status);
    return {...message,headers,bytes:noBody ? Buffer.alloc(0) : message.bytes};
}

async function gatewayExchange({url,method,headers,bytes,rule,upstream,signal}) {
    const request = {method,url,headers,bytes};
    const record = {source:rule?.action === "local" ? "fixture" : "gateway",request:reqView(request)};
    try {
        const effective = rewriteRequest(request,rule);
        if (rule?.action !== "local" && upstream) effective.headers = wireHeaders(effective);
        record.effectiveRequest = reqView(effective);
        let original;
        if (rule?.action !== "local") {
            if (!upstream) throw error(503,"Configure a local test upstream to forward this request. / 请配置本机测试上游以转发此请求。");
            if (effective.url.origin !== upstream) throw error(422,"The request must use the configured upstream. / 请求必须使用已配置的上游。");
            original = await forward(effective,signal);
            record.originalResponse = resView(original);
        }
        const reply = clientResponse(rewriteResponse(original,rule),method,effective.url);
        record.response = resView(reply);
        return {reply,record};
    } catch(e) {
        const status = e.status || 422;
        record.error = status === 502 ? "UPSTREAM_FAILED" : "RULE_ERROR";
        const reply = {status,headers:{"content-type":"application/json"},bytes:Buffer.from(JSON.stringify({error:e.message}))};
        record.response = resView(reply);
        return {reply,record};
    }
}

function replayInput(draft) {
    const method = methodName(draft.method);
    const path = localPath(draft.path);
    const headers = checkedHeaders(draft.headers);
    const body = draft.body ?? "";
    if (typeof body !== "string" || Buffer.byteLength(body)>maxBodyBytes)
        throw new Error("Replay body must be text up to 96 KiB. / 重发正文应为 96 KiB 以内的文本。");
    if (["GET","HEAD"].includes(method) && body)
        throw new Error("This method requires an empty replay body. / 此方法的重发正文应为空。");
    const url = new URL(path,"http://localhost");
    let content = body;
    const mime = headers["content-type"] || "";
    if (/\bjson\b/i.test(mime) || /^\s*[[{]/.test(body)) {
        try {content = JSON.parse(body);} catch { /* Handle edited, non-JSON text below. */ }
    } else if (mime.startsWith("application/x-www-form-urlencoded")) content = Object.fromEntries(new URLSearchParams(body));
    const sourced = [Object.fromEntries(url.searchParams),headers,content];
    const containsSensitive = v => JSON.stringify(safeValue("",v)) !== JSON.stringify(v) ||
        JSON.stringify(v).includes("[redacted]");
    if (sourced.some(containsSensitive))
        throw new Error("Remove credentials and redacted fields before replay. / 请先移除凭据及已脱敏的字段，再重发。");
    return {method,path:url.pathname+url.search,headers,body};
}

module.exports = {upstreamOrigin,readBytes,gatewayExchange,replayInput};
