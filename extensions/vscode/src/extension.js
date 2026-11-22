"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const vscode = require("vscode");
const { AgentClient } = require("./agent");
const { pageView, recordedPlan, moveListItem, runView, withAuthoredTargets, compareRuns, deviceRecordingFormat } = require("./model");
const { summarizePlan } = require("./planSummary");
const { startRecorder, replayGesture, validateGesture } = require("./deviceRecorder");
const { controlCommands, controlTarget, scrollDirection, boundaryControls } = require("./controlRecording");
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
const { readWorkflow } = require("./workflowFile");
const { readiness, safeCaseName, writeCase, findCase, startPytest } = require("./pytestCase");
const { CaseLibrary, createBdd } = require("./caseLibrary");
const { CaseAuthoring, caseDefinitions, canEditCase } = require("./caseAuthoring");
const { loadPytestRun } = require("./pytestReport");
const { journalPath, watchRunJournal } = require("./runProgress");
const { CaseRepair, sourceDigest } = require("./caseRepair");
const { workspaceTools, selectedWorkspaceTab, registerWorkbenchLauncher } = require("./workbenchTools");
const { FlowDebugger } = require("./flowDebug");
const { exportProblemClip, openProblemClip } = require("./problemExport");
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
            actions: [],
            aiResults: {},
            explorationHistory: [],
            cases: [],
        };
        this.caseLibrary = new CaseLibrary(vscode, context);
        this.caseAuthoring = new CaseAuthoring(this, vscode);
        this.caseRepair = new CaseRepair(this, vscode);
        this.explorations = new ExplorationController(this, vscode);
        this.elements = new ElementsController(this, vscode);
        this.networks = new NetworkController(this, vscode);
        this.flowDebugger = new FlowDebugger(this, vscode);
        this.recordingView = this.state.mode;
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
        return new AgentClient({
            executable: this.config.get("cliPath") || process.env.HARMONY_AGENT_CLI || "harmony-agent",
            hdcPath: this.config.get("hdcPath"),
            stateDir: this.stateDir,
        });
    }

    get session() {
        return this.sessionFor(this.state.device);
    }

    get recordingControls() {
        return this.state.recording && this.state.draft?.stepFormat === "controls";
    }

    get fullControlTree() {
        return this.recordingControls || this.state.tool === "inspect";
    }

    get pageOptions() {
        return this.fullControlTree ? controlTreeOptions : observationOptions;
    }
    prepareFlowScenario(planRef,scenario,id,savedHits) { return this.networks.prepareFlow(planRef,scenario,id,savedHits); }

    sessionFor(device) {
        const id = createHash("sha256").update(this.workspaceStateDir + "\0" + device).digest("hex").slice(0, 24);
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
                    // A direct entry may already be opening its tab.
                    if (!this.state.draft) await this.pendingAction?.catch(() => {});
                    if (!this.state.draft && this.panel === panel) await this.perform(async () => {
                        await this.refreshCases();
                        if (this.state.plan) await this.refreshPlanSummary();
                        else if (this.state.tool === "recordings" && this.state.mode === "recordings" && this.state.cases.length)
                            await this.setPlan(vscode.Uri.parse(this.state.cases[0].uri));
                        try { await this.listDevices(); }
                        catch (error) {
                            if (!["network","exploration"].includes(this.state.mode) && !recordingViews.has(this.state.mode)) throw error;
                        }
                    });
                }
            } else if (message.type === "workspaceTab") {
                await this.openTool(message.view);
            } else if (message.type.startsWith("exploration")) {
                if (["explorationReport","explorationNew","explorationFromCase"].includes(message.type) &&
                    this.state.tool === "recordings" && !this.state.caseReview && !this.state.draft)
                    this.state.tool = "exploration";
                if (this.state.tool !== "exploration") return;
                await this.explorations.handle(message);
            } else if (toolMessages.has(message.type) ||
                    (message.type === "view" && message.view === "inspect")) {
                await this.openTool(message.type === "view" ? "inspect" : toolMessages.get(message.type));
            } else if (message.type.startsWith("element")) {
                await this.perform(() => this.elements.handle(message));
            } else if (message.type === "networkNativeStop") {
                // A phone action can still be running when the user ends the capture.
                try { await this.networks.handle(message); }
                catch (error) { this.networks.showError(error); }
            } else if (message.type.startsWith("network")) {
                await this.perform(() => this.networks.handle(message));
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
            } else if (message.channel === "live") {
                await live.receive(message);
            } else if (message.type === "liveDevice") {
                this.openLiveDevice();
            } else if (message.type === "askAI") {
                this.openTask();
            } else if (message.type === "explainExchange" && typeof message.id === "string" && this.state.tool === "network") {
                await this.runAI("exchange",undefined,false,message.id);
            } else if (message.type === "explainStep" || message.type === "suggestCheck") {
                if (message.type === "suggestCheck") await this.runAI("check");
                else if (!message.id || (message.id === this.state.run?.entry?.id && message.index === this.state.run.selected)) {
                    await this.runAI("diagnosis", typeof message.goal === "string" ? message.goal.trim().slice(0,1200) : undefined);
                }
            } else if (message.type === "cancelAI") {
                this.cancelAI();
            } else if (message.type === "aiProvider") {
                await this.setAIProvider(message.provider);
            } else if (message.type === "settings" || message.type === "aiSettings") {
                const query = message.type === "aiSettings" ? "@id:harmonyAgent.aiProvider" : "harmonyAgent";
                await vscode.commands.executeCommand("workbench.action.openSettings", query);
            } else if (message.type === "view") {
                await this.revealView(message.view);
            } else {
                await this.perform(() => this.dispatch(message));
            }
        });
        panel.onDidChangeViewState(() => {
            live.sync();
            if (panel.visible && !this.state.draft) void this.refreshPlanSummary();
        });
        panel.onDidDispose(() => {
            if (this.panel !== panel) return;
            this.panel = this.livePanel = undefined;
            this.planRead = undefined;
            this.planWatch?.dispose();
            this.planWatch = this.watchedUri = undefined;
            this.cancelAI();
            this.caseRepair.controller?.abort();
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
            this.closingLive = closing().catch(error => { this.state.error = this.errorMessage(error); })
                .finally(() => this.publish());
        });
        webview.html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource}; img-src ${webview.cspSource};">
<link rel="stylesheet" href="${resource("workbench.css")}"><link rel="stylesheet" href="${resource("liveDevice.css")}"><link rel="stylesheet" href="${resource("workspaceRail.css")}"><link rel="stylesheet" href="${resource("elements.css")}">
<link rel="stylesheet" href="${resource("network.css")}"><link rel="stylesheet" href="${resource("networkEditor.css")}"><link rel="stylesheet" href="${resource("networkScenarios.css")}">
<link rel="stylesheet" href="${resource("ui/components.css")}"><link rel="stylesheet" href="${resource("ui/fieldEditor.css")}"><link rel="stylesheet" href="${resource("caseLibrary.css")}"><title>Harmony Agent</title></head>
<body><div id="app-shell"><header id="station-header"></header><main id="station-body">
<aside id="live-device" aria-labelledby="live-title">${liveDeviceMarkup()}</aside>
<div id="tool-pane"><div id="tool-navigation"></div><div id="tool-content" role="tabpanel" tabindex="0">
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

    runAI(kind, goal, readOnly = false, exchangeId) {
        if (this.aiJob || this.state.busy) return;
        const { device, draft, recording, run } = this.state;
        if (kind === "phone" && (!device || draft || !goal?.trim())) return;
        if ((kind === "diagnosis" && !run?.entry) || (kind === "check" && (recording || draft?.stepFormat !== "controls"))) return;
        const controller = new AbortController();
        const job = this.aiJob = { kind, controller };
        const key = kind === "exchange" ? exchangeId : kind === "diagnosis" ? run.entry.id + "/" + run.selected : device;
        const result = this.state.aiResults[kind] = { key, goal, provider: this.aiProvider, status: "running", steps: [] };
        if (kind === "phone") {
            this.aiDraft = undefined;
            if (!readOnly) this.state.page = this.state.liveImage = undefined;
        }
        const { signal } = controller;
        job.done = this.perform(async () => {
            try {
                const requestModel = await this.modelAsk(signal, () => { result.waitingForModel = "retry"; this.publish(); });
                signal.throwIfAborted();
                const ask = async prompt => {
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
                const options = { agent: kind === "diagnosis" ? this.reportAgent(run.entry) : this.agent, ask, signal, onEvent, language: this.language,
                    readRequests:(window,filter) => localRequests(this.networks,window,filter) };
                if (kind === "phone") {
                    const outcome = await runPhoneTask({ ...options, device, goal, allowActions: !readOnly,
                        readRequests:readOnly ? undefined : options.readRequests, workbenchSession: this.sessionFor(device) });
                    signal.throwIfAborted();
                    this.aiDraft = outcome?.draft;
                    result.canSave = Boolean(this.aiDraft);
                    if (outcome?.status === "blocked") result.status = "blocked";
                } else if (kind === "diagnosis") {
                    await explainRun({ ...options, run, goal: goal || this.text.aiReportTask });
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
        });
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
        if (recordingViews.has(this.state.mode)) this.recordingView = this.state.mode;
        if (!this.panel) return;
        const text = this.text;
        const baseline = this.baseline();
        void this.panel.webview.postMessage({
            state: {...this.state, testView:this.recordingView,
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
        return error.code ? error.code + " · " + message : message;
    }

    async perform(action) {
        if (this.state.busy) return this.text.deviceBusy;
        this.state.busy = true;
        this.state.error = "";
        this.publish();
        // A newly reopened editor may still be releasing the previous display and recorder.
        const sync = async () => { await action(); await this.elements.sync(); };
        const operation = Promise.resolve(this.closingLive).then(sync);
        this.pendingAction = operation;
        try {
            await operation;
        } catch (error) {
            this.state.error = this.errorMessage(error);
            return this.state.error;
        } finally {
            this.pendingAction = undefined;
            this.state.busy = false;
            this.publish();
            void this.initializeTool();
        }
    }

    async dispatch(message) {
        if (this.state.tool === "recordings" && this.state.caseReview &&
            !["caseBoundary","caseSave","caseCancel","caseEdit","caseMoveStep","caseTargets","devices","device"].includes(message.type)) return;
        switch (message.type) {
            case "caseReview":
                if (message.id && !message.fromRun && !this.state.draft) await this.openCase(message.id);
                await this.caseAuthoring.open(message);
                break;
            case "caseSave": await this.caseAuthoring.save(message); break;
            case "caseBoundary": await this.caseAuthoring.addBoundary(message); break;
            case "caseEdit": await this.caseAuthoring.edit(message); break;
            case "caseMoveStep": if (this.state.tool==="recordings") await this.caseAuthoring.moveStep(message); break;
            case "caseTargets": await this.caseAuthoring.loadTargets(message); break;
            case "caseCancel": this.caseAuthoring.cancel(); break;
            case "caseOpen": await this.openCase(message.id); break;
            case "caseRun": await this.runCase(message); break;
            case "repairSuggest": await this.caseRepair.suggest(message); break;
            case "repairVerify": await this.caseRepair.verify(message); break;
            case "repairApply": await this.caseRepair.apply(message); break;
            case "devices":
                if (this.livePanel) this.livePanel.error = undefined;
                await this.listDevices();
                break;
            case "device": await this.selectDevice(message.device); break;
            case "observe": await this.observe(); break;
            case "detach":
                await this.detach();
                if (this.livePanel) this.livePanel.paused = true;
                break;
            case "openApp": await this.openApp(); break;
            case "screenshot": await this.takeScreenshot(); break;
            case "action": await this.act(message); break;
            case "startRecord": await this.startRecording(message); break;
            case "stopRecord": await this.stopRecording(); break;
            case "discardRecord": await this.discardRecording(); break;
            case "moveRecordedStep": case "removeStep":
                this.editRecordedSteps(message);
                break;
            case "savePlan": await this.savePlan(message); break;
            case "createPytest": await this.createPytest(message); break;
            case "runPytest": await this.usePytest(true); break;
            case "openPytest": await this.usePytest(false); break;
            case "openPlan": await this.choosePlan(); break;
            case "editPlan": await this.editPlan(message.fromRun,message.id); break;
            case "run": await this.executePlan(message.fromRun); break;
            case "report": await this.openReport(message.id); break;
            case "step": await this.inspectStep(message.index, message.phase); break;
            case "compare": await this.compare(); break;
        }
    }

    async openTool(tab) {
        if (!workspaceTools.has(tab)) return;
        if (this.state.tool !== tab || !this.panel) this.pendingTool = tab;
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
            try { await this.networks.init(); }
            catch (error) { this.networks.showError(error); }
            return;
        }
        if (this.state.busy) return;
        this.pendingTool = undefined;
        if (tab === "exploration" && !this.state.draft) {
            await this.explorations.handle({type:"explorationOpen"});
        } else if (tab === "inspect" && this.state.devices.includes(this.state.device)) {
            if (!this.elements.canReuseSnapshot()) await this.perform(() => this.refreshInspector());
        } else if (tab === "recordings" && !this.state.draft) {
            await this.perform(async () => {
                await this.refreshCases();
                await this.refreshPlanSummary();
            });
        }
    }

    async revealView(view) {
        if (view === "explore") return this.openLiveDevice();
        if (view === "exploration") return this.openTool(view);
        if (!recordingViews.has(view) || this.state.busy || this.state.draft || this.state.caseReview) return;
        this.state.tool = "recordings";
        this.state.mode = view;
        this.publish();
        if (view === "recordings") await this.perform(() => this.refreshCases());
        if (view === "workflow") await this.perform(() => this.refreshPlanSummary());
        if (view === "history") await this.perform(() => this.explorations.history());
    }

    openLiveDevice() {
        this.open();
        this.livePanel.focus();
    }

    async sendLiveGesture(device, input, isCurrent, sessions, anchor) {
        if (this.state.device !== device || !isCurrent()) return this.text.liveChanged;
        if (this.recordingControls) return this.perform(() => this.recordControlGesture(input,isCurrent,anchor));
        if (this.state.draft && (!this.state.recording || this.state.draft.location !== "preview")) return this.text.liveRecording;
        return this.perform(async () => {
            const agent = this.agent;
            let session = sessions.get(device);
            if (!session) {
                session = "vscode-display-" + randomUUID();
                await agent.call("attach", { session, device });
                sessions.set(device, session);
            }
            await agent.call("claim", { session });
            try {
                if (!isCurrent()) throw new Error(this.text.liveChanged);
                this.state.page = this.state.liveImage = undefined;
                if (this.state.tool === "inspect") this.publish();
                const started = Date.now();
                await replayGesture({ device, hdcPath: this.config.get("hdcPath"), isCurrent }, input);
                this.networks.mark(input.kind,started,Date.now());
                if (this.state.recording) {
                    const step = { command: "deviceGesture", input };
                    if (this.lastScreenStepAt) step.delayMs = Math.max(0, started - this.lastScreenStepAt);
                    this.state.draft.steps.push(step);
                    this.lastScreenStepAt = Date.now();
                }
            } finally {
                await agent.call("release", { session });
            }
            await this.refreshInspector(isCurrent);
        });
    }

    async recordControlGesture(input, isCurrent, anchor) {
        if (!isCurrent()) throw new Error(this.text.liveChanged);
        const command = controlCommands.get(input.kind);
        if (!command) throw new Error(this.text.recordingGestureOnly);
        if (command === "back") return this.act({command});
        const direction = command === "scroll" ? scrollDirection(input) : undefined;
        if (command === "scroll" && !direction) throw new Error(this.text.recordingScrollControl);
        await this.observe(isCurrent);
        if (!isCurrent()) throw new Error(this.text.liveChanged);
        const {node,locator,issue} = controlTarget(this.state.page,command,anchor || input);
        if (issue) throw new Error(this.text[issue]);
        await this.act({command,ref:node.ref,direction,text:input.text,frameId:this.state.page.frameId},locator);
    }

    async listDevices() {
        const { devices } = await this.agent.call("devices");
        this.state.devices = devices.map(device => device.id);
        await this.networks.devicesChanged(this.state.devices);
        if (!this.state.draft && !this.networks.activeCapture && !this.state.devices.includes(this.state.device)) {
            this.state.device = devices.length === 1 ? devices[0].id : undefined;
            this.state.page = this.state.liveImage = undefined;
            this.state.actions = [];
            await this.refreshInspector();
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
        this.state.actions = [];
        await this.refreshInspector();
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
        const result = await this.agent.call("start", {
            device: this.state.device, session: this.session, ...(fullControls ? controlTreeOptions : observationOptions),
        });
        if (isCurrent && !isCurrent()) return;
        this.state.page = pageView(result.observation,{elements:fullControls});
    }

    async refreshInspector(isCurrent) {
        if (!this.state.device || this.state.tool !== "inspect" || (isCurrent && !isCurrent())) return;
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
            this.state.draft.steps.push({ command, input, label });
        }
    }

    async startRecording({ location, stepFormat }) {
        if (this.state.draft) {
            this.state.tool = "recordings";
            return;
        }
        if (this.state.caseReview) throw new Error(this.text.activeRecording);
        if (!this.state.devices.includes(this.state.device)) throw new Error(this.text.selectDevice);
        if (!["preview", "phone"].includes(location) || !["controls", "coordinates"].includes(stepFormat)) return;
        if (location === "phone" && stepFormat === "controls") throw new Error(this.text.recordPhoneCoordinateOnly);

        this.state.tool = "recordings";
        if (stepFormat === "controls") await this.observe(undefined, true);
        if (this.livePanel) {
            this.livePanel.paused = false;
            this.livePanel.error = undefined;
        }
        this.lastScreenStepAt = undefined;
        const draft = {
            location, stepFormat,
            start: stepFormat === "controls" ? boundaryControls(this.state.page) : [],
            steps: [],
        };
        delete this.state.aiResults.check;
        this.state.draft = draft;
        this.state.recording = true;
        if (location !== "phone") return;

        this.state.page = undefined;
        this.state.liveImage = undefined;
        const capture = this.capture = {};
        capture.ready = startRecorder({
            device: this.state.device, hdcPath: this.config.get("hdcPath"), stateDir: this.stateDir,
            onStep: step => {
                draft.steps.push(step);
                this.publish();
            },
            onError: error => {
                if (this.capture !== capture) return;
                this.capture = undefined;
                this.state.recording = false;
                this.state.mode = "workflow";
                this.state.error = this.errorMessage(error);
                this.publish();
            },
        });
        try {
            capture.handle = await capture.ready;
        } catch (error) {
            if (this.capture === capture) this.capture = undefined;
            this.state.recording = false;
            if (!draft.steps.length) this.state.draft = undefined;
            this.state.mode = draft.steps.length ? "workflow" : "recordings";
            throw error;
        }
    }

    async stopRecording() {
        const draft = this.state.draft;
        if (!this.state.recording || !draft) return;
        const capture = this.capture;
        try {
            if (capture) {
                capture.closing ??= capture.handle ? capture.handle.stop() : capture.ready.then(handle => handle.stop());
                await capture.closing;
            }
        } finally {
            this.capture = undefined;
            this.state.recording = false;
            draft.end = draft.stepFormat === "controls" ? boundaryControls(this.state.page) : [];
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
        return draft.stepFormat === "controls" ? recordedPlan(draft.steps, start, goal, property, expected)
            : { format: deviceRecordingFormat, version: 1, steps: draft.steps };
    }

    editRecordedSteps({type,index,from,to,revision}) {
        const {draft,recording,caseReview,tool} = this.state;
        if (!draft || recording || caseReview || tool!=="recordings") return;
        const current = draft.stepRevision || 0;
        if (type==="moveRecordedStep") {
            if (current!==revision || !moveListItem(draft.steps,from,to)) return;
        } else {
            if ((revision!==undefined && current!==revision) || !Number.isInteger(index) || index<0 || index>=draft.steps.length) return;
            draft.steps.splice(index,1);
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

    async refreshCases() {
        this.state.cases = await this.caseLibrary.list(this.state.runs);
    }

    async openCase(id) {
        if (this.state.draft) throw new Error(this.text.activeRecording);
        const item = this.state.cases.find(row => row.uri === id);
        if (!item) throw new Error(this.text.chooseSavedPlan);
        await this.setPlan(vscode.Uri.parse(item.uri));
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
        if (message.runner !== "workbench" && this.state.pytestCase) return this.usePytest(true);
        return this.executePlan(false);
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
            plan = file.plan;
            group = file.scenario || this.networks.bindings[selected.uri];
        }
        const issue = readiness(plan);
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
        let entry;
        try { entry = await writeCase(parent[0].fsPath, name, plan, group); }
        catch (error) {
            if (error.code === "EEXIST") throw new Error(zh ? "这个用例目录已经存在。请选择新的名称，或打开已有用例。" :
                "This case folder already exists. Choose a new name or open the existing case.");
            throw error;
        }
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
        if (!file.scenario && this.networks.bindings[this.state.plan.uri]) throw new Error(/^zh/i.test(this.language) ?
            "项目用例还没有包含工作区绑定的规则组。请生成包含当前绑定的新用例。" : "Create a new case to include the rule group bound in this workspace.");
        if (entry.requiresRuleGroup && !file.scenario) throw new Error(/^zh/i.test(this.language) ?
            "请在 workflow.json 中恢复此用例需要的规则组快照。" : "Restore this case's required rule group snapshot in workflow.json.");
        const digest = sourceDigest(document.getText());
        let active, result;
        try {
            result = await startPytest(vscode, this, {...entry, requiresRuleGroup: entry.requiresRuleGroup || Boolean(file.scenario)}, {
                ...options,
                onRunning:(run,locate,candidate)=>{
                    active = run;
                    Object.assign(run,{sourceDigest:digest,caseId:this.state.activeCase?.id});
                    if (options.repairOf) run.repairOf = options.repairOf;
                    return this.showRunning(run,candidate || file.plan,file.scenario,locate);
                },
            });
        } catch (error) {
            if (this.state.run?.entry === active && active) {
                active.status = "unknown";
                this.state.run.error = this.errorMessage(error);
            }
            throw error;
        }
        if (result) {
            if (!options.repairOf) this.state.pytestOutcome = {uri: this.state.plan.uri, code: result.code, at: new Date().toISOString()};
            if (result.entry) {
                Object.assign(result.entry, {sourceDigest: digest, caseId: this.state.activeCase?.id});
                if (options.repairOf) result.entry.repairOf = options.repairOf;
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
        this.state.activeCase = this.state.cases.find(row => row.uri === uri.toString());
        const name = this.state.activeCase?.name || path.basename(uri.path);
        this.state.plan = { name, uri: uri.toString() };
        this.state.planSummary = undefined;
        this.state.planDigest = undefined;
        this.state.caseBdd = undefined;
        this.state.caseDefinitions = undefined;
        this.state.pytestReadiness = undefined;
        this.state.pytestCase = this.context.workspaceState.get("pytestCases", {})[uri.toString()];
        this.state.mode = "workflow";
        await this.context.workspaceState.update("plan", this.state.plan);
        await this.refreshPlanSummary();
    }

    async refreshPlanSummary() {
        const plan = this.state.plan;
        if (!plan) return;
        const request = this.planRead = Symbol();
        const activeCase = this.state.cases.find(row => row.uri === plan.uri);
        let summary, digest, bdd, definitions, pytestReadiness, entry = this.context.workspaceState.get("pytestCases", {})[plan.uri];
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
                    digest = sourceDigest(contents);
                    bdd = createBdd(file.plan, this.language, file.scenario || this.networks.bindings[plan.uri]);
                    if (activeCase && await canEditCase(uri,activeCase)) definitions = caseDefinitions(file.plan);
                }
                if(summary && file.scenario) summary.scenarioName=String(file.scenario.name || this.text.netUntitledGroup);
            } catch {
                // JSON parser diagnostics can contain fragments of private step inputs.
            }
            summary ??= { error: this.text.planFileInvalid };
        } catch {
            summary = { error: this.text.planFileUnavailable };
        }
        if (this.planRead === request && this.state.plan === plan) {
            this.state.planSummary = summary;
            this.state.planDigest = digest;
            this.state.caseBdd = bdd;
            this.state.caseDefinitions = definitions;
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
        if (this.panel?.visible && this.state.plan?.uri === uri.toString()) {
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
    }

    showRunning(entry, plan, group, locate) {
        this.state.mode = "run";
        const run = this.state.run = {entry,steps:[],selected:0,bdd:createBdd(plan,this.language,group)};
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

    async executePlan(fromRun, trial) {
        if (this.state.draft) throw new Error(this.text.activeRecording);
        if (!this.state.device) throw new Error(this.text.selectDevice);
        const selected = this.planForRun(fromRun);
        if (!selected) throw new Error(this.text.chooseSavedPlan);
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(selected.uri));
        const contents = document.getText();
        const {plan,scenario} = readWorkflow(trial?.contents || contents);
        const entry = { id: randomUUID(), plan: selected, status: "running", time: new Date().toISOString(),
            sourceDigest: sourceDigest(contents), caseId: this.state.cases.find(row => row.uri === selected.uri)?.id };
        if (trial) entry.repairOf = trial.repairOf;
        await this.prepareFlowScenario(selected,scenario,entry.id);
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
        const group = scenario || this.networks.bindings[selected.uri];
        const stopProgress = this.showRunning(entry,plan,group,locate);
        if (entry.source === "device") {
            await this.replayDevicePlan(entry, plan);
            return;
        }
        let result;
        try {
            const request = { session: this.session, run_id: entry.id, plan, output: "full", ...observationOptions };
            if (plan.preconditions?.length && plan.goals?.length) {
                result = await this.agent.call("execute", { ...request, device: this.state.device });
            } else {
                // execute requires both boundary checks. A session run journals the same steps and frames.
                await this.agent.call("start", { device: this.state.device, session: this.session, max_nodes: 1, compact: true });
                result = await this.agent.call("run", request);
                entry.cleanup = "retained";
                if (result.status === "completed") {
                    try {
                        await this.agent.call("detach", { session: this.session });
                        entry.cleanup = "detached";
                    } catch (error) {
                        entry.cleanup = "failed";
                        this.state.error = this.errorMessage(error);
                    }
                }
            }
        } catch (error) {
            entry.status = ["INVALID_PLAN","INVALID_ARGUMENT","INVALID_REQUEST"].includes(error.code) ? "rejected" : "unknown";
            this.state.run.error = this.errorMessage(error);
            await this.persistRuns();
            throw error;
        } finally {
            stopProgress?.();
        }
        await this.setRun(entry, result, plan, group);
        return entry;
    }

    async replayDevicePlan(entry, plan) {
        const run = this.state.run;
        run.goalStatus = "not_requested";
        const controller = this.nativeReplay = new AbortController();
        const target = { device: this.state.device, hdcPath: this.config.get("hdcPath") };
        const session = this.session;
        try {
            if (plan.version !== 1 || !Array.isArray(plan.steps) || !plan.steps.length ||
                plan.preconditions?.length || plan.goals?.length) throw new Error(this.text.invalidDevicePlan);
            for (const step of plan.steps) {
                if (step?.command !== "deviceGesture" || !step.input) throw new Error(this.text.invalidDevicePlan);
                if (step.input.kind === "unsupported") throw new Error(this.text.unsupportedDeviceStep);
                validateGesture(step.input);
                if (step.delayMs !== undefined && (!Number.isSafeInteger(step.delayMs) ||
                    step.delayMs < 0 || step.delayMs > 2_147_483_647)) throw new Error(this.text.invalidDevicePlan);
            }
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
            await this.replayGestures(plan.steps, run, target, controller.signal, started);
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

    async replayGestures(steps, run, target, signal, started) {
        for (const [index, step] of steps.entries()) {
            const receipt = {
                path: `steps[${index}]`, kind: "command", command: step.input.kind, gesture: step.input,
                label: step.label, status: "running",
                ...(step.delayMs !== undefined && {delayMs:step.delayMs}),
            };
            run.selected = index;
            run.steps.push(receipt);
            this.publish();
            let attempted = false;
            try {
                if (step.delayMs) await delay(step.delayMs, undefined, { signal });
                signal.throwIfAborted();
                const dispatchedAt = Date.now();
                attempted = true;
                await replayGesture(target, step.input);
                receipt.elapsedMs = Date.now() - dispatchedAt;
                receipt.at = new Date().toISOString();
                receipt.status = "completed";
                receipt.dispatched = "acknowledged";
            } catch (error) {
                receipt.status = signal.aborted && !attempted ? "cancelled" : "unknown";
                run.error = receipt.error = this.errorMessage(error);
            }
            run.runtimeMs = Date.now() - started;
            await this.context.workspaceState.update("gestures." + run.entry.id, {
                steps: run.steps, error: run.error, runtimeMs: run.runtimeMs, bdd:run.bdd,
            });
            if (receipt.status !== "completed") break;
        }
    }

    async openReport(id, {reveal=true} = {}) {
        const entry = this.state.runs.find(run => run.id === id);
        if (!entry) return;
        if (reveal) {
            this.state.tool = "recordings";
            const associated = this.planForEntry(entry);
            if (associated.uri !== this.state.plan?.uri) await this.setPlan(vscode.Uri.parse(associated.uri));
        }
        this.state.mode = "run";
        this.state.run = { entry };
        if (entry.source === "pytest") {
            const report = await loadPytestRun(entry,this.language);
            this.state.run = {...report, entry};
            if (report.steps?.length) await this.inspectStep(report.selected ?? 0);
            return;
        }
        if (entry.source === "device") {
            const report = this.context.workspaceState.get("gestures." + entry.id, { steps: [] });
            this.state.run = { ...report, entry, status: entry.status, cleanup: entry.cleanup, goalStatus: "not_requested",
                selected: Math.max(report.steps.length - 1, 0) };
            return;
        }
        const record = await this.agent.call("report", { run_id: id, full: true });
        await this.setRun(entry, record);
    }

    async setRun(entry, record, plan, group) {
        if (!plan && /^[a-zA-Z0-9_-]+$/.test(entry.id)) {
            try { plan = JSON.parse(await fs.readFile(path.join(this.stateDir,"runs",entry.id,"plan.json"),"utf8")); }
            catch (error) {
                if (error.code !== "ENOENT" && error.code !== "ENOTDIR" && !(error instanceof SyntaxError)) throw error;
            }
        }
        const view = withAuthoredTargets(runView(record), plan);
        if (!group && plan) group = await this.networks.scenarioForRun(entry.id);
        entry.status = view.status;
        this.state.run = { entry, ...view, bdd:createBdd(plan,this.language,group), cleanup: entry.cleanup || view.cleanup };
        await this.persistRuns();
        await this.inspectStep(view.selected);
    }

    async inspectStep(index, phase) {
        const run = this.state.run;
        const step = run?.steps?.[index];
        if (!step) return;
        run.selected = index;
        run.phase = phase || (step.after ? "after" : "before");
        run.frame = undefined;
        delete run.frameError;
        run.image = await this.reportImage(run,step,index);
        const frameId = step[run.phase];
        if (frameId) {
            try {
                const frozen = await this.reportAgent(run.entry).call("inspect", { run_id: run.entry.id, frame_id: frameId, max_nodes: 180 });
                run.frame = pageView(frozen);
            } catch (error) {
                if (run.entry.source !== "pytest") throw error;
                run.frameError = this.errorMessage(error);
            }
        }
    }

    reportAgent(entry) {
        const agent = this.agent;
        if (entry?.pytest?.stateDir) agent.stateDir = entry.pytest.stateDir;
        return agent;
    }

    baseline() {
        const current = this.state.run?.entry;
        return current && current.source !== "device" && this.state.runs.find(entry =>
            entry.status === "passed" && (!entry.repairOf || entry.repairApplied) && this.planForEntry(entry)?.uri === this.planForEntry(current)?.uri && entry.time < current.time);
    }

    async compare() {
        const baseline = this.baseline();
        const run = this.state.run;
        if (!baseline || !run.steps) return;
        if (run.comparison) {
            delete run.comparison;
        } else {
            const earlier = baseline.source === "pytest" ? await loadPytestRun(baseline) :
                runView(await this.agent.call("report", { run_id: baseline.id, full: true }));
            run.comparison = { difference: compareRuns(run, earlier) };
        }
    }
}

let activeWorkbench;
function activate(context) {
    const workbench = activeWorkbench = new Workbench(context);
    registerCopilotMcp(vscode, context, workbench);
    registerWorkbenchLauncher(vscode, workbench);
    context.subscriptions.push(
        vscode.commands.registerCommand("harmonyAgent.openWorkbench", () => workbench.open()),
        ...[...workspaceTools].map(([tab,tool]) =>
            vscode.commands.registerCommand(tool.command, () => workbench.openTool(tab))),
        vscode.commands.registerCommand("harmonyAgent.openLiveDevice", () => workbench.openLiveDevice()),
        vscode.commands.registerCommand("harmonyAgent.askAI", () => workbench.openTask()),
        vscode.commands.registerCommand("harmonyAgent.openAIChat", () => workbench.openAI()),
        vscode.commands.registerCommand("harmonyAgent.openPlan", async () => {
            await workbench.openTool("recordings");
            await workbench.perform(() => workbench.choosePlan());
        }),
        vscode.commands.registerCommand("harmonyAgent.openEvidence", async () => {
            try { await openProblemClip(workbench,vscode); }
            catch (error) { void vscode.window.showErrorMessage(workbench.errorMessage(error)); }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration("harmonyAgent.language") || event.affectsConfiguration("harmonyAgent.aiProvider")) workbench.publish();
            if (event.affectsConfiguration("harmonyAgent.language") && workbench.state.plan) void workbench.refreshPlanSummary();
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
