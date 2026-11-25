"use strict";

const {scopePlan} = require("./explorationEngine");
const {prepareFlow} = require("./explorationFlow");
const {checkpointAfterRow,compileCase} = require("./caseComposition");
const {storePresentation} = require("./casePresentation");
const {isDeepStrictEqual} = require("node:util");
const {timelineRows,timelineSteps,timelinePrefix} = require("./caseExplorationTimeline");

function forkSourceSnapshot(document, checkpoint, layout) {
    if (layout==="rows") {
        const rows=timelineRows(document.execution,document);
        if (checkpoint!==-1 && !rows.some(row=>row.index===checkpoint)) return;
        const prefix={...document.plan,preconditions:[],steps:[],goals:[]};
        const display=new Map(document.presentation);
        for (const {field,step,index} of rows) {
            if (index>checkpoint) break;
            if (field==="goals") {
                const check={assert:step};
                prefix.steps.push(check);
                if (display.has(step)) display.set(check,display.get(step));
            } else prefix[field].push(step);
        }
        const compiled=compileCase(prefix);
        if (compiled.pending?.length || !isDeepStrictEqual(timelineSteps(compiled.plan),timelineSteps(document.execution).slice(0,checkpoint+1))) return;
        return {checkpoint,steps:structuredClone(prefix.steps),preconditions:structuredClone(prefix.preconditions),
            presentation:storePresentation(prefix,display)};
    }
    const row = checkpoint === -1 ? -1 : document.plan.steps.findIndex((_, i)=>
        checkpointAfterRow(document,`steps[${i}]`) === checkpoint);
    if (checkpoint !== -1 && row < 0) return;
    const prefix = {...document.plan,steps:document.plan.steps.slice(0,row+1),goals:[]};
    const compiled = compileCase(prefix);
    if (compiled.pending?.length) return;
    const executed=document.execution.steps.slice(0,checkpoint+1);
    // A reference at the end of a compiled prefix can promote its own exit checks to goals.
    // In the full script those same checks are inline unless the reference also ends the full case.
    const exitChecks=compiled.plan.goals || [];
    const inline=[...compiled.plan.steps,...exitChecks.map(assert=>({assert}))];
    let replayExitChecks;
    if (!isDeepStrictEqual(inline,executed)) {
        if (row!==document.plan.steps.length-1 || !exitChecks.length || document.plan.goals?.length ||
            !isDeepStrictEqual(compiled.plan.steps,executed) || !isDeepStrictEqual(exitChecks,document.execution.goals)) return;
        replayExitChecks=exitChecks;
    }
    return {checkpoint,steps:structuredClone(prefix.steps),presentation:storePresentation(prefix,document.presentation),
        ...(replayExitChecks && {replayExitChecks}),...(row>=0 && !prefix.preconditions?.length &&
            compiled.plan.preconditions?.length && {referenceProvidesStart:true})};
}

function recordedFork(report, branch) {
    if (branch?.kind !== "variant" || !["completed","passed"].includes(branch.status)) return;
    const index = branch.checkpoint;
    const length=report.checkpointLayout==="rows" ? timelineSteps(report.plan).length : report.plan.steps.length;
    if (!Number.isInteger(index) || index < -1 || index >= length) return;
    const prefix = report.branches.find(item=>item.kind === "prefix");
    if (prefix?.status !== "completed" || prefix.checkpoint !== index) return;
    const start = report.steps.find(step=>step.key === "prefix" && step.runId && step.status === "completed");
    const end = report.steps.find(step=>step.key === branch.id+"/act" && step.status === "completed");
    if (!start || start.runId !== prefix.runId || !end?.runId || end.runId !== branch.runId || !end.replayStep ||
        !end.toStateId || !start.toStateId || start.toStateId !== end.fromStateId) return;
    const receipt = end.receipts?.find(row=>row.path === "steps[0]" && row.command === end.replayStep.command);
    if (receipt?.status !== "completed" || receipt.dispatched !== "acknowledged") return;
    return {start,end,index};
}

function acknowledgedFreeStep(report, step) {
    if (step.phase !== "free" || step.status !== "completed" || !step.runId || !step.toStateId || !step.fromStateId) return;
    const receipt = step.receipts?.find(row=>row.path==="steps[0]" && row.status==="completed" && row.dispatched==="acknowledged");
    if (!receipt) return;
    if (step.replayStep && step.replayStep.command === receipt.command) return step.replayStep;
    if (!step.entryId && receipt.command === "back") return {command:"back",input:{}};
    const state = (report.pages || []).flatMap(page=>page.states || []).find(row=>row.id===step.fromStateId);
    const entry = state?.entries.find(row=>row.id===step.entryId);
    if (entry?.command === receipt.command && ["press","scroll"].includes(entry.command) && entry.input?.target)
        return {command:entry.command,input:entry.input};
}

function branchDifference(report,branch) {
    if (report.routeMode==="fork") return;
    if (!branch || !["replace","detour"].includes(branch.choice?.strategy)) return;
    if (!["completed","passed"].includes(branch.status) || !branch.choice?.step || !report.plan?.steps?.length) return;
    const act = report.steps.find(s=>s.key===branch.id+"/act" && s.status==="completed");
    const end = report.steps.find(s=>s.key===branch.id+"/suffix" && s.status==="completed");
    if (!act || !end) return;
    const plan = report.plan, i = branch.checkpoint;
    if (!Number.isInteger(i) || !plan.steps[i]) return;
    const linear = prepareFlow(plan,report.language).kind==="linear";
    const replaced = branch.choice.strategy==="replace";
    const varied = structuredClone(branch.choice.step);
    if (replaced) {
        const next = plan.steps[i+1];
        if (!next || next.command!=="back") return;
        if (next.before) varied.before = next.before;
        if (next.refresh) varied.refresh = true;
        if (next.input?.expect) varied.input = {...varied.input,expect:next.input.expect};
    }
    if (!linear && (i!==plan.steps.length-1 || replaced)) return;
    // On endpoint runs the baseline's final checks establish the starting state of the detour.
    const steps = linear ? [] : (plan.goals || []).map(assert=>({assert}));
    steps.push(varied);
    if (report.steps.some(s=>s.key===branch.id+"/return" && s.status==="completed")) steps.push({command:"back"});
    return {index:i+1,remove:replaced?1:0,steps};
}

function completedBranch(report,branch) {
    const edit = branchDifference(report,branch);
    if (!edit) return;
    const plan = report.plan, route = [...plan.steps];
    route.splice(edit.index,edit.remove,...edit.steps);
    return {...plan,steps:route};
}

function caseRoutes(report) {
    if (!report || ["ready","running"].includes(report.status)) return {};
    const stepIds = [];
    if (report.mode === "free") {
        for (const [index,step] of report.steps.entries()) {
            if ((index && report.steps[index-1].toStateId !== step.fromStateId) || !acknowledgedFreeStep(report,step)) break;
            stepIds.push(step.id);
        }
    }
    const baseline = report.steps.find(step=>step.key==="baseline" && step.runId && ["completed","failed"].includes(step.status));
    const branchIds = (report.branches || []).filter(branch=> report.routeMode==="fork" ? recordedFork(report,branch) :
        (branch.id==="baseline" && baseline && report.plan?.steps?.length) || completedBranch(report,branch)).map(b=>b.id);
    const findingIds = report.routeMode==="fork" ? [] : report.findings.filter(f=>
        f.plan?.steps?.length && f.kind==="failure" || f.kind==="review" && stepIds.includes(f.stepId)).map(f=>f.id);
    const source = report.sourceCase;
    const diffBranchIds = report.routeMode!=="fork" && report.status!=="paused" && report.mode==="flow" && source?.uri && source.digest && source.editable!==false ?
        branchIds.filter(id=>id!=="baseline") : [];
    return {stepIds,branchIds,findingIds,diffBranchIds,main:stepIds.length>0 || branchIds.includes("baseline")};
}

function explorationCandidate(report, request) {
    const routes = caseRoutes(report);
    if (!routes.stepIds) return;
    let {stepId,branchId,findingId} = request;
    const finding = findingId && report.findings.find(f=>f.id===findingId);
    if (findingId && !routes.findingIds.includes(findingId)) return;
    if (report.routeMode==="fork" && branchId) {
        const branch=report.branches.find(item=>item.id===branchId);
        const fork=recordedFork(report,branch);
        if (!fork) return;
        const {start,end,index}=fork;
        const source=report.forkSource?.checkpoint===index ? report.forkSource : undefined;
        const script=report.checkpointLayout==="rows" ? timelinePrefix(report.plan,index) : undefined;
        const prefix=source?.steps || (script ? [...script.steps,...(script.goals || []).map(assert=>({assert}))] : report.plan.steps.slice(0,index+1));
        const name=branch.choice?.label || branch.label;
        const plan=structuredClone({...report.plan,steps:[...prefix,end.replayStep]});
        if (script) {
            const conditions=source?.preconditions ?? script.preconditions;
            if (conditions?.length) plan.preconditions=structuredClone(conditions); else delete plan.preconditions;
        } else if (source?.referenceProvidesStart) delete plan.preconditions;
        delete plan.goals;
        delete plan.goal;
        delete plan.editNote;
        const point=report.checkpointDetails?.find(item=>item.index===index);
        return {name:[report.source,name].filter(Boolean).join(" · "),source:"exploration",plan,
            presentationData:source?.presentation,bundle:report.bundle,
            origin:{reportId:report.id,branchId,stepId:end.id,outcome:"observed",label:report.goal,
                parentCaseId:report.sourceCase?.id,parentCaseDigest:report.sourceCase?.digest,
                parentCaseName:report.source,forkPosition:point?.position ?? index+1},
            frames:{start:start.before && {runId:start.runId,frame:start.before},goal:end.after && {runId:end.runId,frame:end.after}}};
    }
    let plan, first, last, outcome, stepEvidence, name = report.goal;
    if (finding?.kind==="failure") {
        plan = finding.plan;
        first = report.steps.find(s=>s.key==="baseline");
        last = report.steps.find(s=>s.id===finding.stepId);
        stepId = last?.id;
        outcome = "checkFailed";
        name = finding.title;
    } else if (report.mode==="flow") {
        branchId ||= "baseline";
        if (!routes.branchIds.includes(branchId)) return;
        const branch = report.branches.find(b=>b.id===branchId);
        first = report.steps.find(s=>s.key==="baseline");
        last = branchId==="baseline" ? first : report.steps.find(s=>s.key===branchId+"/suffix");
        plan = branchId==="baseline" ? report.plan : completedBranch(report,branch);
        outcome = branch.status==="passed" ? "checksPassed" : branch.status==="failed" ? "checkFailed" : "observed";
        if (branchId!=="baseline") name = branch.label;
    } else {
        stepId = finding?.stepId || stepId || routes.stepIds.at(-1);
        const index = routes.stepIds.indexOf(stepId);
        if (index < 0) return;
        const prefix = report.steps.slice(0,index+1);
        plan = {version:"1",steps:prefix.map(s=>acknowledgedFreeStep(report,s))};
        const pages = new Map((report.pages || []).flatMap(page=>(page.states || []).map(state=>[state.id,page.label || page.route])));
        stepEvidence = Object.fromEntries(prefix.map((step,i)=>[`steps[${i}]`,{control:step.label,
            from:pages.get(step.fromStateId),to:pages.get(step.toStateId)}]));
        first = prefix[0];
        last = prefix.at(-1);
        outcome = finding ? "review" : "observed";
        name = finding?.title || (request.stepId ? last.label : report.goal);
    }
    const scoped = report.bundle ? scopePlan(plan,report.bundle,(en,zh)=>/^zh/i.test(report.language)?zh:en) : structuredClone(plan);
    return {name,source:"exploration",plan:scoped,group:report.mockScenario,bundle:report.bundle,stepEvidence,
        origin:{reportId:report.id,...(findingId&&{findingId}),...(branchId&&{branchId}),...(stepId&&{stepId}),outcome,label:report.goal},
        frames:{start:first?.before && {runId:first.runId,frame:first.before},goal:last?.after && {runId:last.runId,frame:last.after}}};
}

module.exports = {caseRoutes,explorationCandidate,branchDifference,forkSourceSnapshot};
