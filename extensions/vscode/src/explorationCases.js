"use strict";

const {scopePlan} = require("./explorationEngine");
const {prepareFlow} = require("./explorationFlow");

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

function completedBranch(report,branch) {
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
    // Restore the original path to this checkpoint. Exploration's navigation between
    // branches is not part of the independent case. Preserve verified baseline goals at an endpoint.
    const route = linear ? plan.steps.slice(0,i+1) : [...plan.steps,...(plan.goals || []).map(assert=>({assert}))];
    route.push(varied);
    if (report.steps.some(s=>s.key===branch.id+"/return" && s.status==="completed")) route.push({command:"back"});
    if (linear) route.push(...plan.steps.slice(i+(replaced?2:1)));
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
    const branchIds = (report.branches || []).filter(branch=>
        (branch.id==="baseline" && baseline && report.plan?.steps?.length) || completedBranch(report,branch)).map(b=>b.id);
    const findingIds = report.findings.filter(f=>f.plan?.steps?.length && f.kind==="failure" || f.kind==="review" && stepIds.includes(f.stepId)).map(f=>f.id);
    return {stepIds,branchIds,findingIds, main:stepIds.length>0 || branchIds.includes("baseline")};
}

function explorationCandidate(report, request) {
    const routes = caseRoutes(report);
    if (!routes.stepIds) return;
    let {stepId,branchId,findingId} = request;
    const finding = findingId && report.findings.find(f=>f.id===findingId);
    if (findingId && !routes.findingIds.includes(findingId)) return;
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

module.exports = {caseRoutes,explorationCandidate};
