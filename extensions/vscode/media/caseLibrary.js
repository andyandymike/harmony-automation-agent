import {actionButton, escapeHtml as html} from "./ui/controls.js";
import {itemMenu} from "./ui/itemActions.js";
import {orderGrip, orderActions} from "./ui/listOrder.js";

const sourceLabels = {recording: ["Recording", "录制"], exploration: ["AI exploration", "AI 探索"],
    workflow: ["Workflow", "流程"], imported: ["Workflow file", "流程文件"]};
const statusLabels = {passed: ["Passed", "通过"], failed: ["Failed", "失败"], completed: ["Completed", "已完成"],
    running: ["Running", "运行中"], unknown: ["Unknown", "状态未知"], cancelled: ["Cancelled", "已取消"],
    rejected: ["Rejected", "未执行"], blocked: ["Blocked", "受阻"], skipped: ["Skipped", "已跳过"],
    yielded: ["Yielded", "已暂停"], error: ["Error", "错误"], budget_exhausted: ["Limit reached", "达到上限"]};
const words = lang => (en, zh) => /^zh/i.test(lang) ? zh : en;

export function isCaseRun(run, plan, caseId) {
    return Boolean(run && ((plan?.uri && run.plan?.uri === plan.uri) || (caseId && run.caseId === caseId)));
}

export function caseRunStatus(run, language) {
    const w = words(language), status = run?.status;
    if (run?.source === "device") {
        if (status === "completed") return w("Replay complete", "回放完成");
        if (status === "unknown") return w("Replay unconfirmed", "回放未确认");
        if (status === "running") return w("Replaying", "正在回放");
    }
    return Object.hasOwn(statusLabels,status) ? w(...statusLabels[status]) : status || w("Not run", "尚未运行");
}

export function caseRunTime(run, language) {
    const date = new Date(run.time);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(language, {dateStyle:"short",timeStyle:"short"}) : "";
}

export function caseRunHistory(runs, language, {id, label, selected, open = false, disabled, showName} = {}) {
    if (!runs.length) return "";
    const w = words(language);
    return `<details class="case-run-picker" id="${html(id)}"${open ? " open" : ""}>
        <summary>${html(label)} <small>${runs.length}</small></summary>
        <ul>${runs.map(run=>`<li><button type="button" data-type="report" data-id="${html(run.id)}"
            ${run.id===selected ? 'aria-current="true"' : ""} ${disabled ? "disabled" : ""}>
            ${showName ? `<strong>${html(run.plan.name)}</strong>` : ""}
            <span><time datetime="${html(run.time)}">${html(caseRunTime(run,language))}</time>
                ${run.repairOf ? `<small> · ${w("Repair verification","修复验证")}</small>` : ""}</span>
            <span class="case-outcome" data-status="${html(run.status)}">${html(caseRunStatus(run,language))}</span></button></li>`).join("")}</ul>
    </details>`;
}

export function caseLibraryView(model, language) {
    const w = words(language);
    const cases = model.cases || [];
    const locked = Boolean(model.busy || model.draft || model.caseReview);
    const currentUri = model.plan?.uri || (model.testView === "run" ? model.run?.entry.plan.uri : undefined);
    const currentCaseId = model.testView === "run" ? model.run?.entry.caseId : undefined;
    const draft = model.caseReview && !model.caseReview.edit ? model.caseReview : model.draft;
    const pending = draft ? `<li class="case-draft" aria-current="true"><strong>${html(draft.name || w("Recording","录制用例"))}</strong>
        <small>${model.recording ? w("Recording","录制中") : w("Draft","草稿")}</small></li>` : "";
    const rows = cases.map(entry => {
        const source = Object.hasOwn(sourceLabels, entry.source) ? w(...sourceLabels[entry.source]) : "";
        const live = model.run?.entry;
        const latest = live?.status === "running" && isCaseRun(live,entry,entry.id) ? live :
            model.runs?.find(run=>(!run.repairOf || run.repairApplied) && isCaseRun(run,entry,entry.id)) || entry.lastRun;
        const options = (label,type,id,attrs={})=>actionButton(label,{attrs:{"data-type":type,"data-id":id,...attrs}});
        const menu = itemMenu(w("Case actions","用例操作"),
            options(w("View workflow JSON","查看流程 JSON"),"editPlan",entry.uri) +
            (entry.editable ? options(w("Rename case","重命名用例"),"caseReview",entry.uri,{"data-case-area":"name"}) : "") +
            options(w("Duplicate case…","复制用例…"),"caseDuplicate",entry.uri) +
            (latest?.id && latest.status!=="running" ? options(w("View latest report","查看最近报告"),"report",latest.id) : "") +
            options(entry.editable?w("Delete case…","删除用例…"):w("Remove from library…","从用例库移除…"),"caseRemove",entry.uri),locked);
        return `<li class="case-library-row" data-item-actions><button type="button" class="case-file" data-type="caseOpen" data-id="${html(entry.uri)}"
            ${!draft && (currentUri === entry.uri || (currentCaseId && currentCaseId === entry.id)) ? 'aria-current="true"' : ""} ${locked ? "disabled" : ""}>
            <span class="case-identity"><strong>${html(entry.name)}</strong>${source || entry.location ? `<small>${html([source, entry.location].filter(Boolean).join(" · "))}</small>` : ""}</span>
            <span class="case-outcome" data-status="${html(latest?.status)}">${html(caseRunStatus(latest,language))}</span></button>${menu}</li>`;
    }).join("");
    const plan = model.plan;
    const allRuns = model.runs || [];
    const showAllRuns = model.testView==="history" || allRuns.some(run=>!isCaseRun(run,plan,model.activeCase?.id));
    const temporary = plan && !cases.some(entry=>entry.uri===plan.uri) ? `<li><button type="button" class="case-file"
        data-type="view" data-view="workflow" ${!draft?'aria-current="true"':""} ${locked?"disabled":""}>
        <span class="case-identity"><strong>${html(plan.name)}</strong><small>${w("Opened file","已打开的文件")}</small></span></button></li>` : "";
    return `<nav class="case-library" aria-label="${w("Test cases", "测试用例")}">
        <header class="case-library-head"><h2>${w("Cases", "用例")}</h2>
            ${actionButton(w("Open file…","打开文件…"),{quiet:true,className:"case-open-file",attrs:{"data-type":"openPlan"},disabled:locked})}</header>
        ${rows || pending || temporary ? `<ul class="case-files" id="case-files">${pending}${rows}${temporary}</ul>` :
            `<p class="case-library-empty" role="status">${model.casesLoading ? w("Loading cases…","正在读取用例…") : w("No saved cases","尚未保存用例")}</p>`}
        ${model.removedCase ? `<p class="case-removal" role="status">${html(model.removedCase.name)} · ${w("Removed","已移除")}
            ${actionButton(w("Undo","撤销"),{quiet:true,disabled:locked,attrs:{"data-type":"caseRestore","data-id":model.removedCase.uri}})}</p>` : ""}
        ${showAllRuns ? caseRunHistory(allRuns,language,{id:"case-all-runs",label:w("All runs","全部运行"),open:model.testView==="history",
            selected:model.testView==="run"?model.run?.entry.id:undefined,disabled:locked,showName:true}) : ""}</nav>`;
}

export function caseStepLabel(text, step, title) {
    if (!step?.name) return title || html(text);
    return `<span class="case-step-title">${title || `<strong>${html(step.name)}</strong>`}
        ${step.name === text ? "" : `<small>${html(text)}</small>`}</span>`;
}

export function caseBddView(bdd, language, {renderRow, renderAfterStep, stepActions, tools, boundaryEditor, coordinates=false,
    branchId="case-branch", showHeading=true, reorder=false} = {}) {
    if (!bdd) return "";
    const w = words(language);
    const authored = step=>!step.area || step.area==="step";
    const row = step => renderRow?.(step.text,{area:step.area || "step",index:step.index,path:step.path,step}) || caseStepLabel(step.text,step);
    const line = (role, content, attached = false) => `<div class="case-bdd-line${attached ? " case-attached-check" : ""}"
        ${role ? `data-bdd-role="${html(role)}"><span class="case-bdd-role">${html(role)}</span>` : ">"}<div class="case-bdd-text">${content}</div></div>`;
    function steps(values, root = false) {
        const executable = values.filter(authored);
        const sortable = reorder && executable.length>1;
        const orderKey = sortable ? executable[0].path.replace(/\[\d+\]$/,"") : "";
        const items = values.map((step,index) => {
            if (!authored(step)) return `<li class="case-step-entry"><div class="case-sort-content">${line(step.role,row(step))}</div></li>`;
            const title = step.branches ? `<details id="${branchId}-${html(step.path)}"><summary${sortable?" data-order-hit":""}>${caseStepLabel(step.text,step)}</summary>
                ${step.branches.map(branch=>`<div class="case-branch"><strong>${html(branch.label)}</strong>${steps(branch.steps)}</div>`).join("")}</details>` : row(step);
            const body = (step.before || []).map(text=>line("Given",html(text),true)).join("") +
                line(coordinates ? undefined : step.role,title) +
                (step.after ? line("Then",html(step.after),true) : "") + (renderAfterStep?.(step) || "");
            const position = step.index ?? index;
            const menu = (stepActions?.(step) || "") + (sortable ? orderActions(w,position,executable.length) : "");
            const group = step.group && step.group !== values[index-1]?.group ? `<h3 class="case-step-group">${html(step.group)}</h3>` : "";
            const order = sortable ? ` data-order-index="${position}" data-step-path="${html(step.path)}" data-order-label="${html(step.name || step.text)}"` : "";
            return `<li class="case-step-entry" data-case-step="${html(step.path)}"${menu ? " data-item-actions" : ""}${order}>
                ${group}${sortable ? orderGrip(w) : ""}<div class="case-sort-content">${body}</div>
                ${itemMenu(w("Step actions","步骤操作"),menu)}</li>`;
        });
        if (root && !coordinates && boundaryEditor) {
            const start = boundaryEditor("start"), end = boundaryEditor("goal");
            if (start) items.splice(values.findLastIndex(step=>step.area==="start" || step.area==="setup")+1,0,
                `<li class="case-bdd-boundary-editor">${start}</li>`);
            if (end) items.push(`<li class="case-bdd-boundary-editor">${end}</li>`);
        }
        return `<ol class="case-bdd-steps"${sortable ? ' data-order-kind="case" data-order-key="'+html(orderKey)+'"' : ""}>${items.join("")}</ol>`;
    }
    const values = bdd.steps || bdd.when; // Older saved gesture reports used the "when" array.
    const heading = showHeading ? `<header class="case-steps-head"><h2>${coordinates ? w("Recorded actions","录制步骤") : w("Case steps","用例步骤")}</h2>${tools || ""}</header>` : "";
    const timeline = values?.length ? steps(values,true) : `<p class="muted">${w("No steps recorded","尚未记录步骤")}</p>`;
    return `<section class="case-bdd">${heading}${timeline}</section>`;
}
