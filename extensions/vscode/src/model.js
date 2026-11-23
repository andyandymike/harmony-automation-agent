"use strict";

function label(node) {
    return node.text || node.hint || node.description || node.id || node.type || node.ref;
}

function targetLabel(selector) {
    if (typeof selector === "string") return selector;
    return [selector?.text,selector?.id,selector?.description,selector?.hint,selector?.type,selector?.bundleName]
        .find(value => typeof value === "string" && value.length) || "";
}

function stableSelector(node, nodes) {
    const scope = node.bundleName ? { bundleName: node.bundleName } : {};
    const candidates = [];
    if (node.id) candidates.push({ ...scope, id: node.id });
    if (node.text) candidates.push(node.type ? { ...scope, text: node.text, type: node.type } : { ...scope, text: node.text });
    return candidates.find(selector => nodes.filter(candidate =>
        Object.entries(selector).every(([field, value]) => candidate[field] === value)
    ).length === 1);
}

function pageView(observation, { elements = false } = {}) {
    if (!observation) return null;
    const nodes = observation.nodes;
    const visible = elements ? nodes : nodes.filter(node => node.visible !== false);
    const counts = new Map();
    if (elements) {
        for (const n of nodes) {
            for (const key of elementKeys(n)) counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    return {
        frameId: observation.frameId,
        capturedAt: observation.capturedAt,
        truncated: observation.quality?.truncated || false,
        ...(elements && { elements: true, complete: observation.quality?.complete === true }),
        nodes: visible.map(node => ({
            ref: node.ref,
            parent: node.parent,
            label: label(node),
            id: node.id,
            type: node.type,
            bundle: node.bundleName,
            text: node.text ?? "",
            visible: node.visible,
            selector: elements ? elementSelector(node, counts) : stableSelector(node, nodes),
            ...(elements && { bounds:node.bounds, attributes:Object.fromEntries(Object.entries(node)
                .filter(([field,value]) => value != null && !["sources","path","identity","parent","center","ref","bounds"].includes(field))) }),
            pressable: node.enabled !== false && Boolean(node.clickable || node.checkable),
            editable: node.enabled !== false && node.editable === true,
            scrollable: node.enabled !== false && node.scrollable === true,
        })),
    };
}

function elementKeys(node) {
    const scope = node.bundleName || "";
    return [node.id && JSON.stringify([scope,"id",node.id]),
        node.text && JSON.stringify([scope,"text",node.text,node.type])].filter(Boolean);
}

function elementSelector(node, counts) {
    const scope = node.bundleName ? {bundleName:node.bundleName} : {};
    for (const key of elementKeys(node)) {
        if (counts.get(key) !== 1) continue;
        return JSON.parse(key)[1] === "id" ? {...scope,id:node.id} :
            {...scope,text:node.text,...(node.type && {type:node.type})};
    }
}

function recordedPlan(steps, start, goal, property, expected) {
    return {
        version: "1",
        ...(start && { preconditions: [{ selector: start.selector, property: "visible", equals: true }] }),
        steps: steps.map(({ command, input }) => ({ command, input })),
        ...(goal && { goals: [{ selector: goal.selector, property, equals: expected }] }),
    };
}

function moveListItem(items, from, to) {
    if (!Array.isArray(items) || ![from,to].every(i=>Number.isInteger(i) && i>=0 && i<items.length) || from===to) return false;
    const [item] = items.splice(from,1);
    items.splice(to,0,item);
    return true;
}

const deviceRecordingFormat = "harmony-agent.device-recording";

const exceptional = new Set(["failed", "unknown", "cancelled", "budget_exhausted"]);

function runView(record) {
    const result = record.result || record;
    const assertions = result.goalVerification?.assertions || [];
    const receipts = record.receipts || result.steps || [];
    const steps = receipts.map((step,index) => {
        const detail = step.result || step.error?.details || {};
        const errorCode = step.error?.code;
        const condition = ["precondition", "goal", "assert"].includes(step.kind);
        const assertion = condition ? detail : detail.assertion;
        const target = assertion?.selector ?? detail.action?.target ?? detail.selector;
        const failedVerification = [detail.inputVerification?.status,assertion?.status].find(value=>
            value === "failed" || value === "unknown");
        const status = condition ? detail.status || step.status :
            step.status === "completed" && failedVerification ? failedVerification : step.status;
        const dispatched = detail.action?.dispatched ?? step.error?.dispatched ?? step.error?.details?.dispatched;
        const lookupFailed = ["TARGET_NOT_FOUND","AMBIGUOUS_TARGET","TARGET_AMBIGUOUS","TARGET_NOT_ACTIONABLE"].includes(errorCode);
        // The terminal lookup can capture a newer page than the one at step start.
        const failureFrame = step.kind==="command" && index===receipts.length-1 && dispatched==="no" && lookupFailed &&
            result.observation?.frameId;
        return {
            path: step.path,
            kind: step.kind,
            command: step.command,
            status,
            dispatched,
            elapsedMs: step.elapsedMs,
            at: step.at,
            startedAt: step.startedAt,
            before: step.beforeFrameId || detail.beforeFrameId || failureFrame || step.basisFrameId,
            after: step.afterFrameId || detail.afterFrameId || assertion?.frameId || detail.frameId,
            screenshot: detail.evidence?.screenshot,
            selector: target,
            property: assertion?.property,
            expected: assertion?.expected,
            actual: assertion?.actual,
            ...(Number.isInteger(assertion?.matches) && {matches:assertion.matches}),
            ...(assertion?.status && {assertionStatus:assertion.status}),
            error: step.error?.message,
            ...(errorCode && {errorCode}),
            ...((["TARGET_NOT_FOUND","AMBIGUOUS_TARGET","TARGET_AMBIGUOUS"].includes(errorCode) ||
                ((!errorCode || errorCode === "ASSERTION_TIMEOUT") && condition && assertion?.status !== "passed" &&
                    Number.isInteger(assertion?.matches) && assertion.matches !== 1))
                && {locatorFailure:true}),
        };
    });
    const firstException = steps.findIndex(step => exceptional.has(step.status));
    return {
        status: result.status === "completed" && result.goalVerification?.status === "passed" ? "passed" :
            result.status === "running" ? "unknown" : result.status,
        runtimeMs: result.profile?.coreWallMs,
        cleanup: result.sessionCleanup?.status ?? record.workflowReceipt?.sessionCleanup?.status,
        goalStatus: result.goalVerification?.status,
        error: result.error?.message,
        ...(result.error?.code && {errorCode:result.error.code}),
        steps,
        selected: firstException >= 0 ? firstException : Math.max(steps.length - 1, 0),
        lastFrame: result.observation?.frameId || assertions.at(-1)?.frameId,
    };
}

function compareRuns(current, earlier) {
    const signature = step => JSON.stringify([step.status, step.command, step.selector, step.expected, step.actual]);
    for (let index = 0; index < Math.max(current.steps.length, earlier.steps.length); index++) {
        const first = current.steps[index];
        const second = earlier.steps[index];
        if (!first || !second || first.path !== second.path || signature(first) !== signature(second)) {
            return { current: first, earlier: second };
        }
    }
    return null;
}

// Receipts identify an action by its execution path. Acknowledged operations may omit the authored selector.
function withAuthoredTargets(view, plan) {
    if (!Array.isArray(view?.steps) || !Array.isArray(plan?.steps)) return view;
    const steps = view.steps.map(receipt => {
        if (receipt.selector || !receipt.command || typeof receipt.path !== "string") return receipt;
        const operation = receipt.path.replace(/\.repeat\.iteration\[\d+\]/g, ".repeat.steps");
        if (!/^steps\[\d+\](?:\.(?:then|else|repeat\.steps)\[\d+\])*$/.test(operation)) return receipt;
        const step = operation.match(/[a-z]+|\d+/g).reduce((node, key) => node?.[key], plan);
        if (step?.command !== receipt.command) return receipt;
        const name = targetLabel(step.input?.target);
        return name ? {...receipt, authoredTarget:name} : receipt;
    });
    return {...view, steps};
}

module.exports = { pageView, recordedPlan, moveListItem, runView, compareRuns, deviceRecordingFormat, targetLabel, withAuthoredTargets };
