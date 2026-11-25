"use strict";
const {validateScenario}=require("./network");
const {pendingCaseWork}=require("./casePresentation");
const {validateRuleSteps}=require("./caseRuleSteps");

const format = "harmony-agent.workflow-scenario";
const draftFormat = "harmony-agent.case-draft";
function readWorkflow(text) {
    const file = JSON.parse(text.replace(/^\uFEFF/,""));
    const result = file?.format===draftFormat && file.version===1 ? {plan:file.workflow,draft:true,
        scenario:file.scenario && validateScenario(file.scenario)} :
        file?.format===format ? {plan:file.workflow,scenario:validateScenario(file.scenario)} : {plan:file};
    validateRuleSteps(result.plan);
    return result;
}
function workflowWithScenario(workflow,scenario) {
    return {format,version:1,workflow,scenario};
}
function workflowForSave(workflow,scenario) {
    if (pendingCaseWork(workflow).length) return {format:draftFormat,version:1,workflow,...(scenario && {scenario})};
    return scenario ? workflowWithScenario(workflow,scenario) : workflow;
}

function requireExecutableWorkflow({plan,draft},language) {
    if (draft || pendingCaseWork(plan).length) throw new Error(/^zh/i.test(language) ?
        "此用例还有待处理的草稿改动。请先完成生成和修改。" :
        "This case has changes awaiting generation or revision. Resolve them before continuing.");
}

module.exports={readWorkflow,workflowWithScenario,workflowForSave,requireExecutableWorkflow};
