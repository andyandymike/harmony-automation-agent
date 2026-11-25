"use strict";

const { timeRange } = require("./networkController");

const inactive = new Set(["not_run","out_of_scope","skipped","rejected"]);

function receiptTiming(row) {
    if (inactive.has(row.status) || row.kind==="unreachedGoals") return {};
    const nativeMs = Number.isFinite(row.elapsedMs) && row.elapsedMs>=0 ? row.elapsedMs : undefined;
    let range = timeRange(row);
    if (!range && nativeMs!==undefined) {
        const start = Date.parse(row.startedAt);
        if (Number.isFinite(start)) range = {start,end:start+nativeMs};
    }
    return {range,elapsedMs:nativeMs ?? (range && range.end-range.start)};
}

// Receipts with disjoint windows keep their runner-measured durations. If a
// parent and child cover the same interval, count their shared wall time once.
// Legacy result.steps contains sequential runner operations without timestamps.
function measuredTime(receipts) {
    let elapsedMs = 0;
    const windows = [];
    for (const row of receipts) {
        const {range,elapsedMs:duration} = receiptTiming(row);
        if (duration===undefined) continue;
        if (range && range.end>range.start) windows.push({...range,duration});
        else elapsedMs += duration;
    }
    windows.sort((a,b)=>a.start-b.start);
    let component;
    for (const window of windows) {
        if (!component || window.start>=component.end) {
            if (component) elapsedMs += component.duration;
            component = {...window};
        } else {
            component.end = Math.max(component.end,window.end);
            component.duration = component.end-component.start;
        }
    }
    return elapsedMs+(component?.duration || 0);
}

function addGroupTiming(group,rows) {
    if (inactive.has(group.status)) {
        group.timingCoverage = "not_executed";
        return;
    }
    const executed = group.indices.map(index=>rows[index]).filter(row=>!inactive.has(row.status) && row.kind!=="unreachedGoals");
    const timed = executed.filter(row=>Number.isFinite(row.elapsedMs));
    if (!timed.length) {
        group.timingCoverage = "missing";
        return;
    }
    group.elapsedMs = timed.length===1 ? timed[0].elapsedMs : measuredTime(timed);
    group.timingCoverage = timed.length===executed.length ? "complete" : "partial";
}

function countOutcomes(groups) {
    const counts = {total:groups.length,executed:0,completed:0,failed:0,notRun:0,outOfScope:0,skipped:0,interrupted:0,unconfirmed:0};
    for (const group of groups) {
        switch (group.status) {
        case "out_of_scope": counts.outOfScope++; break;
        case "rejected":
        case "not_run": counts.notRun++; break;
        case "skipped": counts.skipped++; break;
        case "passed":
        case "completed": counts.completed++; counts.executed++; break;
        case "failed":
        case "error": counts.failed++; counts.executed++; break;
        case "blocked":
        case "budget_exhausted":
        case "cancelled":
        case "yielded":
            counts.interrupted++;
            if (group.indices.length) counts.executed++;
            break;
        default:
            counts.unconfirmed++;
            if (group.indices.length) counts.executed++;
        }
    }
    return counts;
}

function buildMetrics(groups,rows) {
    for (const group of groups) addGroupTiming(group,rows);
    const steps = groups.filter(group=>group.area==="step");
    const goals = groups.filter(group=>group.area==="goal");
    const timed = steps.filter(group=>group.timingCoverage==="complete");
    const longest = timed.reduce((best,item)=>!best || item.elapsedMs>best.elapsedMs ? item : best,undefined);
    const slowest = longest && {number:longest.number,title:longest.title,elapsedMs:longest.elapsedMs,
        index:longest.indices.find(index=>Number.isFinite(rows[index].elapsedMs))};
    return {steps:countOutcomes(steps),goals:countOutcomes(goals),timedSteps:timed.length,slowest};
}

module.exports = { buildMetrics, receiptTiming };
