"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const {createBdd} = require("./caseLibrary");
const {deviceRecordingFormat, moveListItem} = require("./model");
const {sourceDigest} = require("./caseRepair");
const {readiness, safeCaseName, writeCase, findCase, templatePath, testFilename} = require("./pytestCase");
const {readWorkflow, workflowWithScenario} = require("./workflowFile");

const booleanProperties = ["visible", "enabled", "checked", "selected", "focused"];
const targetCommands = new Set(["press", "fill", "scroll", "wait"]);
const sensitiveControl = /pass(?:word|code)|secret|token|密码|口令|验证码/i;

function editableCheck(check) {
    const property = check?.property || "text";
    const expected = check?.equals;
    if (!check?.selector || !(property === "text" ? typeof expected === "string" :
        booleanProperties.includes(property) && typeof expected === "boolean")) return;
    const protectedValue = property === "text" && sensitiveControl.test(JSON.stringify(check.selector));
    return {property, expected:protectedValue ? "" : String(expected), protectedValue};
}

function editableSteps(steps, path = "steps", items = {}, depth = 0) {
    if (!Array.isArray(steps) || depth > 8) return items;
    steps.forEach((step, index) => {
        const key = path + "[" + index + "]";
        if (targetCommands.has(step?.command) && step?.input?.target) {
            const simpleFill = step.command === "fill" && typeof step.input.text === "string";
            // A stored input value can be sensitive, even when the selector has no hint.
            items[key] = {locator:true, ...(simpleFill && {replaceText:true})};
        }
        if (step?.if) {
            editableSteps(step.then,key+".then",items,depth+1);
            editableSteps(step.else,key+".else",items,depth+1);
        }
        if (step?.repeat) editableSteps(step.repeat.steps,key+".repeat.steps",items,depth+1);
    });
    return items;
}

function stepLocation(plan, path) {
    const parts = /^(steps\[\d+\])(?:(?:\.then|\.else|\.repeat\.steps)\[\d+\])*$/u;
    if (typeof path !== "string" || path.length > 200 || !parts.test(path)) return;
    const keys = path.split(/[.\[\]]+/).filter(Boolean);
    const index = Number(keys.pop());
    const list = keys.reduce((item,key)=>item?.[key],plan);
    return {list,index};
}

function caseDefinitions(plan) {
    const conditions = key => Array.isArray(plan[key]) ? plan[key].map(editableCheck) : [];
    return {start:conditions("preconditions"),goal:conditions("goals"),steps:editableSteps(plan.steps)};
}

async function canEditCase(uri, entry) {
    return Boolean(entry && entry.source !== "imported" && uri.scheme === "file" &&
        path.basename(uri.fsPath) === "workflow.json" &&
        await fs.access(uri.fsPath+".harmony-case.json").then(()=>true,()=>false));
}

function suggestedName(value) {
    const cleaned = String(value || "").replace(/(?:\.plan)?\.json$/i, "").replace(/[^\p{L}\p{N}_-]+/gu, " ").trim().slice(0, 64).trim();
    return safeCaseName(cleaned) ? cleaned : "workflow";
}

async function writeReplay(parent, name, plan, group) {
    const folder = path.join(parent, name);
    const contents = group ? workflowWithScenario(plan,group) : plan;
    const json = JSON.stringify(contents,null,2) + "\n";
    await fs.mkdir(folder, {mode:0o700});
    const target = path.join(folder,"workflow.json");
    let file;
    try {
        file = await fs.open(target,"wx",0o600);
        await file.writeFile(json);
        await file.close();
    } catch (error) {
        if (file) { await file.close().catch(()=>{}); await fs.unlink(target).catch(()=>{}); }
        await fs.rmdir(folder).catch(()=>{});
        throw error;
    }
    return folder;
}

class CaseAuthoring {
    constructor(bench,vscode) {
        this.bench = bench;
        this.vscode = vscode;
    }

    words(en,zh) { return /^zh/i.test(this.bench.language) ? zh : en; }

    async open(message) {
        if (this.candidate) return;
        const bench = this.bench, draft = bench.state.draft;
        if (draft) {
            const plan = bench.planFromDraft(message);
            if (plan.steps.some(step=>step.input?.kind === "unsupported"))
                throw new Error(this.words("Remove unsupported gestures before saving a case.", "请先移除无法回放的手势，再保存用例。"));
            const source = draft.originAI ? "exploration" : "recording";
            const name = draft.originAI ? this.words("AI exploration","AI 探索") : this.words("Recording","录制用例");
            this.begin({source, origin:{outcome:"observed"}, plan, name,
                recording:draft, nodes:side=>side==="start"?draft.start:draft.end});
            return;
        }
        const selected = bench.planForRun(message.fromRun);
        if (!selected) throw new Error(bench.text.chooseSavedPlan);
        if (message.fromRun) return this.fromRun(bench.state.run);
        const uri = this.vscode.Uri.parse(selected.uri);
        const doc = await this.vscode.workspace.openTextDocument(uri);
        const original = doc.getText();
        const {plan,scenario} = readWorkflow(original);
        const existing = bench.state.activeCase?.uri === selected.uri ? bench.state.activeCase : undefined;
        const portable = await canEditCase(uri,existing);
        const copy = message.copy === true;
        const name = copy ? selected.name.slice(0,60).trim()+this.words(" copy"," 副本") : selected.name;
        this.begin({source:existing?.source==="imported" ? "workflow" : existing?.source || "workflow",
            origin:existing?.origin,name,plan,group:scenario || bench.networks.bindings?.[selected.uri],
            ...(portable && !copy && {edit:{uri,original}})});
    }

    async fromRun(run) {
        const b = this.bench, entry = run.entry;
        if (!entry || !/^[a-zA-Z0-9_-]+$/.test(entry.id) || !run.steps?.length)
            throw new Error(this.words("This report has no recorded workflow steps.","本次运行尚无可用的操作步骤。"));
        const candidate = {name:entry.plan.name,source:"workflow",origin:{reportId:entry.id,
            outcome:run.goalStatus==="failed" ? "checkFailed" : run.goalStatus==="passed" ? "checksPassed" : "observed"}};
        if (entry.source === "device") {
            const steps = [];
            for (const row of run.steps) {
                if (row.status !== "completed" || row.dispatched !== "acknowledged" || !row.gesture) break;
                steps.push({command:"deviceGesture", input:row.gesture,label:row.label,...(row.delayMs && {delayMs:row.delayMs})});
            }
            candidate.plan = {format:deviceRecordingFormat,version:1,steps};
            candidate.source = "recording";
            candidate.timingUnknown = entry.gestureTimingVersion !== 1;
        } else if (entry.source === "pytest") {
            if (!entry.pytest.workflowSource) throw new Error(this.words("This pytest run has no verified workflow snapshot.",
                "这次 pytest 运行没有可核对的流程版本。"));
            const file = readWorkflow(await fs.readFile(entry.pytest.workflowSource,"utf8"));
            candidate.plan = file.plan;
            candidate.group = file.scenario;
        } else {
            const target = path.join(b.stateDir,"runs",entry.id,"plan.json");
            try { candidate.plan = JSON.parse(await fs.readFile(target,"utf8")); }
            catch (error) {
                if (error.code!=="ENOENT") throw error;
                throw new Error(this.words("The workflow snapshot for this run is unavailable.","这次回放使用的流程版本已不可用。"));
            }
        }
        if (entry.source!=="pytest") candidate.group = await b.networks.scenarioForRun?.(entry.id);
        this.begin(candidate);
    }

    begin(candidate) {
        if (!candidate.plan?.steps?.length || !Array.isArray(candidate.plan.steps) || readiness(candidate.plan)==="invalid")
            throw new Error(this.words("No executable steps are available.", "还没有可执行的步骤。"));
        const state = this.bench.state;
        this.candidate = {...candidate, plan:structuredClone(candidate.plan), group:candidate.group && structuredClone(candidate.group),
            id:randomUUID(), revision:0, targets:{}, originalName:candidate.name, name:candidate.edit ? candidate.name : suggestedName(candidate.name),
            previousTool:state.tool};
        state.tool = "recordings";
        this.update();
    }

    update() {
        const c = this.candidate, plan = c.plan;
        const targets = Object.fromEntries(Object.entries(c.targets).map(([key, values])=>[key,
            values.map(({label},index)=>({label,key:String(index)}))]));
        this.bench.state.caseReview = {id:c.id,revision:c.revision,name:c.name,source:c.source,origin:c.origin,groupName:c.group?.name,
            issue:readiness(plan),bdd:createBdd(plan,this.bench.language,c.group),added:c.added,timingUnknown:c.timingUnknown,edit:Boolean(c.edit),
            dirty:Boolean(c.added || c.reordered || c.name !== c.originalName || c.uri), pendingSave:Boolean(c.uri),
            definitions:caseDefinitions(plan),targets};
    }

    cancel(stay = false) {
        const c = this.candidate;
        this.candidate = undefined;
        this.bench.state.caseReview = undefined;
        if (!stay && c?.previousTool && this.bench.state.tool === "recordings") this.bench.state.tool = c.previousTool;
    }

    async loadTargets({id, area}) {
        const c = this.candidate;
        if (!c || c.id !== id || !["start","goal","step"].includes(area) || c.targets[area] || c.uri) return;
        const snapshots = area === "step" ? await Promise.all([c.nodes?.("start"),c.nodes?.("goal")]) : [await c.nodes?.(area)];
        const captured = snapshots.flatMap(nodes=>nodes || []);
        const current = this.bench.state.page?.nodes || [];
        const targets = new Map();
        for (const node of [...captured, ...current]) {
            if (!node.selector || (node.editable && node.selector.text) || sensitiveControl.test(node.selector.text || "")) continue;
            const label = node.editable ? node.id || node.type : node.label || node.id || node.type;
            if (!label) continue;
            const key = JSON.stringify(node.selector);
            if (!targets.has(key)) targets.set(key, {selector:node.selector,label:String(label).slice(0,120)});
            if (targets.size >= 150) break;
        }
        if (this.candidate !== c) return;
        c.targets[area] = [...targets.values()];
        this.update();
    }

    target(c, area, message, current) {
        const value = message.target;
        if (value === "keep" && current) return current;
        if (typeof value === "string" && /^\d{1,3}$/.test(value) && c.targets[area]?.[Number(value)])
            return structuredClone(c.targets[area][Number(value)].selector);
        const id = typeof message.controlId === "string" && message.controlId.trim();
        if (value !== "manual" || !id || id.length > 256 || /[\x00-\x1f]/u.test(id))
            throw new Error(this.words("Choose a control or enter a stable control ID.","请选择控件或输入稳定的控件 ID。"));
        const bundleName = current?.bundleName || c.bundle;
        return {...(bundleName && {bundleName}),id};
    }

    async edit({id, revision, area, path, index, property, expected, name, replaceText, text, saveName, ...target}) {
        const c = this.candidate;
        if (!c || c.id !== id || c.revision !== revision || c.uri) return;
        if (area === "name") {
            const value = typeof name === "string" ? name.trim() : "";
            if (!safeCaseName(value)) throw new Error(this.words("Enter a valid case name of up to 70 characters.","请输入不超过 70 个字符的有效用例名称。"));
            c.name = value;
        } else if (area === "step" && c.plan.format !== deviceRecordingFormat) {
            const location = stepLocation(c.plan,path);
            const step = location?.list?.[location.index];
            if (!targetCommands.has(step?.command) || !step.input?.target) return;
            const selector = this.target(c,area,target,step.input.target);
            if (replaceText) {
                if (step.command !== "fill" || typeof step.input.text !== "string" || typeof text !== "string" || text.length > 4096) return;
                step.input.text = text;
            }
            step.input.target = selector;
            c.added = true;
        } else if (["start","goal"].includes(area) && c.plan.format !== deviceRecordingFormat) {
            const key = area === "start" ? "preconditions" : "goals";
            const checks = c.plan[key] || [];
            if (!Array.isArray(checks) || !Number.isInteger(index) || index < 0 || index > checks.length) return;
            const prior = checks[index];
            const previous = editableCheck(prior);
            if (prior && !previous) return;
            const selector = this.target(c,area,target,prior?.selector);
            let value;
            if (property === "text" && typeof expected === "string" && expected.length <= 4096) {
                const keepValue = previous?.protectedValue && target.target === "keep" && expected === "";
                value = keepValue ? prior.equals : expected;
            } else if (booleanProperties.includes(property) && ["true","false"].includes(expected)) {
                value = expected === "true";
            }
            if (value === undefined) throw new Error(this.words("Enter an expected value for this check.","请输入此检查的预期值。"));
            checks[index] = {...prior,selector,property,equals:value};
            c.plan[key] = checks;
            c.added = true;
        } else return;
        c.revision++;
        this.update();
        if (area === "name" && saveName && c.edit && !c.added && !c.reordered) {
            if (c.name === c.originalName) this.cancel(true);
            else await this.save({id,name:c.name});
        }
    }

    async moveStep({id, revision, uri, digest, from, to}) {
        const state = this.bench.state;
        const starting = !this.candidate;
        if (starting) {
            if (id || state.draft || !state.caseDefinitions || !digest || state.plan?.uri!==uri || state.planDigest!==digest) return;
            await this.open({});
            if (!this.candidate?.edit || sourceDigest(this.candidate.edit.original)!==digest) {
                this.cancel(true);
                throw new Error(this.words("The case changed. Reopen it before changing the step order.","用例已更新，请重新打开后再调整步骤顺序。"));
            }
        }
        const c = this.candidate;
        if (!c || c.uri || (!starting && (c.id!==id || c.revision!==revision))) return;
        const location = stepLocation(c.plan,from);
        if (!location || !moveListItem(location.list,location.index,to)) {
            if (starting) this.cancel(true);
            return;
        }
        c.reordered = true;
        c.revision++;
        this.update();
    }

    async addBoundary({id,source}) {
        const c = this.candidate;
        if (!c || c.id !== id || c.uri || !["start","goal"].includes(source) || c.plan.format === deviceRecordingFormat) return;
        const key = source === "start" ? "preconditions" : "goals";
        if (c.plan[key]?.length) return;
        const w = (en,zh)=>this.words(en,zh), win = this.vscode.window;
        const title = source === "start" ? w("Choose a starting condition","添加起始条件") : w("Choose an expected result","添加预期结果");
        const raw = await c.nodes?.(source) || [];
        const options = raw.filter(n=>n.selector && !(n.editable && n.selector.text)).map(n=>({
            label:(n.editable ? n.id || n.type : n.label || n.id || n.type) || "Control",
            description:n.id,selector:n.selector
        }));
        let selector;
        if (options.length) {
            const pick = await win.showQuickPick([...options,{label:w("Enter a control ID…","输入控件 ID…")}],{title,ignoreFocusOut:true});
            if (!pick) return;
            selector = pick.selector;
        }
        if (!selector) {
            const value = await win.showInputBox({title,prompt:w("Stable control ID","稳定的控件 ID"),ignoreFocusOut:true,
                validateInput:v=>v.trim()?undefined:w("Enter a control ID.","请输入控件 ID。")});
            if (!value?.trim()) return;
            selector = {...(c.bundle && {bundleName:c.bundle}),id:value.trim()};
        }
        const pick = await win.showQuickPick([
            {label:w("Control is visible","控件可见"),property:"visible",equals:true},
            {label:w("Control is hidden","控件不可见"),property:"visible",equals:false},
            {label:w("Control text equals…","控件文字等于…"),property:"text"},
        ], {title,ignoreFocusOut:true});
        if (!pick) return;
        const equals = pick.property === "text" ? await win.showInputBox({title,ignoreFocusOut:true,
            prompt:w("Enter the expected text","输入你要验证的预期文字")}) : pick.equals;
        if (equals === undefined || this.candidate !== c) return;
        c.plan[key] = [{selector,property:pick.property,equals}];
        c.added = true;
        c.revision++;
        this.update();
    }

    async save({id, name: formName}) {
        const c = this.candidate, b = this.bench, v = this.vscode;
        if (!c || c.id !== id) return;
        const w = (en,zh)=>this.words(en,zh);
        // If indexing or opening fails after the files were created, retry that step on the same directory.
        if (c.edit && !c.uri) {
            if (!c.added && !c.reordered && c.name === c.originalName) return;
            if (c.added || c.reordered) await this.updateDraft(c);
            c.uri = c.edit.uri;
            c.savedName = c.name;
        } else if (!c.uri) {
            const parent = await v.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,
                defaultUri:v.workspace.workspaceFolders?.[0]?.uri,openLabel:w("Create case here","在此创建用例目录")});
            if (!parent?.length) return;
            if (parent[0].scheme !== "file") throw new Error(w("Choose a local project directory.","请选择本机项目目录。"));
            const name = formName === c.name ? formName : await v.window.showInputBox({title:w("Test case name","测试用例名称"),
                value:suggestedName(c.name),ignoreFocusOut:true,
                validateInput:value=>safeCaseName(value) ? undefined : w("Use a short folder name.","请输入不超过 70 个字符的有效目录名。")});
            if (!name || this.candidate !== c) return;
            if (!safeCaseName(name)) throw new Error(w("Invalid case name.","用例名称无效。"));
            let folder;
            try {
                folder = readiness(c.plan) ? await writeReplay(parent[0].fsPath,name,c.plan,c.group) :
                    (await writeCase(parent[0].fsPath,name,c.plan,c.group)).folder;
            } catch (error) {
                if (error.code==="EEXIST") throw new Error(w("A case folder with this name already exists.","此名称的目录已存在，请换一个名称。"));
                throw error;
            }
            c.uri = v.Uri.file(path.join(folder,"workflow.json"));
            c.savedName = name;
        }
        this.update();
        if (c.edit && c.savedName !== c.originalName) await b.caseLibrary.rename(c.uri,c.savedName);
        await b.caseLibrary.add(c.uri,{name:c.savedName,source:c.source,origin:c.origin});
        await b.refreshCases();
        await b.setPlan(c.uri);
        if (c.recording && b.state.draft === c.recording) b.state.draft = undefined;
        this.cancel(true);
    }

    async updateDraft(c) {
        const v=this.vscode, {uri,original}=c.edit;
        const doc = await v.workspace.openTextDocument(uri);
        const conflict = ()=>new Error(this.words("The case file changed. Go back, save your edits, and review the latest version.",
            "用例文件有其他修改。请返回并保存编辑，再核对最新版本。"));
        const unchanged = async()=>!doc.isDirty && doc.getText()===original &&
            (await fs.readFile(uri.fsPath,"utf8")).replace(/^\uFEFF/,"")===original.replace(/^\uFEFF/,"");
        if (!await unchanged()) throw conflict();
        const next = JSON.stringify(c.group ? workflowWithScenario(c.plan,c.group) : c.plan,null,2) + "\n";
        const folder = path.dirname(uri.fsPath);
        let script, content;
        try {
            if (c.added && !readiness(c.plan) && !await findCase(uri)) {
                // Respect an edited/custom Python entry: adding another test here could run the same case twice.
                const pythonTests = (await fs.readdir(folder)).some(name=>/^test_.*\.py$/i.test(name));
                if (pythonTests) throw new Error(this.words("A custom Python test already exists. Open its source or save a separate case.",
                    "当前目录已有自定义 Python 测试，请先核对已有测试入口。"));
                const filename = path.join(folder,testFilename(c.name));
                content = (await fs.readFile(templatePath,"utf8")).replace("__REQUIRES_RULE_GROUP__",c.group?"True":"False");
                const handle=await fs.open(filename,"wx",0o600);
                script=filename;
                try { await handle.writeFile(content); } finally { await handle.close(); }
            }
            if (!await unchanged()) throw conflict();
            const edit = new v.WorkspaceEdit();
            edit.replace(uri,new v.Range(doc.positionAt(0),doc.positionAt(original.length)),next);
            if (!await v.workspace.applyEdit(edit) || !await doc.save()) throw conflict();
        } catch (error) {
            // Never remove another editor's changes if it adopted or modified the generated entry.
            if (script && await fs.readFile(script,"utf8").then(value=>value===content,()=>false)) await fs.unlink(script);
            throw error;
        }
    }
}

module.exports = {CaseAuthoring,caseDefinitions,canEditCase};
