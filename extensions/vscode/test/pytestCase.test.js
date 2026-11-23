"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readiness, safeCaseName, writeCase, findCase, startPytest } = require("../src/pytestCase");
const { readWorkflow } = require("../src/workflowFile");

const start = {selector: {id: "login"}, property: "visible", equals: true};
const goal = {selector: {id: "welcome"}, property: "text", equals: "Hello"};
const plan = {version: "1", preconditions: [start], steps: [{command: "press", input: {target: {id: "login"}}}], goals: [goal]};
const group = {version: 1, name: "Test responses", rules: []};

async function temporary(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-pytest-check-"));
    t.after(() => fs.rm(dir, {recursive: true, force: true}));
    return dir;
}

test("pytest readiness identifies missing boundaries and coordinates before writing or executing", () => {
    assert.equal(readiness(plan), undefined);
    assert.equal(readiness({...plan, preconditions: []}), "start");
    assert.equal(readiness({...plan, goals: []}), "goal");
    assert.equal(readiness({...plan, preconditions: [], goals: []}), "both");
    assert.equal(readiness({format: "harmony-agent.device-recording"}), "gestures");
    for (const value of ["../outside", "a/b", "COM1", "NUL.test", ".", "abc.", ""]) assert.equal(safeCaseName(value), false);
    assert.equal(safeCaseName("首页 业务_01"), true);
});

test("an exported group travels with one editable workflow, concurrent exporters cannot overwrite a case", async t => {
    const parent = await temporary(t);
    const results = await Promise.allSettled([writeCase(parent, "订单", plan, group), writeCase(parent, "订单", plan, group)]);
    assert.deepEqual(results.map(r => r.status).sort(), ["fulfilled", "rejected"]);
    const entry = results.find(r => r.status === "fulfilled").value;
    assert.equal(results.find(r => r.status === "rejected").reason.code, "EEXIST");
    const source = readWorkflow(await fs.readFile(path.join(entry.folder, "workflow.json"), "utf8"));
    assert.deepEqual(source.plan, plan);
    assert.equal(source.scenario.name, group.name);
    assert.match(await fs.readFile(path.join(entry.folder, entry.filename), "utf8"), /REQUIRES_RULE_GROUP = True/);
    const moved = path.join(parent, "moved workspace");
    await fs.rename(entry.folder, moved);
    assert.deepEqual(await findCase({scheme: "file", fsPath: path.join(moved, "workflow.json")}), {...entry, folder: moved});
    await assert.rejects(writeCase(parent, "../elsewhere", plan));
    await assert.rejects(writeCase(parent, "missing", {...plan, goals: []}));
});

test("the workbench runs a process task in the case folder and returns the pytest exit status", async t => {
    const directory = await temporary(t);
    let task, onEnd, detached = 0, disposed = 0;
    const vscode = {
        workspace: {getWorkspaceFolder: () => undefined, isTrusted: true},
        Uri: {file: name => ({toString: () => name})}, TaskScope: {Global: 1}, TaskGroup: {Test: 2}, TaskRevealKind: {Always: 1},
        Task: class { constructor(definition, scope, name, source, execution) { Object.assign(this, {definition, execution}); } },
        ProcessExecution: class { constructor(file, args, options) { Object.assign(this, {file, args, options}); } },
        tasks: {onDidEndTaskProcess(fn) { onEnd = fn; return {dispose() { disposed++; }}; }, onDidEndTask() {return {dispose() {disposed++;}};},
            async executeTask(value) {task = value; onEnd({execution: {task: value}, exitCode: 1});}},
    };
    const bench = {state: {device: "selected-phone", plan:{uri:"file:///sample", name:"sample"}}, storage: {fsPath: directory}, config: {get: () => undefined},
        async detach() {detached++;}};
    const result = await startPytest(vscode, bench, {folder: "/case folder", filename: "test_run.py"});
    assert.equal(detached, 1);
    assert.equal(disposed, 2);
    assert.equal(result.code, 1);
    assert.deepEqual(task.execution.args, ["-m", "pytest", "-p", "harmony_workbench_reporter", "-v", "test_run.py"]);
    assert.equal(result.entry.status, "failed");
    assert.equal(result.entry.pytest.executionCount, 0);
    assert.equal(task.execution.options.env.HARMONY_DEVICE, "selected-phone");
    assert.equal(task.execution.options.cwd, "/case folder");
});

const python = process.env.HARMONY_TEST_PYTHON || "python";
const pytestAvailable = spawnSync(python, ["-c", "import pytest"], {windowsHide: true}).status === 0;

test("the selected project Python runs an existing generated test through the selected CLI script", {
    skip: !pytestAvailable && "Set HARMONY_TEST_PYTHON to a Python interpreter with pytest",
}, async t => {
    const root = await temporary(t);
    const entry = await writeCase(root, "project case", plan);
    const entryPath = path.join(entry.folder, entry.filename);
    const original = await fs.readFile(entryPath, "utf8");
    const runtime = {
        python: spawnSync(python, ["-c", "import sys; print(sys.executable)"], {encoding:"utf8",windowsHide:true}).stdout.trim(),
        src: path.join(root, "runtime source"), cli: path.join(root, "project launch.py"), hdc: path.join(root, "test hdc"),
    };
    await fs.mkdir(runtime.src);
    await fs.writeFile(path.join(runtime.src, "harmony_runtime_test_marker.py"), "READY = True\n");
    await fs.writeFile(runtime.cli, [
        "from harmony_runtime_test_marker import READY", "import json, os, sys",
        "assert READY and sys.argv[sys.argv.index('--hdc') + 1] == os.environ['HARMONY_HDC']",
        "assert sys.executable == os.environ['HARMONY_PYTEST_PROJECT_PYTHON']",
        "print(json.dumps({'success':True,'data':{'status':'completed','goalVerification':{'status':'passed','assertions':[{'status':'passed'}]}}}))",
    ].join("\n"));
    let onEnd, execution;
    const vscode = {
        workspace: { getWorkspaceFolder: () => undefined, isTrusted: true },
        extensions: { getExtension: () => ({ activate() { throw new Error("Unexpected Python extension lookup"); } }) },
        Uri: { file: name => ({ toString: () => name }) }, TaskScope: { Global: 1 }, TaskGroup: { Test: 2 }, TaskRevealKind: { Never: 3 },
        Task: class { constructor(definition, _scope, _name, _source, execution) { Object.assign(this, { definition, execution }); } },
        ProcessExecution: class { constructor(file, args, options) { Object.assign(this, { file, args, options }); } },
        tasks: {
            onDidEndTaskProcess(fn) { onEnd = fn; return { dispose() {} }; },
            onDidEndTask() { return { dispose() {} }; },
            async executeTask(task) {
                execution = task.execution;
                const result = spawnSync(execution.file, execution.args, {
                    cwd: execution.options.cwd, encoding: "utf8", windowsHide: true, timeout: 20000,
                    env: { ...process.env, ...execution.options.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PYTEST_ADDOPTS: "" },
                });
                assert.equal(result.status, 0, result.stdout + result.stderr);
                onEnd({ execution: { task }, exitCode: result.status });
            },
        },
    };
    const bench = { state: { device: "fixture-phone", plan: { uri: "file:///fixture", name: "fixture" } }, storage: { fsPath: root },
        config: { get() { throw new Error("Unexpected settings lookup"); } }, async detach() {},
        projectRuntime: { configuration: runtime, async ready() {}, async verifyPython(value) { assert.equal(value,runtime); } },
    };
    const result = await startPytest(vscode, bench, entry);
    assert.equal(result?.code, 0, result?.entry.pytest.launchError);
    assert.equal(result.entry.status, "passed");
    assert.equal(execution.file, runtime.python);
    assert.equal(execution.options.env.PYTHONPATH.split(path.delimiter)[0], runtime.src);
    assert.equal(await fs.readFile(entryPath, "utf8"), original);
});

test("real pytest collects and checks generated tests with an offline CLI and explicit rule-group fixture", {
    skip: !pytestAvailable && "Set HARMONY_TEST_PYTHON to a Python interpreter with pytest",
}, async t => {
    const parent = await temporary(t);
    const cliFile = path.join(parent, "fake_agent.py");
    const cli = path.join(parent, process.platform === "win32" ? "fake-agent.cmd" : "fake-agent");
    const recorder = path.join(parent, "calls.log");
    const artifacts = path.join(parent, "artifacts");
    await fs.writeFile(cliFile, [
        "import json, os, sys", "from pathlib import Path", "args = sys.argv[1:]",
        "command = next(c for c in ('execute', 'report', 'detach') if c in args)",
        "with open(os.environ['MOCK_LOG'], 'a', encoding='utf8') as file: print(command, file=file)",
        "data = {}", "if command == 'execute':",
        "    assert json.loads(Path(args[args.index('--plan-file')+1]).read_text(encoding='utf8'))['version'] == '1'",
        "    mode = os.environ.get('MOCK_GOAL', 'passed')",
        "    data = {'status': 'completed', 'goalVerification': {'status': mode, 'assertions': []}}",
        "    if mode == 'passed': data['goalVerification']['assertions'].append({'status':'passed','expected':'Hello','actual':'Hello'})",
        "    if mode == 'failed': data['goalVerification']['assertions'].append({'status':'failed','expected':'Hello','actual':'Error'})",
        "elif command == 'report': data = {'receipts': [{'path':'goals[0]'}]}",
        "print(json.dumps({'success':True,'data':data}))",
    ].join("\n"));
    await fs.writeFile(cli, process.platform === "win32" ?
        '@echo off\r\n"' + python + '" "%~dp0fake_agent.py" %*\r\n' :
        '#!/bin/sh\nexec "$MOCK_PYTHON" "$(dirname "$0")/fake_agent.py" "$@"\n', {mode: 0o700});
    const env = {...process.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PYTEST_ADDOPTS: "", HARMONY_AGENT_CLI: cli,
        HARMONY_DEVICE: "synthetic-phone", HARMONY_ARTIFACT_DIR: artifacts, HARMONY_STATE_DIR: "", HARMONY_RULE_GROUP_FIXTURE: "",
        MOCK_LOG: recorder, MOCK_PYTHON: python};
    await fs.writeFile(path.join(parent, "pytest.ini"), "[pytest]\n");
    function run(entry, args, extraEnv = {}) {
        const result = spawnSync(python, ["-m", "pytest", "-c", path.join(parent, "pytest.ini"), "-q", ...args, entry.filename],
            {cwd: entry.folder, env: {...env, ...extraEnv}, encoding: "utf8", windowsHide: true, timeout: 30000});
        return {code: result.status, text: result.stdout + result.stderr};
    }
    const plain = await writeCase(parent, "checked", plan);
    const collected = run(plain, ["--collect-only"], {HARMONY_DEVICE: ""});
    assert.equal(collected.code, 0, collected.text);
    assert.match(collected.text, /::test_workflow/);
    await assert.rejects(fs.access(recorder));
    const passed = run(plain, []);
    assert.equal(passed.code, 0, passed.text);
    assert.match(passed.text, /1 passed/);
    const junit = path.join(parent, "results.xml");
    const failed = run(plain, ["--junitxml", junit], {MOCK_GOAL: "failed"});
    assert.equal(failed.code, 1, failed.text);
    assert.match(failed.text, /final check: failed/);
    assert.match(failed.text, /Hello/);
    assert.match(failed.text, /Run ID/);
    assert.match(await fs.readFile(junit, "utf8"), /<failure[^>]*message=/);
    const locations = await fs.readdir(artifacts);
    const saved = await Promise.all(locations.map(id => fs.readdir(path.join(artifacts, id))));
    assert.ok(saved.some(files => files.includes("report.json") && files.includes("cleanup.json")));
    const noGoal = run(plain, [], {MOCK_GOAL: "not_requested"});
    assert.equal(noGoal.code, 1, noGoal.text);
    assert.match(noGoal.text, /final check: not_requested/);
    const beforeEdit = await fs.readFile(recorder, "utf8");
    await fs.writeFile(path.join(plain.folder, "workflow.json"), JSON.stringify({...plan, preconditions: []}));
    const noStart = run(plain, []);
    assert.equal(noStart.code, 1, noStart.text);
    assert.match(noStart.text, /starting precondition/);
    assert.equal(await fs.readFile(recorder, "utf8"), beforeEdit);
    const withGroup = await writeCase(parent, "network", plan, group);
    const before = await fs.readFile(recorder, "utf8");
    const unprepared = run(withGroup, []);
    assert.equal(unprepared.code, 1, unprepared.text);
    assert.match(unprepared.text, /Set HARMONY_RULE_GROUP_FIXTURE/);
    const unknownFixture = run(withGroup, [], {HARMONY_RULE_GROUP_FIXTURE:"no_such_fixture"});
    assert.equal(unknownFixture.code, 1, unknownFixture.text);
    assert.match(unknownFixture.text, /no_such_fixture/);
    assert.equal(await fs.readFile(recorder, "utf8"), before);
    await fs.writeFile(path.join(parent, "conftest.py"), [
        "from contextlib import contextmanager", "from pathlib import Path", "import os", "import pytest", "@pytest.fixture", "def selected_fixture():",
        "    @contextmanager", "    def prepare(*,rule_group,device,state_dir):",
        "        assert rule_group['name'] == 'Test responses' and device == 'synthetic-phone'",
        "        assert state_dir == Path(os.environ['HARMONY_STATE_DIR']).resolve()",
        "        with open(os.environ['MOCK_LOG'], 'a') as f: print('prepare', file=f)",
        "        try: yield", "        finally:", "            with open(os.environ['MOCK_LOG'], 'a') as f: print('teardown', file=f)",
        "    return prepare",
    ].join("\n"));
    const prepared = run(withGroup, [], {HARMONY_RULE_GROUP_FIXTURE: "selected_fixture", HARMONY_STATE_DIR: path.join(parent, "separate cli state")});
    assert.equal(prepared.code, 0, prepared.text);
    assert.match(await fs.readFile(recorder, "utf8"), /prepare\r?\nexecute\r?\nteardown/);
    await fs.writeFile(path.join(withGroup.folder, "workflow.json"), JSON.stringify(plan));
    const removed = run(withGroup, []);
    assert.equal(removed.code, 1, removed.text);
    assert.match(removed.text, /Restore the required rule group/);
});
