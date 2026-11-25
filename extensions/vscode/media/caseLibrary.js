import {actionButton, escapeHtml as html} from "./ui/controls.js";
import {itemMenu} from "./ui/itemActions.js";
import {orderGrip, orderActions} from "./ui/listOrder.js";
import {ListSelection} from "./ui/listSelection.js";
import {caseStepPreview} from "./stepPreview.js";

const caseSelection = new ListSelection("case-library");

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

export function caseHistoryEntries(runs=[]) {
    const ids = new Set(runs.map(run=>run.id));
    return runs.filter(run=>!run.repairOf || !ids.has(run.repairOf));
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

export function caseLibraryView(model, language, onPreview, previewPending=false) {
    const w = words(language);
    const cases = model.cases || [];
    const allRuns = caseHistoryEntries(model.runs);
    const locked = Boolean(model.busy || model.draft || model.caseReview);
    const loadingPreview=caseSelection.active && previewPending && !model.draft && !model.caseReview;
    caseSelection.update("library",cases.map(entry=>entry.uri),locked && !loadingPreview);
    const selectionTools = caseSelection.tools(w,[{id:"hide",label:w("Remove from library","从用例库移除"),
        disabled:locked,message:uris=>({type:"caseHideSelected",uris})}],{onPreview});
    const currentUri = model.plan?.uri || (model.testView === "run" ? model.run?.entry.plan.uri : undefined);
    const currentCaseId = model.testView === "run" ? model.run?.entry.caseId : undefined;
    const draft = model.caseReview && !model.caseReview.edit ? model.caseReview : model.draft;
    const pending = draft ? `<li class="case-draft" aria-current="true"><strong>${html(draft.name || w("Recording","录制用例"))}</strong>
        <small>${model.recording ? w("Recording","录制中") : w("Draft","草稿")}</small></li>` : "";
    const rows = cases.map(entry => {
        const source = Object.hasOwn(sourceLabels, entry.source) ? w(...sourceLabels[entry.source]) : "";
        const live = model.run?.entry;
        const latest = live?.status === "running" && !live.compositionTrial && isCaseRun(live,entry,entry.id) ? live :
            allRuns.find(run=>!run.compositionTrial && (!run.repairOf || run.repairApplied) && isCaseRun(run,entry,entry.id)) || entry.lastRun;
        const options = (label,type,id,attrs={})=>actionButton(label,{attrs:{"data-type":type,"data-id":id,...attrs}});
        const menu = caseSelection.active ? "" : itemMenu(w("Case actions","用例操作"),
            options(w("View workflow JSON","查看流程 JSON"),"editPlan",entry.uri) +
            (entry.editable ? options(w("Rename case","重命名用例"),"caseReview",entry.uri,{"data-case-area":"name"}) : "") +
            options(w("Duplicate case","复制用例"),"caseDuplicate",entry.uri) +
            (entry.portableId ? actionButton(w("Where used","查看引用位置"),{attrs:{"data-compose":"sourceUsages","data-uri":entry.uri}}) : "") +
            (latest?.id && latest.status!=="running" ? options(w("View latest report","查看最近报告"),"report",latest.id) : "") +
            options(entry.editable?w("Delete case","删除用例"):w("Remove from library","从用例库移除"),"caseRemove",entry.uri),locked);
        const checkbox=caseSelection.checkbox(entry.uri,w("Select ","选择 ")+entry.name);
        return `<li class="case-library-row"${caseSelection.row(entry.uri)}${menu ? " data-item-actions" : ""}>${checkbox}<button type="button" class="case-file" data-selection-hit data-type="caseOpen" data-id="${html(entry.uri)}"
            ${!draft && (currentUri === entry.uri || (currentCaseId && currentCaseId === entry.id)) ? 'aria-current="true"' : ""} ${locked && !loadingPreview ? "disabled" : ""}>
            <span class="case-identity"><strong>${html(entry.name)}</strong>${source || entry.location ? `<small>${html([source, entry.location].filter(Boolean).join(" · "))}</small>` : ""}</span>
            <span class="case-outcome" data-status="${entry.draft ? "draft" : html(latest?.status)}">${entry.draft ? w("Draft","草稿") : html(caseRunStatus(latest,language))}</span></button>${menu}</li>`;
    }).join("");
    const plan = model.plan;
    const showAllRuns = model.testView==="history" || allRuns.some(run=>!isCaseRun(run,plan,model.activeCase?.id));
    const temporary = plan && !cases.some(entry=>entry.uri===plan.uri) ? `<li><button type="button" class="case-file"
        data-type="view" data-view="workflow" ${!draft?'aria-current="true"':""} ${locked?"disabled":""}>
        <span class="case-identity"><strong>${html(plan.name)}</strong><small>${w("Opened file","已打开的文件")}</small></span></button></li>` : "";
    const library = `<nav class="case-library" aria-label="${w("Test cases", "测试用例")}">
        <header class="case-library-head"><h2>${w("Cases", "用例")}</h2>
            <div class="case-library-actions">
                ${actionButton(w("New case","新建用例"),{quiet:true,className:"case-open-file",attrs:{"data-type":"caseNew"},disabled:locked})}
                ${actionButton(w("Open file","打开文件"),{quiet:true,className:"case-open-file",attrs:{"data-type":"openPlan"},disabled:locked})}
                ${caseSelection.active ? "" : selectionTools}
            </div></header>${caseSelection.active ? selectionTools : ""}
        ${rows || pending || temporary ? `<ul class="case-files" id="case-files">${pending}${rows}${temporary}</ul>` :
            `<p class="case-library-empty" role="status">${model.casesLoading ? w("Loading cases…","正在读取用例…") : w("No saved cases","尚未保存用例")}</p>`}
        ${model.removedCase ? `<p class="case-removal" role="status">${html(model.removedCase.name)} · ${w("Removed","已移除")}
            ${actionButton(w("Undo","撤销"),{quiet:true,disabled:locked,attrs:{"data-type":"caseRestore","data-id":model.removedCase.uri}})}</p>` : ""}
        ${showAllRuns ? caseRunHistory(allRuns,language,{id:"case-all-runs",label:w("All runs","全部运行"),open:model.testView==="history",
            selected:model.testView==="run"?model.run?.entry.id:undefined,disabled:locked,showName:true}) : ""}</nav>`;
    return model.draft || model.caseReview ?
        `<details class="case-library-index" id="case-library-index"><summary>${w("Case library","用例库")} <span>${cases.length}</span></summary>${library}</details>` : library;
}

export function caseStepLabel(text, step, title) {
    const name = step?.name || text;
    const heading = title || (step?.name ? `<strong>${html(name)}</strong>` : html(name));
    const description = step?.displayDescription || (step?.name ? text : "");
    if (!description || description === name) return heading;
    const note = step.displayDescription ? ` class="case-step-description" title="${html(description)}"` : "";
    return `<span class="case-step-title">${heading}<small${note}>${html(description)}</small></span>`;
}

export function casePendingNotice(pending, language) {
    if (!pending?.length) return "";
    const w = words(language);
    const count = pending.length;
    const message=pending.some(item=>item.kind) ? w(`${count} pending changes`,`${count} 处改动待处理`) :
        w(`${count} ${count===1?"step is":"steps are"} awaiting generation`,`${count} 条步骤待生成`);
    return `<div class="case-pending-notice"><span role="status">${message}</span>
        ${actionButton(w("Go to first","定位首条"),{quiet:true,attrs:{"data-type":"casePending","data-path":pending[0].path}})}</div>`;
}

export function caseBddView(bdd, language, {renderRow, renderAfterStep, stepActions, tools, coordinates=false, definitions,splitEditor,
    branchId="case-branch", showHeading=true, reorder=false, insert=false, insertedPath, insertionNotice, insertionForm, editingOpinionPath, stepSelection} = {}) {
    if (!bdd) return "";
    const w = words(language);
    const authored = step=>!step.area || step.area==="step";
    const row = step => renderRow?.(step.text,{area:step.area || "step",index:step.index,path:step.path,step}) || caseStepLabel(step.text,step);
    const receipt = (path,applied) => {
        if (!insertedPath || insertedPath!==path) return "";
        const status = insertionNotice==="ruleGroupRemoved" ? w("Rule group removed from draft","已从草稿移除规则组") :
            applied || insertionNotice==="applied" ? w("Applied to draft","已应用到草稿") : w("Added to draft","已加入草稿");
        return `<div class="case-insert-receipt"><small role="status">${status}</small>${actionButton(w("Undo","撤销"),{
            quiet:true,disabled:!insert,attrs:{"data-case-insert":"undo"}})}</div>`;
    };
    const line = (role, content, attached = false) => `<div class="case-bdd-line${attached ? " case-attached-check" : ""}"
        ${role ? `data-bdd-role="${html(role)}"><span class="case-bdd-role">${html(role)}</span>` : ">"}<div class="case-bdd-text">${content}</div></div>`;
    const slot = (path,side,title,menuTitle)=>{
        const position=side==="before" ? w("Insert before","在此步之前插入") : w("Insert after","在此步之后插入");
        return `<button class="case-insert-slot" type="button" data-case-insert="open" data-path="${html(path)}"
            data-side="${side}" data-menu-title="${html(menuTitle)}" aria-keyshortcuts="Shift+F10" aria-label="${html(position+" · "+title)}"></button>`;
    };
    function steps(values, readOnly = false, nested = false, referencePath) {
        const executable = values.filter(step=>step.path);
        const sortable = reorder && !stepSelection?.active && !readOnly && executable.length>1;
        const orderKey = sortable ? (nested ? executable[0].path.replace(/\[\d+\]$/,"") : "timeline") : "";
        const last = values.findLast(step=>step.path);
        let orderIndex=0;
        const items = values.map((step,index) => {
            const selectable = stepSelection && !readOnly && step.path;
            const attributes = selectable && stepSelection.row(step.path) || " data-selection-ignore";
            const checkbox = selectable ? stepSelection.checkbox(step.path,w("Select ","选择 ")+(step.name || step.text)) : "";
            const previewId=selectable && stepSelection.active ? stepSelection.previewId : undefined;
            const previewing=Boolean(previewId && previewId===step.path);
            const expanded=previewing || Boolean(previewId && previewId.startsWith(step.path+"."));
            const preview=previewing ? caseStepPreview(step, definitions?.steps?.[step.path] || definitions?.[step.area]?.[step.index],w) : "";
            const path = step.path || (step.area==="setup" ? "rule-group" : undefined);
            const editGroup = insert && !readOnly && !stepSelection?.active && step.area==="setup";
            const groupEdit = {"data-case-insert":"editRuleGroup","data-path":path};
            const manageReference = readOnly && referencePath && insert && !stepSelection?.active;
            const actions = manageReference ? actionButton(w("Manage parent reference","管理所属引用"),{attrs:{"data-compose":"reference","data-path":referencePath}}) :
                editGroup ? actionButton(w("Edit rule group","编辑规则组"),{attrs:{...groupEdit,"data-step-editor":""}}) :
                !readOnly && !stepSelection?.active && stepActions?.(step) || "";
            const titleText = step.name || step.text;
            const actionLabel=w("Actions for “"+titleText+"”","「"+titleText+"」的步骤操作");
            const rowKind=readOnly ? w("Referenced step","引用内步骤") :
                step.area==="setup" ? w("Case setup","用例配置") : w("Step","步骤");
            const menuAttrs=` data-item-actions data-menu-title="${html(rowKind+" · "+titleText)}"`;
            const canInsert = insert && !stepSelection?.active && !readOnly && step.path;
            const beforeTitle=index ? w("Between steps · before “"+titleText+"”","步骤之间 · 「"+titleText+"」之前") :
                (nested ? w("Group start","本组起点") : w("Case start","用例起点"));
            const afterTitle=nested ? w("End of group","本组末尾") : w("End of case","用例末尾");
            const beforeSlot = canInsert ? slot(step.path,"before",titleText,beforeTitle) : "";
            const afterSlot = canInsert && step===last ? slot(step.path,"after",titleText,afterTitle) : "";
            const withForm = item=>{
                if (readOnly || !insertionForm || insertionForm.path!==step.path) return item;
                const form = `<li class="case-step-insertion-editor">${insertionForm.form}</li>`;
                return insertionForm.side==="before" ? form+item : item+form;
            };
            if (!authored(step) && !step.path) {
                const title = editGroup ? actionButton(step.text,{quiet:true,className:"case-value",attrs:{...groupEdit,
                    title:w("Edit rule group","编辑规则组")}}) : row(step);
                return withForm(`<li class="case-step-entry"${path ? ` data-case-step="${html(path)}"` : ""}${actions ? menuAttrs : ""}${attributes}>
                    ${beforeSlot}${checkbox}<div class="case-sort-content">${line(step.role,title)}${preview}${readOnly ? "" : (renderAfterStep?.(step) || "") + receipt(path)}</div>
                    ${itemMenu(actionLabel,actions)}${afterSlot}</li>`);
            }
            const referenceState = step.reference?.status==="update" ? w("Update available","有新版本") :
                step.reference?.status==="missing" ? w("Source unavailable · saved version","来源不可用 · 已保存版本") :
                step.reference?.status==="draft" ? w("Source is a draft · saved version","来源为草稿 · 已保存版本") : "";
            const description = step.description;
            const generate = description && !description.implemented && !readOnly && insert && !stepSelection?.active ?
                actionButton(w("Generate steps","生成步骤"),{quiet:true,className:"case-generate-step",
                    attrs:{"data-compose":"generateDescription","data-path":step.path,"data-description-id":description.id}}) : "";
            const descriptionLabel = description && `<span class="case-description-text">${caseStepLabel(step.text,step)}</span>`;
            const referenceLabel = step.reference && ["Given","When","Then"].includes(step.role) ?
                `<small class="case-reference-label" title="${html(w("Referenced case","引用用例")+" · "+step.text)}">${w("Reference","引用")}</small>` : "";
            const title = step.branches ? `<details id="${branchId}-${html(step.path)}"${expanded?" open":""}><summary${sortable?" data-order-hit":""}>${referenceLabel}${descriptionLabel || caseStepLabel(step.text,step)}${referenceState ?
                `<small class="case-reference-state">${html(referenceState)}</small>`:""}</summary>
                ${step.branches.map(branch=>`<div class="case-branch" data-selection-ignore>${branch.label ? `<strong>${html(branch.label)}</strong>`:""}
                    ${steps(branch.steps,readOnly||branch.readOnly,true,referencePath || (branch.readOnly && step.reference && path))}</div>`).join("")}</details>` : description ?
                `<div class="case-description-line"><span${sortable?" data-order-hit":""}>${descriptionLabel}</span>${generate}</div>` : row(step);
            const role = step.role || (description && (description.implemented ? w("Steps","步骤") : w("Pending","待生成")));
            const feedback = step.editNote && step.path!==editingOpinionPath ? `<div class="case-step-feedback">
                <p>${html(step.editNote)}</p>${!readOnly && insert && !stepSelection?.active ? actionButton(w("Generate revision","生成修改"),{quiet:true,className:"case-generate-step",
                    attrs:{"data-compose":"reviseStep","data-path":step.path}}) : ""}</div>` : "";
            const ruleStatus = step.ruleGroup?.repeated ?
                w("If this group is already enabled, the run keeps the active rules and sequence.","重复启用时会沿用当前规则和响应进度。") :
                step.ruleGroup?.unavailable ? w("This rule group may not be enabled here.","到这一步时，相关规则组可能尚未启用。") : "";
            const ruleNotice = insert && !readOnly && !stepSelection?.active && ruleStatus ?
                `<small class="case-step-feedback">${ruleStatus}</small>` : "";
            const body = (step.before || []).map(text=>line("Given",html(text),true)).join("") +
                line(role,title) +
                (step.after ? line("Then",html(step.after),true) : "") + preview + feedback + ruleNotice + (renderAfterStep?.(step) || "");
            const insertion = readOnly ? "" : receipt(path,description?.implemented);
            const canMove=sortable && Boolean(step.path);
            const position = canMove ? orderIndex++ : undefined;
            const menu = actions + (canMove ? orderActions(w,position,executable.length) : "");
            const group = step.group && step.group !== values[index-1]?.group ? `<h3 class="case-step-group">${html(step.group)}</h3>` : "";
            const order = canMove ? ` data-order-index="${position}" data-step-path="${html(step.path)}" data-order-label="${html(step.name || step.text)}"` : "";
            return withForm(`<li class="case-step-entry" data-case-step="${html(step.path)}"${description && !description.implemented ? ' data-step-pending="true"' : ""}${menu ? menuAttrs : ""}${order}${attributes}>
                ${beforeSlot}${group}${checkbox}${canMove ? orderGrip(w) : ""}<div class="case-sort-content">${body}${insertion}</div>
                ${itemMenu(actionLabel,menu)}${afterSlot}</li>`);
        });
        const split = !nested && splitEditor ? values.findIndex(step=>step.path===splitEditor.path) : -1;
        if (split>=0) {
            const tail = items.slice(split+1);
            return `<div class="case-edit-layout"><ol class="case-bdd-steps case-edit-start">${items.slice(0,split+1).join("")}</ol>
                <div class="case-edit-fields" data-disclosure-owner="${html(splitEditor.path)}">${splitEditor.form}</div>
                ${tail.length ? `<ol class="case-bdd-steps case-edit-tail" start="${split+2}">${tail.join("")}</ol>` : ""}</div>`;
        }
        return `<ol class="case-bdd-steps"${sortable ? ' data-order-kind="case" data-order-key="'+html(orderKey)+'"' : ""}>${items.join("")}</ol>`;
    }
    const values = bdd.steps || bdd.when; // Older saved gesture reports used the "when" array.
    const heading = showHeading ? `<header class="case-steps-head"><h2>${coordinates ? w("Recorded actions","录制步骤") : w("Case steps","用例步骤")}</h2>${tools || ""}</header>` : "";
    const emptyLabel = w("No steps yet","暂无步骤");
    const needsPlaceholder=insert && !values?.some(step=>step.path) || insertedPath==="steps" && !values?.some(authored);
    const empty = needsPlaceholder ?
        `<ol class="case-bdd-steps"><li class="case-step-entry muted" data-case-step="steps" data-case-empty data-selection-ignore>
            <div class="case-sort-content">${emptyLabel}${receipt("steps")}</div>
            ${insert && !stepSelection?.active ? slot("steps","after",emptyLabel,w("Case start","用例起点")) : ""}</li></ol>` : "";
    const timeline = insertionForm?.path==="steps" && !values?.length ?
        `<ol class="case-bdd-steps"><li class="case-step-insertion-editor">${insertionForm.form}</li></ol>` : (values?.length ? steps(values) : empty ? "" :
        `<p class="muted">${w("No steps recorded","尚未记录步骤")}</p>`)+empty;
    return `<section class="case-bdd">${heading}${timeline}</section>`;
}
