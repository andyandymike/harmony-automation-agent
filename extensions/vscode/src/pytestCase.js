"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const { deviceRecordingFormat } = require("./model");
const { workflowWithScenario } = require("./workflowFile");
const { validateScenario } = require("./network");
const { finishPytest } = require("./pytestReport");
const { journalPath } = require("./runProgress");

const templatePath = path.join(__dirname, "templates", "pytest_case.py");

function readiness(plan) {
    if (plan?.format === deviceRecordingFormat) return "gestures";
    if (!["1", "2"].includes(plan?.version) || !Array.isArray(plan.steps) || !plan.steps.length) return "invalid";
    const start = Array.isArray(plan.preconditions) && plan.preconditions.length;
    const goal = Array.isArray(plan.goals) && plan.goals.length;
    if (!start && !goal) return "both";
    if (!start) return "start";
    if (!goal) return "goal";
}

function safeCaseName(value) {
    return typeof value === "string" && value.length <= 70 && /^[\p{L}\p{N}_-]+(?:[ .][\p{L}\p{N}_-]+)*$/u.test(value) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function testFilename(name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    return "test_" + (slug ? slug + "_" : "workflow_") + suffix + ".py";
}

async function writeCase(parent, name, plan, group) {
    if (!safeCaseName(name)) throw new Error("Invalid case folder name");
    if (readiness(plan)) throw new Error("The workflow needs a control plan with preconditions and goals");
    const filename = testFilename(name);
    const template = await fs.readFile(templatePath, "utf8");
    const workflow = group ? workflowWithScenario(plan, validateScenario(group)) : plan;
    const contents = [["workflow.json", JSON.stringify(workflow, null, 2) + "\n"],
        [filename, template.replace("__REQUIRES_RULE_GROUP__", group ? "True" : "False")]];
    const folder = path.join(parent, name);
    await fs.mkdir(folder, { mode: 0o700 });
    const created = [];
    try {
        for (const [file, content] of contents) {
            const dest = path.join(folder, file);
            const handle = await fs.open(dest, "wx", 0o600);
            created.push(dest);
            try { await handle.writeFile(content); } finally { await handle.close(); }
        }
    } catch (error) {
        await Promise.allSettled(created.map(file => fs.unlink(file)));
        await fs.rmdir(folder).catch(() => {});
        throw error;
    }
    return { folder, filename, requiresRuleGroup: Boolean(group) };
}

async function findCase(uri) {
    if (uri?.scheme !== "file" || path.basename(uri.fsPath) !== "workflow.json") return;
    const folder = path.dirname(uri.fsPath);
    try {
        const files = (await fs.readdir(folder, {withFileTypes: true})).filter(file => file.isFile() && /^test_\w+_[a-f0-9]{12}\.py$/.test(file.name));
        if (files.length !== 1) return;
        const [candidate] = files;
        const handle = await fs.open(path.join(folder, candidate.name), "r");
        try {
            const buffer = Buffer.alloc(2048);
            const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
            const header = buffer.toString("utf8", 0, bytesRead);
            if (!header.startsWith("# Harmony Agent Workbench pytest case v1")) return;
            return {folder, filename:candidate.name, requiresRuleGroup:/^REQUIRES_RULE_GROUP = True$/m.test(header)};
        } finally { await handle.close(); }
    } catch (error) {
        if (!["ENOENT", "EACCES", "ENOTDIR", "EPERM"].includes(error.code)) throw error;
    }
}

async function startPytest(vscode, bench, entry, {workflowOverride, onRunning} = {}) {
    const zh = /^zh/i.test(bench.language);
    if (vscode.workspace.isTrusted === false) throw new Error(zh ? "请先在 VS Code 中信任此工作区，再运行项目测试。" : "Trust this workspace in VS Code before running its tests.");
    const device = bench.state.device || process.env.HARMONY_DEVICE;
    if (!device) throw new Error(zh ? "请在工作台选择手机，或在终端设置 HARMONY_DEVICE 后运行用例。" : "Select a device in the workbench, or set HARMONY_DEVICE and run the test in a terminal.");
    const script = vscode.Uri.file(path.join(entry.folder, entry.filename));
    const invocation = randomUUID();
    const evidenceRoot = path.resolve(process.env.HARMONY_ARTIFACT_DIR || path.join(bench.storage.fsPath, "pytest-artifacts"));
    const directory = path.join(evidenceRoot, invocation);
    const plan = bench.state.plan;
    const env = {HARMONY_DEVICE:device, HARMONY_ARTIFACT_DIR:directory,
        HARMONY_PYTEST_RESULT:path.join(directory, "pytest.json"), HARMONY_PYTEST_TARGET:path.join(entry.folder, entry.filename),
        HARMONY_PYTEST_WORKFLOW_OVERRIDE:workflowOverride || "",
        PYTHONPATH:[path.dirname(templatePath), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)};
    if (workflowOverride && !path.isAbsolute(workflowOverride)) throw new Error("Expected an absolute candidate workflow path");
    let candidate;
    if (workflowOverride) {
        const source = JSON.parse((await fs.readFile(workflowOverride, "utf8")).replace(/^\uFEFF/, ""));
        candidate = source?.format === "harmony-agent.workflow-scenario" ? source.workflow : source;
        if (readiness(candidate)) throw new Error("A candidate must contain a runnable workflow.");
    }
    if (bench.config.get("cliPath")) env.HARMONY_AGENT_CLI = bench.config.get("cliPath");
    if (bench.config.get("hdcPath")) env.HARMONY_HDC = bench.config.get("hdcPath");
    if (entry.requiresRuleGroup && !process.env.HARMONY_RULE_GROUP_FIXTURE) {
        const fixture = await vscode.window.showInputBox({ title: zh ? "准备规则组的 pytest fixture" : "Pytest fixture that prepares the rule group",
            prompt: zh ? "输入项目已注册的 fixture 名称。它负责启动网关并配置设备路由。" : "Enter the registered fixture that prepares the gateway and device route.",
            ignoreFocusOut: true, validateInput: name => /^[A-Za-z_]\w*$/.test(name) ? undefined :
                (zh ? "请输入 Python 标识符。" : "Enter a Python identifier.") });
        if (!fixture) return;
        env.HARMONY_RULE_GROUP_FIXTURE = fixture;
    }
    let python = process.env.HARMONY_PYTEST_PYTHON || "python";
    const pythonExtension = vscode.extensions?.getExtension("ms-python.python");
    if (pythonExtension && !process.env.HARMONY_PYTEST_PYTHON) {
        const api = await pythonExtension.activate();
        const active = api.environments?.getActiveEnvironmentPath(script);
        if (active) python = (await api.environments.resolveEnvironment(active))?.executable?.uri?.fsPath || python;
    }
    const time = new Date().toISOString();
    const task = new vscode.Task({type: "harmony-pytest", case: script.toString(), invocation},
        vscode.workspace.getWorkspaceFolder(script) || vscode.TaskScope.Global, "pytest · " + entry.filename, "Harmony Agent",
        new vscode.ProcessExecution(python, ["-m", "pytest", "-p", "harmony_workbench_reporter", "-v", entry.filename], {cwd: entry.folder, env}));
    task.group = vscode.TaskGroup.Test;
    task.presentationOptions = {reveal: vscode.TaskRevealKind.Never, focus:false};
    if (bench.state.device) await bench.detach();
    await fs.mkdir(evidenceRoot, {recursive:true, mode:0o700});
    await fs.mkdir(directory, {mode:0o700});
    const sourceFile = workflowOverride || path.join(entry.folder, "workflow.json");
    const sourceCopy = path.join(directory, "workflow-source.json");
    try { await fs.copyFile(sourceFile, sourceCopy); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const mine = event => event.execution.task.definition.invocation === invocation;
    const processEnd = vscode.tasks.onDidEndTaskProcess(event => { if (mine(event)) finish({code: event.exitCode}); });
    let fallback;
    const taskEnd = vscode.tasks.onDidEndTask(event => { if (mine(event)) fallback = setTimeout(() => finish({code:undefined}), 50); });
    // The generated test creates a unique run subdirectory, including when using an existing template.
    const sharedState = process.env.HARMONY_STATE_DIR && path.resolve(entry.folder, process.env.HARMONY_STATE_DIR);
    const locate = async () => {
        const dirs = (await fs.readdir(directory,{withFileTypes:true})).filter(dir=>dir.isDirectory() &&
            /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(dir.name));
        if (dirs.length !== 1) return;
        const {name:id} = dirs[0];
        return {id,file:journalPath(sharedState || path.join(directory,id,"state"),id)};
    };
    const stopProgress = onRunning?.({id:invocation,source:"pytest",plan,device,time,status:"running"},locate,candidate);
    let outcome;
    try {
        await vscode.tasks.executeTask(task);
        outcome = await done;
    } catch (error) {
        outcome = {launchError:String(error.message || error)};
    } finally {
        clearTimeout(fallback);
        processEnd.dispose();
        taskEnd.dispose();
        stopProgress?.();
    }
    // Resolve paths the same way as the generated Python test, which runs in entry.folder.
    const result = await finishPytest({directory, invocation, plan, time, device, sharedState, sourceFile, ...outcome});
    if (candidate && result.entry.status === "passed") {
        const deviceRun = result.entry.pytest.deviceRun;
        let actual, execution;
        if (deviceRun) {
            try {
                const folder = path.join(directory, deviceRun);
                [actual, execution] = await Promise.all(["plan.json", "execution.json"].map(async file =>
                    JSON.parse(await fs.readFile(path.join(folder, file), "utf8"))));
            }
            catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
        }
        const verified = execution?.data?.goalVerification;
        if (!isDeepStrictEqual(actual, candidate) || !execution?.success || execution.data?.status !== "completed" ||
            verified?.status !== "passed" || verified.assertions?.length !== candidate.goals.length ||
            !verified.assertions.every(a => a?.status === "passed")) {
            result.entry.status = "failed";
            result.entry.pytest.launchError = zh ? "未找到本次候选流程的执行证据。" : "This run did not produce evidence for the candidate workflow.";
        }
    }
    return result;
}

module.exports = { readiness, safeCaseName, writeCase, findCase, startPytest, testFilename, templatePath };
