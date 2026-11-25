"use strict";

const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { ExplorationStore, summary } = require("./explorationStore");
const { createExploration, runExploration, finishExplorationBranches } = require("./explorationEngine");
const { draftFlow, regressionPlan, checkpointDetails } = require("./explorationFlow");
const { prepareCaseFlow,timelinePrefix } = require("./caseExplorationTimeline");
const { readCaseMetadata } = require("./caseLibrary");
const { authoredDocument } = require("./caseComposition");
const { sourceDigest } = require("./caseRepair");
const { canRecheck, recheckFinding } = require("./explorationRecheck");
const { caseRoutes, explorationCandidate, forkSourceSnapshot } = require("./explorationCases");
const { pageView } = require("./model");
const { readWorkflow, workflowWithScenario, requireExecutableWorkflow } = require("./workflowFile");

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
        const localSource=message.type==="explorationFlow" && ["current","case","file","json"].includes(message.source);
        if (s.busy || this.job || (s.draft && !localSource)) return;
        return this.bench.perform(async () => {
            if (!s.draft && message.type!=="explorationFromCase") s.mode = "exploration";
            switch (message.type) {
                case "explorationNew":
                case "explorationFromCase":
                case "explorationOpen": {
                    if (message.type === "explorationFromCase") {
                        await this.prepare({...message,source:"current"});
                        s.tool=s.mode="exploration";
                    }
                    if (message.type !== "explorationOpen") s.exploration = s.explorationEvidence = s.explorationSourceIssue = undefined;
                    if (message.type === "explorationNew") s.explorationFlow = this.flowDocument = undefined;
                    await this.history();
                    break;
                }
                case "explorationFlow":
                    try { await this.prepare(message); }
                    catch (error) {
                        const missingFile=["ENOENT","FileNotFound"].includes(error.code);
                        const reason = missingFile ? this.words("The case file was not found. Choose another case or load its new file.",
                            "找不到用例文件。请选择其他用例，或从新位置导入文件。") : error instanceof SyntaxError ?
                            this.words("Choose a valid workflow JSON file.","请选择有效的流程 JSON 文件。") : error.message;
                        if (message.source==="case" || message.source==="current") {
                            this.flowDocument=undefined;
                            const entry=message.source==="current" ? s.plan : s.cases?.find(item=>item.uri===message.uri);
                            s.explorationFlow={id:randomUUID(),source:message.source,sourceUri:entry?.uri ?? message.uri,
                                name:entry?.name || this.words("Selected case","所选用例"),checkpoints:[],blockedReason:reason,missingFile};
                        } else s.explorationSourceIssue=reason;
                    }
                    break;
                case "explorationStart":
                    await this.start(message);
                    break;
                case "explorationOpenSourceCase":
                    if (message.uri && message.uri===s.explorationFlow?.sourceUri) {
                        await this.bench.openCase(message.uri);
                        await this.bench.openTool("recordings");
                    }
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
        },{runtime:!(["explorationNew","explorationOpen","explorationFromCase","explorationReport","explorationCase","explorationOpenSourceCase"].includes(message.type) ||
            (message.type==="explorationFlow" && message.source!=="text"))});
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
        let flow, name, sourceUri, sourceCase, sourceDocument, externalScenario = false;
        const original = state.explorationFlow;
        state.explorationSourceIssue = undefined;
        if (message.source === "text") {
            const description = message.description?.trim();
            if (!description) return;
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
                flow = prepareCaseFlow(flow.plan,bench.language);
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
            flow = prepareCaseFlow(message.planJson, bench.language);
            name = original?.name || this.words("Edited flow", "已编辑流程");
            externalScenario = original?.externalScenario;
            if (isDeepStrictEqual(flow.plan,original?.plan)) {
                sourceCase = original.sourceCase;
                sourceUri = original.sourceUri;
                if (this.flowDocument?.id===original.id) sourceDocument=this.flowDocument.document;
                flow = prepareCaseFlow(flow.plan,bench.language,sourceDocument,{trustedCase:Boolean(sourceCase)});
            }
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
                if (message.uri && message.uri !== state.plan.uri) throw new Error(this.words(
                    "The selected case changed. Choose the step again.","当前用例已更换，请重新选择步骤。"));
                uri = vscode.Uri.parse(state.plan.uri);
                name=state.plan.name;
            } else throw new Error(this.words("Choose a flow file first.", "请先选择一个流程文件。"));
            sourceUri = uri.toString();
            const document = await vscode.workspace.openTextDocument(uri);
            const contents = document.getText(), digest = sourceDigest(contents);
            if (message.digest && message.digest !== digest) throw new Error(this.words(
                "The case has changed. Choose the step again.","用例已修改，请重新选择步骤。"));
            const file=readWorkflow(contents);
            requireExecutableWorkflow(file,bench.language);
            const entry = state.cases?.find(item=>item.uri===sourceUri);
            const metadata = await readCaseMetadata(uri);
            const authored = authoredDocument(file,metadata);
            sourceDocument=authored;
            if (entry) sourceCase = {uri:sourceUri,...(entry.portableId && {id:entry.portableId}),digest,
                ...(!entry.editable && {editable:false})};
            flow = prepareCaseFlow(file.plan, bench.language,authored,{trustedCase:Boolean(sourceCase)});
            externalScenario = Boolean(file.scenario || bench.networks?.bindings?.[sourceUri]);
            name ||= metadata?.name || path.basename(uri.fsPath);
        }
        if (message.checkpoint !== undefined) {
            const point=flow.checkpoints.find(point=>point.index===message.checkpoint);
            if (point?.blockedReason) throw new Error(point.blockedReason);
            if (!point) throw new Error(this.words(
                "This position is unavailable. Choose a position from the current case.",
                "这个位置暂不支持探索，请从当前用例重新选择位置。"));
            flow.defaultCheckpoints = [message.checkpoint];
        }
        state.explorationFlow = { ...flow, sourceCase, externalScenario, id:randomUUID(), name, sourceUri,
            source:message.source === "json" && (sourceUri || original?.source==="text") ? original?.source : message.source,
            description:message.source === "json" ? original?.description : message.description?.trim() };
        this.flowDocument=sourceDocument ? {id:state.explorationFlow.id,document:sourceDocument} : undefined;
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
            if (source.blockedReason) throw new Error(source.blockedReason);
            const document=this.flowDocument?.id===source.id ? this.flowDocument.document : undefined;
            prepared = prepareCaseFlow(message.planJson ?? source.plan,this.bench.language,document,{trustedCase:Boolean(source.sourceCase)});
            if (!isDeepStrictEqual(prepared.plan,source.plan)) throw new Error(this.words(
                "Apply your flow changes before starting.","请先应用流程修改，再开始探索。"));
            if (prepared.blockedReason) throw new Error(prepared.blockedReason);
            checkpoints = message.checkpoints ?? source.defaultCheckpoints;
            const point=Array.isArray(checkpoints) && checkpoints.length===1 && prepared.checkpoints.find(c=>c.index===checkpoints[0]);
            if (!point || point.blockedReason) {
                throw new Error(point?.blockedReason || this.words("Choose one starting position in this case.", "请为本轮探索选择一个分叉位置。"));
            }
            await this.bench.requireGestureRuntime?.(timelinePrefix(prepared.plan,point.index));
        }
        const focus = message.focus?.trim() || (guided ? source.name : this.words("Explore this app", "从当前页探索"));
        const report = createExploration({ device:s.device, mode:guided ? "flow" : "free", goal:focus,
            plan:prepared?.plan, checkpoints, maxInputs:message.maxActions, maxMinutes:message.maxMinutes,
            language:this.bench.language, source:guided ? source.name : undefined });
        if (guided) {
            report.routeMode="fork";
            report.checkpointLayout="rows";
            if (this.flowDocument?.id===source.id) report.forkSource=forkSourceSnapshot(this.flowDocument.document,checkpoints[0],report.checkpointLayout);
            report.checkpointDetails = checkpointDetails(prepared,checkpoints);
            if (source.sourceCase) report.sourceCase = source.sourceCase;
        }
        report.evidenceDir = this.bench.stateDir;
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
        return { call: (cmd,input,options) => {
            const work = () => runtime.call(cmd,input,options);
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
            if (report.status === "running") return;
            if (message.type === "explorationTriage") {
                if (!["open","ignored"].includes(message.reviewStatus)) return;
                const batch=Array.isArray(message.findingIds);
                const ids=new Set(batch ? message.findingIds : [findingId]);
                const findings=report.findings.filter(item=>item.kind==="review" && ids.has(item.id));
                if (!findings.length || findings.length!==ids.size) return;
                for (const item of findings) {
                    item.reviewStatus=message.reviewStatus;
                    if (!batch) item.note=String(message.note || "").trim();
                }
                this.state.exploration = report;
                await this.save(report);
                return;
            }
            const finding = report.findings.find(item => item.id === findingId);
            if (!["completed","stopped","blocked"].includes(report.status) || !canRecheck(finding)) return;
            this.state.exploration = report;
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
