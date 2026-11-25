"use strict";

const {checkpointAfterRow} = require("./caseComposition");
const {prepareFlow,parseFlow} = require("./explorationFlow");
const {expectation} = require("./caseBdd");

// Checkpoints count executed operations and checks in order. An authored reference
// occupies one visible row even when its opening/closing checks are stored on the enclosing plan.
function timelineRows(plan, document) {
    const authored=document?.plan || plan, rows=[];
    const start=plan.preconditions?.length || 0, tail=start+plan.steps.length;
    function add(field,offset,condition) {
        for (const [i,step] of (authored[field] || []).entries()) {
            const path=field+"["+i+"]";
            let index=offset+i;
            if (field==="steps" && document) {
                const boundary=checkpointAfterRow(document,path);
                if (boundary===undefined) continue;
                index=start+boundary;
                if (i===authored.steps.length-1 && !authored.goals?.length) index+=plan.goals?.length || 0;
            }
            rows.push({path,index,field,step,condition});
        }
    }
    add("preconditions",0,true);
    add("steps",start,false);
    add("goals",tail,true);
    return rows;
}

function timelineSteps(plan) {
    return [...(plan.preconditions || []).map(assert=>({assert})),...plan.steps,...(plan.goals || []).map(assert=>({assert}))];
}

function prepareCaseFlow(value,language,document,options) {
    const plan=parseFlow(value,language);
    if (!Array.isArray(plan?.steps)) return prepareFlow(plan,language);
    const body={...plan,steps:timelineSteps(plan)};
    delete body.preconditions;
    delete body.goals;
    const names={}, positions={};
    const rows=timelineRows(plan,document);
    const w=(en,zh)=>/^zh/i.test(language)?zh:en;
    for (const [i,row] of rows.entries()) {
        positions[row.index]=i+1;
        names[row.index]=document?.presentation?.get(row.step)?.name || row.step.description?.text || row.step.useCase?.name ||
            (row.condition ? expectation(row.step,w) : undefined);
    }
    const flow=prepareFlow(body,language,names,positions,options);
    return {...flow,plan,goalChecks:(plan.goals || []).map(check=>expectation(check,w))};
}

// Send the original assertion fields to the runner. They retain its timing,
// limits and failure semantics, including for version 2 values read by a prior step.
function timelinePrefix(plan, checkpoint) {
    const count=checkpoint+1, start=plan.preconditions || [];
    const prefix={...plan,steps:plan.steps.slice(0,Math.max(0,count-start.length))};
    const initial=start.slice(0,count);
    const final=(plan.goals || []).slice(0,Math.max(0,count-start.length-plan.steps.length));
    if (initial.length) prefix.preconditions=initial; else delete prefix.preconditions;
    if (final.length) prefix.goals=final; else delete prefix.goals;
    return prefix;
}

module.exports={timelineRows,timelineSteps,timelinePrefix,prepareCaseFlow};
