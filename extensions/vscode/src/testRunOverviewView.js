"use strict";

const {words}=require("./caseRunReportView");
const {createHash}=require("node:crypto");
const fs=require("node:fs/promises");
const path=require("node:path");
const escape=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const statuses={passed:["Passed","通过"],failed:["Failed","失败"],completed:["Completed","完成"],skipped:["Skipped","跳过"],
    blocked:["Blocked","受阻"],cancelled:["Cancelled","取消"],running:["Running","运行中"],unknown:["Unconfirmed","未确认"],
    rejected:["Not started","未启动"],error:["Error","错误"],budget_exhausted:["Limit reached","达到上限"],yielded:["Paused","暂停"]};
const changes={recovered:["Recovered","恢复通过"],regressed:["New failure","新增失败"],persistent:["Still failing","持续失败"],
    mixed:["Mixed results","通过与失败交替"],steady:["Stable outcome","结果持平"],insufficient:["No comparable pair","可比记录不足"]};
const errorNames={ASSERTION_TIMEOUT:["Assertion timed out","断言超时"],TARGET_NOT_FOUND:["Target not found","未找到目标控件"],
    AMBIGUOUS_TARGET:["Ambiguous target","命中多个控件"],TARGET_NOT_ACTIONABLE:["Target not actionable","控件不可操作"]};
const textFor=(map,key,w)=>Object.hasOwn(map,key)?w(...map[key]):key;
const scopeName=(entry,w)=>entry.repairTarget?w("Targeted trial","定点试跑"):entry.repairOf?w("Full repair trial","整例修复验证"):
    entry.compositionTrial?w("Draft verification","草稿验证"):w("Case run","独立运行");
const duration=(ms,w)=>!Number.isFinite(ms) ? "—" : ms<1000 ? Math.round(ms)+w(" ms"," 毫秒") : (ms/1000).toFixed(2)+w(" s"," 秒");
const when=(time,lang)=>{
    const date=new Date(time);
    return time && Number.isFinite(date.getTime()) ? date.toLocaleString(lang,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "—";
};
const percent=(count,total)=>total ? Math.round(100*count/total)+"%" : "—";
const scopes={recent:["Last 10 records","最近 10 条"],month:["Last 30 days","最近 30 天"],
    all:["All retained records","全部留存记录"],custom:["Selected runs","自选运行"]};

function drill(label,ids,caption=label,className="",subtitle="") {
    if (!ids.length) return escape(label);
    return `<button type="button" class="drill ${className}" data-ids="${escape(JSON.stringify(ids))}" data-caption="${escape(caption)}">${escape(label)}${subtitle ? `<small>${escape(subtitle)}</small>` : ""}</button>`;
}

function choiceList(entries,lang) {
    const w=words(lang);
    return entries.map(entry=>`<label class="pick-choice"><input type="checkbox" value="${escape(entry.id)}">
        <span><b>${escape(entry.plan?.name||w("Unnamed case","未命名用例"))}</b><small>${escape(when(entry.time,lang))} · ${escape(scopeName(entry,w))} · ${escape(textFor(statuses,entry.status,w))}</small></span></label>`).join("") ||
        `<p class="empty">${w("No saved runs.","暂无运行记录。")}</p>`;
}

function overviewDocument(csp,resource,lang) {
    const w=words(lang);
    return `<!doctype html><html lang="${escape(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(csp)}; script-src ${escape(csp)};">
        <link rel="stylesheet" href="${escape(resource("ui/disclosure.css"))}"><link rel="stylesheet" href="${escape(resource("caseRunReport.css"))}"><link rel="stylesheet" href="${escape(resource("testRunOverview.css"))}">
        <title>${w("Run overview","运行总览")}</title></head><body><main class="overview-page">
        <header class="overview-head"><div><p class="breadcrumb">${w("Tests / Reports","测试 / 报告")}</p><h1>${w("Run overview","运行总览")}</h1></div>
        <div class="scope-tools"><label for="range">${w("Scope","统计范围")}</label><select id="range">
        ${Object.entries(scopes).map(([value,label])=>`<option value="${value}">${w(...label)}</option>`).join("")}</select>
        <button id="edit-selection" type="button" hidden>${w("Edit selection","更改选择")}</button>
        <button id="export-overview" class="report-export" type="button" disabled title="${w("Export all records in the current scope","导出当前统计范围内的全部记录")}">${w("Export HTML","导出 HTML")}</button></div></header>
        <div id="overview-content" aria-busy="true"><p role="status" class="empty">${w("Reading run history…","正在读取运行历史…")}</p></div>
        <dialog id="scope-dialog" aria-labelledby="pick-heading"><header><h2 id="pick-heading">${w("Select runs","选择统计的运行")}</h2>
        <button type="button" id="pick-all">${w("Select all","全选")}</button><button type="button" id="pick-none">${w("Clear","清空")}</button></header>
        <div id="pick-options"></div><footer><span id="pick-count" aria-live="polite"></span><button type="button" id="pick-cancel">${w("Cancel","取消")}</button>
        <button type="button" id="pick-apply">${w("View statistics","查看统计")}</button></footer></dialog>
        </main><script src="${escape(resource("testRunOverview.js"))}"></script></body></html>`;
}

function groupTable(rows,missing,w) {
    return `<table class="numbers"><thead><tr><th>${w("Group","分组")}</th><th>${w("Runs","运行")}</th><th>${w("Pass rate","通过率")}</th></tr></thead>
        <tbody>${rows.map(group=>{
            const label=group.name||missing;
            return `<tr><th>${drill(label,group.ids,label)}</th><td>${group.ids.length}</td><td>${percent(group.passed,group.decided)}</td></tr>`;
        }).join("")}</tbody></table>`;
}

function overviewContent(data,entries,lang,exported=false) {
    const w=words(lang),byId=new Map(entries.map(e=>[e.id,e]));
    if (!data.total) return `<p class="empty">${w("No saved runs in this scope.","这个范围内没有运行记录。")}</p>`;
    const {independentIds,outcomes,passRate,trials}=data;
    const verifications=[...trials.fullRepair,...trials.targeted,...trials.composition];
    const chips=Object.entries(outcomes).filter(([,ids])=>ids.length).map(([key,ids])=>{
        const label=textFor(statuses,key,w);
        return drill(label+" "+ids.length,ids,label,"outcome "+(key==="failed"?"bad":key==="passed"?"good":""));
    }).join("");
    const trialsLine=[ [trials.fullRepair,w("Full repair trials","整例修复验证")],[trials.targeted,w("Targeted trials","定点试跑")],[trials.composition,w("Draft checks","草稿验证")] ]
        .filter(([ids])=>ids.length).map(([ids,label])=>drill(label+" "+ids.length,ids,label)).join("");
    const recovered=data.repairs.filter(chain=>chain.fullPassedIds.length).length;
    const verified=data.repairs.filter(chain=>chain.targetedPassedIds.length).length;
    const repairSummary=[recovered && w(`${recovered} originals passed full verification`,`${recovered} 项原失败整例复验通过`),
        verified && w(`${verified} originals passed targeted verification`,`${verified} 项原失败定点验证通过`)].filter(Boolean).join(" · ");
    const stats=`<section class="overview-metrics" aria-label="${w("Run results","运行结果")}"><div><h2>${w("Independent runs","独立运行")}</h2>
        <strong>${drill(independentIds.length,independentIds,w("Independent runs","独立运行"))}</strong><small>${escape(w(`Across ${data.caseCount} cases`,`涉及 ${data.caseCount} 个用例`))}</small></div>
        <div><h2>${w("Run pass rate","独立运行通过率")}</h2><strong>${drill(percent(passRate.passed,passRate.decided),[...outcomes.passed,...outcomes.failed],w("Decided independent runs","已判定的独立运行"))}</strong><small>${escape(w(`${passRate.passed} passed / ${passRate.decided} decided`,`${passRate.passed} 通过 / ${passRate.decided} 次已判定`))}</small></div>
        <div><h2>${w("Verification runs","试跑与验证")}</h2><strong>${drill(verifications.length,verifications,w("Verification runs","试跑与验证"))}</strong>
        <small>${escape(repairSummary||w("Counted separately","单独计数"))}</small></div></section>
        ${chips||trialsLine ? `<div class="counts-line">${chips}${trialsLine}</div>` : ""}`;
    const errors=data.failures.map(failure=>{
        const code=failure.code||w("No archived error code","未记录错误码");
        const title=Object.hasOwn(errorNames,code) ? w(...errorNames[code]) : code;
        return `<tr><th>${drill(title,failure.ids,code,"",title!==code ? code : "")}</th><td>${drill(failure.ids.length,failure.ids,code)}</td><td>${failure.caseCount}</td></tr>`;
    }).join("");
    const distribution=data.devices.length ? groupTable(data.devices,w("Device not recorded","未记录设备"),w) : "";
    const failurePanel=`<section><h2>${w("Failure clusters","失败聚类")}</h2>${errors ? `<table class="numbers"><thead><tr><th>${w("Error code","错误类型")}</th><th>${w("Failures","失败次数")}</th><th>${w("Cases affected","受影响用例")}</th></tr></thead><tbody>${errors}</tbody></table>` :
        `<p class="empty">${w("No independent run failures in this scope.","这个范围内没有独立运行失败。")}</p>`}</section>`;
    const spread=`<div class="breakdowns">${failurePanel}<section><h2>${w("By device","设备分布")}</h2>${distribution||`<p class="empty">${w("No independent runs.","暂无独立运行。")}</p>`}
        ${data.cases?.length ? `<details><summary>${w("Group by case","按用例查看")}</summary>${groupTable(data.cases,w("Unknown case","未知用例"),w)}</details>` : ""}</section></div>`;
    const trendRows=data.trends.map(trend=>{
        const kind=textFor(changes,trend.kind,w),title=trend.caseName||w("Unnamed case","未命名用例");
        const timing=trend.duration;
        const delta=timing ? (timing.deltaMs>0?"+":timing.deltaMs<0?"−":"")+duration(Math.abs(timing.deltaMs),w) : "—";
        return `<tr><th>${drill(title,trend.ids,title)}</th><td>${escape(kind)}${trend.mixed ? `<small>${w("Repeated status changes","多次结果切换")}</small>` : ""}</td><td${timing ? ` title="${escape(duration(timing.previousMs,w)+" → "+duration(timing.currentMs,w))}"` : ""}>${escape(delta)}</td></tr>`;
    }).join("");
    const repairRows=data.repairs.map(chain=>{
        const root=byId.get(chain.originalId),ids=[chain.originalId,...chain.trialIds].filter(id=>byId.has(id));
        const label=root ? when(root.time,lang)+" · "+(root.plan?.name||w("Case","用例")) : w("Original outside scope","原运行在范围外");
        const result=chain.fullPassedIds.length ? w("Full trial passed","整例验证通过") : chain.targetedPassedIds.length ? w("Target verified","定点验证通过") : w("No verified recovery","尚无已验证恢复");
        return `<tr><th>${drill(label,ids,label)}</th><td>${chain.trialIds.length}</td><td>${result}</td></tr>`;
    }).join("");
    const slow=data.slowest.slice(0,3).map(run=>{
        const name=run.caseName||w("Case","用例"),stamp=when(byId.get(run.id)?.time,lang);
        return `<li>${drill(name,[run.id],name+" · "+stamp,"",stamp)}<span>${escape(duration(run.durationMs,w))}</span></li>`;
    }).join("");
    const history=`<div class="breakdowns"><section><h2>${w("Case trends","用例趋势")}</h2>${trendRows ? `<table class="numbers"><thead><tr><th>${w("Case","用例")}</th><th>${w("Latest transition","最近变化")}</th><th>${w("Time change","耗时变化")}</th></tr></thead><tbody>${trendRows}</tbody></table>
        <p class="hint">${w("Compares recorded runs of the same case, device, runner and plan.","按相同用例、设备、执行器和计划比较范围内的记录。")}</p>` : `<p class="empty">${w("No comparable case results.","暂无可比较的用例结果。")}</p>`}
        ${repairRows ? `<details><summary>${w("Repair verification history","修复验证经过")}</summary><table class="numbers"><thead><tr><th>${w("Original run","原运行")}</th><th>${w("Trials","试跑")}</th><th>${w("Outcome","验证结果")}</th></tr></thead><tbody>${repairRows}</tbody></table></details>` : ""}</section>
        <section><h2>${w("Slowest runs","耗时最长的运行")}</h2>${slow ? `<ol class="slowest">${slow}</ol><p class="hint">${escape(w(`${data.timedCount} timed independent runs`,`${data.timedCount} 次独立运行有计时`))}</p>` :
        `<p class="empty">${w("No recorded durations.","暂无归档耗时。")}</p>`}</section></div>`;
    const records=entries.map(entry=>{
        const name=entry.plan?.name||w("Unnamed case","未命名用例"),state=textFor(statuses,entry.status,w);
        const open=exported ? '<div class="record-row">' :
            `<button class="record-row" type="button" data-open-run="${escape(entry.id)}" ${entry.status==="running"?"disabled":""}>`;
        return `<li data-record-id="${escape(entry.id)}">${open}
            <span class="run-name">${escape(name)}<small>${escape(when(entry.time,lang))} · ${escape(scopeName(entry,w))}</small></span>
            <span class="run-state" data-tone="${entry.status==="failed"?"error":entry.status==="passed"?"ok":"neutral"}">${escape(state)}</span>
            ${exported ? "</div>" : '<span aria-hidden="true">›</span></button>'}</li>`;
    }).join("");
    return `${stats}${spread}${history}<section class="overview-records" aria-labelledby="list-heading"><header><h2 id="list-heading" tabindex="-1">${w("Run records","运行记录")} <span id="record-count">${entries.length}</span></h2>
        <button id="clear-drill" hidden type="button">${w("View all in scope","显示范围内全部记录")}</button></header><p id="drill-caption" hidden></p>
        <ul>${records}</ul></section>`;
}

async function overviewExportDocument({data,entries,lang,scope,asOf}) {
    const w=words(lang);
    const asset=name=>fs.readFile(path.join(__dirname,"..","media",name),"utf8");
    const [disclosures,base,layout,client]=await Promise.all([asset("ui/disclosure.css"),asset("caseRunReport.css"),asset("testRunOverview.css"),asset("testRunOverview.js")]);
    // HTML parsers normalize CRLF before checking an inline script's digest.
    const script=client.replace(/\r\n?/g,"\n");
    const digest=createHash("sha256").update(script).digest("base64");
    return `<!doctype html><html lang="${escape(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${digest}'; base-uri 'none'; form-action 'none'">
        <title>${w("Run overview","运行总览")}</title><style>${disclosures}\n${base}\n${layout}</style></head><body data-exported><main class="overview-page">
        <header class="overview-head"><div><p class="breadcrumb">${w("Tests / Reports","测试 / 报告")}</p><h1>${w("Run overview","运行总览")}</h1></div>
        <p class="snapshot-meta"><b>${w(...scopes[scope])} · ${w(`${entries.length} records`,`${entries.length} 条记录`)}</b>
        <time datetime="${asOf.toISOString()}">${escape(asOf.toLocaleString(lang))}</time></p></header>
        <div id="overview-content">${overviewContent(data,entries,lang,true)}</div></main><script>${script}</script></body></html>`;
}

module.exports={overviewContent,overviewDocument,overviewExportDocument,choiceList};
