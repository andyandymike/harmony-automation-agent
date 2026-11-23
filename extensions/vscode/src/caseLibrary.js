"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { findCase } = require("./pytestCase");
const { createBdd } = require("./caseBdd");

const suffix = ".harmony-case.json";
const format = "harmony-agent.case";
const sources = new Set(["recording", "exploration", "workflow", "imported"]);
const origins = ["reportId", "findingId", "stepId", "branchId", "outcome", "label"];

function description(name, source, origin) {
    const meta = {id: randomUUID(), name, source};
    if (origin) meta.origin = Object.fromEntries(origins.filter(key =>
        ["string", "number"].includes(typeof origin[key])).map(key => [key, String(origin[key]).slice(0, 300)]));
    return meta;
}

function valid(meta) {
    return meta?.format === format && meta.version === 1 && typeof meta.id === "string" &&
        meta.id.length > 0 && typeof meta.name === "string" && meta.name.trim() && sources.has(meta.source);
}

async function readMetadata(file) {
    try {
        const data = JSON.parse(await fs.readFile(file, "utf8"));
        return valid(data) ? data : undefined;
    } catch (error) {
        if (error instanceof SyntaxError || ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) return;
        throw error;
    }
}

async function readCaseMetadata(uri) {
    if (uri?.scheme === "file") return readMetadata(uri.fsPath + suffix);
}

async function writeCaseMetadata(uri, {name, source, origin, presentation, composition, section}) {
    if (uri.scheme !== "file" || !sources.has(source) || !name?.trim()) throw new Error("Invalid case metadata");
    const marker = uri.fsPath + suffix;
    const data = {format, version: 1, ...description(name.trim(), source, origin), ...(presentation && {presentation}),
        ...(composition && {composition}),...(section && {section:true})};
    // Publish the complete marker in one operation, without replacing another case's identity.
    const staging = marker + "." + data.id + ".tmp";
    await fs.writeFile(staging, JSON.stringify(data, null, 2) + "\n", {flag: "wx", mode: 0o600});
    try {
        try { await fs.link(staging, marker); }
        catch (error) {
            if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error.code)) throw error;
            await fs.copyFile(staging, marker, fs.constants.COPYFILE_EXCL);
        }
        return data;
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await readMetadata(marker);
        if (existing) return existing;
        throw new Error("The case metadata filename is already in use: " + path.basename(marker));
    } finally {
        await fs.unlink(staging).catch(() => {});
    }
}

function defaultName(uri) {
    const filename = path.basename(uri.fsPath || uri.path);
    return filename === "workflow.json" ? path.basename(path.dirname(uri.fsPath || uri.path)) : filename.replace(/\.json$/i, "");
}

class CaseLibrary {
    constructor(vscode, context) {
        this.vscode = vscode;
        this.state = context.workspaceState;
        this.pending = Promise.resolve();
    }

    async add(uri, {name = defaultName(uri), source = "imported", origin, presentation, composition, section} = {}) {
        if (!sources.has(source)) throw new Error("Unknown case source");
        const address = uri.toString();
        const folder = this.vscode.workspace.getWorkspaceFolder?.(uri);
        const relative = folder && path.relative(folder.uri.fsPath, uri.fsPath);
        const portable = source !== "imported" && uri.scheme === "file";
        const meta = portable ? await writeCaseMetadata(uri, {name, source, origin, presentation, composition, section}) : undefined;
        const update = async () => {
            const saved = this.state.get("caseLibrary", {});
            const {composition:_layout, ...index} = meta || saved[address] || description(name,source,origin);
            const record = {...index,uri:address};
            if (relative) Object.assign(record, {folderName: folder.name, relative});
            await this.state.update("caseLibrary", {...saved, [address]: record});
            const hidden = this.state.get("hiddenCases", []);
            if (hidden.includes(address)) await this.state.update("hiddenCases", hidden.filter(item=>item!==address));
            return record;
        };
        const current = this.pending.then(update);
        this.pending = current.catch(() => {});
        return current;
    }

    async registerExisting(uri) {
        const known = this.state.get("caseLibrary", {})[uri.toString()];
        if (!known && (uri.scheme !== "file" || !(await readMetadata(uri.fsPath + suffix) || await findCase(uri)))) return false;
        await this.add(uri);
        return true;
    }

    setHidden(address, hidden) {
        const current = this.pending.then(async()=>{
            const entries = new Set(this.state.get("hiddenCases", []));
            if (hidden) entries.add(address);
            else entries.delete(address);
            await this.state.update("hiddenCases", [...entries]);
        });
        this.pending = current.catch(()=>{});
        return current;
    }

    async managedFolder(uri) {
        if (uri.scheme!=="file" || path.basename(uri.fsPath)!=="workflow.json") return;
        const folder = path.dirname(uri.fsPath);
        const {workspace, Uri} = this.vscode;
        const meta = await readMetadata(uri.fsPath+suffix);
        if (!meta || meta.source==="imported") return;
        if (!(await fs.lstat(folder)).isDirectory()) return;
        const resolved = await fs.realpath(folder);
        for (const project of workspace.workspaceFolders || []) {
            if (project.uri.scheme!=="file") continue;
            const root = await fs.realpath(project.uri.fsPath).catch(()=>undefined);
            if (root && path.relative(resolved,root)==="") return;
        }
        const names = new Set(["workflow.json","workflow.json"+suffix,(await findCase(uri))?.filename]);
        const entries = await fs.readdir(folder,{withFileTypes:true});
        if (!["workflow.json","workflow.json"+suffix].every(name=>entries.some(entry=>entry.name===name && entry.isFile()))) return;
        if (!entries.every(entry=>entry.isFile() && names.has(entry.name) ||
            entry.isDirectory() && [".pytest_cache","__pycache__"].includes(entry.name))) return;
        return Uri.file(resolved);
    }

    async updateMetadata(uri, changes, originalPresentation, originalComposition) {
        const marker = uri.fsPath + suffix;
        const previous = await readMetadata(marker);
        if (!previous) throw new Error("The case metadata is unavailable.");
        const conflict = () => new Error("The case metadata changed. Reopen the case before editing it.");
        const revised = {...previous,...changes};
        if (Object.hasOwn(changes,"presentation") && !isDeepStrictEqual(previous.presentation,originalPresentation)) throw conflict();
        if (Object.hasOwn(changes,"composition") && !isDeepStrictEqual(previous.composition,originalComposition)) throw conflict();
        if (JSON.stringify(revised) === JSON.stringify(previous)) return;
        const stage = marker + "." + randomUUID() + ".tmp";
        try {
            await fs.writeFile(stage, JSON.stringify(revised, null, 2) + "\n", {flag:"wx",mode:0o600});
            if (!isDeepStrictEqual(await readMetadata(marker),previous)) throw conflict();
            await fs.rename(stage, marker);
        } finally {
            await fs.unlink(stage).catch(() => {});
        }
    }

    async list(runs = [], {includeHidden=false} = {}) {
        await this.pending;
        const {workspace, Uri} = this.vscode;
        const hidden = new Set(this.state.get("hiddenCases", []));
        const candidates = new Map();
        function add(uri, fields = {}) {
            const key = uri.toString();
            candidates.set(key, {...candidates.get(key), ...fields, uri});
        }
        for (const record of Object.values(this.state.get("caseLibrary", {}))) {
            const folder = workspace.workspaceFolders?.find(item => item.name === record.folderName);
            const uri = folder && record.relative ? Uri.joinPath(folder.uri, ...record.relative.split(/[\\/]/)) : Uri.parse(record.uri);
            add(uri, {registered: record});
        }
        for (const [address, entry] of Object.entries(this.state.get("pytestCases", {}))) add(Uri.parse(address), {pytest: entry});
        if (workspace.findFiles && workspace.workspaceFolders?.length) {
            const files = await workspace.findFiles("**/{workflow.json,*" + suffix + "}",
                "**/{.git,node_modules,.venv,venv,__pycache__,.pytest_cache}/**");
            for (const uri of files) {
                if (uri.scheme !== "file") continue;
                if (uri.fsPath.endsWith(suffix)) add(Uri.file(uri.fsPath.slice(0, -suffix.length)), {marker: uri.fsPath});
                else add(uri);
            }
        }
        const items = [];
        for (const candidate of candidates.values()) {
            const {uri, registered, pytest, marker} = candidate;
            const isHidden = hidden.has(uri.toString());
            if (isHidden && !includeHidden) continue;
            if (uri.scheme === "file") {
                try { if (!(await fs.stat(uri.fsPath)).isFile()) continue; }
                catch (error) {
                    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code)) continue;
                    throw error;
                }
            }
            const metadataFile = marker || (registered && uri.scheme === "file" ? uri.fsPath + suffix : undefined);
            const meta = metadataFile ? await readMetadata(metadataFile) : undefined;
            const test = pytest || await findCase(uri);
            if (!meta && !registered && !test) continue;
            const record = meta || registered;
            const address = uri.toString();
            items.push({id: record?.id || address, uri: address, previousUri: registered?.uri, name: record?.name || defaultName(uri),
                source: record?.source || "workflow", origin: record?.origin, runner: test ? "pytest" : "workbench",
                ...(isHidden && {hidden:true}),...(meta?.id && {portableId:meta.id}),...(meta?.section && {section:true}),
                ...(Array.isArray(meta?.tags) && {tags:meta.tags.filter(tag=>typeof tag==="string").slice(0,20)}),
                editable:Boolean(meta && meta.source!=="imported" && uri.scheme==="file" && path.basename(uri.fsPath)==="workflow.json")});
        }
        const ids = new Set(), repeated = new Set(), names = new Set(), sharedNames = new Set();
        for (const {id, name} of items) {
            if (ids.has(id)) repeated.add(id);
            if (names.has(name)) sharedNames.add(name);
            ids.add(id);
            names.add(name);
        }
        const cases = items.map(({previousUri, ...item}) => {
            // Two copies in the same workspace can share their portable ID. Their histories belong to distinct files.
            if (repeated.has(item.id)) {
                item.id = item.uri;
                delete item.portableId;
            }
            if (sharedNames.has(item.name)) {
                const uri = Uri.parse(item.uri);
                item.location = workspace.asRelativePath?.(uri, true) || uri.fsPath || uri.path;
            }
            const last = runs.find(r => !r.compositionTrial && (!r.repairOf || r.repairApplied) &&
                (r.caseId === item.id || r.plan?.uri === item.uri || (previousUri && r.plan?.uri === previousUri)));
            if (last) item.lastRun = {id: last.id, status: last.status, source:last.source, at: last.time};
            return item;
        });
        return cases.sort((a, b) => (b.lastRun?.at || "").localeCompare(a.lastRun?.at || "") || a.name.localeCompare(b.name));
    }
}

module.exports = {CaseLibrary, createBdd, readCaseMetadata, writeCaseMetadata};
