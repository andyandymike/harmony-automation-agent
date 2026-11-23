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
const recommendations = {
    keepCase: ["Keep the case for now", "先保留原用例"],
    verifyLocator: ["Verify a replacement locator on a copy", "在副本上验证替代定位器"],
    verifyWait: ["Verify a page readiness check on a copy", "在副本上验证页面等待条件"],
    verifyNavigation: ["Verify the added navigation step on a copy", "在副本上验证新增的跳转步骤"],
    reviewCase: ["Review the case steps or expected result", "核对用例步骤或预期结果"],
    inspectRequest: ["Check the recorded request", "核对同期失败的请求"],
    insufficientEvidence: ["Gather more evidence before editing", "补足证据后再决定是否修改"],
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

export function failureView(review, runId, language, {stepTitle, ai, aiOutput, stop, disabled, repair, runner, canReadLive} = {}) {
    if (!review) return "";
    const w = (en, zh) => /^zh/i.test(language) ? zh : en;
    const [name, cn, next, nextCn] = guidance[review.kind] || guidance.unknown;
    const recommendation = recommendations[ai?.recommendation];
    const phases = {collection:w("Collection","收集用例"),setup:w("Setup","测试准备"),call:w("Test","执行测试"),
        teardown:w("Teardown","测试清理"),pytest:"pytest"};
    const context = [stepTitle || phases[review.phase], review.code].filter(Boolean).join(" · ");
    const button = (label,type,attrs,primary=false) => actionButton(label,{primary,quiet:!primary,disabled,attrs:{"data-type":type,...attrs}});
    const analyzed = ai?.next && ai?.answer;
    const rerun = analyzed && ai.recommendation==="keepCase" && runner ? button(w("Rerun original case","重跑原用例"),"caseRun",
        {"data-from-run":true,"data-runner":runner}) : "";
    const records = ai?.recommendation==="inspectRequest" && ai.evidence?.find(item=>item.kind==="http")?.records;
    const request = records?.length===1 ? button(w("Open failed request","打开失败请求")+" · "+records[0].status,
        "networkEvidenceRecord",{"data-id":records[0].id}) : "";
    const live = canReadLive && !repair && analyzed && review.kind==="locator" &&
        ["reviewCase","insufficientEvidence"].includes(ai.recommendation) &&
        !["sourceChanged","sourceUnavailable","groupChanged"].includes(ai.reason) ?
        button(w("Use current phone screen","用手机当前画面补充分析"),"diagnoseFailure",{"data-id":runId,"data-phase":"live"}) : "";
    const generate = ["environment","runner","unknown"].includes(review.kind) ? w("Diagnose failure with AI","用 AI 诊断失败") :
        w("Generate repair with AI","用 AI 生成修复方案");
    const analysis = analyzed ? `<div class="case-diagnosis">
        <p><strong>${w("Finding","发现")}</strong> ${h(ai.answer)}</p>
        ${ai.fromSavedEvidence ? `<small>${w("Prepared from the saved run evidence.","根据已保存的运行证据生成。")}</small>` : ""}
        ${!repair && recommendation ? `<p><strong>${w("Next action","下一步")}</strong> ${h(ai.next)}</p>` : ""}
        ${!repair && recommendation ? `<small>${h(w(...recommendation))}</small>` : ""}
        ${!repair && unavailable[ai.reason] ? `<small>${h(w(...unavailable[ai.reason]))}</small>` : ""}</div>` :
        `<p>${h(w(next,nextCn))}</p>`;
    return `<section class="case-failure" aria-labelledby="case-failure-title"><header>
        <h2 id="case-failure-title">${w("Failure review","失败排查")}</h2><strong>${h(w(name,cn))}</strong></header>
        ${context ? `<p class="case-failure-context">${h(context)}</p>` : ""}
        ${analysis}${repair || ""}
        <div class="toolbar">${repair ? "" : button(analyzed ? w("Analyze again","重新分析") : generate,
            "diagnoseFailure",{"data-id":runId},!analyzed)}
        ${live}${rerun}${request}${review.index !== undefined ? button(w("View failing step","查看失败步骤"),"showFailureStep",{"data-index":review.index}) : ""}${stop || ""}</div>
        ${aiOutput || ""}</section>`;
}
