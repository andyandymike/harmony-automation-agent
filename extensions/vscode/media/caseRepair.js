import {escapeHtml as html} from "./ui/controls.js";

export function repairView(model, run, language, button) {
    const entry = run.entry;
    const w = (en,zh) => /^zh/i.test(language) ? zh : en;
    const control = (label,type,id,{off=false,primary=false}={}) => button(label,type,{attrs:{"data-id":id},off,primary});
    const state = model.repair;
    const original = state?.id===entry.id;
    const trial = state?.trial===entry.id || state?.stage==="verifying" && entry.repairOf===state.id;
    if (!original && !trial) return entry.repairOf ? control(w("Open original failure","查看原失败报告"),"report",entry.repairOf) : "";
    const wait = state.kind==="wait";
    const step = /^steps\[(\d+)\]$/.exec(state.path);
    const location = step ? w("Step ","第 ")+(Number(step[1])+1)+w(""," 步") : state.path;
    const title = wait ? w("Wait for the target page","等待目标页面就绪") : w("Replace the locator","更换定位器");
    const change = wait ? `<p>${w("After this step, wait up to 3 seconds for ","本步结束后，最多等待 3 秒，直到 ")}<strong>${html(state.label || w("the target control","目标控件"))}</strong>${w(" to be visible."," 可见。")}</p>` :
        `<dl><dt>${w("Original locator","原定位器")}</dt><dd><code>${html(JSON.stringify(state.old))}</code></dd>
        <dt>${w("Replacement locator","替代定位器")}</dt><dd><code>${html(JSON.stringify(state.proposed))}</code>${state.label ? " · "+html(state.label) : ""}</dd></dl>`;
    const canVerify = Boolean(model.devices.includes(model.device) || entry.source === "pytest");
    const verify = state.stage === "proposed" || state.stage === "failed";
    let actions = "";
    if (original && verify) actions += control(w("Run a copy with this change","用副本验证修复"),"repairVerify",state.id,{off:!canVerify,primary:true});
    if (state.stage === "verified") actions += control(w("Apply to case","应用到用例"),"repairApply",state.trial,{primary:true});
    if (trial) actions += control(w("Open original failure","查看原失败报告"),"report",state.id);
    else if (state.trial) actions += control(w("View verification report","查看验证报告"),"report",state.trial);
    const message = state.stage === "applied" ? w("Verified change saved to the case.","已将验证通过的修改保存到用例。") :
        state.stage === "verified" ? w("The copy exercised this change and passed the original final checks.","副本已执行修改后的步骤，并通过原用例的最终断言。") :
        state.stage === "verifying" ? w("Running the modified copy…","正在运行修改后的副本…") :
        state.notReached ? w("The copy passed but did not execute the changed step.","副本通过了测试，但本次没有执行修改的步骤。") :
        state.stage === "failed" ? w("Verification did not pass. See the trial report.","副本验证未通过，详情见验证报告。") :
        !canVerify ? w("Select a device to verify the change.","选择设备后可验证修改。") :
        w("Return the device to the case’s starting state before verifying.","将手机置于用例起始状态后，运行副本验证。");
    return `<section class="case-repair"><h3>${title} <small>· ${html(location)}</small></h3>${change}
        <p role="status">${message}</p><div class="toolbar">${actions}</div></section>`;
}
