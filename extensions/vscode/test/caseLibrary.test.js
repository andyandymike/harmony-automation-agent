"use strict";

const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL, fileURLToPath} = require("node:url");
const {CaseLibrary, createBdd, writeCaseMetadata} = require("../src/caseLibrary");
const {writeCase} = require("../src/pytestCase");
const loadWebview = require("../test-support/loadWebview");

const check = {selector: {id: "cart"}, property: "visible", equals: true};
const plan = {version: "1", preconditions: [check], steps: [{command: "press", input: {target: {id: "buy"}}}], goals: [check]};
const Uri = {
    file: filename => ({scheme: "file", fsPath: filename, toString: () => pathToFileURL(filename).href}),
    parse: address => Uri.file(fileURLToPath(address)),
    joinPath: (uri, ...segments) => Uri.file(path.join(uri.fsPath, ...segments)),
};

function host(project, paths, store = new Map()) {
    const folder = {uri: Uri.file(project), name: "app"};
    const workspace = {
        workspaceFolders: [folder],
        getWorkspaceFolder: uri => path.relative(project, uri.fsPath).startsWith("..") ? undefined : folder,
        findFiles: async () => paths.map(name => Uri.file(path.join(project, name))),
    };
    const workspaceState = {get: (key, fallback) => store.get(key) ?? fallback, update: async (key, val) => store.set(key, val)};
    return new CaseLibrary({workspace, Uri}, {workspaceState});
}

test("only explicit case markers and recognized generated tests appear in a fresh workspace", async t => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "ha-library-"));
    const copy = await fs.mkdtemp(path.join(os.tmpdir(), "ha-library-copy-"));
    t.after(() => Promise.all([project, copy].map(dir => fs.rm(dir, {recursive: true, force: true}))));
    const paths = [path.join("checkout", "workflow.json"), "workflow.json", "basket.json.harmony-case.json"];
    await writeCase(project, "checkout", plan);
    await fs.writeFile(path.join(project, "workflow.json"), JSON.stringify({unrelated: true}));
    const source = Uri.file(path.join(project, "basket.json"));
    await fs.writeFile(source.fsPath, JSON.stringify(plan));
    const store = new Map(), lib = host(project, paths, store);
    const rec = await lib.add(source, {source: "exploration", name: "Add to basket", origin: {reportId: "r1", outcome: "passed"}});
    assert.deepEqual((await lib.list()).map(e => [e.name, e.runner]), [["Add to basket", "workbench"], ["checkout", "pytest"]]);
    const copied = path.join(copy, "app");
    await fs.cp(project, copied, {recursive: true});
    const reopened = await host(copied, paths).list([{id: "run", time: "2026-05-19T12:10:00Z", status: "failed", caseId: rec.id}]);
    assert.equal(reopened[0].id, rec.id);
    assert.equal(reopened[0].origin.reportId, "r1");
    assert.equal(reopened[0].lastRun.status, "failed");
    assert.equal(reopened[0].uri, Uri.file(path.join(copied, "basket.json")).toString());
    await fs.writeFile(path.join(project, "import.json"), JSON.stringify(plan));
    assert.equal(await lib.registerExisting(Uri.file(path.join(project, "import.json"))), false);
    await lib.add(Uri.file(path.join(project, "import.json")));
    assert.equal((await host(project, paths, store).list()).length, 3);
    await assert.rejects(fs.stat(path.join(project, "import.json.harmony-case.json")), {code: "ENOENT"});
    await fs.mkdir(path.join(project, "second"));
    for (const file of ["basket.json", "basket.json.harmony-case.json"]) {
        await fs.copyFile(path.join(project, file), path.join(project, "second", file));
    }
    const duplicates = await host(project, [...paths, "second/basket.json.harmony-case.json"]).list([
        {id: "run", status: "failed", caseId: rec.id, plan: {uri: source.toString()}}]);
    const twins = duplicates.filter(item => item.name === "Add to basket");
    assert.equal(new Set(twins.map(item => item.id)).size, 2);
    assert.equal(new Set(twins.map(item => item.location)).size, 2);
    assert.deepEqual(twins.filter(item => item.lastRun).map(item => item.uri), [source.toString()]);
    const external = Uri.file(path.join(copied, "basket.json"));
    assert.equal(await lib.registerExisting(external), true);
    const opened = (await lib.list()).find(item=>item.uri===external.toString());
    assert.equal(opened.name, rec.name);
    assert.equal(opened.source, rec.source);
});

test("a saved case keeps one identity on repeated or concurrent registration and respects existing sidecars", async t => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "ha-case-metadata-"));
    t.after(() => fs.rm(project, {recursive: true, force: true}));
    const uri = Uri.file(path.join(project, "auth.json"));
    await fs.writeFile(uri.fsPath, JSON.stringify(plan));
    const fields = {name: "Sign in", source: "recording"};
    const [first, second] = await Promise.all([writeCaseMetadata(uri, fields), writeCaseMetadata(uri, fields)]);
    assert.equal(first.id, second.id);
    await fs.writeFile(uri.fsPath + ".harmony-case.json", "external document");
    await assert.rejects(writeCaseMetadata(uri, fields), /already in use/);
    assert.equal(await fs.readFile(uri.fsPath + ".harmony-case.json", "utf8"), "external document");
    const offline = new CaseLibrary({workspace: {}, Uri}, {workspaceState: {get: (_, val) => val}});
    assert.deepEqual(await offline.list(), []);
});

test("removing a case from the library persists without changing files, and a shared folder is not a trash target",async t=>{
    const project=await fs.mkdtemp(path.join(os.tmpdir(),"ha-remove-case-"));
    t.after(()=>fs.rm(project,{recursive:true,force:true}));
    const store=new Map();
    const {folder}=await writeCase(project,"Checkout",plan);
    const file=Uri.file(path.join(folder,"workflow.json"));
    const paths=["Checkout/workflow.json","Checkout/workflow.json.harmony-case.json"];
    const library=host(project,paths,store);
    await library.add(file,{name:"Checkout",source:"recording"});
    const contents=await fs.readFile(file.fsPath,"utf8");
    assert.equal((await library.managedFolder(file)).fsPath,await fs.realpath(folder));
    await library.setHidden(file.toString(),true);
    const reopened=host(project,paths,store);
    assert.deepEqual(await reopened.list(),[]);
    assert.equal(await fs.readFile(file.fsPath,"utf8"),contents);
    assert.equal(await reopened.registerExisting(file),true);
    assert.equal((await reopened.list())[0].name,"Checkout");
    await fs.writeFile(path.join(folder,"company_fixture.py"),"fixture = 1\n");
    assert.equal(await reopened.managedFolder(file),undefined);
});

test("Given When Then follows guards, branching and bounded repetition and conceals filled values", async () => {
    const nested = {version: "2", preconditions: [check], steps: [
        {command: "fill", before: [check], input: {target: {id: "password"}, text: "secret-input",
            expect: {selector: {id: "password"}, equals: "secret-expectation"}}},
        {if: check, then: [{read: {name: "total", selector: {id: "total"}, property: "text"}}],
            else: [{repeat: {limit: 2, until: check, steps: [{assert: {selector: {id: "note"}, equals: "<b>paid</b>"}}]}}]}],
        goals: [{selector: {id: "total"}, equals: {var: "total"}}]};
    const bdd = createBdd(nested, "zh-CN", {name: "示例规则"});
    assert.deepEqual(bdd.given, ["使用规则组 示例规则", "cart 可见"]);
    assert.deepEqual(bdd.when[0].before, ["cart 可见"]);
    assert.match(bdd.when[0].after, /••••/);
    assert.equal(bdd.when[1].branches[1].steps[0].branches[0].steps[0].path, "steps[1].else[0].repeat.steps[0]");
    assert.deepEqual(bdd.then, ["total 显示 $total"]);
    assert.doesNotMatch(JSON.stringify(bdd), /secret-(input|expectation)/);
    const {caseBddView, caseLibraryView} = await loadWebview("caseLibrary");
    const markup = caseBddView(bdd, "zh-CN");
    assert.match(markup, /<details id="case-branch-steps\[1\]"><summary>如果 cart 可见/);
    assert.match(markup, /最多重复 2 次/);
    assert.match(markup, /&lt;b&gt;paid&lt;\/b&gt;/);
    const ui = caseLibraryView({cases: [{uri: "file:///x.json", name: "<Case>", source: "exploration",
        runner: "pytest", lastRun: {id: "r", status: "failed", at: "2026-06-26T03:00:00Z"}}]}, "zh-CN");
    assert.match(ui, /&lt;Case&gt;/);
    assert.match(ui, /<small>AI 探索<\/small>/);
    assert.doesNotMatch(ui, /pytest|caseImport/);
    assert.equal(ui.match(/data-type="openPlan"/g)?.length, 1);
    assert.match(ui, /失败/);
    assert.match(ui, /data-type="caseOpen" data-id="file:\/\/\/x.json"/);
    const gestures = createBdd({format: "harmony-agent.device-recording", steps: [
        {command: "deviceGesture", input: {kind: "swipe", x: 0, y: 5, toX: 5, toY: 8}}]});
    assert.match(caseBddView(gestures, "en"), /Swipe \(0, 5\) → \(5, 8\)/);
    assert.match(caseBddView(gestures, "en"), /No final assertion recorded/);
});
