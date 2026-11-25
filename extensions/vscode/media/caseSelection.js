import {ListSelection} from "./ui/listSelection.js";

const caseSteps = new ListSelection("case-steps");

function stepPaths(rows = []) {
    return rows.flatMap(row=>[
        ...(row.path ? [row.path] : []),
        ...(row.branches || []).flatMap(branch=>branch.readOnly ? [] : stepPaths(branch.steps)),
    ]);
}

export function stepSelectionFor(model, available) {
    const review = model.caseReview;
    const key = review ? ["draft",review.id,review.revision] : ["saved",model.plan?.uri,model.planDigest];
    const paths = available ? stepPaths((review?.bdd || model.caseBdd)?.steps) : [];
    caseSteps.update(JSON.stringify(key),paths,model.busy);
    if (paths.length) return caseSteps;
}

function canSave(roots) {
    const step = roots.find(path=>path.startsWith("steps["));
    const list = step?.replace(/\[\d+\]$/,"") || "steps";
    return Boolean(roots.length && roots.every(path=>path.replace(/\[\d+\]$/,"")===list ||
        list==="steps" && /^(preconditions|goals)\[\d+\]$/.test(path)));
}

export function stepSelectionControls(selection,w,model,onPreview) {
    if (!selection) return "";
    const paths=selection.values;
    const n=paths.length;
    const roots=paths.filter(path=>!paths.some(parent=>path.startsWith(parent+".")));
    const save=canSave(roots);
    const fork=roots.every(path=>/^(preconditions|steps|goals)\[\d+\]$/.test(path));
    const context={id:model.caseReview?.id,revision:model.caseReview?.revision,uri:model.plan?.uri,digest:model.planDigest};
    const help=[];
    if (n && !save) help.push(w("Choose steps from one sequence to save a section.","保存片段时，请勾选同一组流程中的步骤。"));
    if (!fork) help.push(w("To copy nested steps to a new case, select their top-level group.","要将内部步骤复制到新用例，请勾选它们所属的顶层分组。"));
    return selection.tools(w,[
        {id:"save",label:w("Save section","保存片段"),disabled:!save,primary:true,
            message:paths=>({type:"caseCompose",action:"section",paths,...context})},
        {id:"fork",label:w("New case from selected steps","用所选步骤新建用例"),disabled:!fork,
            message:paths=>({type:"caseCompose",action:"forkCase",paths,...context})},
        {id:"remove",label:w("Delete selected","删除所选"),
            message:paths=>({type:"caseStepAction",action:"removeSelected",paths,...context})},
    ],{
        className:"case-selection-tools",label:w("Selected step actions","所选步骤操作"),
        count:w(n===1 ? "1 step selected" : n+" steps selected","已选 "+n+" 步"),
        help:help.join(" "),onPreview,
    });
}
