"use strict";

const { randomUUID } = require("node:crypto");

const redacted = "[redacted]";
const maxBodyBytes = 96 * 1024;
const credential = /authorization|cookie|pass(?:word|wd|phrase)|secret|token|apikey|sessionid|credential|privatekey|clientkey|accesskey|csrf|xsrf|pincode|^(?:pin|otp|cvv|cvc|cardnumber|accountnumber|iban|email|emailaddress|phone|phonenumber|mobile|ssn|creditcard)$/i;

function safeValue(key, value) {
    if (credential.test(key.replace(/[\s._-]/g, ""))) return redacted;
    if (Array.isArray(value)) return value.map(item => safeValue("", item));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, safeValue(name, item)]));
    }
    if (typeof value === "string") return value.replace(/\b(Bearer|Basic)\s+[\w+./=_~-]+/gi, redacted);
    return value;
}

function pairs(items) {
    const map = new Map();
    for (const [key, value] of items) {
        if (!map.has(key)) map.set(key, value);
        else map.set(key, [map.get(key), value].flat());
    }
    return Object.fromEntries(map);
}

function safeUrl(url) {
    const copy = new URL(url);
    copy.username = copy.password = copy.hash = "";
    const entries = [...copy.searchParams];
    copy.search = "";
    for (const [key, value] of entries) copy.searchParams.append(key, safeValue(key, value));
    return copy;
}

function headersView(headers) {
    const entries = Array.isArray(headers) ? headers.map(item => [item.name, item.value]) : Object.entries(headers || {});
    return pairs(entries.map(([name, value]) => {
        const key = name.toLowerCase();
        if (["location", "referer", "referrer", "origin"].includes(key)) {
            // These headers can carry credentials and sensitive query strings of their own.
            try {
                if (typeof value === "string" && /^\/(?![\\/])/.test(value)) {
                    const local = safeUrl(new URL(value,"http://localhost"));
                    if (local.origin === "http://localhost") return [key,local.pathname+local.search];
                }
                return [key, safeUrl(value).href];
            }
            catch { return [key, redacted]; }
        }
        return [key, safeValue(key, value)];
    }));
}

function bodyView(text, mime = "", encoding) {
    if (text == null || text === "") return {bodyState:"unavailable"};
    mime = String(mime || "");
    const base64 = encoding === "base64";
    if (Buffer.byteLength(text) > maxBodyBytes * (base64 ? 4 / 3 : 1) + (base64 ? 4 : 0)) return {bodyState:"tooLarge"};
    if (base64) text = Buffer.from(text, "base64").toString("utf8");
    if (mime.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        return {bodyState:"form", body:safeValue("", pairs(new URLSearchParams(text)))};
    }
    if (/\bjson\b/i.test(mime) || (!mime && /^\s*[[{]/.test(text))) {
        try { return {bodyState:"json", body:safeValue("", JSON.parse(text))}; }
        catch { /* An invalid JSON response is visible through its status and content type. */ }
    }
    return {bodyState:"omitted"};
}

function requestView(method, url, headers, body) {
    const safe = safeUrl(url);
    return {method, url:safe.href, path:safe.pathname, query:pairs(safe.searchParams), headers:headersView(headers), ...body};
}

function harRecords(input, source = "har") {
    if (!["har","arkweb","device"].includes(source)) throw new Error("Unknown network evidence source.");
    const har = typeof input === "string" ? JSON.parse(input.replace(/^\uFEFF/, "")) : input;
    if (!Array.isArray(har?.log?.entries)) throw new Error("Expected a HAR log.entries array. / 请选择包含 log.entries 的 HAR 文件。");
    return har.log.entries.map((entry, index) => {
        try {
            const { request, response } = entry;
            const url = new URL(request.url);
            if (!["http:", "https:"].includes(url.protocol) || !request.method || !Number.isFinite(response.status))
                throw new Error("Invalid HTTP entry");
            const startedAt = new Date(entry.startedDateTime).toISOString();
            const post = request.postData;
            const form = post?.text == null && Array.isArray(post?.params) ?
                new URLSearchParams(post.params.filter(p => !p.fileName).map(p => [p.name, p.value])).toString() : undefined;
            const body = form === undefined ? bodyView(post?.text, post?.mimeType) : bodyView(form,"application/x-www-form-urlencoded");
            const req = requestView(request.method.toUpperCase(),url,request.headers,body);
            const content = response.content || {};
            const timings = Object.fromEntries(Object.entries(entry.timings || {}).filter(([name, time]) =>
                ["blocked","dns","connect","ssl","send","wait","receive"].includes(name) && Number.isFinite(time) && time >= 0));
            const error = typeof entry._error === "string" && /^(?:net::[A-Z_]+|DETACHED|REQUEST_FAILED)$/.test(entry._error) ? entry._error : undefined;
            return {id:randomUUID(), source, startedAt, durationMs:Number.isFinite(entry.time) && entry.time >= 0 ? entry.time : null,
                method:req.method, path:req.path, status:response.status, request:req, timings,
                ...(error && {error}),
                response:{status:response.status, headers:headersView(response.headers), ...bodyView(content.text, content.mimeType, content.encoding)}};
        } catch {
            throw new Error(`Invalid HAR entry ${index + 1}. / HAR 第 ${index + 1} 条记录无效。`);
        }
    });
}

module.exports = { safeValue, headersView, bodyView, requestView, harRecords, maxBodyBytes };
