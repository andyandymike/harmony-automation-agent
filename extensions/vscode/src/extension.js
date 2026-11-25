"use strict";

const path = require("node:path");
const {tmpdir} = require("node:os");
const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const vscode = require("vscode");
const { AgentClient } = require("./agent");
const { ProjectRuntime, projectHdc, pythonPath } = require("./projectRuntime");
const { pageView, recordedPlan, moveListItem, runView, withAuthoredTargets, compareRuns, deviceRecordingFormat } = require("./model");
const { summarizePlan, caseExplorationCheckpoints } = require("./planSummary");
const { startRecorder, replayGesture, validateRecording } = require("./deviceRecorder");
const { controlCommands, controlTarget, phoneControlStep, scrollDirection, boundaryControls } = require("./controlRecording");
const { LiveDevicePanel } = require("./liveDevicePanel");
const { liveDeviceMarkup, phoneTaskMarkup } = require("./liveDeviceMarkup");
const { registerCopilotMcp } = require("./aiIntegration");
const { askAI } = require("./aiHandoff");
const { runPhoneTask, explainRun } = require("./aiTasks");
const { localRequests, explainExchange } = require("./aiEvidence");
const { askCodex } = require("./codexTask");
const { createCopilotAsk } = require("./copilotTask");
const { suggestRecordingCheck } = require("./recordingCheck");
const { ExplorationController } = require("./explorationController");
const { ElementsController } = require("./elementsController");
const { NetworkController } = require("./networkController");
const { readWorkflow, requireExecutableWorkflow } = require("./workflowFile");
const { hasRuleSteps, validateRuleStep, saveRulePlanForRun } = require("./caseRuleSteps");
const { runCasePlan } = require("./workflowWorker");
const { readiness, safeCaseName, writeCase, findCase, startPytest } = require("./pytestCase");
const { CaseLibrary, createBdd, readCaseMetadata } = require("./caseLibrary");
const { restorePresentation, pageCue, stepEvidence, pendingCaseWork } = require("./casePresentation");
const { CaseAuthoring, caseDefinitions, canEditCase } = require("./caseAuthoring");
const { CaseCompositionEditor } = require("./caseCompositionEditor");
const { authoredDocument, hasGestures } = require("./caseComposition");
const { loadPytestRun } = require("./pytestReport");
const { journalPath, readSummaryRecord, withRunReceipts, watchRunJournal } = require("./runProgress");
const { CaseRepair, sourceDigest } = require("./caseRepair");
const { reviewCaseFailure } = require("./caseFailure");
const { diagnoseCase } = require("./caseDiagnosis");
const { workspaceTools, selectedWorkspaceTab, registerWorkbenchLauncher } = require("./workbenchTools");
const { FlowDebugger } = require("./flowDebug");
const { exportProblemClip, openProblemClip } = require("./problemExport");
const { CaseRunReports, archivedRunPlan } = require("./caseRunReport");
const { TestRunOverviewPanel } = require("./testRunOverviewPanel");
const { messagesFor } = require("./strings");

const observationOptions = { max_nodes: 240, compact: true };
const controlTreeOptions = { max_nodes: 5000, compact: false };
const planFilters = { JSON: ["json"] };
const containsPath = (parent, file) => {
    const relative = path.relative(parent,file);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const providerSetupErrors = new Set(["COPILOT_UNSUPPORTED", "COPILOT_UNAVAILABLE", "COPILOT_DENIED", "CODEX_NOT_FOUND", "CODEX_VERSION"]);
const recordingViews = new Set(["recordings", "workflow", "run", "history"]);
const toolMessages = new Map([
    ["openRecordingWorkspace", "recordings"], ["inspect", "inspect"], ["inspectDevice", "inspect"], ["networkOpen", "network"],
]);
const networkDeviceActions = new Set(["networkNative", "networkNativeChoose", "networkNativeTimed", "networkMap",
    "networkStep", "networkExplorationStep"]);
const localCaseActions = new Set(["openPlan", "editPlan", "caseOpen", "caseNew", "caseReview", "caseDuplicate", "caseRemove", "caseHideSelected", "caseRestore",
    "caseCancel", "caseMoveStep", "caseStepAction", "caseEdit", "caseSave", "caseTargets", "openPytest", "repairApply", "repairDraft",
    "moveRecordedStep", "removeStep", "removeRecordedSteps", "undoRecordedRemoval", "report", "step"]);

class Workbench {
    constructor(context) {
        this.context = context;
        this.storage = context.storageUri || context.globalStorageUri;
        this.workspaceStateDir = path.join(this.storage.fsPath, "agent");
        this.pytestArtifactDir = path.join(this.storage.fsPath,"pytest-artifacts");
        const shared = this.config.get("stateDir");
        this.stateDir = shared && path.isAbsolute(shared) ? path.normalize(shared) : this.workspaceStateDir;
        if (shared && !path.isAbsolute(shared)) void vscode.window.showWarningMessage(this.text.aiAbsoluteState);
        const plan = context.workspaceState.get("plan");
        this.state = {
            mode: plan ? "workflow" : "recordings",
            tool: "recordings",
            devices: [],
            runs: context.workspaceState.get("runs", []).map(entry =>
                entry.status === "running" ? { ...entry, status: "unknown" } : entry),
            plan,
            error: "",
            actions: [],
            aiResults: {},
            explorationHistory: [],
            cases: [],
        };
        this.caseLibrary = new CaseLibrary(vscode, context);
        this.caseAuthoring = new CaseAuthoring(this, vscode);
        this.composition = new CaseCompositionEditor(this,vscode);
        const caseFiles = vscode.workspace.createFileSystemWatcher("**/{workflow.json,*.harmony-case.json}");
        const caseChanged = uri => {
            if (!this.panel || !vscode.workspace.getWorkspaceFolder(uri)) return;
            clearTimeout(this.caseRefreshTimer);
            const renew = async () => {
                if (!this.panel) return;
                if (this.state.busy) { this.caseRefreshTimer=setTimeout(renew,300); return; }
                try {
                    await this.loadTestLibrary(this.panel);
                    const draft = this.caseAuthoring.candidate;
                    if (draft) {
                        await this.composition.refreshFor(draft.plan);
                        if (this.caseAuthoring.candidate===draft) {
                            this.caseAuthoring.update();
                            this.composition.refresh();
                            this.publish();
                        }
                    }
                } catch { /* The regular library refresh reports its own read error. */ }
            };
            this.caseRefreshTimer=setTimeout(renew,180);
        };
        context.subscriptions.push(caseFiles,caseFiles.onDidChange(caseChanged),caseFiles.onDidCreate(caseChanged),caseFiles.onDidDelete(caseChanged),
            {dispose:()=>clearTimeout(this.caseRefreshTimer)});
        this.caseRepair = new CaseRepair(this, vscode);
        this.explorations = new ExplorationController(this, vscode);
        this.elements = new ElementsController(this, vscode);
        this.networks = new NetworkController(this, vscode);
        this.flowDebugger = new FlowDebugger(this, vscode);
        this.caseRunReports = new CaseRunReports(this, vscode);
        this.testRunOverview = new TestRunOverviewPanel(this,vscode);
        context.subscriptions.push(this.caseRunReports,this.testRunOverview);
        this.recordingView = this.state.mode;
        this.projectRuntime = new ProjectRuntime(vscode, context, () => this.language, () =>
            this.runtimeOperation || this.state.recording || this.networks.activeCapture || this.closingRuntime);
        context.subscriptions.push(this.projectRuntime.onDidChange((next, previous) => {
            if (this.deviceLookup?.runtime) this.cancelDeviceLookup();
            this.state.device = undefined;
            this.state.deviceDisconnected = false;
            this.state.devices = [];
            this.caseAuthoring.invalidateLiveTargets();
            this.state.deviceLookupError = undefined;
            this.state.page = this.state.liveImage = undefined;
            this.state.actions = [];
            if (this.state.error === previous.error || previous.runtime || next.runtime) this.state.error = "";
            this.livePanel?.runtimeChanged();
            void this.elements.sync();
            if (this.networks.mapping) {
                this.networks.retireMapping();
                this.networks.changed();
            }
            this.publish();
        }));
    }

    get config() {
        return vscode.workspace.getConfiguration("harmonyAgent");
    }

    get language() {
        const configured = this.config.get("language", "auto");
        return configured === "auto" ? vscode.env.language : configured;
    }

    get text() {
        return messagesFor(this.language);
    }

    get agent() {
        const runtime = this.projectRuntime.configuration;
        return new AgentClient({
            executable: runtime?.python || this.config.get("cliPath") || process.env.HARMONY_AGENT_CLI || "harmony-agent",
            ...(runtime && { prefix: [runtime.cli], env: { ...process.env, PYTHONPATH: pythonPath(runtime) },
                verify: () => this.projectRuntime.verifyPython(runtime) }),
            hdcPath: runtime?.hdc || this.config.get("hdcPath"),
            stateDir: this.stateDir,
        });
    }

    get session() {
        return this.sessionFor(this.state.device);
    }

    get recordingControls() {
        const {recording, draft} = this.state;
        return recording && draft?.location !== "phone" && draft?.stepFormat === "controls";
    }

    get fullControlTree() {
        return this.recordingControls || this.state.tool === "inspect";
    }

    get pageOptions() {
        return this.fullControlTree ? controlTreeOptions : observationOptions;
    }
    prepareFlowScenario(planRef,scenario,id,savedHits) { return this.networks.prepareFlow(planRef,scenario,id,savedHits); }

    sessionFor(device) {
        const hash = createHash("sha256").update(this.workspaceStateDir + "\0" + device);
        if (this.projectRuntime.current.runtime) hash.update("\0" + JSON.stringify(this.projectRuntime.current.runtime));
        const id = hash.digest("hex").slice(0, 24);
        return "vscode-" + id;
    }

    open() {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
        const panel = vscode.window.createWebviewPanel("harmonyAgent.workbench", "Harmony Agent", vscode.ViewColumn.Active, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [media, vscode.Uri.file(this.stateDir), vscode.Uri.file(this.pytestArtifactDir)],
        });
        this.panel = panel;
        const webview = panel.webview;
        const resource = name => webview.asWebviewUri(vscode.Uri.joinPath(media, name));
        const live = this.livePanel = new LiveDevicePanel(this, panel);
        let initialized = false;
        webview.onDidReceiveMessage(async message => {
            if (this.panel !== panel) return;
            if (message.type === "ready") {
                if (message.channel === "live") live.ready = true;
                this.publish();
                if (!initialized) {
                    initialized = true;
                    if (!this.state.draft) await Promise.all([this.loadTestLibrary(panel), this.listDevices()]);
                }
            } else if (message.type === "workspaceTab") {
                await this.openTool(message.view);
            } else if (message.type === "devices") {
                await this.listDevices();
            } else if (message.type.startsWith("exploration")) {
                const fromTests=this.state.tool==="recordings" && !this.state.caseReview && !this.state.draft;
                if (["explorationReport","explorationNew"].includes(message.type) && fromTests)
                    this.state.tool = "exploration";
                if (this.state.tool !== "exploration" && !(fromTests && message.type==="explorationFromCase")) return;
                await this.explorations.handle(message);
            } else if (toolMessages.has(message.type) ||
                    (message.type === "view" && message.view === "inspect")) {
                await this.openTool(message.type === "view" ? "inspect" : toolMessages.get(message.type));
            } else if (message.type.startsWith("element")) {
                await this.perform(() => this.elements.handle(message),{
                    runtime:!["elementCopySelected","elementUnwatchSelected","elementRemoveSelected","elementUndoRemoval"].includes(message.type)});
            } else if (message.type === "networkNativeStop" || message.type === "networkCopyRetained") {
                // Stopping the recorder and copying archived data also work during a phone action.
                try { await this.networks.handle(message); }
                catch (error) { this.networks.showError(error); }
            } else if (message.type.startsWith("network")) {
                await this.perform(() => this.networks.handle(message), {runtime:networkDeviceActions.has(message.type)});
            } else if (message.type.startsWith("flowDebug")) {
                await this.flowDebugger.handle(message);
            } else if (message.type === "stopRun") {
                if (this.state.run?.entry.id === message.id && this.state.run.canStop) {
                    this.state.run.canStop = false;
                    this.nativeReplay?.abort();
                    this.publish();
                }
            } else if (message.type === "problemExport") {
                await this.perform(() => exportProblemClip(this,vscode,message));
            } else if (message.type === "caseFullReport") {
                await this.caseRunReports.open(message.id,message.index);
            } else if (message.type === "caseExportReport") {
                await this.caseRunReports.export(message.id);
            } else if (message.type === "testRunOverview") {
                await this.testRunOverview.open();
            } else if (message.channel === "live") {
                await live.receive(message);
            } else if (message.type === "liveDevice") {
                this.openLiveDevice();
            } else if (message.type === "askAI") {
                this.openTask();
            } else if (message.type === "explainExchange" && typeof message.id === "string" && this.state.tool === "network") {
                await this.runAI("exchange",undefined,false,message.id);
            } else if (message.type === "diagnoseFailure") {
                const run = this.state.run;
                const failure = reviewCaseFailure(run);
                if (failure && this.state.tool === "recordings" && this.state.mode === "run" && run.entry.id === message.id) {
                    const useLive = message.phase==="live" && failure.kind==="locator" && this.state.devices.includes(this.state.device);
                    await this.runAI("diagnosis", this.text.aiFailureTask, false, undefined, failure, useLive);
                }
            } else if (message.type === "explainStep" || message.type === "suggestCheck") {
                if (message.type === "suggestCheck") await this.runAI("check");
                else if (!message.id || (message.id === this.state.run?.entry?.id && message.index === this.state.run.selected)) {
                    const run = this.state.run, failure = reviewCaseFailure(run);
                    const goal = typeof message.goal === "string" ? message.goal.trim().slice(0,1200) : undefined;
                    await this.runAI("diagnosis",goal,false,undefined,failure?.index===run?.selected ? failure : undefined);
                }
            } else if (message.type === "cancelAI") {
                this.cancelAI();
            } else if (message.type === "aiProvider") {
                await this.setAIProvider(message.provider);
            } else if (message.type === "projectRuntime") {
                await this.chooseProjectRuntime();
            } else if (message.type === "settings" || message.type === "aiSettings") {
                const query = message.type === "aiSettings" ? "@id:harmonyAgent.aiProvider" : "harmonyAgent";
                await vscode.commands.executeCommand("workbench.action.openSettings", query);
            } else if (message.type === "view") {
                await this.revealView(message.view);
            } else if (message.type === "caseOrganize") {
                await this.caseAuthoring.organize(message);
            } else if (message.type === "caseOrganizeCancel") {
                if (message.id) this.caseAuthoring.stopOrganizing(message.id);
                this.publish();
            } else if (message.type === "caseEndPick") {
                if (this.caseAuthoring.endPick(message)) this.publish();
            } else if (message.type === "caseComposeCancel") {
                this.composition.cancelJob();
            } else if (message.type === "caseInsert") {
                await this.composition.requestInsertion(message,result=>{
                    if (this.panel===panel) void webview.postMessage({type:"caseInsert",action:message.action,
                        session:message.session,sourceId:message.sourceId,request:message.request,...result});
                });
            } else if (message.type === "caseCompose") {
                await this.perform(()=>this.composition.handle(message),{
                    runtime:["runExplore","verifyUpdate","revisionRun","revisionVerify"].includes(message.action)});
            } else {
                await this.perform(() => this.dispatch(message), {runtime:!localCaseActions.has(message.type) || Boolean(message.fromRun) ||
                    (message.type === "caseTargets" && message.live === true)});
                if (message.type==="caseOpen" && message.preview && this.panel===panel)
                    void webview.postMessage({type:"caseLibraryPreviewed",id:message.id});
            }
        });
        panel.onDidChangeViewState(() => {
            live.sync();
            if (panel.visible && !this.state.draft) void this.refreshPlanSummary();
        });
        panel.onDidDispose(() => {
            if (this.panel !== panel) return;
            this.panel = this.livePanel = undefined;
            this.cancelDeviceLookup();
            this.planRead = undefined;
            this.planWatch?.dispose();
            this.planWatch = this.watchedUri = undefined;
            this.cancelAI();
            this.caseAuthoring.stopOrganizing();
            this.caseAuthoring.endPick();
            this.composition.cancelJob();
            this.composition.cancelInsertionIndex();
            this.explorations.cancel("pause");
            this.flowDebugger.stop();
            this.nativeReplay?.abort();
            const nativeCaptureDone = this.networks.finishNative();
            const currentAction = this.pendingAction;
            const previousClose = this.closingLive;
            const closing = async () => {
                // Retire the screen immediately. Finish acknowledged work before freezing the draft.
                await Promise.all([live.stop(), previousClose, currentAction?.catch(() => {}), nativeCaptureDone]);
                if (this.networks.activeCapture) await this.networks.finishNative();
                if (this.state.recording) await this.stopRecording();
            };
            const closeLock = this.closingRuntime = Symbol();
            this.closingLive = closing().catch(error => { this.state.error = this.errorMessage(error); })
                .finally(() => {
                    if (this.closingRuntime === closeLock) this.closingRuntime = undefined;
                    this.publish();
                });
        });
        webview.html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource};">
<link rel="stylesheet" href="${resource("workbench.css")}"><link rel="stylesheet" href="${resource("liveDevice.css")}"><link rel="stylesheet" href="${resource("workspaceRail.css")}"><link rel="stylesheet" href="${resource("elements.css")}">
<link rel="stylesheet" href="${resource("network.css")}"><link rel="stylesheet" href="${resource("networkEditor.css")}"><link rel="stylesheet" href="${resource("networkScenarios.css")}">
<link rel="stylesheet" href="${resource("ui/components.css")}"><link rel="stylesheet" href="${resource("ui/disclosure.css")}"><link rel="stylesheet" href="${resource("ui/fieldEditor.css")}"><link rel="stylesheet" href="${resource("caseLibrary.css")}"><link rel="stylesheet" href="${resource("caseInsert.css")}"><link rel="stylesheet" href="${resource("exploration.css")}"><title>Harmony Agent</title></head>
<body><div id="app-shell"><header id="station-header"></header><div id="tool-navigation"></div><main id="station-body">
<aside id="live-device" aria-labelledby="live-title">${liveDeviceMarkup()}</aside>
<div id="tool-pane"><div id="tool-content" role="tabpanel" tabindex="0">
<div id="workbench"></div>${phoneTaskMarkup()}</div></div></main></div>
<script type="module" src="${resource("workbench.js")}"></script><script type="module" src="${resource("liveDevice.js")}"></script></body></html>`;
    }

    async openAI(surface) {
        try {
            await askAI(vscode, this, surface);
        } catch (error) {
            void vscode.window.showErrorMessage(this.errorMessage(error));
        }
    }

    async chooseProjectRuntime() {
        try {
            if (await this.projectRuntime.choose() && this.panel && !this.state.busy && !this.state.recording && !this.networks.activeCapture)
                await this.listDevices();
        }
        catch (error) { void vscode.window.showErrorMessage(this.errorMessage(error)); }
    }

    async openTask() {
        await this.openTool("exploration");
        if (!this.livePanel || this.state.tool !== "exploration") return;
        this.livePanel.focusTask = true;
        this.livePanel.sync();
    }

    async setAIProvider(provider) {
        if (this.aiJob || !["codex", "copilot"].includes(provider)) return;
        try {
            await this.config.update("aiProvider", provider, vscode.ConfigurationTarget.Global);
        } catch (error) {
            void vscode.window.showErrorMessage(error.message);
        }
        this.publish();
    }

    get aiProvider() { return this.config.get("aiProvider", "copilot"); }

    async modelAsk(signal, onRetry) {
        if (this.aiProvider === "codex") {
            return (prompt, roundSignal) => askCodex({ prompt, signal: roundSignal ? AbortSignal.any([signal, roundSignal]) : signal,
                executable:this.config.get("codexPath"), onRetry });
        }
        return createCopilotAsk(vscode, {signal, language:this.language});
    }

    async readRepairObservation(device, signal) {
        await this.closingLive;
        await this.projectRuntime.ready(false,true);
        const agent = this.agent, session = this.session;
        const read = async () => {
            signal.throwIfAborted();
            try { return await agent.call("observe",{session,...controlTreeOptions}); }
            catch (error) { if (error.code!=="NO_SESSION") throw error; }
            const probe = "workbench-repair-"+randomUUID();
            try {
                signal.throwIfAborted();
                const result = await agent.call("start",{device,session:probe,...controlTreeOptions});
                return result.observation;
            } finally {
                await agent.call("detach",{session:probe}).catch(error=>{
                    if (error.code!=="NO_SESSION") this.state.error = this.errorMessage(error);
                });
            }
        };
        return this.livePanel ? this.livePanel.withDeviceOperation(read) : read();
    }

    runAI(kind, goal, readOnly = false, exchangeId, failure, useLive = false) {
        if (this.aiJob || this.state.busy) return;
        const { device, draft, recording, run } = this.state;
        if (kind === "phone" && (!device || draft || !goal?.trim())) return;
        if ((kind === "diagnosis" && !run?.entry) || (kind === "check" && (recording || draft?.stepFormat !== "controls"))) return;
        const controller = new AbortController();
        const job = this.aiJob = { kind, controller };
        const key = kind === "exchange" ? exchangeId : kind === "diagnosis" ? run.entry.id + "/" + (failure ? "failure" : run.selected) : device;
        const result = this.state.aiResults[kind] = { key, goal, provider: this.aiProvider, status: "running", steps: [] };
        if (kind === "phone") {
            this.aiDraft = undefined;
            if (!readOnly) this.state.page = this.state.liveImage = undefined;
        }
        const { signal } = controller;
        const baseline = failure && this.baseline();
        job.done = this.perform(async () => {
            try {
                let requestModel;
                const ask = async prompt => {
                    requestModel ??= await this.modelAsk(signal, () => { result.waitingForModel = "retry"; this.publish(); });
                    signal.throwIfAborted();
                    result.waitingForModel = true;
                    this.publish();
                    try {
                        return await requestModel(prompt);
                    } finally {
                        result.waitingForModel = false;
                    }
                };
                const onEvent = ({ type, text, receipt }) => {
                    if (signal.aborted) return;
                    if (type === "step") result.steps.push(text);
                    if (type === "evidence") (result.evidence ||= []).push({...receipt,text});
                    if (type === "answer") result.answer = text;
                    this.publish();
                };
                const agent = kind === "diagnosis" ? {call:(...args)=>this.reportAgent(run.entry).call(...args)} :
                    kind === "phone" ? this.agent : undefined;
                const options = { agent, ask, signal, onEvent, language: this.language,
                    readRequests:(window,filter) => localRequests(this.networks,window,filter,failure && run.entry.id) };
                if (kind === "phone") {
                    const outcome = await runPhoneTask({ ...options, device, goal, allowActions: !readOnly,
                        readRequests:readOnly ? undefined : options.readRequests, workbenchSession: this.sessionFor(device) });
                    signal.throwIfAborted();
                    this.aiDraft = outcome?.draft;
                    result.canSave = Boolean(this.aiDraft);
                    if (outcome?.status === "blocked") result.status = "blocked";
                } else if (kind === "diagnosis") {
                    if (failure) {
                        const diagnosis = await diagnoseCase({...options,run,failure,agent:entry=>this.reportAgent(entry),
                            baseline:baseline && (()=>this.readRunView(baseline)),
                            readLive:useLive ? ()=>this.readRepairObservation(device,signal) : undefined,
                            prepare:input=>this.caseRepair.prepare(input)});
                        const {summary,proposed,...details} = diagnosis;
                        Object.assign(result,{answer:summary,...details});
                        await this.caseRepair.propose(proposed);
                    } else await explainRun({...options,run,goal:goal || this.text.aiReportTask});
                } else if (kind === "exchange") {
                    await explainExchange({...options,controller:this.networks,id:exchangeId});
                } else {
                    const suggestion = await suggestRecordingCheck(draft, ask, this.language, this.text.noCheck);
                    signal.throwIfAborted();
                    result.answer = suggestion.text;
                    result.check = suggestion.check;
                }
                if (result.status === "running") result.status = "done";
            } catch (error) {
                result.status = signal.aborted ? "cancelled" : "error";
                if (!signal.aborted) {
                    if (providerSetupErrors.has(error.code)) {
                        result.providerSetup = true;
                        result.answer = this.text[error.code] || error.message;
                    } else {
                        result.answer = this.errorMessage(error);
                    }
                }
            } finally {
                if (signal.aborted) result.status = "cancelled";
                this.aiJob = undefined;
            }
        }, {runtime:!failure});
        return job.done;
    }

    cancelAI() {
        if (!this.aiJob) return;
        this.state.aiResults[this.aiJob.kind].status = "stopping";
        this.aiJob.controller.abort();
        this.publish();
    }

    reviewAITask() {
        if (!this.aiDraft || this.state.draft || this.state.caseReview || this.state.busy || this.state.aiResults.phone?.key !== this.state.device) return;
        this.state.draft = this.aiDraft;
        this.state.draft.originAI = true;
        this.aiDraft = undefined;
        this.state.aiResults.phone.canSave = false;
        delete this.state.aiResults.check;
        this.state.mode = "workflow";
        this.state.tool = "recordings";
        this.open();
        this.publish();
    }

    publish() {
        if (this.projectRuntime.apply()) return;
        if (recordingViews.has(this.state.mode)) this.recordingView = this.state.mode;
        if (!this.panel) return;
        const text = this.text;
        const report = this.caseRepair.reportState(this.state.run);
        const baseline = this.baseline(report.run?.entry);
        void this.panel.webview.postMessage({
            state: {...this.state,...report,testView:report.repairInProgress ? "run" : this.recordingView, runtimeName: this.projectRuntime.current.name,
                runtimeError: this.projectRuntime.current.error,
                failureReview: reviewCaseFailure(report.run),
                ...(this.state.tool !== "network" && {network:undefined,networkDraft:undefined}),
                nativeCaptureActive:Boolean(this.networks.activeCapture)},
            text,
            navigation: {
                selected: selectedWorkspaceTab(this.state),
                tools: [...workspaceTools].map(([id, tool])=>({id,label:text[tool.label]})),
            },
            language: this.language,
            hasBaseline: Boolean(baseline),
            aiProvider: this.aiProvider,
        });
        this.livePanel?.sync();
    }

    errorMessage(error) {
        if (error.code === "ENOENT") return this.text.cliNotFound;
        const message = error.code === "INVALID_AGENT_RESPONSE" ? this.text.invalidAgentResponse :
            this.text[error.code] || error.message;
        const owner = error.code==="DEVICE_OWNED" && error.details?.ownerSession;
        return [error.code,message,typeof owner==="string" && /^[\w.-]{1,100}$/.test(owner) && owner].filter(Boolean).join(" · ");
    }

    async perform(action, { runtime = true } = {}) {
        if (this.state.busy) return this.text.deviceBusy;
        this.state.busy = true;
        this.state.error = "";
        this.publish();
        // A newly reopened editor may still be releasing the previous display and recorder.
        const sync = async () => {
            if (runtime) {
                await this.projectRuntime.ready(false, true);
                this.runtimeOperation = true;
            }
            await action();
            if (runtime) await this.elements.sync();
        };
        const operation = Promise.resolve(runtime ? this.closingLive : undefined).then(sync);
        this.pendingAction = operation;
        try {
            await operation;
        } catch (error) {
            this.state.error = this.errorMessage(error);
            return this.state.error;
        } finally {
            this.runtimeOperation = false;
            this.pendingAction = undefined;
            this.state.busy = false;
            this.publish();
            void this.initializeTool();
        }
    }

    async dispatch(message) {
        if (this.state.tool === "recordings" && this.state.caseReview &&
            !["caseBoundary","caseSave","caseCancel","caseEdit","caseMoveStep","caseStepAction","caseTargets","device"].includes(message.type)) return;
        switch (message.type) {
            case "caseNew": this.caseAuthoring.create(); break;
            case "caseReview":
                if (message.id && !message.fromRun && !this.state.draft) await this.openCase(message.id);
                await this.caseAuthoring.open(message);
                break;
            case "caseDuplicate":
                await this.openCase(message.id);
                await this.caseAuthoring.open({copy:true});
                break;
            case "caseRemove": await this.removeCase(message.id); break;
            case "caseHideSelected": await this.hideSelectedCases(message.uris); break;
            case "caseRestore":
                if (this.state.removedCase?.uri===message.id) {
                    await this.caseLibrary.setHidden(this.state.removedCase.uris || message.id,false);
                    this.state.removedCase=undefined;
                    await this.refreshCases();
                }
                break;
            case "caseSave": await this.caseAuthoring.save(message); break;
            case "caseBoundary": await this.caseAuthoring.addBoundary(message); break;
            case "caseEdit": await this.caseAuthoring.edit(message); break;
            case "caseMoveStep": if (this.state.tool==="recordings") await this.caseAuthoring.moveStep(message); break;
            case "caseStepAction": if (this.state.tool==="recordings") await this.caseAuthoring.changeStep(message); break;
            case "caseTargets": await this.caseAuthoring.loadTargets(message); break;
            case "caseCancel": this.caseAuthoring.cancel(); break;
            case "caseOpen": await this.openCase(message.id); break;
            case "caseRun": await this.runCase(message); break;
            case "repairVerify":
            case "repairApply":
            case "repairDraft": await this.caseRepair.handle(message); break;
            case "device": await this.selectDevice(message.device); break;
            case "observe": await this.observe(); break;
            case "openApp": await this.openApp(); break;
            case "screenshot": await this.takeScreenshot(); break;
            case "action": await this.act(message); break;
            case "startRecord": await this.startRecording(message); break;
            case "stopRecord": await this.stopRecording(); break;
            case "discardRecord": await this.discardRecording(); break;
            case "moveRecordedStep": case "removeStep": case "removeRecordedSteps": case "undoRecordedRemoval":
                this.editRecordedSteps(message);
                break;
            case "savePlan": await this.savePlan(message); break;
            case "createPytest": await this.createPytest(message); break;
            case "runPytest": await this.usePytest(true); break;
            case "openPytest": await this.usePytest(false); break;
            case "openPlan": await this.choosePlan(); break;
            case "editPlan": await this.editPlan(message.fromRun,message.id); break;
            case "run": await this.executePlan(message.fromRun,undefined,{skipRuleGroup:message.skipRuleGroup===true}); break;
            case "report": await this.openReport(message.id); break;
            case "step":
                if (!message.id || message.id===this.state.run?.entry.id) await this.inspectStep(message.index, message.phase);
                break;
            case "compare": await this.compare(); break;
        }
    }

    async openTool(tab) {
        if (!workspaceTools.has(tab)) return;
        if (this.state.tool !== tab || !this.panel || (tab==="network" && !this.state.network && !this.state.networkLoading))
            this.pendingTool = tab;
        this.state.tool = tab;
        this.open();
        this.publish();
        await this.initializeTool();
    }

    async initializeTool() {
        if (!this.panel || this.pendingTool !== this.state.tool) return;
        const tab = this.pendingTool;
        if (tab === "network") {
            this.pendingTool = undefined;
            this.state.networkLoading = true;
            if (this.networkLoadError && this.state.error===this.networkLoadError) this.state.error="";
            this.networkLoadError=undefined;
            this.publish();
            try { await this.networks.init(); }
            catch (error) {
                this.networkLoadError=this.errorMessage(error);
                this.networks.showError(error);
            }
            finally { this.state.networkLoading = false; this.publish(); }
            return;
        }
        if (this.state.busy) return;
        this.pendingTool = undefined;
        if (tab === "exploration" && !this.state.draft && !["explore","revision"].includes(this.state.caseComposition?.mode)) {
            await this.explorations.handle({type:"explorationOpen"});
        } else if (tab === "inspect" && this.state.devices.includes(this.state.device) && !this.state.deviceDisconnected) {
            if (!this.elements.canReuseSnapshot()) await this.perform(() => this.refreshInspector());
        } else if (tab === "recordings" && !this.state.draft) {
            void this.loadTestLibrary(this.panel);
        }
    }

    async revealView(view) {
        if (view === "explore") return this.openLiveDevice();
        if (view === "exploration") return this.openTool(view);
        if (!recordingViews.has(view) || this.state.busy || this.state.draft || this.state.caseReview) return;
        this.state.tool = "recordings";
        this.state.mode = view;
        this.publish();
        if (view === "recordings") await this.loadTestLibrary(this.panel);
        if (view === "workflow") await this.refreshPlanSummary();
        if (view === "history") await this.perform(() => this.explorations.history());
    }

    openLiveDevice() {
        this.open();
        this.livePanel.focus();
    }

    async sendLiveGesture(device, input, isCurrent, sessions, anchor) {
        if (this.state.device !== device || !isCurrent()) return this.text.liveChanged;
        const {draft, recording} = this.state;
        if (draft && (!recording || draft.location === "phone")) return this.text.liveRecording;
        return this.perform(async () => {
            if (!isCurrent()) throw new Error(this.text.liveChanged);
            if (draft?.location === "phone") throw new Error(this.text.liveRecording);
            if (draft?.location === "auto") await this.startPreviewRecording(draft);
            if (this.recordingControls && await this.recordControlGesture(input,isCurrent,anchor,draft?.automatic)) return;
            await this.sendCoordinateGesture(device,input,isCurrent,sessions);
        });
    }

    async sendCoordinateGesture(device,input,isCurrent,sessions) {
        const agent = this.agent;
        let session = sessions.get(device)?.id;
        if (!session) {
            session = "vscode-display-" + randomUUID();
            await agent.call("attach", { session, device });
            sessions.set(device, { id: session, agent });
        }
        await agent.call("claim", { session });
        try {
            if (!isCurrent()) throw new Error(this.text.liveChanged);
            this.state.page = this.state.liveImage = undefined;
            if (this.state.tool === "inspect") this.publish();
            const started = Date.now();
            await replayGesture({ device, hdcPath: agent.hdcPath, isCurrent }, input);
            this.networks.mark(input.kind,started,Date.now());
            if (this.state.recording) {
                const step = { command: "deviceGesture", input };
                if (this.lastScreenStepAt) step.delayMs = Math.max(0, started - this.lastScreenStepAt);
                this.state.draft.steps.push(step);
                this.lastScreenStepAt = Date.now();
            }
        } finally {
            try { await agent.call("release",{session}); }
            catch {
                try {
                    await agent.call("detach",{session});
                    sessions.delete(device);
                } catch (error) {
                    this.state.error = this.errorMessage(error);
                }
            }
        }
        await this.refreshInspector(isCurrent);
    }

    async recordControlGesture(input, isCurrent, anchor, coordinateFallback) {
        if (!isCurrent()) throw new Error(this.text.liveChanged);
        const command = controlCommands.get(input.kind);
        if (command === "back") {
            await this.act({command});
            return true;
        }
        const direction = command === "scroll" ? scrollDirection(input) : undefined;
        if (!command || command === "scroll" && !direction) {
            if (coordinateFallback) return false;
            throw new Error(command ? this.text.recordingScrollControl : this.text.recordingGestureOnly);
        }
        await this.observe(isCurrent);
        if (!isCurrent()) throw new Error(this.text.liveChanged);
        const {node,locator,issue} = controlTarget(this.state.page,command,anchor || input);
        if (issue) {
            if (coordinateFallback) return false;
            throw new Error(this.text[issue]);
        }
        await this.act({command,ref:node.ref,direction,text:input.text,frameId:this.state.page.frameId},locator);
        return true;
    }

    cancelDeviceLookup() {
        this.deviceLookup?.controller.abort();
        this.deviceLookup = undefined;
        this.state.discoveringDevices = false;
    }

    listDevices() {
        if (this.deviceLookup) return this.deviceLookup.done;
        const job = this.deviceLookup = { panel: this.panel, controller: new AbortController() };
        this.state.discoveringDevices = true;
        this.state.deviceLookupError = undefined;
        if (this.livePanel) this.livePanel.error = undefined;
        job.done = this.probeDevices(job).catch(error => {
            if (this.deviceLookup === job) this.state.deviceLookupError = this.errorMessage(error);
        }).finally(() => {
            if (this.deviceLookup !== job) return;
            this.deviceLookup = undefined;
            this.state.discoveringDevices = false;
            this.publish();
        });
        this.publish();
        return job.done;
    }

    async probeDevices(job) {
        await this.closingLive;
        await this.projectRuntime.ready(Boolean(job.panel), true);
        if (this.deviceLookup !== job || this.panel !== job.panel) return;
        job.runtime = this.projectRuntime.current;
        const { devices } = await this.agent.call("devices", {}, { signal: job.controller.signal, timeout: 20000 });
        while (this.deviceLookup === job && this.pendingAction) await this.pendingAction.catch(() => {});
        const current = () => this.deviceLookup === job && this.panel === job.panel && this.projectRuntime.current === job.runtime;
        if (!current()) return;
        this.state.devices = devices.map(device => device.id);
        if (!this.state.devices.includes(this.state.device)) this.caseAuthoring.invalidateLiveTargets();
        await this.networks.devicesChanged(this.state.devices);
        if (!current()) return;
        if (!this.state.draft && !this.networks.activeCapture && !this.state.devices.includes(this.state.device)) {
            this.state.device = devices.length === 1 ? devices[0].id : undefined;
            this.state.deviceDisconnected = false;
            this.state.page = this.state.liveImage = undefined;
            this.state.actions = [];
            if (this.state.tool === "inspect" && !this.state.busy) await this.perform(() => this.refreshInspector(current));
        }
    }

    async selectDevice(device) {
        if (!this.state.devices.includes(device) || device === this.state.device) return;
        if (this.networks.activeCapture) throw new Error(this.language.startsWith("zh") ?
            "手机正在采集网络请求，请在网络调试中结束采集后切换设备。" :
            "Finish the active network capture before switching phones.");
        if (this.state.draft) throw new Error(this.text.activeRecording);
        await this.detach();
        this.state.device = device;
        this.state.deviceDisconnected = false;
        this.caseAuthoring.invalidateLiveTargets();
        this.state.actions = [];
        await this.refreshInspector();
    }

    async disconnectDevice(device, live) {
        if (this.livePanel !== live || this.state.device !== device || this.state.deviceDisconnected || this.state.recording) return;
        await live.withDeviceOperation(async () => {
            await live.detachDeviceSession(device);
            await this.detach();
            this.state.deviceDisconnected = true;
            this.caseAuthoring.invalidateLiveTargets();
            this.publish();
        });
        await live.closing;
    }

    async reconnectDevice(device, live) {
        if (this.livePanel !== live || this.state.device !== device || !this.state.deviceDisconnected) return;
        if (this.state.tool === "inspect") await this.observe();
        this.state.deviceDisconnected = false;
        live.error = undefined;
    }

    async detach() {
        if (this.state.recording) throw new Error(this.text.activeRecording);
        if (this.state.device) await this.agent.call("detach", { session: this.session });
        this.state.page = undefined;
        this.state.liveImage = undefined;
    }

    async observe(isCurrent, fullControls = this.fullControlTree) {
        if (!this.state.device) throw new Error(this.text.selectDevice);
        this.state.page = undefined;
        this.state.liveImage = undefined;
        if (this.state.tool === "inspect") this.publish();
        const page = await this.readPage(fullControls);
        if (!isCurrent || isCurrent()) {
            this.state.page = page;
            if (this.state.deviceDisconnected) {
                this.state.deviceDisconnected = false;
                if (this.livePanel) this.livePanel.error = undefined;
            }
        }
    }

    async readPage(fullControls) {
        const result = await this.agent.call("start", {
            device: this.state.device, session: this.session, ...(fullControls ? controlTreeOptions : observationOptions),
        });
        return pageView(result.observation,{elements:fullControls});
    }

    async refreshInspector(isCurrent) {
        if (!this.state.device || this.state.deviceDisconnected ||
            (this.state.tool !== "inspect" && !this.recordingControls) || (isCurrent && !isCurrent())) return;
        try {
            await this.observe(isCurrent);
        } catch (error) {
            // A failed tree read must not mark a successful device switch or acknowledged touch as failed.
            this.state.error = this.errorMessage(error);
        }
    }

    async openApp() {
        if (!this.state.page) throw new Error(this.text.invalidObservation);
        if (this.state.recording) throw new Error(this.text.activeRecording);
        const app = (await vscode.window.showInputBox({ prompt: this.text.bundleInput, ignoreFocusOut: true }))?.trim();
        if (!app) return;
        this.state.page = undefined;
        this.state.liveImage = undefined;
        const result = await this.agent.call("open", { session: this.session, app, ...this.pageOptions });
        this.state.page = pageView(result.observation,{elements:this.state.tool === "inspect"});
    }

    image(pathname, directory = this.stateDir) {
        if (!pathname || !this.panel || !containsPath(directory,pathname)) return undefined;
        return this.panel.webview.asWebviewUri(vscode.Uri.file(pathname)).toString();
    }

    async reportImage(run, step, index) {
        const root = run.entry.pytest?.stateDir || this.stateDir;
        const source = step.screenshot;
        if (!source) return;
        if (containsPath(root,source) && (containsPath(this.pytestArtifactDir,source) || containsPath(this.stateDir,source)))
            return this.image(source,root);
        // Resolve Windows path aliases and keep the same webview when evidence uses another directory.
        if (!/^[\w-]+$/.test(run.entry.id)) return;
        const ext = path.extname(source).toLowerCase();
        if (![".png",".jpg",".jpeg",".webp"].includes(ext)) return;
        const directory = path.join(this.pytestArtifactDir,"previews",run.entry.id);
        try {
            const [evidenceRoot, picture] = await Promise.all([fs.realpath(root), fs.realpath(source)]);
            if (!containsPath(evidenceRoot,picture)) return;
            await fs.mkdir(directory,{recursive:true,mode:0o700});
            const dest = path.join(directory,String(index)+ext);
            await fs.copyFile(picture,dest);
            return this.image(dest,this.pytestArtifactDir);
        } catch (error) {
            run.frameError = this.errorMessage(error);
        }
    }

    async takeScreenshot() {
        if (!this.state.page) throw new Error(this.text.invalidObservation);
        const result = await this.agent.call("screenshot", { session: this.session });
        this.state.liveImage = { src: this.image(result.path), capturedAt: result.capturedAt };
    }

    async act({ command, ref, direction, text, frameId }, locator) {
        const page = this.state.page;
        if (frameId && frameId !== page?.frameId) throw new Error(this.text.stalePage);
        if (!page && command !== "back") throw new Error(this.text.invalidObservation);
        if (this.state.draft && !this.recordingControls) throw new Error(this.text.activeRecording);
        if (!["press", "fill", "scroll", "back"].includes(command)) return;
        const node = command === "back" ? null : page.nodes.find(candidate => candidate.ref === ref);
        if (command !== "back" && !node) throw new Error(this.text.chooseElement);
        const selector = locator || node?.selector;
        if (this.state.recording && node && !selector) throw new Error(this.text.uniqueTarget);
        const input = {};
        if (node) input.target = { ...selector, ref: node.ref };
        if (command === "scroll") input.direction = direction;
        if (command === "fill") input.text = text;
        this.state.page = undefined;
        this.state.liveImage = undefined;
        const started = Date.now();
        const result = await this.agent.call(command, { ...input, ...this.pageOptions, session: this.session });
        this.networks.mark(node?.id || node?.type || command,started,Date.now());
        this.state.page = pageView(result.observation,{elements:this.fullControlTree});
        const label = node?.editable ? node.id || node.type || node.label : node?.label;
        this.state.actions = [{ command, label, target: selector, frame: result.afterFrameId }, ...this.state.actions].slice(0, 12);
        if (this.state.recording) {
            if (node) input.target = selector;
            const evidence=stepEvidence({from:pageCue(page),to:pageCue(this.state.page)});
            this.state.draft.steps.push({command,input,label,...(evidence && {evidence})});
            if (this.state.draft.automatic) this.lastScreenStepAt = Date.now();
        }
    }

    async startRecording({ location, stepFormat }) {
        if (this.state.draft) {
            this.state.tool = "recordings";
            return;
        }
        if (this.state.caseReview) throw new Error(this.text.activeRecording);
        if (!this.state.devices.includes(this.state.device)) throw new Error(this.text.selectDevice);
        const automatic = location === undefined && stepFormat === undefined;
        if (!automatic && (!["preview", "phone"].includes(location) || !["controls", "coordinates"].includes(stepFormat))) return;

        const onPhone = automatic || location === "phone";
        const controls = automatic || stepFormat === "controls";
        this.state.tool = "recordings";
        if (controls && !onPhone) await this.observe(undefined, true);
        const initialPage = controls && onPhone ? await this.readPage(true).catch(() => undefined) : this.state.page;
        this.state.deviceDisconnected = false;
        if (this.livePanel) this.livePanel.error = undefined;
        this.lastScreenStepAt = undefined;
        const draft = {
            location: automatic ? "auto" : location,
            stepFormat: controls ? "controls" : "coordinates",
            ...(automatic && {automatic:true}),
            start: controls ? boundaryControls(initialPage) : [],
            steps: [],
        };
        delete this.state.aiResults.check;
        this.state.draft = draft;
        this.state.recording = true;
        if (!onPhone) return;

        this.state.page = undefined;
        this.state.liveImage = undefined;
        const capture = this.capture = {page:initialPage};
        capture.ready = startRecorder({
            device: this.state.device, hdcPath: projectHdc(this), withControls: controls,
            onStep: (step, control) => {
                if (this.capture !== capture) return;
                if (draft.location === "auto" && !capture.previewStarting) draft.location = "phone";
                draft.steps.push(controls ? phoneControlStep(capture.page, step, control) : step);
                capture.page = undefined;
                if (controls) this.refreshPhoneRecordingPage(capture, draft);
                this.publish();
            },
            onError: error => {
                if (this.capture !== capture) return;
                this.capture = undefined;
                if (automatic) {
                    draft.location = "preview";
                    draft.phoneUnavailable = true;
                } else {
                    this.state.recording = false;
                    this.state.mode = "workflow";
                    this.state.error = this.errorMessage(error);
                }
                this.publish();
            },
        });
        try {
            capture.handle = await capture.ready;
        } catch (error) {
            if (this.capture === capture) this.capture = undefined;
            if (automatic) {
                draft.location = "preview";
                draft.phoneUnavailable = true;
                return;
            }
            this.state.recording = false;
            if (!draft.steps.length) this.state.draft = undefined;
            this.state.mode = draft.steps.length ? "workflow" : "recordings";
            throw error;
        }
    }

    async startPreviewRecording(draft) {
        const capture = this.capture;
        if (capture) {
            // Stop and drain the phone monitor before injecting any preview gesture.
            capture.previewStarting = true;
            try {
                await this.closePhoneRecording(capture);
            } catch (error) {
                draft.end = [];
                this.state.recording = false;
                this.state.mode = "workflow";
                throw error;
            } finally {
                if (this.capture === capture) this.capture = undefined;
            }
        }
        draft.location = "preview";
    }

    closePhoneRecording(capture) {
        return capture.closing ??= Promise.resolve(capture.handle || capture.ready).then(async handle => {
            try { await handle.stop(); }
            finally { await capture.refresh; }
        });
    }

    refreshPhoneRecordingPage(capture, draft) {
        if (capture.refresh || capture.closing) return;
        const stepCount = draft.steps.length;
        // Skip promotion when another touch arrived during the tree read.
        capture.refresh = this.readPage(true).catch(() => undefined).then(page => {
            if (this.capture === capture && draft.steps.length === stepCount) capture.page = page;
        }).finally(() => {
            capture.refresh = undefined;
            if (this.capture === capture && draft.steps.length !== stepCount) {
                this.refreshPhoneRecordingPage(capture, draft);
            }
        });
    }

    async stopRecording() {
        const draft = this.state.draft;
        if (!this.state.recording || !draft) return;
        const capture = this.capture;
        let endPage = capture ? undefined : this.state.page;
        try {
            if (capture) {
                await this.closePhoneRecording(capture);
                if (draft.stepFormat === "controls" && draft.steps.length) {
                    endPage = await this.readPage(true).catch(() => undefined);
                }
            }
        } finally {
            this.capture = undefined;
            this.state.recording = false;
            draft.end = draft.stepFormat === "controls" ? boundaryControls(endPage) : [];
            this.state.mode = "workflow";
        }
    }

    async discardRecording() {
        await this.stopRecording();
        this.state.draft = undefined;
        this.state.mode = "recordings";
    }

    planFromDraft({ startRef, goalRef, property, expected }) {
        const draft = this.state.draft;
        if (!draft?.steps.length) throw new Error(this.text.emptyRecording);
        if (this.state.recording) throw new Error(this.text.activeRecording);
        const start = draft.start.find(node => node.ref === startRef);
        const goal = draft?.end?.find(node => node.ref === goalRef);
        if ((startRef && !start) || (goalRef && !goal)) throw new Error(this.text.chooseConditions);
        if (draft.stepFormat === "controls" && (start || goal || draft.steps.some(step => step.command !== "deviceGesture"))) {
            return recordedPlan(draft.steps, start, goal, property, expected);
        }
        return { format: deviceRecordingFormat, version: 1, steps: draft.steps };
    }

    editRecordedSteps({type,index,indices,from,to,revision}) {
        const {draft,recording,caseReview,tool} = this.state;
        if (!draft || recording || caseReview || tool!=="recordings") return;
        const current = draft.stepRevision || 0;
        if (current!==revision && (type!=="removeStep" || revision!==undefined)) return;
        if (type==="moveRecordedStep") {
            if (!moveListItem(draft.steps,from,to)) return;
            draft.removedSteps = undefined;
        } else if (type==="undoRecordedRemoval") {
            if (!draft.removedSteps?.length) return;
            for (const {index,step} of draft.removedSteps) draft.steps.splice(index,0,step);
            draft.removedSteps = undefined;
        } else {
            const positions=type==="removeStep" ? [index] : Array.isArray(indices) ? [...new Set(indices)] : [];
            if (!positions.length || positions.some(position=>!Number.isInteger(position) || position<0 || position>=draft.steps.length)) return;
            draft.removedSteps=positions.sort((a,b)=>a-b).map(index=>({index,step:draft.steps[index]}));
            for (const index of positions.toReversed()) draft.steps.splice(index,1);
        }
        draft.stepRevision = current+1;
        delete this.state.aiResults.check;
    }

    async savePlan(message) {
        const plan = this.planFromDraft(message);
        const activeFile = vscode.window.activeTextEditor?.document.uri;
        const folder = (activeFile && vscode.workspace.getWorkspaceFolder(activeFile)) || vscode.workspace.workspaceFolders?.[0];
        const uri = await vscode.window.showSaveDialog({
            filters: planFilters,
            defaultUri: folder && vscode.Uri.joinPath(folder.uri, "recording.plan.json"),
        });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(plan, null, 2) + "\n"));
        await this.setPlan(uri);
        this.state.draft = undefined;
    }

    async refreshCases(panel = this.panel) {
        const request = this.caseListRead = Symbol();
        const cases = await this.caseLibrary.list(this.state.runs,{includeHidden:true});
        if (this.caseListRead === request && this.panel === panel) {
            this.knownCases = cases;
            this.state.cases = cases.filter(item=>!item.hidden);
        }
    }

    loadTestLibrary(panel) {
        if (!panel) return;
        if (this.caseLoad?.panel === panel) return this.caseLoad.done;
        const job = this.caseLoad = { panel };
        this.state.casesLoading = true;
        job.done = (async () => {
            try {
                await this.refreshCases(panel);
                if (this.panel !== panel || this.state.draft || this.state.busy) return;
                if (this.state.plan) await this.refreshPlanSummary();
                else if (this.state.tool === "recordings" && this.state.mode === "recordings" && this.state.cases.length)
                    await this.setPlan(vscode.Uri.parse(this.state.cases[0].uri));
            } catch (error) {
                if (this.panel === panel && !this.state.busy) this.state.error = this.errorMessage(error);
            } finally {
                if (this.caseLoad === job) {
                    this.caseLoad = undefined;
                    this.state.casesLoading = false;
                    this.publish();
                }
            }
        })();
        this.publish();
        return job.done;
    }

    async openCase(id) {
        if (this.state.draft) throw new Error(this.text.activeRecording);
        const item = this.state.cases.find(row => row.uri === id);
        if (!item) throw new Error(this.text.chooseSavedPlan);
        await this.setPlan(vscode.Uri.parse(item.uri));
    }

    async hideSelectedCases(uris) {
        const state=this.state;
        if (state.tool!=="recordings" || state.draft || state.caseReview || !Array.isArray(uris)) return;
        const selected=new Set(uris);
        const cases=state.cases.filter(item=>selected.has(item.uri));
        if (!cases.length || cases.length!==selected.size) return;
        await this.caseLibrary.setHidden(cases.map(item=>item.uri),true);
        const count=cases.length;
        const name=count===1 ? cases[0].name : /^zh/i.test(this.language) ? count+" 条用例" : count+" cases";
        state.removedCase={uri:randomUUID(),uris:cases.map(item=>item.uri),name};
        await this.refreshCases();
        if (selected.has(state.plan?.uri)) await this.setPlan(state.cases[0] ? vscode.Uri.parse(state.cases[0].uri) : undefined);
    }

    async removeCase(id) {
        const state = this.state;
        const item = state.cases.find(row=>row.uri===id);
        if (!item || state.draft || state.caseReview) return;
        const zh = /^zh/i.test(this.language);
        const uri = vscode.Uri.parse(item.uri);
        const libraryOnly = zh ? "从用例库移除" : "Remove from library";
        const trash = zh ? "移入回收站" : "Move to Trash";
        const folder = item.editable && await this.caseLibrary.managedFolder(uri);
        const uses = await this.composition.usages(item.portableId);
        const impact = uses.length ? "\n\n"+(zh ? "以下引用可继续使用各自保存的版本。\n" :
            "These references can continue with their saved versions.\n")+
            uses.map(use=>use.name+(use.before?" · "+use.before:"")).join("\n") : "";
        const choice = await vscode.window.showWarningMessage(
            zh ? `如何移除「${item.name}」？` : `How should “${item.name}” be removed?`,
            {modal:true,detail:(folder ?
                (zh ? "可将用例目录放入回收站，或只从工作台的用例库中移除。\n"+folder.fsPath :
                    "Move the case folder to Trash, or remove the entry from this workbench’s case library.\n"+folder.fsPath) :
                (zh ? "从当前工作区的用例库移除，项目文件保留。" : "Remove the entry from this workspace’s case library and keep its project files."))+impact},
            ...(folder ? [libraryOnly,trash] : [libraryOnly]));
        if (choice===trash && folder) {
            const current = await this.caseLibrary.managedFolder(uri);
            if (!current || current.fsPath!==folder.fsPath ||
                (vscode.workspace.textDocuments || []).some(doc=>doc.isDirty && containsPath(folder.fsPath,doc.uri.fsPath)))
                throw new Error(zh ? "用例目录已变化或有未保存的修改，请检查后再删除。" :
                    "The case folder changed or contains unsaved edits. Review it before removing it.");
            await vscode.workspace.fs.delete(folder,{useTrash:true,recursive:true});
            state.removedCase=undefined;
        } else if (choice===libraryOnly) {
            await this.caseLibrary.setHidden(id,true);
            state.removedCase={uri:id,name:item.name};
        } else return;
        await this.refreshCases();
        if (state.plan?.uri===id) await this.setPlan(state.cases[0] ? vscode.Uri.parse(state.cases[0].uri) : undefined);
    }

    async runCase(message = {}) {
        if (message.fromRun) {
            const previous = this.state.run?.entry;
            if (!previous?.plan) throw new Error(this.text.chooseSavedPlan);
            await this.setPlan(vscode.Uri.parse(this.planForEntry(previous).uri));
            if (previous.source === "pytest" && !this.state.pytestCase)
                throw new Error(/^zh/i.test(this.language) ? "找不到原用例的 pytest 测试文件。请从用例库重新打开该用例。" :
                    "The original pytest test file is missing. Reopen the case from the library.");
        } else if (message.id && this.state.plan?.uri !== message.id) await this.openCase(message.id);
        if (message.runner === "pytest" && !this.state.pytestCase) throw new Error(this.text.chooseSavedPlan);
        const options = {skipRuleGroup:message.skipRuleGroup===true};
        if (message.runner !== "workbench" && this.state.pytestCase) return this.usePytest(true,options);
        return this.executePlan(false,undefined,options);
    }

    async createPytest(message) {
        const zh = /^zh/i.test(this.language);
        const selected = !this.state.draft && this.planForRun(message.fromRun);
        let plan, group;
        if (this.state.draft) {
            plan = this.planFromDraft(message);
        } else {
            if (!selected) throw new Error(this.text.chooseSavedPlan);
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(selected.uri));
            const file = readWorkflow(document.getText());
            requireExecutableWorkflow(file,this.language);
            plan = file.plan;
            group = file.scenario || this.networks.bindings[selected.uri];
        }
        const issue = readiness(plan);
        if (issue === "ruleSteps") throw new Error(zh ? "用例内的规则组步骤请在工作台运行。" :
            "Run cases with rule group steps in the workbench.");
        if (issue === "gestures") throw new Error(zh ? "坐标手势可在工作台回放。请按控件名称或 ID 重新录制，再生成 pytest 用例。" :
            "Replay gestures in the workbench. Record by control name or ID to create a pytest test.");
        if (issue) throw new Error(zh ? "请补齐控件步骤、起始条件和最终断言。录制草稿可选控件，已保存流程可编辑 JSON。" :
            "Add control steps, a starting precondition and a final assertion. Pick controls in the recording or edit the saved JSON.");

        const parent = await vscode.window.showOpenDialog({canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
            defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, openLabel: zh ? "在此创建用例目录" : "Create case folder here"});
        if (!parent?.length) return;
        if (parent[0].scheme !== "file") throw new Error(zh ? "请选择本机项目目录。" : "Choose a local project folder.");
        const suggested = (selected?.name || "workflow").replace(/(?:\.plan)?\.json$/i, "");
        const name = await vscode.window.showInputBox({ title: zh ? "新建 pytest 用例目录" : "New pytest case folder",
            prompt: zh ? "输入用例名称。目录中将包含流程 JSON 和 Python 测试文件。" : "Name the new folder for the workflow JSON and Python test.",
            value: safeCaseName(suggested) ? suggested : "workflow", ignoreFocusOut: true,
            validateInput: value => safeCaseName(value) ? undefined : (zh ? "请输入 1–70 个字母、数字、汉字、空格或连接符。" : "Use 1–70 letters, numbers, spaces or separators.") });
        if (!name) return;
        const entry = await writeCase(parent[0].fsPath,name,plan,group);
        const uri = vscode.Uri.file(path.join(entry.folder, "workflow.json"));
        const existing = this.state.cases.find(row => row.uri === selected?.uri);
        await this.caseLibrary.add(uri, {name, source: this.state.draft ? "recording" : (existing?.source || "workflow"), origin: existing?.origin});
        await this.context.workspaceState.update("pytestCases", {...this.context.workspaceState.get("pytestCases", {}), [uri.toString()]: entry});
        this.state.draft = undefined;
        await this.refreshCases();
        await this.setPlan(uri);
    }

    async usePytest(run, options = {}) {
        const entry = this.state.pytestCase;
        if (!entry) throw new Error(this.text.chooseSavedPlan);
        const script = vscode.Uri.file(path.join(entry.folder, entry.filename));
        if (!run) return vscode.window.showTextDocument(script, {preview: false});
        const relevant = [script.toString(), this.state.plan.uri];
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.isDirty && relevant.includes(doc.uri.toString()) && !(await doc.save())) {
                throw new Error(/^zh/i.test(this.language) ? "请先保存用例文件，再运行 pytest。" : "Save the case files before running pytest.");
            }
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(this.state.plan.uri));
        const file = readWorkflow(document.getText());
        if (options.skipRuleGroup && !options.workflowOverride && (file.scenario || entry.requiresRuleGroup)) {
            const folder = await fs.mkdtemp(path.join(tmpdir(),"harmony-case-no-rules-"));
            const workflowOverride = path.join(folder,"workflow.json");
            try {
                await fs.writeFile(workflowOverride,JSON.stringify(file.plan),{mode:0o600});
                return await this.usePytest(true,{...options,workflowOverride});
            } finally {
                await fs.rm(workflowOverride,{force:true});
                await fs.rmdir(folder);
            }
        }
        const execution = options.workflowOverride ? readWorkflow(await fs.readFile(options.workflowOverride,"utf8")) : file;
        requireExecutableWorkflow(execution,this.language);
        if (hasRuleSteps(execution.plan)) throw new Error(/^zh/i.test(this.language) ?
            "用例内的规则组步骤请在工作台运行。" : "Run cases with rule group steps in the workbench.");
        await this.requireGestureRuntime(options.repairPlan || execution.plan);
        if (!options.skipRuleGroup && !file.scenario && this.networks.bindings[this.state.plan.uri]) throw new Error(/^zh/i.test(this.language) ?
            "项目用例还没有包含工作区绑定的规则组。请生成包含当前绑定的新用例。" : "Create a new case to include the rule group bound in this workspace.");
        if (!options.skipRuleGroup && entry.requiresRuleGroup && !file.scenario) throw new Error(/^zh/i.test(this.language) ?
            "请在 workflow.json 中恢复此用例需要的规则组快照。" : "Restore this case's required rule group snapshot in workflow.json.");
        const digest = sourceDigest(document.getText());
        const metadata = await readCaseMetadata(document.uri);
        const composedBdd = options.bdd || (!options.workflowOverride && this.composedReportBdd(file,metadata));
        let active, result;
        const ruleScope = await this.networks.beginCaseRules();
        try {
            result = await startPytest(vscode,this,{...entry,requiresRuleGroup:Boolean(execution.scenario)}, {
                ...options,
                onRunning:(run,locate,candidate)=>{
                    active = run;
                    Object.assign(run,{sourceDigest:digest,caseId:this.state.activeCase?.id,
                        ...(options.skipRuleGroup && {ruleGroupDisabled:true})});
                    if (composedBdd) run.composedBdd = composedBdd;
                    if (options.compositionTrial) run.compositionTrial = true;
                    if (options.repairOf) run.repairOf = options.repairOf;
                    if (options.repairTarget) run.repairTarget = options.repairTarget;
                    return this.showRunning(run,candidate || file.plan,execution.scenario,locate,metadata?.presentation);
                },
            });
        } catch (error) {
            if (this.state.run?.entry === active && active) {
                active.status = "unknown";
                this.state.run.error = this.errorMessage(error);
            }
            throw error;
        } finally {
            await ruleScope?.close();
        }
        if (result) {
            if (!options.repairOf && !options.compositionTrial) this.state.pytestOutcome = {uri: this.state.plan.uri, code: result.code, at: new Date().toISOString()};
            if (result.entry) {
                Object.assign(result.entry, {sourceDigest:digest,caseId:this.state.activeCase?.id,
                    ...(options.skipRuleGroup && {ruleGroupDisabled:true})});
                if (composedBdd) result.entry.composedBdd = composedBdd;
                if (options.compositionTrial) result.entry.compositionTrial = true;
                if (options.repairOf) result.entry.repairOf = options.repairOf;
                if (options.repairTarget) result.entry.repairTarget = options.repairTarget;
                this.state.runs = [result.entry, ...this.state.runs.filter(row => row.id !== result.entry.id)].slice(0,50);
                await this.persistRuns();
                await this.openReport(result.entry.id,{reveal:false});
                return result.entry;
            }
        }
    }

    async choosePlan() {
        if (this.state.draft) throw new Error(this.text.activeRecording);
        const [uri] = await vscode.window.showOpenDialog({ canSelectMany: false, filters: planFilters }) || [];
        if (!uri) return;
        if (!this.state.cases.some(item=>item.uri===uri.toString()) && await this.caseLibrary.registerExisting(uri))
            await this.refreshCases();
        await this.setPlan(uri);
    }

    async setPlan(uri) {
        this.state.activeCase = uri && this.state.cases.find(row => row.uri === uri.toString());
        const name = uri && (this.state.activeCase?.name || path.basename(uri.path));
        this.state.plan = uri && { name, uri: uri.toString() };
        this.state.planSummary = undefined;
        this.state.caseExplorationCheckpoints = undefined;
        this.state.planDigest = undefined;
        this.state.caseBdd = undefined;
        this.state.caseDefinitions = undefined;
        this.state.pytestReadiness = undefined;
        this.state.pytestCase = uri && this.context.workspaceState.get("pytestCases", {})[uri.toString()];
        this.state.mode = uri ? "workflow" : "recordings";
        await this.context.workspaceState.update("plan", this.state.plan);
        if (uri) await this.refreshPlanSummary();
        else {
            this.planRead=undefined;
            this.planWatch?.dispose();
            this.planWatch=this.watchedUri=undefined;
        }
    }

    async refreshPlanSummary() {
        const plan = this.state.plan;
        if (!plan) return;
        const request = this.planRead = Symbol();
        const activeCase = this.state.cases.find(row => row.uri === plan.uri);
        let summary, digest, bdd, definitions, explorationCheckpoints, pytestReadiness, compositionStale, entry = this.context.workspaceState.get("pytestCases", {})[plan.uri];
        try {
            const uri = vscode.Uri.parse(plan.uri);
            if (this.panel && this.watchedUri !== plan.uri) this.watchPlan(uri);
            const editing = vscode.workspace.textDocuments.find(doc => doc.isDirty && doc.uri.toString() === plan.uri);
            const contents = editing ? editing.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
            if (!entry && uri.scheme === "file" && path.basename(uri.fsPath) === "workflow.json") entry = await findCase(uri);
            try {
                const file=readWorkflow(contents);
                const workspaceBinding = Boolean(!file.scenario && this.networks.bindings[plan.uri]);
                pytestReadiness = {issue: readiness(file.plan), ruleGroup: Boolean(file.scenario) || workspaceBinding, workspaceBinding};
                summary = summarizePlan(file.plan);
                if (summary) {
                    const pending = pendingCaseWork(file.plan);
                    if (pending.length) summary.pending = pending;
                    digest = sourceDigest(contents);
                    const meta = activeCase && await readCaseMetadata(uri);
                    const authored = authoredDocument(file,meta);
                    const sources = authored.authored || file.draft ? await this.composition.refreshFor(authored.plan) : this.composition.sources;
                    compositionStale = authored.stale;
                    bdd = createBdd(authored.plan,this.language,file.scenario || this.networks.bindings[plan.uri],
                        authored.presentation,{...authored,sources});
                    if (activeCase && await canEditCase(uri,activeCase)) definitions = caseDefinitions(authored.plan,authored.presentation);
                    explorationCheckpoints=caseExplorationCheckpoints(file,authored,this.language,
                        {bdd,editable:Boolean(definitions),trustedCase:Boolean(activeCase)});
                }
                const group = file.scenario || this.networks.bindings[plan.uri];
                if (summary && group) summary.scenarioName=String(group.name || this.text.netUntitledGroup);
                if (summary && hasRuleSteps(file.plan)) summary.ruleSteps=true;
            } catch {
                // JSON parser diagnostics can contain fragments of private step inputs.
            }
            summary ??= { error: this.text.planFileInvalid };
        } catch {
            summary = { error: this.text.planFileUnavailable };
        }
        if (this.planRead === request && this.state.plan === plan) {
            this.state.planSummary = summary;
            this.state.caseExplorationCheckpoints = explorationCheckpoints;
            this.state.planDigest = digest;
            this.state.caseBdd = bdd;
            this.state.caseDefinitions = definitions;
            this.state.compositionStale = compositionStale;
            this.state.activeCase = this.state.cases.find(row => row.uri === plan.uri);
            this.state.pytestReadiness = pytestReadiness;
            this.state.pytestCase = entry;
            this.publish();
        }
    }

    watchPlan(uri) {
        this.planWatch?.dispose();
        this.planWatch = undefined;
        this.watchedUri = uri.toString();
        try {
            // Watch immediate neighbors, then compare exact URIs. Filenames can contain glob metacharacters.
            const pattern = new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), "*");
            const watcher = this.planWatch = vscode.workspace.createFileSystemWatcher(pattern);
            const changed = file => this.planChanged(file);
            watcher.onDidCreate(changed);
            watcher.onDidChange(changed);
            watcher.onDidDelete(changed);
        } catch {
            // Some virtual workspaces support reading only. Opening or revealing the plan still refreshes it.
            this.planWatch?.dispose();
            this.planWatch = undefined;
        }
    }

    planChanged(uri) {
        const plan = this.state.plan?.uri;
        const metadata = uri.scheme === "file" && uri.fsPath.endsWith(".harmony-case.json") &&
            vscode.Uri.file(uri.fsPath.slice(0,-".harmony-case.json".length)).toString() === plan;
        if (this.panel?.visible && (plan === uri.toString() || metadata)) {
            void this.refreshPlanSummary();
        }
    }

    planForRun(fromRun) {
        return fromRun ? this.planForEntry(this.state.run?.entry) : this.state.plan;
    }

    planForEntry(entry) {
        const item = entry?.caseId && this.state.cases.find(c => c.id === entry.caseId);
        return item ? {name:item.name,uri:item.uri} : entry?.plan;
    }

    async editPlan(fromRun, id) {
        const plan = id ? this.state.cases.find(entry=>entry.uri===id) : this.planForRun(fromRun);
        if (!plan) throw new Error(this.text.chooseSavedPlan);
        await vscode.window.showTextDocument(vscode.Uri.parse(plan.uri), { preview: false });
    }

    async persistRuns() {
        await this.context.workspaceState.update("runs", this.state.runs);
        this.testRunOverview?.scheduleRefresh();
    }

    composedReportBdd(file,metadata) {
        const authored = authoredDocument(file,metadata);
        if (!authored.authored && !hasRuleSteps(file.plan)) return;
        return createBdd(authored.plan,this.language,file.scenario,authored.presentation,{...authored,sources:this.composition.sources});
    }

    async verifyCompositionCopy(contents,bdd,runner) {
        if (runner!=="pytest" || hasRuleSteps(readWorkflow(contents).plan))
            return this.executePlan(false,{contents,bdd,compositionTrial:true});
        const root = path.join(this.storage.fsPath,"case-verification");
        await fs.mkdir(root,{recursive:true});
        const dir = await fs.mkdtemp(path.join(root,"draft-"));
        const workflowOverride=path.join(dir,"workflow.json");
        try {
            await fs.writeFile(workflowOverride,contents,{flag:"wx",mode:0o600});
            return await this.usePytest(true,{workflowOverride,bdd,compositionTrial:true});
        } finally {
            await fs.unlink(workflowOverride).catch(()=>{});
            await fs.rmdir(dir).catch(()=>{});
        }
    }

    showRunning(entry, plan, group, locate, presentationData) {
        this.state.mode = "run";
        const run = this.state.run = {entry,steps:[],selected:0,bdd:entry.composedBdd || createBdd(plan,this.language,group,restorePresentation(plan,presentationData))};
        this.publish();
        if (!locate) return;
        return watchRunJournal(locate, record=>{
            if (this.state.run !== run) return;
            const receipts = record.status === "running" && record.activeStep ?
                [...record.receipts,{...record.activeStep,status:"running"}] : record.receipts;
            const view = withAuthoredTargets(runView({...record,receipts}),plan);
            Object.assign(run,{steps:view.steps,selected:view.selected,goalStatus:view.goalStatus,error:view.error});
            this.publish();
        });
    }

    async executePlan(fromRun, trial, {skipRuleGroup = false} = {}) {
        if (this.state.draft) throw new Error(this.text.activeRecording);
        const selected = this.planForRun(fromRun);
        if (!selected) throw new Error(this.text.chooseSavedPlan);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(selected.uri));
        const contents = document.getText();
        const file = readWorkflow(trial?.contents || contents);
        requireExecutableWorkflow(file,this.language);
        if (!this.state.device) throw new Error(this.text.selectDevice);
        const {plan,scenario} = file;
        await this.requireGestureRuntime(plan);
        const metadata = await readCaseMetadata(document.uri);
        const entry = { id: randomUUID(), plan: selected, device:this.state.device, status: "running", time: new Date().toISOString(),
            sourceDigest: sourceDigest(contents), caseId: this.state.cases.find(row => row.uri === selected.uri)?.id };
        if (skipRuleGroup) entry.ruleGroupDisabled = true;
        if (trial) entry.repairOf = trial.repairOf;
        if (trial?.repairTarget) entry.repairTarget = trial.repairTarget;
        if (trial?.compositionTrial) entry.compositionTrial = true;
        const group = skipRuleGroup ? undefined : scenario || this.networks.bindings[selected.uri];
        const composedBdd = trial?.bdd || (!trial && this.composedReportBdd({...file,scenario:group},metadata));
        if (composedBdd) entry.composedBdd = composedBdd;
        const scheduled = hasRuleSteps(plan);
        const ruleScope = await this.networks.beginCaseRules(group,entry.id,
            {prepare:!skipRuleGroup && hasRuleSteps(plan,"enable"),upstream:trial?.upstream});
        const activeRules = skipRuleGroup ? undefined : ruleScope;
        try {
            if (plan.format === deviceRecordingFormat) entry.source = "device";
            const expired = this.state.runs.slice(49);
            this.state.runs = [entry, ...this.state.runs].slice(0, 50);
            await this.persistRuns();
            for (const old of expired) {
                if (old.source === "device") await this.context.workspaceState.update("gestures." + old.id, undefined);
            }
            this.state.page = undefined;
            this.state.liveImage = undefined;
            const locate = entry.source === "device" ? undefined :
                ()=>({id:entry.id,file:journalPath(this.stateDir,entry.id)});
            const stopProgress = this.showRunning(entry,plan,group,locate,metadata?.presentation);
            if (entry.source === "device") {
                await saveRulePlanForRun(this.stateDir,entry.id,plan);
                await this.replayDevicePlan(entry,plan,activeRules);
                return entry;
            }
            const agent = this.agent, session = this.session, device = this.state.device;
            let result, failure;
            const controller = scheduled && activeRules ? new AbortController() : undefined;
            if (controller) {
                this.nativeReplay = controller;
                this.state.run.canStop = true;
                this.publish();
            }
            try {
                const request = {session,run_id:entry.id,plan,output:"full",...observationOptions};
                const options = {scope:activeRules,signal:controller?.signal};
                if (plan.preconditions?.length && plan.goals?.length) {
                    result = await runCasePlan(this,"execute",{...request,device},options);
                } else {
                    // execute requires both boundary checks. A session run journals the same steps and frames.
                    await agent.call("start",{device,session,max_nodes:1,compact:true});
                    result = await runCasePlan(this,"run",request,options);
                }
            } catch (error) {
                failure = error;
            } finally {
                this.nativeReplay = undefined;
                this.state.run.canStop = false;
                stopProgress?.();
                entry.cleanup = "detached";
                if (result?.sessionCleanup?.status!=="detached") {
                    try {
                        // Reports read frozen files. The live session can be released even when a step failed.
                        await agent.call("detach",{session});
                    } catch (error) {
                        entry.cleanup = "failed";
                        this.state.error = this.errorMessage(error);
                    }
                }
            }
            if (failure) {
                entry.status = ["INVALID_PLAN","INVALID_ARGUMENT","INVALID_REQUEST"].includes(failure.code) ? "rejected" : "unknown";
                entry.failureCode = this.state.run.errorCode = failure.code;
                this.state.run.cleanup = entry.cleanup;
                entry.failureMessage = this.state.run.error = this.errorMessage(failure);
                await this.persistRuns();
                throw failure;
            }
            await saveRulePlanForRun(this.stateDir,entry.id,plan);
            await this.setRun(entry,result,{plan,group});
            return entry;
        } finally {
            await ruleScope?.close();
        }
    }

    async requireGestureRuntime(plan) {
        if (plan?.format===deviceRecordingFormat || !hasGestures(plan)) return;
        const schema = await this.agent.call("schema",{command_name:"run"});
        const features = schema?.["x-harmony-plan-features"];
        if (!Array.isArray(features) || !features.includes("deviceGesture")) throw new Error(/^zh/i.test(this.language) ?
            "此用例包含坐标手势和控件步骤，请将当前项目的 Harmony Agent 运行时升级到 0.1.0a11 或更高版本。" :
            "This case combines gestures and controls. Update this project's Harmony Agent runtime to 0.1.0a11 or later.");
    }

    async replayDevicePlan(entry,plan,ruleScope) {
        const run = this.state.run;
        run.goalStatus = "not_requested";
        const controller = this.nativeReplay = new AbortController();
        const target = { device: this.state.device, hdcPath: projectHdc(this) };
        const session = this.session;
        try {
            validateRecording(plan,{invalid:this.text.invalidDevicePlan,unsupported:this.text.unsupportedDeviceStep});
            try {
                await this.agent.call("claim", { session });
            } catch (error) {
                if (error.code !== "NO_SESSION") throw error;
                await this.agent.call("attach", { session, device: target.device });
                await this.agent.call("claim", { session });
            }
        } catch (error) {
            this.nativeReplay = undefined;
            run.error = this.errorMessage(error);
            entry.status = "rejected";
            await this.context.workspaceState.update("gestures." + entry.id, { steps: [], error: run.error, bdd:run.bdd });
            await this.persistRuns();
            throw error;
        }

        const started = Date.now();
        entry.status = "running";
        entry.gestureTimingVersion = 1;
        try {
            run.canStop = true;
            await this.replayGestures(plan.steps,run,target,controller.signal,started,ruleScope);
            entry.status = run.steps.at(-1).status;
        } finally {
            this.nativeReplay = undefined;
            run.canStop = false;
            try {
                await this.agent.call("detach", { session });
                run.cleanup = entry.cleanup = "detached";
            } catch (error) {
                run.cleanup = entry.cleanup = "failed";
                this.state.error = this.errorMessage(error);
            }
            run.status = entry.status;
            await this.persistRuns();
        }
    }

    async replayGestures(steps,run,target,signal,started,ruleScope) {
        for (const [index, step] of steps.entries()) {
            const rule = step.ruleGroup;
            const operation = rule?.action==="enable" ? "enableRuleGroup" : "disableRuleGroup";
            const stepStart = Date.now();
            const receipt = {
                path:`steps[${index}]`,kind:rule ? "ruleGroup" : "command",
                command:rule ? operation : step.input.kind,gesture:step.input,
                label:rule?.scenario?.name || rule?.name || step.label,status:"running",stepStartedAt:new Date(stepStart).toISOString(),
                ...(step.delayMs !== undefined && {delayMs:step.delayMs}),
            };
            run.selected = index;
            run.steps.push(receipt);
            this.publish();
            let dispatchedAt;
            try {
                if (step.delayMs) await delay(step.delayMs, undefined, { signal });
                signal.throwIfAborted();
                dispatchedAt = Date.now();
                if (rule) ruleScope?.apply(validateRuleStep(step));
                else await replayGesture(target,step.input);
                receipt.status = "completed";
                receipt.dispatched = "acknowledged";
            } catch (error) {
                receipt.status = signal.aborted && dispatchedAt===undefined ? "cancelled" : "unknown";
                run.error = receipt.error = this.errorMessage(error);
            }
            const finished = Date.now();
            receipt.at = new Date(finished).toISOString();
            receipt.stepElapsedMs = Math.max(0,finished-stepStart);
            // Network evidence uses the dispatch window, excluding the recorded wait.
            if (dispatchedAt!==undefined) receipt.elapsedMs = Math.max(0,finished-dispatchedAt);
            run.runtimeMs = finished - started;
            await this.context.workspaceState.update("gestures." + run.entry.id, {
                steps: run.steps, error: run.error, runtimeMs: run.runtimeMs, bdd:run.bdd,
            });
            if (receipt.status !== "completed") break;
        }
    }

    async openReport(id, {reveal=true} = {}) {
        let entry = this.state.runs.find(run => run.id === id);
        if (!entry) return;
        if (reveal) {
            if (entry.repairOf) entry = this.state.runs.find(run=>run.id===entry.repairOf) || entry;
            this.state.tool = "recordings";
            const associated = this.planForEntry(entry);
            if (associated.uri !== this.state.plan?.uri) await this.setPlan(vscode.Uri.parse(associated.uri));
        }
        this.state.mode = "run";
        this.state.run = { entry };
        if (entry.source === "pytest") {
            const uri = this.planForEntry(entry)?.uri;
            const metadata = uri && await readCaseMetadata(vscode.Uri.parse(uri));
            const report = await loadPytestRun(entry,this.language,metadata?.presentation);
            this.state.run = {...report, entry, bdd:entry.composedBdd || report.bdd};
            await this.caseRepair.show(this.state.run);
            return;
        }
        if (entry.source === "device") {
            const report = this.context.workspaceState.get("gestures." + entry.id, { steps: [] });
            this.state.run = { ...report, entry, status: entry.status, cleanup: entry.cleanup, goalStatus: "not_requested",
                selected: Math.max(report.steps.length - 1, 0) };
            await this.caseRepair.show(this.state.run);
            return;
        }
        let record;
        try {
            record = await readSummaryRecord(this.stateDir,entry,async ()=>{
                await this.projectRuntime.ready(false,true);
                return this.reportAgent(entry).call("report",{run_id:entry.id,full:true});
            });
        } catch (error) {
            if (!entry.failureMessage) throw error;
            this.state.run = {entry,steps:[],status:entry.status,error:entry.failureMessage,errorCode:entry.failureCode};
            await this.caseRepair.show(this.state.run);
            return;
        }
        await this.setRun(entry,record,{fromHistory:true});
    }

    async setRun(entry, record, {plan,group,fromHistory=false} = {}) {
        plan ??= await archivedRunPlan(this.stateDir,entry.id);
        const view = withAuthoredTargets(runView(await withRunReceipts(this.stateDir,entry.id,record)), plan);
        let bdd = entry.composedBdd;
        if (!bdd) {
            if (!group && plan) group = await this.networks.scenarioForRun(entry.id);
            const uri = this.planForEntry(entry)?.uri;
            const metadata = uri && await readCaseMetadata(vscode.Uri.parse(uri));
            bdd = createBdd(plan,this.language,group,restorePresentation(plan,metadata?.presentation));
        }
        const previousStatus = entry.status, previousDevice = entry.device;
        entry.status = view.status;
        entry.device ??= record.device || (record.result || record).observation?.device;
        this.state.run = {entry,...view,bdd,cleanup:entry.cleanup || view.cleanup};
        await this.caseRepair.show(this.state.run);
        if (!fromHistory || previousStatus!==entry.status || previousDevice!==entry.device) await this.persistRuns();
    }

    async inspectStep(index, phase) {
        const run = this.state.run;
        const step = run?.steps?.[index];
        if (!step) return;
        run.selected = index;
        run.phase = phase || (step.after ? "after" : "before");
        run.frame = undefined;
        run.image = undefined;
        delete run.frameError;
        run.image = await this.reportImage(run,step,index);
        const frameId = step[run.phase];
        if (frameId) {
            try {
                await this.projectRuntime.ready(false,true);
                const frozen = await this.reportAgent(run.entry).call("inspect", { run_id: run.entry.id, frame_id: frameId, max_nodes: 180 });
                run.frame = pageView(frozen);
            } catch (error) {
                run.frameError = this.errorMessage(error);
            }
        }
    }

    reportAgent(entry) {
        const agent = this.agent;
        if (entry?.pytest?.stateDir) agent.stateDir = entry.pytest.stateDir;
        return agent;
    }

    baseline(current = this.state.run?.entry) {
        return current && current.source !== "device" && this.state.runs.find(entry =>
            entry.status === "passed" && !entry.compositionTrial && !entry.repairTarget && (!entry.repairOf || entry.repairApplied) &&
            this.planForEntry(entry)?.uri === this.planForEntry(current)?.uri && entry.time < current.time);
    }

    async readRunView(entry) {
        if (entry.source === "pytest") return loadPytestRun(entry);
        const record = await this.reportAgent(entry).call("report", {run_id:entry.id,full:true});
        return {...runView(record),entry};
    }

    async compare() {
        const baseline = this.baseline();
        const run = this.state.run;
        if (!baseline || !run.steps) return;
        if (run.comparison) {
            delete run.comparison;
        } else {
            const earlier = await this.readRunView(baseline);
            run.comparison = { difference: compareRuns(run, earlier) };
        }
    }
}

let activeWorkbench;
function activate(context) {
    const workbench = activeWorkbench = new Workbench(context);
    registerCopilotMcp(vscode, context, workbench);
    workbench.projectRuntime.start();
    context.subscriptions.push(vscode.commands.registerCommand("harmonyAgent.openWorkbench", () => workbench.open()));
    const launcher = registerWorkbenchLauncher(vscode,workbench);
    context.subscriptions.push(
        vscode.commands.registerCommand("harmonyAgent.selectProjectRuntime", () => workbench.chooseProjectRuntime()),
        ...[...workspaceTools].map(([tab,tool]) =>
            vscode.commands.registerCommand(tool.command, () => workbench.openTool(tab))),
        vscode.commands.registerCommand("harmonyAgent.openLiveDevice", () => workbench.openLiveDevice()),
        vscode.commands.registerCommand("harmonyAgent.askAI", () => workbench.openTask()),
        vscode.commands.registerCommand("harmonyAgent.openAIChat", () => workbench.openAI()),
        vscode.commands.registerCommand("harmonyAgent.openPlan", async () => {
            await workbench.openTool("recordings");
            await workbench.perform(() => workbench.choosePlan(), { runtime: false });
        }),
        vscode.commands.registerCommand("harmonyAgent.openEvidence", async () => {
            try { await openProblemClip(workbench,vscode); }
            catch (error) { void vscode.window.showErrorMessage(workbench.errorMessage(error)); }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("harmonyAgent.language") || event.affectsConfiguration("harmonyAgent.aiProvider")) workbench.publish();
            if (event.affectsConfiguration("harmonyAgent.language")) {
                launcher.tooltip = workbench.text.openWorkbench;
                void workbench.projectRuntime.refresh();
                if (workbench.state.plan) void workbench.refreshPlanSummary();
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => workbench.planChanged(event.document.uri)),
    );
}

async function deactivate() {
    activeWorkbench?.explorations.cancel("pause");
    activeWorkbench?.flowDebugger.stop();
    activeWorkbench?.nativeReplay?.abort();
    const ai = activeWorkbench?.aiJob;
    activeWorkbench?.cancelAI();
    activeWorkbench?.panel?.dispose();
    await activeWorkbench?.closingLive;
    await activeWorkbench?.networks.close();
    await ai?.done;
    if (activeWorkbench?.capture) await activeWorkbench.stopRecording();
}

module.exports = { activate, deactivate };
