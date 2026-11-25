import {actionButton, escapeHtml as html} from "./ui/controls.js";

const routeDrafts = new Map();

export function repairInput(input) {
    if (input.id!=="repair-upstream") return false;
    routeDrafts.set(input.form.dataset.id,input.value);
    return true;
}

export function repairSubmit(event, send) {
    if (event.target.id!=="repair-upstream-form") return false;
    event.preventDefault();
    const form = event.target;
    send({type:"repairVerify",id:form.dataset.id,upstream:form.elements.upstream.value});
    return true;
}

const value = item => html(typeof item==="string" ? item : JSON.stringify(item));
const completed = step => ["completed","passed"].includes(step?.status);

function stepTitle(step,w) {
    if (step?.label) return step.label;
    const at = /^steps\[(\d+)\]$/.exec(step?.path);
    return at ? w("Step ","第 ")+(Number(at[1])+1)+w(""," 步") : w("Step","步骤");
}

function trialDetails(result,w) {
    if (!result) return "";
    const {repaired,target,failed,goals,request} = result;
    const step = failed || target || repaired;
    const facts = [[w("Expected","预期"),step?.expected],[w("Actual","实际"),step?.actual]].filter(([,item])=>item!==undefined);
    return `<details class="case-repair-details" id="case-repair-trial-details">
        <summary>${w("Trial details","试跑详情")}</summary>
        ${step ? `<p><strong>${html(stepTitle(step,w))}</strong>${step.errorCode ? " · "+html(step.errorCode) : ""}</p>` : ""}
        ${facts.length ? `<dl class="case-step-facts">${facts.map(([label,item])=>
            `<div><dt>${label}</dt><dd>${value(item)}</dd></div>`).join("")}</dl>` : ""}
        ${request ? `<p><code>${html(request.method+" "+request.path)}</code> · HTTP ${html(request.status)}</p>` : ""}
        ${result.goalStatus==="not_run" ? `<p>${w("The final checks were not run.","最终断言未执行。")}</p>` : ""}
        ${goals?.length ? `<ul class="case-trial-checks">${goals.map(goal=>`<li><span>${html(goal.label || goal.expected || w("Final check","最终断言"))}</span>
            <strong class="case-outcome" data-status="${completed(goal)?"passed":"failed"}">${completed(goal)?w("Passed","通过"):w("Failed","失败")}</strong>
            ${!completed(goal) && goal.actual!==undefined ? `<small>${w("Actual","实际")} ${value(goal.actual)}</small>` : ""}</li>`).join("")}</ul>` : ""}
        </details>`;
}

function trialStatus(state,progress,w) {
    const {stage,target,verificationIssue,result,error} = state;
    const upstream = state.kind==="upstream";
    let label, detail, tone;
    if (stage==="verifying") {
        label=w("Trial running","正在试跑");
        detail=progress?.step && stepTitle(progress.step,w);
        tone="running";
    } else if (stage==="verified" || stage==="applied") {
        label=stage==="verified" ? w("Repair trial passed","修复试跑通过") : upstream ? w("Test upstream saved","已保存测试上游") : w("Applied to case","已应用到用例");
        if (target) {
            detail = upstream ? w("The request reached the test upstream.","请求已到达测试上游。") :
                w("The step that originally failed passed.","原失败步骤已通过。");
            if (result?.failed) detail += " "+w("The trial later stopped at ","试跑随后停在「")+stepTitle(result.failed,w)+w(".","」。");
        } else {
            detail=upstream ? w("The request reached the upstream. The original final checks passed.","请求已到达上游，原用例的最终断言通过。") :
                w("The repaired step ran and the original final checks passed.","修复步骤已执行，原用例的最终断言通过。");
        }
        tone="passed";
    } else if (stage==="failed") {
        const cancelled=result?.status==="cancelled";
        label=cancelled ? w("Trial stopped","试跑已停止") : w("Trial did not pass","试跑未通过");
        tone=cancelled ? "cancelled" : "failed";
        const issues={startingState:w("The starting condition was not met.","起始条件未满足。"),
            upstreamNotObserved:w("No forwarding to the upstream was observed.","没有记录到请求转发至上游。"),
            interrupted:w("The window closed during the trial.","试跑期间工作台已关闭。")};
        detail = issues[verificationIssue] || (state.notReached ? w("The repaired step did not run.","本次未执行修复步骤。") : undefined);
        if (result?.failed && !detail) {
            const cause = result.request?.issue==="UPSTREAM_FAILED" ? w("The test upstream did not respond.","测试上游未响应。") :
                result.request?.issue==="NO_TEST_UPSTREAM" ? w("The gateway has no test upstream.","测试网关未配置上游。") : "";
            detail = [completed(result.repaired) && w("The repaired step ran.","修复步骤已执行。"),
                w("Stopped at ","试跑停在「")+stepTitle(result.failed,w)+w(".","」。"),cause].filter(Boolean).join(" ");
        }
    } else if (stage==="draftSaved") {
        label=w("Changes saved in the editor","已在编辑器保存改动");
        detail=w("Run the current case to verify the edit.","运行当前用例即可验证改动。");
    }
    if (!label && !error) return "";
    return `<div class="case-repair-result" id="case-repair-result" role="status">
        ${label ? `<strong class="case-outcome" data-status="${html(tone)}">${label}</strong>` : ""}
        ${detail ? `<p>${html(detail)}</p>` : ""}${error ? `<p class="case-repair-error">${html(error)}</p>` : ""}</div>`;
}

export function repairView(model, run, language, button) {
    const entry = run.entry, state = model.repair;
    if (state?.id!==entry.id) return "";
    const w = (en,zh) => /^zh/i.test(language) ? zh : en;
    const {stage,issue,kind,label,stepName,proposed} = state;
    const upstream = kind==="upstream", wait = kind==="wait", navigation = kind==="navigation";
    const open = stage==="proposed" || stage==="failed";
    const hasDevice = Boolean(model.devices.includes(model.device) || entry.source==="pytest");
    const sameDevice = !state.device || state.device===model.device;
    const ready = hasDevice && sameDevice && !issue;
    const control = (label,type,id,{off=false,primary=false}={}) => button(label,type,{attrs:{
        "data-id":id,...(primary && {id:"case-repair-action"})},off,primary});
    const title = upstream ? w("Configure the test upstream","配置测试上游") : wait ? w("Wait for the target","等待目标控件") :
        navigation ? w("Add a navigation step","补上页面跳转") : w("Replace the locator","更换定位器");
    const task = [stepName,label && label!==stepName && label].filter(Boolean).join(" · ");
    const detail = upstream ? "" : wait ? `<p>${w("Wait for the control to be visible.","等待该控件可见。")} ${w("Timeout","超时")} ${html(proposed.timeoutMs)} ms</p>` :
        `<dl><dt>${navigation?w("Before","在此步之前"):w("Original locator","原定位器")}</dt><dd>${value(state.old)}</dd>
        <dt>${navigation?w("Insert a tap","插入点按"):w("Replacement locator","替代定位器")}</dt>
        <dd><code>${value(navigation?proposed.input.target:proposed)}</code></dd></dl>`;
    const tryLabel = stage==="failed" ? w("Try again","重新试跑") : w("Try repair","试跑修复");
    const routeForm = upstream && open ? `<form id="repair-upstream-form" data-id="${html(state.id)}">
        <label for="repair-upstream">${w("Development upstream address","开发上游地址")}</label>
        <div class="toolbar"><input id="repair-upstream" name="upstream" type="url" required maxlength="256"
            placeholder="http://127.0.0.1:3000" value="${html(routeDrafts.get(state.id) ?? state.upstream ?? "")}" ${model.busy ? "disabled" : ""}>
        <button id="case-repair-action" type="submit" class="button vscode-button primary" ${!ready||model.busy?"disabled":""}>${tryLabel}</button></div></form>` : "";
    const block = !open ? "" : issue==="ruleSteps" ? w("pytest cannot verify inline rule-group steps.","pytest 暂不支持试跑用例内的规则组步骤。") :
        issue==="start" ? w("Add a starting condition to try this repair.","补齐起始条件后即可试跑。") :
        issue ? w("Finish the case draft to try this repair.","完成用例草稿后即可试跑。") :
        !hasDevice ? w("Connect the phone to try this repair.","连接手机后即可试跑。") :
        !sameDevice ? w("Select the phone used in the failed run.","请选择失败运行使用的手机。") : "";
    let primary = "";
    if (stage==="verified") primary=control(upstream ? w("Save test upstream","保存测试上游") : w("Apply to case","应用到用例"),
        "repairApply",state.trial,{primary:true});
    else if (stage==="verifying" && model.repairProgress?.canStop) primary=actionButton(w("Stop trial","停止试跑"),
        {quiet:true,attrs:{"data-type":"stopRun","data-id":model.repairProgress.id,id:"case-repair-action"}});
    else if (!upstream && open) primary=issue ? control(w("Open case editor","打开用例编辑器"),"repairDraft",state.id,{primary:true}) :
        control(tryLabel,"repairVerify",state.id,{off:!ready,primary:true});
    const handEdit = !upstream && open && !issue ? control(w("Adjust in the case editor","在用例编辑器中调整"),"repairDraft",state.id) : "";
    return `<section class="case-repair" aria-label="${title}">
        <h3>${title}${task?` <small>${html(task)}</small>`:""}</h3>
        ${upstream && !open ? `<p><code>${html(state.upstream)}</code></p>` : ""}
        ${trialStatus(state,model.repairProgress,w)}${block ? `<p class="case-repair-block">${block}</p>` : open && !upstream ?
            `<p>${w("The trial starts at the beginning of the case and checks the step that failed.","从用例起点试跑，验证原失败步骤。")}</p>` : ""}${routeForm}
        ${primary ? `<div class="toolbar case-repair-actions">${primary}</div>` : ""}
        ${trialDetails(state.result,w)}
        ${detail ? `<details id="case-repair-change" class="case-repair-details"><summary>${w("Repair change","修复改动")}</summary>
            ${detail}${handEdit ? `<div class="toolbar">${handEdit}</div>` : ""}</details>` : ""}</section>`;
}
