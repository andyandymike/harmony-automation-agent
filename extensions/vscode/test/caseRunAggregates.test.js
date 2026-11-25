"use strict";

const { test }=require("node:test");
const assert=require("node:assert/strict");
const { buildRunAggregates,concreteLoops,readRunNetwork,runtimeMeasurements,summarizeNetwork }=require("../src/caseRunAggregates");
const stamp=ms=>new Date(Date.UTC(2026,0,1)+ms).toISOString();

test("only retained original exchanges explicitly assigned to the run enter its network breakdown",async()=>{
    const base={caseRunId:"a",startedAt:stamp(100),durationMs:10,status:503,source:"fixture",method:"GET",
        path:"/api/secret-identifier/payment?token=secret-query",request:{url:"https://not-exposed.test/pay",headers:{secret:"value"}},
        response:{body:{token:"not-visible"}},ruleId:"pay",ruleScenarioName:"Payment"};
    const captured=[{...base,caseRunId:undefined},{...base,caseRunId:"b"},{...base,replayed:true},
        {...base,replayOf:"saved"},{...base,testedRuleId:"pay"},base,
        {...base,startedAt:stamp(500),source:"gateway",status:502,ruleId:undefined,error:"UPSTREAM_FAILED"}];
    const controller={async init(){},net:{snapshot:()=>({records:captured,omittedRecords:42}),
        collection:{recordsWithHistory:rows=>[...rows,{...base,startedAt:stamp(990),status:200}]}}};
    const archive=await readRunNetwork(controller,"a");
    const rows=[{index:0,businessNumber:1,startedAt:stamp(10),at:stamp(250)},
        {index:1,businessNumber:2,startedAt:stamp(490),at:stamp(710)},
        {index:2,businessNumber:3,startedAt:stamp(495),at:stamp(550)}];
    const summary=summarizeNetwork(archive,rows);
    assert.equal(summary.historyTruncated,true);
    assert.equal(summary.records.length,3);
    assert.deepEqual(summary.records.map(r=>r.index),[0,undefined,undefined]);
    assert.deepEqual(summary.sources,[{value:"fixture",count:2},{value:"gateway",count:1}]);
    assert.deepEqual(summary.statuses.map(r=>r.value),[503,502,200]);
    assert.deepEqual(summary.rules,[{value:"Payment · pay",count:2}]);
    assert.equal(summary.records[1].issue,"UPSTREAM_FAILED");
    assert.equal(summary.matched,2);
    assert.doesNotMatch(JSON.stringify(summary),/secret-identifier|secret-query|not-exposed|not-visible/);
    assert.equal(summarizeNetwork(await readRunNetwork(controller,"missing"),rows),undefined);
    assert.equal(await readRunNetwork({async init(){throw Error("unavailable")}},"a"),null);
});

test("a gesture's pre-action pacing does not attribute an earlier request to the gesture",()=>{
    const row={index:0,businessNumber:1,startedAt:stamp(0),at:stamp(1000),elapsedMs:1000,
        actionTiming:{at:stamp(1000),elapsedMs:80}};
    const make=ms=>({startedAt:stamp(ms),status:200,method:"GET",source:"fixture",path:"/orders"});
    const stats=summarizeNetwork({records:[make(400),make(950)],historyTruncated:false},[row]);
    assert.deepEqual(stats.records.map(r=>r.index),[undefined,0]);
});

test("each concrete loop invocation contributes its observed iterations, without treating its exit checks as assertions",()=>{
    const outer="steps[3]",inner=outer+".repeat.iteration[0][1]";
    const rows=[
        {path:outer+".repeat.check[0]",condition:"failed",kind:"repeat"},
        {path:inner+".repeat.check[0]",condition:"failed",kind:"repeat"},
        {path:inner+".repeat.iteration[0][0]",command:"press",actionRecorded:true,nativeActionMs:40,kind:"command"},
        {path:inner+".repeat.check[1]",condition:"passed",kind:"repeat"},
        {path:outer+".repeat.check[1]",condition:"passed",kind:"repeat"},
        {path:"steps[4]",assertionStatus:"failed",assertionAttempts:3},
    ].map((row,index)=>({...row,index,title:"S"+index}));
    const indices=[0,1,2,3,4];
    const loops=concreteLoops(indices,rows);
    const outline={groups:[{area:"step",number:4,title:"Retry",indices,loops}]};
    const measurements=runtimeMeasurements({result:{counters:{actions:1,captures:3},profile:{stagesMs:{capture:120,preflight:-1}}}});
    const {execution,timing}=buildRunAggregates({entry:{source:"workbench"},measurements},rows,outline);
    assert.deepEqual(execution.loops.map(l=>[l.index,l.iterations,l.conditionMet]),[[0,1,true],[1,1,true]]);
    assert.deepEqual(execution.rechecked,[{index:5,title:"S5",attempts:3,status:"failed"}]);
    assert.deepEqual(execution.actionKinds,[{command:"press",count:1,indices:[2]}]);
    assert.equal(execution.receipts,6);
    assert.equal(execution.captures,3);
    assert.equal(timing.actionMs,40);
    assert.deepEqual(timing.stages,[{name:"capture",elapsedMs:120}]);
});

test("longest steps use measured business groups; overlapping, partial or legacy windows never produce an unsupported wall-clock share",()=>{
    const group=(number,index,ms,coverage="complete")=>({area:"step",number,title:"Step "+number,indices:[index],elapsedMs:ms,timingCoverage:coverage});
    const run={entry:{source:"workbench"},startedAt:stamp(0),runtimeMs:1000};
    const rows=[[0,100],[200,400],[500,750],[750,790]].map(([start,end],index)=>({index,startedAt:stamp(start),at:stamp(end)}));
    const outline={groups:[group(1,0,100),group(2,1,200),group(3,2,250),group(4,3,40),group(5,1,500,"partial")]};
    const get=()=>buildRunAggregates(run,rows,outline);
    assert.deepEqual(get().timing.topSteps.map(g=>g.number),[3,2,1]);
    assert.equal(get().timing.topShare,.55);
    assert.equal(get().timing.timedSteps,4);
    rows[1].startedAt=stamp(50);
    assert.equal(get().timing.topShare,undefined);
    delete rows[1].startedAt;
    assert.equal(get().timing.topShare,undefined);
    assert.equal(get().execution.actions,undefined);
    assert.equal(get().execution.captures,undefined);
});
