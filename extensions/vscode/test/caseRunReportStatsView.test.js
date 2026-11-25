"use strict";

const {test}=require("node:test");
const assert=require("node:assert/strict");
const {buildRunReportData}=require("../src/caseRunOutline");
const {buildRunAggregates,summarizeNetwork}=require("../src/caseRunAggregates");
const {renderReport}=require("../src/caseRunReportView");

function report(language,trial=false) {
    const start="2026-01-01T00:00:00Z";
    const end="2026-01-01T00:00:01Z";
    const run={entry:{status:trial?"completed":"failed",...(trial && {repairTarget:"steps[0]"})},
        bdd:{steps:[{area:"step",path:"steps[0]",text:"Pay <order>"},
            {area:"step",path:"steps[1]",text:"Read stock"},{area:"goal",path:"goals[0]",text:"Stock restored"}]},
        startedAt:start,runtimeMs:2000,measurements:{captures:3,actions:1,stages:[{name:"capture",elapsedMs:700}]},
        steps:[{kind:"command",path:"steps[0]",command:"press",status:trial?"completed":"failed",startedAt:start,at:end,elapsedMs:1000,
            actionRecorded:true,nativeActionMs:250,assertionStatus:trial?"passed":"failed",assertionAttempts:3}]};
    const {rows,outline}=buildRunReportData(run,language);
    run.outline=outline;
    run.aggregates=buildRunAggregates(run,rows,outline);
    run.aggregates.network=summarizeNetwork({records:[{method:"GET",source:"fixture",path:"/pay?token=private",
        status:503,ruleId:"<unsafe>",startedAt:"2026-01-01T00:00:00.500Z"},
        {method:"GET",source:"gateway",path:"/pay",status:0,startedAt:"2026-01-01T00:00:10Z"}],
        historyTruncated:true},rows);
    return renderReport(run,rows,0,[],language);
}

test("aggregate summaries include observed totals and keep step and request drilldowns scoped",()=>{
    const html=report("zh");
    assert.match(html,/范围内步骤 1\/2 已执行/);
    assert.match(html,/最终断言 0\/1 已执行/);
    assert.match(html,/1 项断言判定 3 次/);
    assert.match(html,/设备状态采集 700 毫秒/);
    assert.match(html,/data-net-by="source" data-net-value="fixture"/);
    assert.match(html,/data-net-by="status" data-net-value="0"[^>]*>无 HTTP 响应/);
    assert.match(html,/data-net-rule="&lt;unsafe&gt;"/);
    assert.match(html,/data-jump-group="0"/);
    assert.match(html,/保留上限/);
    assert.doesNotMatch(html,/token=private|<unsafe>|<order>/);
    const [unassigned]=html.split('data-net-source="gateway"').slice(1);
    assert.doesNotMatch(unassigned.split("</li>")[0],/data-jump-record=/);
});

test("trial statistics label the final goal outside scope and preserve evidence links",()=>{
    const html=report("en",true);
    assert.match(html,/1\/1 in-scope steps executed/);
    assert.match(html,/1 final check outside scope/);
    assert.match(html,/data-jump-record="0"/);
    assert.match(html,/1 check read 3 times/);
    assert.doesNotMatch(html,/Final checks 0\/0 executed/);
});
