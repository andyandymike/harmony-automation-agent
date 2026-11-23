"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { randomUUID } = require("node:crypto");
const { getMcpLaunch } = require("./aiIntegration");
const { deviceRecordingFormat } = require("./model");
const { readWorkflow } = require("./workflowFile");

function launchWorker(interpreter, request, onEvent, env) {
    const child = spawn(interpreter, ["-u", path.join(__dirname, "flowDebugWorker.py")], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: env && { ...process.env, ...env },
    });
    let result, failure, details = "";
    child.stderr.setEncoding("utf8").on("data", data => { details = (details + data).slice(-4000); });
    const lines = createInterface({ input: child.stdout });
    const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
        lines.on("line", line => {
            try {
                const event = JSON.parse(line);
                if (event.type === "complete" || event.type === "error") {
                    result = event;
                    child.stdin.end();
                } else onEvent(event);
            } catch (error) {
                failure = error;
                child.stdin.end();
            }
        });
        child.on("close", code => {
            if (failure) reject(failure);
            else if (result?.type === "error") reject(Object.assign(new Error(result.message), { code: result.code }));
            else if (code !== 0 || !result) reject(new Error(details.trim() || "Debug worker exited without a result."));
            else resolve(result);
        });
    });
    const write = value => {
        if (child.stdin.writable && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(value) + "\n");
    };
    write(request);
    return { done, write };
}

class FlowDebugger {
    constructor(bench, vscode, launch = launchWorker) {
        this.bench = bench;
        this.vscode = vscode;
        this.launch = launch;
    }

    stop() {
        if (!this.job) return;
        this.job.cancelled = true;
        this.job.worker?.write({ action: "stop" });
        this.bench.state.flowDebug.status = "stopping";
        this.bench.publish();
    }

    async handle(message) {
        const b = this.bench, state = b.state, job = this.job, view = state.flowDebug;
        if (message.type === "flowDebugStart") {
            if (!job && !state.draft && !state.busy) return b.perform(() => this.start(message));
            return;
        }
        if (!job || job.id !== message.id) return;
        if (message.type === "flowDebugStop") return this.stop();
        if (view.status !== "paused" || !message.token || view.token !== message.token) return;
        if (message.type === "flowDebugProbe") {
            try {
                const selector = JSON.parse(message.selector);
                job.worker.write({ action: "probe", token: view.token, selector });
            } catch {
                view.probe = { error: /^zh/i.test(b.language) ? "请输入有效的定位器 JSON。" : "Enter valid locator JSON." };
                b.publish();
            }
        } else if (message.type === "flowDebugStep" || message.type === "flowDebugContinue") {
            view.status = "running";
            delete view.probe;
            job.worker.write({ action: message.type === "flowDebugStep" ? "step" : "continue", token: view.token });
            b.publish();
        }
    }

    async start(message) {
        const b = this.bench, state = b.state, planRef = state.plan;
        if (!planRef || !state.device || !state.devices.includes(state.device)) return;
        const document = await this.vscode.workspace.openTextDocument(this.vscode.Uri.parse(planRef.uri));
        const {plan,scenario} = readWorkflow(document.getText());
        if (plan.format === deviceRecordingFormat || !plan.steps?.length) {
            throw new Error(/^zh/i.test(b.language) ? "单步调试支持按控件执行的流程。" : "Step debugging requires a control-based workflow.");
        }
        const { command, env, hdcPath } = await getMcpLaunch(b);
        const breakpoints = (message.breakpoints || []).filter(i => Number.isInteger(i) && i >= 0 && i < plan.steps.length);
        const entry = { id: randomUUID(), plan: planRef, time: new Date().toISOString(), status: "running" };
        const job = this.job = { id: entry.id };
        const view = state.flowDebug = { id: entry.id, planUri: planRef.uri, status: "starting", breakpoints };
        const expired = state.runs.slice(49);
        state.runs = [entry, ...state.runs].slice(0, 50);
        state.mode = "workflow";
        try {
            await b.persistRuns();
            for (const old of expired) if (old.source === "device") await b.context.workspaceState.update("gestures." + old.id, undefined);
            if (job.cancelled || !b.panel) { entry.status = "cancelled"; return; }
            await b.prepareFlowScenario?.(planRef,scenario,entry.id);
            if (job.cancelled || !b.panel) { entry.status = "cancelled"; return; }
            const request = { session: b.session, stateDir: b.stateDir, hdcPath,
                runId: entry.id, device: state.device, plan, breakpoints };
            view.status = "running";
            b.publish();
            job.worker = this.launch(command, request, event => {
                if (job.cancelled) return;
                if (event.type === "paused") {
                    Object.assign(view, { status: "paused", path: event.path, operation: event.operation, token: event.token,
                        frameId: event.frameId, probe: undefined });
                } else if (event.type === "probe" && view.token === event.token) {
                    view.probe = event;
                } else if (event.type === "step") {
                    view.last = event.path;
                }
                b.publish();
            }, env);
            const result = await job.worker.done;
            entry.status = result.status;
            entry.cleanup = "detached";
            await b.openReport(entry.id);
        } catch (error) {
            entry.status = "unknown";
            if (error.code === "DEBUG_CORE_REQUIRED") {
                entry.status = "rejected";
                if (/^zh/i.test(b.language)) error.message = "单步调试需要 harmony-automation-agent 0.1.0a10 或更高版本。";
            }
            throw error;
        } finally {
            this.job = undefined;
            state.flowDebug = undefined;
            await b.persistRuns();
        }
    }
}

module.exports = { FlowDebugger, launchWorker };
