"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { finishExplorationBranches } = require("./explorationEngine");

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function summary(report) {
    const { id, goal, mode, status, device, createdAt, updatedAt, reason } = report;
    return { id, goal, mode, status, device, createdAt, updatedAt, reason,
        pages: report.pages.length, findings: report.findings.length };
}

function ownerAlive(pid) {
    if (!Number.isInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

class ExplorationStore {
    constructor(directory) { this.directory = directory; }

    file(id) {
        if (!uuid.test(id)) throw new Error("Invalid exploration ID.");
        return path.join(this.directory, id + ".json");
    }

    async load(id) {
        const report = JSON.parse(await fs.readFile(this.file(id), "utf8"));
        if (report.status === "running" && !ownerAlive(report.writerPid)) {
            report.status = "paused";
            report.reason = /^zh/i.test(report.language) ? "工作台已关闭，可以从原设备继续。" :
                "The workbench closed. Resume on the original device.";
            finishExplorationBranches(report);
        }
        return report;
    }

    async history() {
        let files;
        try { files = await fs.readdir(this.directory); }
        catch (error) { if (error.code === "ENOENT") return []; throw error; }
        const ids = files.filter(f => f.endsWith(".json") && uuid.test(f.slice(0,-5))).map(f => f.slice(0,-5));
        const entries = await Promise.all(ids.map(async id => summary(await this.load(id))));
        return entries.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    async save(report) {
        await fs.mkdir(this.directory, {recursive:true});
        const file = this.file(report.id), temp = file + "." + randomUUID() + ".tmp";
        report.updatedAt = new Date().toISOString();
        report.writerPid = report.status === "running" ? process.pid : undefined;
        try {
            await fs.writeFile(temp, JSON.stringify(report), {flag:"wx",mode:0o600});
            await fs.rename(temp,file);
        } finally {
            await fs.rm(temp,{force:true});
        }
    }

    // Publish an already populated owner file atomically. After an extension-host
    // crash, contenders all compete for the same next slot without removing a live lock.
    async withWriter(id, action) {
        const base = this.file(id);
        await fs.mkdir(this.directory, {recursive:true});
        const owner = base + "." + randomUUID() + ".owner";
        await fs.writeFile(owner, String(process.pid), {flag:"wx",mode:0o600});
        let lock;
        try {
            for (let slot = 0; !lock; slot++) {
                const candidate = base + ".writer-" + slot;
                try { await fs.link(owner, candidate); lock = candidate; }
                catch (error) {
                    if (error.code !== "EEXIST") throw error;
                    let value;
                    try { value = await fs.readFile(candidate, "utf8"); }
                    catch (readError) { if (readError.code === "ENOENT") { slot--; continue; } throw readError; }
                    if (ownerAlive(Number(value))) throw Object.assign(new Error("This exploration is open in another session."),
                        {code:"EXPLORATION_IN_USE"});
                }
            }
            return await action();
        } finally {
            if (lock) await fs.unlink(lock);
            await fs.unlink(owner);
        }
    }
}

module.exports = { ExplorationStore, summary };
