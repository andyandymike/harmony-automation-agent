import { actionButton, escapeHtml as h } from "./ui/controls.js";

const live = status => ["ready", "running", "paused"].includes(status);

export function guidedOutcome(report, t) {
    const session = {ready:t.xWatching, running:t.xActive, paused:t.xPaused, stopping:t.xStopping};
    if (session[report.status]) return session[report.status];
    const branches = report.branches || [];
    const baseline = report.originalStatus || branches.find(branch => branch.id === "baseline")?.status;
    const states = report.variationStates || branches.filter(branch => branch.id !== "baseline" && branch.kind!=="prefix").map(branch => branch.status);
    if (report.routeMode==="fork") {
        const prefix=report.prefixStatus || branches.find(b=>b.kind==="prefix")?.status;
        if (["failed","blocked"].includes(prefix)) return t.xForkPrefixFailed;
        if (states.includes("completed") || states.includes("passed")) return t.xForkRecorded;
    }
    if (baseline === "failed") return t.xRouteFailedBase;
    if (states.includes("failed")) return t.xRouteFailedAlternative;
    if (report.status === "blocked" || baseline === "blocked" || states.includes("blocked")) return t.xBlocked;
    if (report.status === "stopped") return t.xStopped;
    if (["pending", "incomplete"].includes(baseline) || states.some(state => ["pending", "incomplete", "running"].includes(state))) return t.xRouteIncomplete;
    if (states.includes("completed")) return states.includes("passed") ? t.xRouteUnchecked : t.xRouteObserved;
    if (states.includes("passed")) return t.xRouteChecked;
    if (states.length && states.every(state => state === "skipped")) return t.xRouteNoAlternative;
    return t.xDone;
}

function routeStatus(value, t, active) {
    const labels = {passed:t.xRouteChecked, completed:t.xRouteObserved, failed:t.xFailure, blocked:t.xBlocked,
        skipped:t.xSkipped, pending:active ? t.xWait : t.xRouteUntested, incomplete:t.xIncomplete,
        running:t.xActive, paused:t.xPaused};
    return labels[value] || value;
}

function rawStepLabel(step, t) {
    if (!step) return "";
    const target = step.input?.target || step.assert?.selector;
    const name = typeof target === "string" ? target : target?.text || target?.description || target?.id || target?.type;
    const kind = step.command || (step.assert && "assert");
    return [t[kind] || kind, name].filter(Boolean).join(" · ");
}

function positionName(index, report, t) {
    if (index===-1) return t.xForkStart;
    const point = report.checkpointDetails?.find(item => item.index === index);
    const label = point?.label || rawStepLabel(report.plan?.steps?.[index], t);
    return [t.xRoutePosition.replace("{n}", point?.position ?? index + 1), label].filter(Boolean).join(" · ");
}

export function guidedActivity(report, t) {
    const fork=report.routeMode==="fork";
    const baseline = report.branches?.find(item => item.id === (fork?"prefix":"baseline"));
    const branch = report.branches?.find(item => item.status === "running" && item.kind === "variant");
    if (!baseline) return t.xWatching;
    if (!branch) return ["pending", "running"].includes(baseline.status) ? (fork?t.xForkRunningPrefix:t.xRouteRunningBase) : t.xRouteFindingPaths;
    const act = branch.choice?.label || branch.label;
    const phase = report.pending?.phase;
    if (phase === "check") return t.xRouteChecking;
    if (phase === "variant") return t.xRouteTrying.replace("{action}", act);
    if (phase === "return") return t.xRouteReturning.replace("{action}", act);
    if (phase === "anchor") return t.xRouteReturnTo.replace("{position}", positionName(branch.checkpoint, report, t));
    return t.xRouteFindingPaths + " · " + positionName(branch.checkpoint, report, t);
}

function branchFinding(branch, report) {
    return report.findings.find(item => item.kind === "failure" && (item.branchId === branch.id ||
        (!item.branchId && report.steps.some(step => step.id === item.stepId &&
            (step.key === branch.id || step.key?.startsWith(branch.id + "/"))))));
}

function displayValue(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
}

function branchRow(branch, model, t, label, marker = "") {
    const report = model.exploration;
    const finding = branchFinding(branch, report);
    const routes = model.explorationCaseRoutes;
    const button = (type, title, id, options = {}) => actionButton(title,
        {...options, attrs:{"data-x":type, "data-id":id}});
    const actions = [];
    if (finding?.canRecheck) {
        const connected = model.device === report.device && model.devices?.includes(report.device);
        actions.push(button("recheck", t.xRecheck, finding.id, {primary:true, disabled:model.busy || !connected || live(report.status)}));
    }
    if (finding && routes?.findingIds?.includes(finding.id) && (branch.id !== "baseline" || !report.sourceCase)) {
        actions.push(button("caseFinding", t.xRouteSave, finding.id, {disabled:model.busy}));
    } else if (branch.id !== "baseline" && routes?.branchIds?.includes(branch.id)) {
        actions.push(button("caseBranch", report.routeMode==="fork" ? t.xForkReview : t.xRouteSave, branch.id, {primary:report.routeMode==="fork",disabled:model.busy}));
    }
    if (routes?.diffBranchIds?.includes(branch.id)) {
        actions.push(button("applyBranchDifference", t.xRouteDiff, branch.id, {quiet:true, disabled:model.busy}));
    }
    if (finding?.stepId) actions.push(button("traceStep", t.xInspectTrace, finding.stepId, {quiet:true}));
    const lastRecheck = finding?.retests?.at(-1);
    const recheckStatus = lastRecheck && {reproduced:t.xReproduced, passed:t.xRouteChecked, inconclusive:t.xInconclusive}[lastRecheck.status];
    const target = finding?.selector;
    const checkTarget = typeof target === "string" ? target : target?.text || target?.description || target?.id || target?.type;
    const comparison = finding && [["expected", t.expected], ["actual", t.actual]]
        .filter(([key]) => finding[key] !== undefined)
        .map(([key, title]) => `<div><dt>${h(title)}</dt><dd>${h(displayValue(finding[key]))}</dd></div>`).join("");
    const reason = finding ? (comparison ? "" : finding.title || branch.reason) : branch.reason;
    const reached=["completed","passed"].includes(branch.status);
    const status=branch.kind==="prefix" && reached ? t.xForkReady : report.routeMode==="fork" && reached ? t.xForkRecorded :
        routeStatus(branch.status,t,live(report.status));
    const actionStep = branch.kind === "variant" && report.steps.find(step => step.key === branch.id + "/act" &&
        step.status === "completed" && step.receipts?.some(receipt => receipt.dispatched === "acknowledged"));
    return `<li class="x-route-row" data-outcome="${h(branch.status)}">
        ${marker ? `<span class="x-route-marker" aria-hidden="true">${h(marker)}</span>` : ""}
        <div class="x-route-row-head"><strong>${h(label)}</strong><span>${h(status)}</span></div>
        ${actionStep?.from && actionStep.to ? `<p class="x-observed-path">${h(actionStep.from)} <span>→</span> ${h(actionStep.to)}</p>` : ""}
        ${checkTarget ? `<p>${h(checkTarget)}</p>` : ""}
        ${comparison ? `<dl class="x-route-values">${comparison}</dl>` : ""}
        ${reason ? `<p class="x-route-note">${h(reason)}</p>` : ""}
        ${recheckStatus ? `<p class="x-route-note">${h(t.xLatestCheck)} · ${h(recheckStatus)}</p>` : ""}
        ${actions.length ? `<div class="toolbar">${actions.join("")}</div>` : ""}</li>`;
}

export function guidedComparison(model, t) {
    const report = model.exploration;
    const branches = report.branches || [];
    const fork=report.routeMode==="fork";
    const baseline = branches.find(branch => branch.id === (fork?"prefix":"baseline"));
    if (!baseline && !branches.length) {
        return `<p class="x-route-note">${h(live(report.status) ? t.xWatching : t.xRouteNoRecorded)}</p>`;
    }
    const groups = new Map();
    for (const branch of branches) {
        if (branch === baseline || !Number.isInteger(branch.checkpoint)) continue;
        if (!groups.has(branch.checkpoint)) groups.set(branch.checkpoint, []);
        groups.get(branch.checkpoint).push(branch);
    }
    const tried = branches.filter(branch => branch !== baseline && (["completed", "passed", "failed"].includes(branch.status) ||
        report.steps.some(step => step.key === branch.id + "/act" && step.receipts?.some(receipt => receipt.dispatched === "acknowledged")))).length;
    const sections = [];
    for (const [index, options] of groups) {
        const point = report.checkpointDetails?.find(item => item.index === index);
        const original = point?.nextLabel || rawStepLabel(report.plan?.steps?.[index + 1], t);
        const rows = [];
        const placeholders = new Set();
        for (const [slot, branch] of options.entries()) {
            // Two reserved attempts at a position do not imply two discoverable paths.
            if (!branch.choice && ["pending", "skipped"].includes(branch.status)) {
                if (placeholders.has(branch.status)) continue;
                placeholders.add(branch.status);
            }
            const marker = branch.choice || branch.entryId ? String(slot+1).padStart(2,"0") : "";
            rows.push(branchRow(branch, model, t, branch.choice?.label || (branch.entryId && branch.label) || t.xRouteUntried, marker));
        }
        sections.push(`<section class="x-route-group"><h3>${h(positionName(index, report, t))}</h3>
            ${original || (!fork && report.plan) ? `<p class="x-route-original"><span>${h(fork?t.xForkOriginalNext:t.xRouteOriginalAction)}</span> ${h(original || t.xRouteEndpoint)}</p>` : ""}
            ${!fork && point?.checks?.length ? `<div class="x-route-checks"><span>${h(t.xRouteChecks)}</span><ul>${point.checks.map(check => `<li>${h(check)}</li>`).join("")}</ul></div>` : ""}
            <ul class="x-route-list">${rows.join("")}</ul></section>`);
    }
    return `<section class="x-route-comparison">
        ${groups.size ? `<p class="x-route-count">${h(fork ? t.xRouteCount.replace("{n}", tried) : t.xRoutePositions.replace("{n}", groups.size)+" · "+t.xRouteCount.replace("{n}", tried))}</p>` : ""}
        ${baseline ? `<ul class="x-route-list x-route-baseline">${branchRow(baseline, model, t, fork?t.xForkPrefix:t.xRouteBaseline)}</ul>` : ""}
        ${sections.join("")}</section>`;
}
