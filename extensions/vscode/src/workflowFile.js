"use strict";
const {validateScenario}=require("./network");

const format = "harmony-agent.workflow-scenario";
function readWorkflow(text) {
    const file = JSON.parse(text.replace(/^\uFEFF/,""));
    return file?.format===format ? {plan:file.workflow,scenario:validateScenario(file.scenario)} : {plan:file};
}
function workflowWithScenario(workflow,scenario) {
    return {format,version:1,workflow,scenario};
}
module.exports={readWorkflow,workflowWithScenario};
