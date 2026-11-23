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
    reviewCase: ["Review the case steps or expected result", "核对用例步骤或预期结果"],
    insufficientEvidence: ["Gather more evidence before editing", "补足证据后再决定是否修改"],
};

export function failureView(review, runId, language, { stepTitle, ai, aiOutput, stop, disabled } = {}) {
    if (!review) return "";
    const w = (en, zh) => /^zh/i.test(language) ? zh : en;
    const [name, cn, next, nextCn] = guidance[review.kind] || guidance.unknown;
    const recommendation = recommendations[ai?.recommendation];
    const phases = {collection:w("Collection","收集用例"),setup:w("Setup","测试准备"),teardown:w("Teardown","测试清理"),pytest:"pytest"};
    const context = [stepTitle || phases[review.phase], review.code].filter(Boolean).join(" · ");
    const button = (label,type,attrs,primary=false) => actionButton(label,{primary,quiet:!primary,disabled,attrs:{"data-type":type,...attrs}});
    return `<section class="case-failure" aria-labelledby="case-failure-title"><header>
        <h2 id="case-failure-title">${w("Failure review","失败排查")}</h2><strong>${h(w(name,cn))}</strong></header>
        ${context ? `<p class="case-failure-context">${h(context)}</p>` : ""}
        <p>${h(w(next,nextCn))}</p>
        <div class="toolbar">${button(w("Diagnose failure with AI","用 AI 诊断失败"),"diagnoseFailure",{"data-id":runId},true)}
        ${review.index !== undefined ? button(w("View failing step","查看失败步骤"),"showFailureStep",{"data-index":review.index}) : ""}${stop || ""}</div>
        ${recommendation ? `<p class="case-recommendation"><strong>${w("AI recommendation","AI 建议")}</strong> · ${h(w(...recommendation))}</p>` : ""}
        ${aiOutput || ""}</section>`;
}
