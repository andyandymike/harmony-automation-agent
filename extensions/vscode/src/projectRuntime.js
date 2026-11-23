"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const manifestPath = ".harmony-agent/runtime.json";
const preferenceKey = "projectRuntime";
const settings = { kind: "settings" };
const runtimeFields = ["python", "cli", "src", "hdc"];
const missing = error => ["ENOENT", "FileNotFound"].includes(error.code);

async function readManifest(candidate, w) {
    const { folder, uri } = candidate;
    if (folder.uri.scheme !== "file") throw new Error(w("The runtime must belong to a local workspace folder.", "运行时配置必须位于本机工作区文件夹中。"));
    const info = await fs.stat(uri.fsPath);
    if (!info.isFile() || info.size > 65536) throw new Error(w("Expected a JSON file no larger than 64 KiB.", "需要一个不超过 64 KiB 的 JSON 文件。"));
    let json;
    const source = await fs.readFile(uri.fsPath, "utf8");
    try { json = JSON.parse(source.replace(/^\uFEFF/, "")); }
    catch (error) {
        const location = /line (\d+) column (\d+)/.exec(error.message);
        throw new Error(w("Invalid JSON." + (location ? ` Line ${location[1]}, column ${location[2]}.` : ""),
            "JSON 格式有误。" + (location ? `第 ${location[1]} 行，第 ${location[2]} 列。` : "")));
    }
    if (!json || typeof json !== "object" || Array.isArray(json) || json.version !== 1)
        throw new Error(w('Expected numeric "version": 1.', '需要使用数字 "version": 1。'));
    const entries = await Promise.all(runtimeFields.map(async field => {
        const input = json[field];
        if (typeof input !== "string" || !input.trim() || input.includes("\0") ||
            (process.platform === "win32" && /^[a-z]:[^\\/]/i.test(input)))
            throw new Error(w(`“${field}” must be an absolute path or a path relative to the workspace folder.`,
                `“${field}”须为绝对路径或相对于工作区文件夹的路径。`));
        const resolved = path.resolve(folder.uri.fsPath, input);
        try {
            const target = await fs.stat(resolved);
            if (field === "src" ? !target.isDirectory() : !target.isFile())
                throw new Error(field === "src" ? w("expected a directory", "应为目录") : w("expected a file", "应为文件"));
            const binary = field === "python" || field === "hdc";
            await fs.access(resolved, binary && process.platform !== "win32" ? constants.X_OK : constants.R_OK);
            if (field === "python") candidate.pythonFile = `${target.ino}:${target.size}:${target.mtimeMs}`;
        } catch (error) {
            const reason = missing(error) ? w("path does not exist", "路径不存在") :
                ["EACCES", "EPERM"].includes(error.code) ? w("access denied or file is not executable", "无权访问或文件不可执行") : error.message;
            throw new Error(`${field} · ${reason} · ${resolved}`);
        }
        return [field, resolved];
    }));
    return Object.freeze(Object.fromEntries(entries));
}

function pythonPath(runtime, ...extra) {
    return [runtime?.src, ...extra, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
}

function projectHdc(bench) {
    return bench.projectRuntime?.configuration?.hdc || bench.config.get("hdcPath");
}

class ProjectRuntime {
    constructor(vscode, context, language, inUse = () => false, run = execute) {
        this.vscode = vscode;
        this.store = context.workspaceState;
        this.language = language;
        this.inUse = inUse;
        this.run = run;
        this.events = new EventEmitter();
        this.preference = this.store.get(preferenceKey);
        this.current = this.next = settings;
        this.entries = [];
        this.watchers = [];
        this.subscriptions = [];
        this.probes = new WeakMap();
        this.revision = 0;
        context.subscriptions.push(this);
    }

    words(en, zh) { return /^zh/i.test(this.language() || "") ? zh : en; }

    get configuration() {
        if (this.vscode.workspace.isTrusted === false) throw new Error(this.words(
            "Trust this workspace in VS Code before using a project runtime.", "请先在 VS Code 中信任此工作区。"));
        if (this.current.error) throw new Error(this.current.error);
        return this.current.runtime;
    }

    onDidChange(handler) {
        this.events.on("change", handler);
        return { dispose: () => this.events.off("change", handler) };
    }

    start() {
        const { workspace } = this.vscode;
        const watch = () => { this.watchFolders(); void this.refresh(); };
        for (const subscribe of [workspace.onDidChangeWorkspaceFolders, workspace.onDidGrantWorkspaceTrust]) {
            if (subscribe) this.subscriptions.push(subscribe(watch));
        }
        watch();
    }

    watchFolders() {
        const { workspace, RelativePattern } = this.vscode;
        for (const watcher of this.watchers.splice(0)) watcher.dispose();
        if (!RelativePattern || !workspace.createFileSystemWatcher || workspace.isTrusted === false) return;
        for (const folder of workspace.workspaceFolders || []) {
            const watcher = workspace.createFileSystemWatcher(new RelativePattern(folder, manifestPath));
            const schedule = () => {
                clearTimeout(this.timer);
                this.timer = setTimeout(() => { void this.refresh(); }, 80);
            };
            watcher.onDidCreate(schedule);
            watcher.onDidChange(schedule);
            watcher.onDidDelete(schedule);
            this.watchers.push(watcher);
        }
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.timer);
        for (const item of [...this.watchers, ...this.subscriptions]) item?.dispose();
        this.events.removeAllListeners();
    }

    async candidate(folder) {
        const { Uri, workspace } = this.vscode;
        const uri = Uri.joinPath(folder.uri, ".harmony-agent", "runtime.json");
        const entry = { id: uri.toString(), uri, folder };
        try {
            // The UI extension launches on the local host. A remote manifest must be reported if present.
            if (folder.uri.scheme === "file") await fs.lstat(uri.fsPath);
            else await workspace.fs.stat(uri);
        } catch (error) {
            if (missing(error)) return;
            entry.error = error.message;
            return entry;
        }
        try { entry.runtime = await readManifest(entry, this.words.bind(this)); }
        catch (error) { entry.error = error.message; }
        return entry;
    }

    refresh() {
        const revision = ++this.revision;
        const { workspace } = this.vscode;
        this.loading = (async () => {
            const entries = workspace.isTrusted === false ? [] : await Promise.all(
                (workspace.workspaceFolders || []).map(folder => this.candidate(folder)));
            if (this.disposed || this.revision !== revision) return;
            this.entries = entries.filter(Boolean);
            this.next = this.evaluate();
            this.apply();
        })();
        return this.loading;
    }

    evaluate() {
        if (this.preference?.kind === "settings") return settings;
        const choice = this.preference?.id;
        const chosen = this.entries.find(entry => entry.id === choice);
        if (chosen?.runtime) return { kind: "project", id: chosen.id, name: chosen.folder.name,
            runtime: chosen.runtime, pythonFile: chosen.pythonFile };
        if (chosen || choice) return { kind: "invalid", error: chosen ? this.problem(chosen) : this.words(
            `The selected runtime configuration is missing or its folder was removed. ${choice}`,
            `找不到已选的运行时配置，或所在文件夹已移出工作区。${choice}`) };
        if (this.entries.length === 1 && this.entries[0].error) return { kind: "invalid", error: this.problem(this.entries[0]) };
        if (!this.entries.length) return settings;
        return { kind: "pending", error: this.words(
            "Select and confirm a runtime with Harmony Agent: Select Project Runtime.",
            "请运行「Harmony Agent: 选择项目运行时」并确认要使用的配置。") };
    }

    problem(entry) {
        const file = entry.folder.uri.scheme === "file" ? entry.uri.fsPath : entry.id;
        return `${this.words("Invalid project runtime", "项目运行时配置无效")} · ${file}\n${entry.error}`;
    }

    apply() {
        if (this.inUse() || this.current === this.next) return false;
        const previous = this.current;
        if (JSON.stringify(previous) === JSON.stringify(this.next)) {
            this.next = previous;
            return false;
        }
        this.current = this.next;
        this.events.emit("change", this.current, previous);
        return true;
    }

    async ready(offer = false, recheck = false) {
        if (!this.loading || (recheck && !this.inUse())) this.refresh();
        let loading;
        do { loading = this.loading; await loading; } while (loading !== this.loading);
        if (this.picking) await this.picking;
        else if (offer && this.next.kind === "pending") {
            const offered = this.entries.map(entry => entry.id).join("\n");
            if (this.offered !== offered) {
                this.offered = offered;
                await this.choose(false);
            }
        }
        this.apply();
    }

    choose(force = true) {
        if (!this.picking) this.picking = this.pick(force).finally(() => { this.picking = undefined; });
        return this.picking;
    }

    async pick(force) {
        const { workspace, window } = this.vscode;
        const w = this.words.bind(this);
        if (workspace.isTrusted === false) {
            await window.showWarningMessage(w("Trust this workspace before selecting its runtime.", "请先信任此工作区，再选择项目运行时。"));
            return;
        }
        if (force) await this.refresh();
        const useSettings = w("Use VS Code settings", "使用 VS Code 设置");
        const useProject = w("Use project runtime", "使用项目运行时");
        let entry = this.entries[0];
        if (force || this.entries.length !== 1) {
            const choices = this.entries.map(candidate => ({ entry: candidate, label: candidate.folder.name,
                description: candidate.folder.uri.scheme === "file" ? candidate.folder.uri.fsPath : candidate.folder.uri.toString(),
                detail: candidate.error || (candidate.id === this.preference?.id ? w("Selected", "当前选择") : manifestPath) }));
            const chosen = await window.showQuickPick([...choices, { label: useSettings, useSettings: true }], {
                title: w("Select Project Runtime", "选择项目运行时"),
                placeHolder: w("Choose the project that supplies the tools for this window", "选择为当前窗口提供工具的项目"),
            });
            if (!chosen) return;
            if (chosen.useSettings) return this.savePreference(settings);
            entry = chosen.entry;
        }
        if (!entry || entry.error) {
            if (entry) void window.showErrorMessage(this.problem(entry));
            return;
        }
        if (entry.id === this.preference?.id) return true;
        const approved = await window.showWarningMessage(w(`Use the runtime supplied by “${entry.folder.name}”?`,
            `是否使用「${entry.folder.name}」提供的运行时？`), { modal: true, detail: w(
            `Harmony Agent will use the following project tools on this computer.\n${entry.uri.fsPath}\n\n`,
            `Harmony Agent 将在本机使用以下项目工具。\n${entry.uri.fsPath}\n\n`) +
            runtimeFields.map(field => `${field}: ${entry.runtime[field]}`).join("\n") }, useProject, useSettings);
        if (approved === useSettings) return this.savePreference(settings);
        if (approved !== useProject || workspace.isTrusted === false) return;
        await this.refresh();
        const latest = this.entries.find(candidate => candidate.id === entry.id);
        if (!latest?.runtime || JSON.stringify(latest.runtime) !== JSON.stringify(entry.runtime) || latest.pythonFile !== entry.pythonFile) {
            void window.showErrorMessage(latest?.error ? this.problem(latest) : w(
                "The project runtime changed during confirmation. Select it again.", "运行时配置在确认期间发生变化，请重新选择。"));
            return;
        }
        return this.savePreference({ kind: "project", id: entry.id });
    }

    async savePreference(preference) {
        if (this.disposed || this.vscode.workspace.isTrusted === false) return;
        await this.store.update(preferenceKey, preference);
        this.preference = preference;
        this.next = this.evaluate();
        this.apply();
        return true;
    }

    verifyPython(runtime) {
        if (this.vscode.workspace.isTrusted === false) return Promise.reject(new Error(this.words(
            "Trust this workspace in VS Code before using its Python interpreter.", "请先在 VS Code 中信任此工作区，再使用项目的 Python。")));
        if (!this.probes.has(runtime)) this.probes.set(runtime, this.checkPython(runtime).catch(error => {
            this.probes.delete(runtime);
            throw error;
        }));
        return this.probes.get(runtime);
    }

    async checkPython(runtime) {
        const w = this.words.bind(this);
        let stdout;
        try {
            ({ stdout } = await this.run(runtime.python, ["-I", "-S", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
                { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 16384 }));
        } catch (error) {
            throw new Error(`${w("Cannot start the project Python interpreter", "无法启动项目的 Python 解释器")} · ${runtime.python}\n${error.stderr?.trim() || error.message}`);
        }
        const version = /^(\d+)\.(\d+)$/.exec(stdout.trim());
        if (!version || Number(version[1]) < 3 || (Number(version[1]) === 3 && Number(version[2]) < 10))
            throw new Error(`${w("Project runtime requires Python 3.10 or newer", "项目运行时需要 Python 3.10 或更新版本")} · ${runtime.python}` +
                (version ? ` · ${version[0]}` : ""));
    }
}

module.exports = { ProjectRuntime, projectHdc, pythonPath };
