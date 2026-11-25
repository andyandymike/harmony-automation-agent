import {html, requestHost, fieldNames, fieldText, highlight, ruleDifferences, exchangeDifferences, isTransportChange} from "./networkInspector.js";
import {tabList, tabPanels} from "./ui/tabs.js";
import {actionButton} from "./ui/controls.js";
import {itemMenuTrigger} from "./ui/itemActions.js";
import {jsonFields, headerFields, queryFields, fieldBrowser} from "./networkFieldActions.js";

export function button(action, label, options = {}) {
    const {id, disabled, pressed, primary, title, className, expanded, controls, quiet, focusId} = options;
    return actionButton(label, {primary, disabled, quiet, className, attrs: {
        id:focusId, "data-net": action, "data-id": id, "aria-pressed": pressed, "aria-expanded": expanded, "aria-controls": controls, title,
    }});
}

export const duration = value => value == null ? "—" : Math.round(value) + " ms";
export const clock = (stamp, lang) => new Date(stamp).toLocaleTimeString(lang, {hour12:false});
export function statusTone(value) {
    if (value === 0 || value >= 500) return "error";
    if (value >= 400) return "warning";
    return value >= 200 && value < 300 ? "success" : "ordinary";
}
export function sourceNames(w) {
    return {fixture:w("Local fixture","本地模拟"),gateway:w("Test gateway","测试网关"),
        device:w("Native HTTP","真机 HTTP"),arkweb:"ArkWeb",har:"HAR"};
}
export function option(value, label, current) {
    return `<option value="${html(value)}" ${current === value ? "selected" : ""}>${html(label)}</option>`;
}
function bodyNote(part, w) {
    const notes = {unavailable:w("No body retained in this record.","本条记录未保留正文。"),
        tooLarge:w("Body exceeded the capture size limit.","正文超出采集大小上限。"),
        omitted:w("Body format was not retained.","此格式的正文未保留。")};
    return notes[part.bodyState] || notes.unavailable;
}
function renderField(record, field, hit, cursor, w) {
    const text = fieldText(record, field);
    const part = field.startsWith("response") ? record.response : record.request;
    let contents, interactive=false;
    if (text || (field.endsWith("Body") && part.body !== undefined)) {
        let markup=highlight(text,hit?.field === field ? hit : undefined), browser="";
        const side=field.startsWith("response") ? "response" : "request";
        if(field.endsWith("Body") && part.bodyState==="json"){
            if(text.length<=8192 && hit?.field!==field){markup=jsonFields(record,side+"Json",w);interactive=true;}
            else browser=fieldBrowser(record,side+"Json",cursor,w);
        } else if(field.endsWith("Headers") && hit?.field!==field){
            markup=headerFields(record,side+"Header",w);
        }
        contents = browser+`<pre class="net-field-value">${markup}</pre>`;
    } else {
        const note = field.endsWith("Body") ? bodyNote(part,w) : w("No headers retained.","未保留头部字段。");
        contents = `<p class="net-unavailable">${html(note)}</p>`;
    }
    return `<section class="net-detail-field"><h3>${w(...fieldNames[field])}${interactive ?
        ` <small>${w("Select a field to create a rule","点字段建规则")}</small>`:""}</h3>${contents}</section>`
        +(field==="url"?queryFields(record,w):"");
}
const showValue = value => typeof value === "string" ? value : JSON.stringify(value, null, 2);
export function diffRows(changes, labels, w) {
    if (!changes.length) return `<p class="net-unavailable">${w("The retained fields are identical.","保留的字段内容一致。")}</p>`;
    const cell = (value, side) => `<div class="net-diff-value ${side}"><small>${html(labels[side])}</small>
        <pre>${value === undefined ? `<i>${w("Absent","无此字段")}</i>` : html(showValue(value))}</pre></div>`;
    return `<div class="net-differences">${changes.map(change => `<section><h3><code>${html(change.path)}</code></h3>
        <div class="net-diff-pair">${cell(change.before,"before")}${cell(change.after,"after")}</div></section>`).join("")}</div>`;
}
function changesView(record,w) {
    if (!record.effectiveRequest && !record.originalResponse) {
        return `<p class="net-unavailable">${w("This source retained a single version. To compare captures, select two requests in the list.","此来源只保留了一版请求与响应。可在请求列表中多选两条记录进行对比。")}</p>`;
    }
    const labels = {before:w("Original","原始"),after:w("Effective","实际生效")};
    const changes = ruleDifferences(record);
    const transport = changes.filter(isTransportChange);
    const application = changes.filter(change => !isTransportChange(change));
    return `<p class="net-diff-note">${record.originalResponse ?
        w("Compares the incoming request and upstream response with what the gateway sent.","对比网关收到的原始请求、上游返回的原始响应，以及应用规则后发出的内容。") :
        w("Request changes only. The local response has no upstream original.","显示请求的改写。此本地响应没有上游原文。")}</p>
        ${application.length || !transport.length ? diffRows(application,labels,w) : ""}
        ${transport.length ? `<details class="net-transport-diff" id="net-transport-diff-${html(record.id)}"><summary>${w("Transport headers","传输头部")} · ${transport.length}</summary>
            ${diffRows(transport,labels,w)}</details>` : ""}`;
}
export function comparisonView(before,after,w,lang,fromSelection) {
    const changes=exchangeDifferences(before,after);
    const labels={before:w("Request A","请求 A"),after:w("Request B","请求 B")};
    const identity=(record,label)=>{
        const time=new Date(record.startedAt).toLocaleString(lang,{year:"numeric",month:"2-digit",day:"2-digit",
            hour:"2-digit",minute:"2-digit",second:"2-digit",fractionalSecondDigits:3,hour12:false});
        const status=record.status ? "HTTP "+record.status : w("No HTTP response","未收到 HTTP 响应");
        return `<div data-comparison-id="${html(record.id)}"><dt>${label}</dt>
            <dd><strong>${html(record.method+" "+requestHost(record)+record.path)}</strong>
            <small>${html(time)} · ${html(status)} · ${duration(record.durationMs)}</small></dd></div>`;
    };
    return `<article class="net-detail net-comparison"${fromSelection ? ' data-list-name="requests"' : ""} aria-labelledby="net-comparison-title">
        <header class="net-detail-head"><div class="net-detail-title"><h2 id="net-comparison-title" tabindex="-1">${w("Request comparison","请求对比")}</h2>
        ${actionButton(w("Back to requests","返回请求列表"),{quiet:true,attrs:{"data-net":"closeComparison"}})}</div>
        <dl class="net-comparison-sources">${identity(before,labels.before)}${identity(after,labels.after)}</dl></header>
        <div class="net-detail-content" id="net-detail-body" data-scroll-key="${html(JSON.stringify([before.id,after.id]))}">
        ${changes.length ? `<h3 class="net-comparison-count">${w(changes.length+" changed fields","差异字段 "+changes.length+" 项")}</h3>` : ""}
        ${diffRows(changes,labels,w)}</div></article>`;
}
function timing(record,w) {
    const labels = {blocked:w("Blocked","排队"),dns:"DNS",connect:w("Connect","连接"),ssl:"TLS",
        send:w("Send","发送"),wait:w("Wait","等待"),receive:w("Receive","接收")};
    const stages = Object.entries(record.timings || {});
    return `<section class="net-detail-field"><h3>${w("Total duration","总耗时")} · ${duration(record.durationMs)}</h3>
        ${stages.length ? `<dl class="net-timings">${stages.map(([name,ms]) => `<dt>${html(labels[name] || name)}</dt><dd>${duration(ms)}</dd>`).join("")}</dl>` :
        `<p class="net-unavailable">${w("This source did not retain timing phases.","此来源未保留分段耗时。")}</p>`}</section>`;
}
export function detailView(record, records, detail, hit, w, lang, matchedRule, {favorite,ai,busy,editor="",hasRuleDraft=false,picking=false}={}) {
    const tabs = {response:w("Response","响应"),request:w("Request","请求"),timing:w("Timing","耗时"),
        changes:w("Rule changes","改写差异")};
    let contents;
    if (detail.tab === "changes") contents = changesView(record,w);
    else if (detail.tab === "timing") contents = timing(record,w);
    else {
        const fields = detail.tab === "response" ? ["responseBody","responseHeaders"] : ["url","requestHeaders","requestBody"];
        contents = fields.map(field => renderField(record,field,hit,detail.fieldCursor,w)).join("");
    }
    const source = sourceNames(w)[record.source] || record.source;
    const original = record.replayOf && records.find(row=>row.id===record.replayOf);
    const tabOptions = {id:"network-detail",className:"net-detail-tabs",label:w("Exchange details","请求详情"),active:detail.tab,
        items:Object.entries(tabs).map(([id,label])=>({id,label,data:{net:"detail",id,...(picking && {"list-name":"requests"})}}))};
    return `<article class="net-detail" data-item-actions="request" data-record-detail="true" data-record-id="${html(record.id)}"
        data-item-label="${html(record.method+" "+record.path)}" aria-label="${w("Exchange details","请求详情")}">
        <header class="net-detail-head"><div class="net-detail-title">
        ${actionButton("←",{className:"net-back-list",quiet:true,attrs:{"data-net":"backToList","aria-label":w("Back to requests","返回请求列表"),title:w("Back to requests","返回请求列表")}})}
        <h2><span class="net-verb">${html(record.method)}</span> ${html(record.path)}</h2>
        <span class="net-status" data-tone="${statusTone(record.status)}">${record.status === 0 ? w("No HTTP response","未收到 HTTP 响应") : "HTTP "+html(record.status)}</span></div>
        <div class="net-detail-meta"><span class="net-host">${html(requestHost(record))}</span><span>${html(source)}</span><span>${html(clock(record.startedAt,lang))}</span><span>${duration(record.durationMs)}</span>
        ${button(favorite?"unfavorite":"favorite",favorite?w("★ Saved","★ 已收藏"):w("☆ Save","☆ 收藏"),
            {id:record.id,focusId:"net-detail-star",pressed:!!favorite,className:"net-save-exchange",quiet:true,title:favorite?w("Remove this favorite","取消收藏这条请求"):w("Keep this request and response","保存此请求与当时的响应")})}</div>
        ${favorite?`<div class="net-saved-name">${html(favorite.name)} ${button("renameFavorite",w("Rename","改名"),{id:record.id,quiet:true})}</div>`:""}
        ${record.batch ? button("captureResults",record.batch.label,{id:record.batch.id,quiet:true,title:w("View requests from this batch","查看这批请求")}) : ""}
        ${record.ruleId ? `<p class="net-provenance">${w("Matched rule","命中规则")} ${matchedRule ?
            button("matchedRule",record.ruleId,{id:record.id,className:"net-rule-link",quiet:true,title:w("Edit matched rule","编辑命中规则")}) :
            `<code>${html(record.ruleId)}</code>`} · #${html(record.ruleHit)}${record.ruleScenarioName?" · "+html(record.ruleScenarioName):""}</p>` : ""}
        ${original ? `<div class="net-provenance">${w("Resent from","重发来源")} ${button("openExchange",original.method+" "+requestHost(original)+original.path,{id:original.id,quiet:true})}
            ${button("compareReplay",w("Compare with original","与原请求对比"),{id:record.id})}</div>` :
            record.replayOf ? `<p class="net-provenance">${w("The original request is no longer retained.","历史和收藏中已找不到原请求。")}</p>` : ""}
        ${record.error ? `<p role="alert">${html(record.error)}</p>` : ""}
        <div class="net-actions">${button("createRule",hasRuleDraft?w("Continue rule draft","继续编辑规则"):w("Create rule","创建规则"),{id:record.id,disabled:busy})}
        ${button("resend",w("Edit & resend","编辑并重发"),{id:record.id,disabled:busy})}
        ${itemMenuTrigger(w("Request actions","请求操作"),false)}
        <div data-item-menu hidden>${actionButton(w("Explain this request with AI","用 AI 解释这条请求"),{quiet:true,disabled:busy,attrs:{"data-type":"explainExchange","data-id":record.id}})}</div></div></header>
        ${ai?.key === record.id ? `<section class="inline-ai"><strong>${w("AI explanation","AI 解释")}</strong>
            ${["running","stopping"].includes(ai.status) ? `<p role="status">${w("Reviewing this request…","正在分析这条请求…")}</p>
                ${actionButton(w("Stop","停止"),{disabled:ai.status==="stopping",attrs:{"data-type":"cancelAI"}})}` : ""}
            ${ai.status==="cancelled" ? `<p>${w("Stopped","已停止")}</p>` : ""}
            ${ai.answer ? `<p class="ai-answer" role="status">${html(ai.answer)}</p>` : ""}
            ${ai.evidence?.length ? `<details id="net-ai-evidence-${html(record.id)}"><summary>${w("Evidence consulted","实际读取的证据")}</summary>
                <p class="ai-answer">${html(ai.evidence[0].text)}</p></details>` : ""}</section>` : ""}
        ${editor}${tabList(tabOptions)}<div class="net-detail-content" id="net-detail-body"${picking ? ' data-list-name="requests"' : ""} data-scroll-key="${html(record.id)}-${detail.tab}">${tabPanels(tabOptions,contents)}</div></article>`;
}
