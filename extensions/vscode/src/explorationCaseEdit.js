"use strict";

const {isDeepStrictEqual} = require("node:util");
const {compileCase, checkpointAfterRow, stageInsertion} = require("./caseComposition");
const {createBdd} = require("./caseBdd");
const {branchDifference} = require("./explorationCases");
const {scopePlan} = require("./explorationEngine");

function stageBranchDifference(report, branchId, candidate, language) {
    const w = (en,zh)=>/^zh/i.test(language) ? zh : en;
    const branch = report.branches?.find(item=>item.id===branchId);
    const edit = branchDifference(report,branch);
    const compiled = compileCase(candidate.plan);
    if (!edit || candidate.compositionStale || !isDeepStrictEqual(compiled.plan,report.plan))
        throw new Error(w("The source case has changed. Explore its current version to apply a change.",
            "来源用例已变化。请基于当前版本重新探索后再采用更改。"));

    const target = edit.remove ? edit.index : edit.index-1;
    const index = candidate.plan.steps.findIndex((step,i)=>
        (!edit.remove || step.command==="back") && checkpointAfterRow(compiled,`steps[${i}]`)===target);
    const cannotMap = w("This change is inside a composed step. Save this route as a separate case.",
        "这处变化无法单独映射到原用例的步骤，可以将这条走法另存为用例。");
    if (index===-1) throw new Error(cannotMap);
    const anchor = {path:`steps[${index}]`,side:"after"};
    const steps = report.bundle ? scopePlan({steps:edit.steps},report.bundle,w).steps : structuredClone(edit.steps);
    const staged = stageInsertion(candidate,anchor,steps,{replace:edit.remove ? anchor.path : undefined},w);
    const expected = [...report.plan.steps];
    expected.splice(edit.index,edit.remove,...steps);
    if (!isDeepStrictEqual(staged.compiled.plan,{...report.plan,steps:expected})) throw new Error(cannotMap);

    const row = createBdd(candidate.plan,language,undefined,candidate.presentation).steps.find(item=>item.path===anchor.path);
    const label = row?.name || row?.text || anchor.path;
    const detail = edit.remove ? w(`Replace step ${index+1} “${label}” with`,`将第 ${index+1} 步「${label}」替换为`) :
        w(`After step ${index+1} “${label}”, insert`,`在第 ${index+1} 步「${label}」后插入`);
    const added = createBdd({steps},language).steps.map((item,i)=>`${i+1}. ${item.text}`);
    return {anchor,staged,detail:[detail,...added].join("\n")};
}

module.exports = {stageBranchDifference};
