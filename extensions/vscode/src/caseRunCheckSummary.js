"use strict";

const recordedOutcomes = new Set(["passed","failed","unknown"]);
const goalPath = /^goals\[\d+\]$/;

function summarizeRunChecks(rows, outline, run) {
    const counts = {passed:0,failed:0,unknown:0,goalsNotRun:0,goalsOutOfScope:0};
    const goals = new Map();
    const goalForRow = new Map();
    for (const [ordinal,group] of (outline?.goals || []).entries()) {
        const path = group.path || `goals[${ordinal}]`;
        goals.set(path,group.status);
        for (const index of group.indices || []) goalForRow.set(index,path);
    }

    // Older reports can keep final checks only in the terminal result. A live
    // receipt for that same goal below replaces it, so it is counted once.
    const resultByGoal = new Map();
    for (const [index,assertion] of (run?.finalAssertions || []).entries()) {
        if (recordedOutcomes.has(assertion?.status)) resultByGoal.set(`goals[${index}]`,assertion.status);
    }
    for (const [index,row] of rows.entries()) {
        if (row.kind==="if" || row.kind==="repeat" || row.kind==="unreachedGoals" || row.condition) continue;
        if (!recordedOutcomes.has(row.assertionStatus)) continue;
        const path = goalForRow.get(index) || (goalPath.test(row.path) && row.path);
        if (path) resultByGoal.set(path,row.assertionStatus);
        else counts[row.assertionStatus]++;
    }
    for (const outcome of resultByGoal.values()) counts[outcome]++;
    for (const [path,status] of goals) {
        if (resultByGoal.has(path)) continue;
        if (status==="not_run" && run?.goalStatus!=="not_requested") counts.goalsNotRun++;
        if (status==="out_of_scope") counts.goalsOutOfScope++;
    }
    return counts;
}

module.exports = { summarizeRunChecks };
