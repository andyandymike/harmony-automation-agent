"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { safeValue, headersView, bodyView, requestView, harRecords, maxBodyBytes } = require("./networkEvidence");
const {matchRule,validateRule,estimate,localPath} = require("./networkRules");
const {upstreamOrigin,readBytes,gatewayExchange,replayInput} = require("./networkGateway");
const {NetworkCollection} = require("./networkCollection");

const limit = 500;
const isObject = obj => obj !== null && typeof obj === "object" && !Array.isArray(obj);
const transportHeaders = new Set(["host","content-length","connection","transfer-encoding","upgrade","trailer","keep-alive"]);
const invalid = (en, zh) => { throw new Error(en + " / " + zh); };

function exampleScenario() {
    return {version:1, name:"Retry / 重试", rules:[{id:"items", method:"GET", path:"/items", steps:[
        {response:{status:503, json:{error:"Try again"}}},
        {response:{status:200, json:{items:[]}}},
    ]}]};
}

function scenarioFromRecord(record) {
    if (!Number.isInteger(record.status) || record.status<200 || record.status>599)
        invalid("No usable HTTP response status was captured. Create a response sequence and specify the intended status.", "未采集到可用的 HTTP 响应状态。请新建顺序响应并填写预期状态码。");
    const response = {status:record.status};
    if(record.method!=="HEAD" && ![204,205,304].includes(record.status)){
        const captured=record.response;
        if(captured?.bodyState!=="json" || captured.body===undefined || JSON.stringify(captured.body).includes("[redacted]"))
            invalid("A complete JSON response is needed. Create a response sequence and enter the intended test response.", "此记录缺少完整的 JSON 响应。请新建顺序响应并填写预期测试正文。");
        response.json=structuredClone(captured.body);
    }
    return {version:1, name:record.method + " " + record.path, rules:[{id:"request",method:record.method,
        path:record.path,steps:[{response}]}]};
}

function validateHeaders(headers, forResponse) {
    if (headers === undefined) return;
    if (!isObject(headers)) invalid("headers must contain named values.", "headers 必须包含键值。");
    for (const [key, value] of Object.entries(headers)) {
        if (typeof value !== "string" || transportHeaders.has(key.toLowerCase()))
            invalid("Use a string fixture header or remove the reserved transport header.", "请使用字符串请求头或移除保留的传输头。");
        try { http.validateHeaderName(key); http.validateHeaderValue(key, value); }
        catch { invalid("Invalid HTTP header.", "HTTP 头无效。"); }
        if (forResponse && key.toLowerCase() === "location" && !/^\/(?![\/\\])/.test(value))
            invalid("Fixture redirects must use a local path.", "本地模拟响应的跳转需要使用本地路径。");
    }
}

function validateScenario(input) {
    const scenario = structuredClone(typeof input === "string" ? JSON.parse(input) : input);
    if (scenario?.version !== 1 || !Array.isArray(scenario.rules)) invalid("Expected version 1 and rules[].", "规则组需要 version 1 和 rules 数组。");
    if (scenario.paused !== undefined && typeof scenario.paused !== "boolean") invalid("Paused must be a boolean.", "暂停状态必须是布尔值。");
    const ids = new Set();
    for (const rule of scenario.rules) {
        if (typeof rule?.id !== "string" || !rule.id.trim() || ids.has(rule.id)) invalid("Use unique rule IDs.", "每条规则需要唯一的 ID。");
        ids.add(rule.id);
        if (rule.match || rule.action) { validateRule(rule); continue; }
        if (typeof rule.method !== "string" || !/^[A-Za-z]+$/.test(rule.method) || typeof rule.path !== "string" ||
            !/^\/(?!\/)/.test(rule.path) || /[\\#?]/.test(rule.path) ||
            (rule.enabled !== undefined && typeof rule.enabled !== "boolean")) {
            invalid("Use an HTTP method and an exact path such as /items.", "请使用 HTTP 方法及 /items 形式的精确路径。");
        }
        rule.method = rule.method.toUpperCase();
        if (!Array.isArray(rule.steps) || !rule.steps.length) invalid("A rule needs at least one step.", "规则至少需要一个响应步骤。");
        for (const step of rule.steps) {
            const response = step?.response, request = step?.request;
            if (!isObject(response) || !Number.isInteger(response.status) || response.status < 200 || response.status > 599)
                invalid("Expected an HTTP response status from 200 to 599.", "请填写 200 至 599 的响应状态码。");
            if (response.delayMs !== undefined && (!Number.isInteger(response.delayMs) || response.delayMs < 0 || response.delayMs > 60000))
                invalid("delayMs must be between 0 and 60000.", "delayMs 应在 0 至 60000 之间。");
            if (request !== undefined && !isObject(request) || request?.json !== undefined && !isObject(request.json) ||
                request?.query !== undefined && (!isObject(request.query) || Object.values(request.query).some(v => typeof v !== "string")))
                invalid("Request edits use a JSON object and string query values.", "请求修改使用 JSON 对象和字符串查询参数。");
            validateHeaders(request?.headers, false);
            validateHeaders(response.headers, true);
        }
    }
    return scenario;
}

function setHeaders(base, edits) {
    const result = {...base};
    for (const [key, value] of Object.entries(edits || {})) result[key.toLowerCase()] = value;
    return result;
}

class NetworkSession {
    constructor({onChange = () => {}, scenarioId = () => undefined} = {}) {
        this.onChange = onChange;
        this.scenarioId = scenarioId;
        this.scenario = exampleScenario();
        this.counts = new Map();
        this.records = [];
        this.collection = new NetworkCollection();
        this.omittedRecords = 0;
        this.upstream = "";
        this.replays = new Map();
    }

    snapshot() {
        return {running:Boolean(this.baseUrl), baseUrl:this.baseUrl, upstream:this.upstream, scenario:this.scenario, records:[...this.records],
            favorites:[...this.collection.items.values()], removedFavorite:this.collection.removed?.record.id, deletedCapture:this.removedRecord?.record.id,
            clearedHistory:this.clearedHistory?.id,
            omittedRecords:this.omittedRecords, hits:this.scenario.rules.map(rule => ({ruleId:rule.id,count:this.counts.get(rule.id) || 0}))};
    }

    notify() { this.onChange(this.snapshot()); }

    append(records, skipped=0) {
        const total = this.records.length + records.length;
        this.records = this.records.concat(records).slice(-limit);
        this.omittedRecords += skipped + Math.max(0, total - limit);
        this.notify();
    }

    importHar(input, { source = "har", batch } = {}) {
        const records = harRecords(input, source);
        if (batch) for (const record of records) record.batch = batch;
        this.append(records);
        return records.length;
    }

    // Workspace persistence contains the records returned by snapshot(), never a raw capture.
    restoreRecords(records, omittedRecords = 0) {
        this.records = records.slice(-limit);
        this.omittedRecords = omittedRecords + Math.max(0,records.length - limit);
    }

    findRecord(id) { return this.records.find(row => row.id === id) || this.collection.items.get(id)?.record; }

    removeRecord(id) {
        const index = this.records.findIndex(row => row.id === id);
        if (index < 0) return;
        this.removedRecord = {record:this.records[index], following:this.records[index+1]?.id, index};
        this.records.splice(index,1);
        this.notify();
    }

    undoRecordRemoval(id) {
        const removed = this.removedRecord;
        if (!removed || removed.record.id !== id) return;
        const following = this.records.findIndex(r => r.id === removed.following);
        this.records.splice(following >= 0 ? following : Math.min(removed.index,this.records.length),0,removed.record);
        if (this.records.length > limit) {
            this.records.splice(this.records[0] === removed.record ? 1 : 0,1);
            this.omittedRecords++;
        }
        this.removedRecord = undefined;
        this.notify();
    }

    clearRecords() {
        if (!this.records.length && !this.omittedRecords) return;
        this.clearedHistory = { id: randomUUID(), records: this.records, omitted: this.omittedRecords };
        this.records = [];
        this.omittedRecords = 0;
        this.removedRecord = undefined;
        this.notify();
    }

    undoClearRecords(id) {
        const saved = this.clearedHistory;
        if (!saved || saved.id !== id) return;
        this.clearedHistory = undefined;
        const incoming = this.records;
        const retained = new Set(incoming.map(record => record.id));
        this.records = saved.records.filter(record => !retained.has(record.id));
        this.omittedRecords += saved.omitted;
        this.append(incoming);
    }

    setScenario(input, savedHits = []) {
        this.scenario = validateScenario(input);
        const ids = new Set(this.scenario.rules.map(rule=>rule.id));
        this.counts = new Map(savedHits.filter(hit=>ids.has(hit.ruleId) && Number.isSafeInteger(hit.count) && hit.count>0)
            .map(hit=>[hit.ruleId,hit.count]));
        this.notify();
    }

    setScenarioPaused(paused) {
        this.scenario = {...this.scenario,paused};
        this.notify();
    }

    setUpstream(value) {
        const origin = upstreamOrigin(value);
        if (origin && this.baseUrl && new URL(origin).port === new URL(this.baseUrl).port)
            invalid("Choose a different port from the gateway.", "上游端口与网关端口必须不同。");
        this.upstream = origin;
        this.notify();
    }

    upsertRule(input) {
        const rule = validateScenario({version:1,rules:[input]}).rules[0];
        const rules = [...this.scenario.rules];
        const index = rules.findIndex(existing=>existing.id===rule.id);
        if (index < 0) rules.unshift(rule);
        else {
            const prior = rules[index];
            if (JSON.stringify({...prior,enabled:true}) !== JSON.stringify({...rule,enabled:true})) this.counts.delete(rule.id);
            rules[index] = rule;
        }
        this.scenario = {...this.scenario,rules};
        this.notify();
    }

    saveEditedRule(input, original) {
        const rule = validateScenario({version:1,rules:[input]}).rules[0];
        const rules = [...this.scenario.rules];
        const index = original ? rules.findIndex(item=>item.id===original.id) : -1;
        if (original && (index < 0 || JSON.stringify(rules[index]) !== JSON.stringify(original)))
            invalid("This rule changed. Reopen it or save your draft as a copy.", "这条规则已变更。请重新打开，或将草稿另存为副本。");
        if (rules.some((item,i)=>item.id===rule.id && i!==index))
            invalid("A rule with this name already exists.", "已有同名规则。请使用其他名称。");
        if (index < 0 || rule.id===original.id) {this.upsertRule(rule);return;}
        const oldCount=this.counts.get(original.id);
        this.counts.delete(original.id);
        if (oldCount && JSON.stringify({...original,id:rule.id,enabled:true})===JSON.stringify({...rule,enabled:true}))
            this.counts.set(rule.id,oldCount);
        rules[index]=rule;
        this.scenario={...this.scenario,rules};
        this.notify();
    }

    restoreRemovedRule({rule,index,hits}) {
        const rules=[...this.scenario.rules];
        if(rules.some(item=>item.id===rule.id))
            invalid("A rule with this name already exists.", "已有同名规则，无法撤销移除。");
        rules.splice(Math.min(index,rules.length),0,rule);
        this.scenario={...this.scenario,rules};
        if(hits) this.counts.set(rule.id,hits);
        this.notify();
    }

    removeRule(id) {
        this.scenario = {...this.scenario,rules:this.scenario.rules.filter(rule=>rule.id!==id)};
        this.counts.delete(id);
        this.notify();
    }

    moveRule(id,direction) {
        const rules = [...this.scenario.rules], index = rules.findIndex(rule=>rule.id===id);
        const next = direction==="up" ? index-1 : direction==="down" ? index+1 : direction;
        if (index<0 || !Number.isInteger(next) || next<0 || next>=rules.length || next===index) return;
        const [rule] = rules.splice(index,1);
        rules.splice(next,0,rule);
        this.scenario = {...this.scenario,rules};
        this.notify();
    }

    previewRule(input,records=this.collection.recordsWithHistory(this.records),preferredId,originalId=input.id) {
        const rule = validateScenario({version:1,rules:[input]}).rules[0];
        const pattern={...rule,enabled:true};
        const matching = records.filter(r => matchRule(pattern,r.method,new URL(r.request.url)));
        const originalIndex=originalId==null?-1:this.scenario.rules.findIndex(r=>r.id===originalId);
        const ordered=[...this.scenario.rules];
        if(originalIndex<0) ordered.unshift(rule);
        else ordered[originalIndex]=rule;
        const origin=this.upstream||this.baseUrl;
        const routes=new Map();
        let gatewayMatches=0, applicable=0;
        for(const record of records){
            if(!origin) break;
            const original=new URL(record.request.url);
            const url=new URL(origin);
            url.pathname=original.pathname;
            url.search=original.search;
            if([...url.searchParams.values()].some(v=>/\[redacted\]/i.test(v)))
                url.search=new URLSearchParams([...url.searchParams].filter(([,v])=>!/\[redacted\]/i.test(v))).toString();
            const matches=matchRule(pattern,record.method,url);
            const winner=!this.scenario.paused && ordered.find(r=>matchRule(r,record.method,url));
            if(matches) gatewayMatches++;
            if(winner===rule) applicable++;
            routes.set(record.id,{url:url.href,matches,winner:winner?.id,selected:winner===rule});
        }
        const recent = matching.slice().reverse();
        const historical=new Set(matching.map(r=>r.id));
        const samples=[...recent,...records.filter(r=>!historical.has(r.id)&&routes.get(r.id)?.matches).reverse()];
        const selected=preferredId && records.find(r=>r.id===preferredId);
        if(selected){const i=samples.indexOf(selected);if(i>=0)samples.splice(i,1);samples.unshift(selected);}
        return {total:records.length,matchedIds:matching.map(r=>r.id),
            gateway:{origin,upstream:this.upstream,paused:!!this.scenario.paused,disabled:rule.enabled===false,
                needsUpstream:!!rule.match && rule.action!=="local" && !this.upstream, gatewayMatches,applicable},
            examples:samples.slice(0,5).map(r=>({...((historical.has(r.id)&&rule.match)?estimate(rule,r):{id:r.id,request:r.request}),
                historical:historical.has(r.id),route:routes.get(r.id)}))};
    }

    async replay(draft) {
        if (!this.baseUrl) invalid("Start the local test gateway first.", "请先启动本地测试网关。");
        const source = draft.sourceId && this.findRecord(draft.sourceId);
        if (draft.sourceId && !source) invalid("The source exchange is no longer available.", "原始请求已不在记录中。");
        const {method,path,headers,body} = replayInput(draft);
        if (source && ["POST","PUT","PATCH"].includes(method) && draft.body === undefined &&
            !["json","form","text"].includes(source.request.bodyState))
            invalid("Supply the replay body explicitly.", "请明确填写要重发的正文。");
        return this.sendLocal({method,path,headers,body},{sourceId:source?.id,replayed:true});
    }

    async testSequence(rule) {
        return this.sendLocal({method:rule.method,path:rule.path,headers:{}},{testedRuleId:rule.id});
    }

    async sendLocal({method,path,headers,body},pending) {
        const token = randomUUID();
        this.replays.set(token,pending);
        try {
            const response = await fetch(this.baseUrl+path,{method,headers:{...headers,"x-workbench-replay":token},
                body:body || undefined,redirect:"manual",signal:AbortSignal.timeout(65000)});
            await response.arrayBuffer();
            if (!pending.record) invalid("No exchange was recorded for this test request.", "本次测试请求未生成记录。");
            return pending.record;
        } finally {this.replays.delete(token);}
    }

    resetHits() { this.counts.clear(); this.notify(); }
    clear() { this.records = []; this.removedRecord = undefined; this.omittedRecords = 0; this.notify(); }

    async start() {
        if (this.closing) await this.closing;
        if (this.baseUrl) return this.baseUrl;
        if (this.opening) return this.opening;
        const abort = new AbortController();
        const server = http.createServer((req, res) => {
            this.handle(req, res, abort.signal).catch(e => {
                if (!res.destroyed && !res.headersSent) res.writeHead(e.status || 400).end();
                else if (!res.writableEnded) res.destroy();
            });
        });
        this.opening = new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
                server.off("error", reject);
                this.server = server;
                this.abort = abort;
                this.baseUrl = "http://127.0.0.1:" + server.address().port;
                this.notify();
                resolve(this.baseUrl);
            });
        });
        try { return await this.opening; } finally { this.opening = undefined; }
    }

    async stop() {
        if (this.opening) await this.opening;
        if (this.closing) return this.closing;
        if (!this.server) return;
        const server = this.server;
        this.server = this.baseUrl = undefined;
        this.abort.abort();
        this.closing = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        try { await this.closing; } finally { this.closing = undefined; this.notify(); }
    }

    async handle(req, res, signal) {
        const started = Date.now(), startedAt = new Date(started).toISOString(), baseUrl = this.baseUrl;
        // Accept local API paths, never absolute proxy targets.
        if (!/^\/(?![\/\\])/.test(req.url)) { res.writeHead(400).end(); return; }
        const upstream = this.upstream;
        // A restored upstream could coincide with the gateway's newly allocated port.
        if (upstream && new URL(upstream).port === new URL(baseUrl).port) {
            res.writeHead(508,{"content-type":"text/plain; charset=utf-8"}).end("Upstream points to this gateway. / 上游指向当前网关。");
            return;
        }
        const url = new URL(localPath(req.url),upstream || baseUrl);
        if (url.origin !== (upstream || baseUrl)) { res.writeHead(400).end(); return; }
        const method = req.method;
        const pending = this.replays.get(req.headers["x-workbench-replay"]);
        delete req.headers["x-workbench-replay"];
        const bytes = await readBytes(req,{drain:true});
        if (signal.aborted) return;
        const rule = this.scenario.paused ? undefined : this.scenario.rules.find(r => matchRule(r,method,url));
        // Keep the owner at match time; a slow response can finish after the
        // operator has switched to a different scenario with a same-named rule.
        const ruleScenarioId=rule && this.scenarioId();
        const owner=ruleScenarioId ? {ruleScenarioId,ruleScenarioName:this.scenario.name} : {};
        const raw = bytes.length <= maxBodyBytes ? bytes.toString("utf8") : undefined;
        let ruleHit;
        if (rule && (rule.match || raw !== undefined)) {
            ruleHit = (this.counts.get(rule.id) || 0) + 1;
            this.counts.set(rule.id,ruleHit);
        }
        if (rule?.match || upstream && !rule) {
            const {reply,record} = await gatewayExchange({url,method,headers:req.headers,bytes,rule,upstream,signal});
            if (!signal.aborted) this.finish(res,{id:randomUUID(),startedAt,method,path:url.pathname,...record,
                ...(rule && {ruleId:rule.id,ruleHit,...owner}),status:reply.status},reply,started,pending);
            return;
        }
        const parsedBody = raw === undefined ? {bodyState:"tooLarge"} : bodyView(raw, req.headers["content-type"]);
        const request = requestView(method, url, req.headers, parsedBody);
        let stepIndex, effective = request;
        let reply = {status:404, json:{error:"No fixture rule matches this request."}};
        if (raw === undefined) reply = {status:413,json:{error:"Fixture request body too large."}};
        else if (rule) {
            stepIndex = Math.min(ruleHit,rule.steps.length) - 1;
            const {request:edits, response} = rule.steps[stepIndex];
            const effectiveUrl = new URL(url);
            for (const [key, value] of Object.entries(edits?.query || {})) effectiveUrl.searchParams.set(key, value);
            const baseHeaders = edits?.json === undefined ? req.headers : {...req.headers, "content-type":"application/json"};
            const headers = setHeaders(baseHeaders, edits?.headers);
            const body = edits?.json === undefined ? parsedBody :
                {bodyState:"json",body:safeValue("", {...(isObject(parsedBody.body) ? parsedBody.body : {}), ...edits.json})};
            effective = requestView(method, effectiveUrl, headers, body);
            reply = response;
        }
        const headers = setHeaders({"content-type":"application/json; charset=utf-8"}, reply.headers);
        const echo = {method, path:effective.path, query:effective.query, headers:effective.headers, body:effective.body};
        const noBody = method === "HEAD" || [204,205,304].includes(reply.status);
        const value = reply.json === undefined ? echo : reply.json;
        const serialized = noBody ? "" : JSON.stringify(value);
        const record = {id:randomUUID(), source:"fixture", startedAt, method, path:url.pathname, request,
            ...(ruleHit && {ruleId:rule.id, ruleHit, stepIndex, effectiveRequest:effective,...owner}), status:reply.status,
            response:{status:reply.status,headers:headersView(headers), ...bodyView(serialized, "application/json")}};
        if (reply.delayMs) await delay(reply.delayMs, undefined, {signal});
        if (signal.aborted) return;
        this.finish(res,record,{status:reply.status,headers,bytes:serialized},started,pending);
    }

    finish(res,record,reply,started,pending) {
        if (res.destroyed) {
            record.error = "CLIENT_CLOSED";
            record.status = 0;
        } else {
            res.writeHead(reply.status,reply.headers);
            res.end(reply.bytes);
        }
        record.durationMs = Date.now() - started;
        if (pending) {
            if(pending.replayed) record.replayed = true;
            if(pending.testedRuleId) record.testedRuleId=pending.testedRuleId;
            if (pending.sourceId) record.replayOf = pending.sourceId;
            pending.record = record;
        }
        this.append([record]);
    }
}

module.exports = { NetworkSession, exampleScenario, scenarioFromRecord, validateScenario, historyLimit:limit };
