"use strict";

const { randomUUID } = require("node:crypto");
const { getMcpLaunch } = require("./aiIntegration");
const { deviceRecordingFormat } = require("./model");
const { readWorkflow, requireExecutableWorkflow } = require("./workflowFile");

const {hasRuleSteps,planWithRuleCheckpoints,saveRulePlanForRun} = require("./caseRuleSteps");
const {launchWorker,launchWorkflow} = require("./workflowWorker");

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
        const workflow = readWorkflow(document.getText());
        requireExecutableWorkflow(workflow,b.language);
        const {plan,scenario} = workflow;
        if (plan.format === deviceRecordingFormat || !plan.steps?.length) {
            throw new Error(/^zh/i.test(b.language) ? "单步调试支持按控件执行的流程。" : "Step debugging requires a control-based workflow.");
        }
        await b.requireGestureRuntime?.(plan);
        const { command, env, hdcPath } = await getMcpLaunch(b);
        const breakpoints = (message.breakpoints || []).filter(i => Number.isInteger(i) && i >= 0 && i < plan.steps.length);
        const entry = { id: randomUUID(), plan: planRef, time: new Date().toISOString(), status: "running" };
        if (message.skipRuleGroup===true) entry.ruleGroupDisabled = true;
        const job = this.job = { id: entry.id };
        const view = state.flowDebug = { id: entry.id, planUri: planRef.uri, status: "starting", breakpoints };
        const expired = state.runs.slice(49);
        state.runs = [entry, ...state.runs].slice(0, 50);
        state.mode = "workflow";
        let ruleScope;
        try {
            await b.persistRuns();
            for (const old of expired) if (old.source === "device") await b.context.workspaceState.update("gestures." + old.id, undefined);
            if (job.cancelled || !b.panel) { entry.status = "cancelled"; return; }
            const group = message.skipRuleGroup===true ? undefined : scenario || b.networks?.bindings?.[planRef.uri];
            ruleScope = await b.networks?.beginCaseRules?.(group,entry.id,
                {prepare:message.skipRuleGroup!==true && hasRuleSteps(plan,"enable")});
            if (job.cancelled || !b.panel) { entry.status = "cancelled"; return; }
            const request = {session:b.session,stateDir:b.stateDir,runId:entry.id,device:state.device,breakpoints,debug:true};
            view.status = "running";
            b.publish();
            job.worker = launchWorkflow(this.launch,{command,env,hdcPath},request,planWithRuleCheckpoints(plan),
                message.skipRuleGroup===true ? undefined : ruleScope,event => {
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
            });
            const result = await job.worker.done;
            await saveRulePlanForRun(b.stateDir,entry.id,plan);
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
            try { await ruleScope?.close(); }
            finally { await b.persistRuns(); }
        }
    }
}

module.exports = { FlowDebugger, launchWorker };
