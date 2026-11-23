"use strict";

const http = require("node:http");
const { safeValue, bodyView, headersView, requestView, maxBodyBytes } = require("./networkEvidence");

const reserved = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","proxy-connection",
    "te","trailer","transfer-encoding","upgrade","host","content-length","x-workbench-replay"]);
const methods = new Set(["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]);
const fail = (en,zh) => { throw new Error(en+" / "+zh); };
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);

function localPath(path) {
    if (typeof path !== "string" || !/^\/(?![\\/])/.test(path) || /[\\#\x00-\x1f\x7f]/.test(path))
        fail("Enter a local path starting with one slash.", "请输入以单个斜杠开头的本地路径。");
    const parsed = new URL(path,"http://localhost");
    if (parsed.origin !== "http://localhost" || parsed.pathname.startsWith("//"))
        fail("The path must stay within the configured origin.", "路径须位于已配置的测试源内。");
    return path;
}

function methodName(value, any = false) {
    const method = typeof value === "string" && value.toUpperCase();
    if (!(any && method === "*") && !methods.has(method))
        fail("Choose an HTTP method.", "请选择 HTTP 方法。");
    return method;
}

function checkedHeaders(headers = {}) {
    if (!object(headers)) fail("Headers must be a name/value object.", "请求头或响应头需要使用键值对象。");
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (typeof value !== "string" || reserved.has(key.toLowerCase()))
            fail("Use string values and editable HTTP headers.", "请使用可编辑的 HTTP 头及字符串值。");
        try {http.validateHeaderName(key); http.validateHeaderValue(key,value);}
        catch {fail("Invalid HTTP header.", "HTTP 头无效。");}
        Object.defineProperty(out,key.toLowerCase(),{value, enumerable:true, writable:true, configurable:true});
    }
    return out;
}

function expression(value) {
    try {return new RegExp(value,"g");}
    catch {fail("Invalid regular expression.", "正则表达式无效。");}
}

function matchRule(rule, method, url) {
    if (rule.enabled === false || (rule.method !== "*" && rule.method !== method)) return false;
    if (!rule.match) return rule.path === url.pathname;
    const {field, type, value} = rule.match;
    const target = field === "url" ? url.href : url.pathname;
    if (type === "exact") return target === value;
    if (type === "regex") return expression(value).test(target);
    const glob = value.split("*").map(part=>part.replace(/[.*+?^$(){}|\[\]\\]/g,"\\$&")).join(".*");
    return new RegExp("^"+glob+"$").test(target);
}

function checkMessage(message, isResponse) {
    if (!object(message)) fail("Provide the replacement message.", "请填写完整的替换内容。");
    message.headers = checkedHeaders(message.headers);
    if (message.body !== undefined && (typeof message.body !== "string" || Buffer.byteLength(message.body)>maxBodyBytes))
        fail("Body must be text up to 96 KiB.", "正文需要使用 96 KiB 以内的文本。");
    if (isResponse) {
        if (!Number.isInteger(message.status) || message.status < 200 || message.status > 599)
            fail("Enter a response status between 200 and 599.", "请输入 200 至 599 的响应状态码。");
        if (message.headers.location !== undefined) localPath(message.headers.location);
    } else {
        message.method = methodName(message.method);
        localPath(message.path);
        if (["GET","HEAD"].includes(message.method) && message.body)
            fail("GET and HEAD must have an empty body.", "GET 和 HEAD 的正文应为空。");
    }
}

function validateRule(rule) {
    if (typeof rule.id !== "string" || !rule.id.trim() || rule.enabled !== undefined && typeof rule.enabled !== "boolean")
        fail("Use a rule ID and boolean enabled state.", "请填写规则 ID 并使用布尔启用状态。");
    rule.method = methodName(rule.method, true);
    const match = rule.match;
    if (!match || !["path","url"].includes(match.field) || !["exact","glob","regex"].includes(match.type) ||
        typeof match.value !== "string" || !match.value)
        fail("Choose a match field, pattern and value.", "请选择匹配字段、方式并填写表达式。");
    if (match.type === "regex") expression(match.value);
    switch (rule.action) {
        case "local":
        case "replaceResponse": checkMessage(rule.response,true); break;
        case "replaceRequest": checkMessage(rule.request,false); break;
        case "reroute": localPath(rule.path); break;
        case "rewrite":
            if (!Array.isArray(rule.edits) || !rule.edits.length)
                fail("Add at least one edit.", "请至少添加一条修改。");
            for (const edit of rule.edits) {
                if (edit?.target === "requestJson" || edit?.target === "responseJson") {
                    if (!["set","remove"].includes(edit.op) || !Array.isArray(edit.path) ||
                        edit.path.some(part => typeof part !== "string" && !(Number.isSafeInteger(part) && part >= 0)) ||
                        (!edit.path.length && edit.op === "remove"))
                        fail("Choose a JSON property or array item.", "请选择 JSON 属性或数组元素。");
                    if (edit.op === "set" && (edit.value === undefined || Buffer.byteLength(JSON.stringify(edit.value)) > maxBodyBytes))
                        fail("Enter a JSON value up to 96 KiB.", "请输入 96 KiB 以内的 JSON 值。");
                    continue;
                }
                if (!["query","requestHeader","requestBody","responseHeader","responseBody"].includes(edit?.target) ||
                    !["set","remove","literal","regex"].includes(edit.op))
                    fail("Unknown rewrite target or operation.", "重写字段或操作无效。");
                if (edit.target === "query" || edit.target.endsWith("Header")) {
                    if (typeof edit.key !== "string" || !edit.key)
                        fail("Choose a query parameter or header name.", "请填写查询参数名或 HTTP 头名称。");
                    if (edit.target.endsWith("Header")) checkedHeaders({[edit.key]:edit.op === "set" ? edit.value : ""});
                    if (edit.occurrence !== undefined && (edit.target !== "query" || !Number.isSafeInteger(edit.occurrence) || edit.occurrence < 0))
                        fail("Choose a query parameter occurrence.", "请选择有效的同名参数位置。");
                }
                if (edit.op !== "remove" && typeof edit.value !== "string")
                    fail("Provide the replacement text.", "请填写替换文本。");
                if (["literal","regex"].includes(edit.op) && (typeof edit.find !== "string" || !edit.find.length))
                    fail("Provide text to find.", "请填写查找内容。");
                if (edit.op === "regex") expression(edit.find);
            }
            break;
        default: fail("Unknown rule action.", "未知的规则动作。");
    }
    return rule;
}

function transformed(old, edit) {
    if (edit.op === "set") return edit.value;
    if (edit.op === "remove") return "";
    if (edit.op === "regex") return old.replace(expression(edit.find), edit.value);
    return old.split(edit.find).join(edit.value);
}

function textBody(message) {
    const type = message.headers["content-type"] || "";
    const encoding = message.headers["content-encoding"];
    if (encoding && encoding.toLowerCase() !== "identity" ||
        type && !/^(?:text\/|application\/(?:[^;]+\+)?(?:json|xml)(?:;|$)|application\/(?:javascript|x-www-form-urlencoded)(?:;|$))/i.test(type))
        fail("Body search requires uncompressed text.", "正文查找需要未压缩的文本。");
    try {return new TextDecoder("utf-8",{fatal:true}).decode(message.bytes);}
    catch {fail("Body search requires UTF-8 text.", "正文查找需要 UTF-8 文本。");}
}

// Follow only own JSON members. A different response shape must pass through unchanged.
function rewriteJson(message, edit) {
    let value;
    try { value = JSON.parse(textBody(message)); } catch { return; }
    if (!edit.path.length) value = edit.value;
    else {
        let parent = value;
        for (const [i,key] of edit.path.entries()) {
            if (parent === null || typeof parent !== "object" || Array.isArray(parent) !== (typeof key === "number")) return;
            const exists = Object.hasOwn(parent,key);
            if (i < edit.path.length - 1) {
                if (!exists) return;
                parent = parent[key];
            } else if (edit.op === "remove") {
                if (!exists) return;
                if (Array.isArray(parent)) parent.splice(key,1);
                else delete parent[key];
            } else {
                if (Array.isArray(parent) && key > parent.length) return;
                Object.defineProperty(parent,key,{value:edit.value,writable:true,enumerable:true,configurable:true});
            }
        }
    }
    message.bytes = Buffer.from(JSON.stringify(value));
}

function applyEdits(message, edits) {
    for (const edit of edits) {
        if (edit.target === "query") {
            const params = message.url.searchParams;
            if (edit.occurrence !== undefined) {
                const entries = [...params];
                let occurrence = 0;
                const index = entries.findIndex(([key]) => key === edit.key && occurrence++ === edit.occurrence);
                if (index < 0) continue;
                if (edit.op === "remove") entries.splice(index,1);
                else entries[index][1] = transformed(entries[index][1],edit);
                message.url.search = new URLSearchParams(entries).toString();
            }
            else if (edit.op === "remove") params.delete(edit.key);
            else if (edit.op === "set") params.set(edit.key,edit.value);
            else if (params.has(edit.key)) {
                const entries = [...params];
                message.url.search = "";
                for (const [key,value] of entries) params.append(key,key === edit.key ? transformed(value,edit) : value);
            }
        } else if (edit.target === "requestJson" || edit.target === "responseJson") {
            rewriteJson(message,edit);
        } else if (edit.target.endsWith("Header")) {
            const key = edit.key.toLowerCase();
            if (edit.op === "remove") delete message.headers[key];
            else if (edit.op === "set" || Object.hasOwn(message.headers,key)) {
                const old = message.headers[key] ?? "";
                const changed = Array.isArray(old) ? old.map(v=>transformed(v,edit)) : transformed(old,edit);
                for (const value of [changed].flat()) http.validateHeaderValue(key,value);
                message.headers[key] = changed;
            }
        } else {
            const text = ["set","remove"].includes(edit.op) ? "" : textBody(message);
            message.bytes = Buffer.from(transformed(text,edit));
            if (["set","remove"].includes(edit.op)) delete message.headers["content-encoding"];
        }
    }
    return message;
}

function rewriteRequest(original, rule) {
    const request = {...original,url:new URL(original.url),headers:{...original.headers}};
    if (rule?.action === "replaceRequest") {
        const replacement = rule.request;
        return {method:replacement.method,url:new URL(replacement.path, request.url), headers:{...replacement.headers},
            bytes:Buffer.from(replacement.body || "")};
    }
    if (rule?.action === "reroute") {
        const url = new URL(rule.path,request.url);
        if (!rule.path.includes("?")) url.search = request.url.search;
        request.url = url;
    }
    if (rule?.action === "rewrite") applyEdits(request,rule.edits.filter(e=>!e.target.startsWith("response")));
    return request;
}

function rewriteResponse(original, rule) {
    if (["local","replaceResponse"].includes(rule?.action)) {
        const {status,headers,body} = rule.response;
        return {status,headers:{...headers},bytes:Buffer.from(body || "")};
    }
    const response = {...original,headers:{...original.headers}};
    if (rule?.action === "rewrite") applyEdits(response,rule.edits.filter(e=>e.target.startsWith("response")));
    return response;
}

function viewBody(message) {
    const {bytes,headers} = message;
    if (bytes.length > maxBodyBytes) return {bodyState:"tooLarge"};
    if (headers["content-encoding"] && headers["content-encoding"] !== "identity") return {bodyState:"omitted"};
    const mime = headers["content-type"] || "";
    const text = bytes.toString("utf8");
    const view = bodyView(text,mime);
    if (view.bodyState === "omitted" && /^(?:text\/plain)(?:;|$)/i.test(mime)) {
        // Plain-text test fixtures may carry labelled values or credentials in JSON-shaped text.
        const masked = safeValue("",text);
        if (/^\s*[[{]/.test(masked)) {
            try {
                const json = JSON.parse(masked), sanitized = JSON.stringify(safeValue("",json));
                return {bodyState:"text",body:sanitized === JSON.stringify(json) ? masked : sanitized};
            } catch { /* Continue with labelled plain text. */ }
        }
        const clean = masked.replace(/(["']?)([a-z][\w.-]*)(\1\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi,
            (all,quote,key,delimiter,value) => safeValue(key,value) === "[redacted]" ?
                quote+key+delimiter+(value.startsWith('"') ? '"[redacted]"' : "[redacted]") : all);
        return {bodyState:"text",body:safeValue("",clean)};
    }
    return view;
}

const reqView = req => requestView(req.method,req.url,req.headers,viewBody(req));
const resView = res => ({status:res.status,headers:headersView(res.headers),...viewBody(res)});

function reconstruct(view) {
    if (view.bodyState === "json") return JSON.stringify(view.body);
    if (view.bodyState === "form") {
        const params = new URLSearchParams();
        for (const [key,value] of Object.entries(view.body || {})) for (const v of [value].flat()) params.append(key,v);
        return params.toString();
    }
    if (view.bodyState === "text") return String(view.body);
    return "";
}

function estimate(rule, record) {
    const req = record.request, res = record.originalResponse || record.response;
    const original = {method:req.method,url:new URL(req.url),headers:req.headers,bytes:Buffer.from(reconstruct(req))};
    const example = {id:record.id, request:req};
    const bodyAction = target => rule.edits?.some(e=>e.target === target || e.target === target.replace("Body","Json"));
    const known = view=>["json","form","text"].includes(view?.bodyState) && !JSON.stringify(view.body).includes("[redacted]");
    function estimated(view,changed,target,whole) {
        if (whole) return changed;
        if (!bodyAction(target)) return {...changed,body:view.body,bodyState:view.bodyState};
        if (!known(view)) {example.unavailable = true; delete changed.body; changed.bodyState = view.bodyState || "unavailable";}
        return changed;
    }
    try {
        const effective = reqView(rewriteRequest(original,rule));
        example.effectiveRequest = estimated(req,effective,"requestBody",rule.action === "replaceRequest");
        if (res) example.originalResponse = res;
        if (rule.action === "local" || res) {
            const upstream = res && {status:res.status,headers:res.headers,bytes:Buffer.from(reconstruct(res))};
            const after = resView(rewriteResponse(upstream,rule));
            example.response = estimated(res,after,"responseBody",["local","replaceResponse"].includes(rule.action));
        }
    } catch {example.unavailable = true;}
    return example;
}

module.exports = {localPath,methodName,checkedHeaders,matchRule,validateRule,rewriteRequest,rewriteResponse,
    reqView,resView,estimate,reserved};
