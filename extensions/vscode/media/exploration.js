import { tabList, tabPanels } from "./ui/tabs.js";
import { actionButton } from "./ui/controls.js";
import {ListSelection} from "./ui/listSelection.js";
import {guidedActivity, guidedComparison, guidedOutcome} from "./explorationRoutes.js";

const findingSelection = new ListSelection("exploration-findings");

// State local to the editor: unsubmitted inputs, the selected report section and trace step.
const setup = { mode: "free", focus: "", description: "", maxActions: "20", maxMinutes: "3",
    flowId: undefined, planJson: "", original: "", checkpoint: undefined, caseSearch:"" };

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
            <span>${h(run.mode === "flow" ? guidedOutcome(run,t) : status(run.status,t))}</span><time>${h(Number.isFinite(time.valueOf()) ? time.toLocaleString(language) : "")}</time>
            <span class="row-arrow" aria-hidden="true">›</span></button></li>`;
    });
    return rows.length ? `<details class="x-history" id="exploration-history"><summary>${h(t.xHistory)}</summary>
        <ul class="run-list">${rows.join("")}</ul></details>` : "";
}

function synchronizeFlow(flow) {
    if (flow?.id === setup.flowId) return;
    setup.flowId = flow?.id;
    setup.caseSearch = "";
    if (flow) setup.mode = "flow";
    if (flow?.description) setup.description = flow.description;
    setup.original = flow?.plan ? JSON.stringify(flow.plan, null, 2) : "";
    setup.planJson = setup.original;
    setup.checkpoint = flow?.defaultCheckpoints?.[0];
}

function forkPositions(flow,t,busy) {
    if (!flow?.checkpoints.length) return "";
    const selected=flow.checkpoints.find(point=>point.index===setup.checkpoint);
    const row=(point,showReason)=>{
        const position=point.position ?? point.index+1;
        return `<label class="x-checkpoint"><input type="radio" name="x-checkpoint" id="x-checkpoint-${h(point.index)}"
            data-checkpoint="${h(point.index)}" ${point===selected?"checked":""}${off(busy || point.blockedReason || flow.blockedReason)}>
            <span>${point.index===-1 ? h(t.xCaseBeginning) : h(format(t.xStepPosition,{n:position,label:point.label}))}
            ${showReason && point.blockedReason ? `<small>${h(point.blockedReason)}</small>` : ""}</span></label>`;
    };
    const groups=[];
    for (const point of flow.checkpoints) {
        const last=groups.at(-1);
        if (point.blockedReason && last?.[0].blockedReason===point.blockedReason) last.push(point);
        else groups.push([point]);
    }
    const points=groups.map(group=>{
        const first=group[0],last=group.at(-1);
        if (group.length===1) return row(first,!flow.blockedReason);
        const label=format(t.xUnavailableRange,{from:first.position ?? first.index+1,to:last.position ?? last.index+1});
        return `<div class="x-disabled-range"><details id="x-unavailable-${h(first.index)}"><summary>${h(label)}</summary>
            ${group.map(point=>row(point,false)).join("")}</details>${flow.blockedReason ? "" : `<small>${h(first.blockedReason)}</small>`}</div>`;
    }).join("");
    const hint=selected && !selected.blockedReason && !flow.blockedReason ? selected.index===-1 ? t.xBeforeFirst :
        format(t.xPrefixTo,{n:selected.position ?? selected.index+1,label:selected.label}) : "";
    return `<fieldset class="x-checkpoints"><legend>${h(t.xAnchors)}</legend>
        <div class="x-position-list">${points}</div></fieldset>${hint ? `<p class="x-prefix-preview">${h(hint)}</p>` : ""}`;
}

function flowControls(model,t) {
    const flow = model.explorationFlow;
    const busy = model.busy || model.explorationWorking;
    const cases = model.cases || [];
    const current = model.plan && !cases.some(entry=>entry.uri===model.plan.uri);
    const entries = current ? [model.plan,...cases] : cases;
    const query = setup.caseSearch.trim().toLocaleLowerCase();
    const matches=entry=>[entry.name,entry.location].filter(Boolean).join(" ").toLocaleLowerCase();
    const choices=entries.map(entry=>{
        const selected=entry.uri===flow?.sourceUri;
        const label=entry.name + (entry.draft ? " · "+t.xCaseDraft : "");
        const button = actionButton(label,{quiet:true,className:"x-case-choice",disabled:busy,
            attrs:{"id":`x-case-${encodeURIComponent(entry.uri)}`,"data-x":"flow","data-source":current && entry===model.plan ? "current" : "case","data-id":entry.uri,"aria-current":selected?"true":undefined,
                title:entry.draft ? t.xSetupDraft : entry.location}});
        const needle=matches(entry);
        return `<div data-case-search-value="${h(needle)}" ${needle.includes(query) ? "" : "hidden"}>${button}</div>`;
    }).join("");
    const sourcePicker = `<details id="x-more-sources" ${entries.length||flow?"":"open"}><summary>${h(t.xOtherSources)}</summary>
        <div class="toolbar">${action("flow",t.xPickFile,{disabled:busy,attrs:{"data-source":"file"}})}</div>
        <label>${h(t.xPrompt)}<textarea id="x-description" rows="3" placeholder="${h(t.xPromptExample)}"${off(busy)}>${h(setup.description)}</textarea></label>
        ${action("flow",t.xPrepare,{disabled:busy || model.draft || !setup.description.trim(),attrs:{id:"x-prepare","data-source":"text"}})}</details>`;
    const search = entries.length>1 ? `<input type="search" class="vscode-textfield" id="x-case-search" aria-label="${h(t.xSetupSearch)}" placeholder="${h(t.xSetupSearch)}" value="${h(setup.caseSearch)}">` : "";
    const loaded = flow && !entries.some(entry=>entry.uri===flow.sourceUri) ? `<p class="x-loaded-source"><strong>${h(flow.name)}</strong>${flow.source==="json" ? " · "+h(t.xEditedSource) : ""}</p>` : "";
    const picker = `<section id="x-case-source" aria-labelledby="x-source-title"><h2 id="x-source-title">${h(t.xSetupCase)}</h2>
        ${search}${choices ? `<div class="x-case-choices">${choices}</div><small id="x-case-no-match" ${entries.some(entry=>matches(entry).includes(query))?"hidden":""}>${h(t.xSetupNoMatch)}</small>` : ""}
        ${loaded}${sourcePicker}</section>`;
    return `<section class="x-flow" data-flow-id="${h(flow?.id)}">${picker}
        ${model.explorationSourceIssue ? `<p class="x-source-issue" role="status">${h(model.explorationSourceIssue)} ${flow ? h(format(t.xSetupRetained,{name:flow.name})) : ""}</p>` : ""}
        ${flow?.blockedReason ? `<p class="x-source-issue" id="x-flow-blocked" role="status">${h(flow.blockedReason)}</p>` : ""}
        ${model.explorationWorking ? `<div class="toolbar"><p class="muted" role="status">${h(t.xBusyPrepare)}</p>${action("stopDraft",t.xStopDraft)}</div>` : ""}
        ${forkPositions(flow,t,busy)}${!flow?.missingFile && (flow?.blockedReason || flow?.checkpoints.some(p=>p.blockedReason)) && cases.some(entry=>entry.uri===flow.sourceUri) ?
            actionButton(t.xOpenSourceCase,{quiet:true,disabled:busy || model.draft,attrs:{"data-x":"openSourceCase","data-id":flow.sourceUri}}) : ""}
        ${flow?.externalScenario ? `<p class="x-note">${h(t.xSetupBinding)}</p>` : ""}</section>`;
}

function disabledReason(model,t) {
    if (model.busy || model.explorationWorking) return t.xSetupWaiting;
    if (model.draft) return t.xFinishRecording;
    if (setup.mode === "flow") {
        if (!model.explorationFlow) return t.xChooseCase;
        if (setup.original !== setup.planJson) return t.xPlanEdited;
        if (model.explorationFlow.blockedReason) return model.explorationFlow.blockedReason;
        if (!model.explorationFlow.checkpoints.some(point=>point.index===setup.checkpoint && !point.blockedReason)) return t.xStartHelp;
    }
    if (!model.device || !model.devices?.includes(model.device)) return t.xConnect;
    return "";
}

function setupView(model,t) {
    synchronizeFlow(model.explorationFlow);
    const guided = setup.mode === "flow";
    const busy = model.busy || model.explorationWorking;
    const reason = disabledReason(model,t);
    const dirty = setup.planJson!==setup.original;
    return `<section class="x-explore x-setup"><h1>${h(t.xExplore)}</h1>
        <fieldset class="x-modes"><legend>${h(t.xMode)}</legend>
            ${[["free",t.xFree],["flow",t.xGuided]].map(([key,name])=>`<label class="x-mode"><input type="radio"
                name="x-mode" id="x-mode-${key}" value="${key}" data-x="mode" data-id="${key}" ${setup.mode===key ? "checked" : ""}${off(busy)}>
                <span>${h(name)}</span></label>`).join("")}</fieldset>
        <p class="x-guide">${h(guided ? t.xGuidedHint : t.xSetupHint)}</p>
        <form id="x-setup-form">${guided ? flowControls(model,t) : ""}
            <label>${h(t.xFocus)}<textarea id="x-focus" rows="2" placeholder="${h(guided ? t.xSetupFocusExample : t.xFocusExample)}"${off(busy)}>${h(setup.focus)}</textarea></label>
            <details id="x-limits"><summary>${h(guided ? t.xSetupAdvanced : t.xLimits)}</summary><div class="x-budgets">
                <label>${h(t.xInputs)}<input class="vscode-textfield" id="x-max-actions" type="number" min="1" max="100" step="1" required value="${h(setup.maxActions)}"${off(busy)}></label>
                <label>${h(t.xMinutes)}<input class="vscode-textfield" id="x-max-minutes" type="number" min="1" max="30" step="1" required value="${h(setup.maxMinutes)}"${off(busy)}></label></div>
                ${guided && model.explorationFlow?.plan ? `<details id="x-plan-editor"><summary>${h(t.xEdit)}</summary><textarea id="x-json" rows="8" spellcheck="false" aria-label="${h(t.xEdit)}"${off(busy)}>${h(setup.planJson)}</textarea>
                    <div class="toolbar" id="x-edited" ${dirty ? "" : "hidden"}>${action("update",t.xUpdate,{disabled:busy})}<small>${h(t.xPlanEdited)}</small></div></details>` : ""}</details>
            <div class="toolbar x-start-actions">${action("start",guided ? t.xSetupStart : t.xStart,{primary:true,disabled:Boolean(reason),attrs:{id:"x-start","aria-describedby":
                guided && model.explorationFlow?.blockedReason ? "x-flow-blocked x-start-reason" : "x-start-reason"}})}
                <small id="x-start-reason" role="status">${h(guided && model.explorationFlow?.blockedReason===reason ? "" : reason)}</small></div>
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

function findings(model,t,language) {
    const report = model.exploration, busy = model.busy;
    if (!report.findings.length) return `<p class="empty">${h(t.xNoFindings)}</p>`;
    const w=(en,zh)=>/^zh/i.test(language) ? zh : en;
    const review=report.findings.filter(item=>item.kind==="review");
    findingSelection.update(report.id,review.map(item=>item.id),busy || report.status==="running");
    const picked=new Set(findingSelection.values);
    const triage=(id,label,reviewStatus)=>({id,label,
        disabled:!review.some(item=>picked.has(item.id) && (item.reviewStatus || "open")!==reviewStatus),
        message:findingIds=>({type:"explorationTriage",id:report.id,findingIds,reviewStatus})});
    const tools=findingSelection.tools(w,[triage("ignore",w("Ignore selected","忽略所选"),"ignored"),
        triage("reopen",w("Reopen selected","重新打开所选"),"open")]);
    return tools+report.findings.map((item,i)=>{
        const step=report.steps.find(s=>s.id===item.stepId);
        const ignored=item.reviewStatus==="ignored";
        const attrs={"data-id":item.id};
        const canAct=!busy && model.device===report.device && model.devices.includes(report.device) &&
            ["completed","stopped","blocked"].includes(report.status);
        const {receipt,receiptIndex}=findingReceipt(step);
        const evidence=findingEvidence.get(step?.id);
        const check=findingSelection.checkbox(item.id,w("Select ","选择 ")+item.title);
        const row=findingSelection.row(item.id);
        const preview=check && findingSelection.previewId===item.id;
        const card=`<details class="x-finding" id="x-finding-${check ? "pick-" : ""}${i}" data-finding-id="${h(item.id)}"${check ? "" : row}${preview ? " open" : ""} data-item-actions="finding"
            data-item-label="${h(item.title)}"><summary${check ? " data-selection-hit" : ""}><span class="x-kind" data-kind="${h(ignored ? "ignored" : item.kind)}">${h(ignored ? t.xIgnored : status(item.kind,t))}</span>
            <strong>${h(item.title)}</strong></summary><div class="x-finding-detail" data-selection-ignore data-selection-detail><dl class="x-pairs">
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
            ${model.explorationCaseRoutes?.findingIds?.includes(item.id) ? action("caseFinding",report.mode==="flow" ? t.xRouteSave : t.xSaveCase,{disabled:busy,attrs})+
                (report.mode!=="flow" && model.cases?.some(c=>c.editable)?action("insertFinding",t.xInsertCase,{disabled:busy,attrs}):"") : ""}
            ${(item.regression || item.plan) ? action("save",report.mockScenario ? t.xSaveWithGroup : t.xSave,{disabled:busy,attrs}) : ""}</div></div></details>`;
        return check ? `<div class="x-finding-selection"${row}>${check}${card}</div>` : card;
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

function inputBudget(report, t) {
    if (!Number.isFinite(report.inputs) || report.inputs < 0) return "";
    const used = report.inputs;
    const limit = report.maxInputs;
    const limited = Number.isFinite(limit) && limit > 0;
    const prefix = report.prefixInputs;
    return `<div class="x-input-budget"><small>${h(limited ? t.xInputBudget : t.xInputs)}</small>
        <div class="x-input-reading"><strong>${h(used)}</strong>${limited ? `<span>/ ${h(limit)}</span>` : ""}</div>
        ${limited ? `<meter min="0" max="${h(limit)}" value="${h(Math.min(used,limit))}" aria-hidden="true"></meter>` : ""}
        ${Number.isFinite(prefix) && prefix > 0 ? `<small>${h(format(t.xPrefixInputs,{n:prefix}))}</small>` : ""}</div>`;
}

function sessionReadout(report, t, outcome, reason) {
    const active = ["ready", "running"].includes(report.status);
    const latest = report.steps.at(-1);
    const pending = (active || report.status === "paused") && report.pending;
    const guided = report.mode === "flow";
    const step = pending?.label ? pending : active && !guided ? latest : undefined;
    const caption = step === pending ? t.xPendingAction : t.xLatest;
    const budget = inputBudget(report, t);
    const summary = !active && report.status !== "paused";
    return `<div class="x-readout${summary ? " x-summary-readout" : ""}${budget ? " x-with-budget" : ""}">
        <div class="x-readout-main"><p class="x-session-status" role="status">${h(outcome)}</p>
        ${active && guided ? `<p class="x-guided-activity" role="status">${h(guidedActivity(report,t))}</p>` : ""}
        ${step?.label ? `<p class="x-action-label">${h(caption)}${step === latest && step.status ? " · " + h(status(step.status,t)) : ""}</p>
            <strong class="x-action-name">${h(step.label)}</strong>` : ""}
        ${step?.reason ? `<p class="x-action-reason">${h(step.reason)}</p>` : ""}
        ${active && !guided && !step && outcome !== t.xWatching ? `<p class="x-guided-activity">${h(t.xWatching)}</p>` : ""}
        ${reason ? `<p class="guide-copy">${h(reason)}</p>` : ""}
        ${report.currentPage ? `<p class="x-screen-name"><span>${h(active ? t.xCurrentPage : t.xRecordedPage)}</span> ${h(report.currentPage)}</p>` : ""}
        </div>${budget}</div>`;
}

function reportView(model,t,exportClip,language) {
    const r=model.exploration;
    const guided=r.mode==="flow";
    if (reportId !== r.id) {
        reportId=r.id; selectedStep=undefined; findingNotes.clear(); findingEvidence.clear(); requestedEvidence.clear();
        tab=guided ? "routes" : r.status==="running" && r.steps.length ? "trace" :
            r.findings.length && r.status!=="running" ? "findings" : "coverage";
    }
    if (model.explorationEvidence?.id===r.id) findingEvidence.set(model.explorationEvidence.stepId,model.explorationEvidence);
    const running=["ready","running"].includes(r.status), paused=r.status==="paused";
    const outcome=guided ? guidedOutcome(r,t) : status(r.status,t);
    const reason=r.reason?.trim();
    const repeatsOutcome=reason && reason.replace(/[。.!]$/,"")===outcome.replace(/[。.!]$/,"");
    const explainStop=reason && (!guided || (r.routeStop!=="positionsExplored" && !repeatsOutcome));
    const connected=model.device && (!r.device || model.device===r.device) && model.devices.includes(model.device);
    const actions=running ? action("pause",t.xPause) + action("stop",t.xStop) : paused ?
        action("resume",t.xResume,{primary:true,disabled:!connected || model.busy}) + action("stop",t.xStop) :
        action("new",t.xNew,{primary:!guided,disabled:model.busy});
    const sections = [["coverage",t.xCoverage],["findings",t.xFindings+" · "+r.findings.length],["trace",t.xTrace]];
    if (guided) sections.unshift(["routes",r.routeMode==="fork" ? t.xForkRoutes : t.xRouteComparison]);
    const tabs = {
        id: "exploration-report", className: "x-tabs", label: t.xReport, active: tab,
        items: sections.map(([id,label]) => ({id,label,data:{x:"tab",id}})),
    };
    const contents = tab === "routes" ? guidedComparison(model,t) : tab === "findings" ? findings(model,t,language) : tab === "trace" ?
        trace(r,model.explorationEvidence,t,model.busy,model.explorationCaseRoutes) : coverage(r,t);
    const hint = running && ["findings","trace"].includes(tab) && r.steps.length ? `<p class="x-note">${h(t.xPauseForEvidence)}</p>` : "";
    return `<section class="x-explore x-report" data-session="${h(r.status)}"><header class="x-report-head">
        <div class="x-report-heading"><p class="kicker">${h(running || paused ? (guided ? t.xGuided : t.xFree) : t.xReport)}</p>
        <h1>${h((guided && r.source) || r.goal || (running || paused ? t.xExplore : t.xReport))}</h1>
        ${guided && r.source && r.goal && r.source!==r.goal ? `<p>${h(r.goal)}</p>` : ""}</div>
        <div class="toolbar">${!guided && model.explorationCaseRoutes?.main && !running ? action("caseMain",t.xSavePathCase,{disabled:model.busy})+
            (model.cases?.some(c=>c.editable)?action("insertMain",t.xInsertCase,{disabled:model.busy}):"") : ""}${actions}
            ${guided && r.sourceCase?.uri && !running && !paused ? action("viewSourceCase",t.xRouteSource,{disabled:model.busy}) : ""}
            ${paused && !connected ? `<small>${h(t.xResumeDevice)}</small>` : ""}</div></header>
        ${sessionReadout(r,t,outcome,explainStop ? reason : "")}
        ${!guided && !running && r.steps.length && exportClip ? exportClip(selectedStep) : ""}
        ${tabList(tabs)}${tabPanels(tabs,hint+contents)}
        ${guided && !running && r.steps.length && exportClip ? exportClip(selectedStep) : ""}</section>`;
}

export function explorationView(model,t,exportClip,language) {
    const current = model.exploration ? reportView(model,t,exportClip,language) : setupView(model,t);
    return current + explorationHistory(model,t,language);
}

export function exploreClick(el, model, send, render, t) {
    const { x, id, phase }=el.dataset;
    if (!x) return false;
    if (x==="mode") {
        setup.mode=id;
        render();
    }
    if (x==="flow") {
        if (id && id===model.explorationFlow?.sourceUri && !model.explorationFlow.blockedReason) return true;
        send({type:"explorationFlow",source:el.dataset.source,uri:id,description:setup.description.trim()});
    }
    if (x==="openSourceCase") send({type:"explorationOpenSourceCase",uri:id});
    if (x==="stopDraft") send({type:"explorationStop"});
    if (x==="update") send({type:"explorationFlow",source:"json",planJson:setup.planJson,name:model.explorationFlow?.name});
    if (x==="start" && !disabledReason(model,t)) {
        const form=el.form;
        if (!form.checkValidity()) { document.getElementById("x-limits").open=true; form.reportValidity(); return true; }
        send({type:"explorationStart",mode:setup.mode,focus:setup.focus.trim(),maxActions:Number(setup.maxActions),
            maxMinutes:Number(setup.maxMinutes),...(setup.mode==="flow" && {flowId:setup.flowId,planJson:setup.planJson,checkpoints:[setup.checkpoint]})});
    }
    if (x==="new") {
        setup.flowId=undefined; setup.focus=setup.description=setup.original=setup.planJson="";
        setup.checkpoint=undefined; setup.mode="free";
        send({type:"explorationNew"});
    }
    if (x==="report") send({type:"explorationReport",id});
    if (["pause","resume","stop"].includes(x)) send({type:{pause:"explorationPause",resume:"explorationResume",stop:"explorationStop"}[x],id:model.exploration.id});
    if (x==="save") send({type:"explorationSave",id:model.exploration.id,findingId:id});
    if (["caseMain","caseStep","caseBranch","caseFinding"].includes(x)) send({type:"explorationCase",id:model.exploration.id,
        ...(x==="caseStep" && {stepId:id}), ...(x==="caseBranch" && {branchId:id}), ...(x==="caseFinding" && {findingId:id})});
    if (["insertMain","insertBranch","insertFinding"].includes(x)) send({type:"caseCompose",action:"importReport",reportId:model.exploration.id,
        ...(x==="insertBranch" && {branchId:id}),...(x==="insertFinding" && {findingId:id})});
    if (x==="recheck") send({type:"explorationRecheck",id:model.exploration.id,findingId:id});
    if (x==="applyBranchDifference") send({type:"caseCompose",action:"reviewBranchDifference",reportId:model.exploration.id,branchId:id});
    if (x==="viewSourceCase") send({type:"caseCompose",action:"viewExplorationSource",reportId:model.exploration.id});
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

export function exploreInput(el, model, t) {
    if (el.dataset.xNote) { findingNotes.set(el.dataset.xNote,el.value); return true; }
    if (el.id==="x-case-search") {
        setup.caseSearch = el.value;
        const query = el.value.trim().toLocaleLowerCase();
        const rows = document.querySelectorAll("#x-case-source [data-case-search-value]");
        let matches = 0;
        for (const row of rows) {
            row.hidden = !row.dataset.caseSearchValue.includes(query);
            if (!row.hidden) matches++;
        }
        document.getElementById("x-case-no-match").hidden = matches>0;
        return true;
    }
    if (el.dataset.checkpoint !== undefined) {
        const index=Number(el.dataset.checkpoint);
        if (el.checked && model.explorationFlow?.checkpoints.some(p=>p.index===index && !p.blockedReason)) setup.checkpoint=index;
    } else {
        const key={"x-focus":"focus","x-description":"description","x-max-actions":"maxActions","x-max-minutes":"maxMinutes","x-json":"planJson"}[el.id];
        if (!key) return false;
        setup[key]=el.value;
        if (key==="description") {
            document.getElementById("x-prepare").disabled=Boolean(!el.value.trim() || model.explorationWorking || model.busy || model.draft);
        }
        if (key==="planJson") document.getElementById("x-edited").hidden=el.value===setup.original;
    }
    const reason = disabledReason(model,t);
    document.getElementById("x-start").disabled=Boolean(reason);
    document.getElementById("x-start-reason").textContent=setup.mode==="flow" && model.explorationFlow?.blockedReason===reason ? "" : reason;
    return true;
}
