"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const journalPath = (directory, id) => path.join(directory,"runs",id,"run.json");

// The summary uses recorded outcomes. Full reports also verify every frozen frame.
async function readSummaryRecord(directory, entry, loadFullReport) {
    if (/^[\w-]+$/.test(entry.id)) {
        try {
            const record = JSON.parse(await fs.readFile(journalPath(directory,entry.id),"utf8"));
            if (record?.schema==="harmony-run/1" && record.runId===entry.id &&
                Array.isArray(record.receipts) && Array.isArray(record.frames) &&
                typeof record.result?.status==="string" && record.result.status!=="running" &&
                (entry.cleanup || record.result.sessionCleanup?.status)) return record;
        } catch { /* Older or incomplete archives are interpreted by their runtime. */ }
    }
    return loadFullReport();
}

async function withRunReceipts(directory,id,result) {
    if (Array.isArray(result.receipts) || result.runId!==id || !/^[a-zA-Z0-9_-]+$/.test(id)) return result;
    try {
        const journal = JSON.parse(await fs.readFile(journalPath(directory,id),"utf8"));
        if (journal.runId===id && journal.result?.status===result.status && Array.isArray(journal.receipts))
            return {...result,receipts:journal.receipts};
    } catch { /* Keep the run result available when the journal cannot be read. */ }
    return result;
}

function watchRunJournal(locate, onUpdate) {
    let stopped = false;
    let reading = false;
    let last;
    async function read() {
        if (stopped || reading) return;
        reading = true;
        try {
            const journal = await locate();
            if (!journal) return;
            const changed = (await fs.stat(journal.file)).mtimeMs;
            if (last?.file === journal.file && last.changed === changed) return;
            const record = JSON.parse(await fs.readFile(journal.file,"utf8"));
            if (stopped || record.runId !== journal.id || !Array.isArray(record.receipts)) return;
            last = {file:journal.file,changed};
            onUpdate(record);
        } catch (error) {
            // A missing journal (or a transient lock on replacement) should not change the test result.
            if (!["ENOENT","ENOTDIR","EACCES","EBUSY","EPERM"].includes(error.code) && !(error instanceof SyntaxError))
                console.warn("Harmony Agent run progress",error.code || error.name);
        } finally {
            reading = false;
        }
    }
    const timer = setInterval(read,350);
    timer.unref();
    void read();
    return () => { stopped = true; clearInterval(timer); };
}

module.exports = {journalPath,readSummaryRecord,withRunReceipts,watchRunJournal};
