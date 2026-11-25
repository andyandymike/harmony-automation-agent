import {actionButton, escapeHtml as h} from "./ui/controls.js";

const guidance = {
    environment: ["Device or connection failure", "设备或连接异常",
        "Restore the device connection or tool, then run the same case again.", "先恢复设备连接或执行工具，再重跑原用例。"],
    runner: ["pytest failed outside a case step", "pytest 在用例步骤之外失败",
        "Check the failed pytest phase and its fixture or configuration before changing any steps.", "先查看 pytest 失败阶段，核对 fixture 或运行配置。"],
    locator: ["Locator did not resolve", "定位器匹配失败",
        "Check that the run reached the intended page. If the same control has a new locator, verify a replacement on a copy of this case.",
        "先核对是否到达预期页面。如果同一个控件的定位方式变了，再用副本验证替代定位器。"],
    page: ["Page or starting state did not match", "页面状态不符合步骤要求",
        "Check the preceding step and the starting state. Review the steps if the intended navigation has changed.",
        "先核对前一步和起始状态。确认页面流程已经变更，再检查用例步骤。"],
    assertion: ["Assertion failed", "断言失败",
        "Compare the expected and observed results. Confirm the intended behavior before changing the assertion.",
        "先对照预期和实际结果，确认业务预期是否变化，再决定是否改断言。"],
    unknown: ["Cause unconfirmed", "失败原因待确认",
        "Use the saved screen and execution log to check what happened before deciding whether to change the case.",
        "先对照运行画面和日志，确认这一步实际发生了什么，再决定是否修改用例。"],
};
const unavailable = {
    sourceChanged: ["The workflow was edited after this run. Diagnose a run of the current version to prepare an edit.", "运行后用例已有变更。运行当前版本后，可按新的失败证据生成修改。"],
    sourceUnavailable: ["The workflow used by this run could not be read.", "无法读取这次执行使用的流程文件。"],
    groupChanged: ["The bound rule group differs from the one used in this run.", "当前绑定的规则组与这次执行时不同。"],
    missingPage: ["A complete control tree is needed to prepare the edit.", "需要完整的页面控件树才能生成修改。"],
    noMatch: ["No usable replacement was found on the observed page.", "在已读取的页面上没找到可用的替代控件。"],
    composed: ["Review the failing step in the case editor. If it belongs to a reference, open that source or convert the reference to local steps.",
        "请在用例编辑器核对失败步骤。若失败发生在引用内，可以打开来源，或将引用转为本地步骤。"],
};

export function failureView(review, runId, language, {stepTitle, expected, actual, ai, aiOutput, stop, disabled, repair,
    repairKind, runner, canReadLive, evidence, request, manualEdit} = {}) {
    if (!review) return "";
    const w = (en, zh) => /^zh/i.test(language) ? zh : en;
    const [name, cn, next, nextCn] = guidance[review.kind] || guidance.unknown;
    const phases = {collection:w("Collection","收集用例"),setup:w("Setup","测试准备"),call:w("Test","执行测试"),
        teardown:w("Teardown","测试清理"),pytest:"pytest"};
    const context = stepTitle || phases[review.phase];
    const facts = review.kind==="assertion" ? [[w("Expected","预期"),expected],[w("Actual","实际"),actual]]
        .filter(([,value])=>value!==undefined) : [];
    const button = (label,type,attrs,primary=false) => actionButton(label,{primary,quiet:!primary,disabled,attrs:{"data-type":type,...attrs}});
    const analyzed = ai?.next && ai?.answer;
    const rerun = analyzed && ai.recommendation==="keepCase" && runner;
    const live = canReadLive && analyzed && review.kind==="locator" &&
        ["reviewCase","insufficientEvidence"].includes(ai.recommendation) &&
        !["sourceChanged","sourceUnavailable","groupChanged"].includes(ai.reason);
    const analyze = primary => button(analyzed ? w("Analyze again","重新分析") : w("Analyze failure with AI","用 AI 分析失败"),
        "diagnoseFailure",{"data-id":runId},primary);
    let primary = stop || "";
    if (!repair && !primary) {
        if (rerun) primary=button(w("Rerun original case","重跑原用例"),"caseRun",{"data-from-run":true,"data-runner":runner},true);
        else if (live) primary=button(w("Use current phone screen to analyze","用手机当前画面补充分析"),
            "diagnoseFailure",{"data-id":runId,"data-phase":"live"},true);
        else primary=analyze(true);
    }
    const records = ai?.recommendation==="inspectRequest" && ai.evidence?.find(item=>item.kind==="http")?.records;
    const related = request || (records?.length===1 ? {...records[0],path:records[0].route} : undefined);
    const extra = [!stop && (repairKind==="upstream" || !repair && (rerun || live)) ? analyze(false) : "", !repair && manualEdit]
        .filter(Boolean).join("");
    const analysis = analyzed ? `<div class="case-diagnosis">
        <p><strong>${w("Finding","发现")}</strong> ${h(ai.answer)}</p>
        ${ai.fromSavedEvidence ? `<small>${w("Prepared from the saved run evidence.","根据已保存的运行证据生成。")}</small>` : ""}
        ${!repair ? `<p>${h(ai.next)}</p>` : ""}
        ${!repair && unavailable[ai.reason] ? `<small>${h(w(...unavailable[ai.reason]))}</small>` : ""}</div>` :
        !repair ? `<p>${h(w(next,nextCn))}</p>` : "";
    const relatedRequest = related ? `<p><code>${h(related.method+" "+related.path)}</code> · HTTP ${h(related.status)}</p>
        <div class="toolbar">${button(w("Open in Network","在网络调试中打开"),"networkEvidenceRecord",{"data-id":related.id})}</div>` : "";
    return `<section class="case-failure" data-disclosure-owner="${h(runId)}" aria-labelledby="case-failure-title"><header>
        <h2 id="case-failure-title">${w("Failure review","失败排查")}</h2><strong>${h(repairKind==="upstream" ?
            w("Test upstream missing","测试上游未配置") : w(name,cn))}</strong></header>
        ${context ? `<p class="case-failure-context">${h(context)}</p>` : ""}
        ${facts.length ? `<dl class="case-step-facts">${facts.map(([label,value])=>
            `<div><dt>${h(label)}</dt><dd>${h(typeof value==="string" ? value : JSON.stringify(value))}</dd></div>`).join("")}</dl>` : ""}
        ${analysis}${repair || ""}
        ${primary ? `<div class="toolbar case-failure-actions">${primary}</div>` : ""}
        ${review.code || evidence || relatedRequest ? `<details id="case-original-evidence" class="case-repair-details">
            <summary>${w("Original failure evidence","原失败证据")}</summary>
            ${review.code ? `<p><code>${h(review.code)}</code></p>` : ""}${evidence || ""}${relatedRequest}</details>` : ""}
        ${extra ? `<details id="case-failure-options" class="case-repair-details"><summary>${w("More actions","更多操作")}</summary>
            <div class="toolbar">${extra}</div></details>` : ""}
        ${aiOutput || ""}</section>`;
}
