"use strict";
const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const {writeCase, startPytest} = require("../src/pytestCase");
const {loadPytestRun} = require("../src/pytestReport");
const {CaseRepair,sourceDigest} = require("../src/caseRepair");
const {diagnoseCase} = require("../src/caseDiagnosis");
const {reviewCaseFailure} = require("../src/caseFailure");
const {withAuthoredTargets} = require("../src/model");

const python = process.env.HARMONY_TEST_PYTHON || "python";
const installed = spawnSync(python, ["-c", "import pytest"], {windowsHide:true}).status === 0;
const repo = path.resolve(__dirname, "../../..");
const count = n => ({selector:{id:"fixture.counter"}, equals:"Counter: " + n, timeoutMs:150});
const plan = {version:"1", preconditions:[count(0)], steps:[{command:"press", input:{target:{id:"fixture.increment"}}}], goals:[count(1)]};

test("receipt labels recover nested loop/branch targets and exclude entered text", () => {
    const input = {target:{id:"username"},text:"private test input"};
    const plan = {steps:[{repeat:{steps:[{if:{},then:[{command:"fill",input}]}]}}]};
    const where = "steps[0].repeat.iteration[3][0].then[0]";
    const steps = [{path:where,command:"fill"}, {path:where,command:"back"}, {path:"__proto__.oops",command:"fill"}];
    const view = withAuthoredTargets({steps},plan);
    assert.equal(view.steps[0].authoredTarget,"username");
    assert.deepEqual(view.steps.slice(1),steps.slice(1));
    assert.doesNotMatch(JSON.stringify(view),/private test input/);
});

// Run the installed pytest, the repository CLI and its file-backed report through the extension Task entry.
// The only simulated part of the execution path is the native phone transport.
test("case reports retain real steps, identify framework phases and validate candidates with the original pytest fixture", {
    skip: !installed && "Set HARMONY_TEST_PYTHON to an interpreter with pytest",
}, async t => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(),"ha-workbench-report-"));
    t.after(() => fs.rm(temp, {recursive:true,force:true}));
    const script = path.join(temp,"fixture_agent.py");
    await fs.writeFile(script, [
        "import sys", "from harmony_agent.cli import main", "from harmony_agent.core import Agent",
        "from tests.test_core import FakeNativeTransport", "def factory(**options):",
        "    device = FakeNativeTransport()", "    device.serial = 'report-fixture'", "    device.connected = [device.serial]",
        "    return Agent(**options, transport=device)", "sys.exit(main(agent_factory=factory))",
    ].join("\n"));
    const cli = path.join(temp, process.platform === "win32" ? "fixture.cmd" : "fixture");
    await fs.writeFile(cli, process.platform === "win32" ? '@echo off\r\n"%REPORT_PYTHON%" "%~dp0fixture_agent.py" %*\r\n' :
        '#!/bin/sh\nexec "$REPORT_PYTHON" "$(dirname "$0")/fixture_agent.py" "$@"\n', {mode:0o700});
    const caseEntry = await writeCase(temp, "Counter", plan);
    const testFile = path.join(caseEntry.folder, caseEntry.filename);
    const conftest = path.join(temp,"conftest.py");
    await fs.writeFile(path.join(temp,"pytest.ini"),"[pytest]\n");
    const source = {name:"Counter",uri:"file:///Counter/workflow.json"};
    let onEnd;
    const bench = {language:"en", storage:{fsPath:temp}, state:{device:"report-fixture", plan:source}, detach:async()=>{},
        config:{get:k=>k === "cliPath" ? cli : undefined}};
    const vscode = {
        workspace:{isTrusted:true,getWorkspaceFolder(){}}, Uri:{file:p=>({toString:()=>p})},
        TaskScope:{Global:1}, TaskGroup:{Test:2}, TaskRevealKind:{Always:1},
        Task:class {constructor(definition,scope,name,provider,execution){Object.assign(this,{definition,execution});}},
        ProcessExecution:class {constructor(file,args,options){Object.assign(this,{file,args,options});}},
        tasks:{
            onDidEndTaskProcess(fn){onEnd=fn;return {dispose(){}};}, onDidEndTask(){return {dispose(){}};},
            async executeTask(task){
                const options = task.execution.options;
                const env = {...process.env, ...options.env, REPORT_PYTHON:python, HARMONY_STATE_DIR:"",
                    PYTEST_DISABLE_PLUGIN_AUTOLOAD:"1", PYTEST_ADDOPTS:"", PYTHONDONTWRITEBYTECODE:"1",
                    PYTHONPATH:[options.env.PYTHONPATH,path.join(repo,"src"),repo].join(path.delimiter)};
                const result = spawnSync(python, task.execution.args, {cwd:options.cwd,env,encoding:"utf8",windowsHide:true,timeout:40000});
                assert.equal(result.error,undefined);
                onEnd({execution:{task},exitCode:result.status});
            }
        }
    };
    const run = async options => {
        const result = await startPytest(vscode,bench,caseEntry,options);
        const view = await loadPytestRun(JSON.parse(JSON.stringify(result.entry)));
        assert.deepEqual(view.entry.plan,source);
        return view;
    };
    const passed = await run();
    assert.equal(passed.status,"passed",JSON.stringify(passed.pytest));
    assert.deepEqual(passed.steps.map(s=>s.path),["preconditions[0]","steps[0]","goals[0]"]);
    assert.equal(passed.steps[1].authoredTarget,"fixture.increment");
    assert.deepEqual(passed.pytest.phases.map(p=>p.phase),["setup","call","teardown"]);
    const candidate = path.join(temp,"candidate.json");
    await fs.writeFile(candidate, JSON.stringify({...plan,goals:[count(3)]}));
    const failed = await run({workflowOverride:candidate});
    assert.equal(failed.status,"failed");
    assert.ok(failed.steps[failed.selected], JSON.stringify(failed.pytest));
    assert.equal(failed.steps[failed.selected].actual,"Counter: 1");
    assert.equal(failed.cleanup,"detached");
    assert.equal(failed.steps[failed.selected].expected,"Counter: 3");
    const executed = JSON.parse(await fs.readFile(failed.entry.pytest.workflowSource, "utf8"));
    assert.deepEqual(executed.goals, [count(3)]);
    assert.notEqual(failed.entry.pytest.directory,passed.entry.pytest.directory);
    assert.equal(JSON.parse(await fs.readFile(path.join(caseEntry.folder,"workflow.json"))).goals[0].equals,"Counter: 1");
    await fs.writeFile(candidate,JSON.stringify(plan));
    const validated = await run({workflowOverride:candidate});
    assert.equal(validated.status,"passed",JSON.stringify(validated.pytest));
    await t.test("a stale locator is proposed from the real frozen failure frame, verified with pytest, then applied", async () => {
        const workflow = path.join(caseEntry.folder,"workflow.json");
        const oldPlan = {...plan,steps:[{command:"press",input:{target:{id:"fixture.increment-old"}}}]};
        const original = JSON.stringify(oldPlan,null,2) + "\n";
        await fs.writeFile(workflow,original);
        const log = path.join(temp,"fixture-runs.txt");
        await fs.writeFile(conftest,[
            "from pathlib import Path","import pytest","@pytest.fixture(autouse=True)","def required_route():",
            "    with Path(__file__).with_name('fixture-runs.txt').open('a') as f: print('prepare',file=f)",
            "    yield","    with Path(__file__).with_name('fixture-runs.txt').open('a') as f: print('cleanup',file=f)",
        ].join("\n"));
        const failure = await run();
        assert.ok(failure.steps[failure.selected]?.locatorFailure, JSON.stringify(failure.steps));
        failure.entry.sourceDigest = sourceDigest(original);
        bench.state.run = failure;
        bench.networks = {bindings:{}};
        bench.reportAgent = entry => ({call:async(command,input)=>{
            const file = path.join(temp,"inspect-request.json");
            await fs.writeFile(file,JSON.stringify({schemaVersion:"1",command,input}));
            const result = spawnSync(python,[script,"--state-dir",entry.pytest.stateDir,"--request",file,"--json"],{
                env:{...process.env,PYTHONPATH:[path.join(repo,"src"),repo].join(path.delimiter),PYTHONDONTWRITEBYTECODE:"1"},
                encoding:"utf8",windowsHide:true});
            const envelope = JSON.parse(result.stdout);
            assert.equal(envelope.success,true,JSON.stringify(envelope.error)); return envelope.data;
        }});
        bench.setPlan = async () => {};
        bench.usePytest = async (_,options) => {
            assert.equal(await fs.readFile(workflow,"utf8"),original);
            bench.state.run = await run(options);
            bench.state.run.entry.repairOf = options.repairOf;
            return bench.state.run.entry;
        };
        bench.refreshPlanSummary = async () => {};
        const persisted = [];
        bench.persistRuns = async () => persisted.push(Boolean(bench.state.run.entry.repairApplied));
        bench.refreshCases = async () => {};
        let contents = original;
        vscode.Uri.parse = s => s;
        vscode.Range = class {constructor(start,end){Object.assign(this,{start,end});}};
        vscode.WorkspaceEdit = class {replace(uri,range,text){Object.assign(this,{range,text});}};
        vscode.workspace.openTextDocument = async()=>({getText:()=>contents, uri:source.uri,positionAt:n=>n,save:async()=>{
            await fs.writeFile(workflow,contents);return true;
        }});
        vscode.workspace.applyEdit = async e => {
            contents = contents.slice(0,e.range.start)+e.text+contents.slice(e.range.end);return true;
        };
        const repair = new CaseRepair(bench,vscode);
        const diagnosis = await diagnoseCase({run:failure,failure:reviewCaseFailure(failure),language:"en",onEvent:()=>{},
            agent:bench.reportAgent,prepare:input=>repair.prepare(input),
            ask:async prompt=>{
                const {options} = JSON.parse(prompt.split("\n").at(-1));
                const candidate = options.find(c=>c.proposed?.id==="fixture.increment");
                assert.ok(candidate,JSON.stringify(options));
                return JSON.stringify({summary:"The counter control has a changed ID.",next:"Verify the alternative with pytest.",
                    recommendation:"verifyLocator",option:candidate.number,citations:["page","failure"]});
            }});
        repair.propose(diagnosis.proposed);
        assert.equal(bench.state.repair.proposed.id,"fixture.increment");
        assert.equal(await fs.readFile(workflow,"utf8"),original);
        await repair.verify({id:failure.entry.id});
        assert.equal(bench.state.repair.stage,"verified",JSON.stringify(bench.state.run.pytest));
        assert.equal(bench.state.run.goalStatus,"passed");
        assert.equal(await fs.readFile(workflow,"utf8"),original);
        await repair.apply({id:bench.state.repair.trial});
        assert.deepEqual(persisted,[true]);
        const fixed = JSON.parse(await fs.readFile(workflow,"utf8"));
        assert.equal(fixed.steps[0].input.target.id,"fixture.increment");
        assert.deepEqual(fixed.goals,oldPlan.goals);
        assert.deepEqual((await fs.readFile(log,"utf8")).trim().split(/\r?\n/),["prepare","cleanup","prepare","cleanup"]);
        assert.equal((await loadPytestRun(failure.entry)).status,"failed");
    });
    await fs.writeFile(conftest,'import pytest\n@pytest.fixture(autouse=True)\ndef setup():\n    raise RuntimeError("fixture unavailable")\n');
    const setupError = await run();
    assert.equal(setupError.steps.length,0);
    assert.match(setupError.pytest.phases.find(p=>p.phase==="setup" && p.outcome==="failed").message,/fixture unavailable/);
    await fs.writeFile(conftest,'import pytest\n@pytest.fixture(autouse=True)\ndef setup():\n    yield\n    raise RuntimeError("cleanup broken")\n');
    const cleanup = await run();
    assert.equal(cleanup.status,"failed");
    assert.equal(cleanup.goalStatus,"passed");
    assert.equal(cleanup.pytest.phases.find(p=>p.phase==="teardown").outcome,"failed");
    await fs.writeFile(testFile,'syntax error : :');
    const invalid = await run();
    assert.equal(invalid.status,"failed");
    assert.equal(invalid.steps.length,0);
    assert.ok(invalid.pytest.phases.some(p=>p.phase==="collection" && p.outcome==="failed"));
});
