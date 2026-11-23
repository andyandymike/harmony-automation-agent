"use strict";

const { execFile, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { promisify } = require("node:util");
const versionCommand = promisify(execFile);
const compatibleBinaries = new Set();
const modelRoundTimeoutMs = 60_000;

const disabledFeatures = [
    "shell_tool", "unified_exec", "apps", "plugins", "hooks", "multi_agent", "multi_agent_v2",
    "computer_use", "browser_use", "in_app_browser", "image_generation", "view_image", "memories",
];

function codexError(code, message) {
    return Object.assign(new Error(message), { code });
}

async function resolveCodex(executable) {
    if (process.platform !== "win32") return executable || "codex";
    const directories = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
    const configured = executable && path.isAbsolute(executable);
    const name = executable || "codex";
    const filename = path.extname(name) ? name : name + ".exe";
    const candidates = configured ? [filename] : directories.map(dir => path.join(dir, filename));
    for (const candidate of candidates) {
        if (/\.exe$/i.test(candidate) && existsSync(candidate)) return candidate;
    }
    if (configured && !/\.(?:ps1|cmd)$/i.test(name)) {
        throw codexError("CODEX_NOT_FOUND", "The configured Codex executable was not found.");
    }

    // npm installs a .cmd/.ps1 shim. Launch its native executable directly so Stop
    // cancels the actual model process on Windows without starting a command shell.
    const dirs = configured ? [path.dirname(executable)] : directories;
    const triple = (process.arch === "arm64" ? "aarch64" : "x86_64") + "-pc-windows-msvc";
    const pkg = "@openai/codex-win32-" + process.arch;
    for (const dir of dirs) {
        if (!existsSync(path.join(dir, "codex.cmd")) && !existsSync(path.join(dir, "codex.ps1"))) continue;
        const codex = path.join(dir, "node_modules", "@openai", "codex");
        let vendor;
        try {
            vendor = path.join(path.dirname(require.resolve(pkg + "/package.json", { paths: [codex] })), "vendor");
        } catch {
            vendor = path.join(codex, "vendor");
        }
        for (const layout of ["bin", "codex"]) {
            const native = path.join(vendor, triple, layout, "codex.exe");
            if (existsSync(native)) return native;
        }
    }
    if (!executable && process.env.LOCALAPPDATA) {
        const desktop = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
        const dirs = await fs.readdir(desktop, { withFileTypes: true }).catch(() => []);
        const versions = await Promise.all(dirs.filter(d => d.isDirectory()).map(async d => {
            const binary = path.join(desktop, d.name, "codex.exe");
            const info = await fs.stat(binary).catch(() => undefined);
            return info?.isFile() ? { binary, updated: info.mtimeMs } : undefined;
        }));
        const recent = versions.filter(Boolean).sort((a, b) => b.updated - a.updated)[0];
        if (recent) return recent.binary;
    }
    throw codexError("CODEX_NOT_FOUND", "Install Codex CLI or choose the Codex executable in Harmony Agent settings.");
}

function askInDirectory(binary, cwd, prompt, signal) {
    const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check",
        "--sandbox", "read-only", "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
        "-c", "project_doc_max_bytes=0", "-c", 'model_reasoning_effort="low"'];
    for (const feature of disabledFeatures) args.push("-c", "features." + feature + "=false");
    args.push("-");

    return new Promise((resolve, reject) => {
        // Codex's "none" execution environment disables local *and* remote filesystem
        // and process access. A read-only sandbox alone still permits file reads.
        const env = { ...process.env, CODEX_EXEC_SERVER_URL: "none" };
        delete env.CODEX_APP_TOOLS_PIPE_PATH;
        const child = spawn(binary, args, { cwd, env, signal, killSignal: "SIGKILL", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        const events = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        let answer, failure, completed = false, stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, modelRoundTimeoutMs);
        events.on("line", line => {
            let event;
            try { event = JSON.parse(line); } catch { return; }
            const { item } = event;
            if (item && !["agent_message", "reasoning"].includes(item.type)) {
                failure = codexError("CODEX_TOOL_CALL", "The model attempted a tool call outside the workbench.");
                child.kill();
                return;
            }
            if (event.type === "item.completed" && item?.type === "agent_message") answer = item.text;
            if (event.type === "turn.completed") completed = true;
            if (event.type === "turn.failed") failure = codexError("CODEX_REQUEST_FAILED",
                event.error?.message || "Codex could not complete the request.");
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", text => { stderr = (stderr + text).slice(-1600); });
        // Early process exits can close stdin before the JSON prompt has finished writing.
        child.stdin.on("error", () => {});
        child.once("error", error => {
            failure = error.code === "ENOENT" ? codexError("CODEX_NOT_FOUND", "The Codex executable was not found.") : error;
        });
        child.once("close", code => {
            clearTimeout(timer);
            if (signal?.aborted) return reject(signal.reason);
            if (timedOut) return reject(codexError("CODEX_TIMEOUT", "Codex did not finish the model request in 60 seconds."));
            if (failure) return reject(failure);
            if (code === 0 && completed && answer?.trim()) return resolve(answer.trim());
            reject(codexError("CODEX_REQUEST_FAILED", stderr.trim() || "Codex closed without returning a result."));
        });
        child.stdin.end(prompt, "utf8");
    });
}

async function askCodex({ prompt, signal, executable, onRetry }) {
    signal?.throwIfAborted();
    const binary = await resolveCodex(executable);
    if (!compatibleBinaries.has(binary)) {
        const { stdout } = await versionCommand(binary, ["--version"], { signal, windowsHide: true }).catch(error => {
            if (error.code === "ENOENT") throw codexError("CODEX_NOT_FOUND", "The Codex executable was not found.");
            throw error;
        });
        const version = /codex-cli\s+(\d+)\.(\d+)\./.exec(stdout);
        if (!version || (Number(version[1]) === 0 && Number(version[2]) < 146)) {
            throw codexError("CODEX_VERSION", "Update Codex CLI to version 0.146.0 or newer for workbench tasks.");
        }
        compatibleBinaries.add(binary);
    }
    // No application files or project-specific MCP servers are needed for this model round.
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "harmony-model-"));
    try {
        try {
            return await askInDirectory(binary, cwd, prompt, signal);
        } catch (error) {
            signal?.throwIfAborted();
            if (error.code !== "CODEX_TIMEOUT") throw error;
            // Retry only this model question, using the same observation of completed device actions.
            onRetry?.();
            return await askInDirectory(binary, cwd, prompt, signal);
        }
    } finally {
        await fs.rm(cwd, { recursive: true, force: true });
    }
}

module.exports = { askCodex };
