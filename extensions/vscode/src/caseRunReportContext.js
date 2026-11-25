"use strict";

const { gatewayIssue, requestSummary } = require("./aiEvidence");
const { readRunNetwork } = require("./caseRunAggregates");
const { during, timeRange } = require("./networkController");

function repairForRun(bench, entry) {
    const originalId = entry.repairOf || entry.id;
    const matches = view => {
        if (view?.id !== originalId) return false;
        if (entry.repairOf) return view.trial === entry.id;
        const trial = view.trial && bench.state.runs?.find(candidate => candidate.id === view.trial);
        return !trial || trial.repairOf === originalId;
    };
    const live = bench.state.repair;
    const saved = bench.caseRepair?.history?.get(originalId)?.view;
    const view = [live, saved].find(matches);
    if (view) {
        return {stage:view.stage, kind:view.kind, target:view.target, trialId:view.trial, stepName:view.stepName};
    }
    if (entry.repairOf && entry.repairApplied === true) {
        return {stage:"applied", target:entry.repairTarget, trialId:entry.id};
    }
}

function networkTrail(records, failure, range, runId) {
    const sameRun = records.filter(record => record.caseRunId === runId && !record.replayed && !record.replayOf);
    const errors = during(sameRun, [], range).records.filter(record => record.status >= 400 && record.status <= 599);
    if (errors.length !== 1) return;
    const anchor = errors[0];
    // A background request may fail during an unrelated UI assertion. Summarize only when its status
    // also occurs as a standalone number in the value actually observed by the failing check.
    const observedCodes = String(failure.actual ?? "").match(/\b[45]\d{2}\b/g) || [];
    if (!observedCodes.includes(String(anchor.status)) || !anchor.method || !anchor.path) return;
    const path = requestSummary(anchor).route;
    const sameExchange = record => record.method === anchor.method && record.path === anchor.path
        && anchor.request?.url && record.request?.url === anchor.request.url;
    const anchorTime = Date.parse(anchor.startedAt);
    const exchanges = sameRun.filter(record => record === anchor ||
        (Date.parse(record.startedAt) < anchorTime && sameExchange(record)))
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    return exchanges.map(record => ({
        method:anchor.method, path, status:record.status, source:record.source, issue:gatewayIssue(record),
        upstreamStatus:Number.isInteger(record.originalResponse?.status) ? record.originalResponse.status : undefined,
        ruleMatched:Boolean(record.ruleId),
    }));
}

async function reportContext(bench, run, rows, retained) {
    const {entry} = run;
    const context = {};
    const repair = repairForRun(bench, entry);
    if (repair) context.repair = repair;
    const diagnosis = bench.state.aiResults?.diagnosis;
    if (diagnosis?.key === entry.id + "/failure" && diagnosis.status === "done" && diagnosis.answer) {
        context.diagnosis = {finding:diagnosis.answer, next:diagnosis.next};
    }
    const failure = rows.find(row => row.firstBlocking);
    const range = timeRange(failure);
    if (!range || !bench.networks || failure.actual == null) return context;
    const archive=retained===undefined ? await readRunNetwork(bench.networks,entry.id) : retained;
    if (archive) {
        const trail = networkTrail(archive.records, failure, range, entry.id);
        if (trail) context.requestTrail = trail;
    }
    return context;
}

module.exports = { reportContext };
