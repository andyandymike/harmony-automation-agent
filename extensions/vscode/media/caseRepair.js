import {escapeHtml as html} from "./ui/controls.js";

export function repairView(model, run, language, button) {
    const entry = run.entry;
    const w = (en,zh) => /^zh/i.test(language) ? zh : en;
    const control = (label,type,id,{off=false,primary=false}={}) => button(label,type,{attrs:{"data-id":id},off,primary});
    const state = model.repair;
    const original = state?.id===entry.id;
    const trial = state?.trial===entry.id || state?.stage==="verifying" && entry.repairOf===state.id;
    if (!original && !trial) return entry.repairOf ? control(w("Open original failure","查看原失败报告"),"report",entry.repairOf) : "";
    const wait = state.kind==="wait", navigation = state.kind==="navigation";
    const step = /^steps\[(\d+)\]$/.exec(state.path);
    const location = step ? w("Step ","第 ")+(Number(step[1])+1)+w(""," 步") : state.path;
    const title = wait ? w("Wait for the target page","等待目标页面就绪") : navigation ?
        w("Insert a navigation step","补上页面跳转") : w("Replace the locator","更换定位器");
    const change = wait ? `<p>${w("After this step, wait up to 3 seconds for ","本步结束后，最多等待 3 秒，直到 ")}<strong>${html(state.label || w("the target control","目标控件"))}</strong>${w(" to be visible."," 可见。")}</p>` :
        navigation ? `<dl><dt>${w("Insert before this step","在此步前插入")}</dt>
        <dd>${w("Tap","点按")} <strong>${html(state.label)}</strong> · <code>${html(JSON.stringify(state.proposed.input.target))}</code></dd>
        <dt>${w("Then run the original step","接着执行原步骤")}</dt><dd>${html(state.old || location)}</dd></dl>` :
        `<dl><dt>${w("Original locator","原定位器")}</dt><dd><code>${html(JSON.stringify(state.old))}</code></dd>
        <dt>${w("Replacement locator","替代定位器")}</dt><dd><code>${html(JSON.stringify(state.proposed))}</code>${state.label ? " · "+html(state.label) : ""}</dd></dl>`;
    const hasDevice = Boolean(model.devices.includes(model.device) || entry.source === "pytest");
    const open = state.stage === "proposed" || state.stage === "failed";
    let actions = "";
    if (original && open && !state.issue)
        actions += control(w("Run a copy with this change","用副本验证修复"),"repairVerify",state.id,{off:!hasDevice,primary:hasDevice});
    if (open) actions += control(w("Open edit draft","打开修改草稿"),"repairDraft",state.id,{primary:!original || Boolean(state.issue) || !hasDevice});
    if (state.stage === "verified") actions += control(w("Apply to case","应用到用例"),"repairApply",state.trial,{primary:true});
    if (trial) actions += control(w("Open original failure","查看原失败报告"),"report",state.id);
    else if (state.trial) actions += control(w("View verification report","查看验证报告"),"report",state.trial);
    const message = state.stage === "applied" ? w("Verified change saved to the case.","已将验证通过的修改保存到用例。") :
        state.stage === "draftSaved" ? w("The draft was saved. Run the case to check the result.","草稿中的修改已保存，可运行用例检查结果。") :
        state.stage === "verified" ? w("The copy exercised this change and passed the original final checks.","副本已执行修改后的步骤，并通过原用例的最终断言。") :
        state.stage === "verifying" ? w("Running the modified copy…","正在运行修改后的副本…") :
        state.notReached ? w("The copy passed but did not execute the changed step.","副本通过了测试，但本次没有执行修改的步骤。") :
        state.stage === "failed" ? w("Verification did not pass. See the trial report.","副本验证未通过，详情见验证报告。") :
        state.issue ? w("Open the draft to review and save the edit. A verified run requires a starting condition and a final assertion.",
            "可打开草稿核对并保存。补齐起始条件和最终断言后，可以验证这项修改。") :
        !hasDevice ? w("Select a device to verify the change.","选择设备后可验证修改。") :
        w("Return the device to the case’s starting state before verifying.","将手机置于用例起始状态后，运行副本验证。");
    const origin = state.evidenceId === "livePage" ? w("From current phone screen","依据当前手机画面") : w("From recorded failure page","依据运行时失败画面");
    return `<section class="case-repair"><h3>${title} <small>· ${html(location)} · ${origin}</small></h3>${change}
        <p role="status">${message}</p><div class="toolbar">${actions}</div></section>`;
}
