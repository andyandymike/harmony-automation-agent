"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const Module = require("node:module");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { after, mock, test } = require("node:test");
const { recordedPlan } = require("../src/model");
const { summarizePlan } = require("../src/planSummary");
const { validateGesture } = require("../src/deviceRecorder");

const workbenchFixtures = mkdtempSync(path.join(tmpdir(), "harmony-recording-"));
after(() => rmSync(workbenchFixtures, { recursive: true, force: true }));

function latch() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

// Drive the same commands and webview messages as an installed extension.
function openWorkbench(agent, recorder = {}, display, selectedPlan, runs = [], configureHost, {openOnStart = true} = {}) {
    const commands = new Map();
    const storage = new Map();
    const storagePath = mkdtempSync(path.join(workbenchFixtures, "workspace-"));
    storage.set("runs", runs);
    if (selectedPlan) storage.set("plan", selectedPlan);
    let state, navigation, sidebar, receive, disposePanel, saved, panel, notifyView, notifySidebar, notifyEdit, panelCount = 0;
    let sidebarCloses = 0;
    const live = { messages: [] };
    const uri = { fsPath: path.join(storagePath, "recording.json"), path: "/recording.json", toString: () => "file:///recording.json" };
    const vscode = {
        env: { language: "en" }, ViewColumn: { Active: 1 }, RelativePattern: class {},
        Uri: { joinPath: () => uri, file: () => uri, parse: () => uri },
        commands: {
            registerCommand: (key, handler) => commands.set(key, handler),
            async executeCommand(key) {
                assert.equal(key, "workbench.action.closeSidebar");
                sidebarCloses++;
                sidebar.visible = false;
                notifySidebar({visible:false});
            },
        },
        workspace: {
            getConfiguration: () => ({ get: (key, fallback) => fallback }),
            onDidChangeConfiguration() {},
            textDocuments: [],
            onDidChangeTextDocument(fn) { notifyEdit = fn; },
            createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
            fs: { async writeFile(_, bytes) { saved = JSON.parse(bytes.toString()); },
                async readFile() { return Buffer.from(JSON.stringify(saved)); } },
            openTextDocument: async () => ({ getText: () => JSON.stringify(saved) }),
        },
        window: {
            createTreeView(id, options) {
                assert.equal(id, "harmonyAgent.launcher");
                sidebar = {
                    provider: options.treeDataProvider, visible: false, dispose() {},
                    onDidChangeVisibility(fn) { notifySidebar = fn; return {dispose() {}}; },
                };
                return sidebar;
            },
            showSaveDialog: async () => uri,
            createWebviewPanel(type) {
                assert.equal(type, "harmonyAgent.workbench");
                panelCount++;
                panel = {
                    visible: true, reveal() {
                        if (this.visible) return;
                        this.visible = true;
                        notifyView();
                    },
                    onDidChangeViewState(fn) { notifyView = fn; },
                    onDidDispose(fn) { disposePanel = fn; }, dispose() { disposePanel(); },
                    webview: { asWebviewUri: () => "", onDidReceiveMessage(fn) { receive = fn; },
                        postMessage(event) {
                            if (!event.state) { live.messages.push(structuredClone(event)); return; }
                            state = structuredClone(event.state);
                            navigation = structuredClone(event.navigation);
                        } },
                };
                return panel;
            },
        },
    };
    configureHost?.(vscode, storage);
    const loader = Module._load;
    const stub = mock.method(Module, "_load", function (id, ...args) {
        if (id === "vscode") return vscode;
        if (id === "./deviceRecorder") return { validateGesture, ...recorder };
        if (id === "./liveDisplay" && display) return { async openLiveDisplay(options) {
            display.onOpen?.(options);
            return {async drain() {},...display};
        } };
        if (id === "./agent") return { AgentClient: class { call(...params) { return agent(...params); } } };
        return loader.call(this, id, ...args);
    });
    const entry = require.resolve("../src/extension");
    delete require.cache[entry];
    delete require.cache[require.resolve("../src/liveDevicePanel")];
    let extension;
    try { extension = require(entry); } finally { stub.mock.restore(); }
    extension.activate({ globalStorageUri: { fsPath: storagePath }, extensionUri: uri, subscriptions: [],
        workspaceState: { get: (k, fallback) => storage.get(k) ?? fallback,
            async update(k, v) { storage.set(k, structuredClone(v)); } },
    });
    if (openOnStart) commands.get("harmonyAgent.openWorkbench")();
    live.send = message => receive({ ...message, channel: "live" });
    return {
        live,
        screenshotPath: filename => path.join(storagePath, "agent", filename),
        get navigation() { return navigation; },
        get sidebarVisible() { return sidebar.visible; },
        get sidebarCloses() { return sidebarCloses; },
        sidebarItems() { return sidebar.provider.getChildren(); },
        setSidebarVisible(visible) {
            if (sidebar.visible === visible) return;
            sidebar.visible = visible;
            notifySidebar({visible});
        },
        send(type, fields) { return receive({ type, ...fields }); },
        openLive() { commands.get("harmonyAgent.openLiveDevice")(); return live; },
        runCommand(key) { return commands.get(key)(); }, get panelCount() { return panelCount; },
        setVisible(visible) { panel.visible = visible; notifyView(); },
        editFile(text) {
            vscode.workspace.textDocuments = [{ isDirty: true, uri, getText: () => text }];
            notifyEdit({ document: vscode.workspace.textDocuments[0] });
        },
        get state() { return state; }, get saved() { return saved; }, close: () => disposePanel(),
        deactivate: () => extension.deactivate(),
    };
}

test("opening a local workflow does not wait for startup case indexing or phone detection", async () => {
    const discovery = latch(), index = latch(), probeStarted = latch(), indexStarted = latch();
    const plan = { version: "1", steps: [{ command: "back", input: {} }] };
    let signal;
    const bench = openWorkbench(async (command, _input, options) => {
        assert.equal(command, "devices");
        signal = options.signal;
        probeStarted.resolve();
        return discovery.promise;
    }, {}, undefined, undefined, [], vscode => {
        const root = vscode.Uri.file("/fixture");
        root.scheme = "file";
        vscode.workspace.workspaceFolders = [{ name: "slow project", uri: root }];
        vscode.workspace.findFiles = async () => { indexStarted.resolve(); return index.promise; };
        vscode.window.showOpenDialog = async () => [vscode.Uri.file("/fixture/recording.json")];
        vscode.workspace.fs.readFile = async () => Buffer.from(JSON.stringify(plan));
    });
    const initializing = bench.send("ready");
    try {
        await Promise.all([probeStarted.promise, indexStarted.promise]);
        assert.equal(bench.state.discoveringDevices, true);
        assert.equal(bench.state.casesLoading, true);
        assert.equal(Boolean(bench.state.busy), false);
        await bench.send("openPlan");
        assert.equal(bench.state.plan.name, "recording.json");
        assert.equal(bench.state.planSummary.stepCount, 1);
        assert.equal(bench.state.discoveringDevices, true);
        assert.equal(bench.state.casesLoading, true);
    } finally {
        bench.close();
        assert.equal(signal?.aborted, true);
        index.resolve([]);
        discovery.resolve({ devices: [{ id: "late-device" }] });
        await initializing;
        await bench.deactivate();
    }
    assert.deepEqual(bench.state.devices, []);
});

test("recording and existing workflow actions generate editable pytest cases and keep a cancelled draft", async t => {
    const fs = require("node:fs/promises");
    const os = require("node:os");
    const path = require("node:path");
    const {pathToFileURL, fileURLToPath} = require("node:url");
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-workbench-case-"));
    t.after(() => fs.rm(parent, {recursive:true, force:true}));
    const uri = file => ({scheme:"file", path:file.replaceAll("\\","/"), fsPath:file, toString:() => pathToFileURL(file).href});
    const observed = {frameId:"frame", nodes:[{ref:"@login", id:"login", clickable:true}]};
    let name, opened, activeDocument, storage;
    const bench = openWorkbench(async command => {
        if (command === "devices") return {devices:[{id:"synthetic"}]};
        return {observation:observed, afterFrameId:"frame"};
    }, {}, undefined, undefined, [], (vscode, localState) => {
        storage = localState;
        vscode.Uri.file = uri;
        vscode.Uri.parse = text => uri(fileURLToPath(text));
        vscode.window.showOpenDialog = async () => [uri(parent)];
        vscode.window.showInputBox = async () => name;
        vscode.window.showTextDocument = async file => {opened = file;};
        vscode.workspace.fs.readFile = file => fs.readFile(file.fsPath);
        vscode.workspace.openTextDocument = async file => {
            const content = activeDocument ?? await fs.readFile(file.fsPath, "utf8");
            return {getText:() => content};
        };
    });
    t.after(() => bench.deactivate());
    await bench.send("devices");
    await bench.send("startRecord", { location: "preview", stepFormat: "controls" });
    await bench.send("action", {command:"press", ref:"@login", frameId:"frame"});
    await bench.send("stopRecord");
    await bench.send("createPytest");
    assert.match(bench.state.error, /starting precondition/);
    const checks={startRef:"@login",goalRef:"@login",property:"visible",expected:true};
    await bench.send("createPytest", checks);
    assert.ok(bench.state.draft);
    await bench.send("caseReview", checks);
    assert.equal(bench.state.caseReview.source,"recording");
    assert.equal(bench.state.caseReview.bdd.given.length,1);
    assert.equal(bench.state.caseReview.bdd.when.length,1);
    assert.equal(bench.state.caseReview.bdd.then.length,1);
    await bench.send("caseSave",{id:bench.state.caseReview.id});
    assert.ok(bench.state.draft);
    name="first case";
    await bench.send("caseSave",{id:bench.state.caseReview.id});
    assert.equal(bench.state.draft, undefined);
    assert.equal(bench.state.mode, "workflow");
    assert.equal(bench.state.pytestReadiness.issue, undefined);
    assert.deepEqual(bench.state.planSummary.hasGoal, true);
    const first = bench.state.plan.uri;
    await bench.send("openRecordingWorkspace");
    assert.ok(bench.state.cases.some(c=>c.uri === first && c.source==="recording"));
    await bench.send("caseOpen",{id:first});
    assert.equal(bench.state.activeCase.name,"first case");
    const firstEntry = bench.state.pytestCase;
    const firstPlan = JSON.parse(await fs.readFile(fileURLToPath(first), "utf8"));
    assert.deepEqual(firstPlan.preconditions[0].selector, {id:"login"});
    assert.deepEqual(firstPlan.goals[0].equals, true);
    await bench.send("openPytest");
    assert.equal(opened.fsPath, path.join(firstEntry.folder, firstEntry.filename));

    // An existing flow may have a dirty editor and a workspace-bound network dependency.
    name="with group";
    const group = {version:1,name:"network sample",rules:[]};
    storage.set("network.scenarios", {[first]:group});
    activeDocument = JSON.stringify({...firstPlan, goals:[{...firstPlan.goals[0],equals:false}]});
    await bench.send("createPytest");
    assert.equal(bench.state.pytestCase.requiresRuleGroup, true);
    const next = JSON.parse(await fs.readFile(fileURLToPath(bench.state.plan.uri),"utf8"));
    assert.equal(next.scenario.name, group.name);
    assert.equal(next.workflow.goals[0].equals, false);
    assert.deepEqual(JSON.parse(await fs.readFile(fileURLToPath(first),"utf8")),firstPlan);
});

test("workbench commands open the corresponding offline tab without a navigation view", async () => {
    let language = "zh-CN", languageChanged;
    const bench = openWorkbench(async command => {
        assert.equal(command, "devices");
        throw new Error("HDC unavailable");
    }, {}, undefined, undefined, [], vscode => {
        vscode.workspace.getConfiguration = () => ({get:(key,fallback) => key === "language" ? language : fallback});
        vscode.workspace.onDidChangeConfiguration = listener => {
            languageChanged = () => listener({affectsConfiguration:key => key === "harmonyAgent.language"});
        };
    }, {openOnStart:false});
    const labels = ["测试", "元素", "网络调试", "AI 探索"];
    assert.deepEqual(bench.sidebarItems(), []);
    assert.equal(bench.panelCount, 0);
    const openingNetwork = bench.runCommand("harmonyAgent.network");
    assert.equal(bench.state.tool, "network");
    await Promise.all([openingNetwork, bench.send("ready")]);
    assert.equal(bench.state.tool, "network");
    assert.ok(bench.state.network);
    assert.equal(bench.state.error, "");
    assert.deepEqual(bench.navigation.tools.map(item => item.label), labels);
    assert.equal(bench.navigation.selected, "network");
    await bench.runCommand("harmonyAgent.recordings");
    assert.equal(bench.state.tool, "recordings");
    assert.equal(bench.state.error, "");
    await bench.runCommand("harmonyAgent.exploration");
    assert.equal(bench.state.tool, "exploration");
    await bench.runCommand("harmonyAgent.inspect");
    assert.equal(bench.state.tool, "inspect");
    assert.equal(bench.state.device, undefined);
    assert.equal(bench.panelCount, 1);
    language = "en";
    languageChanged();
    assert.deepEqual(bench.navigation.tools.map(item => item.label),
        ["Tests","Elements","Network","AI exploration"]);
    assert.equal(bench.sidebarCloses, 0);
    await bench.deactivate();
});

test("long workflow previews identify each target and default text assertion without leaking filled values", () => {
    const plan = {steps: [
        {command: "open", input: {app: "com.example.shop"}},
        ...["cart", "product", "add", "checkout"].map(id => ({command: "press", input: {target: {id}}})),
        {command: "fill", input: {target: {id: "address"}, text: "private input"}},
        {assert: {selector: {id: "notice"}, equals: "Saved"}}
    ], preconditions: [{selector: {id: "cart"}, property: "visible", equals: true}],
       goals: [{selector: {id: "password", type: "TextInput"}, equals: "private expectation"}]};
    const preview = summarizePlan(plan);
    assert.equal(preview.commands.length, 5);
    assert.deepEqual(preview.rows.map(row => row.detail), ["com.example.shop", "cart", "product", "add",
        "checkout", "address", 'notice · text = "Saved"']);
    assert.deepEqual(preview.initialChecks, ["cart · visible = true"]);
    assert.deepEqual(preview.finalChecks, ["password · text = ••••"]);
    assert.doesNotMatch(JSON.stringify(preview), /private/);
});

test("the activity bar opens one editor and closes the launcher sidebar on each use", async () => {
    const calls = [];
    let closed = 0;
    const bench = openWorkbench(async (command) => {
        calls.push(command);
        if (command === "devices") return { devices: [{ id: "phone" }] };
        if (command === "start") return { observation: { frameId: "page", nodes: [] } };
        if (command === "screenshot") return {path:bench.screenshotPath("page.png")};
    }, {}, {
        async nextFrame() { return { data: Buffer.from([1]), width: 30, height: 100, mime: "image/jpeg" }; },
        async close() { closed++; },
    }, undefined, [], undefined, {openOnStart:false});
    assert.equal(bench.panelCount, 0);
    bench.setSidebarVisible(true);
    assert.equal(bench.panelCount, 1);
    assert.equal(bench.sidebarVisible, false);
    assert.equal(bench.sidebarCloses, 1);
    const {live} = bench;
    await Promise.all([bench.send("ready"), live.send({ type: "ready" })]);
    assert.deepEqual(calls, ["devices"]);
    assert.equal(bench.state.mode, "recordings");
    assert.equal(bench.state.device, "phone");
    assert.equal(live.messages.at(-1).streaming, true);
    await bench.runCommand("harmonyAgent.openLiveDevice");
    assert.equal(live.messages.at(-1).focusPreview, true);
    assert.equal(bench.state.tool, "recordings");
    const epoch = live.messages.at(-1).epoch;
    await live.send({ type: "nextFrame", epoch });
    assert.equal(live.messages.at(-1).type, "frame");
    bench.setVisible(false);
    assert.equal(live.messages.at(-1).streaming, false);
    const count = live.messages.length;
    await live.send({ type: "nextFrame", epoch });
    assert.equal(live.messages.length, count);
    bench.setVisible(true);
    const visibleEpoch = live.messages.at(-1).epoch;
    await bench.send("view", { view: "history" });
    assert.equal(bench.state.testView, "history");
    assert.equal(live.messages.at(-1).streaming, true);
    await bench.send("view", { view: "inspect" });
    assert.equal(bench.state.page.frameId, "page");
    assert.equal(bench.state.tool, "inspect");
    assert.equal(bench.state.elements.picking, true);
    assert.equal(bench.state.elements.picture.frameId, "page");
    assert.equal(live.messages.at(-1).streaming, false);
    assert.equal(live.messages.at(-1).picking, true);
    assert.notEqual(live.messages.at(-1).epoch,visibleEpoch);
    await bench.send("elementMode", {picking:false});
    assert.equal(live.messages.at(-1).streaming, true);
    const resumedEpoch = live.messages.at(-1).epoch;
    await bench.runCommand("harmonyAgent.askAI");
    assert.equal(bench.panelCount, 1);
    assert.equal(bench.state.tool, "exploration");
    assert.equal(live.messages.at(-1).focusTask, true);
    assert.equal(live.messages.at(-1).streaming, true);
    bench.runCommand("harmonyAgent.openWorkbench");
    assert.equal(bench.state.tool, "exploration");
    assert.equal(bench.sidebarCloses, 1);
    await bench.send("workspaceTab", {view:"recordings"});
    assert.equal(bench.state.testView, "history");
    assert.equal(live.messages.at(-1).epoch, resumedEpoch);
    assert.equal(live.messages.at(-1).streaming, true);
    bench.setVisible(false);
    bench.setSidebarVisible(true);
    assert.equal(bench.panelCount, 1);
    assert.equal(bench.state.testView, "history");
    assert.equal(bench.sidebarVisible, false);
    assert.equal(bench.sidebarCloses, 2);
    await bench.deactivate();
    assert.equal(closed, 1);
});

test("the element overlay replaces the live frame, blocks stale touches and restores phone controls", async () => {
    const calls = [];
    const previewModes = [];
    const readingFrame = latch();
    const finishFrame = latch();
    const touching = latch();
    const finishTouch = latch();
    let captures = 0, observations = 0;
    const nodes = [{ ref: "@item", id: "item", clickable: true }];
    const bench = openWorkbench(async command => {
        calls.push(command);
        if (command === "devices") return { devices: [{ id: "phone" }] };
        if (command === "start") return { observation: { frameId: "read-" + ++observations, nodes } };
        if (command === "press") return { observation: { frameId: "pressed", nodes } };
        if (command === "screenshot") return {path:bench.screenshotPath("captured.png")};
    }, {
        async replayGesture({ device }, input) {
            assert.equal(device, "phone");
            assert.deepEqual(input, { kind: "click", x: 5, y: 8 });
            calls.push("touch");
            touching.resolve();
            await finishTouch.promise;
        },
    }, {
        onOpen({ prefetch }) { previewModes.push(prefetch); },
        async nextFrame() {
            if (++captures === 2) {
                readingFrame.resolve();
                await finishFrame.promise;
            }
            return { data: Buffer.from([1]), width: 30, height: 100, mime: "image/jpeg" };
        },
        async close() {},
    });
    const live = bench.openLive();
    await live.send({ type: "ready" });
    const epoch = live.messages.at(-1).epoch;
    await live.send({ type: "nextFrame", epoch });
    const geometry = live.messages.at(-1).geometry;
    const capture = live.send({ type: "nextFrame", epoch });
    await readingFrame.promise;
    const inspect = bench.send("view", { view: "inspect" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ["devices","start"]);
    finishFrame.resolve();
    await Promise.all([capture, inspect]);
    assert.equal(bench.state.page.frameId, "read-1");
    assert.notEqual(live.messages.at(-1).epoch, epoch);
    assert.equal(bench.state.elements.picking, true);
    assert.deepEqual(calls, ["devices","start","screenshot"]);
    assert.equal(live.messages.at(-1).streaming, false);
    await live.send({type:"nextFrame",epoch:live.messages.at(-1).epoch});
    assert.equal(captures,2);
    const input = {kind:"click",x:5,y:8};
    await live.send({type:"gesture",epoch,geometry,input});
    assert.equal(live.messages.at(-1).type,"gestureResult");
    assert.ok(live.messages.at(-1).error);
    assert.equal(calls.includes("touch"),false);

    await bench.send("elementMode",{picking:false});
    const liveEpoch = live.messages.at(-1).epoch;
    await live.send({type:"nextFrame",epoch:liveEpoch});
    const gesture = live.send({type:"gesture",epoch:liveEpoch,geometry:live.messages.at(-1).geometry,input});
    await touching.promise;
    assert.equal(bench.state.page, undefined);
    assert.equal(bench.state.busy, true);
    await live.send({ type: "nextFrame", epoch:liveEpoch });
    await live.send({ type: "nextFrame", epoch:liveEpoch });
    await bench.send("startRecord", { location: "preview", stepFormat: "controls" });
    await bench.send("view", { view: "history" });
    await bench.send("action", { command: "press", ref: "@item", frameId: "read-1" });
    assert.equal(captures, 5);
    assert.deepEqual(calls, ["devices", "start", "screenshot", "attach", "claim", "touch"]);
    finishTouch.resolve();
    await gesture;
    assert.equal(captures, 5);
    assert.deepEqual(calls.slice(-2), ["release", "start"]);
    assert.equal(bench.state.tool, "inspect");
    assert.equal(bench.state.page.frameId, "read-2");
    await bench.send("action", { command: "press", ref: "@item", frameId: "read-1" });
    assert.equal(calls.at(-1), "start");
    await bench.send("action", { command: "press", ref: "@item", frameId: "read-2" });
    assert.equal(bench.state.page.frameId, "pressed");
    assert.equal(bench.state.draft, undefined);
    assert.deepEqual(bench.state.aiResults, {});
    assert.deepEqual(previewModes, [true]);
    await bench.deactivate();
});

test("leaving element selection during a capture queues the next frame on the same reader", async () => {
    const readStarted = latch(), finishRead = latch(), observationStarted = latch(), finishObservation = latch();
    const reads = [], calls = [];
    let opened = 0;
    const bench = openWorkbench(async command => {
        calls.push(command);
        if (command==="devices") return {devices:[{id:"phone"}]};
        if (command==="start") {
            observationStarted.resolve();
            await finishObservation.promise;
            return {observation:{frameId:"inspect",nodes:[]}};
        }
    },{},{
        onOpen() { opened++; },
        async nextFrame({discardBuffered}) {
            reads.push(discardBuffered);
            if (reads.length===2) {
                readStarted.resolve();
                await finishRead.promise;
            }
            return {data:Buffer.from([1]),width:30,height:100,mime:"image/jpeg"};
        },
        async close() {},
    });
    const live = bench.openLive();
    await live.send({type:"ready"});
    const epoch = live.messages.at(-1).epoch;
    await live.send({type:"nextFrame",epoch});
    const interrupted = live.send({type:"nextFrame",epoch});
    await readStarted.promise;

    const inspecting = bench.send("workspaceTab",{view:"inspect"});
    await observationStarted.promise;
    await bench.send("workspaceTab",{view:"network"});
    const resume = live.messages.at(-1);
    assert.equal(resume.streaming,true);
    assert.notEqual(resume.epoch,epoch);
    const next = live.send({type:"nextFrame",epoch:resume.epoch});
    finishRead.resolve();
    finishObservation.resolve();
    await Promise.all([interrupted,next,inspecting]);
    const frames = live.messages.filter(message=>message.type==="frame");
    assert.deepEqual(frames.map(frame=>frame.epoch),[epoch,resume.epoch]);
    assert.deepEqual(reads,[true,false,true]);
    assert.deepEqual(calls,["devices","start"]);
    assert.equal(opened,1);
    await bench.deactivate();
});

test("returning to element selection reuses the snapshot until live pixels change or the user refreshes", async t => {
    const calls = [];
    let observations = 0, pixel = 1, readers = 0;
    const bench = openWorkbench(async command => {
        calls.push(command);
        if (command === "devices") return {devices:[{id:"phone"}]};
        if (command === "start") return {observation:{frameId:"pick-" + ++observations,nodes:[]}};
        if (command === "screenshot") return {path:bench.screenshotPath(`pick-${observations}.png`)};
        assert.fail("Unexpected device command: " + command);
    },{},{
        onOpen() { readers++; },
        async nextFrame() { return {data:Buffer.from([pixel]),width:30,height:100,mime:"image/jpeg"}; },
        async close() {},
    },undefined,[],vscode => {
        const createPanel = vscode.window.createWebviewPanel;
        vscode.window.createWebviewPanel = (...args) => {
            const panel = createPanel(...args);
            panel.webview.asWebviewUri = () => "file:///test/pick.png";
            return panel;
        };
    });
    t.after(()=>bench.deactivate());
    const live = bench.openLive();
    await live.send({type:"ready"});
    const nextFrame = () => live.send({type:"nextFrame",epoch:live.messages.at(-1).epoch});
    const tab = view => bench.send("workspaceTab",{view});
    const mode = picking => bench.send("elementMode",{picking});
    await nextFrame();
    await tab("inspect");
    assert.equal(bench.state.elements.picture.frameId,"pick-1");
    await mode(false);
    await nextFrame();
    await mode(true);
    assert.equal(bench.state.elements.picture.frameId,"pick-1");
    await tab("network");
    await nextFrame();
    await tab("inspect");
    assert.equal(bench.state.page.frameId,"pick-1");
    assert.deepEqual(calls,["devices","start","screenshot"]);

    await tab("network");
    pixel = 2;
    await nextFrame();
    await tab("inspect");
    assert.equal(bench.state.elements.picture.frameId,"pick-2");
    await bench.send("observe");
    assert.equal(bench.state.elements.picture.frameId,"pick-3");
    assert.deepEqual(calls,["devices","start","screenshot","start","screenshot","start","screenshot"]);
    assert.equal(readers,1);
});

test("a running BDD case follows durable receipts while switching tools", async t => {
    const fs = require("node:fs/promises");
    const os = require("node:os");
    const path = require("node:path");
    const {setTimeout:wait} = require("node:timers/promises");
    const folder = await fs.mkdtemp(path.join(os.tmpdir(),"ha-workbench-journal-"));
    const started = latch(), finish = latch();
    const selected = {name:"Shop",uri:"file:///shop.json"};
    const condition = {selector:{id:"title"},property:"visible",equals:true};
    const plan = {version:"1",preconditions:[condition],steps:[{command:"press",input:{target:{id:"checkout"}}}],goals:[condition]};
    const given = {path:"preconditions[0]",kind:"precondition",result:{status:"passed"}};
    const when = {path:"steps[0]",kind:"command",command:"press",status:"completed"};
    const failed = {path:"goals[0]",kind:"goal",result:{status:"failed"}};
    const bench = openWorkbench(async (command,input)=>{
        if (command === "devices") return {devices:[{id:"fixture"}]};
        assert.equal(command,"execute");
        const directory = path.join(folder,"runs",input.run_id);
        await fs.mkdir(directory,{recursive:true});
        await fs.writeFile(path.join(directory,"run.json"),JSON.stringify({runId:input.run_id,status:"running",
            receipts:[given],activeStep:{...when,status:"started"}}));
        started.resolve();
        await finish.promise;
        return {status:"failed",steps:[given,when,failed],goalVerification:{status:"failed"}};
    },{},undefined,selected,[],vscode=>{
        vscode.workspace.getConfiguration = ()=>({get:(key,fallback)=>key === "stateDir" ? folder : fallback});
        vscode.workspace.openTextDocument = async ()=>({getText:()=>JSON.stringify(plan)});
    });
    let running;
    t.after(async ()=>{
        finish.resolve();
        await running;
        await bench.deactivate();
        await fs.rm(folder,{recursive:true,force:true});
    });
    await bench.live.send({type:"ready"});
    const epoch = bench.live.messages.at(-1).epoch;
    running = bench.send("run");
    await started.promise;
    await bench.send("workspaceTab",{view:"network"});
    assert.equal(bench.state.tool,"network");
    assert.equal(bench.live.messages.at(-1).epoch,epoch);
    for (let attempt=0; attempt<100 && bench.state.run.steps.length<2; attempt++) await wait(15);
    assert.deepEqual(bench.state.run.steps.map(step=>step.status),["passed","running"]);
    assert.equal(bench.state.run.bdd.when[0].text,"Tap checkout");
    finish.resolve();
    await running;
    assert.equal(bench.state.tool,"network");
    await bench.send("workspaceTab",{view:"recordings"});
    assert.equal(bench.state.testView,"run");
    assert.equal(bench.state.run.entry.status,"failed");
    assert.deepEqual(bench.state.run.steps.map(step=>step.status),["passed","completed","failed"]);
});

test("an acknowledged inspector gesture remains successful when controls cannot be read", async () => {
    let reads = 0;
    const bench = openWorkbench(async command => {
        if (command === "devices") return { devices: [{ id: "phone" }] };
        if (command === "screenshot") return {path:bench.screenshotPath("captured.png")};
        if (command === "start") {
            if (++reads === 2) throw new Error("Control tree unavailable");
            return { observation: { frameId: "read-" + reads, nodes: [] } };
        }
    }, { async replayGesture() {} }, {
        async nextFrame() { return { data: Buffer.from([1]), width: 30, height: 100, mime: "image/jpeg" }; },
        async close() {},
    });
    const live = bench.openLive();
    await live.send({ type: "ready" });
    await bench.send("view", { view: "inspect" });
    assert.equal(bench.state.elements.picture.frameId,"read-1");
    await bench.send("elementMode",{picking:false});
    const epoch = live.messages.at(-1).epoch;
    await live.send({ type: "nextFrame", epoch });
    await live.send({ type: "gesture", epoch, geometry: live.messages.at(-1).geometry, input: { kind: "back" } });
    assert.equal(live.messages.at(-1).type, "gestureResult");
    assert.equal(live.messages.at(-1).error, undefined);
    assert.equal(bench.state.error, "Control tree unavailable");
    assert.equal(bench.state.page, undefined);
    await bench.send("observe");
    assert.equal(bench.state.page.frameId, "read-3");
    assert.equal(bench.state.error, "");
    await bench.deactivate();
});

test("device changes in the inspector replace both the feed and the controls", async () => {
    let devices = ["one", "two"];
    const reads = [];
    const bench = openWorkbench(async (command, input) => {
        if (command === "devices") return { devices: devices.map(id => ({ id })) };
        if (command === "screenshot") return {path:bench.screenshotPath("captured.png")};
        if (command === "start") {
            reads.push(input.device);
            return { observation: { frameId: "page-" + input.device, nodes: [] } };
        }
    });
    const live = bench.openLive();
    await live.send({ type: "ready" });
    await bench.send("device", { device: "one" });
    await bench.send("view", { view: "inspect" });
    assert.equal(bench.state.elements.picture.frameId,"page-one");
    await bench.send("elementMode",{picking:false});
    const epoch = live.messages.at(-1).epoch;
    await live.send({ type: "device", device: "two" });
    assert.equal(bench.state.page.frameId, "page-two");
    assert.notEqual(live.messages.at(-1).epoch, epoch);
    assert.equal(live.messages.at(-1).device, "two");
    const count = live.messages.length;
    await live.send({ type: "nextFrame", epoch });
    assert.equal(live.messages.length, count);
    devices = [];
    await live.send({ type: "refresh" });
    assert.equal(bench.state.page, undefined);
    assert.equal(live.messages.at(-1).streaming, false);
    devices = ["one"];
    await live.send({ type: "refresh" });
    assert.equal(live.messages.at(-1).streaming, true);
    assert.equal(bench.state.page.frameId, "page-one");
    assert.deepEqual(reads, ["one", "two", "one"]);
    await bench.deactivate();
});

test("one-click workbench recording retains acknowledged steps across a failed action and page refresh", async () => {
    let starts = 0;
    const requests = [];
    const observed = { frameId: "current", nodes: [{ ref: "@button", id: "hello", clickable: true }] };
    const bench = openWorkbench(async (command, input) => {
        requests.push([command, input]);
        if (command === "devices") return { devices: [{ id: "test" }] };
        if (command === "start") starts++;
        if (command === "back") throw new Error("Device stopped responding");
        if (command === "run" || command === "report") return { status: "completed", goalVerification: { status: "not_requested" } };
        return { observation: observed, afterFrameId: observed.frameId };
    });
    await bench.send("devices");
    await bench.send("startRecord", { location: "preview", stepFormat: "controls" });
    assert.equal(starts, 1);
    await bench.send("action", { command: "press", ref: "@button", frameId: "old" });
    assert.equal(bench.state.draft.steps.length, 0);
    await bench.send("action", { command: "press", ref: "@button", frameId: "current" });
    await bench.send("action", { command: "back", frameId: "current" });
    assert.match(bench.state.error, /stopped responding/);
    assert.equal(bench.state.page, undefined);
    assert.equal(bench.state.draft.steps.length, 1);
    await bench.send("observe");
    await bench.send("stopRecord");
    await bench.send("startRecord", { location: "preview", stepFormat: "controls" });
    assert.equal(bench.state.recording, false);
    assert.equal(bench.state.draft.steps.length, 1);
    await bench.send("savePlan");
    assert.deepEqual(bench.saved, { version: "1", steps: [{ command: "press", input: { target: { id: "hello" } } }] });
    assert.deepEqual(bench.state.planSummary, { source: "workflow", stepCount: 1, commands: ["press"], hasGoal: false, controlFlow: [],
        rows:[{kind:"press",detail:"hello"}],initialChecks:[],finalChecks:[] });
    requests.length = 0;
    await bench.send("run");
    assert.deepEqual(requests.map(([command]) => command), ["start", "run", "detach"]);
    const id = bench.state.run.entry.id;
    assert.equal(requests[1][1].run_id, id);
    assert.equal(bench.state.run.entry.status, "completed");
    await bench.send("report", { id });
    assert.equal(bench.state.run.cleanup, "detached");
});

test("the phone preview records stable control actions and blocks ambiguous or unsupported input", async t => {
    let frame = 0, focused = false, overlapped = false;
    const bounds = (left,top,right,bottom)=>({left,top,right,bottom});
    const node = (ref,fields)=>({ref,visible:true,bundleName:"test.phone",...fields});
    const observation = () => ({frameId:"view-"+ ++frame,quality:{complete:true},nodes:[
        node("@root",{type:"Page",bounds:bounds(0,0,100,200)}),
        node("@list",{parent:"@root",id:"items",type:"List",scrollable:true,bounds:bounds(20,40,80,175)}),
        node("@button",{parent:"@list",id:"open",type:"Button",clickable:true,bounds:bounds(28,50,72,75)}),
        node("@caption",{parent:"@button",type:"Text",text:"Open",bounds:bounds(35,55,57,66)}),
        node("@input",{parent:"@root",id:"query",type:"TextInput",editable:true,focused,bounds:bounds(10,8,78,34)}),
        ...(overlapped ? [node("@overlay",{parent:"@root",id:"popup",type:"Button",clickable:true,bounds:bounds(32,52,63,70)})] : []),
    ]});
    const actions = [];
    const bench = openWorkbench(async (command,input)=>{
        if (command === "devices") return {devices:[{id:"phone"}]};
        if (command === "start") return {observation:observation()};
        assert.ok(["press","scroll","fill","back"].includes(command),command);
        actions.push([command,structuredClone(input)]);
        if (command === "press") focused = input.target.ref === "@input";
        return {observation:observation(),action:{dispatched:"acknowledged"}};
    },{
        async replayGesture(){assert.fail("Control recording must dispatch a locator-backed action");}
    },{
        async nextFrame(){return {data:Buffer.from([1]),width:100,height:200,mime:"image/jpeg"};},
        async close(){}
    });
    t.after(()=>bench.deactivate());
    const live = bench.openLive();
    await live.send({type:"ready"});
    await bench.send("startRecord", { location: "preview", stepFormat: "controls" });
    const {epoch} = live.messages.at(-1);
    await live.send({type:"nextFrame",epoch});
    const {geometry} = live.messages.at(-1);
    const send = (input,anchor) => live.send({type:"gesture",epoch,geometry,input,anchor});
    const tap = {kind:"click",x:44,y:60};
    await send({kind:"typeText",text:"before focus"});
    assert.match(live.messages.at(-1).error,/input field/);
    overlapped = true;
    await send(tap);
    assert.match(live.messages.at(-1).error,/uniquely/);
    overlapped = false;
    await send({...tap,kind:"longClick"});
    assert.match(live.messages.at(-1).error,/Screen coordinates/);
    assert.deepEqual(actions,[]);
    await send(tap);
    await send({kind:"swipe",x:30,y:188,toX:30,toY:80},{x:30,y:145});
    await send({kind:"click",x:40,y:18});
    await send({kind:"typeText",text:"cart"});
    await send({kind:"back"});
    assert.deepEqual(actions.map(([command,input])=>[command,input.target?.ref]),[
        ["press","@button"],["scroll","@list"],["press","@input"],["fill","@input"],["back",undefined],
    ]);
    await bench.send("stopRecord");
    await bench.send("savePlan");
    const target = id=>({id,bundleName:"test.phone"});
    assert.deepEqual(bench.saved.steps,[
        {command:"press",input:{target:target("open")}},
        {command:"scroll",input:{target:target("items"),direction:"down"}},
        {command:"press",input:{target:target("query")}},
        {command:"fill",input:{target:target("query"),text:"cart"}},
        {command:"back",input:{}},
    ]);
});

test("start and end checks can each be saved on their own", () => {
    const node = { selector: { id: "hello" } };
    const steps = [{ command: "back", input: {} }];
    const onlyStart = recordedPlan(steps, node);
    const onlyEnd = recordedPlan(steps, undefined, node, "visible", true);
    assert.ok(onlyStart.preconditions);
    assert.equal(onlyStart.goals, undefined);
    assert.equal(onlyEnd.preconditions, undefined);
    assert.deepEqual(onlyEnd.goals, [{ selector: node.selector, property: "visible", equals: true }]);
});

test("recording review reorders executable steps and rejects operations from the old order",async t=>{
    const snapshot={frameId:"draft",nodes:["first","second","third"].map(id=>({ref:"@"+id,id,clickable:true}))};
    const bench=openWorkbench(async command=>command==="devices" ? {devices:[{id:"phone"}]} : {observation:snapshot});
    t.after(()=>bench.deactivate());
    await bench.send("devices");
    await bench.send("startRecord",{location:"preview",stepFormat:"controls"});
    for (const node of snapshot.nodes) await bench.send("action",{command:"press",ref:node.ref,frameId:"draft"});
    await bench.send("moveRecordedStep",{from:0,to:2,revision:0});
    assert.equal(bench.state.draft.steps[0].input.target.id,"first");
    await bench.send("stopRecord");
    await bench.send("moveRecordedStep",{from:0,to:2,revision:0});
    await bench.send("removeStep",{index:0,revision:0});
    await bench.send("moveRecordedStep",{from:2,to:-1,revision:1});
    await bench.send("savePlan");
    assert.deepEqual(bench.saved.steps.map(step=>step.input.target.id),["second","third","first"]);
});

test("live screen recording rejects obsolete frames and saves only acknowledged gestures", async () => {
    const calls = [];
    const gestures = [];
    let width = 100;
    const bench = openWorkbench(async (command, input) => {
        calls.push([command, input]);
        if (command === "devices") return { devices: [{ id: "phone" }] };
    }, {
        async replayGesture(_, gesture) {
            if (gesture.kind === "longClick") throw new Error("Gesture failed");
            gestures.push(gesture);
        },
    }, {
        async nextFrame() { return { data: Buffer.from([1]), width, height: 200, mime: "image/jpeg" }; },
        async close() {},
    });
    const live = bench.openLive();
    await live.send({ type: "ready" });
    const epoch = live.messages.at(-1).epoch;
    await live.send({ type: "nextFrame", epoch });
    const first = live.messages.at(-1).geometry;
    await bench.send("startRecord", { location: "preview", stepFormat: "coordinates" });
    assert.equal(bench.state.draft.location, "preview");
    assert.equal(bench.state.draft.stepFormat, "coordinates");
    const click = { kind: "click", x: 12, y: 31 };
    const back = { kind: "back" };
    const double = { ...click, kind: "doubleClick" };
    const pinch = { kind: "pinch", fingers: [
        { x: 90, y: 79, toX: 48, toY: 79 }, { x: 110, y: 79, toX: 152, toY: 79 }
    ] };
    const home = { kind: "home" };
    const recents = { kind: "recents", x: 99, y: 198, toX: 99, toY: 120 };
    const typed = { kind: "typeText", text: "工作台 test 'value'" };
    const send = (input, geometry) => live.send({ type: "gesture", epoch, geometry, input });
    await send(click, first);
    await send({ ...click, kind: "longClick" }, first);
    assert.equal(live.messages.at(-1).error, "Gesture failed");
    width = 200;
    await live.send({ type: "nextFrame", epoch });
    const second = live.messages.at(-1).geometry;
    assert.notEqual(first, second);
    await send(back, first);
    assert.equal(bench.state.draft.steps.length, 1);
    await send({ ...pinch, fingers: [{ ...pinch.fingers[0], toX: 200 }, pinch.fingers[1]] }, second);
    assert.equal(bench.state.draft.steps.length, 1);
    await send(back, second);
    for (const action of [double, pinch, typed, home, recents]) await send(action, second);
    assert.deepEqual(gestures, [click, back, double, pinch, typed, home, recents]);
    await live.send({ type: "stopRecord" });
    assert.equal(bench.state.recording, false);
    await bench.send("workspaceTab", { view: "network" });
    assert.equal(bench.state.tool, "network");
    assert.equal(live.messages.at(-1).epoch, epoch);
    assert.deepEqual(bench.state.draft.steps.map(step => step.input), gestures);
    await send(click, second);
    assert.equal(gestures.length, 7);
    await bench.runCommand("harmonyAgent.askAI");
    assert.equal(bench.state.tool, "exploration");
    await bench.send("workspaceTab", { view: "recordings" });
    assert.equal(bench.panelCount, 1);
    await bench.send("savePlan");
    assert.equal(bench.saved.format, "harmony-agent.device-recording");
    assert.deepEqual(bench.state.planSummary, {
        source: "coordinates", stepCount: 7, commands: ["click", "back", "doubleClick", "pinch", "typeText"],
        hasGoal: false, controlFlow: [], initialChecks: [], finalChecks: [],
        rows: [{kind:"click",detail:"(12, 31)"},{kind:"back",detail:""},{kind:"doubleClick",detail:"(12, 31)"},
            {kind:"pinch",detail:""},{kind:"typeText",detail:""},{kind:"home",detail:""},{kind:"recents",detail:""}],
    });
    assert.deepEqual(bench.saved.steps.map(s => s.input), gestures);
    assert.ok(Number.isInteger(bench.saved.steps[1].delayMs));
    await bench.deactivate();
    const sessions = calls.filter(([command]) => command !== "devices");
    assert.deepEqual(sessions.map(([command]) => command),
        ["attach", ...Array.from({length: gestures.length + 1}, () => ["claim", "release"]).flat(), "detach"]);
    assert.equal(new Set(sessions.map(([, input]) => input.session)).size, 1);
});

test("phone gestures flush before saving, replay in order, and remain readable in history", async () => {
    let capture, stopped = 0;
    const replayed = [];
    const step = { command: "deviceGesture", input: { kind: "click", x: 10, y: 20 }, label: "10, 20" };
    const bench = openWorkbench(async () => ({ devices: [{ id: "phone" }] }), {
        async startRecorder(options) {
            capture = options;
            return { async stop() { stopped++; capture.onStep(step); } };
        },
        validateGesture() {},
        async replayGesture(target, input) { replayed.push([target.device, input.kind]); },
    });
    await bench.send("devices");
    await bench.send("startRecord", { location: "phone", stepFormat: "controls" });
    assert.match(bench.state.error, /currently saves screen coordinates/);
    assert.equal(capture, undefined);
    assert.equal(bench.state.draft, undefined);
    await bench.send("startRecord", { location: "phone", stepFormat: "coordinates" });
    assert.equal(bench.state.draft.location, "phone");
    assert.equal(bench.state.draft.stepFormat, "coordinates");
    capture.onStep({ command: "deviceGesture", input: { kind: "back" }, label: "" });
    assert.equal(bench.state.draft.steps.length, 1);
    await bench.send("stopRecord");
    assert.equal(stopped, 1);
    assert.equal(bench.state.draft.steps.length, 2);
    await bench.send("savePlan");
    assert.equal(bench.saved.format, "harmony-agent.device-recording");
    await bench.send("run");
    assert.deepEqual(replayed, [["phone", "back"], ["phone", "click"]]);
    assert.equal(bench.state.run.entry.status, "completed");
    assert.equal(bench.state.run.goalStatus, "not_requested");
    await bench.send("report", { id: bench.state.run.entry.id });
    assert.deepEqual(bench.state.run.steps.map(s => s.command), ["back", "click"]);
    bench.saved.steps.push({ command: "deviceGesture", input: { kind: "unsupported" } });
    await bench.send("run");
    assert.equal(bench.state.run.entry.status, "rejected");
    assert.equal(replayed.length, 2);
    await bench.send("startRecord", { location: "phone", stepFormat: "coordinates" });
    await bench.send("discardRecord");
    assert.equal(stopped, 2);
    assert.equal(bench.state.draft, undefined);
    await bench.send("startRecord", { location: "phone", stepFormat: "coordinates" });
    bench.close();
    await bench.deactivate();
    assert.equal(stopped, 3);
});

test("closing the single editor waits for a pending acknowledged gesture then restores the draft for review", async () => {
    let acknowledge, entered;
    const sent = new Promise(resolve => { entered = resolve; });
    const calls = [];
    const bench = openWorkbench(async command => {
        calls.push(command);
        if (command === "devices") return { devices: [{ id: "phone" }] };
    }, {
        async replayGesture() {
            await new Promise(resolve => { acknowledge = resolve; entered(); });
        },
    }, {
        async nextFrame() { return { data: Buffer.from([1]), width: 100, height: 200, mime: "image/jpeg" }; },
        async close() {},
    });
    const live = bench.openLive();
    await live.send({ type: "ready" });
    const epoch = live.messages.at(-1).epoch;
    await live.send({ type: "nextFrame", epoch });
    const geometry = live.messages.at(-1).geometry;
    await bench.send("startRecord", { location: "preview", stepFormat: "coordinates" });
    const writing = live.send({ type: "gesture", epoch, geometry, input: { kind: "click", x: 20, y: 40 } });
    await sent;
    bench.close();
    const reopening = bench.openLive();
    await reopening.send({ type: "ready" });
    acknowledge();
    await writing;
    // A command finishing on the newly opened editor must see the closed session's complete draft.
    await bench.send("devices");
    assert.equal(bench.state.recording, false);
    assert.equal(bench.state.mode, "workflow");
    assert.equal(bench.state.draft.steps.length, 1);
    assert.equal(calls.filter(command => command === "detach").length, 1);
    await bench.deactivate();
});

test("plans restored from older workspaces get a fresh preview without exposing private inputs", async () => {
    const selected = { name: "recording.json", uri: "file:///recording.json" };
    const recent = { id: "recent-id", plan: { name: "recording.json", uri: "file:///private/recording.json" }, status: "completed" };
    const bench = openWorkbench(async () => ({ devices: [] }), {}, undefined, selected, [recent]);
    const live = bench.openLive();
    await live.send({ type: "ready" });
    assert.equal(bench.state.plan.name, "recording.json");
    assert.deepEqual(bench.state.runs,[recent]);
    await bench.send("view", { view: "workflow" });
    assert.match(bench.state.planSummary.error, /workflow/i);
    assert.deepEqual(bench.state.plan, selected);
    const plan = { version: "2", steps: [
        { command: "fill", input: { text: "private input" } },
        { if: { equals: "private condition" }, then: [{ repeat: { limit: 20, steps: [{ command: "press" }] } }] },
        { command: "untrusted text" },
    ], goals: [{ equals: "private expectation" }] };
    bench.editFile(JSON.stringify(plan));
    assert.deepEqual(bench.state.planSummary, { source: "workflow", stepCount: 3, commands: ["fill", "if", "unknownStep"],
        hasGoal: true, controlFlow: ["if", "repeat"], rows:[{kind:"fill",detail:""},{kind:"if",detail:""},{kind:"unknownStep",detail:""}],initialChecks:[],finalChecks:[] });
    bench.editFile('{"private fragment": !!!}');
    assert.equal(typeof bench.state.planSummary.error, "string");
    assert.doesNotMatch(bench.state.planSummary.error, /private fragment/);
    assert.deepEqual(bench.state.plan, selected);
    await bench.deactivate();
});
