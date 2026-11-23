import { vscode } from "./bridge.js";
import { pytestWorkflow } from "./pytestCase.js";
import { recordingWorkspace } from "./recordingWorkspace.js";
import { caseBddView, caseStepLabel, caseLibraryView, caseRunHistory, caseRunStatus, caseRunTime, isCaseRun } from "./caseLibrary.js";
import { caseReviewView, caseStepActions, stepEditArea, caseEditorClick, caseEditorInput, caseEditorSubmit,
    endCasePicture, selectCasePictureTarget } from "./caseAuthoring.js";
import { pytestPhases } from "./pytestReport.js";
import { repairView } from "./caseRepair.js";
import { failureView } from "./caseFailure.js";
import { networkView, networkClick, networkInput, networkOrder, requestMenuItems, requestFieldMenuItems, ruleGroupMenuItems } from "./networkView.js";
import { trafficKeydown } from "./networkTraffic.js";
import { tabKeydown, tabList } from "./ui/tabs.js";
import { actionButton } from "./ui/controls.js";
import { bindItemMenus, closeItemMenu, itemMenu, menuItems } from "./ui/itemActions.js";
import { bindListOrder, orderGrip, orderActions } from "./ui/listOrder.js";
import { workflowDebugView, flowDebugClick, evidenceExport } from "./flowDebug.js";
import { bindElements, updateElements, selectElement, rebindElement, elementControls, elementsFooter, elementClick, elementInput, elementMenuItems } from "./elements.js";
import { explorationView, exploreClick, exploreInput, exploreChange, exploreToggle } from "./exploration.js";

const shell = document.getElementById("app-shell");
const header = document.getElementById("station-header");
const root = document.getElementById("workbench");
const toolNav = document.getElementById("tool-navigation");
const toolContent = document.getElementById("tool-content");
let model;
let toolNavigation;
let t;
let language;
let hasBaseline;
let headerSignature = "";
let navigationSignature = "";
let contentSignature = "";
let explorationReturn;
let requestedWorkspaceTab;
let pendingFocus;
let requestedCaptureFocus;
let requestedCaseEdit;
let caseEditOrigin;
let pendingOrderFocus;
let dismissedReport;
let caseEvidence;
let inspectFilter = "";
let interactiveOnly = false;
const collapsedNodes = new Set();
const replacements = new Map();
const diagnosisGoals = new Map();
const caseRunners = new Map();
const selection = { ref: "", filter: "", start: "", goal: "", property: "visible", expected: "", visible: true, checksOpen: false, confirmDiscard: false };
const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const h = value => String(value ?? "").replace(/[&<>"']/g, character => entities[character]);
const status = value => t[value] || value || "—";
const word = (en, zh) => /^zh/i.test(language) ? zh : en;
const disabled = yes => (yes ? "disabled" : "");

function button(label, type, { off = false, primary = false, attrs } = {}) {
    return actionButton(label, {primary, disabled: model.busy || off, attrs: {"data-type": type, ...attrs}});
}

function clock(timestamp) {
    return timestamp ? new Date(timestamp).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

function commandName(command) {
    return t[command === "stop" ? "quit" : command] || command;
}

function artIcon(name) {
    const paths = {
        device: '<rect x="5" y="2" width="10" height="16" rx="2"/><path d="M9 15h2"/>',
        refresh: '<path d="M16 7a6.5 6.5 0 1 0 .3 5M16.5 3.5V7h-3.8"/>',
        history: '<path d="M2 9a7.5 7.5 0 1 1 .8 4M2 4.5V9h4.5M10 5.5v5l3.5 2"/>',
        back: '<path d="M15.5 10H4.5m5-5-5 5 5 5"/>',
        settings: '<path d="M3 5h7m4 0h3M3 10h2m4 0h8M3 15h9m4 0h1"/><circle cx="12" cy="5" r="2"/><circle cx="7" cy="10" r="2"/><circle cx="14" cy="15" r="2"/>',
        file: '<path d="M5 2.5h6.5L15 6v11.5H5zM11 3v4h4M7.5 10h5m-5 3h3"/>',
        search: '<circle cx="8.5" cy="8.5" r="5.2"/><path d="m12.3 12.3 4.2 4.2"/>',
        input: '<rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="M6 7.5v5"/>',
        press: '<rect x="3" y="5" width="14" height="10" rx="3"/><path d="M7 10h6"/>',
        scroll: '<path d="M5 3h10M5 17h10m-5-4V7m-2 2 2-2 2 2m-4 2 2 2 2-2"/>',
        element: '<rect x="4" y="4" width="12" height="12" rx="1.5"/><path d="M7 8h6m-6 3h4"/>',
    };
    return `<svg class="station-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function filteredNodes() {
    const query = inspectFilter.trim().toLowerCase();
    return (model.page?.nodes || []).filter(node =>
        (!interactiveOnly || node.pressable || node.editable || node.scrollable) &&
        [node.label, node.id, node.type, node.bundle].some(text => text?.toLowerCase().includes(query)));
}

function nodeList(nodes) {
    if (!nodes.length) return `<p class="node-empty">${h(model.page.nodes.length ? t.noMatchingNodes : t.stationNoNative)}</p>`;
    const visible = new Set(nodes.map(node=>node.ref)), children = new Map();
    for (const node of nodes) {
        const parent=visible.has(node.parent)?node.parent:undefined;
        if (!children.has(parent)) children.set(parent,[]);
        children.get(parent).push(node);
    }
    const rows = [];
    function branch(parent,level) {
        const siblings=children.get(parent)||[];
        siblings.forEach((node,index)=>{
            const hasChildren=children.has(node.ref);
            const expanded=hasChildren && (inspectFilter || interactiveOnly || !collapsedNodes.has(treeKey(node)));
            rows.push({node,parent,level,expanded,hasChildren,index,size:siblings.length});
            if (expanded) branch(node.ref,level+1);
        });
    }
    branch(undefined,1);
    const focus = rows.some(({node})=>node.ref===selection.ref) ? selection.ref : rows[0]?.node.ref;
    return rows.map(({node,parent,level,expanded,hasChildren,index,size})=>`
        <button type="button" role="treeitem" class="node-row depth-${Math.min(level-1,4)}" data-ref="${h(node.ref)}"
            data-item-actions="element" data-item-label="${h(node.label)}" aria-keyshortcuts="Shift+F10"
            data-node-parent="${h(parent)}" aria-level="${level}" aria-posinset="${index+1}" aria-setsize="${size}"
            aria-selected="${node.ref===selection.ref}" tabindex="${focus===node.ref?0:-1}" ${hasChildren?'aria-expanded="'+Boolean(expanded)+'"':""}
            ${disabled(model.busy)}>
            <span class="node-disclosure" aria-hidden="true" ${hasChildren&&!inspectFilter&&!interactiveOnly?"data-tree-toggle":""}>${hasChildren?(expanded?"▾":"▸"):""}</span>
            ${artIcon(node.editable ? "input" : node.scrollable ? "scroll" : node.pressable ? "press" : "element")}
            <span class="node-name">${h(node.label)}</span><small class="node-kind">${h(node.type)}</small></button>`).join("");
}

function treeKey(node) {
    return node.selector ? JSON.stringify(node.selector) : model.page.frameId+"/"+node.ref;
}

function toggleNode(row) {
    if (model.busy || inspectFilter || interactiveOnly) return;
    const node=model.page.nodes.find(item=>item.ref===row.dataset.ref);
    if (!node || !row.hasAttribute("aria-expanded")) return;
    const key=treeKey(node);
    if (collapsedNodes.has(key)) collapsedNodes.delete(key);
    else collapsedNodes.add(key);
    render();
    root.querySelector('.node-row[data-ref="'+CSS.escape(node.ref)+'"]')?.focus();
}

function revealNode(ref) {
    const nodes = new Map(model.page.nodes.map(node=>[node.ref,node]));
    const visited=new Set();
    for (let parent=nodes.get(nodes.get(ref)?.parent);parent && !visited.has(parent.ref);parent=nodes.get(parent.parent)) {
        visited.add(parent.ref);
        collapsedNodes.delete(treeKey(parent));
    }
}

function treeKeydown(event) {
    const row=event.target.closest(".node-row");
    if (!row || model.busy || !["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return false;
    const rows=[...root.querySelectorAll("#node-list .node-row")];
    const index=rows.indexOf(row), expanded=row.getAttribute("aria-expanded");
    event.preventDefault();
    if ((event.key==="ArrowLeft" && expanded==="true") || (event.key==="ArrowRight" && expanded==="false")) toggleNode(row);
    else {
        const next={ArrowUp:rows[index-1],ArrowDown:rows[index+1],Home:rows[0],End:rows.at(-1),
            ArrowLeft:rows.find(item=>item.dataset.ref===row.dataset.nodeParent),
            ArrowRight:rows.find(item=>item.dataset.nodeParent===row.dataset.ref)}[event.key];
        next?.click();
    }
    return true;
}

function image(view) {
    if (!view?.src) return "";
    return `<figure class="screenshot"><img src="${h(view.src)}" alt="${t.screenshot}">
        <figcaption>${t.screenshot} ${h(clock(view.capturedAt))}</figcaption></figure>`;
}

function nodeDetails(node) {
    if (!node) {
        const picture = model.elements?.picture;
        const canPick = model.elements?.picking && picture?.src && picture.frameId === model.page?.frameId;
        return `<p class="node-hint">${h(canPick ? t.stationPickOnScreen : t.stationPickNative)}</p>`;
    }
    const actions = [
        node.editable && `<div class="input-tools"><input id="replacement" type="text" value="${h(replacements.get(node.ref))}"
            aria-label="${h(t.enterText)}" placeholder="${h(t.enterText)}">${button(t.fill, "action", { primary: true, attrs: {"data-command":"fill"} })}</div>`,
        node.pressable && button(t.press, "action", { primary: !node.editable, attrs: {"data-command":"press"} }),
        node.scrollable && button(t.scrollUp, "action", { attrs: {"data-command":"scroll","data-direction":"up"} }),
        node.scrollable && button(t.scrollDown, "action", { attrs: {"data-command":"scroll","data-direction":"down"} }),
    ].filter(Boolean).join("");
    if (model.page?.elements) return `<section class="node-detail" aria-labelledby="selected-name">${elementControls(node,actions)}</section>`;
    const parent = model.page.nodes.find(other => other.ref === node.parent);
    const props = [["ID", node.id], [t.stationText, node.text], [t.stationBundle, node.bundle]]
        .filter(([, value]) => value).map(([name, value]) => `<dt>${h(name)}</dt><dd>${h(value)}</dd>`).join("");
    return `<section class="node-detail" aria-labelledby="selected-name">
        ${actions ? `<div class="node-actions">${actions}</div>` : `<p class="node-readonly">${h(t.stationReadOnly)}</p>`}
        <dl class="node-props">${props}${parent ? `<dt>${h(t.stationParent)}</dt><dd><button type="button" id="node-parent"
            data-type="parentControl" data-target="${h(parent.ref)}" ${disabled(model.busy)}>${h(parent.label)}</button></dd>` : ""}</dl>
        <details id="node-selector"><summary>${h(t.selector)}</summary>
        <code>${h(node.selector ? JSON.stringify(node.selector, null, 2) : t.noSelector)}</code></details></section>`;
}

function inspector() {
    const page = model.page;
    const selected = page?.nodes.find(node => node.ref === selection.ref);
    const tools = `<details id="inspector-tools"><summary>${h(t.stationSessionTools)}</summary><div class="inspector-menu">
        ${button(t.phoneBack, "action", { off: !page, attrs: {"data-command":"back"} })}
        ${button(t.openApp, "openApp", { off: !page })}${button(t.screenshot, "screenshot", { off: !page })}
        ${button(t.closeSession, "detach", { off: !model.device })}</div></details>`;
    const heading = `<div class="inspect-head"><div>${selected ? `<span class="inspect-caption">${h(t.stationSelected)}</span>` : ""}
        <h1 id="selected-name" tabindex="-1">${h(selected?.label || t.stationInspector)}</h1>
        ${selected?.type ? `<code class="selected-type">${h(selected.type)}</code>` : ""}</div>${tools}</div>`;
    const refresh = button(model.elements?.picking ? t.stationRefreshSnapshot : t.stationRefreshNodes, "observe", { off: !model.device });
    if (!page) return heading + `<section class="inspect-empty"><p role="status">${h(model.busy ? t.stationReadingControls : model.device ? t.stationAwaitControls : t.noObservation)}</p>${refresh}</section>`;
    const nodes = filteredNodes();
    const count = t.stationNodeCount.replace("{n}", nodes.length);
    const capture = model.liveImage?.src ? `<details id="inspector-capture"><summary>${h(t.screenshot)} · ${h(clock(model.liveImage.capturedAt))}</summary>${image(model.liveImage)}</details>` : "";
    const log = model.actions.length ? `<details id="inspector-log"><summary>${h(t.recentActions)} · ${model.actions.length}</summary>
        <ol>${model.actions.map(action => `<li>${h(commandName(action.command))} ${h(action.label)}</li>`).join("")}</ol></details>` : "";
    return `<div class="inspect-workspace"><section class="inspect-controls" aria-label="${h(t.stationInspector)}">
        <div class="inspect-search">${artIcon("search")}<input type="search" id="node-filter" aria-label="${h(t.searchNodes)}"
            placeholder="${h(t.searchNodes)}" value="${h(inspectFilter)}"></div>
        <div class="inspect-filters"><label><input type="checkbox" id="interactive-only" ${interactiveOnly ? "checked" : ""}>
            ${h(t.stationInteractiveOnly)}</label>${refresh}</div>
        <div class="node-meta"><span role="status" id="node-count">${h(count)}</span><span>${h(page.truncated ? t.partialTree : clock(page.capturedAt))}</span></div>
        <div class="node-list" id="node-list" role="tree" aria-label="${h(t.stationInspector)}">${nodeList(nodes)}</div></section>
        <div class="inspect-properties">${heading}<div id="node-info">${nodeDetails(selected)}</div></div></div>
        ${elementsFooter()}${capture}${log}`;
}

function elementOptions(nodes, ref) {
    return `<option value="">${t.skipCheck}</option>` + nodes.map(node =>
        `<option value="${h(node.ref)}" ${node.ref === ref ? "selected" : ""}>${h(node.label)}${node.id ? " · " + h(node.id) : ""}</option>`).join("");
}

function devicePicker() {
    const blocked = model.busy || Boolean(model.draft || model.caseReview);
    const captureActive = model.nativeCaptureActive || model.network?.capturing;
    const options = model.devices.map(id => `<option value="${h(id)}" ${id === model.device ? "selected" : ""}>${h(id)}</option>`).join("");
    const lookupLabel = model.discoveringDevices ? t.stationCheckingDevices : model.deviceLookupError ? t.stationDeviceLookupFailed : t.stationUnconnected;
    const device = options ? `<select data-field="device" aria-label="${h(t.selectDevice)}"
        title="${h(t.selectDevice)}" ${disabled(blocked || captureActive)}>
        ${model.devices.includes(model.device) ? "" : `<option value="">${h(t.selectDevice)}</option>`}${options}</select>` :
        `<span class="station-device-status" role="status" title="${h(model.deviceLookupError || lookupLabel)}">${h(lookupLabel)}</span>`;
    const refreshLabel = model.discoveringDevices ? t.stationCheckingDevices : t.refreshDevices;
    return `<div class="station-device">${artIcon("device")}${device}
        <button class="station-tool" type="button" data-type="devices" aria-label="${h(refreshLabel)}" title="${h(model.deviceLookupError || refreshLabel)}"
            ${disabled(model.busy || model.discoveringDevices)}>${artIcon("refresh")}</button></div>`;
}

function toolBack(surface) {
    const destination = {exploration:explorationReturn,"exploration-report":explorationReturn,network:model.network?.returnTo}[surface];
    const destinationLabel = { workflow:t.backRecordings, recordings:t.backRecordings,
        exploration:t.returnToStep,run:t.returnToStep,explore:t.stationBackPhone }[destination];
    return !destinationLabel || (toolNavigation.selected === "recordings" && (model.draft || model.caseReview)) ? "" : `<button type="button" class="station-link tool-back" data-type="view"
        data-view="${destination}" ${disabled(model.busy)}>${artIcon("back")}
        <span>${h(destinationLabel)}</span></button>`;
}

function topBar() {
    return `<div class="station-top-inner"><div class="station-identity"><span class="station-mark" aria-hidden="true"></span>
        <span>Harmony <strong>Agent</strong></span></div>${devicePicker()}<div class="station-utilities">
        <details class="station-settings"><summary class="station-tool" title="${h(t.stationSettings)}" aria-label="${h(t.stationSettings)}">
        ${artIcon("settings")}</summary><div class="station-menu">
        ${button(t.selectProjectRuntime + (model.runtimeName ? " · " + model.runtimeName : ""), "projectRuntime")}
        ${button(t.stationAiSettings, "aiSettings")}${button(t.loadSettings, "settings")}</div></details></div></div>`;
}

function stepInfo(step) {
    if (step.command === "deviceGesture" || step.gesture) {
        const g = step.gesture || step.input;
        const point = (x, y) => Number.isFinite(x) && Number.isFinite(y) ? `(${x}, ${y})` : "";
        const points = g.kind === "recents" ? "" : [point(g.x, g.y), point(g.toX, g.toY)].filter(Boolean).join(" → ");
        return { title: commandName(g.kind), detail: points || g.event || step.label || "" };
    }
    const title = step.command === "back" ? t.phoneBack : commandName(step.command);
    const scroll = { up: t.scrollUp, down: t.scrollDown, left: t.scrollLeft, right: t.scrollRight };
    return { title: step.label ? `${title} · ${step.label}` : title,
        detail: step.command === "scroll" ? scroll[step.input.direction] :
            step.command === "wait" ? `${step.input.property} = ${JSON.stringify(step.input.equals)}` : "" };
}

function recordedList(draft, editable) {
    const firstStep = draft.location === "phone" ? t.firstFinger :
        draft.stepFormat === "controls" ? t.firstControl : t.firstScreen;
    if (!draft.steps.length) return `<p class="list-placeholder">${h(firstStep)}</p>`;
    const reorder = editable && !model.busy && draft.steps.length>1;
    return `<ol class="action-log" ${reorder?'data-order-kind="recording" data-order-key="draft"':""}>${draft.steps.map((step, index) => {
        const info = stepInfo(step);
        const menu = editable ? itemMenu(word("Step actions","步骤操作"),
            (reorder?orderActions(word,index,draft.steps.length):"") +
            button(t.remove,"removeStep",{attrs:{"data-index":index,"data-revision":draft.stepRevision || 0}}),model.busy) : "";
        return `<li ${editable?`data-item-actions data-order-index="${index}" data-order-label="${h(info.title)}"`:""}>
            ${reorder?orderGrip(word):""}<div class="recorded-step-title"><strong>${h(info.title)}</strong>
            ${info.detail ? `<small>${h(info.detail)}</small>` : ""}</div>${menu}</li>`;
    }).join("")}</ol>`;
}

function recordableControls() {
    const query = selection.filter.toLowerCase();
    const nodes = (model.page?.nodes || []).filter(node => node.visible !== false && node.selector && (node.pressable || node.editable || node.scrollable) &&
        [node.label, node.id, node.type].some(v => v?.toLowerCase().includes(query)));
    if (!nodes.length) return `<p class="list-placeholder">${t.noRecordable}</p>`;
    return nodes.map(node => {
        const command = (label, name, attrs) => button(label, "action", { attrs: {"data-target":node.ref,"data-command":name,...attrs} });
        return `<div class="control-line"><div class="control-caption"><strong>${h(node.label)}</strong>
            ${node.id && node.id !== node.label ? `<small>${h(node.id)}</small>` : ""}</div><div class="control-buttons">
            ${node.pressable ? command(t.tap, "press", {"aria-label":t.tap + " · " + node.label}) : ""}
            ${node.scrollable ? command(t.scrollUp, "scroll", {"data-direction":"up"}) + command(t.scrollDown, "scroll", {"data-direction":"down"}) : ""}
            ${node.editable ? `<label class="input-tools"><input type="text" data-replacement data-target="${h(node.ref)}" value="${h(replacements.get(node.ref))}" aria-label="${t.enterText}" placeholder="${t.enterText}">
                ${command(t.fill, "fill")}</label>` : ""}</div></div>`;
    }).join("");
}

function recordingDimensions(draft) {
    const location = draft.location === "phone" ? t.recordLocationPhone : t.recordLocationPreview;
    const format = draft.stepFormat === "controls" ? t.recordFormatControls : t.recordFormatCoordinates;
    return h(location + " · " + format);
}

function recordingStage() {
    const draft = model.draft;
    const coordinates = draft.stepFormat === "coordinates";
    const n = draft.steps.length;
    const count = t.counter.replace("{n}", n);
    const finish = button(t.finish, "stopRecord", { primary: true });
    const tools = finish + button(n ? t.discard : t.cancelEmpty, "askDiscard");
    return `<div class="rec-stage"><header class="stage-head"><div>
        <div class="record-status"><i aria-hidden="true"></i>${recordingDimensions(draft)}</div>
        <h1 aria-live="polite">${h(count)}</h1></div><div class="toolbar">${tools}</div></header>
        <div class="${coordinates ? 'gesture-layout' : 'record-layout'}">
        ${coordinates ? "" : `<section class="control-section"><div class="section-header"><h2>${t.controls}</h2>
            <div class="toolbar">${button(t.phoneBack, "action", { off: !model.page, attrs: {"data-command":"back"} })}
            ${button(model.page ? t.refreshPage : t.checkDevice, "observe")}</div></div>
            ${model.page ? `<input type="search" id="control-filter" value="${h(selection.filter)}" aria-label="${t.searchControls}" placeholder="${t.searchControls}">
                <div id="record-controls">${recordableControls()}</div>` : `<p class="list-placeholder">${t.checkDevice}</p>`}</section>`}
        <section class="log-section" aria-label="${h(count)}"><div id="live-step-log">${recordedList(draft, false)}</div>
            ${draft.location === "phone" ? `<small class="native-note">${t.scopedPhone}</small>` : ""}</section></div></div>`;
}

function reviewRecording(draft) {
    const coordinates = draft.stepFormat === "coordinates";
    const dimensions = recordingDimensions(draft);
    if (!draft.steps.length) return `<section class="record-home"><p class="kicker">${dimensions}</p><h1>${t.reviewTitle}</h1>
        <p class="guide-copy">${coordinates ? t.reviewEmpty : t.reviewEmptyControls}</p>
        ${button(t.startAgain, "discardRecord", { primary: true })}</section>`;
    const unsupported = draft.steps.some(step => step.input?.kind === "unsupported");
    return `<section class="review-stage"><header class="stage-head"><div><p class="kicker">${dimensions}</p><h1>${t.reviewTitle}</h1>
        <p class="guide-copy">${t.reviewHint}</p></div><div class="toolbar">${button(word("Save as test case","保存为测试用例"), "caseReview", {primary:true,off:unsupported})}${button(t.saveRecording, "savePlan", {off:unsupported})}${button(t.discard, "askDiscard")}</div></header>
        <div class="review-body"><section><h2>${h(t.counter.replace("{n}", draft.steps.length))}</h2>${recordedList(draft,true)}</section>
        <div>${coordinates ? `<p class="setup-note">${unsupported ? t.unsupportedHint : t.phoneScreenHint}</p>` : checksForm(draft)}
        </div></div></section>`;
}

function checksForm(draft) {
    return `<div><details class="conditions optional-checks" id="check-options" ${selection.checksOpen ? "open" : ""}>
        <summary>${t.optionalChecks}</summary><p class="guide-copy">${t.checksHint}</p>
        <label>${t.startCondition}<select id="start-condition" data-field="start">${elementOptions(draft.start, selection.start)}</select></label>
        <label>${t.expectedResult}<select id="goal-condition" data-field="goal">${elementOptions(draft.end || [], selection.goal)}</select></label>
        ${!selection.goal ? "" : `<label>${t.property}<select id="goal-property" data-field="property">
            <option value="visible" ${selection.property === "visible" ? "selected" : ""}>${t.visible}</option>
            <option value="text" ${selection.property === "text" ? "selected" : ""}>${t.text}</option></select></label>
        <label>${t.expected}${selection.property === "text" ? `<input id="expected-value" data-field="expected" value="${h(selection.expected)}">` :
        `<select data-field="visible"><option value="true" ${selection.visible ? "selected" : ""}>${t.yes}</option><option value="false" ${selection.visible ? "" : "selected"}>${t.no}</option></select>`}</label>`}
        </details>${draft.end?.length ? inlineAI("check", t.stationAiCheck, model.aiResults?.check) : ""}</div>`;
}

const aiWorking = result => ["running","stopping"].includes(result?.status);

function aiStop(result) {
    return aiWorking(result) ? actionButton(t.stopTask,{attrs:{"data-type":"cancelAI"},disabled:result.status==="stopping"}) : "";
}

function aiOutput(result,key) {
    if (!result) return "";
    const waiting = result?.waitingForModel === "retry" ? t.modelRetry :
        result?.waitingForModel && t.modelReviewing.replace("{provider}", result.provider === "codex" ? "Codex" : "GitHub Copilot");
    const reads = result?.evidence || [];
    const evidenceLink = receipt=>{
        if (!result.next) return "";
        if (receipt.id==="passingPage" && receipt.status==="read")
            return button(word("Open passing run","查看通过的报告"),"report",{attrs:{"data-id":receipt.runId}});
        if (Number.isInteger(receipt.index) && receipt.runId===model.run?.entry.id)
            return button(word("Open step evidence","查看步骤证据"),"showFailureStep",
                {attrs:{"data-index":receipt.index,"data-phase":receipt.phase}});
        return "";
    };
    return `${aiWorking(result) ? `<p role="status">${h(result.status === "stopping" ? t.taskStopping : waiting || result.steps.at(-1) || t.taskThinking)}</p>` : ""}
        ${result?.status === "cancelled" ? `<p>${h(t.taskCancelled)}</p>` : ""}
        ${result?.answer ? `<p class="ai-answer" role="status">${h(result.answer)}</p>` : ""}
        ${reads.length ? `<details id="diagnosis-evidence-${h(key)}"><summary>${h(t.aiEvidenceRead)} · ${reads.length}</summary>
            ${reads.map(r=>`<p class="ai-answer">${h(r.text)}</p>${evidenceLink(r)}${(r.records || []).map(row=>
                button(t.aiOpenRecord+" · "+row.method+" "+row.route+" · "+row.status,"networkEvidenceRecord",{attrs:{"data-id":row.id}})).join("")}`).join("")}
            ${reads.some(r=>r.kind==="http") ? `<small>${h(t.aiEvidenceScope)}</small>` : ""}</details>` : ""}`;
}

function inlineAI(kind, label, result) {
    const check = result?.check;
    const chosen = check && selection.goal === check.ref && selection.property === check.property &&
        (check.property === "text" ? selection.expected === check.expected : selection.visible === check.expected);
    const key = kind === "diagnosis" && model.run.entry.id + "/" + model.run.selected;
    return `<section class="inline-ai">${key ? `<label for="ai-diagnosis-goal">${h(t.aiDiagnosisGoal)}</label>
        <input id="ai-diagnosis-goal" data-diagnosis="${h(key)}" value="${h(diagnosisGoals.get(key) ?? result?.goal ?? "")}"
        placeholder="${h(t.aiDiagnosisExample)}" maxlength="1200" ${disabled(aiWorking(result))}>` : ""}<div class="toolbar">
        ${button(label, kind === "check" ? "suggestCheck" : "explainStep")}${aiStop(result)}</div>
        ${aiOutput(result,key)}
        ${check ? `<p><strong>${h(check.label)}</strong> · ${h(check.property)} = <code>${h(JSON.stringify(check.expected))}</code></p>
        ${button(chosen ? t.checkUsed : t.applyCheck, "applyCheck", { off: chosen })}` : ""}</section>`;
}

function planPreview(summary) {
    if (!summary) return "";
    if (summary.error) return `<p class="setup-note" role="status">${h(summary.error)}</p>`;
    const names = { transform: t.stationTransform, stop: t.quit };
    const controlFlow = (summary.controlFlow || []).map(kind => kind === "if" ? t.stationBranch : t.stationLoop);
    const rows=summary.rows || (summary.debugSteps || summary.commands || []).map(kind=>({kind}));
    const draw=items=>items.map(({kind,detail})=>`<li><div><strong>${h(names[kind] || t[kind] || t.stationOtherStep)}</strong>${detail?`<span> · ${h(detail)}</span>`:""}</div></li>`).join("");
    const checks=(title,items)=>items?.length?`<div class="plan-checks"><h3>${h(title)}</h3>
        <ul>${items.map(item=>`<li>${h(item)}</li>`).join("")}</ul></div>`:"";
    return `<section class="plan-preview"><div class="section-header"><h2>${h(t.stationPlanOrder)}</h2>
        <span class="preview-count">${h(t.stationPlanCount.replace("{n}", summary.stepCount))}</span></div>
        ${checks(t.initialChecks,summary.initialChecks)}
        <ol class="action-log">${draw(rows.slice(0,5))}</ol>
        ${rows.length>5?`<details class="plan-tail" id="remaining-plan-steps"><summary>${h(t.allPlanSteps.replace("{n}",rows.length-5))}</summary>
            <ol class="action-log" start="6">${draw(rows.slice(5))}</ol></details>`:""}
        ${controlFlow.length ? `<p class="preview-check">${h(t.stationConditional.replace("{types}", new Intl.ListFormat(language).format(controlFlow)))}</p>` : ""}
        ${checks(t.finalChecks,summary.finalChecks) || `<p class="preview-check">${h(summary.hasGoal ? t.stationHasCheck : t.stationNoCheck)}</p>`}</section>`;
}

function selectedCaseRun() {
    const run = model.run;
    return model.testView==="run" && isCaseRun(run?.entry,model.plan,model.activeCase?.id) &&
        run.entry.id!==dismissedReport ? run : undefined;
}

function caseRunSummary(run, locked = false) {
    const runs = model.runs.filter(entry=>isCaseRun(entry,model.plan,model.activeCase?.id));
    const latest = runs.find(entry=>!entry.repairOf || entry.repairApplied) || runs[0];
    const shown = run?.entry || latest;
    const replay = shown?.source==="device" || (!shown && model.planSummary?.source==="coordinates");
    const label = run && shown.id!==latest?.id ? word("Selected run","所选运行") :
        replay ? word("Latest replay","最近回放") : word("Latest run","最近运行");
    const result = !shown && replay ? word("Not replayed","尚未回放") : caseRunStatus(shown,language);
    const meta = shown ? [shown.source==="pytest" ? "pytest" : word("Workbench","工作台"),caseRunTime(shown,language),
        run?.runtimeMs === undefined ? "" : (run.runtimeMs/1000).toFixed(2)+" s"].filter(Boolean).join(" · ") : "";
    const visible = run && shown.status!=="running";
    const toggle = visible || (!run && latest) ? actionButton(visible ? word("Hide report","收起报告") : word("View report","查看报告"),
        {quiet:true,disabled:model.busy||locked,attrs:{id:"case-report-toggle","data-type":visible?"hideCaseReport":"report",
            "data-id":visible?undefined:latest.id,"aria-expanded":Boolean(visible)}}) : "";
    return `<section class="case-run-summary" aria-label="${word("Run summary","运行摘要")}">
        <div class="case-run-description"><span class="case-run-label">${label}</span>
            <strong class="case-outcome" data-status="${h(shown?.status)}" role="status">${h(result)}</strong>
            ${meta ? `<small>${h(meta)}</small>` : ""}</div>
        <div class="case-summary-actions">${toggle}
            ${runs.length>1 ? caseRunHistory(runs,language,{id:"case-run-history",label:word("Case history","用例历史"),selected:run?.entry.id,disabled:model.busy||locked}) : ""}</div></section>`;
}

function caseEditValue(text,area,{index,path,add,defaultName,stepLabel,primaryStep}={}) {
    const className = area==="name" ? "case-value case-title" : stepLabel ? "case-value case-step-name" : "case-value";
    return actionButton(text,{quiet:true,className,
        disabled:model.busy,attrs:{"data-type":"caseReview","data-case-area":area,"data-case-index":index,
            "data-case-path":path,"data-case-add":add,"data-step-default":defaultName,"data-order-hit":stepLabel?"":undefined,
            "data-step-editor":primaryStep?"":undefined}});
}

function definitionBdd(run, coordinates) {
    const defs = model.caseDefinitions;
    const tools = defs && actionButton(word("Organize with AI","用 AI 整理步骤"),{quiet:true,disabled:model.busy,
        attrs:{"data-type":"caseReview","data-case-area":"organize"}});
    const stepActions = defs && !model.busy ? step=>caseStepActions(step,defs.steps[step.path],caseEditValue,word) : undefined;
    return caseBddView(model.caseBdd,language,{coordinates,tools,stepActions,reorder:Boolean(defs && !model.busy),renderRow:runRows(run,(text,context)=>{
        const {area,path,index,step}=context;
        if (area==="step") return caseStepLabel(text,step,defs?.steps[path] && caseEditValue(step.name || text,stepEditArea(defs.steps[path]),
            {path,defaultName:text,stepLabel:true}));
        return defs?.[area]?.[index] ? caseEditValue(text,area,context) : h(text);
    }),boundaryEditor:area=>{
        if (!defs || coordinates) return "";
        const title = area==="start" ? word("Add starting condition","添加起始条件") : word("Add final assertion","添加最终断言");
        return `<div class="case-add-check">${caseEditValue("+ "+title,area,{index:defs[area].length,add:true})}</div>`;
    }});
}

function caseWorkspace() {
    if (model.caseReview?.edit) return caseReviewView(model,language,caseRunSummary(undefined,true));
    if (!model.plan) return recordingWorkspace(model,t);
    const run = selectedCaseRun();
    const ready = model.devices.includes(model.device);
    const coordinates = model.planSummary?.source==="coordinates" || (!model.caseBdd && run?.entry.source==="device");
    const unavailable = model.pytestCase && (model.pytestReadiness?.issue || model.pytestReadiness?.workspaceBinding ||
        (model.pytestCase.requiresRuleGroup && !model.pytestReadiness?.ruleGroup));
    const canPytest = Boolean(model.pytestCase && !unavailable);
    const runner = canPytest ? caseRunners.get(model.plan.uri) || "pytest" : "workbench";
    const running = run?.entry.status==="running";
    const runnerSelect = canPytest ? `<select id="case-runner" class="case-runner"
        aria-label="${h(word("Runner","执行方式"))}" ${disabled(model.busy)}>
        <option value="workbench" ${runner === "workbench" ? "selected" : ""}>${h(word("Workbench","工作台"))}</option>
        <option value="pytest" ${runner === "pytest" ? "selected" : ""}>pytest</option></select>` : "";
    const runnable = model.planSummary && !model.planSummary.error;
    const needsPhone = runnable && runner!=="pytest" && !ready;
    const runButton = running && run.canStop ?
        actionButton(word("Stop replay","停止回放"),{primary:true,attrs:{id:"case-run-action","data-type":"stopRun","data-id":run.entry.id}}) :
        button(running ? word("Running…","运行中…") : coordinates ? word("Replay","回放") : word("Run","运行"),coordinates ? "run" : "caseRun",
            {primary:true,off:running||needsPhone||!runnable,attrs:{id:"case-run-action","data-runner":runner,"data-id":model.plan.uri}});
    const origin = model.activeCase?.origin;
    const exploration = model.activeCase?.source === "exploration";
    const prior = origin?.reportId && (exploration ? model.exploration?.id === origin.reportId ||
        model.explorationHistory?.some(item => item.id === origin.reportId) : model.runs.some(r => r.id === origin.reportId));
    const title = model.activeCase?.name || model.plan.name;
    const save = runnable && !model.caseDefinitions ? button(word("Save as case","保存为用例"),"caseReview") : "";
    const menu = `<details class="case-tools" id="case-tools">
        <summary title="${word("More actions","更多操作")}" aria-label="${word("More actions","更多操作")}">⋯</summary>
        <div>${button(word("View workflow JSON","查看流程 JSON"),"editPlan")}
        ${model.activeCase ? button(word("Duplicate case…","复制用例…"),"caseDuplicate",{attrs:{"data-id":model.activeCase.uri}})+
            button(model.activeCase.editable?word("Delete case…","删除用例…"):word("Remove from library…","从用例库移除…"),
                "caseRemove",{attrs:{"data-id":model.activeCase.uri}}) : ""}
        ${runnable && !coordinates ? button(word("Explore from these steps","沿这些步骤探索"),"explorationFromCase") : ""}
        ${prior ? button(word("Open source report","查看来源报告"),exploration?"explorationReport":"report",{attrs:{"data-id":origin.reportId}}) : ""}</div></details>`;
    const joined = run && (!run.entry.repairOf || run.entry.repairApplied) && model.planDigest && run.entry.sourceDigest===model.planDigest &&
        model.caseBdd && JSON.stringify(model.caseBdd)===JSON.stringify(run.bdd);
    const definition = model.caseBdd ? definitionBdd(joined ? run : undefined,coordinates) : planPreview(model.planSummary);
    const headingNote = [coordinates&&word("Coordinate recording","坐标录制"),needsPhone&&(coordinates ?
        word("Connect a phone to replay","连接手机后可回放") : word("Connect a phone to run","连接手机后可运行"))].filter(Boolean).join(" · ");
    const settings = runnable && !coordinates ?
        `<details id="case-run-settings" class="case-run-settings" ${model.flowDebug?.planUri===model.plan.uri ? "open" : ""}>
            <summary>${word("Run settings & debugging","运行配置与调试")}</summary>
            ${pytestWorkflow(model,language,button,h)}${workflowDebugView(model,language,t)}</details>` : "";
    const review = run && model.failureReview;
    const failedStep = run?.steps?.[review?.index];
    const failureKey = run?.entry.id + "/failure";
    const ai = model.aiResults?.diagnosis?.key === failureKey ? model.aiResults.diagnosis : undefined;
    const repair = run && repairView(model,run,language,button);
    const rerun = run?.entry.source!=="device" && run?.entry.sourceDigest && run.entry.sourceDigest===model.planDigest ?
        (run.entry.source==="pytest" ? model.pytestCase && "pytest" : ready && "workbench") : undefined;
    return `<section class="plan-sheet case-detail-sheet"><header class="case-detail-head">
        <div class="case-heading"><h1>${model.caseDefinitions ? caseEditValue(title,"name") : h(title)}</h1>
            ${headingNote ? `<small>${h(headingNote)}</small>` : ""}</div>
        <div class="case-header-actions">${runnerSelect}${runButton}${save}${menu}</div></header>
        ${caseRunSummary(run)}
        ${failureView(review,run?.entry.id,language,{stepTitle:failedStep && stepTitle(failedStep),ai,
            aiOutput:aiOutput(ai?.next ? {...ai,answer:undefined} : ai,failureKey),stop:aiStop(ai),disabled:model.busy,repair,runner:rerun})}
        ${!review && repair ? repair : ""}
        ${model.planSummary?.scenarioName?`<p class="case-review-note">${h(t.netRuleGroup)} · ${h(model.planSummary.scenarioName)}</p>`:""}
        ${definition}${run ? caseReportBody(run,joined) : ""}${settings}</section>`;
}

function display(value) {
    if (value === undefined || value === null) return "—";
    return typeof value === "string" ? value : JSON.stringify(value);
}

function stepTitle(step) {
    if (step.gesture) {
        const info = stepInfo(step);
        return [info.title, info.detail].filter(Boolean).join(" · ");
    }
    const action=step.command ? commandName(step.command) : t[step.kind] || step.kind || step.path;
    const s=step.selector || step.authoredTarget;
    const target=typeof s==="string"?s:s?.text || s?.id || s?.description || s?.hint || s?.type;
    return [action,target].filter(Boolean).join(" · ");
}

function errorDetails(message) {
    return message ? `<details class="run-diagnostic"><summary>${h(t.stationDiagnostic)}</summary>
        <p><code>${h(message)}</code></p></details>` : "";
}

function evidence(run, step) {
    if (!step) return `<p class="empty">${t.noSteps}</p>`;
    const view = run.frame;
    const phases = ["before", "after"].filter(phase => step[phase]);
    const phaseTools = phases.length === 2 ? `<div class="phase-buttons">${phases.map(phase => button(t[phase], "step", {
        primary: run.phase === phase, attrs: {"data-index":run.selected,"data-phase":phase},
    })).join("")}</div>` : phases.length ? `<small>${h(t[phases[0]])}</small>` : "";
    const stepError = errorDetails(step.error);
    if (step.gesture) {
        const receipt = step.dispatched === "acknowledged" ? t.stationAckSeen :
            step.status === "unknown" ? t.stationAckMissing : status(step.status);
        return `<section class="evidence gesture-receipt"><h3>${h(stepTitle(step))}</h3>
            <p>${word("Device","设备")} · ${h(receipt)}</p>${stepError}</section>`;
    }
    const facts = [[t.expected,step.expected],[t.actual,step.actual]].filter(([,value])=>value!==undefined);
    const tree = view ? `<details id="case-step-tree"><summary>${word("Recorded UI tree","运行时控件树")}</summary>
        <div class="phone"><ul>${view.nodes.filter(node=>node.id||node.text).map(node=>
            `<li class="${step.selector?.id && node.id===step.selector.id ? "match" : ""}">
                <strong>${h(node.label)}</strong><small>${h(node.id||node.type)}</small></li>`).join("")}</ul>
            <small class="frame-id"><code>${h(view.frameId)}</code>${view.truncated ? " · " + h(t.partialTree) : ""}</small></div>
        </details>` : "";
    return `<section class="evidence"><div class="section-header"><h3>${h(stepTitle(step))}</h3>${phaseTools}</div>
        ${facts.length ? `<dl class="case-step-facts">${facts.map(([label,value])=>
            `<div><dt>${h(label)}</dt><dd><code>${h(display(value))}</code></dd></div>`).join("")}</dl>` : ""}
        ${stepError}
        ${run.image ? `<figure class="case-run-picture"><figcaption>${word("Screen during run","运行时画面")}
            ${view?.capturedAt ? `<time>${h(clock(view.capturedAt))}</time>` : ""}</figcaption>${image({src:run.image})}</figure>` : ""}
        ${tree}${!view&&!run.image ? `<p class="empty">${h(t.noFrame)}</p>` : ""}
        ${step.selector ? `<details id="case-step-locator"><summary>${word("Locator","定位器")}</summary>
            <code>${h(display(step.selector))}</code></details>` : ""}</section>`;
}

function comparison(run) {
    if (!run.comparison) return "";
    const difference = run.comparison.difference;
    if (!difference) return `<p class="empty">${t.noDifference}</p>`;
    const summarize = step => step ?
        `${h(step.path)} · ${h(stepTitle(step))} · ${h(status(step.status))}<br><code>${h(display(step.actual ?? step.selector))}</code>` : t.unavailable;
    return `<section class="comparison"><h2>${t.firstDifference}</h2><dl>
        <div><dt>${t.earlier}</dt><dd>${summarize(difference.earlier)}</dd></div>
        <div><dt>${t.current}</dt><dd>${summarize(difference.current)}</dd></div></dl></section>`;
}

function showCaseEvidence(run, index, inline) {
    return caseEvidence?.id===run.entry.id && caseEvidence.index===index && caseEvidence.inline===inline;
}

function caseStepAction(run, step, index, inline) {
    const label = step.gesture && step.dispatched==="acknowledged" ? word("Device confirmed","设备已确认") :
        step.gesture && step.status==="unknown" ? word("Device unconfirmed","设备未确认") : status(step.status);
    return actionButton(label,{quiet:true,className:"case-step-status",disabled:model.busy || run.entry.status==="running",
        attrs:{"data-type":"caseStep","data-index":index,"data-inline":inline,"data-status":step.status,
            "aria-label":label+" · "+word("Step evidence","步骤证据"),"aria-expanded":showCaseEvidence(run,index,inline)}});
}

function runRows(run, draw = (text,{step})=>caseStepLabel(text,step)) {
    if (!run?.steps) return draw;
    const receipts = new Map();
    run.steps.forEach((step,index)=>{
        const path = step.path?.replace(/\.repeat\.iteration\[\d+\]/g,".repeat.steps");
        if (path && (!receipts.has(path) || receipts.get(path).index!==run.selected)) receipts.set(path,{step,index});
    });
    return (text, context) => {
        const body = draw(text,context);
        if (!context.path) return body;
        const receipt = receipts.get(context.path);
        const pending = run.entry.status==="running" ? word("Waiting","等待中") : word("Not reached","未执行");
        const value = receipt ? caseStepAction(run,receipt.step,receipt.index,true) : `<small class="case-step-status">${pending}</small>`;
        const open = receipt && showCaseEvidence(run,receipt.index,true);
        return `<div class="case-step-line"><span>${body}</span>${value}</div>${open ? caseStepEvidence(run,receipt.index) : ""}`;
    };
}

function caseStepEvidence(run,index) {
    if (run.selected!==index) return `<p class="case-evidence-pending" role="status">${h(t.working)}</p>`;
    const step = run.steps[index];
    const key = run.entry.id + "/" + index;
    const result = model.aiResults?.diagnosis;
    const diagnosis = model.failureReview?.index === index ? "" : inlineAI("diagnosis", t.stationAiExplain, result?.key === key ? result : undefined);
    return `<div class="case-step-evidence" id="run-evidence">${evidence(run,step)}${errorDetails(run.frameError)}
        ${comparison(run)}
        <details id="case-evidence-tools"><summary>${word("More evidence tools","更多证据工具")}</summary>
            <div class="toolbar">${button(t.netStep,"networkStep")}${evidenceExport(model,language,"run")}</div>${diagnosis}
        </details></div>`;
}

function caseReportNotice(run) {
    if (run.entry.status==="unknown") {
        const uncertain = run.steps?.findIndex(step=>step.gesture && step.status==="unknown") ?? -1;
        return `<p class="run-outcome">${h(uncertain>=0 ? t.stationUnconfirmedStep.replace("{n}",uncertain+1) : t.stationUnconfirmedRun)}</p>`;
    }
    if (run.entry.status==="completed" && run.goalStatus==="not_requested")
        return `<p class="run-outcome">${word("No final result was checked in this run.","本次回放未检查业务结果。")}</p>`;
    return "";
}

function caseRunTrace(run) {
    return `<details id="execution-timeline" class="case-run-trace"><summary>${word("Execution log","执行日志")}</summary>
        <ol>${run.steps.map((step,index)=>`<li><div class="case-step-line">
            <span><strong>${h(stepTitle(step))}</strong>
                ${step.elapsedMs===undefined ? "" : `<small> · ${Math.round(step.elapsedMs)} ms</small>`}</span>
            ${caseStepAction(run,step,index,false)}</div>
            ${showCaseEvidence(run,index,false) ? caseStepEvidence(run,index) : ""}</li>`).join("")}</ol>
        ${hasBaseline ? button(t.compare,"compare") : ""}${hasBaseline && caseEvidence?.id!==run.entry.id ? comparison(run) : ""}</details>`;
}

function caseReportBody(run, joined) {
    const {entry} = run;
    if (!Array.isArray(run.steps)) {
        if (model.busy || entry.status==="running") return "";
        return `<div class="case-run-notes">${errorDetails(model.error)}
            ${button(t.reloadReport,"report",{attrs:{"data-id":entry.id}})}</div>`;
    }
    const noSteps = !run.steps.length;
    const note = caseReportNotice(run);
    const cleanup = run.cleanup && run.cleanup!=="detached" ? `<p>${h(t.cleanup)} · ${h(status(run.cleanup))}</p>` : "";
    const distinct = !joined && !noSteps;
    const changed = entry.sourceDigest && model.planDigest && entry.sourceDigest!==model.planDigest;
    const snapshotTitle = entry.repairOf ? word("Repair verification","修复验证") : word("Steps from this run","本次执行的步骤");
    const snapshot = distinct ? `<section class="case-run-snapshot"><h2>${snapshotTitle}</h2>
        ${changed ? `<p class="case-review-note">${word("This run used a different workflow version.","本次执行使用了不同版本的流程。")}</p>` : ""}
        ${caseBddView(run.bdd,language,{renderRow:runRows(run),coordinates:entry.source==="device",branchId:"run-branch",showHeading:false})}</section>` : "";
    const separateError = run.error!==run.steps[run.selected]?.error ? errorDetails(run.error) : "";
    const canSave = distinct && !entry.repairOf &&
        (entry.source!=="pytest" || entry.pytest?.workflowSource);
    const tools = canSave ? `<details id="case-run-options"><summary>${word("Report options","报告操作")}</summary>
        ${button(word("Save a copy of this run’s workflow…","将本次执行版本另存为用例…"),"caseReview",{attrs:{"data-from-run":true}})}</details>` : "";
    return `<section class="case-report-body" id="case-run-report">${note}${cleanup}${pytestPhases(run,language)}${separateError}
        ${noSteps ? `<p class="empty">${h(t.noSteps)}</p>` : snapshot+caseRunTrace(run)}${tools}</section>`;
}

function surfaceForState() {
    if (model.tool === "network" || model.tool === "inspect") return model.tool;
    if (model.tool === "exploration") {
        const run = model.exploration;
        return run && !["ready","running","paused"].includes(run.status) ? "exploration-report" : "exploration";
    }
    if (model.caseReview) return model.caseReview.edit ? "case" : "case-review";
    if (model.draft) return model.recording ? "recording" : "review";
    return model.plan ? "case" : "recordings";
}

function focusKey(el) {
    if (!el || !shell.contains(el)) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.matches("summary")) return el.parentElement.id ? "#" + CSS.escape(el.parentElement.id) + " > summary" : ".station-settings > summary";
    const attrs = ["data-field", "data-type", "data-el", "data-x", "data-net", "data-bdd", "data-area", "data-path",
        "data-row", "data-checkpoint", "data-view", "data-index", "data-command", "data-direction", "data-target", "data-id",
        "data-ref", "data-phase", "data-replacement", "data-case-area", "data-case-path", "data-case-index", "data-case-add", "data-inline"];
    return attrs.filter(name => el.hasAttribute(name)).map(name => `[${name}="${CSS.escape(el.getAttribute(name))}"]`).join("");
}

function render() {
    document.documentElement.lang = language;
    const surface = surfaceForState();
    const previous = shell.dataset.surface;
    const selected = toolNavigation.selected;
    const itemKey=surface==="case" ? model.activeCase?.id || model.plan?.uri : undefined;
    const itemChanged=Boolean(itemKey && shell.dataset.caseKey && shell.dataset.caseKey!==itemKey);
    const sameCase=Boolean(itemKey && shell.dataset.caseKey===itemKey);
    shell.dataset.caseKey=itemKey || "";
    const tabChanged = selected !== shell.dataset.tab;
    const switchedTabs = tabChanged && selected === requestedWorkspaceTab;
    if (switchedTabs) requestedWorkspaceTab = undefined;
    const focus = document.activeElement;
    const key = focusKey(focus);
    const start = typeof focus?.selectionStart === "number" ? focus.selectionStart : undefined;
    const end = start === undefined ? undefined : focus.selectionEnd;
    const menuOpen = header.querySelector("details")?.open;
    if (previous !== surface || (focus !== document.body && key !== pendingFocus?.key)) pendingFocus = undefined;
    shell.dataset.surface = surface;
    shell.dataset.tab = selected;
    const nav = topBar();
    if (headerSignature !== nav) {
        header.innerHTML = nav + '<div id="station-feedback" hidden role="alert"></div>';
        headerSignature = nav;
        if (menuOpen && previous === surface) header.querySelector("details").open = true;
    }
    const tabs = tabList({
        id:"station", label:t.toolNavigation, active:selected, className:"station-tabs", panelId:toolContent.id,
        items:toolNavigation.tools.map(({id,label})=>({id,label,data:{type:"workspaceTab",view:id}})),
    });
    if (tabs !== navigationSignature) {
        const scroll = toolNav.firstElementChild?.scrollLeft || 0;
        toolNav.innerHTML = tabs;
        toolNav.firstElementChild.scrollLeft = scroll;
        navigationSignature = tabs;
    }
    const activeTab = document.getElementById("station-tab-" + selected);
    toolContent.setAttribute("aria-labelledby", activeTab.id);
    const feedback = document.getElementById("station-feedback");
    const run = surface==="case" ? selectedCaseRun() : undefined;
    const reportOwnsError = run && model.error && (!run.steps || model.error===run.error ||
        model.error===run.steps[run.selected]?.error);
    const error = model.runtimeError || (reportOwnsError ? "" : model.error || "");
    if (feedback.textContent !== error) feedback.textContent = error;
    feedback.hidden = !error;
    let panel = "";
    if (surface === "recording") panel = recordingStage();
    if (surface === "review") panel = reviewRecording(model.draft);
    if (surface === "recordings") panel = recordingWorkspace(model, t);
    if (surface === "case") panel = caseWorkspace();
    if (surface === "inspect") panel = inspector();
    if (surface === "network") panel = networkView(model,language);
    if (surface.startsWith("exploration")) panel = explorationView(model,t,
        step => evidenceExport(model,language,"exploration",step),language);
    if (surface === "case-review") panel = caseReviewView(model,language);
    const confirm = selected === "recordings" && selection.confirmDiscard && model.draft ? `<div class="confirm-discard" role="group" aria-label="${h(t.discardAsk)}">
        <strong>${h(t.discardAsk)}</strong>${button(t.keep, "keepDraft", { primary: true })}${button(t.discard, "discardRecord")}</div>` : "";
    const detail = toolBack(surface) + confirm + panel;
    const html = selected === "recordings" ? `<div class="test-layout">${caseLibraryView(model,language)}
        <div class="test-detail">${detail}</div></div>` : detail;
    if (html !== contentSignature) {
        closeItemMenu();
        cancelOrderDrag();
        const scrolls = ["node-list", "record-controls", "live-step-log", "net-record-list", "net-detail-body", "case-files", "bdd-target-results"]
            .map(id => document.getElementById(id)).filter(Boolean)
            .map(el => ({id: el.id, top: el.scrollTop, left: el.scrollLeft, key: el.dataset.scrollKey}));
        const oldLog = document.getElementById("live-step-log");
        const followSteps = oldLog && oldLog.scrollHeight - oldLog.clientHeight - oldLog.scrollTop < 4;
        const disclosures = previous === surface ?
            Array.from(root.querySelectorAll("details[open]"), item => item.id).filter(id=>!itemChanged || id==="case-all-runs") : [];
        const contentTop = toolContent.scrollTop;
        root.innerHTML = html;
        contentSignature = html;
        for (const id of disclosures) {
            const detail = document.getElementById(id);
            if (detail) detail.open = true;
        }
        if (previous === surface) {
            if (sameCase) toolContent.scrollTop = contentTop;
            for (const {id, top, left, key} of scrolls) {
                const list = document.getElementById(id);
                if (list && list.dataset.scrollKey === key) {
                    list.scrollTop = id === "live-step-log" && followSteps ? list.scrollHeight : top;
                    list.scrollLeft = left;
                }
            }
        }
    }
    root.setAttribute("aria-busy", String(Boolean(model.busy)));
    if (key && previous === surface && !focus.isConnected) {
        const next = shell.querySelector(key);
        if (next?.disabled && model.busy) pendingFocus = { key, start, end };
        else {
            next?.focus({ preventScroll: true });
            if (next && start !== undefined && typeof next.setSelectionRange === "function") next.setSelectionRange(start, end);
        }
    } else if (pendingFocus && !model.busy && document.activeElement === document.body) {
        const next = shell.querySelector(pendingFocus.key);
        next?.focus({ preventScroll: true });
        if (next && pendingFocus.start !== undefined && typeof next.setSelectionRange === "function") {
            next.setSelectionRange(pendingFocus.start, pendingFocus.end);
        }
        pendingFocus = undefined;
    }
    if (itemChanged || (previous && previous !== surface && !sameCase)) {
        const heading = root.querySelector(".test-detail h1, h1");
        toolContent.scrollTop = 0;
        if (switchedTabs) activeTab.focus({preventScroll:true});
        else if (heading && !itemChanged) {
            heading.tabIndex = -1;
            heading.focus({preventScroll:true});
        }
    }
    if (requestedCaptureFocus) {
        const capture = model.network?.capture;
        if (surface !== "network" || model.device !== requestedCaptureFocus.device ||
            (focus !== document.body && focus?.dataset.net !== requestedCaptureFocus.action)) {
            requestedCaptureFocus = undefined;
        } else if (capture?.id && capture.id !== requestedCaptureFocus.previousId) {
            requestedCaptureFocus = pendingFocus = undefined;
            (root.querySelector('[data-net="nativeStop"]') || document.getElementById("network-native-phase"))?.focus({preventScroll:true});
        }
    }
    if (focus?.id === "network-native-phase") root.querySelector('[data-net="nativeStop"]')?.focus({preventScroll:true});
    if (pendingOrderFocus && !model.busy) {
        const {kind,key,to,tool} = pendingOrderFocus;
        pendingOrderFocus = undefined;
        if (model.tool===tool) {
            const list = root.querySelector(`[data-order-kind="${kind}"][data-order-key="${CSS.escape(key)}"]`);
            list?.querySelector(`:scope > [data-order-index="${to}"] > [data-item-menu-trigger],
                :scope > [data-order-index="${to}"] > [data-order-head] > [data-item-menu-trigger]`)?.focus({preventScroll:true});
        }
    }
}

window.addEventListener("message", event => {
    const message = event.data;
    if (!message.state) return;
    const sameDevice = message.state.device === model?.device;
    const sameInspector = sameDevice && message.state.tool === "inspect";
    if (!sameDevice) {
        inspectFilter = "";
        interactiveOnly = false;
    }
    if (message.state.page?.frameId !== model?.page?.frameId || message.state.device !== model?.device) {
        if (message.state.device !== model?.device) collapsedNodes.clear();
        const oldSelector = sameInspector && model.page?.nodes.find(node => node.ref === selection.ref)?.selector;
        const match = oldSelector && message.state.page?.nodes.find(node =>
            node.selector && JSON.stringify(node.selector) === JSON.stringify(oldSelector));
        selection.ref = match?.ref || "";
        selection.filter = "";
        replacements.clear();
    }
    if (!message.state.draft) selection.confirmDiscard = false;
    const closedCaseEditor = model?.caseReview?.edit && !message.state.caseReview;
    if (message.state.recording && !model?.recording || message.state.draft && !model?.draft) {
        Object.assign(selection, { start: "", goal: "", expected: "", property: "visible", visible: true, checksOpen: false, filter: "" });
    }
    model = message.state;
    toolNavigation = message.navigation;
    t = message.text;
    language = message.language;
    updateElements(model,language,t);
    if (sameInspector && model.page?.elements && !selection.ref) selection.ref = rebindElement(model.page)?.ref || "";
    hasBaseline = message.hasBaseline;
    render();
    if (closedCaseEditor && caseEditOrigin) {
        let origin = root.querySelector(caseEditOrigin);
        if (origin?.closest("[data-item-menu]")) origin=origin.closest(".case-library-row")?.querySelector(".case-file") ||
            origin.closest("[data-case-step]")?.querySelector(":scope > [data-item-menu-trigger]");
        if (origin?.disabled && model.busy) pendingFocus={key:caseEditOrigin};
        else origin?.focus({preventScroll:true});
        caseEditOrigin=undefined;
    }
    if (requestedCaseEdit && !model.busy) {
        const {area,index,path,add} = requestedCaseEdit;
        requestedCaseEdit = undefined;
        if (model.caseReview) {
            const editor = [...root.querySelectorAll("[data-bdd][data-area]")].find(el=>el.dataset.area===area &&
                (["name","organize"].includes(area) || ((path ? el.dataset.path===path : el.dataset.index===index) &&
                    (el.dataset.bdd==="add")===add)));
            editor?.click();
        } else caseEditOrigin=undefined;
    }
});

function handleClick(event) {
    const control = event.target.closest("button");
    if (!control || control.disabled) return;
    if (event.target.closest("[data-tree-toggle]")) {toggleNode(control);return;}
    if (caseEditorClick(control,model,message=>vscode.postMessage(message),render)) return;
    if (["native","nativeChoose","nativeTimed"].includes(control.dataset.net)) {
        const options = control.closest("#network-native-options");
        if (options) options.open = false;
        requestedCaptureFocus = {action:control.dataset.net,device:model.device,previousId:model.network?.capture?.id};
    }
    if (networkClick(control,model,message=>vscode.postMessage(message),render)) return;
    if (flowDebugClick(control,model,message=>vscode.postMessage(message))) return;
    if (elementClick(control)) return;
    if (exploreClick(control, model, message => vscode.postMessage(message), render)) return;
    let { type, view, ref, target, command, direction, id, phase, index, fromRun } = control.dataset;
    if (type==="hideCaseReport") {
        dismissedReport = model.run?.entry.id;
        caseEvidence = undefined;
        render();
        return;
    }
    if (type==="caseStep" || type==="showFailureStep") {
        const run = selectedCaseRun(), receipt = Number(index), jump = type==="showFailureStep";
        if (!run?.steps?.[receipt]) return;
        const row = `[data-type="caseStep"][data-index="${receipt}"]`;
        const inline = jump ? Boolean(root.querySelector(row+'[data-inline="true"]')) : control.dataset.inline==="true";
        const open = jump || !showCaseEvidence(run,receipt,inline);
        caseEvidence = open ? {id:run.entry.id,index:receipt,inline} : undefined;
        render();
        if (jump) {
            const target = root.querySelector(row+`[data-inline="${inline}"]`);
            for (let parent=target?.closest("details"); parent; parent=parent.parentElement.closest("details")) parent.open=true;
            target?.focus({preventScroll:true});
            target?.scrollIntoView({block:"center"});
        }
        if (open && (run.selected!==receipt || phase && phase!==run.phase)) vscode.postMessage({type:"step",index:receipt,phase});
        return;
    }
    if (type==="caseReview" && control.dataset.caseArea) {
        const {caseArea,caseIndex,casePath,caseAdd}=control.dataset;
        requestedCaseEdit={area:caseArea,index:caseIndex,path:casePath,add:caseAdd==="true"};
        caseEditOrigin=focusKey(control);
    }
    if (type==="caseStepAction") {
        const review = model.caseReview;
        sendWorkbench({type,id:review?.id,revision:review?.revision,uri:model.plan?.uri,digest:model.planDigest,
            action:control.dataset.stepAction,path:control.dataset.casePath});
        return;
    }
    if (["caseOpen","openPlan","run","caseRun","report"].includes(type)) {
        caseEvidence=undefined;
        dismissedReport=undefined;
    }
    if (type==="report" && control.closest("#case-run-history")) {
        const history=control.closest("#case-run-history");
        history.open=false;
        history.querySelector("summary").focus();
    }
    if (["explorationFromCase","explorationReport"].includes(type)) explorationReturn="workflow";
    if (type === "stopRecord") {
        document.getElementById("record").click();
        return;
    }
    if (type === "workspaceTab") {
        if (view !== shell.dataset.tab && control.parentElement.getAttribute("aria-disabled") !== "true") {
            if (view==="exploration") explorationReturn=undefined;
            requestedWorkspaceTab = view;
            vscode.postMessage({type,view});
        }
        return;
    }
    if (type === "explainStep") {
        vscode.postMessage({type,id:model.run.entry.id,index:model.run.selected,goal:document.getElementById("ai-diagnosis-goal")?.value});
        return;
    }
    if (type === "parentControl") {
        if (!filteredNodes().some(node => node.ref === target)) {
            inspectFilter = "";
            interactiveOnly = false;
        }
        selection.ref = target;
        revealNode(target);
        if (model.page.elements) selectElement(model.page.nodes.find(n=>n.ref === target),true);
        render();
        const row = root.querySelector(".node-row[aria-selected=true]");
        if (row) {
            row.focus({ preventScroll: true });
            const list = document.getElementById("node-list");
            list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
        }
        return;
    }
    if (type === "applyCheck") {
        const check = model.aiResults?.check?.check;
        if (check) Object.assign(selection, { goal: check.ref, checksOpen: true, property: check.property,
            expected: check.property === "text" ? check.expected : "", visible: check.property === "visible" && check.expected });
        render();
        return;
    }
    if (type === "keepDraft") {
        selection.confirmDiscard = false;
        render();
        return;
    } else if (type === "askDiscard") {
        if (model.draft.steps.length) {
            selection.confirmDiscard = true;
            render();
            root.querySelector('[data-type="keepDraft"]')?.focus();
            return;
        }
        type = "discardRecord";
    }
    if (control.closest(".station-settings")) header.querySelector("details").open = false;
    if (control.closest("#inspector-tools")) {
        const menu = document.getElementById("inspector-tools");
        menu.open = false;
        menu.querySelector("summary").focus();
    }
    if (control.closest("#case-tools")) {
        control.closest("#case-tools").open = false;
        document.querySelector("#case-tools > summary").focus();
    }
    if (ref) {
        selection.ref = ref;
        if (model.page?.elements) selectElement(model.page.nodes.find(n=>n.ref === ref),true);
        render();
        if (event.detail === 0) root.querySelector(".node-row[aria-selected=true]")?.focus();
        return;
    }
    if (!type) return;
    vscode.postMessage({
        type, view, command, direction, id, phase, index: index === undefined ? undefined : Number(index),
        fromRun: fromRun === "true",
        runner: control.dataset.runner,
        ...(type==="removeStep" && {revision:Number(control.dataset.revision)}),
        ...(type === "caseSave" && {name:model.caseReview?.name}),
        ref: target || selection.ref,
        frameId: model.page?.frameId,
        text: (control.closest(".control-line")?.querySelector("[data-replacement]") || document.getElementById("replacement"))?.value,
        startRef: selection.start,
        goalRef: selection.goal,
        property: selection.property,
        expected: selection.property === "text" ? selection.expected : selection.visible,
    });
}

header.addEventListener("click", handleClick);
toolNav.addEventListener("click", handleClick);
toolNav.addEventListener("keydown", tabKeydown);
root.addEventListener("click", handleClick);
const sendWorkbench = message=>vscode.postMessage(message);
root.addEventListener("dblclick", event=>{
    if (event.button!==0 || model?.busy || event.target.closest("button,a,input,textarea,select,summary,[data-order-grip],.case-step-evidence")) return;
    const row = event.target.closest("[data-case-step]");
    const edit = row?.querySelector(":scope > [data-item-menu] [data-step-editor]");
    if (!edit) return;
    event.preventDefault();
    edit.click();
});
bindItemMenus(root,owner=>{
    if (!model || model.busy) return [];
    if (owner.dataset.itemActions==="request") return requestMenuItems(owner,model,language,sendWorkbench,render);
    if (owner.dataset.itemActions==="request-field") return requestFieldMenuItems(owner,model,language,sendWorkbench,render);
    if (owner.dataset.itemActions==="rule-group") return ruleGroupMenuItems(owner,model,language,sendWorkbench,render);
    if (owner.dataset.itemActions==="element") return elementMenuItems(owner.dataset.ref);
    if (owner.dataset.itemActions==="finding")
        return menuItems(owner.querySelectorAll("[data-x=traceStep], [data-x=caseFinding], [data-x=save], [data-x=triage]"));
    return [];
});
const cancelOrderDrag = bindListOrder(root,change=>{
    if (!model || model.busy) return;
    const {row,list,from,to} = change, {orderKind:kind,orderKey:key} = list.dataset;
    if (kind!=="rules") pendingOrderFocus = {kind,key,to,tool:model.tool};
    if (kind==="recording") sendWorkbench({type:"moveRecordedStep",from,to,revision:model.draft?.stepRevision || 0});
    else if (kind==="case") sendWorkbench({type:"caseMoveStep",id:model.caseReview?.id,revision:model.caseReview?.revision,
        uri:model.plan?.uri,digest:model.planDigest,from:row.dataset.stepPath,to});
    else if (!networkOrder(change,model,sendWorkbench,render)) pendingOrderFocus=undefined;
});
root.addEventListener("submit", event => caseEditorSubmit(event,model,message=>vscode.postMessage(message)));
root.addEventListener("keydown", event => {
    if (event.key==="Escape" && event.target.closest("#bdd-editor") && !event.isComposing) {
        event.preventDefault();
        if (endCasePicture(model,sendWorkbench)) {
            document.getElementById("bdd-pick-screen")?.focus();
            return;
        }
        root.querySelector('#bdd-editor [data-bdd="cancel"]')?.click();
        return;
    }
    if (event.key==="F2" && event.target.closest('.case-file[aria-current=true], .case-title')) {
        const title = root.querySelector(".case-title");
        if (title) {event.preventDefault();title.click();}
        return;
    }
    if (event.key==="F2" && event.target.closest(".case-step-name")) {
        const row = event.target.closest("[data-case-step]");
        const rename = row?.querySelector(':scope > [data-item-menu] :is([data-area="stepName"],[data-case-area="stepName"])');
        if (rename) {event.preventDefault();rename.click();}
        return;
    }
    if (!event.isComposing && ["sc-library-name","ns-rename-rule"].includes(event.target.id) && ["Enter","Escape"].includes(event.key)) {
        event.preventDefault();
        const action=event.target.id==="sc-library-name" ? (event.key==="Enter"?"sc-confirm":"sc-dismiss") :
            (event.key==="Enter"?"studio-rename-save":"studio-rename-cancel");
        root.querySelector('[data-net="'+action+'"]')?.click();
        return;
    }
    if (event.key==="F2" && event.target.closest('#scenario-title,.sc-library-item[aria-current=true]')) {
        event.preventDefault();
        root.querySelector("#scenario-title")?.click();
        return;
    }
    if (tabKeydown(event) || trafficKeydown(event, render) || treeKeydown(event)) return;
    if (event.key === "Enter" && !event.isComposing && event.target.id === "net-find") {
        event.preventDefault();
        root.querySelector('[data-net="findGo"]')?.click();
    }
});

root.addEventListener("input", event => {
    if (caseEditorInput(event.target,model,sendWorkbench,render)) return;
    if (event.target.id === "ai-diagnosis-goal") {
        diagnosisGoals.set(event.target.dataset.diagnosis,event.target.value);
        return;
    }
    if (networkInput(event.target,render,message=>vscode.postMessage(message))) return;
    if (elementInput(event.target)) return;
    if (exploreInput(event.target, model)) return;
    if (event.target.id === "replacement" || event.target.hasAttribute("data-replacement")) {
        replacements.set(event.target.dataset.target || selection.ref, event.target.value);
    } else if (event.target.id === "control-filter") {
        selection.filter = event.target.value;
        document.getElementById("record-controls").innerHTML = recordableControls();
    } else if (event.target.id === "node-filter" || event.target.id === "interactive-only") {
        inspectFilter = document.getElementById("node-filter").value;
        interactiveOnly = document.getElementById("interactive-only").checked;
        const nodes = filteredNodes();
        const list = document.getElementById("node-list");
        list.innerHTML = nodeList(nodes);
        list.scrollTop = 0;
        document.getElementById("node-count").textContent = t.stationNodeCount.replace("{n}", nodes.length);
    } else if (event.target.dataset.field === "expected") {
        selection.expected = event.target.value;
    }
});

function changeField(event) {
    if (caseEditorInput(event.target,model,sendWorkbench,render)) return;
    if (event.target.dataset.x === "mode" && event.target.checked) {
        exploreClick(event.target,model,sendWorkbench,render);
        return;
    }
    if (event.target.id === "case-runner") {
        caseRunners.set(model.plan.uri,event.target.value);
        render();
        return;
    }
    if (exploreChange(event.target)) return;
    const field = event.target.dataset.field;
    if (field === "device") {
        vscode.postMessage({ type: "device", device: event.target.value });
    } else if (field && field !== "expected") {
        selection[field] = field === "visible" ? event.target.value === "true" : event.target.value;
        if (field === "goal") {
            selection.expected = model.draft.end.find(node => node.ref === selection.goal)?.text || "";
        }
        render();
    }
}
header.addEventListener("change", changeField);
root.addEventListener("change", changeField);

document.addEventListener("click", event => {
    const menu = header.querySelector(".station-settings[open]");
    if (menu && !menu.contains(event.target)) menu.open = false;
    for (const menu of root.querySelectorAll("#inspector-tools[open],#network-native-options[open],#case-tools[open],#case-run-history[open]"))
        if (!menu.contains(event.target)) menu.open = false;
});
root.addEventListener("keydown", event => {
    const menu = root.querySelector("#inspector-tools[open],#sc-management[open],#network-native-options[open],#case-tools[open],#case-run-history[open]");
    if (menu && event.key === "Escape") {
        menu.open = false;
        menu.querySelector("summary").focus();
    }
});
header.addEventListener("keydown", event => {
    const menu = header.querySelector(".station-settings[open]");
    if (menu && event.key === "Escape") {
        menu.open = false;
        menu.querySelector("summary").focus();
    }
});

root.addEventListener("toggle", event => {
    if (event.target.id === "check-options" && event.target.isConnected) selection.checksOpen = event.target.open;
    if (event.target.matches(".x-finding[data-finding-id]") && event.target.isConnected)
        exploreToggle(event.target,model,message=>vscode.postMessage(message));
}, true);

bindElements(render, ref => {
    if (!filteredNodes().some(node => node.ref === ref)) {
        inspectFilter = "";
        interactiveOnly = false;
    }
    selection.ref = ref;
    revealNode(ref);
    selectElement(model.page.nodes.find(n=>n.ref===ref),true);
    render();
    const row = root.querySelector(".node-row[aria-selected=true]");
    const list = document.getElementById("node-list");
    if (row && list) {
        const itemBox = row.getBoundingClientRect(), listBox = list.getBoundingClientRect();
        if (itemBox.top < listBox.top) list.scrollTop += itemBox.top - listBox.top;
        if (itemBox.bottom > listBox.bottom) list.scrollTop += itemBox.bottom - listBox.bottom;
    }
},{
    selectCaseTarget:(key,picture)=>selectCasePictureTarget(key,picture,model,sendWorkbench,render),
    endCasePick:()=>endCasePicture(model,sendWorkbench),
});

vscode.postMessage({ type: "ready" });
