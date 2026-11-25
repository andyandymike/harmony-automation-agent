"use strict";

const outcomesByStatus = {
    passed:"passed", failed:"failed", error:"failed", completed:"completed",
    skipped:"skipped", not_run:"skipped", blocked:"blocked", rejected:"blocked",
    budget_exhausted:"blocked", yielded:"blocked", cancelled:"cancelled", running:"running",
};

const isDecided = run => run.outcome==="passed" || run.outcome==="failed";
const idsOf = runs => runs.map(run=>run.id);
const hasDuration = run => Number.isFinite(run.durationMs) && run.durationMs>=0;
const nonempty = value => typeof value==="string" && value.trim() ? value : null;
const dateValue = value => typeof value==="number" ? value : Date.parse(value);

function trialType(entry) {
    if (entry.repairTarget) return "targeted";
    if (entry.repairOf) return "fullRepair";
    if (entry.compositionTrial) return "composition";
}

function indexCaseUris(entries) {
    const cases = new Map();
    for (const entry of entries) {
        const uri = nonempty(entry?.plan?.uri);
        const id = nonempty(entry?.caseId);
        if (!uri || !id) continue;
        if (!cases.has(uri)) cases.set(uri,id);
        else if (cases.get(uri)!==id) cases.set(uri,null);
    }
    return cases;
}

function selectRuns(entries, factsById, options) {
    // Older entries can lack a case id. A URI can bridge to a known id only
    // when that URI has belonged to exactly one case in the saved history.
    const cases = indexCaseUris(entries);
    const since = dateValue(options.since);
    const seen = new Set();
    const runs = [];
    for (const entry of entries) {
        if (!nonempty(entry?.id) || seen.has(entry.id)) continue;
        seen.add(entry.id);
        const time = dateValue(entry.time);
        if (Number.isFinite(since) && !(time>=since)) continue;
        const fact = (factsById instanceof Map ? factsById.get(entry.id) :
            Object.hasOwn(factsById,entry.id) && factsById[entry.id]) || {};
        const uri = nonempty(entry.plan?.uri);
        const id = nonempty(entry.caseId) || cases.get(uri);
        const caseKey = id ? "id:"+id : uri && (!cases.has(uri) || cases.get(uri)!==null) ? "uri:"+uri : null;
        const source = nonempty(fact.source) || nonempty(entry.source) || "workbench";
        runs.push({
            id:entry.id,caseKey,caseName:nonempty(entry.plan?.name) || id || uri || null,
            time:Number.isFinite(time) ? time : null,source,device:nonempty(entry.device) || nonempty(fact.device),
            outcome:Object.hasOwn(outcomesByStatus,entry.status) ? outcomesByStatus[entry.status] : "unknown",
            trial:trialType(entry),originalId:nonempty(entry.repairOf),
            verified:fact.targetVerified===true || entry.repairApplied===true,
            planDigest:nonempty(fact.planDigest) || nonempty(entry.planDigest),sourceDigest:nonempty(entry.sourceDigest),
            rulesDisabled:entry.ruleGroupDisabled===true,
            durationMs:fact.durationMs,failureCode:nonempty(fact.failureCode) || nonempty(entry.failureCode),
            failurePath:nonempty(fact.failurePath),
        });
    }
    runs.sort((a,b)=>(b.time ?? -Infinity)-(a.time ?? -Infinity));
    return Number.isInteger(options.limit) && options.limit>=0 ? runs.slice(0,options.limit) : runs;
}

function groupBy(runs, key) {
    const groups = new Map();
    for (const run of runs) {
        const value = run[key];
        if (!groups.has(value)) groups.set(value,[]);
        groups.get(value).push(run);
    }
    return groups;
}

function passCounts(runs) {
    return {passed:runs.filter(run=>run.outcome==="passed").length,decided:runs.filter(isDecided).length};
}

function caseCount(runs) {
    return new Set(runs.map(run=>run.caseKey).filter(Boolean)).size;
}

function comparable(left,right) {
    if (!left.device || left.device!==right.device || left.source!==right.source || left.rulesDisabled!==right.rulesDisabled) return false;
    if (left.planDigest || right.planDigest) return Boolean(left.planDigest && left.planDigest===right.planDigest);
    return Boolean(left.sourceDigest && left.sourceDigest===right.sourceDigest);
}

function trendFor(runs) {
    const latest = runs.find(run=>isDecided(run) && run.time!==null) || runs[0];
    const trend = {caseName:latest.caseName,latestId:latest.id,previousId:null,ids:[latest.id],kind:"insufficient",mixed:false};
    if (!isDecided(latest) || latest.time===null) return trend;
    const cohort = [latest,...runs.filter(run=>run.time!==null && run.time<latest.time &&
        isDecided(run) && comparable(latest,run))];
    if (cohort.length<2) return trend;
    const prev = cohort[1];
    trend.ids = idsOf(cohort);
    trend.previousId = prev.id;
    let changes=0;
    for (let index=1;index<cohort.length;index++) {
        if (cohort[index].outcome!==cohort[index-1].outcome) changes++;
    }
    trend.mixed = changes>=2;
    if (latest.outcome!==prev.outcome) trend.kind = latest.outcome==="passed" ? "recovered" : "regressed";
    else trend.kind = latest.outcome==="passed" ? "steady" : "persistent";
    // A failure can stop before the end of the plan. Compare like endpoints.
    const sameEndpoint = latest.outcome==="passed" && prev.outcome==="passed" ||
        latest.outcome==="failed" && prev.outcome==="failed" && latest.failurePath && latest.failurePath===prev.failurePath &&
        latest.failureCode && latest.failureCode===prev.failureCode;
    if (sameEndpoint && hasDuration(latest) && hasDuration(prev)) {
        trend.duration = {currentMs:latest.durationMs,previousMs:prev.durationMs,deltaMs:latest.durationMs-prev.durationMs};
    }
    return trend;
}

function buildTestRunOverview(entries=[],factsById={},options={}) {
    const all = selectRuns(entries,factsById,options);
    const independent = all.filter(run=>!run.trial);
    const categories = groupBy(independent,"outcome");
    const outcomes = Object.fromEntries(["passed","failed","completed","skipped","blocked","cancelled","running","unknown"]
        .map(key=>[key,idsOf(categories.get(key) || [])]));
    const trials = Object.fromEntries(["targeted","fullRepair","composition"]
        .map(key=>[key,idsOf(all.filter(run=>run.trial===key))]));
    const byCase = groupBy(independent,"caseKey");
    const cases = [...byCase].map(([key,runs])=>({
        name:key ? runs[0].caseName : null,ids:idsOf(runs),...passCounts(runs),
    }));
    const devices = [...groupBy(independent,"device")].map(([name,runs])=>({
        name,ids:idsOf(runs),caseCount:caseCount(runs),...passCounts(runs),
    }));
    const failures = [...groupBy(categories.get("failed") || [],"failureCode")].map(([code,runs])=>({
        code,ids:idsOf(runs),caseCount:caseCount(runs),
        sources:[...groupBy(runs,"source")].map(([name,items])=>({name,ids:idsOf(items)})),
    }));
    for (const list of [cases,devices,failures]) list.sort((a,b)=>b.ids.length-a.ids.length);
    const repairs = [...groupBy(all.filter(run=>run.originalId),"originalId")].map(([originalId,runs])=>({
        originalId,trialIds:idsOf(runs),
        fullPassedIds:idsOf(runs.filter(run=>run.trial==="fullRepair" && run.outcome==="passed")),
        // A verified target in a repeat can be applied even if the next action
        // in that body failed. Use the repair decision, not the trial status.
        targetedPassedIds:idsOf(runs.filter(run=>run.trial==="targeted" && run.verified)),
    }));
    const trends = [...byCase].filter(([key])=>key).map(([,runs])=>trendFor(runs));
    const timed = independent.filter(run=>hasDuration(run) && (isDecided(run) || run.outcome==="completed"));
    const slowest = timed.sort((a,b)=>b.durationMs-a.durationMs).map(({id,caseName,durationMs})=>({id,caseName,durationMs}));
    return {total:all.length,caseCount:caseCount(independent),independentIds:idsOf(independent),
        outcomes,passRate:passCounts(independent),cases,devices,failures,trials,repairs,trends,slowest,timedCount:timed.length};
}

module.exports = {buildTestRunOverview};
