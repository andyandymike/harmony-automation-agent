"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const journalPath = (directory, id) => path.join(directory,"runs",id,"run.json");

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

module.exports = {journalPath, watchRunJournal};
