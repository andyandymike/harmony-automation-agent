"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { ProjectRuntime, projectHdc } = require("../src/projectRuntime");
const { getMcpLaunch, registerCopilotMcp } = require("../src/aiIntegration");
const { askAI } = require("../src/aiHandoff");
const { messagesFor } = require("../src/strings");

function uri(fsPath) {
    return { scheme: "file", fsPath, toString: () => pathToFileURL(fsPath).href };
}

async function project(t, name) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `harmony runtime ${name} `));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const relative = { version: 1, python: "Python bin/python.exe", hdc: "Tools/hdc.exe", cli: ".harmony-agent/start cli.py", src: "src" };
    const [python, cli, hdc, src] = ["python", "cli", "hdc", "src"].map(key => path.join(root, relative[key]));
    await Promise.all([path.dirname(python), path.dirname(cli), path.dirname(hdc), src]
        .map(directory => fs.mkdir(directory, { recursive: true })));
    await Promise.all([python, cli, hdc].map(file => fs.writeFile(file, "fixture", { mode: 0o700 })));
    const manifest = path.join(root, ".harmony-agent", "runtime.json");
    const write = value => fs.writeFile(manifest, typeof value === "string" ? value : JSON.stringify(value), "utf8");
    await write(relative);
    return { folder: { name, uri: uri(root) }, manifest, write, relative, paths: { python, cli, src, hdc } };
}

function windowFor(t, folders, { preference, trusted = true } = {}) {
    const watches = new Map(), store = new Map(preference ? [["projectRuntime", preference]] : []);
    const calls = { confirmations: [], pickers: [], errors: [], probes: [], notifications: 0 };
    const ui = { approval: undefined, choice: undefined, pinned: false, python: "3.11" };
    let provider;
    const vscode = {
        Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
        RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
        workspace: {
            isTrusted: trusted, workspaceFolders: folders,
            createFileSystemWatcher(pattern) {
                assert.equal(pattern.pattern, ".harmony-agent/runtime.json");
                const watcher = { onDidCreate(fn) { this.create = fn; }, onDidChange(fn) { this.change = fn; },
                    onDidDelete(fn) { this.delete = fn; }, dispose() { watches.delete(pattern.base.name); } };
                watches.set(pattern.base.name, watcher);
                return watcher;
            },
            onDidChangeConfiguration() { return { dispose() {} }; },
        },
        window: {
            async showQuickPick(choices) { calls.pickers.push(choices); return choices.find(choice => choice.label === ui.choice); },
            async showWarningMessage(message, options) { calls.confirmations.push({ message, options }); return ui.approval; },
            async showErrorMessage(error) { calls.errors.push(error); },
        },
        EventEmitter: class { fire() { calls.notifications++; } dispose() {} },
        lm: { registerMcpServerDefinitionProvider(_, registered) { provider = registered; return { dispose() {} }; } },
        McpStdioServerDefinition: class {
            constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); }
        },
    };
    const context = { subscriptions: [], workspaceState: { get: key => store.get(key),
        async update(key, value) { store.set(key, value); } } };
    const manager = new ProjectRuntime(vscode, context, () => "en", () => ui.pinned, async (command, args) => {
        calls.probes.push({ command, args });
        return { stdout: ui.python + "\n" };
    });
    manager.start();
    t.after(() => manager.dispose());
    return { manager, store, ui, vscode, calls, watches, context, get provider() { return provider; } };
}

test("a trusted single-root manifest resolves against its owning folder and needs explicit consent", async t => {
    const projectA = await project(t, "App A");
    const first = windowFor(t, [projectA.folder]);
    await first.manager.ready();
    assert.equal(first.manager.current.kind, "pending");
    assert.throws(() => first.manager.configuration, /Select and confirm/);
    assert.equal(first.calls.confirmations.length, 0);
    await first.manager.ready(true);
    await first.manager.ready(true);
    assert.equal(first.calls.confirmations.length, 1);
    assert.equal(first.calls.confirmations[0].options.modal, true);
    assert.ok(first.calls.confirmations[0].options.detail.includes(projectA.paths.cli));
    assert.deepEqual(first.calls.probes, []);
    assert.equal(first.store.has("projectRuntime"), false);

    first.ui.choice = projectA.folder.name;
    first.ui.approval = "Use project runtime";
    assert.equal(await first.manager.choose(), true);
    assert.deepEqual(first.manager.configuration, projectA.paths);
    assert.deepEqual(first.calls.probes, []);
    const reopened = windowFor(t, [projectA.folder], { preference: first.store.get("projectRuntime") });
    await reopened.manager.ready(true);
    assert.deepEqual(reopened.manager.configuration, projectA.paths);
    assert.equal(reopened.calls.confirmations.length, 0);
});

test("multiple roots never select implicitly and an untrusted window cannot enable project tools", async t => {
    const a = await project(t, "First");
    const b = await project(t, "Second");
    const host = windowFor(t, [a.folder, b.folder]);
    await host.manager.ready(true);
    assert.deepEqual(host.calls.pickers[0].map(info => info.label), ["First", "Second", "Use VS Code settings"]);
    assert.equal(host.calls.confirmations.length, 0);
    host.ui.choice = "Second";
    host.ui.approval = "Use project runtime";
    await host.manager.choose();
    assert.deepEqual(host.manager.configuration, b.paths);

    const untrusted = windowFor(t, [a.folder, b.folder], { trusted: false, preference: host.store.get("projectRuntime") });
    await untrusted.manager.ready(true);
    assert.throws(() => untrusted.manager.configuration, /Trust this workspace/);
    assert.equal(untrusted.calls.pickers.length, 0);
    assert.equal(untrusted.watches.size, 0);
    assert.deepEqual(untrusted.calls.probes, []);
});

test("watcher changes revalidate without switching an active job to invalid or different settings", async t => {
    const item = await project(t, "Watched");
    const host = windowFor(t, [item.folder], { preference: { kind: "project", id: uri(item.manifest).toString() } });
    await host.manager.ready();
    const active = host.manager.configuration;
    const changes = [];
    host.manager.onDidChange(next => changes.push(next.kind));
    host.ui.pinned = true;
    await item.write("{ broken");
    host.watches.get(item.folder.name).change();
    for (let i = 0; i < 60 && host.manager.next.kind !== "invalid"; i++) await delay(20);
    assert.equal(host.manager.next.kind, "invalid");
    assert.equal(host.manager.configuration, active);
    assert.deepEqual(changes, []);
    host.ui.pinned = false;
    host.manager.apply();
    assert.throws(() => host.manager.configuration, /Invalid JSON/);
    await item.write({ ...item.relative, version: 2 });
    await host.manager.ready(false, true);
    assert.throws(() => host.manager.configuration, /"version": 1/);
    await item.write({ ...item.relative, src: "missing folder" });
    await host.manager.ready(false, true);
    assert.throws(() => host.manager.configuration, /src · path does not exist/);
    await item.write(item.relative);
    await host.manager.ready(false, true);
    assert.deepEqual(host.manager.configuration, item.paths);
    assert.deepEqual(host.calls.probes, []);
    assert.equal(host.calls.confirmations.length, 0);
    await fs.unlink(item.manifest);
    await host.manager.ready(false, true);
    assert.throws(() => host.manager.configuration, /selected runtime configuration is missing/);
    host.ui.choice = "Use VS Code settings";
    await host.manager.choose();
    assert.equal(host.manager.configuration, undefined);
    const manual = windowFor(t, [item.folder]);
    await manual.manager.ready(true);
    assert.equal(manual.manager.configuration, undefined);
    assert.equal(manual.calls.pickers.length, 0);
});

test("MCP discovery, export and HDC share one approved runtime and keep failure diagnostics", async t => {
    const item = await project(t, "Device Tools");
    const host = windowFor(t, [item.folder]);
    const bench = {
        text: messagesFor("en"), language: "en", projectRuntime: host.manager, stateDir: path.join(item.folder.uri.fsPath, "evidence"),
        get agent() { throw new Error("The legacy CLI must not be consulted"); }, config: { get() { throw new Error("Unexpected settings fallback"); } },
    };
    registerCopilotMcp(host.vscode, host.context, bench);
    assert.deepEqual(await host.provider.provideMcpServerDefinitions(), []);
    assert.deepEqual(host.calls.probes, []);
    host.ui.choice = item.folder.name;
    host.ui.approval = "Use project runtime";
    await host.manager.choose();
    const [definition] = await host.provider.provideMcpServerDefinitions();
    assert.equal(definition.command, item.paths.python);
    assert.deepEqual(definition.args, ["-m", "harmony_agent.mcp", "--state-dir", bench.stateDir, "--hdc", item.paths.hdc]);
    assert.equal(definition.env.PYTHONPATH.split(path.delimiter)[0], item.paths.src);
    assert.equal(projectHdc(bench), item.paths.hdc);
    assert.deepEqual(host.calls.probes, []);
    assert.ok(host.calls.notifications > 0);

    host.ui.python = "3.9";
    await assert.rejects(host.provider.resolveMcpServerDefinition(definition), /requires Python 3.10 or newer.*3.9/);
    host.ui.python = "3.11";
    assert.deepEqual(await getMcpLaunch(bench), { command: definition.command, args: definition.args, env: definition.env, hdcPath: item.paths.hdc });
    let clipboard;
    await askAI({ window: { showQuickPick: async () => ({ id: "config" }), showInformationMessage() {} },
        env: { clipboard: { async writeText(text) { clipboard = text; } } } }, bench);
    assert.ok(clipboard.includes("command = " + JSON.stringify(item.paths.python)));
    assert.ok(clipboard.includes("args = " + JSON.stringify(definition.args)));
    assert.ok(clipboard.includes("[mcp_servers.harmony.env]\nPYTHONPATH = " + JSON.stringify(definition.env.PYTHONPATH)));
    assert.equal(host.calls.probes.at(-1).command, item.paths.python);
});
