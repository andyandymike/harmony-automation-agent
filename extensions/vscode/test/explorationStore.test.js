"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { ExplorationStore } = require("../src/explorationStore");

test("a reopened exploration shows the last durable intent and offers recovery after its host exits", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),"exploration-store-"));
    t.after(() => fs.rm(dir,{recursive:true,force:true}));
    const store = new ExplorationStore(dir);
    const report = {id:randomUUID(),mode:"free",goal:"Settings",status:"running",pages:[],findings:[],
        createdAt:new Date().toISOString(),pending:{runId:randomUUID()},branches:[{status:"passed"},{status:"running"}]};
    await store.save(report);
    assert.equal((await store.load(report.id)).status,"running");
    const file = store.file(report.id);
    const interrupted = JSON.parse(await fs.readFile(file,"utf8"));
    interrupted.writerPid = 0;
    await fs.writeFile(file,JSON.stringify(interrupted));
    const reopened = new ExplorationStore(dir);
    assert.equal((await reopened.history())[0].status,"paused");
    const recovered = await reopened.load(report.id);
    assert.deepEqual(recovered.pending, report.pending);
    assert.deepEqual(recovered.branches.map(b => b.status), ["passed", "paused"]);
    assert.throws(() => store.file("../outside"));
});

test("overlapping resume requests get one writer and a crashed owner's slot can be recovered", async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(),"exploration-writer-"));
    t.after(() => fs.rm(dir,{recursive:true,force:true}));
    const store = new ExplorationStore(dir), second = new ExplorationStore(dir), id = randomUUID();
    await fs.writeFile(store.file(id) + ".writer-0","0");
    await store.withWriter(id,async () => {
        await assert.rejects(second.withWriter(id,() => assert.fail("second writer")), {code:"EXPLORATION_IN_USE"});
    });
    assert.equal(await second.withWriter(id,() => 7),7);
});
