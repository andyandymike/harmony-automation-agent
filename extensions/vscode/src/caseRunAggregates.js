"use strict";

const { requestSummary } = require("./aiEvidence");
const { timeRange } = require("./networkController");

const nonnegative = value => Number.isFinite(value) && value>=0;
const integerCount = value => Number.isSafeInteger(value) && value>=0;

function concreteLoops(indices,rows) {
    const loops=new Map();
    for (const index of indices) {
        const row=rows[index], path=row.path || "";
        for (const match of path.matchAll(/\.repeat\.(check|iteration)\[(\d+)\]/g)) {
            // An inner loop is a distinct invocation in every outer iteration.
            const root=path.slice(0,match.index);
            if (!loops.has(root)) loops.set(root,{index,title:row.title,rounds:new Set()});
            const loop=loops.get(root), attempt=Number(match[2]);
            if (match[1]==="iteration") loop.rounds.add(attempt);
            else if (row.kind==="repeat" && match.index+match[0].length===path.length) {
                loop.lastCheck=attempt;
                loop.condition=row.condition;
            }
        }
    }
    return Array.from(loops.values(),loop=>{
        const {index,title,rounds,lastCheck,condition}=loop;
        if (!["passed","failed"].includes(condition) || lastCheck>rounds.size ||
            Array.from(rounds).some(attempt=>attempt>=rounds.size)) return {index,title};
        return {index,title,iterations:rounds.size,conditionMet:condition==="passed"};
    });
}

function runtimeMeasurements(record) {
    const result=record.result || record;
    const counters=result.counters || {};
    const stages=Object.entries(result.profile?.stagesMs || {})
        .filter(([,value])=>nonnegative(value)).map(([name,elapsedMs])=>({name,elapsedMs}))
        .sort((a,b)=>b.elapsedMs-a.elapsedMs);
    return {actions:integerCount(counters.actions) ? counters.actions : undefined,
        captures:integerCount(counters.captures) ? counters.captures : undefined,stages};
}

function executionSummary(run,rows,outline) {
    const byAction=new Map(), rechecked=[];
    let actionMs=0, timedActions=0;
    for (const row of rows) {
        if (row.actionRecorded || (run.entry.source==="device" && row.kind==="command" && row.dispatched==="acknowledged")) {
            const command=row.command || "action";
            if (!byAction.has(command)) byAction.set(command,[]);
            byAction.get(command).push(row.index);
        }
        const duration=row.nativeActionMs ?? row.actionTiming?.elapsedMs;
        if (nonnegative(duration) && row.kind==="command" && (row.actionRecorded || run.entry.source==="device")) {
            actionMs+=duration;
            timedActions++;
        }
        if (row.assertionAttempts>1 && ["passed","failed","unknown"].includes(row.assertionStatus))
            rechecked.push({title:row.title,index:row.index,attempts:row.assertionAttempts,status:row.assertionStatus});
    }
    const actionKinds=Array.from(byAction,([command,indices])=>({command,count:indices.length,indices}));
    const loops=outline.groups.flatMap(group=>(group.loops || []).filter(loop=>loop.iterations!==undefined)
        .map(loop=>({...loop,number:group.number,title:group.loops.length===1 ? group.title : loop.title})));
    // A legacy run with no runner counters can still show individual observed
    // actions. An unknown dispatch is never counted as a confirmed action.
    const actions=run.measurements?.actions ?? (run.entry.source==="device" &&
        rows.length && rows.every(row=>row.kind==="ruleGroup" || row.dispatched==="acknowledged" || row.dispatched==="no")
        ? actionKinds.reduce((sum,kind)=>sum+kind.count,0) : undefined);
    return {execution:{actions,captures:run.measurements?.captures,receipts:rows.filter(row=>row.kind!=="unreachedGoals").length,
        actionKinds,loops,rechecked},actionMs:timedActions ? actionMs : undefined};
}

function shareOfWall(groups,rows,run,total) {
    if (!groups.length || !(run.runtimeMs>0) || total>run.runtimeMs) return;
    const start=Date.parse(run.startedAt || (run.entry.source==="device" && rows[0]?.startedAt));
    if (!Number.isFinite(start)) return;
    const spans=[];
    for (const group of groups) {
        const windows=group.indices.map(index=>timeRange(rows[index]));
        if (windows.some(range=>!range)) return;
        const first=Math.min(...windows.map(range=>range.start));
        const last=Math.max(...windows.map(range=>range.end));
        if (first<start || last>start+run.runtimeMs) return;
        if (spans.some(span=>first<span.end && last>span.start)) return;
        spans.push({start:first,end:last});
    }
    return total/run.runtimeMs;
}

function buildRunAggregates(run,rows,outline) {
    const {execution,actionMs}=executionSummary(run,rows,outline);
    const timed=outline.groups.filter(group=>group.area==="step" && group.timingCoverage==="complete")
        .sort((a,b)=>b.elapsedMs-a.elapsedMs);
    const leading=timed.slice(0,3);
    const topSteps=leading.map(group=>({number:group.number,title:group.title,index:group.indices[0],elapsedMs:group.elapsedMs}));
    const topMs=topSteps.reduce((sum,group)=>sum+group.elapsedMs,0);
    return {execution,timing:{wallMs:nonnegative(run.runtimeMs) ? run.runtimeMs : undefined,
        topSteps,topMs,topShare:shareOfWall(leading,rows,run,topMs),timedSteps:timed.length,
        stages:run.measurements?.stages || [],actionMs}};
}

async function readRunNetwork(controller,runId) {
    if (!controller || !runId) return null;
    try {
        await controller.init();
        const snapshot=controller.net.snapshot();
        const records=controller.net.collection.recordsWithHistory(snapshot.records)
            .filter(record=>record.caseRunId===runId && !record.replayed && !record.replayOf && !record.testedRuleId);
        return {records,historyTruncated:snapshot.omittedRecords>0};
    } catch {
        return null;
    }
}

function frequencies(records,field) {
    const counts=new Map();
    for (const record of records) {
        const value=record[field];
        if (value!==undefined) counts.set(value,(counts.get(value) || 0)+1);
    }
    return Array.from(counts,([value,count])=>({value,count})).sort((a,b)=>b.count-a.count);
}

function summarizeNetwork(archive,rows) {
    if (!archive?.records.length) return;
    const windows=rows.map(row=>({row,range:timeRange(row.actionTiming || row)})).filter(item=>item.range);
    const records=[...archive.records].sort((a,b)=>Date.parse(a.startedAt)-Date.parse(b.startedAt)).map(raw=>{
        const safe=requestSummary(raw);
        const start=Date.parse(raw.startedAt);
        const end=start+(nonnegative(raw.durationMs) ? raw.durationMs : 0);
        // A timestamp intersection can only locate a request in a step window.
        // If two windows intersect the request, keep the request unassigned.
        const matches=windows.filter(({range})=>start<=range.end && end>=range.start);
        const row=matches.length===1 ? matches[0].row : undefined;
        const rule=raw.ruleId ? [raw.ruleScenarioName,raw.ruleId].filter(Boolean).join(" · ") : undefined;
        return {method:safe.method,path:safe.route || "—",source:safe.source,
            status:Number.isInteger(raw.status) && (raw.status===0 || (raw.status>=100 && raw.status<=599)) ? raw.status : null,
            rule,issue:safe.gatewayIssue,index:row?.index,businessNumber:row?.businessNumber};
    });
    const rules=frequencies(records,"rule");
    return {records,sources:frequencies(records,"source"),statuses:frequencies(records,"status"),rules,
        matched:rules.reduce((sum,rule)=>sum+rule.count,0),historyTruncated:archive.historyTruncated};
}

module.exports={buildRunAggregates,concreteLoops,readRunNetwork,runtimeMeasurements,summarizeNetwork};
