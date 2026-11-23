"use strict";

const failures = new Set(["failed", "rejected", "blocked", "unknown", "error", "budget_exhausted"]);
const deviceErrors = new Set(["NO_DEVICE", "DEVICE_NOT_FOUND", "DEVICE_DISCONNECTED", "DEVICE_RESTARTED", "DEVICE_IDENTITY_CHANGED",
    "DEVICE_OWNED", "DEVICE_MISMATCH", "HDC_NOT_FOUND", "HDC_START_FAILED", "HDC_TIMEOUT", "HDC_COMMAND_FAILED"]);
const pageErrors = new Set(["PRECONDITION_NOT_MET", "TARGET_NOT_ACTIONABLE", "INPUT_FOCUS_BLOCKED", "NOT_EDITABLE", "TARGET_NOT_SCROLLABLE"]);
const runnerPhases = new Set(["collection", "setup", "teardown", "pytest"]);

function reviewCaseFailure(run) {
    if (!run?.entry || !failures.has(run.entry.status)) return;
    const index = run.steps?.findIndex(step => failures.has(step.status));
    const step = index >= 0 ? run.steps[index] : undefined;
    const code = step ? step.errorCode : run.errorCode || run.entry.failureCode;
    const phase = step ? undefined : run.pytest?.phases?.find(p => p.outcome === "failed" && runnerPhases.has(p.phase))?.phase;
    let kind = "unknown";
    if (deviceErrors.has(code)) kind = "environment";
    else if (!step && (phase || run.pytest?.launchError || [4, 5].includes(run.pytest?.code))) kind = "runner";
    else if (step?.locatorFailure) kind = "locator";
    else if (step?.kind === "precondition" || pageErrors.has(code)) kind = "page";
    else if (step?.status === "failed" && (step.expected !== undefined || code === "ASSERTION_TIMEOUT")) kind = "assertion";
    return { kind, code, phase, index: step ? index : undefined };
}

module.exports = { reviewCaseFailure };
