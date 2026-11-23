"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {createBdd, readCaseMetadata} = require("./caseLibrary");
const {maxSteps, title, stepRoles, roleOverride, stepEntries, restorePresentation, storePresentation, stepEvidence, pageCue, entriesForOrganization,
    organizationPrompt, parseOrganization} = require("./casePresentation");
const {stepLocator, canonicalLocator, describeLocator, observationsForStep, manualLocator, targetCommands} = require("./caseLocators");
const {editableCommands, actionDefinition, buildAction, gestureDefinition, buildGesture} = require("./caseStepEditing");
const {deviceRecordingFormat, moveListItem} = require("./model");
const {sourceDigest} = require("./caseRepair");
const {readiness, safeCaseName, reserveCaseFolder, writeCase, findCase, templatePath, testFilename} = require("./pytestCase");
const {readWorkflow, workflowWithScenario} = require("./workflowFile");

const booleanProperties = ["visible", "enabled", "checked", "selected", "focused"];
const sensitiveControl = /pass(?:word|code)|secret|token|密码|口令|验证码/i;

function editableCheck(check) {
    const property = check?.property || "text";
    const expected = check?.equals;
    if (!check?.selector || !(property === "text" ? typeof expected === "string" :
        booleanProperties.includes(property) && typeof expected === "boolean")) return;
    const protectedValue = property === "text" && sensitiveControl.test(JSON.stringify(check.selector));
    return {property, expected:protectedValue ? "" : String(expected), protectedValue};
}

function stepLocation(plan, path) {
    const parts = /^(steps\[\d+\])(?:(?:\.then|\.else|\.repeat\.steps)\[\d+\])*$/u;
    if (typeof path !== "string" || path.length > 200 || !parts.test(path)) return;
    const keys = path.split(/[.\[\]]+/).filter(Boolean);
    const index = Number(keys.pop());
    const list = keys.reduce((item,key)=>item?.[key],plan);
    return {list,index};
}

function caseDefinitions(plan, presentation) {
    const conditions = key => Array.isArray(plan[key]) ? plan[key].map(editableCheck) : [];
    const entries = [...stepEntries(plan.steps)];
    const controls = plan.format !== deviceRecordingFormat;
    const steps = Object.fromEntries(entries.map(({path,step,siblings})=>{
        const locator = stepLocator(step);
        const roles = controls ? stepRoles(step) : [];
        const {name,group,role} = presentation?.get(step) || {};
        const check = editableCheck(step.assert);
        const action = controls ? actionDefinition(step) : undefined;
        const gesture = controls ? undefined : gestureDefinition(step);
        return [path,{name,group,roles,role:role || roles[0],removable:siblings>1 || /\.else\[\d+\]$/.test(path),
            insertCheck:controls && entries.length<maxSteps && !step.stop && !step.yield,
            ...(locator && {locator:describeLocator(locator.owner[locator.field])}), ...(check && {check}),action,gesture}];
    }));
    return {start:conditions("preconditions"),goal:conditions("goals"),steps,commands:controls ? editableCommands() : []};
}

function setStepPresentation(candidate, step, display) {
    if (display.name || display.group || display.role || display.evidence) candidate.presentation.set(step,display);
    else candidate.presentation.delete(step);
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
    const contents = group ? workflowWithScenario(plan,group) : plan;
    const json = JSON.stringify(contents,null,2) + "\n";
    const folder = await reserveCaseFolder(parent,name);
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
            this.begin({source, origin:{outcome:"observed"}, plan, name, purpose:draft.goal,
                stepEvidence:Object.fromEntries(draft.steps.map((step,i)=>[`steps[${i}]`,{...step.evidence,control:step.label}])),
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
        const metadata = await readCaseMetadata(uri);
        const existing = bench.state.activeCase?.uri === selected.uri ? bench.state.activeCase : undefined;
        const portable = await canEditCase(uri,existing);
        const copy = message.copy === true;
        const name = copy ? selected.name.slice(0,60).trim()+this.words(" copy"," 副本") : selected.name;
        this.begin({source:existing?.source==="imported" ? "workflow" : existing?.source || "workflow",
            origin:existing?.origin,name,plan,group:scenario || bench.networks.bindings?.[selected.uri],presentationData:metadata?.presentation,
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
        if (entry.plan.uri) candidate.presentationData = (await readCaseMetadata(this.vscode.Uri.parse(entry.plan.uri)))?.presentation;
        this.begin(candidate);
    }

    begin(candidate) {
        if (!candidate.plan?.steps?.length || !Array.isArray(candidate.plan.steps) || readiness(candidate.plan)==="invalid")
            throw new Error(this.words("No executable steps are available.", "还没有可执行的步骤。"));
        const state = this.bench.state;
        const plan = structuredClone(candidate.plan);
        const presentation = restorePresentation(plan,candidate.presentationData);
        for (const {path,step} of stepEntries(plan.steps)) {
            const evidence = stepEvidence(candidate.stepEvidence?.[path]);
            if (evidence) presentation.set(step,{...presentation.get(step),evidence});
        }
        this.candidate = {...candidate,plan,presentation,
            group:candidate.group && structuredClone(candidate.group),
            id:randomUUID(), revision:0, targets:{}, originalName:candidate.name, name:candidate.edit ? candidate.name : suggestedName(candidate.name),
            previousTool:state.tool};
        state.tool = "recordings";
        this.update();
    }

    update() {
        const c = this.candidate, plan = c.plan;
        const targets = Object.fromEntries(Object.entries(c.targets).map(([key, values])=>[key,
            values.map(({label},index)=>({label,key:String(index)}))]));
        const picker = c.stepTargets;
        const stepTargets = picker && (!picker.device || picker.device === this.bench.state.device) ? {
            path:picker.path,area:picker.area,command:picker.command,insert:picker.insert,matches:picker.matches,
            live:Boolean(picker.device),picture:picker.picture,
            choices:picker.choices.map(({label,source,detail,selector,bounds},index)=>({label,source,detail,key:String(index),
                locator:describeLocator(selector),...(picker.picture && bounds && {bounds})})),
        } : undefined;
        this.bench.state.caseReview = {id:c.id,revision:c.revision,name:c.name,source:c.source,origin:c.origin,groupName:c.group?.name,
            issue:readiness(plan),bdd:createBdd(plan,this.bench.language,c.group,c.presentation),added:c.added,timingUnknown:c.timingUnknown,edit:Boolean(c.edit),
            dirty:Boolean(c.added || c.reordered || c.presentationChanged || c.name !== c.originalName || c.uri), pendingSave:Boolean(c.uri),
            definitions:caseDefinitions(plan,c.presentation),targets,stepTargets,organization:c.organization,
            undoRemove:Boolean(c.removedStep)};
    }

    cancel(stay = false) {
        const c = this.candidate;
        c?.organizationJob?.abort();
        this.candidate = undefined;
        this.bench.state.caseReview = undefined;
        if (!stay && c?.previousTool && this.bench.state.tool === "recordings") this.bench.state.tool = c.previousTool;
    }

    async loadTargets({id, revision, area, path, live, add, pick, command}) {
        const c = this.candidate;
        if (!c || c.id !== id || c.uri || (revision !== undefined && c.revision !== revision)) return;
        if (["step","stepCheck","stepOperation"].includes(area)) {
            if (c.revision===revision) await this.loadStepTargets(c,path,{area,live:live===true,
                insert:area!=="step" && add===true,pick:pick===true,command:area==="stepOperation" ? command : undefined});
            return;
        }
        if (!["start","goal"].includes(area) || c.targets[area]) return;
        const captured = await c.nodes?.(area) || [];
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

    async loadStepTargets(c, path, {area,live,insert,pick,command}) {
        const location = stepLocation(c.plan,path);
        const step = location?.list?.[location.index];
        const anchor = stepLocator(step);
        if (!step || (insert && c.plan.format===deviceRecordingFormat)) return;
        let locator = insert ? undefined : anchor;
        if (area==="stepOperation") {
            if (!targetCommands.has(command) || !editableCommands(insert ? undefined : step).includes(command) ||
                (!insert && !actionDefinition(step))) return;
            const target = !insert && command===step.command ? step.input?.target : undefined;
            locator = stepLocator({command,input:{target:target || {}}});
        } else if (!locator && !insert) return;
        const bench = this.bench;
        const revision = c.revision;
        const panel = bench.panel;
        const current = () => this.candidate === c && c.revision === revision && bench.panel===panel;
        const sources = [];
        let device, picture, page;
        if (live) {
            device = bench.state.device;
            if (!device || !bench.state.devices.includes(device)) throw new Error(bench.text.selectDevice);
            const onDevice = () => current() && bench.state.device === device && bench.state.devices.includes(device);
            const read = async()=>{
                await bench.observe(onDevice,true);
                if (!onDevice()) return;
                page = bench.state.page;
                if (!page || !pick) return;
                const capture = await bench.agent.call("screenshot",{session:bench.session});
                if (!onDevice()) return;
                const src = bench.image(capture.path);
                if (!src) throw new Error(this.words("The page image could not be displayed.","无法显示当前页面的截图。"));
                picture = {id:randomUUID(),src,device};
            };
            if (bench.livePanel) await bench.livePanel.withDeviceOperation(read);
            else await read();
            if (!current() || bench.state.device !== device) return;
            if (page) sources.push({nodes:page.nodes, source:"live", complete:page.complete && !page.truncated});
        }
        if (c.nodes) {
            c.recordedNodes ??= Promise.all([c.nodes("start"),c.nodes("goal")]);
            for (const nodes of await c.recordedNodes) if (nodes?.length) sources.push({nodes,source:"recorded"});
        }
        if (!current() || (device && (bench.state.device !== device || !bench.state.devices.includes(device)))) return;
        const bundle = canonicalLocator(anchor?.owner[anchor.field])?.bundleName || c.bundle;
        c.stepTargets = {path,area,command,insert,device,picture,pageCue:pageCue(page),...observationsForStep(locator,sources,bundle)};
        this.update();
    }

    endPick(message) {
        const c = this.candidate, picture = c?.stepTargets?.picture;
        if (!picture || (message && (c.id!==message.id || c.revision!==message.revision || picture.id!==message.picture))) return false;
        c.stepTargets.picture = undefined;
        this.update();
        return true;
    }

    invalidateLiveTargets() {
        if (!this.candidate?.stepTargets?.device) return;
        this.candidate.stepTargets = undefined;
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

    stepTarget(c, path, message, current, {area="step",command,insert=false,scope}={}) {
        const picker = c.stepTargets;
        const state = this.bench.state;
        const selected = picker?.path===path && picker.area===area && picker.command===command && picker.insert===insert &&
            (!picker.device || (picker.device===state.device && state.devices.includes(picker.device))) &&
            /^\d+$/.test(message.target || "") && picker.choices[Number(message.target)];
        const selector = message.target === "keep" ? current :
            message.target === "manual" ? manualLocator(message.locatorField,message.controlId,scope) : selected?.selector;
        if (!selector) throw new Error(this.words("Choose a control from the page, or enter an exact locator.","请选中页面上的控件，或输入准确的定位条件。"));
        return {selector:structuredClone(selector),evidence:stepEvidence({control:selected?.label,from:selected?.source==="live" ? picker.pageCue : undefined})};
    }

    expectedValue(property, expected, prior, keepProtected) {
        if (property === "text" && typeof expected === "string" && expected.length <= 4096)
            return keepProtected && expected === "" ? prior.equals : expected;
        if (booleanProperties.includes(property) && ["true","false"].includes(expected)) return expected === "true";
        throw new Error(this.words("Enter an expected value for this check.","请输入此检查的预期值。"));
    }

    editStepCheck(c, location, step, path, {add, property, expected, role, ...target}) {
        const insert = add === true;
        const prior = insert ? undefined : step.assert;
        const check = editableCheck(prior);
        if (c.plan.format === deviceRecordingFormat || (!insert && !check) ||
            (insert && (step.stop || step.yield || [...stepEntries(c.plan.steps)].length>=maxSteps))) return false;
        if (!["Given","Then"].includes(role)) return false;
        const anchor = stepLocator(step);
        const scope = canonicalLocator(anchor?.owner[anchor.field])?.bundleName || c.bundle;
        const chosen = this.stepTarget(c,path,target,prior?.selector,{area:"stepCheck",insert,scope});
        const equals = this.expectedValue(property,expected,prior,check?.protectedValue && target.target==="keep");
        const assertion = {...prior,selector:chosen.selector,property,equals};
        const edited = insert ? {assert:assertion} : step;
        if (insert) {
            location.list.splice(location.index+1,0,edited);
            c.removedStep = undefined;
        } else edited.assert = assertion;
        const display = c.presentation.get(step);
        const name = insert ? "" : display?.name || "";
        const group = display?.group || "";
        const override = roleOverride(stepRoles(edited),role);
        const previousEvidence = insert ? undefined : display?.evidence;
        const evidence = target.target==="keep" ? previousEvidence : chosen.evidence;
        setStepPresentation(c,edited,{name,group,role:override,evidence});
        c.presentationChanged ||= override !== (insert ? undefined : display?.role) || !isDeepStrictEqual(evidence,previousEvidence);
        c.stepTargets = undefined;
        c.added = true;
        return true;
    }

    editStepOperation(c,location,step,path,fields) {
        const {command,add,target} = fields;
        const prior = add ? undefined : step;
        if (c.plan.format===deviceRecordingFormat || !editableCommands(prior).includes(command) ||
            (!add && !actionDefinition(step)) ||
            (add && (step.stop || step.yield || [...stepEntries(c.plan.steps)].length>=maxSteps))) return false;
        const current = prior?.command===command ? prior.input?.target : undefined;
        const anchor = stepLocator(step);
        const scope = canonicalLocator(anchor?.owner[anchor.field])?.bundleName || c.bundle;
        const chosen = targetCommands.has(command) && !(command==="scroll" && target==="auto") ?
            this.stepTarget(c,path,fields,current,{area:"stepOperation",command,insert:add===true,scope}) : undefined;
        const edited = buildAction(prior,fields,chosen?.selector,(en,zh)=>this.words(en,zh));
        if (add) {
            location.list.splice(location.index+1,0,edited);
            setStepPresentation(c,edited,{evidence:chosen?.evidence});
            c.removedStep = undefined;
            c.added = true;
        } else this.replaceOperation(c,location,step,edited,target==="keep" ? undefined : chosen?.evidence);
        c.stepTargets = undefined;
        return true;
    }

    replaceOperation(c,location,step,edited,selectedEvidence) {
        if (isDeepStrictEqual(step,edited)) return;
        const display = c.presentation.get(step);
        const sameTarget = step.command===edited.command && isDeepStrictEqual(step.input?.target,edited.input?.target);
        const evidence = selectedEvidence || (sameTarget && stepEvidence({control:display?.evidence?.control,from:display?.evidence?.from}));
        const role = roleOverride(stepRoles(edited),display?.role);
        c.presentation.delete(step);
        setStepPresentation(c,edited,{...display,role,evidence});
        c.presentationChanged ||= Boolean(display?.evidence && !isDeepStrictEqual(evidence,display.evidence));
        location.list[location.index] = edited;
        c.removedStep = undefined;
        c.added = true;
    }

    async edit({id, revision, area, path, index, property, expected, name, role, add, text, saveName, ...target}) {
        const c = this.candidate;
        if (!c || c.id !== id || c.revision !== revision || c.uri) return;
        if (area === "name") {
            const value = typeof name === "string" ? name.trim() : "";
            if (!safeCaseName(value)) throw new Error(this.words("Enter a valid case name of up to 70 characters.","请输入不超过 70 个字符的有效用例名称。"));
            c.name = value;
        } else if (["step","stepName","stepCheck","stepOperation","stepGesture"].includes(area)) {
            const location = stepLocation(c.plan,path);
            const step = location?.list?.[location.index];
            if (!step) return;
            if (area === "stepName") {
                const label = title(name), group = title(target.group);
                if ((name && !label) || (target.group && !group)) throw new Error(this.words("Enter a short title on one line.","请输入简短的单行标题。"));
                const previous = c.presentation.get(step);
                const roles = c.plan.format===deviceRecordingFormat ? [] : stepRoles(step);
                if (role && !roles.includes(role)) return;
                const override = role ? roleOverride(roles,role) : previous?.role;
                setStepPresentation(c,step,{name:label,group,role:override,evidence:previous?.evidence});
                c.presentationChanged ||= label !== (previous?.name || "") || group !== (previous?.group || "") || override !== previous?.role;
            } else if (area === "stepCheck") {
                if (!this.editStepCheck(c,location,step,path,{add,property,expected,role,...target})) return;
            } else if (area==="stepOperation") {
                if (!this.editStepOperation(c,location,step,path,{...target,add,property,expected,text})) return;
            } else if (area==="stepGesture") {
                if (c.plan.format!==deviceRecordingFormat) return;
                const edited = buildGesture(step,{...target,text},(en,zh)=>this.words(en,zh));
                if (!edited) return;
                this.replaceOperation(c,location,step,edited);
            } else {
                const locator = stepLocator(step);
                if (!locator) return;
                const scope = canonicalLocator(locator.owner[locator.field])?.bundleName || c.bundle;
                const {selector,evidence} = this.stepTarget(c,path,target,undefined,{scope});
                locator.owner[locator.field] = selector;
                const previous = c.presentation.get(step);
                setStepPresentation(c,step,{...previous,evidence});
                c.presentationChanged ||= !isDeepStrictEqual(evidence,previous?.evidence);
                c.stepTargets = undefined;
                c.added = true;
            }
        } else if (["start","goal"].includes(area) && c.plan.format !== deviceRecordingFormat) {
            const key = area === "start" ? "preconditions" : "goals";
            const checks = c.plan[key] || [];
            if (!Array.isArray(checks) || !Number.isInteger(index) || index < 0 || index > checks.length) return;
            const prior = checks[index];
            const previous = editableCheck(prior);
            if (prior && !previous) return;
            const selector = this.target(c,area,target,prior?.selector);
            const equals = this.expectedValue(property,expected,prior,previous?.protectedValue && target.target==="keep");
            checks[index] = {...prior,selector,property,equals};
            c.plan[key] = checks;
            c.added = true;
        } else return;
        c.revision++;
        this.update();
        if (area === "name" && saveName && c.edit && !c.added && !c.reordered && !c.presentationChanged) {
            if (c.name === c.originalName) this.cancel(true);
            else await this.save({id,name:c.name});
        }
    }

    async moveStep({id, revision, uri, digest, from, to}) {
        const starting = !this.candidate;
        const c = await this.stepDraft({id,revision,uri,digest});
        if (!c) return;
        const location = stepLocation(c.plan,from);
        if (!location || !moveListItem(location.list,location.index,to)) {
            if (starting) this.cancel(true);
            return;
        }
        c.removedStep = undefined;
        c.stepTargets = undefined;
        c.reordered = true;
        c.revision++;
        this.update();
    }

    async stepDraft({id,revision,uri,digest}) {
        const state = this.bench.state;
        const starting = !this.candidate;
        if (starting) {
            if (id || state.draft || !state.caseDefinitions || !digest || state.plan?.uri!==uri || state.planDigest!==digest) return;
            await this.open({});
            if (!this.candidate?.edit || sourceDigest(this.candidate.edit.original)!==digest) {
                this.cancel(true);
                throw new Error(this.words("The case changed. Reopen it before editing steps.","用例已更新，请重新打开后再编辑步骤。"));
            }
        }
        const c = this.candidate;
        if (c && !c.uri && (starting || c.id===id && c.revision===revision)) return c;
    }

    async changeStep(message) {
        const {action,path} = message;
        if (!["undoRemove","duplicate","remove"].includes(action)) return;
        const c = await this.stepDraft(message);
        if (!c) return;
        if (action === "undoRemove") {
            if (!c.removedStep) return;
            const {list,index,step} = c.removedStep;
            list.splice(index,0,step);
            c.removedStep = undefined;
        } else {
            const location = stepLocation(c.plan,path);
            const step = location?.list?.[location.index];
            if (!step) return;
            const {list,index} = location;
            if (action === "remove") {
                if (list.length === 1 && !/\.else\[\d+\]$/.test(path)) return;
                list.splice(index,1);
                c.removedStep = {list,index,step};
            } else {
                if (c.plan.format !== deviceRecordingFormat &&
                    [...stepEntries(c.plan.steps)].length + [...stepEntries([step])].length > maxSteps)
                    throw new Error(this.words("The workflow has reached its step limit.","已达到流程的步骤上限。"));
                const copy = structuredClone(step);
                list.splice(index+1,0,copy);
                const originals = [...stepEntries([step])], copies = [...stepEntries([copy])];
                originals.forEach(({step:original},i)=>{
                    const {name,group,role} = c.presentation.get(original) || {};
                    setStepPresentation(c,copies[i].step,{name,group,role});
                });
                c.removedStep = undefined;
            }
        }
        c.stepTargets = undefined;
        c.reordered = true;
        c.revision++;
        this.update();
    }

    async organize({id,revision}) {
        const c = this.candidate, b = this.bench;
        if (!c || c.id !== id || c.revision !== revision || c.organizationJob || c.uri || b.state.busy) return;
        const steps = [...stepEntries(c.plan.steps)];
        if (!steps.length || steps.length > maxSteps) {
            c.organization = {error:this.words("AI can organize up to 200 steps at a time.","AI 一次可以整理最多 200 个步骤。")};
            this.update();
            b.publish();
            return;
        }
        const job = c.organizationJob = new AbortController();
        const signal = AbortSignal.any([job.signal,AbortSignal.timeout(90_000)]);
        c.organization = {working:true};
        this.update();
        b.publish();
        try {
            const rows = entriesForOrganization(c.plan,c.presentation);
            const ask = await b.modelAsk(signal);
            const answer = await ask(organizationPrompt(c.plan,rows,b.language,
                {name:c.name,goal:c.purpose || c.origin?.label,source:c.source,outcome:c.origin?.outcome}),signal);
            signal.throwIfAborted();
            if (this.candidate !== c || c.organizationJob !== job) return;
            if (c.revision !== revision || c.uri) {
                c.organization = {error:this.words("Steps changed during organization. Run it again to use the latest version.",
                    "整理期间步骤有变动，可重新整理最新版本。")};
                return;
            }
            const proposed = parseOrganization(answer,rows);
            c.presentation = new Map(steps.map(({step},i)=>[step,{...proposed[i],evidence:c.presentation.get(step)?.evidence}]));
            c.presentationChanged = true;
            c.organization = {ready:true};
            c.revision++;
        } catch (error) {
            if (!job.signal.aborted) c.organization = {error:error.code && b.text[error.code] || this.words(
                "AI could not organize the steps. Check the provider or try again.","AI 整理未完成，可检查 AI 提供方或重试。")};
        } finally {
            if (this.candidate === c && c.organizationJob === job) {
                c.organizationJob = undefined;
                this.update();
                b.publish();
            }
        }
    }

    stopOrganizing(id) {
        const c = this.candidate;
        if (!c?.organizationJob || (id && c.id !== id)) return;
        c.organizationJob.abort();
        c.organizationJob = c.organization = undefined;
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
        this.stopOrganizing(id);
        const w = (en,zh)=>this.words(en,zh);
        const presentation = storePresentation(c.plan,c.presentation);
        // If indexing or opening fails after the files were created, retry that step on the same directory.
        if (c.edit && !c.uri) {
            if (!c.added && !c.reordered && !c.presentationChanged && c.name === c.originalName) return;
            if ((c.presentationChanged || c.presentationData && (c.added || c.reordered)) &&
                !isDeepStrictEqual((await readCaseMetadata(c.edit.uri))?.presentation,c.presentationData))
                throw new Error(w("The case step titles changed on disk. Reopen the case before saving.","磁盘上的步骤名称有改动，请重新打开用例后再保存。"));
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
            const folder = readiness(c.plan) ? await writeReplay(parent[0].fsPath,name,c.plan,c.group) :
                (await writeCase(parent[0].fsPath,name,c.plan,c.group)).folder;
            c.uri = v.Uri.file(path.join(folder,"workflow.json"));
            c.savedName = name;
        }
        this.update();
        if (c.edit && !c.savedMetadata) {
            const changes = {...(c.savedName !== c.originalName && {name:c.savedName}),
                ...((c.presentationChanged || c.presentationData && (c.added || c.reordered)) && {presentation})};
            if (Object.keys(changes).length) await b.caseLibrary.updateMetadata(c.uri,changes,c.presentationData);
            c.savedMetadata = true;
        }
        await b.caseLibrary.add(c.uri,{name:c.savedName,source:c.source,origin:c.origin,presentation});
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
