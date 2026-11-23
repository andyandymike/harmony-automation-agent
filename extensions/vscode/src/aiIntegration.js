"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const providerId = "harmonyAgent.phoneTools";
const windows = process.platform === "win32";

async function isFile(filename) {
    return (await fs.stat(filename).catch(() => undefined))?.isFile();
}

async function findExecutable(command) {
    const filename = windows && !path.extname(command) ? command + ".exe" : command;
    if (path.isAbsolute(filename) || /[/\\]/.test(filename)) {
        if (await isFile(filename)) return path.resolve(filename);
        return undefined;
    }
    for (const directory of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
        const candidate = path.resolve(directory, filename);
        if (await isFile(candidate)) return candidate;
    }
}

async function cliInterpreter(command) {
    const cli = await findExecutable(command);
    if (!cli) return undefined;
    // pipx may expose the entry point through a symlink to its private venv.
    const entry = await fs.realpath(cli);
    const scripts = path.dirname(entry);
    if (windows) {
        if (path.basename(scripts).toLowerCase() !== "scripts") return undefined;
        // Windows venv installs keep python.exe in Scripts. A global install keeps it one level up.
        for (const directory of [scripts, path.dirname(scripts)]) {
            const python = path.join(directory, "python.exe");
            if (await isFile(python)) return python;
        }
    } else {
        const envPython = path.join(scripts, "python");
        if (await isFile(path.join(path.dirname(scripts), "pyvenv.cfg")) && await isFile(envPython)) return envPython;
        // pip's POSIX entry point names the interpreter even for a --user install.
        const handle = await fs.open(entry, "r");
        try {
            const { buffer, bytesRead } = await handle.read(Buffer.alloc(1024), 0, 1024, 0);
            const python = /^#!(\/[^\r\n]+\/python[\d.]*)\r?$/m.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
            if (python && await isFile(python)) return python;
        } finally {
            await handle.close();
        }
    }
}

async function getMcpLaunch(workbench) {
    const agent = workbench.agent;
    const chosen = workbench.config.get("mcpPythonPath");
    const command = chosen ? await findExecutable(chosen) : await cliInterpreter(agent.executable);
    if (!command) {
        const message = /^zh\b/i.test(workbench.language)
            ? "请将 harmonyAgent.mcpPythonPath 设为已安装 harmony-automation-agent 的 Python 解释器路径。"
            : "Set harmonyAgent.mcpPythonPath to the Python interpreter with harmony-automation-agent installed.";
        throw Object.assign(new Error(message), { code: "MCP_PYTHON_REQUIRED" });
    }
    const args = ["-m", "harmony_agent.mcp", "--state-dir", workbench.stateDir];
    if (agent.hdcPath) args.push("--hdc", agent.hdcPath);
    return { command, args };
}

function registerCopilotMcp(vscode, context, workbench) {
    if (!vscode.lm?.registerMcpServerDefinitionProvider) return;
    const changes = new vscode.EventEmitter();
    context.subscriptions.push(changes, vscode.workspace.onDidChangeConfiguration(event => {
        if (["cliPath", "mcpPythonPath", "hdcPath"].some(key => event.affectsConfiguration("harmonyAgent." + key))) {
            changes.fire();
        }
    }), vscode.lm.registerMcpServerDefinitionProvider(providerId, {
        onDidChangeMcpServerDefinitions: changes.event,
        async provideMcpServerDefinitions() {
            const { command, args } = await getMcpLaunch(workbench);
            return [new vscode.McpStdioServerDefinition("Harmony Agent", command, args)];
        },
    }));
}

module.exports = { getMcpLaunch, registerCopilotMcp };
