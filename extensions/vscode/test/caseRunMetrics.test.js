"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {buildRunReportData} = require("../src/caseRunOutline");

const stamp = milliseconds => new Date(Date.UTC(2026,0,1)+milliseconds).toISOString();
const leaf = (path,values={}) => ({path,status:"completed",kind:"command",...values});
function report(steps,receipts,extra={}) {
    return buildRunReportData({entry:{id:"case",status:"completed"},bdd:{steps},steps:receipts,...extra},"en");
}

test("step metrics count scoped business outcomes separately from preconditions and final checks",()=>{
    const defs = [
        {area:"start",path:"preconditions[0]",text:"Ready"},
        ...["Prepare","Submit","Validate"].map((text,index)=>({area:"step",path:`steps[${index}]`,text})),
        {area:"goal",path:"goals[0]",text:"Paid"}
    ];
    const records = [leaf("preconditions[0]",{kind:"precondition",elapsedMs:900}),
        leaf("steps[0]",{elapsedMs:0}),leaf("steps[1]",{status:"failed",elapsedMs:150})];
    const failed=report(defs,records,{entry:{status:"failed"}});
    assert.deepEqual(failed.outline.metrics.steps,{total:3,executed:2,completed:1,failed:1,notRun:1,outOfScope:0,skipped:0,interrupted:0,unconfirmed:0});
    assert.equal(failed.outline.metrics.goals.notRun,1);
    assert.equal(failed.outline.metrics.timedSteps,2);
    assert.deepEqual(failed.outline.metrics.slowest,{number:2,title:"Submit",elapsedMs:150,index:2});
    assert.deepEqual(failed.outline.groups.map(group=>[group.elapsedMs,group.timingCoverage]),[
        [900,"complete"],[0,"complete"],[150,"complete"],[undefined,"not_executed"],[undefined,"not_executed"]]);

    const trial=report(defs,records.slice(0,2),{entry:{status:"completed",repairTarget:"steps[0]"}});
    assert.equal(trial.outline.metrics.steps.executed,1);
    assert.equal(trial.outline.metrics.steps.outOfScope,2);
    assert.equal(trial.outline.metrics.goals.outOfScope,1);
    assert.equal(trial.outline.metrics.steps.notRun,0);
});

test("nested timing uses the union of overlapping windows and the recorded duration of disjoint serial operations",()=>{
    const defs=[{area:"step",path:"steps[0]",text:"Group"}];
    const records=[
        leaf("steps[0]",{startedAt:stamp(10),at:stamp(50),elapsedMs:40}),
        leaf("steps[0].then[0]",{startedAt:stamp(15),at:stamp(25),elapsedMs:10}),
        leaf("steps[0].then[1]",{startedAt:stamp(45),at:stamp(55)}),
        leaf("steps[0].then[2]",{startedAt:stamp(180),at:stamp(191),elapsedMs:9}),
        leaf("steps[0].then[3]",{startedAt:stamp(210),elapsedMs:2.5}),
    ];
    const {outline,rows}=report(defs,records);
    assert.equal(rows[2].elapsedMs,10);
    assert.equal(outline.groups[0].elapsedMs,56.5);
    assert.equal(outline.groups[0].timingCoverage,"complete");
    assert.equal(outline.metrics.slowest.index,0);
});

test("older durations, partial timings and absent timing stay distinct from zero and from placeholders",()=>{
    const defs=[0,1,2,3,4].map(index=>({area:"step",path:`steps[${index}]`,text:`Action ${index}`}));
    const records=[
        leaf("steps[0]",{elapsedMs:40.5}),
        leaf("steps[0].then[0]",{elapsedMs:1.5}),
        leaf("steps[1]",{elapsedMs:200}),
        leaf("steps[1].then[0]",{elapsedMs:-1}),
        leaf("steps[2]",{elapsedMs:null,startedAt:stamp(12),at:stamp(10)}),
        leaf("steps[3]",{status:"skipped",elapsedMs:0}),
    ];
    const {outline,rows}=report(defs,records);
    const [complete,partial,missing,skipped,unconfirmed]=outline.groups;
    assert.deepEqual([complete.elapsedMs,complete.timingCoverage],[42,"complete"]);
    assert.deepEqual([partial.elapsedMs,partial.timingCoverage],[200,"partial"]);
    assert.deepEqual([missing.elapsedMs,missing.timingCoverage],[undefined,"missing"]);
    assert.equal(skipped.timingCoverage,"not_executed");
    assert.equal(unconfirmed.timingCoverage,"missing");
    assert.equal(rows[3].elapsedMs,undefined);
    assert.equal(rows[5].elapsedMs,undefined);
    assert.equal(outline.metrics.timedSteps,1);
    assert.equal(outline.metrics.slowest.number,1);
    assert.equal(outline.metrics.steps.executed,3);
    assert.equal(outline.metrics.steps.skipped,1);
    assert.equal(outline.metrics.steps.unconfirmed,1);
});

test("one loop reports executed iterations and the last observed exit check, not the number of receipts",()=>{
    const defs=[{area:"step",path:"steps[0]",text:"Retry"}];
    const root="steps[0].then[0]";
    const check=(base,attempt,condition)=>leaf(`${base}.repeat.check[${attempt}]`,{kind:"repeat",condition});
    const records=[check(root,0,"failed"),leaf(root+".repeat.iteration[0][0]"),
        leaf(root+".repeat.iteration[0][1]"),check(root,1,"failed"),leaf(root+".repeat.iteration[1][0]"),check(root,2,"passed")];
    const summary=items=>report(defs,items).outline.groups[0].repeatSummary;
    assert.deepEqual(summary(records),{iterations:2,conditionMet:true});
    assert.deepEqual(summary([check(root,0,"passed")]),{iterations:0,conditionMet:true});
    assert.deepEqual(summary(records.slice(0,2)),{iterations:1,conditionMet:false});
    assert.equal(summary([check(root,2,"passed")]),undefined);
    assert.equal(summary([...records,check("steps[0].then[1]",0,"passed")]),undefined);
    assert.equal(summary([leaf("steps[0]")]),undefined);
});
