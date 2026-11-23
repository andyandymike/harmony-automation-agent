import {escapeHtml as html} from "./ui/controls.js";

export function repairView(model, language, button) {
    const run = model.run, entry = run.entry, step = run.steps?.[run.selected];
    const w = (en,zh) => /^zh/i.test(language) ? zh : en;
    const control = (label,type,id,off=false) => button(label,type,{attrs:{"data-id":id},off});
    const state = model.repair;
    const original = state?.id === entry.id && state.index === run.selected;
    const trial = state?.trial === entry.id;
    if (!original && !trial) {
        if (entry.repairOf) return control(w("Open original failure","查看原失败报告"),"report",entry.repairOf);
        if (!step?.locatorFailure || !entry.sourceDigest || !(step.before || step.after)) return "";
        return control(w("Find a replacement locator with AI","用 AI 寻找替代定位器"),"repairSuggest",entry.id);
    }
    const change = `<dl><dt>${w("Original locator","原定位器")}</dt><dd><code>${html(JSON.stringify(state.old))}</code></dd>
        <dt>${w("Suggested locator","建议定位器")}</dt><dd><code>${html(JSON.stringify(state.proposed))}</code> · ${html(state.label)}</dd></dl>`;
    const canVerify = Boolean(model.devices.includes(model.device) || entry.source === "pytest");
    const verify = state.stage === "proposed" || state.stage === "failed";
    let actions = "";
    if (original && verify) actions += control(w("Run a copy with this change","用副本验证修复"),"repairVerify",state.id,!canVerify);
    if (trial && state.stage === "verified") actions += control(w("Apply verified change","应用已验证的修改"),"repairApply",state.trial);
    if (trial) actions += control(w("Open original failure","查看原失败报告"),"report",state.id);
    else if (state.trial) actions += control(w("View verification report","查看验证报告"),"report",state.trial);
    const message = state.stage === "applied" ? w("Verified locator saved.","已保存验证通过的定位器。") :
        state.stage === "verified" ? w("The copy passed the original final checks.","副本已通过原用例的最终断言。") :
        state.stage === "failed" ? w("Verification did not pass. See the trial report.","副本验证未通过，详情见验证报告。") :
        w("The candidate uniquely matched the saved page. Return the device to the starting screen to verify.","候选控件在失败页面唯一匹配。将手机置于用例起始页后，可运行副本验证。");
    return `<section class="plan-preview"><h2>${w("Locator repair","定位器修复")}</h2><code>${html(state.path)}</code>${change}
        <p role="status">${message}</p><div class="toolbar">${actions}</div></section>`;
}
