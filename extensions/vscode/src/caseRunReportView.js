"use strict";

const { renderDurationChart } = require("./caseRunReportChart");
const { renderRunStatistics } = require("./caseRunReportStatsView");
const { safeValue } = require("./networkEvidence");

const words = language => (en, zh) => /^zh/i.test(language) ? zh : en;
const h = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
const statusLabels = {
    passed:["Passed","通过"], failed:["Failed","失败"], completed:["Completed","已完成"],
    unknown:["Unconfirmed","未确认"], cancelled:["Cancelled","已取消"], blocked:["Blocked","受阻"],
    rejected:["Not run","未执行"], skipped:["Skipped","已跳过"], not_run:["Not run","未执行"],
    yielded:["Yielded","已暂停"], budget_exhausted:["Limit reached","达到上限"], error:["Error","错误"],
};
const commands = {press:["Click","点击"],fill:["Enter","输入"],scroll:["Scroll","滚动"],back:["Go back","返回"],
    wait:["Wait","等待"],observe:["Read screen","读取画面"],deviceGesture:["Device gesture","设备手势"],
    enableRuleGroup:["Enable rule group","启用规则组"],disableRuleGroup:["Turn off rule group","关闭规则组"]};
const status = (value,w) => Object.hasOwn(statusLabels,value) ? w(...statusLabels[value]) : value || "—";
const seconds = (value,w) => Number.isFinite(value) ? (value/1000).toFixed(2) + w(" s"," 秒") : "";
function durationLabel(ms,w) {
    if (!Number.isFinite(ms) || ms<0) return "";
    if (ms>0 && ms<1) return w("<1 ms","<1 毫秒");
    return ms<1000 ? Math.round(ms)+w(" ms"," 毫秒") : seconds(ms,w);
}
const time = (value,language) => {
    const date = new Date(value);
    return value && Number.isFinite(date.getTime()) ? date.toLocaleString(language,{dateStyle:"short",timeStyle:"short"}) : "";
};
const display = value => typeof value==="string" ? value : JSON.stringify(value) ?? "—";
const field = (label,value) => `<div><dt>${h(label)}</dt><dd>${value}</dd></div>`;
const icon = name => `<i aria-hidden="true" class="icon icon-${name}"></i>`;
const tone = row => row.isBlocking ? "error" : row.condition==="failed" || row.kind==="unreachedGoals" ? "neutral" :
    ["completed","passed"].includes(row.status) || row.condition==="passed" ? "ok" : "neutral";

function rowStatus(row,w) {
    if (row.condition==="passed") return w("Condition met","条件满足");
    if (row.condition==="failed") return row.kind==="repeat" ? w("Continue retrying","条件未满足") : w("Condition false","条件不满足");
    if (row.kind==="unreachedGoals" && row.evaluated<row.declared)
        return w(`${row.declared-row.evaluated} not run`,`${row.declared-row.evaluated} 条未执行`);
    return status(row.status,w);
}

function testPhases(pytest,w) {
    if (!pytest?.phases?.length) return "";
    return `<details class="report-raw"><summary>${w("pytest phases","pytest 测试阶段")}</summary><ul>${pytest.phases.map(phase=>
        `<li>${h(phase.when || phase.phase)} · ${h(phase.outcome)}${phase.nodeid ? ` · <code>${h(phase.nodeid)}</code>` : ""}</li>`).join("")}</ul></details>`;
}

function stateTone(state) {
    if (["failed","error","blocked","budget_exhausted"].includes(state)) return "error";
    if (["passed","completed","verified","applied"].includes(state)) return "ok";
    return "neutral";
}

function localizedState(value,w) {
    if (value==="out_of_scope") return w("Outside trial","验证范围外");
    return status(value,w);
}

function verdict(run,rows,w) {
    const {entry,outline} = run;
    const {targetGroup,targetIndex,blockingGroup,groups,goals,scope} = outline;
    const repair = run.context?.repair;
    const steps = groups.filter(group=>group.area==="step");
    const target = rows[targetIndex];
    const blocked = rows.find(row=>row.firstBlocking);
    const passedGoals = goals.filter(goal=>goal.status==="passed").length;
    const remaining = steps.filter(group=>group.status==="not_run" && group.number>blockingGroup?.number).length;
    const issues = [run.error,entry.failureMessage,blocked?.errorCode].filter(Boolean);
    if (scope==="target") {
        const didPass = ["passed","completed"].includes(target?.status) && !target.isBlocking && target.assertionStatus!=="failed";
        const verified = ["verified","applied"].includes(repair?.stage) || entry.repairApplied;
        const headline = verified ? w("Repair target verified","原失败步骤已验证") : didPass ? w("Trial reached its target","试跑已执行到目标步骤") :
            target?.isBlocking ? w("Target step failed","目标步骤验证失败") : w("Trial did not verify its target","本次未验证目标步骤");
        return {headline,detail:targetGroup?.caption || targetGroup?.title || target?.title || entry.repairTarget,
            note:entry.repairApplied || repair?.stage==="applied" ? w("Applied to case","修复已应用到用例") : "",
            tone:verified || didPass ? "ok" : blocked ? "error" : "neutral", kind:w("Targeted trial","定点试跑")};
    }
    if (blocked || stateTone(entry.status)==="error") {
        const where = blockingGroup?.number;
        const headline = where ? w(`Stopped at step ${where} of ${steps.length}`,`用例停在第 ${where} / ${steps.length} 步`) :
            blockingGroup?.area==="goal" ? w("Final check failed","最终断言失败") : blockingGroup?.area==="start" ?
            w("Starting condition blocked the run","起始条件阻断了运行") : localizedState(entry.status,w);
        return {headline,detail:blockingGroup?.caption || blockingGroup?.title || blocked?.title || issues[0],note:remaining ?
            w(`${remaining} subsequent steps did not run`,`后续 ${remaining} 个业务步骤未执行`) : "", tone:"error",
            kind:entry.status==="failed" || blocked ? w("Run failed","运行失败") : w("Run result","运行结果")};
    }
    const verifiedAll = goals.length && passedGoals===goals.length && entry.status==="passed";
    return {headline:verifiedAll ? w(`All ${passedGoals} final checks passed`,`${passedGoals} 项最终断言全部通过`) :
        entry.status==="passed" ? w("Case passed","用例通过") : localizedState(entry.status,w),
        detail:"",note:run.goalStatus==="not_requested" ? w("Final checks were not requested for this run.","本次运行未要求检查最终结果。") : "",
        tone:stateTone(entry.status),kind:entry.repairOf ? w("Repair verification","修复验证") : entry.status==="passed" ? w("Run passed","运行通过") : w("Run result","运行结果")};
}

function routeTrail(trail,w) {
    if (!trail?.length) return "";
    const last = trail.at(-1);
    const shown = trail.length>6 ? [trail[0],null,...trail.slice(-4)] : trail;
    const source = record => record.source==="fixture" ? (record.ruleMatched ? w("Mock rule","规则模拟") : w("Fixture service","模拟服务")) :
        record.source==="gateway" ? w("Gateway","网关") : w("Recorded","记录");
    let prior;
    const sequence = shown.map(record=>{
        if (!record) { prior=undefined; return `<span class="trail-ellipsis">…</span>`; }
        const label = source(record);
        const node = `<span class="trail-part">${label!==prior ? `<small>${h(label)}</small>` : ""}
            <b${record===last && record.status>=400 ? ' class="trail-fault"' : ""}>${h(record.status)}</b></span>`;
        prior=label;
        return node;
    }).join(`<span class="trail-arrow" aria-hidden="true">→</span>`);
    return `<div class="route-trail"><span class="trail-label" title="${h(last.method+" "+last.path)}">${w("Request sequence","请求经过")}</span><span class="trail-values">${sequence}</span></div>
        ${last.issue==="UPSTREAM_FAILED" && last.source==="gateway" && !Number.isInteger(last.upstreamStatus) ?
        `<p class="trail-note">${w("The gateway recorded no upstream HTTP response.","网关未记录到上游 HTTP 响应。")}</p>` : ""}`;
}

function goalSummary(outline,w) {
    const goals = outline.goals;
    if (!goals.length && outline.scope!=="target") return "";
    if (outline.scope==="target") {
        const group=outline.targetGroup;
        const boundary=group?.number ? w(`Through step ${group.number}`,`截至用例第 ${group.number} 步`) :
            group?.area==="goal" ? w("Through the selected final check","截至指定的最终断言") :
            group?.area==="start" ? w("Through the selected starting condition","截至指定的起始条件") : w("Through the selected target","截至指定验证目标");
        const outside=goals.filter(goal=>goal.status==="out_of_scope").length;
        const scopeNote=outside ? w(`${outside} final checks outside this trial.`,`${outside} 项最终断言在本次验证范围外。`) :
            w("This trial covers execution up to the target.","本次试跑仅验证到此处。");
        return `<aside class="check-panel"><h3>${w("Verification scope","验证范围")}</h3>
            <p>${h(boundary)}</p><small>${h(scopeNote)}</small></aside>`;
    }
    const check = goal=>{
        const idx = goal.indices[0];
        const copy = `<span class="status-symbol" data-tone="${stateTone(goal.status)}" aria-hidden="true"></span><span class="check-name">${h(goal.caption || goal.title)}</span>
            <small>${h(localizedState(goal.status,w))}</small>`;
        return Number.isInteger(idx) ? `<li><button class="check-row" type="button" data-jump-record="${idx}">${copy}</button></li>` :
            `<li><div class="check-row">${copy}</div></li>`;
    };
    return `<aside class="check-panel"><h3>${w("Final checks","最终断言")}</h3><ul>${goals.map(check).join("")}</ul></aside>`;
}

function contextNotes(run,related,w) {
    const {diagnosis,repair} = run.context || {};
    const note = diagnosis?.finding ? `<div class="diagnosis"><h3>${w("AI analysis","AI 分析")}</h3><p>${h(diagnosis.finding)}</p>
        ${diagnosis.next ? `<p class="next">${h(diagnosis.next)}</p>` : ""}</div>` : "";
    const labels = {proposed:["Repair suggested","已有修复建议"],draftSaved:["Repair draft saved","修复草稿已保存"],verified:["Repair verified","修复已验证"],applied:["Repair applied","修复已应用"],failed:["Repair trial failed","修复试跑失败"],verifying:["Verifying repair","正在验证修复"]};
    const showRepair = run.outline.scope!=="target" && Object.hasOwn(labels,repair?.stage);
    const repairNote = showRepair ? `<div class="repair-note">${h(w(...labels[repair.stage]))}${related.some(item=>item.id===repair.trialId) ?
        ` <button type="button" data-related="${h(repair.trialId)}">${w("View trial","查看试跑")}</button>` : ""}</div>` : "";
    return note+repairNote;
}

function durationCell(ms,coverage,w) {
    const recorded=durationLabel(ms,w);
    const label=recorded ? (coverage==="partial" ? w("Recorded ","已记录 ") : "")+recorded :
        coverage==="not_executed" ? "—" : w("Unrecorded","未计时");
    return `<span class="row-time"${recorded ? "" : ' data-muted="true"'}>${h(label)}</span>`;
}

function rowFace(number,title,state,meta,ms,coverage,w) {
    return `<span class="row-number">${h(number)}</span><span class="row-description"><span class="row-title">${h(title)}</span>
        ${meta ? `<small class="row-meta">${h(meta)}</small>` : ""}</span>${durationCell(ms,coverage,w)}<span class="row-status" data-tone="${stateTone(state)}">
        <i class="status-symbol" data-tone="${stateTone(state)}" aria-hidden="true"></i>${h(localizedState(state,w))}</span>`;
}

function recordLine(row,face,selected,w) {
    return `<button class="step-line record-line" type="button" data-record="${row.index}" aria-expanded="${selected===row.index}" aria-controls="report-evidence">
        ${face}<span class="fold-arrow" aria-hidden="true"></span></button><div data-slot="${row.index}"></div>`;
}

function groupLine(group,rows,selected,w) {
    const {indices,number,title,status:state} = group;
    const ordinal = number ? String(number).padStart(2,"0") : group.area==="goal" ? "◎" : group.area==="start" ? "◇" : "·";
    let meta = indices.length>1 ? w(`${indices.length} records`,`${indices.length} 条记录`) : "";
    const rounds=group.repeatSummary;
    if (rounds) {
        const count=w(`${rounds.iterations} iterations`,`循环 ${rounds.iterations} 轮`);
        meta=rounds.conditionMet ? count+w(" · exit condition met"," · 达到退出条件") : count;
    }
    const face = rowFace(ordinal,group.caption || title,state,meta,group.elapsedMs,group.timingCoverage,w);
    if (!indices.length) return `<div class="step-line static-line">${face}<span></span></div>`;
    if (indices.length===1) return recordLine(rows[indices[0]],face,selected,w);
    const nested = indices.map(index=>{
        const row=rows[index];
        const meta = row.iteration && w(`Iteration ${row.iteration}`,`第 ${row.iteration} 轮`);
        const name = row.condition ? `${row.title} · ${rowStatus(row,w)}` : row.title;
        return recordLine(row,rowFace("·",name,row.condition ? (row.condition==="passed"?"passed":"completed") : row.status,meta,row.elapsedMs,undefined,w),selected,w);
    }).join("");
    return `<details class="record-group"${indices.includes(selected) ? " open" : ""}><summary class="step-line">${face}<span class="fold-arrow" aria-hidden="true"></span></summary>
        <div class="nested-records">${nested}</div></details>`;
}

function inlineOutline(outline,rows,selected,w,actionTimingOnly) {
    const {groups} = outline;
    const entries = groups.filter(group=>group.area!=="goal");
    const render = group => `<div class="outline-item" data-tone="${stateTone(group.status)}">${groupLine(group,rows,selected,w)}</div>`;
    const heading=`<div class="ledger-columns"><span>${w("Step","步骤")}</span><span>${actionTimingOnly ? w("Action time","动作耗时") : w("Duration","耗时")}</span><span>${w("Result","结果")}</span></div>`;
    return `${heading}<div class="step-ledger">${entries.map(render).join("")}</div>
        ${outline.goals.length && (outline.scope!=="target" || outline.goals.some(group=>group.indices.length)) ? `<section class="goal-ledger"><h3>${w("Final checks","最终断言")}</h3>
        ${outline.goals.map(render).join("")}</section>` : ""}`;
}

function directory(groups,w) {
    const entries = groups.map(group=>{
        const index = group.indices[0];
        const name = group.number ? `${group.number}. ${group.title}` : group.caption || group.title;
        const face=`<span>${h(name)}</span>${durationCell(group.elapsedMs,group.timingCoverage,w)}<small>${h(localizedState(group.status,w))}</small>`;
        return `<li>${Number.isInteger(index) ? `<button type="button" data-jump-record="${index}" data-members="${group.indices.join(" ")}">${face}</button>` :
            `<div class="index-static">${face}</div>`}</li>`;
    }).join("");
    return `<dialog id="step-directory" aria-labelledby="directory-title"><div class="dialog-top"><h2 id="directory-title">${w("Step index","步骤目录")}</h2>
        <button type="button" class="icon-button" data-dialog-close aria-label="${w("Close index","关闭目录")}">${icon("close")}</button></div><ol class="trace-list">${entries}</ol></dialog>`;
}

function lightbox(w) {
    return `<dialog id="report-lightbox" aria-labelledby="photo-title"><div class="dialog-top"><h2 id="photo-title" data-full-caption>${w("Device screenshot","设备画面")}</h2>
        <button type="button" class="zoom-button" data-zoom data-zoom-in="${w("Actual size","原始尺寸")}" data-zoom-out="${w("Fit image","适应窗口")}">${w("Actual size","原始尺寸")}</button>
        <button type="button" class="icon-button" data-dialog-close aria-label="${w("Close screenshot","关闭原图")}">${icon("close")}</button></div>
        <div class="photo-stage" data-photo-stage><img data-full-image alt="${w("Full device screenshot","完整设备画面")}"></div></dialog>`;
}

function renderReport(run,rows,selected,related,language,{standalone=false,canExport=true}={}) {
    const w = words(language), {entry} = run;
    const outline=run.outline || {groups:[],goals:[],scope:"full"};
    const result=verdict({...run,outline},rows,w);
    const row=rows[selected];
    const focus=outline.focusIndex;
    const focusText=outline.scope==="target" ? w("Target step","验证目标") : outline.blockingGroup ? w("Failure location","失败位置") : w("Result location","结果位置");
    const runner=entry.source==="pytest" ? "pytest" : entry.source==="device" ? w("Device replay","真机回放") : w("Workbench","工作台");
    const duration=seconds(run.pytest?.elapsedMs ?? run.runtimeMs,w);
    const relatedRuns=related.length ? `<details class="report-raw related-runs"><summary>${w("Related runs","相关运行")} · ${related.length}</summary><ul>${related.map(item=>{
        const label=`${item.repairOf ? w("Repair trial","修复试跑") : w("Original run","原始运行")} · ${h(status(item.status,w))} <small>${h(time(item.time,language))}</small>`;
        return standalone ? `<li>${label}</li>` : `<li><button type="button" data-related="${h(item.id)}">${label}</button></li>`;
    }).join("")}</ul></details>` : "";
    const checks=goalSummary(outline,w);
    const failedRow=outline.blockingGroup && rows[outline.focusIndex];
    const values=outline.scope!=="target" && failedRow?.assertionStatus==="failed" && !failedRow.title?.includes("••••") && failedRow.expected!==undefined && failedRow.actual!==undefined
        && [failedRow.expected,failedRow.actual].every(value=>["string","boolean","number"].includes(typeof value) && String(value).length<=70);
    const verdictNote=values ? `<span>${w("Expected","预期")} <b>${h(failedRow.expected)}</b></span><span>${w("Observed","实际")} <b>${h(failedRow.actual)}</b></span>` :
        h(result.note);
    const summary=`<section class="run-verdict${checks ? " with-checks" : ""}" data-tone="${result.tone}"><div class="verdict-copy">
        <div class="verdict-label"><i class="status-symbol" data-tone="${result.tone}" aria-hidden="true"></i>${h(result.kind)}</div>
        <h2>${h(result.headline)}</h2>${result.detail ? `<p class="verdict-detail">${h(result.detail)}${outline.blockingGroup && Number.isInteger(focus) ? `<button type="button" class="verdict-jump" data-jump-record="${focus}">${w("View evidence","查看失败现场")} ↘</button>` : ""}</p>` : ""}
        ${verdictNote ? `<p class="verdict-note">${verdictNote}</p>` : ""}${routeTrail(run.context?.requestTrail,w)}</div>${checks}</section>`;
    const chart=renderDurationChart(rows,selected,language);
    return `<div class="report-page"><header class="document-head"><div class="document-meta"><span class="document-type"><i class="page-icon" aria-hidden="true"></i>${w("Test run report","测试报告")}</span>
        <span class="metadata-rule"></span><span>${h(runner)}</span>${entry.time ? `<time datetime="${h(entry.time)}">${h(time(entry.time,language))}</time>` : ""}
        ${duration ? `<span class="total-duration">${icon("clock")}${h(duration)}</span>` : ""}
        ${canExport && !standalone ? `<button type="button" class="report-export" data-export-report>${w("Export HTML","导出 HTML")}</button>` : ""}</div><h1>${h(entry.plan?.name || w("Test case","测试用例"))}</h1></header>
        ${summary}${renderRunStatistics(run,rows,outline,{w,h,durationLabel,localizedState})}${contextNotes({...run,outline},standalone ? [] : related,w)}
        ${outline.groups.length ? `<section class="outline"><div class="outline-nav"><h2>${w("Execution steps","执行步骤")}</h2>
        ${row ? `<div class="outline-actions">${Number.isInteger(focus) ? `<button type="button" data-jump-record="${focus}" class="focus-link">${h(focusText)}<span aria-hidden="true"> ↗</span></button>` : ""}
        <button type="button" data-directory-open aria-haspopup="dialog">${icon("list")}${w("Index","目录")}</button></div>` : ""}</div>
        ${inlineOutline(outline,rows,selected,w,run.actionTimingOnly)}</section>` : ""}
        ${row ? `<section id="report-evidence" data-step="${selected}" data-loading="${w("Reading evidence…","正在读取证据…")}" aria-label="${w("Step evidence","步骤证据")}" aria-live="polite">
        ${renderEvidence(row,{loading:true},language)}</section>${directory(outline.groups,w)}${lightbox(w)}` :
            `<p class="report-empty">${w("There are no step receipts for this run.","这次运行没有归档步骤回执。")}${run.error && run.error!==result.detail ? " "+h(run.error) : ""}</p>`}
        ${chart ? `<details class="report-raw profile"><summary>${w("Timing by execution record","逐条执行记录耗时")}</summary>${chart}</details>` : ""}
        ${run.cleanup && run.cleanup!=="detached" ? `<p class="report-note">${w("Cleanup","清理")} · ${h(status(run.cleanup,w))}</p>` : ""}
        ${testPhases(run.pytest,w)}${relatedRuns}</div>`;
}

function compare(row,w) {
    if (row.expected===undefined && row.actual===undefined) return "";
    // The authored description already marks protected assertions. Keep their evidence masked as well.
    const masked = row.title?.includes("••••");
    const expected = masked ? "••••" : display(row.expected), actual = masked ? "••••" : display(row.actual);
    const withCode = /^(\S[^\r\n]*?)\s+([1-5]\d{2})(?:\s+([^\r\n]*))?$/u;
    const left = expected.match(withCode), right = actual.match(withCode);
    const shared = left && right && left[1]===right[1];
    const cell = (label,value,match) => field(label,shared ?
        `<strong class="result-number">${h(match[2])}</strong>${match[3] ? `<span class="result-copy">${h(match[3])}</span>` : ""}` :
        `<strong class="result-text">${h(value)}</strong>`);
    return `<div class="comparison"><h3>${h(shared ? left[1] : w("Assertion comparison","断言对比"))}</h3>
        <dl class="values" data-tone="${tone(row)}">${cell(w("Expected","预期"),expected,left)}
        ${cell(w("Observed","实际"),actual,right)}</dl></div>`;
}

function screenshot(row,{image,crop,loading},w) {
    if (loading || !image) return !loading && row.screenshot ? `<p class="report-label">${w("Saved screenshot unavailable","已保存的截图不可用")}</p>` : "";
    const label = row.isBlocking ? w("Failure screenshot","失败现场") : w("Device screenshot","设备画面");
    return `<figure class="report-image"${crop ? ` data-crop="${h(JSON.stringify(crop))}"` : ""}>
        <figcaption><span class="figure-title">${icon("frame")}${label}</span><button type="button" class="image-toggle" aria-haspopup="dialog">${w("View original","查看原图")}${icon("expand")}</button></figcaption>
        <div class="image-mat"><div class="report-screen"><img alt="${label}" src="${h(image)}">${crop ? '<span class="screen-highlight" aria-hidden="true"></span>' : ""}</div></div>
        <div class="photo-caption"><span>${w("Device capture","设备截图")}<span class="crop-caption" hidden> · ${w("Assertion region","断言区域")}</span></span>
        ${row.screenshotAt && /\d{2}:\d{2}:\d{2}/.test(row.screenshotAt) ? `<time datetime="${h(row.screenshotAt)}">${h(new Date(row.screenshotAt).toLocaleTimeString(w("en-GB","zh-CN"),{hour12:false}))}</time>` : ""}</div></figure>`;
}

function networkEvidence({requests,logs,networkUnavailable,runId,gatewayIssue},w) {
    if (!requests) return "";
    if (networkUnavailable) return `<section class="requests"><h3>${w("Network requests","关联请求")}</h3><p class="report-label">${w("Saved network data could not be read.","已保存的网络记录暂不可用。")}</p></section>`;
    const labels = {fixture:["Fixture service","模拟服务"],gateway:["Test gateway","测试网关"],har:["HAR","HAR"],arkweb:["ArkWeb","ArkWeb"],device:["Device capture","设备采集"]};
    const requestRow = request => {
        const issue = gatewayIssue(request);
        const source = Object.hasOwn(labels,request.source) ? w(...labels[request.source]) : w("Recorded request","已记录请求");
        const upstream = Number.isInteger(request.originalResponse?.status) ? w(`Upstream ${request.originalResponse.status}`,`上游 ${request.originalResponse.status}`) : "";
        const missingResponse = issue==="UPSTREAM_FAILED" && !Number.isInteger(request.originalResponse?.status);
        const notes = [source,issue,upstream,request.caseRunId!==runId && w("Time overlap only","同期记录")].filter(Boolean);
        return `<li class="request-item"><div class="request-line"><span class="method">${h(request.method || "HTTP")}</span>
            <code>${h(String(request.path || "").split(/[?#]/,1)[0])}</code><strong class="http-status" data-fault="${request.status>=400 && request.source!=="fixture"}">${h(request.status || "—")}</strong></div>
            <div class="request-note">${h(notes.join(" · "))}${missingResponse ? `<span>${w("No upstream HTTP response recorded","未记录到上游 HTTP 响应")}</span>` : ""}</div></li>`;
    };
    const entries = requests.length ? `<ul>${requests.slice(0,4).map(requestRow).join("")}</ul>` :
        `<p class="report-label">${w("No saved requests in this step’s time range.","此步骤时段没有保存的请求。")}</p>`;
    const extra = requests.length>4 ? `<details class="report-raw"><summary>${w("More requests","更多请求")} <b>${requests.length-4}</b></summary>
        <ul>${requests.slice(4).map(requestRow).join("")}</ul></details>` : "";
    const relatedLogs = logs?.length ? `<details class="report-raw"><summary>${w("Related network logs","同期网络日志")} <b>${logs.length}</b></summary><ul>${logs.map(log=>
        `<li><code>${h(safeValue("",log.message || log.text || log.kind || log.event))}</code>${log.caseRunId!==runId ? ` <small>${w("Time overlap only","同期记录")}</small>` : ""}</li>`).join("")}</ul></details>` : "";
    const scope = requests.length && requests.every(request=>request.caseRunId===runId) ? w("This run · step time range","同次运行 · 此步骤时段") : w("Step time range","此步骤时段");
    return `<section class="requests"><header><h3>${w("Network requests","关联请求")}</h3><small>${scope}</small></header>${entries}${extra}${relatedLogs}</section>`;
}

function renderEvidence(row,evidence,language) {
    const w = words(language);
    const label = row.firstBlocking ? w("First blocking step","首个阻断步骤") : row.isBlocking ? w("Blocking step","阻断步骤") : rowStatus(row,w);
    const duration = seconds(row.elapsedMs,w);
    const authored = row.businessNumber;
    const header = `<header class="evidence-heading visually-hidden"><span>${h(label)} ${authored ? w("Case step ","用例步骤 ")+h(authored) : ""} ${h(duration)}</span><h2>${h(row.title)}</h2></header>`;
    const dispatched = row.dispatched==="acknowledged" ? w("acknowledged","已确认") : row.dispatched==="no" ? w("not sent","未发送") :
        row.dispatched ? status(row.dispatched,w) : "";
    const action = Object.hasOwn(commands,row.command) ? w(...commands[row.command]) : row.command || w("Gesture","手势");
    const deviceAction = row.actionTarget ? w(`${action} “${row.actionTarget}”`,`${action}「${row.actionTarget}」`) : action;
    const assertion = row.assertionStatus || row.errorCode==="ASSERTION_TIMEOUT";
    const evidenceLabel = row.condition ? w("Condition","条件") : assertion ? w("Assertion","断言") : w("Error","错误");
    const facts = [row.dispatched ? field(w("Device action","设备动作"),`${h(deviceAction)} <span class="fact-note">${h(dispatched)}</span>`) : "",
        row.actionTiming ? field(w("Step duration","步骤总耗时"),h(durationLabel(row.elapsedMs,w))) : "",
        Number.isFinite(row.actionTiming?.elapsedMs) ? field(w("Action time","动作耗时"),h(durationLabel(row.actionTiming.elapsedMs,w))) : "",
        assertion || row.errorCode || row.condition ? field(evidenceLabel,`${h(row.errorCode==="ASSERTION_TIMEOUT" ? w("Timed out","超时") : rowStatus(row,w))}`+
            (row.errorCode ? ` <code class="fact-note">${h(row.errorCode)}</code>` : "")) : ""].filter(Boolean);
    const picture = screenshot(row,evidence,w);
    const tree = evidence.loading ? "" : ["before","after"].filter(phase=>row[phase]).map(phase=>`<details class="report-raw" data-frame="${phase}">
        <summary>${phase==="before" ? w("UI tree before action","动作前控件树") : w("UI tree after action","动作后控件树")}</summary>
        <div data-tree>${w("Reading archived UI tree…","正在读取归档控件树…")}</div></details>`).join("");
    const diagnostic = row.error ? `<details class="report-raw"><summary>${w("Error details","错误详情")}</summary><p>${h(row.error)}</p></details>` : "";
    const details = [compare(row,w),facts.length ? `<dl class="report-facts">${facts.join("")}</dl>` : "",networkEvidence(evidence,w)].join("");
    return header+(!details && !picture && !tree && !diagnostic ? `<p class="report-label">${evidence.loading ? w("Reading evidence…","正在读取证据…") : w("This receipt has no additional evidence.","这条执行记录没有其他归档证据。")}</p>` : "")+`<div class="evidence-spread${evidence.image && details ? " with-image" : ""}">${details ? `<div class="evidence-reading">${details}</div>` : ""}${picture}</div>
        ${tree || diagnostic ? `<section class="appendix"><h3>${w("Technical details","技术明细")}</h3>${tree}${diagnostic}</section>` : ""}`;
}

function renderTree(frame,language) {
    const w = words(language);
    if (!Array.isArray(frame?.nodes)) return `<p class="report-label">${w("Archived UI tree unavailable","归档控件树不可用")}</p>`;
    const nodes = frame.nodes.map(({ref,parent,type,id,text,description,bounds})=>({ref,parent,type,id,text,description,bounds}));
    return `<p class="report-label">${h(time(frame.capturedAt,language))} · ${nodes.length} ${w("nodes","个控件")}</p><pre>${h(JSON.stringify(nodes,null,2))}</pre>`;
}

function reportDocument(webview,resource,language,title,body,interactive) {
    return `<!doctype html><html lang="${h(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src data:;">
    <link rel="stylesheet" href="${h(resource("ui/disclosure.css"))}"><link rel="stylesheet" href="${h(resource("caseRunReport.css"))}"><title>${h(title)}</title></head><body><main class="run-report">${body}</main>
    ${interactive ? `<script src="${h(resource("caseRunReport.js"))}"></script>` : ""}</body></html>`;
}

function standaloneReportDocument(language,title,body,templates,{css,js,nonce}) {
    return `<!doctype html><html lang="${h(language)}" data-archived-report><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
    <title>${h(title)}</title><style>${css}</style></head><body><main class="run-report">${body}</main>${templates}
    <script nonce="${nonce}">${js}</script></body></html>`;
}

module.exports = { words, renderReport, renderEvidence, renderTree, reportDocument, standaloneReportDocument };
