"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const {buildTestRunOverview} = require("../src/testRunOverview");

function run(day,status,extra={}) {
    return {id:"r"+day,plan:{name:"Checkout",uri:"file:///checkout.json"},caseId:"checkout",
        device:"phone",sourceDigest:"definition",time:new Date(Date.UTC(2026,0,day)).toISOString(),status,...extra};
}

test("independent outcomes and supported pass-rate denominator exclude three different trial scopes",()=>{
    const entries=[run(1,"failed"),run(2,"completed",{repairOf:"r1",repairTarget:"steps[2]",repairApplied:true}),
        run(3,"passed",{repairOf:"r1"}),run(4,"passed",{compositionTrial:true}),run(5,"passed"),
        run(6,"completed"),run(7,"skipped"),run(8,"rejected"),run(9,"cancelled"),
        run(10,"running"),run(11,"unknown"),run(5,"passed")];
    const overview=buildTestRunOverview(entries);
    assert.equal(overview.total,11);
    assert.equal(overview.caseCount,1);
    assert.equal(overview.independentIds.length,8);
    assert.deepEqual(overview.outcomes,{passed:["r5"],failed:["r1"],completed:["r6"],skipped:["r7"],
        blocked:["r8"],cancelled:["r9"],running:["r10"],unknown:["r11"]});
    assert.deepEqual(overview.passRate,{passed:1,decided:2});
    assert.deepEqual(overview.trials,{targeted:["r2"],fullRepair:["r3"],composition:["r4"]});
    assert.deepEqual(overview.repairs,[{originalId:"r1",trialIds:["r3","r2"],fullPassedIds:["r3"],targetedPassedIds:["r2"]}]);
    const unverified=buildTestRunOverview([run(1,"failed"),run(2,"completed",{repairOf:"r1",repairTarget:"steps[2]"})]);
    assert.deepEqual(unverified.repairs[0].targetedPassedIds,[]);
    assert.deepEqual(buildTestRunOverview([run(2,"completed",{repairOf:"r1",repairTarget:"steps[2]"})],
        {r2:{targetVerified:true}}).repairs[0].targetedPassedIds,["r2"]);
    assert.deepEqual(buildTestRunOverview([run(2,"failed",{repairOf:"r1",repairTarget:"steps[2].repeat.iteration[1][0]",repairApplied:true})])
        .repairs[0].targetedPassedIds,["r2"]);
});

test("groups evidence-backed failures by code and devices by independently adjudicated outcomes",()=>{
    const entries=[run(1,"failed"),run(2,"failed",{caseId:"inventory",device:undefined,source:"pytest",
        plan:{uri:"file:///inventory.json",name:"Inventory"}}),run(3,"passed"),
        run(4,"failed",{device:"tablet"}),run(5,"failed",{repairOf:"r1",failureCode:"WRONG_SCOPE"})];
    const facts={r1:{failureCode:"ASSERTION_TIMEOUT",durationMs:12},r2:{failureCode:"ASSERTION_TIMEOUT",durationMs:45},
        r3:{durationMs:0},r4:{durationMs:-20}};
    const result=buildTestRunOverview(entries,facts);
    assert.deepEqual(result.failures.map(({code,ids,caseCount})=>({code,ids,caseCount})),[
        {code:"ASSERTION_TIMEOUT",ids:["r2","r1"],caseCount:2},{code:null,ids:["r4"],caseCount:1}]);
    assert.deepEqual(result.failures[0].sources,[{name:"pytest",ids:["r2"]},{name:"workbench",ids:["r1"]}]);
    assert.deepEqual(result.devices.find(item=>item.name==="phone"),{name:"phone",ids:["r3","r1"],caseCount:1,passed:1,decided:2});
    assert.deepEqual(result.devices.find(item=>item.name===null).ids,["r2"]);
    assert.deepEqual(result.slowest.map(item=>item.id),["r2","r1","r3"]);
    assert.equal(result.timedCount,3);
    assert.deepEqual(result.cases[0],{name:"Checkout",ids:["r4","r3","r1"],passed:1,decided:3});
});

test("bridges known legacy URIs without merging different case ids that reused the same path",()=>{
    const a=run(1,"failed",{caseId:undefined}),b=run(2,"passed");
    const same=buildTestRunOverview([a,b]);
    assert.equal(same.caseCount,1);
    assert.equal(same.trends[0].kind,"recovered");
    const ambiguous=buildTestRunOverview([a,b,run(3,"failed",{caseId:"replacement"}),
        run(4,"passed",{plan:{name:"Checkout"},caseId:undefined})]);
    assert.equal(ambiguous.caseCount,2);
    assert.deepEqual(ambiguous.cases.find(item=>item.name===null).ids,["r4","r1"]);
    assert.ok(ambiguous.trends.every(item=>item.kind==="insufficient"));
});

test("compares decisions only within a matching captured definition, device, runner and rule setting",()=>{
    const entries=[run(1,"failed"),run(2,"passed"),run(3,"failed"),run(4,"passed",{source:"pytest"}),
        run(5,"passed",{device:"other"}),run(6,"passed",{ruleGroupDisabled:true}),
        run(7,"passed"),run(8,"failed",{sourceDigest:"new labels"}),run(9,"skipped")];
    const facts=new Map(entries.map(entry=>[entry.id,{planDigest:entry.id==="r7"?"different":"same",durationMs:10}]));
    const [trend]=buildTestRunOverview(entries,facts).trends;
    assert.deepEqual(trend.ids,["r8","r3","r2","r1"]);
    assert.equal(trend.kind,"persistent");
    assert.equal(trend.mixed,true);
    assert.equal(trend.previousId,"r3");
    assert.equal(trend.duration,undefined);
    const insufficient=buildTestRunOverview([run(1,"passed",{device:null}),run(2,"failed",{device:null})]);
    assert.equal(insufficient.trends[0].kind,"insufficient");
    assert.equal(buildTestRunOverview([run(1,"passed",{sourceDigest:null}),run(2,"failed",{sourceDigest:null})]).trends[0].kind,"insufficient");
});

test("duration trend compares runs that reach the same endpoint and preserves a real zero",()=>{
    assert.deepEqual(buildTestRunOverview([run(1,"passed"),run(2,"passed")],
        {r1:{durationMs:0},r2:{durationMs:12}}).trends[0].duration,{previousMs:0,currentMs:12,deltaMs:12});
    const failed=[run(1,"failed"),run(2,"failed")];
    const evidence={r1:{failureCode:"TIMEOUT",failurePath:"steps[3]",durationMs:120},
        r2:{failureCode:"TIMEOUT",failurePath:"steps[3]",durationMs:80}};
    assert.equal(buildTestRunOverview(failed,evidence).trends[0].duration.deltaMs,-40);
    evidence.r2.failurePath="steps[1]";
    assert.equal(buildTestRunOverview(failed,evidence).trends[0].duration,undefined);
});

test("recent windows limit actual run records before calculating every breakdown",()=>{
    const entries=[run(3,"passed"),run(1,"failed"),run(4,"completed",{repairOf:"r1",repairTarget:"steps[0]"}),run(2,"failed"),
        run(5,"failed",{time:"unknown",failureCode:"OLDEST"})];
    const result=buildTestRunOverview(entries,{}, {limit:2,since:Date.UTC(2026,0,3)});
    assert.equal(result.total,2);
    assert.deepEqual(result.independentIds,["r3"]);
    assert.deepEqual(result.trials.targeted,["r4"]);
    assert.equal(result.trends[0].kind,"insufficient");
    assert.deepEqual(result.failures,[]);
    assert.deepEqual(buildTestRunOverview(entries,{}, {limit:0}).passRate,{passed:0,decided:0});
});
