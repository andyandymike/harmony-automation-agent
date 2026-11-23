"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const manifest = require("../package.json");
const { getMcpLaunch, registerCopilotMcp } = require("../src/aiIntegration");

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "harmony mcp ")));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const win = process.platform === "win32";
    const scripts = path.join(root, win ? "Scripts" : "bin");
    await fs.mkdir(scripts);
    const cli = path.join(scripts, win ? "harmony-agent.exe" : "harmony-agent");
    const python = path.join(scripts, win ? "python.exe" : "python");
    await Promise.all([cli, python, path.join(root, "pyvenv.cfg")].map(file => fs.writeFile(file, "")));
    const settings = {};
    const bench = {
        config: { get: key => settings[key] }, language: "en",
        agent: { executable: cli, hdcPath: path.join(root, "device tools", "hdc") },
        stateDir: path.join(root, "workbench evidence"),
    };
    return { bench, root, settings, python };
}

test("Copilot discovers a complete stdio definition for the Workbench runtime and follows configuration changes", async t => {
    const { bench, root, python, settings } = await fixture(t);
    let provider, providerId, changed;
    let signals = 0;
    const vscode = {
        EventEmitter: class { fire() { signals++; } },
        workspace: { onDidChangeConfiguration(fn) { changed = fn; } },
        lm: { registerMcpServerDefinitionProvider(id, value) { provider = value; providerId = id; } },
        McpStdioServerDefinition: class {
            constructor(label, command, args) { Object.assign(this, { label, command, args }); }
        },
    };
    registerCopilotMcp(vscode, { subscriptions: [] }, bench);
    assert.equal(providerId, manifest.contributes.mcpServerDefinitionProviders[0].id);
    const [server] = await provider.provideMcpServerDefinitions();
    assert.equal(server.label, "Harmony Agent");
    assert.equal(server.command, python);
    assert.deepEqual(server.args, ["-m", "harmony_agent.mcp", "--state-dir", bench.stateDir, "--hdc", bench.agent.hdcPath]);
    settings.mcpPythonPath = path.join(root, process.platform === "win32" ? "other.exe" : "other");
    await fs.writeFile(settings.mcpPythonPath, "");
    changed({ affectsConfiguration: setting => setting === "harmonyAgent.mcpPythonPath" });
    assert.equal(signals, 1);
    assert.equal((await provider.provideMcpServerDefinitions())[0].command, settings.mcpPythonPath);
});

test("an unknown CLI installation requests the interpreter and older VS Code keeps the Workbench", async t => {
    const { bench, root, settings } = await fixture(t);
    assert.doesNotThrow(() => registerCopilotMcp({}, { subscriptions: [] }, bench));
    const workingCli = bench.agent.executable;
    bench.agent.executable = path.join(root, "missing-cli");
    await assert.rejects(getMcpLaunch(bench), { code: "MCP_PYTHON_REQUIRED" });
    bench.agent.executable = workingCli;
    settings.mcpPythonPath = path.join(root, "missing-explicit-python");
    await assert.rejects(getMcpLaunch(bench), { code: "MCP_PYTHON_REQUIRED" });
});
