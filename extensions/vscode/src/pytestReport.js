"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {isDeepStrictEqual} = require("node:util");
const {runView, withAuthoredTargets} = require("./model");
const {createBdd} = require("./caseBdd");
const {restorePresentation} = require("./casePresentation");

const deviceRunName = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

async function readJson(file) {
    try { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/,"")); }
    catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR" && !(error instanceof SyntaxError)) throw error;
    }
}

function pytestStatus(code, phases) {
    if (phases.some(p => p.outcome === "failed" && p.phase !== "interrupted")) return "failed";
    if (code === 2 || phases.some(p => p.phase === "interrupted")) return "cancelled";
    if (code === undefined || code === null) return "unknown";
    if (code !== 0) return "failed";
    if (!phases.some(p => p.phase === "call" && p.outcome === "passed")) {
        return phases.some(p => p.outcome === "skipped") ? "skipped" : "unknown";
    }
    return "passed";
}

async function finishPytest({directory, invocation, plan, device, time, code, sharedState, sourceFile, launchError, releaseSession}) {
    const pytest = await readJson(path.join(directory, "pytest.json"));
    const phases = Array.isArray(pytest?.phases) ? pytest.phases : [];
    const exitCode = code ?? pytest?.exitCode;
    const dirs = (await fs.readdir(directory, {withFileTypes:true})).filter(d => d.isDirectory() && deviceRunName.test(d.name));
    // Each generated test creates its own UUID directory. Preparation can fail before any device run exists.
    const executions = [];
    for (const dir of dirs) {
        const folder = path.join(directory,dir.name);
        const execution = await readJson(path.join(folder,"execution.json"));
        if (execution) executions.push(dir.name);
        if (!releaseSession || execution?.data?.sessionCleanup?.status==="detached") continue;
        const receiptFile = path.join(folder,"cleanup.json");
        if ((await readJson(receiptFile))?.success) continue;
        const stateDir = sharedState || path.join(folder,"state");
        const journal = !execution && await readJson(path.join(stateDir,"runs",dir.name,"run.json"));
        // A stopped task may leave a journal without execution.json or a cleanup receipt.
        if (!execution && journal?.runId!==dir.name) continue;
        let receipt;
        try {
            const data = await releaseSession(dir.name,stateDir);
            receipt = {success:true,data};
        } catch (error) {
            receipt = {success:false,error:{code:error.code,message:error.message}};
        }
        await fs.writeFile(receiptFile,JSON.stringify(receipt)+"\n",{mode:0o600}).catch(error=>{
            console.warn("Harmony Agent could not save pytest cleanup evidence",error);
        });
    }
    const deviceRun = executions.length === 1 ? executions[0] : undefined;
    let workflowSource;
    if (deviceRun) {
        const dir = path.join(directory, deviceRun);
        const exact = path.join(dir, "workflow-source.json");
        if (await readJson(exact)) workflowSource = exact;
        else if (sourceFile) {
            const snapshot = path.join(directory, "workflow-source.json");
            const source = await readJson(snapshot);
            const planOnly = source?.format === "harmony-agent.workflow-scenario" ? source.workflow : source;
            if (source && isDeepStrictEqual(source, await readJson(sourceFile)) &&
                isDeepStrictEqual(planOnly, await readJson(path.join(dir, "plan.json")))) workflowSource = snapshot;
        }
    }
    const entry = {
        id: deviceRun || invocation, source:"pytest", plan, device, time,
        status: launchError ? "failed" : pytestStatus(exitCode, phases),
        pytest: {directory, invocation, code:exitCode, deviceRun, executionCount:executions.length, workflowSource,
            stateDir: deviceRun && (sharedState || path.join(directory, deviceRun, "state")), launchError}
    };
    return {code:exitCode, entry};
}

async function loadPytestRun(entry, language, presentationData, projectRun) {
    const info = entry.pytest;
    const session = await readJson(path.join(info.directory, "pytest.json"));
    let record, cleanup, executedPlan, executionError;
    let fullEvidence = false;
    if (info.deviceRun) {
        const folder = path.join(info.directory, info.deviceRun);
        executedPlan = await readJson(path.join(folder, "plan.json"));
        // Old templates emitted a full report only on failure. All completed CLI runs journal each receipt.
        const exported = await readJson(path.join(folder, "report.json"));
        if (exported?.success && exported.data?.runId === info.deviceRun) record = exported.data;
        if (!record) {
            const journal = await readJson(path.join(info.stateDir, "runs", info.deviceRun, "run.json"));
            if (journal?.runId === info.deviceRun) record = journal;
        }
        fullEvidence = Array.isArray(record?.receipts);
        const execution = await readJson(path.join(folder, "execution.json"));
        executionError = execution?.error;
        const finalCleanup = await readJson(path.join(folder, "cleanup.json"));
        if (finalCleanup?.success) cleanup = "detached";
        else if (finalCleanup?.success === false) cleanup = "failed";
        if (!record) record = execution?.data;
        if (record && execution?.data?.sessionCleanup) {
            record = {...record, workflowReceipt:{...record.workflowReceipt, sessionCleanup:execution.data.sessionCleanup}};
        }
    }
    const source = await readJson(info.workflowSource || path.join(info.directory,"workflow-source.json"));
    const wrapped = source?.format === "harmony-agent.workflow-scenario";
    const plan = executedPlan || (wrapped ? source.workflow : source);
    const bdd = createBdd(plan,language,wrapped ? source.scenario : undefined,restorePresentation(plan,presentationData));
    return {
        ...(record ? (projectRun ? projectRun(record,plan) : withAuthoredTargets(runView(record),executedPlan)) : {steps:[],selected:0}),
        ...(executionError && !record?.result?.error && !record?.error && {error:executionError.message,errorCode:executionError.code}),
        status:entry.status, entry, bdd, ...(cleanup && {cleanup}),
        pytest: {code:info.code, phases:session?.phases || [], elapsedMs:session?.elapsedMs,
            launchError:info.launchError, recorded:Boolean(session), fullEvidence, executionCount:info.executionCount}
    };
}

module.exports = {finishPytest, loadPytestRun};
