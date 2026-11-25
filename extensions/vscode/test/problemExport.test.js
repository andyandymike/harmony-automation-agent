"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createProblemClip, renderProblemClip, parseClip } = require("../src/problemExport");

test("a portable clip uses the recorded plan, deduplicates native frames and includes only the chosen interval", async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"harmony-clip-"));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    const stored=path.join(dir,"runs","run1");
    await fs.mkdir(stored,{recursive:true});
    const plan={version:"1",steps:[{command:"back"}]};
    await fs.writeFile(path.join(stored,"plan.json"),JSON.stringify(plan));
    const reads=[], network=[];
    const bench={language:"en",stateDir:dir,state:{run:{entry:{id:"run1",plan:{name:"</script>"}},
        steps:[{path:"steps[0]",status:"completed"},{path:"steps[1]",kind:"assert",status:"failed",before:"f",after:"f",expected:"ok",actual:"no"}]}},
        agent:{call:async(c,a)=>{assert.equal(c,"inspect");reads.push(a);return {nodes:[{text:"<img src=x onerror=alert(1)>"}],quality:{complete:true}};}},
        networks:{scenarioForRun:async runId=>{assert.equal(runId,"run1");return {name:"retry",rules:[{request:{json:{email:"hidden@private"}}}]};},
        evidenceForStep:async(...args)=>{network.push(args);return {records:[{url:"https://test.example/x?token=private",
            headers:[{name:"Cookie",value:"private"}],data:{Authorization:"private"}}]};}}};
    const clip=await createProblemClip(bench,{id:"run1",source:"run",from:1,to:1,includePlan:true,includeNetwork:true});
    assert.deepEqual(clip.plan,plan);
    assert.equal(clip.steps[0].number,2);
    assert.equal(reads.length,1);
    assert.deepEqual(network,[["run1","steps[1]",bench.state.run.steps[1]]]);
    assert.equal(clip.mockScenario.rules[0].request.json.email,"[redacted]");
    const noNetwork=await createProblemClip(bench,{id:"run1",source:"run",from:1,to:1,includePlan:true});
    assert.equal(noNetwork.mockScenario,undefined);
    assert.ok(!JSON.stringify(clip).includes("private"));
    const html=renderProblemClip(clip,"zh-CN");
    assert.match(html,/--disclosure-angle:45deg/);
    assert.ok(!html.includes("<img src=x"));
    assert.match(html,/操作后/);
    assert.deepEqual(JSON.parse(JSON.stringify(parseClip(html))),JSON.parse(JSON.stringify(clip)));
    assert.equal(parseClip("<script>alert(1)</script>"),undefined);
    await assert.rejects(createProblemClip(bench,{id:"other",source:"run",from:0,to:0}));
});

test("a missing recorded frame remains distinguishable from an empty tree; gestures export offline",async()=>{
    const entry={id:"r",plan:{name:"sample"}};
    const bench={state:{run:{entry,steps:[{path:"steps[0]",before:"missing"}]}},agent:{call:async()=>{
        throw Object.assign(new Error("not found"),{code:"FRAME_NOT_FOUND"});}}};
    const missing=await createProblemClip(bench,{source:"run",id:"r",from:0,to:0});
    assert.equal(missing.frameErrors["r/missing"],"FRAME_NOT_FOUND");
    entry.source="device";
    bench.state.run.steps=[{command:"click",gesture:{kind:"click",x:1,y:4},dispatched:"acknowledged",status:"completed"}];
    const gesture=await createProblemClip(bench,{source:"run",id:"r",from:0,to:0,includePlan:true});
    assert.equal(gesture.gestures[0].gesture.x,1);
    assert.equal(gesture.plan,undefined);
    bench.state.run.steps=[{command:"typeText",gesture:{kind:"typeText",text:"private input"},status:"completed"}];
    const typed=await createProblemClip(bench,{source:"run",id:"r",from:0,to:0,includePlan:true});
    assert.equal(typed.gestures[0].gesture.kind,"typeText");
    assert.doesNotMatch(JSON.stringify(typed),/private input/);
});
