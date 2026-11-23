import { tabList, tabPanels } from "./ui/tabs.js";
import { actionButton } from "./ui/controls.js";

// State local to the editor: unsubmitted inputs, the selected report section and trace step.
const setup = { mode: "free", focus: "", description: "", maxActions: "20", maxMinutes: "3",
    flowId: undefined, planJson: "", original: "", checkpoints: [] };

let tab = "coverage";
let reportId;
let selectedStep;
const findingNotes = new Map();
const findingEvidence = new Map();
const requestedEvidence = new Set();

const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const h = value => String(value ?? "").replace(/[&<>"']/g, c => entities[c]);
const off = value => value ? " disabled" : "";
const active = value => `aria-pressed="${Boolean(value)}"`;
const format = (str, values) => str.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
const valueText = value => typeof value === "string" ? value : JSON.stringify(value);

function action(type, text, { primary = false, disabled = false, attrs } = {}) {
    return actionButton(text, {primary, disabled, attrs: {"data-x":type, ...attrs}});
}

function status(value, t) {
    const labels = { ready: t.xWatching, running: t.xActive, paused: t.xPaused, stopping: t.xStopping, completed: t.xDone,
        stopped: t.xStopped, blocked: t.xBlocked, pending: t.xPending, tried: t.xTried, skipped: t.xSkipped,
        unknown: t.xUnknown, failure: t.xFailure, review: t.xReview, observed: t.xObserve,
        incomplete: t.xIncomplete, reproduced: t.xReproduced, inconclusive: t.xInconclusive };
    return labels[value] || t[value] || value;
}

function explorationHistory(model, t, language) {
    const rows = (model.explorationHistory || []).map(run => {
        const time = new Date(run.createdAt);
        return `<li><button class="run-item" type="button" data-x="report" data-id="${h(run.id)}"${off(model.busy)}>
            <span class="run-name">${h(run.goal || (run.mode === "flow" ? t.xGuided : t.xFree))}</span>
            <span>${h(status(run.status,t))}</span><time>${h(Number.isFinite(time.valueOf()) ? time.toLocaleString(language) : "")}</time>
            <span class="row-arrow" aria-hidden="true">›</span></button></li>`;
    });
    return rows.length ? `<details class="x-history" id="exploration-history"><summary>${h(t.xHistory)}</summary>
        <ul class="run-list">${rows.join("")}</ul></details>` : "";
}

function synchronizeFlow(flow) {
    if (flow?.id === setup.flowId) return;
    setup.flowId = flow?.id;
    if (flow) setup.mode = "flow";
    if (flow?.description) setup.description = flow.description;
    setup.original = flow ? JSON.stringify(flow.plan, null, 2) : "";
    setup.planJson = setup.original;
    setup.checkpoints = flow ? [...(flow.defaultCheckpoints || [])] : [];
}

function flowControls(model,t) {
    const flow = model.explorationFlow;
    const busy = model.busy || model.explorationWorking;
    const dirty = setup.planJson !== setup.original;
    const cases = model.cases || [];
    const current = model.plan && !cases.some(entry=>entry.uri===model.plan.uri);
    const choice=(entry,source)=>actionButton(entry.name,{quiet:true,className:"x-case-choice",disabled:busy,
        attrs:{"data-x":"flow","data-source":source,"data-id":entry.uri,"aria-current":flow?.sourceUri===entry.uri?"true":undefined}});
    const choices=(current ? choice(model.plan,"current") : "") + cases.map(entry=>choice(entry,"case")).join("");
    return `<section class="x-flow" data-flow-id="${h(flow?.id)}">
        ${choices ? `<details id="x-case-source" ${flow?"":"open"}><summary>${h(t.xChooseCase)}${flow?" · "+h(flow.name):""}</summary>
            <div class="x-case-choices">${choices}</div></details>` : ""}
        <details id="x-more-sources" ${choices||flow?"":"open"}><summary>${h(t.xOtherSources)}</summary>
            <div class="toolbar">${action("flow",t.xPickFile,{disabled:busy,attrs:{"data-source":"file"}})}</div>
            <label>${h(t.xPrompt)}<textarea id="x-description" rows="3" placeholder="${h(t.xPromptExample)}"${off(busy)}>${h(setup.description)}</textarea></label>
            ${action("flow",t.xPrepare,{disabled:busy || !setup.description.trim(),attrs:{id:"x-prepare","data-source":"text"}})}
        </details>
        ${model.explorationWorking ? `<div class="toolbar"><p class="muted" role="status">${h(t.xBusyPrepare)}</p>
            ${action("stopDraft",t.xStopDraft)}</div>` : ""}
        ${flow ? `<fieldset class="x-checkpoints"><legend>${h(t.xAnchors)}</legend><p class="x-flow-name">${h(flow.name)}</p>
            ${flow.kind === "endpoint" ? `<p>${h(t.xAnchorEnd)}</p>` : ""}
            ${flow.checkpoints.map(point=>`<label class="x-checkpoint"><input type="checkbox" data-checkpoint="${h(point.index)}" ${setup.checkpoints.includes(point.index) ? "checked" : ""}${off(busy)}>
                <span>${point.index+1}. ${h(point.label)}</span></label>`).join("")}</fieldset>
            <details id="x-plan-editor"><summary>${h(t.xEdit)}</summary><textarea id="x-json" rows="8" spellcheck="false" aria-label="${h(t.xEdit)}"${off(busy)}>${h(setup.planJson)}</textarea>
            <div class="toolbar" id="x-edited" ${dirty ? "" : "hidden"}>${action("update",t.xUpdate,{disabled:busy})}<small>${h(t.xPlanEdited)}</small></div></details>` : ""}
        </section>`;
}

function unavailable(model) {
    return !model.device || !model.devices.includes(model.device) || model.busy || model.explorationWorking ||
        (setup.mode === "flow" && (!model.explorationFlow || !setup.checkpoints.length || setup.original !== setup.planJson));
}

function setupView(model,t) {
    synchronizeFlow(model.explorationFlow);
    const guided = setup.mode === "flow";
    const busy = model.busy || model.explorationWorking;
    const boundGroup = guided && model.explorationFlow?.ruleGroupName;
    const group = model.explorationRuleGroup;
    return `<section class="x-explore x-setup"><h1>${h(t.xExplore)}</h1>
        <div class="x-modes" role="group" aria-label="${h(t.xExplore)}">
            ${[["free",t.xFree],["flow",t.xGuided]].map(([key,name])=>`<button type="button" data-x="mode" data-id="${key}" ${active(setup.mode===key)}${off(busy)}>${h(name)}</button>`).join("")}</div>
        <p class="x-guide">${h(guided ? t.xGuidedHint : t.xSetupHint)}</p>
        <form id="x-setup-form">${guided ? flowControls(model,t) : ""}
            <label>${h(t.xFocus)}<textarea id="x-focus" rows="2" placeholder="${h(t.xFocusExample)}"${off(busy)}>${h(setup.focus)}</textarea></label>
            ${boundGroup ? `<p>${h(t.netRuleGroup)} · ${h(boundGroup)}</p>` : group ? `<label class="x-rule-group"><input type="checkbox" id="x-rule-group"
                data-group="${h(group.id)}" data-version="${h(group.version)}" ${setup.group?.id === group.id && setup.group.version === group.version ? "checked" : ""}${off(busy)}>
                ${h(t.xUseGroup)} · ${h(group.name)}</label>` : ""}
            <details id="x-limits"><summary>${h(t.xLimits)}</summary><div class="x-budgets">
                <label>${h(t.xInputs)}<input class="vscode-textfield" id="x-max-actions" type="number" min="1" max="100" step="1" required value="${h(setup.maxActions)}"${off(busy)}></label>
                <label>${h(t.xMinutes)}<input class="vscode-textfield" id="x-max-minutes" type="number" min="1" max="30" step="1" required value="${h(setup.maxMinutes)}"${off(busy)}></label></div></details>
            <div class="toolbar">${action("start",t.xStart,{primary:true,disabled:unavailable(model),attrs:{id:"x-start"}})}
                ${!model.device ? `<small>${h(t.xConnect)}</small>` : ""}</div>
        </form></section>`;
}

function coverageCounts(pages) {
    const counts = { pages:pages.length, total:0, tried:0, skipped:0, unknown:0 };
    for (const page of pages) for (const state of page.states) for (const entry of state.entries) {
        if (entry.status === "skipped") counts.skipped++;
        else {
            counts.total++;
            if (entry.status === "tried" || entry.status === "unknown") counts.tried++;
            if (entry.status === "unknown") counts.unknown++;
        }
    }
    return counts;
}

function coverage(report,t) {
    if (!report.pages.length) return `<p class="empty">${h(t.xNoPages)}</p>`;
    const counts = coverageCounts(report.pages);
    const blocks = report.pages.map((page,i)=>`<details class="x-page" id="x-page-${i}"><summary><strong>${h(page.label)}</strong>
        <span>${page.states.length}</span></summary>${page.states.map(state=>`<section class="x-state">
            <h3>${h(state.label)}${state.complete === false ? ` <small>${h(t.xPartial)}</small>` : ""}</h3>
            ${state.entries.length ? `<ul>${state.entries.map(entry=>{
                const step = report.steps.find(s=>s.entryId === entry.id && s.fromStateId === state.id);
                return `<li><div>${h(entry.label)}${entry.reason ? `<small>${h(entry.reason)}</small>` : ""}</div>
                    ${step ? action("traceStep",status(entry.status,t),{attrs:{"data-id":step.id}}) :
                        `<small>${h(status(entry.status,t))}</small>`}</li>`;
            }).join("")}</ul>` : `<p class="muted">${h(t.xNoEntries)}</p>`}</section>`).join("")}</details>`);
    return `<p class="x-counter">${h(format(t.xCounts,counts))}</p>
        ${counts.skipped || counts.unknown ? `<p class="x-note">${h(format(t.xExcluded,counts))}</p>` : ""}${blocks.join("")}`;
}

function pair(label,value) {
    return value === undefined || value === null ? "" : `<div><dt>${h(label)}</dt><dd>${h(valueText(value))}</dd></div>`;
}

function retests(item,t) {
    if (!item.retests?.length) return `<p class="x-note">${h(t.xUnretested)}</p>`;
    const counts = { reproduced: 0, passed: 0, inconclusive: 0 };
    for (const check of item.retests) {
        if (Object.hasOwn(counts,check.status)) counts[check.status]++;
    }
    const last = item.retests.at(-1);
    return `<p>${h(format(t.xRechecks,counts))}</p>
        <dl class="x-pairs">${pair(t.xLatestCheck,status(last.status,t))}${pair(t.actual,last.actual)}${pair(t.xPreparedGroup,last.ruleGroup)}</dl>
        ${last.reason ? `<p class="x-note">${h(last.reason)}</p>` : ""}`;
}

function findings(model,t) {
    const report = model.exploration, busy = model.busy;
    if (!report.findings.length) return `<p class="empty">${h(t.xNoFindings)}</p>`;
    return report.findings.map((item,i)=>{
        const step=report.steps.find(s=>s.id===item.stepId);
        const ignored=item.reviewStatus==="ignored";
        const attrs={"data-id":item.id};
        const canAct=!busy && model.device===report.device && model.devices.includes(report.device) &&
            ["completed","stopped","blocked"].includes(report.status);
        const {receipt,receiptIndex}=findingReceipt(step);
        const evidence=findingEvidence.get(step?.id);
        return `<details class="x-finding" id="x-finding-${i}" data-finding-id="${h(item.id)}" data-item-actions="finding"
            data-item-label="${h(item.title)}"><summary><span class="x-kind" data-kind="${h(ignored ? "ignored" : item.kind)}">${h(ignored ? t.xIgnored : status(item.kind,t))}</span>
            <strong>${h(item.title)}</strong></summary><div class="x-finding-detail"><dl class="x-pairs">
            ${pair(t.xRule,item.source)}${pair(t.expected,item.expected)}${pair(t.actual,item.actual)}
            ${pair(t.xTrigger,step?.label)}${pair(t.xPreparedGroup,report.mockScenario?.name)}</dl>
            ${item.evidenceSteps?.length > 1 ? `<p>${h(format(t.xOccurrences,{n:item.evidenceSteps.length}))}</p>` : ""}
            ${receipt ? `<div class="toolbar">${frameButtons(step.id,receipt,receiptIndex,t,busy)}</div>` : ""}
            ${evidence ? `<div class="x-finding-evidence">${frameEvidence(evidence,t)}</div>` : ""}
            ${item.kind === "failure" ? retests(item,t) : ""}
            ${item.kind === "review" ? `<label class="x-note-editor">${h(t.xNote)}<textarea id="x-note-${i}" rows="2" data-x-note="${h(item.id)}"${off(busy)}>${h(findingNotes.get(item.id) ?? item.note ?? "")}</textarea></label>
                <div class="toolbar">${action("note",t.xSaveNote,{disabled:busy,attrs})}${action("triage",ignored ? t.xReopen : t.xIgnore,{disabled:busy,attrs})}</div>` : ""}
            <div class="toolbar">
            ${step ? action("traceStep",t.xInspectTrace,{attrs:{"data-id":step.id}}) : ""}
            ${item.canRecheck ? action("recheck",t.xRecheck,{disabled:!canAct,attrs}) : ""}
            ${model.explorationCaseRoutes?.findingIds?.includes(item.id) ? action("caseFinding",t.xSaveCase,{disabled:busy,attrs}) : ""}
            ${(item.regression || item.plan) ? action("save",report.mockScenario ? t.xSaveWithGroup : t.xSave,{disabled:busy,attrs}) : ""}</div></div></details>`;
    }).join("");
}

function findingReceipt(step) {
    const receipts=step?.receipts||[];
    let receiptIndex=receipts.findIndex(row=>["failed","unknown"].includes(row.status) && (row.before||row.after));
    if (receiptIndex<0) receiptIndex=receipts.findLastIndex(row=>row.before||row.after);
    return receiptIndex>=0 ? {receipt:receipts[receiptIndex],receiptIndex} :
        {receipt:step?.before||step?.after ? step : undefined};
}

export function exploreToggle(el,model,send) {
    if (!el.open || !el.dataset.findingId || model.busy) return;
    const report=model.exploration;
    if (!report || ["ready","running"].includes(report.status)) return;
    const finding=report.findings.find(item=>item.id===el.dataset.findingId);
    const step=report.steps.find(item=>item.id===finding?.stepId);
    const {receipt,receiptIndex}=findingReceipt(step);
    const phase=receipt?.after ? "after" : receipt?.before ? "before" : undefined;
    if (!phase || !step?.runId || requestedEvidence.has(step.id) || findingEvidence.has(step.id)) return;
    requestedEvidence.add(step.id);
    send({type:"explorationEvidence",id:report.id,stepId:step.id,phase,receiptIndex});
}

function frameButtons(stepId, receipt, index, t, busy) {
    return ["before","after"].filter(phase=>receipt[phase]).map(phase=>
        action("evidence", phase === "before" ? t.xBefore : t.xAfter, {
            disabled:busy, attrs:{"data-id":stepId,"data-phase":phase,"data-index":index},
        })).join("");
}

function frameEvidence(evidence,t) {
    if (!evidence?.page) return "";
    const { page, phase }=evidence;
    return `<h3>${h(t.xEvidence)} · ${h(phase==="before" ? t.xBefore : t.xAfter)}</h3>
        ${page.truncated ? `<small>${h(t.xPartial)}</small>` : ""}
        <ul>${page.nodes.map(node=>`<li><strong>${h(node.label || node.type)}</strong> <small>${h(node.id || "")}</small></li>`).join("")}</ul>`;
}

function trace(report,evidence,t,busy,routes) {
    if (!report.steps.length) return `<p class="empty">${h(t.xNoSteps)}</p>`;
    const chosen=report.steps.find(step=>step.id===selectedStep);
    return `<ol class="x-timeline">${report.steps.map((step,i)=>{
        const open=chosen===step;
        const saved=evidence?.stepId===step.id && (!evidence.id || evidence.id===report.id) ? evidence : null;
        return `<li><button type="button" class="x-trace-row" data-x="step" data-id="${h(step.id)}" aria-expanded="${open}">
            <small>${i+1}</small><span><strong>${h(step.label)}</strong>
            <small>${h([step.from,step.to].filter(Boolean).join(" → "))}</small></span><small>${h(status(step.status,t))}</small></button>
            ${open ? `<div class="x-step-detail">${step.reason ? `<p>${h(step.reason)}</p>` : ""}
                ${routes?.stepIds?.includes(step.id) ? action("caseStep",t.xSaveCaseToStep,{disabled:busy,attrs:{"data-id":step.id}}) : ""}
                ${step.error ? `<p>${h(step.error)}</p>` : ""}${step.receipts?.length ? `<h3>${h(t.xReceipts)}</h3><ol class="x-receipts">
                ${step.receipts.map((r,index)=>`<li><strong>${h(t[r.command] || t[r.kind] || r.command || r.kind)}</strong> · ${h(status(r.status,t))}
                    ${r.selector ? `<small>${h(valueText(r.selector))}</small>` : ""}
                    ${step.runId ? `<button type="button" data-net="explorationStep" data-id="${h(step.id)}" data-receipt="${index}" ${off(busy)}>${h(t.netStep)}</button>` : ""}
                    ${r.expected !== undefined || r.actual !== undefined ? `<dl class="x-pairs">${pair(t.expected,r.expected)}${pair(t.actual,r.actual)}</dl>` : ""}
                    ${step.receipts.length > 1 && step.runId ? `<div class="toolbar">${frameButtons(step.id,r,index,t,busy)}</div>` : ""}
                    ${saved?.receiptIndex===index ? frameEvidence(saved,t) : ""}</li>`).join("")}
                </ol>` : ""}
                ${step.runId && !(step.receipts?.length>1) ? `<div class="toolbar">${frameButtons(step.id,step,undefined,t,busy)}</div>` : ""}
                ${saved?.receiptIndex===undefined ? frameEvidence(saved,t) : ""}</div>` : ""}</li>`;
    }).join("")}</ol>`;
}

function reportView(model,t,exportClip) {
    const r=model.exploration;
    if (reportId !== r.id) {
        reportId=r.id; selectedStep=undefined; findingNotes.clear(); findingEvidence.clear(); requestedEvidence.clear();
        tab=r.findings.length && r.status!=="running" ? "findings" : "coverage";
    }
    if (model.explorationEvidence?.id===r.id) findingEvidence.set(model.explorationEvidence.stepId,model.explorationEvidence);
    const running=["ready","running"].includes(r.status), paused=r.status==="paused";
    const latest=r.pending || r.steps.at(-1);
    const connected=model.device && (!r.device || model.device===r.device) && model.devices.includes(model.device);
    const actions=running ? action("pause",t.xPause) + action("stop",t.xStop) : paused ?
        action("resume",t.xResume,{primary:true,disabled:!connected || model.busy}) + action("stop",t.xStop) :
        action("new",t.xNew,{primary:true,disabled:model.busy});
    const tabs = {
        id: "exploration-report", className: "x-tabs", label: t.xReport, active: tab,
        items: [["coverage",t.xCoverage],["findings",t.xFindings+" · "+r.findings.length],["trace",t.xTrace]]
            .map(([id,label]) => ({id,label,data:{x:"tab",id}})),
    };
    const contents = tab === "findings" ? findings(model,t) : tab === "trace" ?
        trace(r,model.explorationEvidence,t,model.busy,model.explorationCaseRoutes) : coverage(r,t);
    const hint = running && tab !== "coverage" && r.steps.length ? `<p class="x-note">${h(t.xPauseForEvidence)}</p>` : "";
    return `<section class="x-explore x-report"><header class="stage-head">
        <p class="kicker">${h(r.mode==="flow" ? t.xGuided : t.xFree)}</p>
        <h1>${h(r.goal || (running || paused ? t.xExplore : t.xReport))}</h1>
        <div class="x-meta"><strong role="status">${h(status(r.status,t))}</strong>
            <span>${h(format(t.xInputCount,{n:r.inputs,max:r.maxInputs}))}</span></div>
        ${r.reason ? `<p class="guide-copy">${h(r.reason)}</p>` : ""}
        ${r.currentPage ? `<p class="guide-copy">${h(t.xCurrentPage)} · ${h(r.currentPage)}</p>` : ""}
        ${running ? `<div class="x-activity"><small>${h(r.pending ? t.xNow : t.xLatest)}</small><strong>${h(latest?.label || t.xWatching)}</strong>
            ${latest?.reason ? `<p>${h(latest.reason)}</p>` : ""}</div>` : ""}
        <div class="toolbar">${model.explorationCaseRoutes?.main && !running ? action("caseMain",r.mode==="flow"?t.xSaveMainCase:t.xSavePathCase,{disabled:model.busy}) : ""}${actions}${paused && !connected ? `<small>${h(t.xResumeDevice)}</small>` : ""}</div>
        ${!running && r.steps.length && exportClip ? exportClip(selectedStep) : ""}</header>
        ${r.branches?.length ? `<details id="x-branches"><summary>${h(t.xBranch)} · ${r.branches.length}</summary>
            <ul class="x-branch-list">${r.branches.map(b=>`<li><span>${h(b.label)}</span> <small>${h(status(b.status,t))}</small>
                ${b.reason ? `<p>${h(b.reason)}</p>` : ""}
                ${b.id!=="baseline" && model.explorationCaseRoutes?.branchIds?.includes(b.id) ? action("caseBranch",t.xSaveBranchCase,{disabled:model.busy,attrs:{"data-id":b.id}}) : ""}</li>`).join("")}</ul></details>` : ""}
        ${tabList(tabs)}${tabPanels(tabs,hint+contents)}</section>`;
}

export function explorationView(model,t,exportClip,language) {
    const current = model.exploration ? reportView(model,t,exportClip) : setupView(model,t);
    return current + explorationHistory(model,t,language);
}

export function exploreClick(el, model, send, render) {
    const { x, id, phase }=el.dataset;
    if (!x) return false;
    if (x==="mode") {
        setup.mode=id;
        if (id==="flow" && model.plan && (!model.explorationFlow || (model.explorationFlow.source==="current" &&
            model.explorationFlow.sourceUri!==model.plan.uri)))
            send({type:"explorationFlow",source:"current"});
        render();
    }
    if (x==="flow") {
        send({type:"explorationFlow",source:el.dataset.source,uri:id,description:setup.description.trim()});
        el.closest?.("#x-case-source")?.removeAttribute("open");
    }
    if (x==="stopDraft") send({type:"explorationStop"});
    if (x==="update") send({type:"explorationFlow",source:"json",planJson:setup.planJson,name:model.explorationFlow?.name});
    if (x==="start" && !unavailable(model)) {
        const form=el.form;
        if (!form.checkValidity()) { document.getElementById("x-limits").open=true; form.reportValidity(); return true; }
        const group = form.querySelector("#x-rule-group:checked");
        send({type:"explorationStart",mode:setup.mode,focus:setup.focus.trim(),maxActions:Number(setup.maxActions),
            ...(group && {ruleGroupId:group.dataset.group,ruleGroupVersion:Number(group.dataset.version)}),
            maxMinutes:Number(setup.maxMinutes),...(setup.mode==="flow" && {flowId:setup.flowId,planJson:setup.planJson,checkpoints:setup.checkpoints})});
    }
    if (x==="new") {
        setup.flowId=undefined; setup.focus=setup.description=setup.original=setup.planJson="";
        setup.checkpoints=[]; setup.mode="free"; setup.group=undefined;
        send({type:"explorationNew"});
    }
    if (x==="report") send({type:"explorationReport",id});
    if (["pause","resume","stop"].includes(x)) send({type:{pause:"explorationPause",resume:"explorationResume",stop:"explorationStop"}[x],id:model.exploration.id});
    if (x==="save") send({type:"explorationSave",id:model.exploration.id,findingId:id});
    if (["caseMain","caseStep","caseBranch","caseFinding"].includes(x)) send({type:"explorationCase",id:model.exploration.id,
        ...(x==="caseStep" && {stepId:id}), ...(x==="caseBranch" && {branchId:id}), ...(x==="caseFinding" && {findingId:id})});
    if (x==="recheck") send({type:"explorationRecheck",id:model.exploration.id,findingId:id});
    if (x==="note" || x==="triage") {
        const item = model.exploration.findings.find(f => f.id===id);
        const ignored = x==="triage" ? item.reviewStatus!=="ignored" : item.reviewStatus==="ignored";
        send({type:"explorationTriage",id:model.exploration.id,findingId:id,reviewStatus:ignored ? "ignored" : "open",
            note:findingNotes.get(id) ?? item.note ?? ""});
    }
    if (x==="evidence") send({type:"explorationEvidence",id:model.exploration.id,stepId:id,phase,
        ...(el.dataset.index!==undefined && {receiptIndex:Number(el.dataset.index)})});
    if (x==="tab") { tab=id; render(); }
    if (x==="traceStep" || x==="step") {
        tab="trace"; selectedStep=x==="step" && selectedStep===id ? undefined : id; render();
        if (x==="traceStep") document.querySelector(`[data-x="step"][data-id="${CSS.escape(id)}"]`)?.focus();
    }
    return true;
}

export function exploreInput(el, model) {
    if (el.dataset.xNote) { findingNotes.set(el.dataset.xNote,el.value); return true; }
    if (el.dataset.checkpoint !== undefined) {
        const index=Number(el.dataset.checkpoint);
        setup.checkpoints=el.checked ? [...new Set([...setup.checkpoints,index])].sort((a,b)=>a-b) : setup.checkpoints.filter(n=>n!==index);
    } else {
        const key={"x-focus":"focus","x-description":"description","x-max-actions":"maxActions","x-max-minutes":"maxMinutes","x-json":"planJson"}[el.id];
        if (!key) return false;
        setup[key]=el.value;
        if (key==="description") {
            document.getElementById("x-prepare").disabled=!el.value.trim() || model.explorationWorking || model.busy;
        }
        if (key==="planJson") document.getElementById("x-edited").hidden=el.value===setup.original;
    }
    document.getElementById("x-start").disabled=unavailable(model);
    return true;
}

export function exploreChange(el) {
    if (el.id==="x-rule-group") {
        setup.group = el.checked ? {id:el.dataset.group,version:Number(el.dataset.version)} : undefined;
        return true;
    }
    return false;
}
