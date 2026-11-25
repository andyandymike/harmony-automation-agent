"use strict";

const { createBdd } = require("./caseBdd");
const { summarizeRunChecks } = require("./caseRunCheckSummary");
const { concreteLoops } = require("./caseRunAggregates");
const { buildMetrics, receiptTiming } = require("./caseRunMetrics");

const blocking = new Set(["failed","unknown","cancelled","blocked","budget_exhausted","error"]);
const completed = new Set(["completed","passed"]);
const includeArea = {steps:"step",goals:"goal",preconditions:"start"};

// The runner emits a receipt for each repeat check and iteration. All such
// paths need to resolve through the exact BDD layout frozen for this run.
function planPath(path) {
    return typeof path==="string" ? path.replace(/\.repeat\.iteration\[\d+\]/g,".repeat.steps")
        .replace(/\.repeat\.check\[\d+\]$/,"") : "";
}

function executionStep(plan, path) {
    if (!/^steps\[\d+\](?:\.(?:then|else|repeat\.steps)\[\d+\])*$/.test(path)) return;
    return path.match(/[a-z]+|\d+/g).reduce((value,key)=>value?.[key],plan);
}

function targetName(selector) {
    return typeof selector==="string" ? selector : selector?.text || selector?.textPrefix ||
        selector?.id || selector?.description || selector?.hint;
}

function rootPosition(path) {
    const match = /^(steps|goals|preconditions)\[(\d+)\](?:\.|$)/.exec(path || "");
    return match && {area:includeArea[match[1]],index:Number(match[2])};
}

function compiledLayout(roots) {
    const groups = [];
    const byPath = new Map();
    function visit(def, group, depth) {
        const path = def.receiptPath || def.path;
        // References and implemented descriptions expand into their children.
        // Their authored path can coincide with a different real receipt.
        if (path && !def.reference && !def.description?.implemented) byPath.set(path,{group,def,depth});
        for (const branch of def.branches || []) {
            for (const child of branch.steps || []) visit(child,group,depth+1);
        }
    }
    for (const def of roots) {
        const position = rootPosition(def.path);
        const area = def.area || position?.area;
        if (!["start","step","goal"].includes(area)) continue;
        const group = {area, path:def.path, title:def.name || def.text || def.path, role:def.role,
            reference:Boolean(def.reference), indices:[], status:"unknown"};
        if (area==="step" && position) group.number = position.index+1;
        groups.push(group);
        visit(def,group,0);
    }
    function lookup(path) {
        for (let current=planPath(path);current;) {
            if (byPath.has(current)) return byPath.get(current);
            const separator = current.lastIndexOf(".");
            if (separator<0) break;
            current = current.slice(0,separator);
        }
    }
    return {groups,lookup};
}

function summarizeGroup(group, rows) {
    const receipts = group.indices.map(index=>rows[index]);
    const failure = receipts.find(row=>row.isBlocking);
    if (failure) return failure.status;
    if (receipts.every(row=>row.status==="passed")) return "passed";
    if (receipts.every(row=>completed.has(row.status) || row.condition)) return "completed";
    return receipts.find(row=>!completed.has(row.status) && !row.condition)?.status || "unknown";
}

function buildRunReportData(run, language) {
    const zh = /^zh/i.test(language);
    const bdd = run.bdd || createBdd(run.plan,language);
    const {groups,lookup} = compiledLayout(bdd?.steps || []);
    const start = Date.parse(run.startedAt || run.entry.time);
    const target = run.entry.repairTarget;
    const rows = (run.steps || []).map((step,index)=>{
        const path = planPath(step.path);
        // A precondition-only trial ends with an injected stop at steps[0].
        // Its receipt must not claim that the first original business step ran.
        const trialStop = target?.startsWith("preconditions[") && step.kind==="stop" && path==="steps[0]";
        const owner = trialStop ? undefined : lookup(path);
        const timing = receiptTiming(step);
        const at = timing.range?.start;
        const elapsed = Number.isFinite(at) && Number.isFinite(start) && at>=start ? at-start : undefined;
        const iteration = [...(step.path || "").matchAll(/\.repeat\.iteration\[(\d+)\]/g)].at(-1);
        const pathDepth = (step.path?.match(/\.(?:then|else|repeat\.(?:iteration|check))\[/g) || []).length;
        const title = owner?.def.name || owner?.def.text || step.label || (trialStop && (zh ? "结束定点试跑" : "End targeted trial")) ||
            (zh ? "执行记录" : step.command || step.kind || "Record")+" "+(index+1);
        let group = owner?.group;
        if (!group) {
            const goal = /^goals\[\d+\]$/.test(step.path) || step.kind==="goal";
            group = {area:goal ? "goal" : "record",path:step.path,title,indices:[],status:"unknown"};
            groups.push(group);
        }
        group.indices.push(index);
        const definition = executionStep(run.plan,path);
        return {...step,index,title,elapsed,elapsedMs:timing.elapsedMs,depth:Math.min(3,Math.max(pathDepth,owner?.depth || 0)),
            ...(group.number && {businessNumber:group.number}),...(iteration && {iteration:Number(iteration[1])+1}),
            actionTarget:targetName(definition?.input?.target) || step.authoredTarget ||
                (!step.assertionStatus && targetName(step.selector)),isBlocking:!step.condition && blocking.has(step.status)};
    });

    const targetIndex = target ? rows.find(row=>row.path===target)?.index : undefined;
    const targetGroup = target && (lookup(target)?.group || groups.find(group=>group.indices.includes(targetIndex)));
    const firstBlocking = rows.find(row=>row.isBlocking);
    if (firstBlocking) firstBlocking.firstBlocking = true;
    const blockingGroup = firstBlocking && groups.find(group=>group.indices.includes(firstBlocking.index));
    const targetPosition = targetGroup ? groups.indexOf(targetGroup) : -1;
    const blockingPosition = blockingGroup ? groups.indexOf(blockingGroup) : -1;

    // Some older archives have the final assertion payload but no per-goal receipts.
    const describedGoals = new Set(groups.filter(group=>group.area==="goal").map(group=>group.path));
    const finalCount = Math.max(run.plan?.goals?.length || 0,run.finalAssertions?.length || 0);
    for (let i=0;i<finalCount;i++) {
        const path = `goals[${i}]`;
        if (!describedGoals.has(path)) groups.push({area:"goal",path,title:(zh ? "最终断言 " : "Final check ")+(i+1),indices:[]});
    }

    const goals = groups.filter(group=>group.area==="goal");
    for (const [index,group] of groups.entries()) {
        const goalIndex = group.area==="goal" && rootPosition(group.path)?.index;
        const assertion = Number.isInteger(goalIndex) && run.finalAssertions?.[goalIndex];
        const goal = Number.isInteger(goalIndex) && run.plan?.goals?.[goalIndex];
        if (group.indices.length) group.status = summarizeGroup(group,rows);
        else if (assertion?.status) group.status = assertion.status;
        else if (target && ((targetPosition>=0 && index>targetPosition) ||
                (group.area==="goal" && !target.startsWith("goals[")))) group.status = "out_of_scope";
        else if ((blockingPosition>=0 && index>blockingPosition) ||
                (group.area==="goal" && run.goalStatus==="not_run")) group.status = "not_run";
        else group.status = "unknown";
        if (group.area==="step") {
            const loops=concreteLoops(group.indices,rows);
            if (loops.length) group.loops=loops;
            if (loops.length===1 && loops[0].iterations!==undefined)
                group.repeatSummary={iterations:loops[0].iterations,conditionMet:loops[0].conditionMet};
        }
        if (group.area==="goal") {
            const observed = rows[group.indices[0]] || assertion;
            const expected = observed?.expected ?? goal?.equals;
            // createBdd masks sensitive text selectors. Do not put the raw
            // literal back into the always-visible summary for these rows.
            const literal = expected!=null && ["string","boolean","number"].includes(typeof expected) && !group.title?.includes("••••");
            if (literal) group.expected = expected;
            group.caption = literal && typeof expected==="string" && (!goal?.property || goal.property==="text") ?
                expected : group.title;
        }
    }
    const focusIndex = firstBlocking?.index ?? targetIndex ??
        (run.entry.status==="passed" ? goals.find(group=>group.indices.length)?.indices[0] : undefined) ?? rows[0]?.index;
    const metrics = buildMetrics(groups,rows);
    const outline = {groups,goals,scope:target ? "target" : "full",targetIndex,targetGroup,blockingGroup,focusIndex,metrics};
    metrics.checks = summarizeRunChecks(rows,outline,run);
    return {rows,outline};
}

module.exports = { buildRunReportData };
