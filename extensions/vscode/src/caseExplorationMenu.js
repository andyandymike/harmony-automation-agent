"use strict";

const {deviceRecordingFormat} = require("./model");
const {stepEntries,pendingCaseWork} = require("./casePresentation");
const {prepareCaseFlow,timelineRows} = require("./caseExplorationTimeline");

// Both a row and its neighbouring insertion point use the same before/after boundary.
// Guided exploration can only hand over at a checkpoint the full-case replay engine knows.
function caseExplorationCheckpoints(file, authored, language, {bdd,review=false,editable=true,trustedCase=true}={}) {
    const w = (en,zh)=>/^zh/i.test(language) ? zh : en;
    const plan = authored.plan, coordinate = plan.format===deviceRecordingFormat;
    const pending = pendingCaseWork(plan);
    let flow, sourceReason;
    if (coordinate) sourceReason=w("Choose a case with control-based steps.","请选择包含控件步骤的用例。");
    else if (review==="clean") sourceReason=w("Return to the case to explore other paths.","返回用例后可探索其他走法。");
    else if (review) sourceReason=w("Save the case and return to Tests to explore other paths.","请先保存用例，回到测试页后再探索其他走法。");
    else if (file.draft || pending.length) sourceReason=w("Finish the pending steps or edits and save the case first.","请先完成待生成步骤或修改意见，并保存用例。");
    else {
        try { flow=prepareCaseFlow(file.plan,language,authored,{trustedCase}); }
        catch (error) { sourceReason=error.message; }
    }
    const points = new Map(flow?.checkpoints.map(point=>[point.index,point]));
    const ends = new Map(timelineRows(file.plan,authored).map(row=>[row.path,row.index]));
    const checkpoints = flow && Object.fromEntries([...ends].filter(([,end])=>points.has(end) && !points.get(end).blockedReason));
    if (!bdd) return checkpoints;
    const dynamic = w("Choose a position before or after the whole condition or loop.","请选择整个条件或循环步骤之前或之后的位置。");
    const group = w("Choose a position before or after the whole generated step.","请选择整个描述步骤之前或之后的位置。");
    const unfinished = w("Finish the pending steps or edits before this position.","请先完成这个位置之前的待生成步骤或修改意见。");
    const stopped = w("The earlier script can stop here. Choose a position before that step.","前置脚本可能提前结束，请选择该步骤之前的位置。");
    const scriptIssues = new Map(pending.map(item=>[item.path,unfinished]));
    for (const {step,path} of stepEntries(plan.steps)) {
        if (Object.hasOwn(step,"stop") || Object.hasOwn(step,"yield")) scriptIssues.set(path,stopped);
    }
    let prefixReason;
    const followUpSource = coordinate ? sourceReason : !editable ?
        w("Open an editable case to add follow-up steps.","请打开可编辑用例以补充后续步骤。") : undefined;
    function boundary(checkpoint,context,insideBranch) {
        const followUpReason = followUpSource || (insideBranch && dynamic) || prefixReason;
        const pathsReason = context || sourceReason || points.get(checkpoint)?.blockedReason;
        return {...(insideBranch && {copyReason:dynamic}),...(followUpReason && {followUpReason}),...(pathsReason ? {pathsReason} :
            points.has(checkpoint) ? {checkpoint} : {pathsReason:group})};
    }
    function stepRow(row,before,after,insideBranch=false) {
        const scoped=insideBranch ? dynamic : group;
        row.exploration={before:boundary(before,before===undefined ? scoped : undefined,insideBranch)};
        prefixReason ||= scriptIssues.get(row.path);
        for (const branch of row.branches || []) {
            if (branch.readOnly) continue;
            const linear=Boolean(row.description);
            branch.steps.forEach((child,i)=>stepRow(child,
                linear && i===0 ? before : undefined,linear && i===branch.steps.length-1 ? after : undefined,
                insideBranch || !linear));
        }
        row.exploration.after=boundary(after,after===undefined ? scoped : undefined,insideBranch);
    }
    let before=-1;
    for (const row of bdd.steps) {
        if (!ends.has(row.path)) continue;
        const after=ends.get(row.path);
        if (row.area==="step") {
            stepRow(row,before,after);
        } else row.exploration={before:boundary(before),after:boundary(after)};
        before=after;
    }
    return checkpoints;
}

module.exports={caseExplorationCheckpoints};
