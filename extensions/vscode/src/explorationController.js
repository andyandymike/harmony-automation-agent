"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { ExplorationStore, summary } = require("./explorationStore");
const { createExploration, runExploration, finishExplorationBranches } = require("./explorationEngine");
const { prepareFlow, draftFlow, regressionPlan } = require("./explorationFlow");
const { canRecheck, recheckFinding } = require("./explorationRecheck");
const { caseRoutes, explorationCandidate } = require("./explorationCases");
const { pageView } = require("./model");
const { readWorkflow, workflowWithScenario } = require("./workflowFile");

class ExplorationController {
    constructor(bench, vscode) {
        this.bench = bench;
        this.vscode = vscode;
        this.store = new ExplorationStore(path.join(bench.storage.fsPath, "explorations"));
    }

    get state() { return this.bench.state; }
    words(en, zh) { return /^zh/i.test(this.bench.language) ? zh : en; }

    async history() { this.state.explorationHistory = await this.store.history(); }

    async save(report) {
        for (const finding of report.findings) {
            if (finding.kind === "failure") finding.canRecheck = canRecheck(finding);
        }
        await this.store.save(report);
        if (this.state.exploration?.id === report.id) this.state.explorationCaseRoutes = caseRoutes(report);
        const entries = this.state.explorationHistory.filter(item => item.id !== report.id);
        this.state.explorationHistory = [summary(report), ...entries];
        this.bench.publish();
    }

    cancel(reason) { this.job?.controller.abort(reason); }

    async handle(message) {
        const s = this.state, current = s.exploration;
        if (message.type === "explorationPause" || message.type === "explorationStop") {
            if (this.job && (!message.id || this.job.id === message.id)) {
                this.cancel(message.type === "explorationPause" ? "pause" : "stop");
                return;
            }
        }
        if (s.busy || this.job || s.draft) return;
        return this.bench.perform(async () => {
            s.mode = "exploration";
            switch (message.type) {
                case "explorationNew":
                case "explorationFromCase":
                case "explorationOpen": {
                    if (message.type !== "explorationOpen") s.exploration = s.explorationEvidence = s.explorationFlow = undefined;
                    await this.bench.networks?.init();
                    const n = s.network;
                    s.explorationRuleGroup = n?.scenario?.rules?.some(rule=>rule.enabled!==false) && !n.scenario.paused ?
                        {id:n.activeScenarioId,version:n.scenarioVersion,name:n.scenario.name} : undefined;
                    await this.history();
                    if (message.type === "explorationFromCase") await this.prepare({source:"current"});
                    break;
                }
                case "explorationFlow":
                    await this.prepare(message);
                    break;
                case "explorationStart":
                    await this.start(message);
                    break;
                case "explorationReport":
                    s.exploration = await this.store.load(message.id);
                    s.explorationEvidence = undefined;
                    break;
                case "explorationResume": {
                    await this.store.withWriter(message.id, async () => {
                        const report = await this.store.load(message.id);
                        if (report.status === "paused") {
                            this.requireDevice(report.device);
                            await this.resumeRuleGroup(report);
                            await this.run(report);
                        }
                    });
                    break;
                }
                case "explorationStop": {
                    if (current?.id !== message.id) return;
                    await this.store.withWriter(message.id, async () => {
                        const report = await this.store.load(message.id);
                        if (report.status !== "paused") return;
                        report.status = "stopped";
                        report.reason = this.words("Ended by user.", "用户结束了探索。");
                        finishExplorationBranches(report);
                        s.exploration = report;
                        await this.save(report);
                    });
                    break;
                }
                case "explorationEvidence":
                    await this.evidence(message);
                    break;
                case "explorationSave":
                    await this.exportFinding(message);
                    break;
                case "explorationCase":
                    if (!s.caseReview && s.exploration?.id === message.id) this.reviewCase(s.exploration,message);
                    break;
                case "explorationTriage":
                case "explorationRecheck":
                    await this.updateFinding(message);
                    break;
            }
            s.explorationCaseRoutes = caseRoutes(s.exploration);
        });
    }

    reviewCase(report,message) {
        const candidate = explorationCandidate(report,message);
        if (!candidate) throw new Error(this.words("No confirmed path is available for this result.",
            "这项结果没有可复现的操作路径。"));
        candidate.nodes = async side => {
            const ref = candidate.frames[side];
            if (!ref) return [];
            try {
                const frozen = await this.reportAgent(report).call("inspect",{run_id:ref.runId,frame_id:ref.frame,max_nodes:5000});
                return pageView(frozen,{elements:true})?.nodes.filter(node=>!report.bundle || node.bundle===report.bundle) || [];
            } catch { return []; } // A missing archived frame still permits an explicit control ID.
        };
        this.bench.caseAuthoring.begin(candidate);
    }

    async prepare(message) {
        const { bench, vscode, state } = this;
        let flow, name, sourceUri, scenario;
        const original = state.explorationFlow;
        if (message.source === "text") {
            const description = message.description?.trim();
            if (!description) return;
            state.explorationFlow = undefined;
            const controller = new AbortController();
            this.job = { controller };
            state.explorationWorking = true;
            bench.publish();
            try {
                const ask = await bench.modelAsk(controller.signal);
                let observation;
                if (state.device) {
                    const session = "vscode-flow-" + randomUUID();
                    const agent = bench.agent;
                    const read = async () => {
                        try {
                            return (await agent.call("start", {session, device:state.device, compact:true, max_nodes:240})).observation;
                        } finally { await agent.call("detach", {session}); }
                    };
                    observation = bench.livePanel ? await bench.livePanel.withDeviceOperation(read) : await read();
                }
                controller.signal.throwIfAborted();
                flow = await draftFlow({description, observation, ask, signal:controller.signal, language:bench.language});
                controller.signal.throwIfAborted();
                name = description;
            } catch (error) {
                if (controller.signal.aborted) return;
                throw error;
            } finally {
                this.job = undefined;
                state.explorationWorking = false;
            }
        } else if (message.source === "json") {
            flow = prepareFlow(message.planJson, bench.language);
            name = state.explorationFlow?.name || this.words("Edited flow", "已编辑流程");
        } else {
            let uri;
            if (message.source === "file") {
                [uri] = await vscode.window.showOpenDialog({canSelectMany:false, filters:{JSON:["json"]}}) || [];
                if (!uri) return;
            } else if (message.source === "case") {
                const entry=state.cases.find(item=>item.uri===message.uri);
                if (!entry) throw new Error(this.words("That test case is no longer available.","找不到所选用例。"));
                uri=vscode.Uri.parse(entry.uri);
                name=entry.name;
            } else if (message.source === "current" && state.plan) {
                uri = vscode.Uri.parse(state.plan.uri);
                name=state.plan.name;
            } else throw new Error(this.words("Choose a flow file first.", "请先选择一个流程文件。"));
            sourceUri = uri.toString();
            state.explorationFlow = undefined;
            const document = await vscode.workspace.openTextDocument(uri);
            const file=readWorkflow(document.getText());
            flow = prepareFlow(file.plan, bench.language);
            scenario=file.scenario;
            name ||= path.basename(uri.fsPath);
        }
        state.explorationFlow = { ...flow, id:randomUUID(), name, sourceUri:sourceUri || (message.source === "json" ? original?.sourceUri : undefined),
            source:message.source === "json" ? original?.source : message.source,
            scenario:message.source === "json" ? original?.scenario : scenario,
            description:message.source === "json" ? original?.description : message.description?.trim() };
        const fileFlow = state.explorationFlow;
        fileFlow.ruleGroupName = (fileFlow.scenario || (fileFlow.sourceUri && bench.networks?.bindings?.[fileFlow.sourceUri]))?.name;
    }

    async start(message) {
        const s = this.state;
        this.requireDevice(s.device);
        const guided = message.mode === "flow";
        const source = s.explorationFlow;
        let prepared, checkpoints;
        if (guided) {
            if (!source || (message.flowId && source.id !== message.flowId)) {
                throw new Error(this.words("Review the flow before starting.", "请先核对流程再开始。"));
            }
            prepared = prepareFlow(message.planJson ?? source.plan, this.bench.language);
            checkpoints = message.checkpoints ?? prepared.defaultCheckpoints;
            const eligible = new Set(prepared.checkpoints.map(c => c.index));
            if (!Array.isArray(checkpoints) || !checkpoints.length || checkpoints.some(i => !eligible.has(i))) {
                throw new Error(this.words("Choose an exploration checkpoint in this flow.", "请在当前流程中选择要探索的步骤。"));
            }
        }
        const focus = message.focus?.trim() || (guided ? source.name : this.words("Explore this app", "从当前页探索"));
        const report = createExploration({ device:s.device, mode:guided ? "flow" : "free", goal:focus,
            plan:prepared?.plan, checkpoints, maxInputs:message.maxActions, maxMinutes:message.maxMinutes,
            language:this.bench.language, source:guided ? source.name : undefined });
        report.evidenceDir = this.bench.stateDir;
        const bound = guided && (source.scenario || (source.sourceUri && this.bench.networks?.bindings?.[source.sourceUri]));
        if (message.ruleGroupId) {
            const n = s.network;
            if (bound || !n?.scenario || n.activeScenarioId !== message.ruleGroupId || n.scenarioVersion !== message.ruleGroupVersion) {
                throw new Error(this.words("The rule group changed. Reopen exploration setup to review it.", "规则组已更改，请重新打开探索设置核对。"));
            }
            report.mockScenario = await this.bench.prepareFlowScenario(undefined,structuredClone(n.scenario));
        } else if (guided && source.sourceUri) {
            report.mockScenario = await this.bench.prepareFlowScenario?.({uri:source.sourceUri},source.scenario);
        }
        await this.store.withWriter(report.id, () => this.run(report));
    }

    requireDevice(device) {
        if (!device || this.state.device !== device || !this.state.devices.includes(device)) {
            throw new Error(this.words("Connect and select the phone used for this exploration.", "请连接并选中本次探索使用的手机。"));
        }
    }

    async resumeRuleGroup(report) {
        if (!report.mockScenario) return;
        const n = this.state.network, saved = report.ruleGroupProgress;
        const live = n?.running && n.mappedDevice === report.device &&
            isDeepStrictEqual({...n.scenario,name:report.mockScenario.name}, report.mockScenario);
        if (live && saved && isDeepStrictEqual(n.hits,saved)) return;
        const sequence = !report.mockScenario.paused && report.mockScenario.rules.some(rule=>rule.enabled!==false && rule.steps?.length>1);
        if (sequence && (!saved || report.pending)) {
            throw new Error(this.words("The previous sequence position cannot be confirmed. End this exploration and start a new one.",
                "无法确认上次顺序响应的位置。请结束本轮探索后重新开始。"));
        }
        await this.bench.prepareFlowScenario(undefined,report.mockScenario,undefined,saved);
    }

    reportAgent(report) {
        const agent = this.bench.agent;
        if (report.evidenceDir) agent.stateDir = report.evidenceDir;
        return agent;
    }

    deviceAgent(report) {
        const runtime = this.reportAgent(report);
        return { call: (cmd,input) => {
            const work = () => runtime.call(cmd,input);
            const panel = this.bench.livePanel;
            return panel ? panel.withDeviceOperation(work) : work();
        } };
    }

    async run(report) {
        this.requireDevice(report.device);
        const s = this.state, bench = this.bench;
        if (!bench.panel) return;
        const controller = new AbortController();
        this.job = { id:report.id, controller };
        s.exploration = report;
        s.explorationEvidence = s.page = s.liveImage = undefined;
        s.explorationWorking = true;
        bench.publish();
        try {
            // Acquire the model only when the exploration actually needs a decision.
            let provider;
            const ask = async (prompt, signal) => {
                provider ??= bench.modelAsk(controller.signal);
                return (await provider)(prompt, signal);
            };
            await runExploration({ report, agent:this.deviceAgent(report), ask, signal:controller.signal,
                workbenchSession:bench.sessionFor(report.device), onUpdate: () => {
                    if (report.mockScenario && !report.pending && s.network?.running && s.network.mappedDevice === report.device)
                        report.ruleGroupProgress = s.network.hits.map(hit=>({...hit}));
                    return this.save(report);
                } });
        } catch (error) {
            report.status = controller.signal.aborted ? controller.signal.reason === "stop" ? "stopped" : "paused" : "blocked";
            report.reason = controller.signal.aborted ? this.words("Interrupted by user.", "用户中断了探索。") : bench.errorMessage(error);
            finishExplorationBranches(report);
            await this.save(report);
        } finally {
            this.job = undefined;
            s.explorationWorking = false;
        }
    }

    async evidence({id,stepId,receiptIndex,phase}) {
        const report = this.state.exploration;
        if (id !== report?.id || !["before","after"].includes(phase)) return;
        const step = report.steps.find(s => s.id === stepId);
        const receipt = Number.isInteger(receiptIndex) ? step?.receipts?.[receiptIndex] : step;
        if (!step?.runId || !receipt?.[phase]) return;
        this.state.explorationEvidence = undefined;
        const frozen = await this.reportAgent(report).call("inspect", {run_id:step.runId, frame_id:receipt[phase], max_nodes:180});
        this.state.explorationEvidence = {id,stepId,receiptIndex,phase,page:pageView(frozen)};
    }

    async updateFinding(message) {
        const {id,findingId} = message;
        if (this.state.exploration?.id !== id) return;
        await this.store.withWriter(id,async () => {
            const report = await this.store.load(id);
            const finding = report.findings.find(item => item.id === findingId);
            if (!finding || report.status === "running") return;
            this.state.exploration = report;
            if (message.type === "explorationTriage") {
                if (finding.kind !== "review" || !["open","ignored"].includes(message.reviewStatus)) return;
                finding.reviewStatus = message.reviewStatus;
                finding.note = String(message.note || "").trim();
                await this.save(report);
                return;
            }
            if (!["completed","stopped","blocked"].includes(report.status) || !canRecheck(finding)) return;
            this.requireDevice(report.device);
            const controller = new AbortController();
            this.job = {id,controller};
            this.state.explorationWorking = true;
            this.bench.publish();
            try {
                await recheckFinding({report,findingId,device:report.device,agent:this.deviceAgent(report),
                    prepareRuleGroup:scenario=>this.bench.prepareFlowScenario(undefined,scenario),
                    signal:controller.signal,workbenchSession:this.bench.sessionFor(report.device),onUpdate:() => this.save(report)});
            } finally {
                this.job = undefined;
                this.state.explorationWorking = false;
            }
        });
    }

    async exportFinding({id,findingId}) {
        const report = this.state.exploration;
        if (id !== report?.id) return;
        const finding = report.findings.find(item => item.id === findingId);
        const plan = finding && regressionPlan(finding);
        if (!plan) return;
        const { vscode } = this;
        const folder = vscode.workspace.workspaceFolders?.[0];
        const uri = await vscode.window.showSaveDialog({filters:{JSON:["json"]},
            defaultUri:folder && vscode.Uri.joinPath(folder.uri,"exploration-regression.plan.json")});
        if (!uri) return;
        const file = report.mockScenario ? workflowWithScenario(plan,report.mockScenario) : plan;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(file,null,2)+"\n"));
        await this.bench.setPlan(uri);
    }
}

module.exports = { ExplorationController };
