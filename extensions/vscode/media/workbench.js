import { vscode } from "./bridge.js";
import { pytestWorkflow } from "./pytestCase.js";
import { recordingWorkspace } from "./recordingWorkspace.js";
import { recordedStepPreview } from "./stepPreview.js";
import { caseBddView, caseStepLabel, caseLibraryView, casePendingNotice, caseRunHistory, caseRunStatus, caseRunTime, caseHistoryEntries, isCaseRun } from "./caseLibrary.js";
import { caseReviewView, caseStepActions, caseFeedbackView, caseEditorClick, caseEditorInput, caseEditorSubmit, openCaseEditor,
    caseEditorToggle, endCasePicture, selectCasePictureTarget } from "./caseAuthoring.js";
import { pytestPhases } from "./pytestReport.js";
import { repairView,repairInput,repairSubmit } from "./caseRepair.js";
import {compositionStepMenu, caseStepMenuItems, caseForkStepMenu, casePositionMenuItems, compositionPage, compositionControls,
    compositionClick, compositionInput, compositionKeydown} from "./caseComposition.js";
import {InlineCaseInsertion} from "./caseInsert.js";
import { failureView } from "./caseFailure.js";
import { networkView, networkClick, networkInput, networkOrder, requestMenuItems, requestFieldMenuItems, ruleGroupMenuItems } from "./networkView.js";
import { trafficKeydown } from "./networkTraffic.js";
import { tabKeydown, tabList } from "./ui/tabs.js";
import { restoreDisclosures } from "./ui/disclosures.js";
import { treeKeydown } from "./ui/treeNavigation.js";
import { actionButton } from "./ui/controls.js";
import { bindItemMenus, closeItemMenu, itemMenu, menuItems } from "./ui/itemActions.js";
import { bindListOrder, orderGrip, orderActions } from "./ui/listOrder.js";
import { stepSelectionFor, stepSelectionControls } from "./caseSelection.js";
import { ListSelection, listSelectionClick, listSelectionChange, bindListSelection, exitListSelection,
    updateListSelectionScope, exitHiddenListSelection, activeListPreview } from "./ui/listSelection.js";
import { workflowDebugView, flowDebugClick, flowDebugInput, evidenceExport } from "./flowDebug.js";
import { bindElements, updateElements, selectElement, rebindElement, elementControls, elementsFooter, elementClick, elementInput, elementMenuItems } from "./elements.js";
import { explorationView, exploreClick, exploreInput, exploreToggle } from "./exploration.js";

const shell = document.getElementById("app-shell");
const header = document.getElementById("station-header");
const root = document.getElementById("workbench");
const toolNav = document.getElementById("tool-navigation");
const toolContent = document.getElementById("tool-content");
const inlineInsertion = new InlineCaseInsertion(root,message=>vscode.postMessage(message),render,
    edit=>openCaseEditor(edit,model,message=>vscode.postMessage(message),render));
let model;
let toolNavigation;
let t;
let language;
let hasBaseline;
let headerSignature = "";
let navigationSignature = "";
let contentSignature = "";
let contentContext;
let previousDisclosures = new Map();
let explorationReturn;
let requestedWorkspaceTab;
let pendingFocus;
let requestedCaptureFocus;
let requestedCaseEdit;
let appliedStepFocus;
let caseEditOrigin;
let caseReturnPosition;
let revisionFocus;
let pendingOrderFocus;
let dismissedReport;
let caseEvidence;
let pendingLibraryPreview;
let inspectFilter = "";
let interactiveOnly = false;
const collapsedNodes = new Set();
const replacements = new Map();
const diagnosisGoals = new Map();
const caseRunners = new Map();
const runWithoutRuleGroup = new Set();
const recordedSelection = new ListSelection("recorded-steps");
const locatorSelection = new ListSelection("element-locators");
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
        overview: '<path d="M3 3v13.5h14M6.5 13V9m4 4V5m4 8V7.5"/>',
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
    const canCollapse = !inspectFilter.trim() && !interactiveOnly;
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
            const expanded=hasChildren && (!canCollapse || !collapsedNodes.has(treeKey(node)));
            rows.push({node,parent,level,expanded,hasChildren,index,size:siblings.length});
            if (expanded) branch(node.ref,level+1);
        });
    }
    branch(undefined,1);
    const focus = rows.some(({node})=>node.ref===selection.ref) ? selection.ref : rows[0]?.node.ref;
    return rows.map(({node,parent,level,expanded,hasChildren,index,size})=>`
        <button type="button" role="treeitem" class="node-row depth-${Math.min(level-1,4)}" data-ref="${h(node.ref)}"
            data-selection-hit${locatorSelection.row(node.ref)} data-item-actions="element" data-item-label="${h(node.label)}" aria-keyshortcuts="Shift+F10"
            data-node-parent="${h(parent)}" aria-level="${level}" aria-posinset="${index+1}" aria-setsize="${size}"
            aria-selected="${node.ref===selection.ref}" tabindex="${focus===node.ref?0:-1}" ${hasChildren?'aria-expanded="'+Boolean(expanded)+'"':""}
            ${disabled(model.busy)}>
            <span class="node-disclosure" aria-hidden="true" ${hasChildren&&canCollapse?"data-tree-toggle":""}></span>
            ${artIcon(node.editable ? "input" : node.scrollable ? "scroll" : node.pressable ? "press" : "element")}
            <span class="node-name">${h(node.label)}</span><small class="node-kind">${h(node.type)}</small></button>`).join("");
}

function treeKey(node) {
    return node.selector ? JSON.stringify(node.selector) : model.page.frameId+"/"+node.ref;
}

function toggleNode(row) {
    if (model.busy || !row.querySelector("[data-tree-toggle]")) return;
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

function previewNode(node) {
    selection.ref=node?.ref || "";
    if (node) revealNode(node.ref);
    selectElement(node,true);
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
    const picking = model.elements?.picking;
    const refresh = button(picking ? t.stationRefreshSnapshot : t.stationRefreshNodes, "observe", { off: !model.device });
    const mode = picking ? word("Pick element","选取元素") : word("Live phone","实时操作");
    const heading = `<header class="inspect-mode-head"><div><small>${h(t.workbenchElements)}</small>
        <h1>${h(model.deviceDisconnected ? t.stationInspector : mode)}</h1></div>${model.deviceDisconnected ? "" : refresh}</header>`;
    if (model.deviceDisconnected) return heading + `<section class="inspect-empty"><p role="status">${h(t.liveDisconnected)}</p></section>`;
    if (!page) return heading + `<section class="inspect-empty"><p role="status">${h(model.busy ? t.stationReadingControls : model.device ? t.stationAwaitControls : t.noObservation)}</p></section>`;
    const nodes = filteredNodes();
    const locators=page.elements ? nodes.filter(node=>node.selector) : [];
    locatorSelection.update(JSON.stringify([page.frameId,inspectFilter,interactiveOnly]),locators.map(node=>node.ref),model.busy);
    const locatorTools=locatorSelection.tools(word,[{id:"copy",label:word("Copy locators","复制定位器"),
        message:refs=>({type:"elementCopySelected",refs,frameId:page.frameId})}],
        {onPreview:ref=>{if (ref) previewNode(page.nodes.find(node=>node.ref===ref));}});
    const copied=model.elements?.copiedSelection;
    const copiedNote=locatorSelection.active && copied && copied.frameId===page.frameId ? word(
        "Copied "+copied.count+" locators.","已复制 "+copied.count+" 个定位器。") : "";
    const count = t.stationNodeCount.replace("{n}", locatorSelection.active ? locators.length : nodes.length);
    const capture = model.liveImage?.src ? `<details id="inspector-capture"><summary>${h(t.screenshot)} · ${h(clock(model.liveImage.capturedAt))}</summary>${image(model.liveImage)}</details>` : "";
    const log = model.actions.length ? `<details id="inspector-log"><summary>${h(t.recentActions)} · ${model.actions.length}</summary>
        <ol>${model.actions.map(action => `<li>${h(commandName(action.command))} ${h(action.label)}</li>`).join("")}</ol></details>` : "";
    const inspection = `<div class="inspect-workspace"><section class="inspect-controls" aria-label="${h(t.stationInspector)}">
        <h2 class="inspect-tree-title">${h(word("Control tree","控件树"))}</h2>
        <div class="inspect-search">${artIcon("search")}<input type="search" id="node-filter" aria-label="${h(t.searchNodes)}"
            placeholder="${h(t.searchNodes)}" value="${h(inspectFilter)}"></div>
        <div class="inspect-filters"><label><input type="checkbox" id="interactive-only" ${interactiveOnly ? "checked" : ""}>
            ${h(t.stationInteractiveOnly)}</label></div>
        <div class="node-meta"><span role="status" id="node-count">${h(count)}</span><span>${h(page.truncated ? t.partialTree : clock(page.capturedAt))}</span></div>
        ${locatorTools}${copiedNote ? `<small role="status">${h(copiedNote)}</small>` : ""}
        ${locatorSelection.active ? `<ul class="node-list locator-selection" id="node-list">${locators.map(node=>
            `<li${locatorSelection.row(node.ref)}>${locatorSelection.checkbox(node.ref,word("Select ","选择 ")+node.label)}
                <span>${h(node.label)}</span><small>${h(node.type)}</small></li>`).join("")}</ul>` :
            `<div class="node-list" id="node-list" role="tree" aria-label="${h(t.stationInspector)}">${nodeList(nodes)}</div>`}</section>
        <div class="inspect-properties"><header class="inspect-head">${selected ? `<span class="inspect-caption">${h(t.stationSelected)}</span>` : ""}
            <h2 id="selected-name" tabindex="-1">${h(selected?.label || word("No control selected","尚未选取控件"))}</h2>
            ${selected?.type ? `<code class="selected-type">${h(selected.type)}</code>` : ""}</header>
            <div id="node-info">${nodeDetails(selected)}</div></div></div>`;
    return heading + elementsFooter(previewNode,inspection) + capture + log;
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
    const caseLabel = surface.startsWith("exploration") ? (caseReturnPosition?.path ? word("Back to case step","返回用例步骤") :
        word("Back to case","返回用例")) : t.backRecordings;
    const destinationLabel = { workflow:caseLabel, recordings:t.backRecordings,
        exploration:t.returnToStep,run:t.returnToStep,explore:t.stationBackPhone }[destination];
    return !destinationLabel || (toolNavigation.selected === "recordings" && (model.draft || model.caseReview)) ? "" : `<button type="button" class="station-link tool-back" data-type="view"
        data-view="${destination}" ${disabled(model.busy)}>${artIcon("back")}
        <span>${h(destinationLabel)}</span></button>`;
}

function topBar() {
    const deviceActions = model.tool==="inspect" && model.device && !model.deviceDisconnected ? `<div class="station-device-actions" role="group"
        aria-label="${h(t.stationSessionTools)}">${button(t.openApp,"openApp",{off:!model.page})}
        ${button(t.screenshot,"screenshot",{off:!model.page})}</div>` : "";
    return `<div class="station-top-inner"><div class="station-identity"><span class="station-mark" aria-hidden="true"></span>
        <span>Harmony <strong>Agent</strong></span></div>${devicePicker()}<div class="station-utilities">
        <details class="station-settings"><summary class="station-tool" title="${h(t.stationSettings)}" aria-label="${h(t.stationSettings)}">
        ${artIcon("settings")}</summary><div class="station-menu">
        ${button(t.selectProjectRuntime + (model.runtimeName ? " · " + model.runtimeName : ""), "projectRuntime")}
        ${button(t.stationAiSettings, "aiSettings")}${button(t.loadSettings, "settings")}${deviceActions}</div></details></div></div>`;
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
    const firstStep = draft.location === "auto" ? word("No steps recorded yet","尚未录制步骤") :
        draft.location === "phone" ? t.firstFinger :
        draft.stepFormat === "controls" ? t.firstControl : t.firstScreen;
    if (!draft.steps.length) return `<p class="list-placeholder">${h(firstStep)}</p>`;
    const picking = editable && recordedSelection.active;
    const reorder = editable && !picking && !model.busy && draft.steps.length>1;
    return `<ol class="action-log" ${reorder?'data-order-kind="recording" data-order-key="draft"':""}>${draft.steps.map((step, index) => {
        const info = stepInfo(step);
        const menu = editable && !picking ? itemMenu(word("Step actions","步骤操作"),
            (reorder?orderActions(word,index,draft.steps.length):"") +
            button(t.remove,"removeStep",{attrs:{"data-index":index,"data-revision":draft.stepRevision || 0}}),model.busy) : "";
        const itemActions=editable && !picking ? ` data-item-actions data-order-index="${index}" data-order-label="${h(info.title)}"` : "";
        return `<li${editable ? recordedSelection.row(index) : ""}${itemActions}>
            ${picking ? recordedSelection.checkbox(index,word("Select ","选择 ")+info.title) : reorder ? orderGrip(word) : ""}<div class="recorded-step-title"><strong>${h(info.title)}</strong>
            ${info.detail ? `<small>${h(info.detail)}</small>` : ""}
            ${picking && recordedSelection.previewId===String(index) ? recordedStepPreview(step,word) : ""}</div>${menu}</li>`;
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
    const location = ({phone:t.recordLocationPhone,preview:t.recordLocationPreview,auto:t.recordWaiting})[draft.location];
    if (draft.automatic) return h(location);
    const format = draft.stepFormat === "controls" ? t.recordFormatControls : t.recordFormatCoordinates;
    return h(location + " · " + format);
}

function recordingStage() {
    const draft = model.draft;
    const previewControls = draft.location === "preview" && draft.stepFormat === "controls";
    const n = draft.steps.length;
    const count = t.counter.replace("{n}", n);
    const finish = button(t.finish, "stopRecord", { primary: true });
    const tools = finish + button(n ? t.discard : t.cancelEmpty, "askDiscard");
    const last = draft.steps.at(-1);
    const logHeading = last ? "h2" : "h1";
    const info = last && stepInfo(last);
    const target = last?.input?.target;
    const facts = [];
    if (target?.type) facts.push([word("Control type","控件类型"),target.type]);
    if (target?.id) facts.push([word("Control ID","控件 ID"),target.id]);
    else if (target) facts.push([word("Locator","定位器"),typeof target==="string" ? target : JSON.stringify(target)]);
    if (info?.detail) facts.push([word("Action details","动作详情"),info.detail]);
    if (Number.isFinite(last?.delayMs)) facts.push([word("Replay delay","回放间隔"),last.delayMs+" ms"]);
    return `<div class="rec-stage"><header class="stage-head">
        <div class="record-status"><i aria-hidden="true"></i><strong>${h(t.recording)}</strong><span>${recordingDimensions(draft)}</span></div>
        <div class="toolbar">${tools}</div></header>
        ${last ? `<section class="rec-latest" aria-live="polite"><small>${word("Latest step","最新步骤")}</small>
            <div class="rec-current"><span>${String(n).padStart(2,"0")}</span><h1>${h(info.title)}</h1></div>
            ${facts.length ? `<dl class="rec-facts">${facts.map(([label,value])=>`<div><dt>${h(label)}</dt><dd><code>${h(value)}</code></dd></div>`).join("")}</dl>` : ""}</section>` : ""}
        <div class="${previewControls ? 'record-layout' : 'gesture-layout'}">
        ${previewControls ? `<section class="control-section"><div class="section-header"><h2>${t.controls}</h2>
            <div class="toolbar">${button(t.phoneBack, "action", { off: !model.page, attrs: {"data-command":"back"} })}
            ${button(model.page ? t.refreshPage : t.checkDevice, "observe")}</div></div>
            ${model.page ? `<input type="search" id="control-filter" value="${h(selection.filter)}" aria-label="${t.searchControls}" placeholder="${t.searchControls}">
                <div id="record-controls">${recordableControls()}</div>` : `<p class="list-placeholder">${t.checkDevice}</p>`}</section>` : ""}
        <section class="log-section" aria-label="${h(count)}"><div class="rec-log-head"><${logHeading}>${word("Action log","操作记录")}</${logHeading}><small>${h(count)}</small></div><div id="live-step-log">${recordedList(draft, false)}</div>
            ${draft.location === "phone" ? `<small class="native-note">${t.scopedPhone}</small>` : ""}</section></div></div>`;
}

function reviewRecording(draft) {
    const coordinates = draft.stepFormat === "coordinates";
    const dimensions = recordingDimensions(draft);
    const revision=draft.stepRevision || 0;
    recordedSelection.update(revision,draft.steps.map((_,index)=>index),model.busy);
    const tools=recordedSelection.tools(word,[{id:"remove",label:word("Delete selected","删除所选"),
        message:ids=>({type:"removeRecordedSteps",indices:ids.map(Number),revision})}]);
    const undo=draft.removedSteps?.length ? button(word("Undo deletion","撤销删除"),"undoRecordedRemoval",
        {attrs:{"data-revision":revision}}) : "";
    if (!draft.steps.length) return `<section class="record-home"><p class="kicker">${dimensions}</p><h1>${t.reviewTitle}</h1>
        <p class="guide-copy">${coordinates || draft.location === "phone" ? t.reviewEmpty : t.reviewEmptyControls}</p>
        ${undo}${button(t.startAgain, "discardRecord", { primary: true })}</section>`;
    const unsupported = draft.steps.some(step => step.input?.kind === "unsupported");
    const hasCoordinates = draft.steps.some(step => step.command === "deviceGesture");
    return `<section class="review-stage"><header class="stage-head"><div><p class="kicker">${dimensions}</p><h1>${t.reviewTitle}</h1>
        <p class="guide-copy">${t.reviewHint}</p></div><div class="toolbar">${button(word("Save as test case","保存为测试用例"), "caseReview", {primary:true,off:unsupported})}${button(t.saveRecording, "savePlan", {off:unsupported})}${button(t.discard, "askDiscard")}</div></header>
        <div class="review-body"><section><h2>${h(t.counter.replace("{n}", draft.steps.length))}</h2>${tools}${undo}${recordedList(draft,true)}</section>
        <div>${hasCoordinates ? `<p class="setup-note">${unsupported ? t.unsupportedHint : t.phoneScreenHint}</p>` : ""}
        ${coordinates ? "" : checksForm(draft)}
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

function aiOutput(result,key,{reportLinks=true}={}) {
    if (!result) return "";
    const waiting = result?.waitingForModel === "retry" ? t.modelRetry :
        result?.waitingForModel && t.modelReviewing.replace("{provider}", result.provider === "codex" ? "Codex" : "GitHub Copilot");
    const reads = result?.evidence || [];
    const evidenceLink = receipt=>{
        if (!reportLinks || !result.next) return "";
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

function currentCaseRun() {
    const run = model.run;
    return model.testView==="run" && isCaseRun(run?.entry,model.plan,model.activeCase?.id) ? run : undefined;
}

function selectedCaseRun() {
    const run = currentCaseRun();
    return run?.entry.id===dismissedReport ? undefined : run;
}

function caseRunSummary(run, locked = false) {
    const runs = caseHistoryEntries(model.runs).filter(entry=>isCaseRun(entry,model.plan,model.activeCase?.id));
    const latest = runs.find(entry=>!entry.compositionTrial && (!entry.repairOf || entry.repairApplied)) || runs[0];
    const retained = run || currentCaseRun();
    const shown = retained?.entry || latest;
    const replay = shown?.source==="device" || (!shown && model.planSummary?.source==="coordinates");
    const label = retained && shown.id!==latest?.id ? word("Selected run","所选运行") :
        replay ? word("Latest replay","最近回放") : word("Latest run","最近运行");
    const result = !shown && replay ? word("Not replayed","尚未回放") : caseRunStatus(shown,language);
    const meta = shown ? [shown.compositionTrial && word("Copy verification","副本验证"),
        shown.ruleGroupDisabled && word("Rule group off for this run","本次规则组已关闭"),
        shown.source==="pytest" ? "pytest" : word("Workbench","工作台"),caseRunTime(shown,language),
        retained?.runtimeMs === undefined ? "" : (retained.runtimeMs/1000).toFixed(2)+" s"].filter(Boolean).join(" · ") : "";
    const visible = run && shown.status!=="running";
    const toggle = visible || (!run && shown) ? actionButton(visible ? word("Hide summary","收起简报") : word("Show summary","展开简报"),
        {quiet:true,disabled:model.busy||locked,attrs:{id:"case-report-toggle","data-type":visible?"hideCaseReport":"report",
            "data-id":visible?undefined:shown.id,"aria-expanded":Boolean(visible)}}) : "";
    const full = shown && shown.status!=="running" ? actionButton(word("Full report","完整报告"),
        {quiet:true,disabled:model.busy||locked,attrs:{"data-type":"caseFullReport","data-id":shown.id,
            "data-index":caseEvidence?.id===shown.id ? caseEvidence.index : undefined}}) : "";
    return `<section class="case-run-summary" aria-label="${word("Run summary","运行摘要")}">
        <div class="case-run-description"><span class="case-run-label">${label}</span>
            <strong class="case-outcome" data-status="${h(shown?.status)}" role="status">${h(result)}</strong>
            ${meta ? `<small>${h(meta)}</small>` : ""}</div>
        <div class="case-summary-actions">${toggle}${full}
            ${runs.length>1 ? caseRunHistory(runs,language,{id:"case-run-history",label:word("Case history","用例历史"),selected:shown.id,disabled:model.busy||locked}) : ""}</div></section>`;
}

function caseEditValue(text,area,{index,path,add,defaultName,stepLabel,primaryStep,failure}={}) {
    const className = area==="name" ? "case-value case-title" : stepLabel ? "case-value case-step-name" : "case-value";
    return actionButton(text,{quiet:true,className,
        disabled:model.busy,attrs:{"data-type":"caseReview","data-case-area":area,"data-case-index":index,
            "data-case-path":path,"data-case-add":add,"data-step-default":defaultName,"data-order-hit":stepLabel?"":undefined,
            "data-selection-hit":!add && (stepLabel || area==="start" || area==="goal") ? "" : undefined,
            "data-step-editor":primaryStep?"":undefined,"data-from-failure":failure?"true":undefined}});
}

function findFailureRow(run,step) {
    if (!step?.path || run.entry.sourceDigest!==model.planDigest ||
        !["locator","assertion","page"].includes(model.failureReview?.kind)) return;
    const expected=step.path.replace(/\.repeat\.iteration\[\d+\]/g,".repeat.steps");
    function find(rows) {
        for (const row of rows || []) {
            const definition=model.caseDefinitions?.steps[row.path];
            if (definition && !definition.reference && !definition.description && (row.receiptPath || row.path)===expected) return row;
            for (const branch of row.branches || []) {
                if (branch.readOnly) continue;
                const match=find(branch.steps);
                if (match) return match;
            }
        }
    }
    return find(model.caseBdd?.steps);
}

function definitionBdd(run, coordinates) {
    const defs = model.caseDefinitions;
    const stepSelection = stepSelectionFor(model,defs && model.caseBdd?.steps?.some(step=>step.path));
    const selectionTools = stepSelectionControls(stepSelection,word,model,()=>{caseEvidence=undefined;});
    const tools = stepSelection?.active ? selectionTools : defs && `<div class="case-step-tools">${actionButton(word("Organize with AI","用 AI 整理步骤"),{quiet:true,disabled:model.busy || Boolean(model.planSummary?.pending?.length),
        attrs:{"data-type":"caseReview","data-case-area":"organize"}})}${compositionControls(model.caseBdd,word,model.busy)}${selectionTools}</div>`;
    const stepActions = !model.busy ? step=>(defs ? caseStepActions(step,defs.steps[step.path] || defs[step.area]?.[step.index],caseEditValue,word)+
        compositionStepMenu(step,model,word) : "") + caseForkStepMenu(step,model,word) : undefined;
    return caseBddView(model.caseBdd,language,{coordinates,tools,stepActions,stepSelection,definitions:defs,reorder:Boolean(defs && !model.busy),
        insert:Boolean(defs && !model.busy),
        renderRow:runRows(run,(text,context)=>{
        const {area,path,index,step}=context;
        if (stepSelection?.active) return caseStepLabel(text,step);
        const definition=defs?.steps[path] || defs?.[area]?.[index];
        return caseStepLabel(text,step,definition && caseEditValue(step.name || text,"stepDetails",
            {path,index,defaultName:text,stepLabel:true}));
    })});
}

function bddDefinition(bdd) {
    // Menu availability changes as the case is edited. Archived results describe the steps themselves.
    return JSON.stringify(bdd,(key,value)=>key==="exploration" ? undefined : value);
}

function caseWorkspace() {
    if (model.caseReview?.edit) return caseReviewView(model,language,caseRunSummary(undefined,true));
    if (!model.plan) return recordingWorkspace(model,t);
    const run = selectedCaseRun();
    const review = run && model.failureReview;
    const ready = model.devices.includes(model.device);
    const coordinates = model.planSummary?.source==="coordinates" || (!model.caseBdd && run?.entry.source==="device");
    const unavailable = model.pytestCase && (model.pytestReadiness?.issue || model.pytestReadiness?.workspaceBinding ||
        (model.pytestCase.requiresRuleGroup && !model.pytestReadiness?.ruleGroup));
    const canPytest = Boolean(model.pytestCase && !unavailable);
    const ruleGroup = model.planSummary?.scenarioName || model.planSummary?.ruleSteps;
    const skipRuleGroup = ruleGroup && runWithoutRuleGroup.has(model.plan.uri);
    const runner = canPytest ? caseRunners.get(model.plan.uri) || (ruleGroup ? "workbench" : "pytest") : "workbench";
    const running = run?.entry.status==="running";
    const runnerSelect = canPytest ? `<select id="case-runner" class="case-runner"
        aria-label="${h(word("Runner","执行方式"))}" ${disabled(model.busy)}>
        <option value="workbench" ${runner === "workbench" ? "selected" : ""}>${h(word("Workbench","工作台"))}</option>
        <option value="pytest" ${runner === "pytest" ? "selected" : ""}>pytest</option></select>` : "";
    const validCase = model.planSummary && !model.planSummary.error;
    const pending = model.planSummary?.pending;
    const runnable = validCase && !pending?.length;
    const exploreDraft = pending?.length && model.caseDefinitions ? actionButton(word("Explore the whole draft","探索整个草稿"),
        {primary:true,disabled:model.busy,attrs:{"data-compose":"reviseCase"}}) : "";
    const needsPhone = runnable && runner!=="pytest" && !ready;
    const runButton = running && run.canStop ?
        actionButton(word("Stop replay","停止回放"),{primary:true,attrs:{id:"case-run-action","data-type":"stopRun","data-id":run.entry.id}}) :
        button(running ? word("Running…","运行中…") : review ? word("Run current case","运行当前用例") :
            coordinates ? word("Replay","回放") : word("Run","运行"),coordinates ? "run" : "caseRun",
            {primary:!review,off:running||needsPhone||!runnable,attrs:{id:"case-run-action","data-runner":runner,"data-id":model.plan.uri}});
    const origin = model.activeCase?.origin;
    const exploration = model.activeCase?.source === "exploration";
    const prior = origin?.reportId && (exploration ? model.exploration?.id === origin.reportId ||
        model.explorationHistory?.some(item => item.id === origin.reportId) : model.runs.some(r => r.id === origin.reportId));
    const title = model.activeCase?.name || model.plan.name;
    const save = validCase && !model.caseDefinitions ? button(word("Save as case","保存为用例"),"caseReview") : "";
    const menu = `<details class="case-tools" id="case-tools">
        <summary title="${word("More actions","更多操作")}" aria-label="${word("More actions","更多操作")}">⋯</summary>
        <div>${button(word("View workflow JSON","查看流程 JSON"),"editPlan")}
        ${model.activeCase ? button(word("Duplicate case","复制用例"),"caseDuplicate",{attrs:{"data-id":model.activeCase.uri}})+
            button(model.activeCase.editable?word("Delete case","删除用例"):word("Remove from library","从用例库移除"),
                "caseRemove",{attrs:{"data-id":model.activeCase.uri}}) : ""}
        ${runnable && model.caseExplorationCheckpoints ? button(word("Explore other paths","探索其他走法"),"explorationFromCase",
            {attrs:{"data-uri":model.plan.uri,"data-digest":model.planDigest}}) : ""}
        ${prior ? button(word("Open source report","查看来源报告"),exploration?"explorationReport":"report",{attrs:{"data-id":origin.reportId}}) : ""}</div></details>`;
    const joined = run && !run.entry.compositionTrial && (!run.entry.repairOf || run.entry.repairApplied) && model.planDigest &&
        run.entry.sourceDigest===model.planDigest && model.caseBdd &&
        (run.entry.composedBdd || bddDefinition(model.caseBdd)===bddDefinition(run.bdd));
    const definition = model.caseBdd ? definitionBdd(joined ? run : undefined,coordinates) : planPreview(model.planSummary);
    const headingNote = [coordinates&&word("Coordinate recording","坐标录制"),needsPhone&&(coordinates ?
        word("Connect a phone to replay","连接手机后可回放") : word("Connect a phone to run","连接手机后可运行"))].filter(Boolean).join(" · ");
    const settings = validCase && (!coordinates || ruleGroup) ?
        `<details id="case-run-settings" class="case-run-settings" ${model.flowDebug?.planUri===model.plan.uri ? "open" : ""}>
            <summary>${word("Run settings & debugging","运行配置与调试")}${skipRuleGroup ?
                ' · '+word("Rule group off for next run","本次规则组已关闭") : ""}</summary>
            ${ruleGroup ? `<label class="case-run-rule-group"><input id="case-skip-rule-group" type="checkbox"
                ${skipRuleGroup?"checked":""} ${disabled(model.busy)}>${word("Turn off the rule group for the next run","本次关闭规则组")}</label>` : ""}
            ${coordinates ? "" : pytestWorkflow(model,language,button,h)+
                (pending?.length ? "" : workflowDebugView(model,language,t))}</details>` : "";
    const failedStep = run?.steps?.[review?.index];
    const failureRow = run && findFailureRow(run,failedStep);
    const failureKey = run?.entry.id + "/failure";
    const ai = model.aiResults?.diagnosis?.key === failureKey ? model.aiResults.diagnosis : undefined;
    const repair = run && repairView(model,run,language,button);
    const originalEvidence = failedStep && (run.selected===review.index && !needsStepEvidence(run,review.index) ?
        evidence(run,failedStep,"case-original-step")+errorDetails(run.frameError,"case-original-frame-error") :
        button(word("Load failure step evidence","读取失败步骤证据"),"step",{attrs:{"data-id":run.entry.id,"data-index":review.index}}));
    const manualEdit = failureRow && caseEditValue(word("Edit the failed step manually","手动编辑失败步骤"),"stepDetails",
        {path:failureRow.path,defaultName:failureRow.name || failureRow.text,failure:true});
    const rerun = run?.entry.source!=="device" && run?.entry.sourceDigest && run.entry.sourceDigest===model.planDigest ?
        (run.entry.source==="pytest" ? model.pytestCase && "pytest" : ready && "workbench") : undefined;
    return `<section class="plan-sheet case-detail-sheet"><header class="case-detail-head">
        <div class="case-heading"><h1>${model.caseDefinitions ? caseEditValue(title,"name") : h(title)}</h1>
            ${headingNote ? `<small>${h(headingNote)}</small>` : ""}</div>
        <div class="case-header-actions">${runnerSelect}${exploreDraft || runButton}${save}${menu}</div></header>
        ${casePendingNotice(pending,language)}
        ${model.caseDefinitions ? caseFeedbackView(model.caseBdd,caseEditValue(model.caseBdd?.editNote ? word("Edit feedback","编辑意见") :
            word("Case feedback","用例修改意见"),"caseFeedback"),word) : ""}
        ${caseRunSummary(run)}
        ${failureView(review,run?.entry.id,language,{stepTitle:failureRow?.name || failureRow?.text || (failedStep && stepTitle(failedStep)),
            expected:failedStep?.expected,actual:failedStep?.actual,ai,
            aiOutput:aiOutput(ai?.next ? {...ai,answer:undefined} : ai,failureKey,{reportLinks:false}),stop:aiStop(ai),disabled:model.busy,repair,
            repairKind:repair && model.repair?.kind,runner:rerun,evidence:originalEvidence,manualEdit,request:repair && model.repair?.request,
            canReadLive:ready && !run?.entry.repairOf})}
        ${!review && repair ? repair : ""}
        ${model.compositionStale ? `<p class="case-composition-warning">${word("Workflow JSON changed outside the editor. Showing executable steps.",
            "流程 JSON 已在用例编辑器之外修改，当前显示实际执行步骤。")}</p>`:""}
        ${settings}${definition}${run ? caseReportBody(run,joined) : ""}</section>`;
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

function errorDetails(message,id) {
    return message ? `<details class="run-diagnostic" id="${id}"><summary>${h(t.stationDiagnostic)}</summary>
        <p><code>${h(message)}</code></p></details>` : "";
}

function evidence(run, step, scope="case-step") {
    if (!step) return `<p class="empty">${t.noSteps}</p>`;
    const view = run.frame;
    const phases = ["before", "after"].filter(phase => step[phase]);
    const phaseTools = phases.length === 2 ? `<div class="phase-buttons">${phases.map(phase => button(t[phase], "step", {
        primary: run.phase === phase, attrs: {"data-id":run.entry.id,"data-index":run.selected,"data-phase":phase},
    })).join("")}</div>` : phases.length ? `<small>${h(t[phases[0]])}</small>` : "";
    const stepError = errorDetails(step.error,scope+"-error");
    if (step.gesture) {
        const receipt = step.dispatched === "acknowledged" ? t.stationAckSeen :
            step.status === "unknown" ? t.stationAckMissing : status(step.status);
        return `<section class="evidence gesture-receipt"><h3>${h(stepTitle(step))}</h3>
            <p>${word("Device","设备")} · ${h(receipt)}</p>${stepError}</section>`;
    }
    const facts = [[t.expected,step.expected],[t.actual,step.actual]].filter(([,value])=>value!==undefined);
    const tree = view ? `<details id="${scope}-tree"><summary>${word("Recorded UI tree","运行时控件树")}</summary>
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
        ${tree}${run.frameError ? button(word("Retry loading evidence","重新读取证据"),"step",{
            attrs:{"data-id":run.entry.id,"data-index":run.selected,"data-phase":run.phase}
        }) : !view&&!run.image ? `<p class="empty">${h(t.noFrame)}</p>` : ""}
        ${step.selector ? `<details id="${scope}-locator"><summary>${word("Locator","定位器")}</summary>
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

function needsStepEvidence(run, index) {
    const step = run.steps[index];
    return run.selected!==index || (!run.phase && Boolean(step?.before || step?.after || step?.screenshot));
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
        if (!context.path || context.step?.description) return body;
        const receipt = receipts.get(context.step?.receiptPath || context.path);
        const pending = run.entry.status==="running" ? word("Waiting","等待中") : word("Not reached","未执行");
        const value = receipt ? caseStepAction(run,receipt.step,receipt.index,true) : `<small class="case-step-status">${pending}</small>`;
        const open = receipt && showCaseEvidence(run,receipt.index,true);
        return `<div class="case-step-line"><span>${body}</span>${value}</div>${open ? caseStepEvidence(run,receipt.index) : ""}`;
    };
}

function caseStepEvidence(run,index) {
    if (needsStepEvidence(run,index)) return `<p class="case-evidence-pending" role="status">${h(t.working)}</p>`;
    const step = run.steps[index];
    const key = run.entry.id + "/" + index;
    const result = model.aiResults?.diagnosis;
    const diagnosis = model.failureReview?.index === index ? "" : inlineAI("diagnosis", t.stationAiExplain, result?.key === key ? result : undefined);
    return `<div class="case-step-evidence" id="run-evidence" data-selection-ignore>${evidence(run,step)}${errorDetails(run.frameError,"case-frame-error")}
        ${comparison(run)}
        <details id="case-evidence-tools"><summary>${word("More evidence tools","更多证据工具")}</summary>
            <div class="toolbar">${button(t.netStep,"networkStep")}${button(word("Full report","完整报告"),"caseFullReport",
                {attrs:{"data-id":run.entry.id,"data-index":index}})}${evidenceExport(model,language,"run")}</div>${diagnosis}
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
        return `<div class="case-run-notes">${errorDetails(model.error,"case-run-error")}
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
    const separateError = run.error!==run.steps[run.selected]?.error ? errorDetails(run.error,"case-run-error") : "";
    const canSave = distinct && !entry.repairOf &&
        (entry.source!=="pytest" || entry.pytest?.workflowSource);
    const tools = entry.status!=="running" ? `<details id="case-run-options"><summary>${word("Report options","报告操作")}</summary>
        ${button(word("Export HTML report","导出 HTML 报告"),"caseExportReport",{attrs:{"data-id":entry.id}})}
        ${canSave ? button(word("Save a copy of this run’s workflow","将本次执行版本另存为用例"),"caseReview",{attrs:{"data-from-run":true}}) : ""}</details>` : "";
    return `<section class="case-report-body" id="case-run-report" data-disclosure-owner="${h(entry.id)}">${note}${cleanup}${pytestPhases(run,language)}${separateError}
        ${noSteps ? `<p class="empty">${h(t.noSteps)}</p>` : snapshot+caseRunTrace(run)}${tools}</section>`;
}

function surfaceForState() {
    if (model.tool === "network" || model.tool === "inspect") return model.tool;
    const composition = model.caseComposition?.mode;
    if (model.tool === "exploration") {
        if (["explore","revision"].includes(composition)) return "case-exploration";
        const run = model.exploration;
        return run && !["ready","running","paused"].includes(run.status) ? "exploration-report" : "exploration";
    }
    if (composition && !["explore","revision"].includes(composition)) return "case-composition";
    if (model.caseReview) return model.caseReview.edit ? "case" : "case-review";
    if (model.draft) return model.recording ? "recording" : "review";
    return model.plan ? "case" : "recordings";
}

function focusKey(el) {
    if (!el || !shell.contains(el)) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.matches("summary")) return el.parentElement.id ? "#" + CSS.escape(el.parentElement.id) + " > summary" :
        el.closest(".station-settings") ? ".station-settings > summary" : "";
    const attrs = ["data-field", "data-type", "data-el", "data-x", "data-net", "data-bdd", "data-compose","data-compose-field",
        "data-source-id","data-side","data-area", "data-path",
        "data-row", "data-checkpoint", "data-view", "data-index", "data-command", "data-direction", "data-target", "data-id",
        "data-ref", "data-phase", "data-replacement", "data-case-area", "data-case-path", "data-case-index", "data-case-add", "data-inline",
        "data-list-pick","data-list-name","data-list-action"];
    if (el.hasAttribute("data-list-pick")) attrs.push("value");
    return attrs.filter(name => el.hasAttribute(name)).map(name => `[${name}="${CSS.escape(el.getAttribute(name))}"]`).join("");
}

function rememberCasePosition(path) {
    caseReturnPosition={key:shell.dataset.caseKey,top:toolContent.scrollTop,path,
        opened:Array.from(root.querySelectorAll(".case-bdd details[open][id]"),item=>item.id)};
}

function previewLibraryCase(uri) {
    if (!uri || pendingLibraryPreview || model.busy || model.tool!=="recordings" || model.caseReview || model.draft) return;
    if (model.plan?.uri===uri && model.testView==="workflow") return;
    caseEvidence=dismissedReport=undefined;
    pendingLibraryPreview=uri;
    vscode.postMessage({type:"caseOpen",id:uri,preview:true});
}

function render() {
    document.documentElement.lang = language;
    const surface = surfaceForState();
    const previous = shell.dataset.surface;
    const selected = toolNavigation.selected;
    const browsingLibrary=selected==="recordings" && !model.caseReview && !model.draft && ["case","recordings"].includes(surface);
    updateListSelectionScope(JSON.stringify([selected,surface,model.device,model.plan?.uri,model.caseReview?.id,
        selected==="recordings" ? model.testView : undefined, surface==="inspect" ? model.elements?.picking : undefined]),
        browsingLibrary ? JSON.stringify([selected,model.device]) : undefined);
    const areaTask=surface==="case-composition" || surface==="case-exploration";
    const inCase=surface==="case" || surface==="case-review";
    const itemKey=inCase ? surface==="case" ? model.plan?.uri : model.caseReview?.id : undefined;
    if (areaTask && shell.dataset.caseKey) {
        const focusedRow = document.activeElement?.closest("[data-case-step]");
        rememberCasePosition(model.caseComposition?.anchor?.path || focusedRow?.dataset.caseStep);
    }
    const returningToCase = inCase && itemKey && caseReturnPosition?.key===itemKey && previous!==surface &&
        (previous==="case-composition" || previous==="case-exploration" || (previous?.startsWith("exploration") && explorationReturn==="workflow"));
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
    const overview = selected === "recordings" ? `<button type="button" class="station-link station-overview" data-type="testRunOverview"
        title="${word("Open an overview of all runs in a new editor tab","在新标签页查看全部测试运行")}">
        ${artIcon("overview")}${word("Run overview","运行总览")}</button>` : "";
    const navigation = tabs + overview;
    if (navigation !== navigationSignature) {
        const scroll = toolNav.firstElementChild?.scrollLeft || 0;
        toolNav.innerHTML = navigation;
        toolNav.firstElementChild.scrollLeft = scroll;
        navigationSignature = navigation;
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
    if (areaTask) panel = compositionPage(model,language);
    if (surface === "inspect") panel = inspector();
    if (surface === "network") panel = networkView(model,language);
    if (surface.startsWith("exploration")) panel = explorationView(model,t,
        step => evidenceExport(model,language,"exploration",step),language);
    if (surface === "case-review") panel = caseReviewView(model,language);
    const confirm = selected === "recordings" && selection.confirmDiscard && model.draft ? `<div class="confirm-discard" role="group" aria-label="${h(t.discardAsk)}">
        <strong>${h(t.discardAsk)}</strong>${button(t.keep, "keepDraft", { primary: true })}${button(t.discard, "discardRecord")}</div>` : "";
    const detail = toolBack(surface) + confirm + panel;
    const html = selected === "recordings" && !areaTask ? `<div class="test-layout">${caseLibraryView(model,language,previewLibraryCase,Boolean(pendingLibraryPreview))}
        <div class="test-detail">${detail}</div></div>` : detail;
    const libraryContext = JSON.stringify([surface,model.device]);
    const itemContext = inCase ? itemKey : surface==="network" ? model.network?.viewedGroup?.id || model.network?.activeScenarioId :
        surface==="inspect" ? selection.ref : areaTask ? model.caseComposition?.viewId :
        surface.startsWith("exploration") ? model.exploration?.id || model.explorationFlow?.id : undefined;
    const context = JSON.stringify([libraryContext,itemContext]);
    if ((html !== contentSignature || context !== contentContext) && !inlineInsertion.deferRender(model,surface)) {
        closeItemMenu();
        cancelOrderDrag();
        const scrolls = ["node-list", "record-controls", "live-step-log", "net-record-list", "net-detail-body", "case-files", "bdd-target-results",
            "case-task-body","case-insert-results"]
            .map(id => document.getElementById(id)).filter(Boolean)
            .map(el => ({id: el.id, top: el.scrollTop, left: el.scrollLeft, key: el.dataset.scrollKey}));
        const oldLog = document.getElementById("live-step-log");
        const followSteps = oldLog && oldLog.scrollHeight - oldLog.clientHeight - oldLog.scrollTop < 4;
        const contentTop = toolContent.scrollTop;
        root.innerHTML = html;
        contentSignature = html;
        contentContext = context;
        previousDisclosures = restoreDisclosures(root,previousDisclosures,context,libraryContext);
        exitHiddenListSelection(root);
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
    inlineInsertion.sync(model,surface);
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
    if (returningToCase) {
        for (const id of caseReturnPosition.opened) {
            const branch = document.getElementById(id);
            if (branch) branch.open = true;
        }
        toolContent.scrollTop = caseReturnPosition.top;
        const row = caseReturnPosition.path && root.querySelector('[data-case-step="'+CSS.escape(caseReturnPosition.path)+'"]');
        (row?.querySelector(":scope > .case-sort-content summary, :scope > .case-sort-content .case-generate-step") ||
            row?.querySelector(":scope > [data-item-menu-trigger]") || root.querySelector('#case-insert-start') ||
            root.querySelector("h1 button"))?.focus({preventScroll:true});
        caseReturnPosition=undefined;
    } else if (itemChanged || (previous && previous !== surface && !sameCase)) {
        const heading = root.querySelector(".test-detail h1, h1");
        toolContent.scrollTop = 0;
        if (switchedTabs) activeTab.focus({preventScroll:true});
        else if (heading && !itemChanged && !activeListPreview("case-library")) {
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
    const revisionTarget = model.caseReview?.revisionFocus;
    if (inCase && !model.busy && revisionTarget?.token && revisionTarget.token!==revisionFocus) {
        revisionFocus=revisionTarget.token;
        focusCaseWork(revisionTarget.path);
    }
}

window.addEventListener("message", event => {
    const message = event.data;
    if (message.type==="caseLibraryPreviewed") {
        if (pendingLibraryPreview!==message.id) return;
        pendingLibraryPreview=undefined;
        const latest=activeListPreview("case-library");
        if (latest!==message.id) previewLibraryCase(latest);
        render();
        return;
    }
    if (message.type==="caseInsert") return inlineInsertion.receive(message);
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
    if (!message.state.draft) {
        selection.confirmDiscard = false;
        recordedSelection.reset();
    }
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
    if (appliedStepFocus && !model.busy) {
        const {id,revision,path}=appliedStepFocus;
        appliedStepFocus=undefined;
        if (model.caseReview?.id===id && model.caseReview.revision!==revision) focusCaseWork(path,"nearest");
    }
    if (closedCaseEditor && caseEditOrigin) {
        let origin = root.querySelector(caseEditOrigin);
        if (origin?.closest("[data-item-menu]")) origin=origin.closest(".case-library-row")?.querySelector(".case-file") ||
            origin.closest("[data-case-step]")?.querySelector(":scope > [data-item-menu-trigger]");
        if (origin?.disabled && model.busy) pendingFocus={key:caseEditOrigin};
        else origin?.focus({preventScroll:true});
        caseEditOrigin=undefined;
    }
    if (requestedCaseEdit && !model.busy) {
        const {area,index,path,add,failure} = requestedCaseEdit;
        requestedCaseEdit = undefined;
        if (model.caseReview) {
            const editor = [...root.querySelectorAll("[data-bdd][data-area]")].find(el=>el.dataset.area===area &&
                (["name","organize","caseFeedback"].includes(area) || ((path ? el.dataset.path===path : el.dataset.index===index) &&
                    (el.dataset.bdd==="add")===add)));
            if (editor && failure) editor.dataset.fromFailure="true";
            editor?.click();
        } else caseEditOrigin=undefined;
    }
});

function focusCaseWork(path, block="center") {
    if (path==="case") {
        root.querySelector('[data-area="caseFeedback"],[data-case-area="caseFeedback"]')?.focus({preventScroll:true});
        return;
    }
    const row=inlineInsertion.row(path);
    for (let parent=row?.closest("details");parent;parent=parent.parentElement.closest("details")) parent.open=true;
    const control=row && [...row.querySelectorAll(".case-step-name,.case-generate-step,summary,[data-item-menu-trigger]")]
        .find(node=>node.closest("[data-case-step]")===row && !node.closest("[data-item-menu]"));
    control?.focus({preventScroll:true});
    row?.scrollIntoView({block});
}

function handleClick(event) {
    const control = event.target.closest("button");
    if (!control || control.disabled) return;
    if (listSelectionClick(control,sendWorkbench,render)) return;
    if (inlineInsertion.click(control,model,language)) return;
    if (compositionClick(control,model,sendWorkbench,render)) return;
    if (event.target.closest("[data-tree-toggle]")) {toggleNode(control);return;}
    if (caseEditorClick(control,model,message=>vscode.postMessage(message),render)) return;
    const sourceMenu=control.closest("#net-add-source");
    if (sourceMenu) sourceMenu.open=false;
    if (["native","nativeChoose","nativeTimed"].includes(control.dataset.net)) {
        const options = control.closest("#network-native-options");
        if (options) options.open = false;
        requestedCaptureFocus = {action:control.dataset.net,device:model.device,previousId:model.network?.capture?.id};
    }
    if (networkClick(control,model,message=>vscode.postMessage(message),render)) return;
    if (flowDebugClick(control,model,message=>{
        if (message.type==="flowDebugStart" && runWithoutRuleGroup.delete(model.plan?.uri)) message.skipRuleGroup=true;
        sendWorkbench(message);
    },language)) return;
    if (elementClick(control)) return;
    if (exploreClick(control, model, message => vscode.postMessage(message), render,t)) return;
    let { type, view, ref, target, command, direction, id, phase, index, fromRun } = control.dataset;
    if (type==="casePending") {
        focusCaseWork(control.dataset.path);
        return;
    }
    if (type==="caseSave" && inlineInsertion.refocusDescription()) return;
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
        if (open && (needsStepEvidence(run,receipt) || phase && phase!==run.phase))
            vscode.postMessage({type:"step",id:run.entry.id,index:receipt,phase});
        return;
    }
    if (type==="caseReview" && control.dataset.caseArea) {
        const {caseArea,caseIndex,casePath,caseAdd}=control.dataset;
        requestedCaseEdit={area:caseArea,index:caseIndex,path:casePath,add:caseAdd==="true",failure:control.dataset.fromFailure==="true"};
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
    if (type==="report" && (control.id==="case-report-toggle" || control.closest("#case-run-history")) &&
        currentCaseRun()?.entry.id===id && Array.isArray(model.run.steps)) {
        render();
        return;
    }
    if (["explorationFromCase","explorationReport"].includes(type)) {
        explorationReturn="workflow";
        rememberCasePosition(control.closest("[data-case-step]")?.dataset.caseStep);
    }
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
    const menu = control.closest(".station-settings, #case-tools");
    if (menu) {
        menu.open = false;
        menu.querySelector("summary").focus({preventScroll:true});
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
        ...(type==="explorationFromCase" && {uri:control.dataset.uri,digest:control.dataset.digest,
            ...(control.dataset.checkpoint!==undefined && {checkpoint:Number(control.dataset.checkpoint)})}),
        ...(["run","caseRun"].includes(type) && runWithoutRuleGroup.delete(model.plan?.uri) && {skipRuleGroup:true}),
        ...(["removeStep","undoRecordedRemoval"].includes(type) && {revision:Number(control.dataset.revision)}),
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
    if (event.button!==0 || model?.busy || event.target.closest("button,a,input,textarea,select,[data-order-grip],.case-step-evidence")) return;
    const row = event.target.closest("[data-case-step]");
    const edit = row?.querySelector(":scope > [data-item-menu] [data-step-editor]");
    if (!edit) return;
    event.preventDefault();
    edit.click();
});
bindItemMenus(root,owner=>{
    if (!model) return [];
    if (owner.dataset.itemActions==="request") return requestMenuItems(owner,model,language,sendWorkbench,render);
    if (owner.dataset.itemActions==="request-field") return requestFieldMenuItems(owner,model,language,sendWorkbench,render);
    if (model.busy) return [];
    if (owner.dataset.itemActions==="rule-group") return ruleGroupMenuItems(owner,model,language,sendWorkbench,render);
    if (owner.dataset.itemActions==="element") return elementMenuItems(owner.dataset.ref);
    if (owner.dataset.itemActions==="finding")
        return menuItems(owner.querySelectorAll("[data-x=traceStep], [data-x=caseFinding], [data-x=save], [data-x=triage]"));
    return [];
},(owner,buttons)=>owner.hasAttribute("data-case-step") ? caseStepMenuItems(buttons,word) : undefined,
slot=>casePositionMenuItems(slot,model,word,message=>{
    if (message.type==="explorationFromCase") {
        explorationReturn="workflow";
        rememberCasePosition(slot.dataset.path);
    }
    sendWorkbench(message);
}));
document.addEventListener("keydown",event=>{
    if (event.defaultPrevented || model?.tool!=="network" || !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase()!=="f" || root.contains(event.target)) return;
    if (event.target===document.body || toolNav.contains(event.target) || event.target===toolContent)
        trafficKeydown(event,render);
});
const cancelOrderDrag = bindListOrder(root,change=>{
    if (!model || model.busy) return;
    const selectionExited = exitListSelection();
    const {row,list,from,to} = change, {orderKind:kind,orderKey:key} = list.dataset;
    if (kind!=="rules") pendingOrderFocus = {kind,key,to,tool:model.tool};
    if (kind==="recording") sendWorkbench({type:"moveRecordedStep",from,to,revision:model.draft?.stepRevision || 0});
    else if (kind==="case") sendWorkbench({type:"caseMoveStep",id:model.caseReview?.id,revision:model.caseReview?.revision,
        uri:model.plan?.uri,digest:model.planDigest,from:row.dataset.stepPath,to,...(key==="timeline" && {timeline:true})});
    else if (!networkOrder(change,model,sendWorkbench,render)) pendingOrderFocus=undefined;
    if (selectionExited) setTimeout(render,0);
});
bindListSelection(root,render,cancelOrderDrag);
root.addEventListener("invalid", event => {
    if (!event.target.closest("#bdd-editor")) return;
    for (let detail=event.target.closest("details"); detail; detail=detail.parentElement?.closest("details")) detail.open=true;
}, true);
root.addEventListener("submit", event => {
    if (repairSubmit(event,sendWorkbench)) return;
    caseEditorSubmit(event,model,message=>{
        if (message.area==="stepDetails") appliedStepFocus={id:message.id,revision:message.revision,path:message.path};
        sendWorkbench(message);
    });
});
root.addEventListener("keydown",compositionKeydown);
root.addEventListener("keydown", event => {
    if (event.key==="Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing &&
        event.target.closest("#bdd-editor.case-step-details")) {
        event.preventDefault();
        document.getElementById("bdd-apply")?.click();
        return;
    }
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
    if (event.key==="F2" && event.target.closest(".case-step-name, [data-case-step] summary, [data-case-step] > [data-item-menu-trigger]")) {
        const row = event.target.closest("[data-case-step]");
        const rename = row?.querySelector(':scope > [data-item-menu] [data-step-editor]');
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
    if (tabKeydown(event) || trafficKeydown(event, render) || treeKeydown(event,root,model.busy,toggleNode)) return;
});

root.addEventListener("input", event => {
    if (repairInput(event.target)) return;
    if (event.target.tagName!=="SELECT" && compositionInput(event.target,render)) return;
    if (caseEditorInput(event.target,model,sendWorkbench,render)) return;
    if (event.target.id === "ai-diagnosis-goal") {
        diagnosisGoals.set(event.target.dataset.diagnosis,event.target.value);
        return;
    }
    if (networkInput(event.target,render,message=>vscode.postMessage(message))) return;
    if (elementInput(event.target) || flowDebugInput(event.target,model,language)) return;
    if (exploreInput(event.target, model,t)) {
        if (event.target.hasAttribute("data-checkpoint")) render();
        return;
    }
    if (event.target.id === "replacement" || event.target.hasAttribute("data-replacement")) {
        replacements.set(event.target.dataset.target || selection.ref, event.target.value);
    } else if (event.target.id === "control-filter") {
        selection.filter = event.target.value;
        document.getElementById("record-controls").innerHTML = recordableControls();
    } else if (event.target.id === "node-filter" || event.target.id === "interactive-only") {
        inspectFilter = document.getElementById("node-filter").value;
        interactiveOnly = document.getElementById("interactive-only").checked;
        render();
        const list=document.getElementById("node-list");
        if (list) list.scrollTop=0;
    } else if (event.target.dataset.field === "expected") {
        selection.expected = event.target.value;
    }
});

function changeField(event) {
    if (listSelectionChange(event.target,render)) return;
    if (event.target.tagName==="SELECT" && compositionInput(event.target,render)) return;
    if (caseEditorInput(event.target,model,sendWorkbench,render)) return;
    if (event.target.dataset.x === "mode" && event.target.checked) {
        exploreClick(event.target,model,sendWorkbench,render,t);
        return;
    }
    if (event.target.id === "case-skip-rule-group") {
        if (event.target.checked) runWithoutRuleGroup.add(model.plan.uri);
        else runWithoutRuleGroup.delete(model.plan.uri);
        render();
        return;
    }
    if (event.target.id === "case-runner") {
        caseRunners.set(model.plan.uri,event.target.value);
        render();
        return;
    }
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
    for (const menu of root.querySelectorAll("#net-add-source[open],#network-native-options[open],#case-tools[open],#case-run-history[open]"))
        if (!menu.contains(event.target)) menu.open = false;
});
root.addEventListener("keydown", event => {
    const menu = root.querySelector("#sc-management[open],#net-add-source[open],#network-native-options[open],#case-tools[open],#case-run-history[open]");
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
    caseEditorToggle(event.target,model,sendWorkbench,render);
    if (event.target.id==="case-original-evidence" && event.target.open && event.target.isConnected && !model.busy) {
        const run = selectedCaseRun(), index = model.failureReview?.index;
        if (Number.isInteger(index) && run?.selected===index && needsStepEvidence(run,index))
            vscode.postMessage({type:"step",id:run.entry.id,index});
    }
    if (event.target.id === "check-options" && event.target.isConnected) selection.checksOpen = event.target.open;
    if (event.target.matches(".x-finding[data-finding-id]") && event.target.isConnected)
        exploreToggle(event.target,model,message=>vscode.postMessage(message));
}, true);

bindElements(render, ref => {
    exitListSelection();
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
