"use strict";

const sources = {
    fixture:["Fixture service","模拟服务"],gateway:["Test gateway","测试网关"],har:["HAR","HAR"],
    device:["Device capture","设备采集"],arkweb:["ArkWeb","ArkWeb"],other:["Other","其他来源"],unknown:["Unspecified source","来源未记录"],
};
const stages = {
    capture:["Device state capture","设备状态采集"],preflight:["Preflight checks","运行前检查"],
    normalize:["State normalization","状态整理"],statePersistence:["State storage","状态保存"],
    evidencePersistence:["Evidence storage","证据保存"],projection:["UI projection","界面投影"],
};
const actions = {
    press:["Click","点击"],fill:["Input","输入"],back:["Go back","返回"],scroll:["Scroll","滚动"],
    deviceGesture:["Device gesture","设备手势"],wait:["Wait","等待"],observe:["Observe","读取画面"],
};
const outcomeLabels = {
    completed:["completed","完成"],failed:["failed","失败"],notRun:["not run","未执行"],
    skipped:["skipped","跳过"],interrupted:["interrupted","中止或受阻"],unconfirmed:["unconfirmed","未确认"],
    outOfScope:["outside scope","范围外"],passed:["passed","通过"],unknown:["unconfirmed","未确认"],
};

function renderRunStatistics(run,rows,outline,{w,h,durationLabel,localizedState}) {
    const metrics=outline.metrics;
    if (!metrics) return "";
    const {network,execution,timing}=run.aggregates || {};
    const ms=n=>durationLabel(n,w);
    const label=(dict,key)=>Object.hasOwn(dict,key) ? w(...dict[key]) : String(key || "—");
    const annotated=(n,en,zh,singular=en)=>w(`${n} ${n===1 ? singular : en}`,`${n} ${zh}`);
    const outcomes=(counts,keys)=>keys.filter(key=>counts[key]>0).map(key=>`${counts[key]} ${label(outcomeLabels,key)}`);
    const link=(text,index,group=false)=>Number.isInteger(index) ?
        `<button type="button" class="stats-link" data-jump-${group?"group":"record"}="${index}">${h(text)} <span aria-hidden="true">↗</span></button>` : h(text);
    const stepLink=(item,group=true)=>link((item.number ? w(`Step ${item.number} · `,`第 ${item.number} 步 · `) : "")+item.title,item.index,group);
    const named=(label,html)=>`<div class="stats-fact"><dt>${h(label)}</dt><dd>${html}</dd></div>`;
    const statsRow=(id,title,summary,content)=>`<details class="stats-row" id="stats-${id}"><summary>
        <span class="stats-name">${h(title)}</span><span class="stats-summary">${summary.filter(Boolean).map(text=>`<span>${h(text)}</span>`).join("")}</span>
        <i class="fold-arrow" aria-hidden="true"></i></summary><div class="stats-content">${content}</div></details>`;
    const result=[];

    const {steps,checks,goals}=metrics;
    const checkCount=checks.passed+checks.failed+checks.unknown;
    if (steps.total || checkCount || goals.total) {
        const scope=steps.total-steps.outOfScope;
        const summary=[steps.total && (scope ? w(`${steps.executed}/${scope} in-scope steps executed`,`范围内步骤 ${steps.executed}/${scope} 已执行`) :
            annotated(steps.outOfScope,"steps outside scope","个业务步骤范围外","step outside scope")),
            checkCount && w(`${checkCount} checks · ${outcomes(checks,["passed","failed","unknown"]).join(", ")}`,
                `${checkCount} 项断言 · ${outcomes(checks,["passed","failed","unknown"]).join("、")}`),
            goals.total && (goals.outOfScope===goals.total ? annotated(goals.outOfScope,"final checks outside scope","项最终断言范围外","final check outside scope") :
                w(`Final checks ${goals.executed}/${goals.total-goals.outOfScope} executed`,`最终断言 ${goals.executed}/${goals.total-goals.outOfScope} 已执行`))];
        const stepStates=outcomes(steps,["completed","failed","notRun","skipped","interrupted","unconfirmed","outOfScope"]);
        const facts=[];
        if (stepStates.length) facts.push(named(w("Business steps","业务步骤"),h(stepStates.join(" · "))+
            (rows.length ? ` <button type="button" class="stats-link" data-directory-open>${w("Step index","步骤目录")} ↗</button>` : "")));
        const blockers=rows.filter(row=>row.firstBlocking);
        if (blockers.length) facts.push(named(w("First blocking step","首个阻断步骤"),link(blockers[0].title,blockers[0].index)));
        const goalsList=outline.goals.map(goal=>`<li>${link(goal.caption||goal.title,goal.indices[0])}<small>${h(localizedState(goal.status,w))}</small></li>`);
        if (goalsList.length) facts.push(named(w("Final checks","最终断言"),`<ul class="stats-items">${goalsList.join("")}</ul>`));
        const checked=rows.filter(row=>!row.condition && !["if","repeat","unreachedGoals"].includes(row.kind) &&
            ["passed","failed","unknown"].includes(row.assertionStatus));
        if (checked.length) facts.push(named(w("Check evidence","断言证据"),`<details class="stats-inner"><summary>${w("Show recorded checks","查看断言记录")}</summary><ul class="stats-items">${
            checked.map(row=>`<li>${link(row.title,row.index)}<small>${h(localizedState(row.assertionStatus,w))}</small></li>`).join("")}</ul></details>`));
        result.push(statsRow("coverage",w("Validation coverage","验证覆盖"),summary,`<dl>${facts.join("")}</dl>`));
    }

    if (network?.records.length) {
        const statusTitle=value=>value==null ? w("Unrecorded","未记录") : value===0 ? w("No HTTP response","无 HTTP 响应") : String(value);
        const groups=[["source",w("Source","来源"),network.sources,value=>label(sources,value)],
            ["status",w("HTTP status","响应码"),network.statuses,statusTitle],
            ["rule",w("Matched rule","命中规则"),network.rules,String]];
        const filters=groups.filter(([, ,values])=>values?.length).map(([key,title,items,format])=>
            named(title,items.map(({value,count})=>`<button type="button" class="stats-filter" data-net-by="${key}" data-net-value="${h(value)}" aria-pressed="false">${h(format(value))} <b>${count}</b></button>`).join(""))).join("");
        const requestRows=network.records.map((record,i)=>{
            const source=label(sources,record.source);
            const position=record.businessNumber ? w(`Step ${record.businessNumber}`,`第 ${record.businessNumber} 步`) : w("Step","步骤");
            return `<li data-net-source="${h(record.source)}" data-net-status="${h(record.status)}" data-net-rule="${h(record.rule||"")}">
                <span class="request-number">${i+1}</span><span><code>${h(record.method)} ${h(record.path)}</code>
                <small>${h([source,record.rule,record.issue].filter(Boolean).join(" · "))}</small></span>
                <b class="net-code">${h(statusTitle(record.status))}</b><span title="${w("Matching step time window","请求所在步骤时段")}">${Number.isInteger(record.index) ? link(position,record.index) : ""}</span></li>`;
        }).join("");
        const summaries=[annotated(network.records.length,"saved requests","条留存请求","saved request"),
            w(`Rule matches ${network.matched}`,`命中规则 ${network.matched} 次`),...network.sources.map(({value,count})=>`${label(sources,value)} ${count}`)];
        result.push(statsRow("network",w("Network and rules","网络与规则"),summaries,`<dl>${filters}</dl>
            <div class="net-results"><output data-net-count aria-live="polite">${network.records.length}</output> ${w("matching requests","条请求")}
            <button hidden type="button" class="stats-link" data-net-clear>${w("Clear filter","清除筛选")}</button></div>
            <ol class="stats-requests">${requestRows}</ol>
            ${network.historyTruncated ? `<p class="stats-note">${w("The archive has reached its retention limit. Counts cover retained requests.","网络归档已达保留上限，统计仅涵盖仍保存的请求。")}</p>` : ""}`));
    }

    if (execution) {
        const summary=[];
        if (Number.isFinite(execution.actions)) summary.push(annotated(execution.actions,"device actions","次设备操作","device action"));
        if (Number.isFinite(execution.captures)) summary.push(annotated(execution.captures,"state captures","次状态采集","state capture"));
        const loopCount=execution.loops.reduce((n,item)=>n+item.iterations,0);
        if (execution.loops.length) summary.push(annotated(loopCount,"loop iterations","轮业务循环","loop iteration"));
        if (execution.rechecked.length===1) {
            const attempts=execution.rechecked[0].attempts;
            summary.push(w(`1 check read ${attempts} times`,`1 项断言判定 ${attempts} 次`));
        } else if (execution.rechecked.length) summary.push(annotated(execution.rechecked.length,"checks polled again","项断言重复检查"));
        if (!summary.length && execution.receipts>0) summary.push(annotated(execution.receipts,"execution records","条执行记录","execution record"));
        const facts=[];
        if (Number.isInteger(execution.receipts)) facts.push(named(w("Execution records","执行记录"),h(execution.receipts)));
        if (execution.actionKinds.length) facts.push(named(w("Device actions","设备操作"),execution.actionKinds.map(item=>{
            const action=label(actions,item.command);
            return `<details class="stats-inner"><summary>${h(action)} · ${item.count}</summary><ul class="stats-items">${item.indices.map(index=>
                `<li>${link(rows[index]?.title||action,index)}</li>`).join("")}</ul></details>`;
        }).join("")));
        if (execution.loops.length) facts.push(named(w("Business loops","业务循环"),`<ul class="stats-items">${execution.loops.map(item=>
            `<li>${stepLink(item,false)}<small>${h(annotated(item.iterations,"iterations","轮","iteration"))}${item.conditionMet ? w(" · exit condition met"," · 达到退出条件") : ""}</small></li>`).join("")}</ul>`));
        if (execution.rechecked.length) facts.push(named(w("Repeated check reads","断言重复检查"),`<ul class="stats-items">${execution.rechecked.map(item=>
            `<li>${link(item.title,item.index)}<small>${h(annotated(item.attempts,"reads","次判定"))} · ${h(localizedState(item.status,w))}</small></li>`).join("")}</ul>`));
        if (summary.length) result.push(statsRow("execution",w("Actions and retries","执行与重试"),summary,`<dl>${facts.join("")}</dl>`));
    }

    const top=timing?.topSteps || (metrics.slowest ? [metrics.slowest] : []);
    if (top.length || timing?.stages.length || Number.isFinite(timing?.actionMs)) {
        const summary=[];
        const facts=[];
        if (top.length) {
            const sum=timing?.topMs ?? top[0].elapsedMs;
            const longest=run.actionTimingOnly ? w("Longest timed action","已计时动作中最长") :
                metrics.timedSteps<steps.executed ? w("Longest fully timed step","完整计时中最长") : w("Longest step","最耗时步骤");
            const rank=top.length===1 ? longest : metrics.timedSteps<steps.executed ?
                w(`Top ${top.length} fully timed steps`,`完整计时中最慢 ${top.length} 步`) : w(`Top ${top.length} steps`,`最慢 ${top.length} 步`);
            const share=Number.isFinite(timing?.topShare) ? w(` (${Math.round(timing.topShare*100)}% of run)`,`（占整次运行 ${Math.round(timing.topShare*100)}%）`) : "";
            summary.push(rank+" "+ms(sum)+share);
            facts.push(named(longest,`<ol class="stats-ranking">${top.map(item=>`<li>${stepLink(item)}<b>${h(ms(item.elapsedMs))}</b></li>`).join("")}</ol>`));
        }
        if (timing?.stages.length) {
            const sorted=[...timing.stages].sort((a,b)=>b.elapsedMs-a.elapsedMs);
            summary.push(label(stages,sorted[0].name)+" "+ms(sorted[0].elapsedMs));
            facts.push(named(w("Runtime stages","运行阶段"),`<ul class="stats-items">${sorted.map(item=>`<li><span>${h(label(stages,item.name))}</span><b>${h(ms(item.elapsedMs))}</b></li>`).join("")}</ul>`));
        }
        if (Number.isFinite(timing?.actionMs)) facts.push(named(w("Recorded action time","已计时动作合计"),h(ms(timing.actionMs))));
        const note=timing?.stages.length ? `<p class="stats-note">${w("Stage timings can overlap. Each is measured independently.","运行阶段可能重叠，各项分别计时。")}</p>` : "";
        result.push(statsRow("timing",w("Duration breakdown","耗时构成"),summary,`<dl>${facts.join("")}</dl>${note}`));
    }
    return result.length ? `<section class="run-statistics" aria-labelledby="run-stats-title"><h2 id="run-stats-title">${w("Run statistics","运行统计")}</h2>${result.join("")}</section>` : "";
}

module.exports={renderRunStatistics};
