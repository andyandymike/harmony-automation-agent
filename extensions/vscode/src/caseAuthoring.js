"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {createBdd, readCaseMetadata} = require("./caseLibrary");
const {caseExplorationCheckpoints} = require("./caseExplorationMenu");
const {maxSteps, title, stepRoles, roleOverride, bddRoles, stepEntries, restorePresentation, storePresentation, stepEvidence, pageCue, entriesForOrganization,
    organizationPrompt, parseOrganization, caseDescription, descriptionText, pendingCaseWork, rewritePlanExpressions} = require("./casePresentation");
const {stepLocator, canonicalLocator, describeLocator, observationsForStep, manualLocator, targetCommands} = require("./caseLocators");
const {editableCommands, actionDefinition, buildAction, gestureDefinition, gestureOptions, buildGesture} = require("./caseStepEditing");
const {deviceRecordingFormat, moveListItem} = require("./model");
const {sourceDigest} = require("./caseRepair");
const {reviewCaseFailure} = require("./caseFailure");
const {readiness, safeCaseName, reserveCaseFolder, writeCase, findCase, templatePath, testFilename} = require("./pytestCase");
const {readWorkflow, workflowForSave} = require("./workflowFile");
const {rulePlanForRun} = require("./caseRuleSteps");
const {authoredDocument, compileCase, compositionRecord, signature, bindingNames, stepLocation, selectedStepLocations, sectionSelection, sectionRangePaths,
    insertionAnchor, asAssertionStep, stageInsertion, rememberInsertion} = require("./caseComposition");

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

function caseDefinitions(plan, presentation) {
    const details = (step,defaultRole) => {
        const {name,group,role,description} = presentation?.get(step) || {};
        return {name,group,role:role || defaultRole,defaultRole,roles:bddRoles,descriptionText:caseDescription(step)?.text || description};
    };
    const conditions = (key,role) => Array.isArray(plan[key]) ? plan[key].map(check=>({...editableCheck(check),...details(check,role),
        ...(check?.selector && {locator:describeLocator(check.selector)}),removable:true})) : [];
    const entries = [...stepEntries(plan.steps)];
    const steps = Object.fromEntries(entries.map(({path,step,siblings})=>{
        const locator = stepLocator(step);
        const check = editableCheck(step.assert);
        const action = actionDefinition(step);
        const gesture = gestureDefinition(step);
        return [path,{...details(step,stepRoles(step)[0]),reference:Boolean(step.useCase),
            description:Boolean(caseDescription(step)),ruleGroup:step.ruleGroup?.action,
            ...(descriptionText(step.editNote) && {editNote:step.editNote}),
            removable:siblings>1 || /\.else\[\d+\]$/.test(path),
            ...(locator && {locator:describeLocator(locator.owner[locator.field])}), ...(check && {check}),action,gesture}];
    }));
    return {start:conditions("preconditions","Given"),goal:conditions("goals","Then"),steps,commands:editableCommands(),gestures:gestureOptions()};
}

function setStepPresentation(candidate, step, display) {
    if (display.name || display.group || display.role || display.description || display.evidence) candidate.presentation.set(step,display);
    else candidate.presentation.delete(step);
}

function missingCopyReads(compiled) {
    if (compiled.plan.version!=="2" || compiled.pending?.length) return;
    const declared=bindingNames(compiled.plan), missing=new Set();
    rewritePlanExpressions(compiled.plan,value=>{
        if (typeof value?.var==="string" && Object.keys(value).length===1 && !declared.has(value.var)) missing.add(value.var);
        return value;
    });
    if (missing.size) return [...missing];
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
    const contents = workflowForSave(plan,group);
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

    create() {
        if (this.candidate || this.bench.state.draft) return;
        const name = this.words("New test case","新建用例");
        this.begin({source:"workflow",name,plan:{version:"1",steps:[]},emptyCase:true});
    }

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
        const {original,uri,candidate} = await this.readSelectedCase(selected);
        const portable = await canEditCase(uri,bench.state.activeCase?.uri === selected.uri ? bench.state.activeCase : undefined);
        if (message.copy === true) candidate.name = selected.name.slice(0,60).trim()+this.words(" copy"," 副本");
        else if (portable) candidate.edit={uri,original};
        this.begin(candidate);
    }

    async readSelectedCase(selected) {
        const bench=this.bench, uri=this.vscode.Uri.parse(selected.uri);
        const doc = await this.vscode.workspace.openTextDocument(uri);
        const original = doc.getText();
        const file = readWorkflow(original);
        const {scenario} = file;
        const metadata = await readCaseMetadata(uri);
        const authored = authoredDocument(file,metadata);
        const existing = bench.state.activeCase?.uri === selected.uri ? bench.state.activeCase : undefined;
        return {original,uri,doc,candidate:{source:existing?.source==="imported" ? "workflow" : existing?.source || "workflow",
            origin:existing?.origin,name:selected.name,plan:authored.plan,group:scenario || bench.networks.bindings?.[selected.uri],
            presentationData:authored.display,metadataPresentation:metadata?.presentation,compositionData:metadata?.composition,
            compositionStale:authored.stale,section:metadata?.section}};
    }

    async forkSource({id,revision,uri,digest}) {
        const state=this.bench.state, c=this.candidate;
        if (c) {
            if (c.id!==id || c.revision!==revision || c.uri) return;
            const existing=c.edit && state.cases?.find(item=>item.uri===c.edit.uri.toString());
            return {candidate:c,returnDraft:c,parentCaseId:existing?.portableId,
                parentCaseDigest:c.edit && !state.caseReview?.dirty ? sourceDigest(c.edit.original) : undefined};
        }
        if (id || state.draft || !uri || state.plan?.uri!==uri || !digest || state.planDigest!==digest) return;
        const {candidate,original,doc}=await this.readSelectedCase(state.plan);
        if (this.candidate || state.draft || state.plan?.uri!==uri || state.planDigest!==digest || doc.getText()!==original || sourceDigest(original)!==digest)
            throw new Error(this.words("The case changed. Choose the steps again.","用例已更新，请重新选择要复制的步骤。"));
        candidate.presentation=restorePresentation(candidate.plan,candidate.presentationData);
        return {candidate,parentCaseId:state.activeCase?.uri===uri ? state.activeCase.portableId : undefined,parentCaseDigest:digest};
    }

    async fromRun(run) {
        const b = this.bench, entry = run.entry;
        if (!entry || !/^[a-zA-Z0-9_-]+$/.test(entry.id) || !run.steps?.length)
            throw new Error(this.words("This report has no recorded workflow steps.","本次运行尚无可用的操作步骤。"));
        const candidate = {name:entry.plan.name,source:"workflow",origin:{reportId:entry.id,
            outcome:run.goalStatus==="failed" ? "checkFailed" : run.goalStatus==="passed" ? "checksPassed" : "observed"}};
        if (entry.source === "device") {
            const steps = [];
            const saved = b.stateDir && await rulePlanForRun(b.stateDir,entry.id);
            for (const row of run.steps) {
                if (row.status!=="completed" || row.dispatched!=="acknowledged") break;
                const original = saved?.steps[steps.length];
                if (original?.ruleGroup) steps.push(original);
                else if (row.gesture) steps.push({command:"deviceGesture",input:row.gesture,label:row.label,...(row.delayMs && {delayMs:row.delayMs})});
                else break;
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
            try { candidate.plan = await rulePlanForRun(b.stateDir,entry.id) || JSON.parse(await fs.readFile(target,"utf8")); }
            catch (error) {
                if (error.code!=="ENOENT") throw error;
                throw new Error(this.words("The workflow snapshot for this run is unavailable.","这次回放使用的流程版本已不可用。"));
            }
        }
        if (entry.source!=="pytest") candidate.group = await b.networks.scenarioForRun?.(entry.id);
        if (entry.plan.uri) candidate.presentationData = (await readCaseMetadata(this.vscode.Uri.parse(entry.plan.uri)))?.presentation;
        this.begin(candidate);
    }

    async beginRepair({doc,group,metadata,plan,source,entry,presentation,onSave}) {
        if (this.candidate || this.bench.state.draft) return;
        const uri = doc.uri;
        const existing = this.bench.state.cases.find(item=>item.uri===uri.toString());
        const edit = await canEditCase(uri,existing) ? {uri,original:source} : undefined;
        this.begin({plan,group,edit,added:true,presentationData:metadata?.presentation,compositionData:metadata?.composition,onSave,
            name:existing?.name || entry.plan.name,
            source:existing?.source && existing.source!=="imported" ? existing.source : "workflow",
            origin:edit ? existing.origin : {reportId:entry.id,outcome:"observed"}},presentation ?? null);
    }

    begin(candidate, display = candidate.presentationData) {
        if (!Array.isArray(candidate.plan?.steps) || !candidate.emptyCase &&
            (!candidate.plan.steps.length && !descriptionText(candidate.plan.editNote) || readiness(candidate.plan)==="invalid"))
            throw new Error(this.words("No executable steps are available.", "还没有可执行的步骤。"));
        const state = this.bench.state;
        const plan = structuredClone(candidate.plan);
        const presentation = restorePresentation(plan,display);
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
        const compiled = compileCase(plan);
        const targets = Object.fromEntries(Object.entries(c.targets).map(([key, values])=>[key,
            values.map(({label},index)=>({label,key:String(index)}))]));
        const picker = c.stepTargets;
        const stepTargets = picker && (!picker.device || picker.device === this.bench.state.device) ? {
            path:picker.path,area:picker.area,command:picker.command,insert:picker.insert,matches:picker.matches,
            live:Boolean(picker.device),picture:picker.picture,
            choices:picker.choices.map(({label,source,detail,selector,bounds},index)=>({label,source,detail,key:String(index),
                locator:describeLocator(selector),...(picker.picture && bounds && {bounds})})),
        } : undefined;
        const insertion = c.insertionUndo?.revision===c.revision ? c.insertionUndo : undefined;
        const dirty=Boolean(c.added || c.reordered || c.presentationChanged || c.groupChanged || c.name !== c.originalName || c.uri);
        const bdd=createBdd(plan,this.bench.language,c.group,c.presentation,{...compiled,sources:this.bench.composition?.sources});
        caseExplorationCheckpoints(compiled,{...compiled,plan},this.bench.language,{bdd,review:c.edit && !dirty ? "clean" : "draft"});
        this.bench.state.caseReview = {id:c.id,revision:c.revision,name:c.name,source:c.source,origin:c.origin,
            issue:readiness(compiled.plan),bdd,added:c.added,timingUnknown:c.timingUnknown,edit:Boolean(c.edit),
            missingReads:c.source==="workflow" && c.origin?.parentCaseName ? missingCopyReads(compiled) : undefined,
            empty:!plan.steps.length,coordinates:plan.format===deviceRecordingFormat,pending:compiled.pending,
            ...(c.revisionFocus && {revisionFocus:c.revisionFocus}),
            compositionStale:c.compositionStale,
            dirty, pendingSave:Boolean(c.uri),
            definitions:caseDefinitions(plan,c.presentation),targets,stepTargets,organization:c.organization,
            insertionUndo:insertion?.path,insertionNotice:insertion?.notice,
            undoRemove:Boolean(c.removedStep)};
    }

    cancel(stay = false) {
        const c = this.candidate;
        c?.organizationJob?.abort();
        this.candidate = undefined;
        this.bench.state.caseReview = undefined;
        this.bench.composition?.closeDraft(c?.id);
        if (c?.returnDraft) {
            this.candidate = c.returnDraft;
            this.bench.state.tool = "recordings";
            this.update();
            return;
        }
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
        const step = insert || area==="stepCheck" ? insertionAnchor(c.plan,path) : location?.list?.[location.index];
        const anchor = stepLocator(step);
        if (!step) return;
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

    insertStep(c, anchor, step, display, positionedCheck=false) {
        const additions = new Map();
        if (display) setStepPresentation({presentation:additions},step,display);
        const staged = stageInsertion(c,anchor,[step],{display:additions,positionedCheck},(en,zh)=>this.words(en,zh));
        rememberInsertion(c,anchor,staged,Boolean(c.edit && !this.bench.state.caseReview?.dirty));
        c.presentationChanged ||= !isDeepStrictEqual(storePresentation(c.plan,c.presentation),storePresentation(staged.plan,staged.presentation));
        Object.assign(c,{plan:staged.plan,presentation:staged.presentation,added:true,compositionStale:false,
            stepTargets:undefined,removedStep:undefined});
        return true;
    }

    editStepCheck(c, step, path, {add, side, property, expected, role, name, positionedCheck, ...target},boundary=false) {
        const insert = add === true;
        const prior = insert ? undefined : step.assert;
        const check = editableCheck(prior);
        if (!insert && !check) return false;
        if (!["Given","Then"].includes(role)) return false;
        const anchor = stepLocator(step);
        const scope = canonicalLocator(anchor?.owner[anchor.field])?.bundleName || c.bundle;
        const chosen = this.stepTarget(c,path,target,prior?.selector,{area:"stepCheck",insert,scope});
        const equals = this.expectedValue(property,expected,prior,check?.protectedValue && target.target==="keep");
        const assertion = {...prior,selector:chosen.selector,property,equals};
        const owner = boundary ? prior : step;
        const display = c.presentation.get(owner);
        const group = display?.group || "";
        const override = roleOverride(stepRoles({assert:assertion}),role);
        const previousEvidence = insert ? undefined : display?.evidence;
        const evidence = target.target==="keep" ? previousEvidence : chosen.evidence;
        if (insert) return this.insertStep(c,{path,side:side || "after"},{assert:assertion},
            {name,group,role:positionedCheck ? role : override,evidence},positionedCheck===true);
        if (boundary) Object.assign(prior,assertion);
        else step.assert = assertion;
        const storedRole=boundary ? display?.role : override;
        setStepPresentation(c,owner,{...display,group,role:storedRole,evidence});
        c.presentationChanged ||= storedRole !== display?.role || !isDeepStrictEqual(evidence,previousEvidence);
        c.stepTargets = undefined;
        c.added = true;
        return true;
    }

    editStepOperation(c,location,step,path,fields) {
        const {command,add,target} = fields;
        const prior = add ? undefined : step;
        if (!editableCommands(prior).includes(command) ||
            (!add && !actionDefinition(step))) return false;
        const current = prior?.command===command ? prior.input?.target : undefined;
        const anchor = stepLocator(step);
        const scope = canonicalLocator(anchor?.owner[anchor.field])?.bundleName || c.bundle;
        const chosen = targetCommands.has(command) && !(command==="scroll" && target==="auto") ?
            this.stepTarget(c,path,fields,current,{area:"stepOperation",command,insert:add===true,scope}) : undefined;
        const edited = buildAction(prior,fields,chosen?.selector,(en,zh)=>this.words(en,zh));
        if (add) return this.insertStep(c,{path,side:fields.side || "after"},edited,
            {name:fields.name,role:roleOverride(stepRoles(edited),fields.role),evidence:chosen?.evidence});
        this.replaceOperation(c,location,step,edited,target==="keep" ? undefined : chosen?.evidence);
        c.stepTargets = undefined;
        return true;
    }

    replaceOperation(c,location,step,edited,selectedEvidence) {
        if (step.editNote) edited.editNote=step.editNote;
        if (isDeepStrictEqual(step,edited)) return;
        const display = c.presentation.get(step);
        const sameTarget = step.command===edited.command && isDeepStrictEqual(step.input?.target,edited.input?.target);
        const evidence = selectedEvidence || (sameTarget && stepEvidence({control:display?.evidence?.control,from:display?.evidence?.from}));
        const role = display?.role !== stepRoles(edited)[0] ? display?.role : undefined;
        c.presentation.delete(step);
        setStepPresentation(c,edited,{...display,role,evidence});
        c.presentationChanged ||= Boolean(display?.evidence && !isDeepStrictEqual(evidence,display.evidence));
        location.list[location.index] = edited;
        c.removedStep = undefined;
        c.added = true;
    }

    stepDetails(c,row,{name,group,role,description}) {
        const w=(en,zh)=>this.words(en,zh);
        if (role !== undefined && !bddRoles.includes(role))
            throw new Error(w("Choose Given, When or Then.","请选择 Given、When 或 Then。"));
        const previous=c.presentation.get(row.step) || {};
        const label=name===undefined ? previous.name : title(name);
        const section=group===undefined ? previous.group : title(group);
        if ((name && !label) || (group && !section)) throw new Error(w("Enter a title of up to 120 characters on one line.","请输入最多 120 字的单行标题。"));
        const wrapper=caseDescription(row.step);
        const prose=description===undefined ? wrapper?.text || previous.description || "" : descriptionText(description);
        if (description!==undefined && !prose && (wrapper || typeof description!=="string" || description.trim()))
            throw new Error(w(wrapper ? "Enter a step description of up to 1,200 characters." : "Use up to 1,200 characters for the description.",
                wrapper ? "请填写步骤描述，最多 1200 字。" : "步骤描述最多 1200 字。"));
        const defaultRole=row.boundary ? (row.list===c.plan.preconditions ? "Given" : "Then") : stepRoles(row.step)[0];
        const selected=role===undefined ? previous.role : (role!==defaultRole ? role : undefined);
        // Technical edits may replace the object at this position. Apply labels to the final object.
        return ()=>{
            const step=row.list[row.index], current=c.presentation.get(step);
            if (wrapper && prose!==wrapper.text) {
                wrapper.text=prose;
                if (pendingCaseWork(c.plan).length) c.added=true;
                else c.presentationChanged=true;
            }
            const display={...current,name:label,group:section,role:selected,description:wrapper ? undefined : prose || undefined};
            c.presentationChanged ||= ["name","group","role","description"].some(key=>(previous[key] || "")!==(display[key] || ""));
            setStepPresentation(c,step,display);
        };
    }

    async edit({id, revision, area, path, index, property, expected, name, role, add, text, saveName, note, explore, fromFailure,
        descriptionText:description,operationArea,...target}) {
        const c = this.candidate;
        if (!c || c.id !== id || c.revision !== revision || c.uri) return;
        let finishDetails;
        if (area==="stepDetails") {
            const row=selectedStepLocations(c.plan,[path])?.[0];
            if (!row || add) return;
            finishDetails=this.stepDetails(c,row,{name,role,description,group:target.group});
            if (!operationArea) {
                finishDetails();
                c.revision++;
                this.update();
                return;
            }
            if (row.boundary) {
                if (operationArea!=="stepCheck" && operationArea!==(row.list===c.plan.preconditions ? "start" : "goal")) return;
                index=row.index;
            } else if (!["stepOperation","stepCheck","stepGesture","step"].includes(operationArea)) return;
            area=operationArea;
            if (area==="stepCheck") role="Then";
        }
        if (area==="caseFeedback" || area==="stepFeedback") {
            const location = area==="stepFeedback" && stepLocation(c.plan,path);
            const owner = area==="caseFeedback" ? c.plan : location?.list?.[location.index];
            if (!owner || owner.useCase) return;
            const value = descriptionText(note);
            if (!value && String(note || "").trim()) throw new Error(this.words(
                "Enter up to 1,200 characters of feedback.","请输入最多 1200 字的修改意见。"));
            if (fromFailure && location) {
                const run = this.bench.state.run;
                const failure = reviewCaseFailure(run);
                const receipt = run?.steps?.[failure?.index];
                if (c.edit && run?.entry?.sourceDigest===sourceDigest(c.edit.original) && receipt?.path) {
                    const executionPath = compileCase(c.plan).paths?.get(path) || path;
                    if (executionPath===receipt.path.replace(/\.repeat\.iteration\[\d+\]/g,".repeat.steps")) {
                        const protectedValue = sensitiveControl.test(JSON.stringify(receipt.target || "")) || owner.command==="fill";
                        c.caseFailure={path,status:receipt.status,code:receipt.errorCode,
                            ...(!protectedValue && {expected:receipt.expected,actual:receipt.actual})};
                    }
                }
            }
            if (value) owner.editNote=value;
            else delete owner.editNote;
            c.added = true;
            c.revision++;
            this.update();
            if (explore && value) await this.bench.composition.show({id:c.id,revision:c.revision,
                action:area==="caseFeedback" ? "reviseCase" : "reviseStep",path});
            return;
        } else if (area === "name") {
            const value = typeof name === "string" ? name.trim() : "";
            if (!safeCaseName(value)) throw new Error(this.words("Enter a valid case name of up to 70 characters.","请输入不超过 70 个字符的有效用例名称。"));
            c.name = value;
        } else if (["step","stepName","stepCheck","stepOperation","stepGesture"].includes(area)) {
            const location = stepLocation(c.plan,path);
            const step = add || area==="stepCheck" ? insertionAnchor(c.plan,path) : location?.list?.[location.index];
            if (!step) return;
            const stepName = add ? title(name) : undefined;
            if (add && name && !stepName) throw new Error(this.words("Enter a short title on one line.","请输入简短的单行标题。"));
            if (area === "stepName") {
                const label = title(name), group = title(target.group);
                if ((name && !label) || (target.group && !group)) throw new Error(this.words("Enter a short title on one line.","请输入简短的单行标题。"));
                const previous = c.presentation.get(step);
                const roles = stepRoles(step);
                if (role && !roles.includes(role)) return;
                const override = role ? roleOverride(roles,role) : previous?.role;
                setStepPresentation(c,step,{...previous,name:label,group,role:override});
                c.presentationChanged ||= label !== (previous?.name || "") || group !== (previous?.group || "") || override !== previous?.role;
            } else if (area === "stepCheck") {
                if (!this.editStepCheck(c,step,path,{add,property,expected,role,name:stepName,...target},!add && !location)) return;
            } else if (area==="stepOperation") {
                if (!this.editStepOperation(c,location,step,path,{...target,add,property,expected,text,role,name:stepName})) return;
            } else if (area==="stepGesture") {
                const edited = buildGesture(add ? undefined : step,{...target,text},(en,zh)=>this.words(en,zh));
                if (!edited) return;
                if (add) this.insertStep(c,{path,side:target.side || "after"},edited,{name:stepName,role:roleOverride(stepRoles(edited),role)});
                else this.replaceOperation(c,location,step,edited);
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
            const edited = {...prior,selector,property,equals};
            const display = c.presentation.get(prior);
            if (display) {
                c.presentation.delete(prior);
                c.presentation.set(edited,display);
            }
            checks[index] = edited;
            c.plan[key] = checks;
            c.added = true;
        } else return;
        finishDetails?.();
        c.revision++;
        this.update();
        if (area === "name" && saveName && c.edit && !c.added && !c.reordered && !c.presentationChanged) {
            if (c.name === c.originalName) this.cancel(true);
            else await this.save({id,name:c.name});
        }
    }

    async moveStep({id, revision, uri, digest, from, to, timeline}) {
        const starting = !this.candidate;
        const c = await this.stepDraft({id,revision,uri,digest});
        if (!c) return;
        const location = selectedStepLocations(c.plan,[from])?.[0];
        let moved=false;
        if (timeline && location && (location.boundary || location.list===c.plan.steps)) {
            const entries=["preconditions","steps","goals"].flatMap(field=>(c.plan[field] || [])
                .map((step,index)=>({step,field,path:`${field}[${index}]`})));
            moved=moveListItem(entries,entries.findIndex(entry=>entry.path===from),to);
            if (moved) {
                let first=0,last=entries.length;
                while (first<last && entries[first].field==="preconditions") first++;
                while (last>first && entries[last-1].field==="goals") last--;
                const body=entries.slice(first,last);
                const extra=body.filter(entry=>entry.field!=="steps").length;
                if (extra && [...stepEntries(c.plan.steps)].length+extra>maxSteps)
                    throw new Error(this.words("The workflow has reached its step limit.","已达到流程的步骤上限。"));
                if (c.plan.preconditions) c.plan.preconditions=entries.slice(0,first).map(entry=>entry.step);
                if (c.plan.goals) c.plan.goals=entries.slice(last).map(entry=>entry.step);
                c.plan.steps=body.map(({field,step})=>field==="steps" ? step :
                    asAssertionStep(step,field==="preconditions" ? "Given" : "Then",c.presentation));
            }
        } else if (!timeline && location) moved=moveListItem(location.list,location.index,to);
        if (!moved) {
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

    removeSelectedSteps(c, paths, bulk) {
        const selected = selectedStepLocations(c.plan,paths);
        if (!selected?.length) {
            if (bulk) throw new Error(this.words("The steps changed. Select them again.","步骤已变化，请重新选择。"));
            return false;
        }
        const groups = new Map();
        for (const row of selected) {
            if (!groups.has(row.list)) groups.set(row.list,[]);
            groups.get(row.list).push(row);
        }
        for (const [list,rows] of groups) {
            const canEmpty = rows[0].boundary || /\.else\[\d+\]$/.test(rows[0].path) || (bulk && list===c.plan.steps);
            if (rows.length===list.length && !canEmpty) {
                if (bulk) throw new Error(this.words("Select the whole branch, loop or generated step to remove its last step.",
                    "如需删除最后一条，请选中它所在的分支、循环或生成步骤整行。"));
                return false;
            }
        }
        c.removedStep = Array.from(groups,([list,rows])=>{
            const removed=rows.map(({index,step})=>({index,step})).sort((a,b)=>a.index-b.index);
            for (const {index} of removed.toReversed()) list.splice(index,1);
            return {list,removed};
        });
        return true;
    }

    async changeStep(message) {
        const {action,path,paths} = message;
        if (!["undoRemove","duplicate","remove","removeSelected"].includes(action)) return;
        const starting = !this.candidate;
        const c = await this.stepDraft(message);
        if (!c) return;
        if (action === "undoRemove") {
            if (!c.removedStep) return;
            for (const {list,removed} of c.removedStep) {
                for (const {index,step} of removed) list.splice(index,0,step);
            }
            c.removedStep = undefined;
        } else if (action === "duplicate") {
            const location = selectedStepLocations(c.plan,[path])?.[0];
            const step = location?.step;
            if (!step) return;
            if (step.ruleGroup) {
                if (starting) this.cancel(true);
                throw new Error(this.words("Insert a rule group at the point where it should change.","请在需要切换规则的位置插入规则组步骤。"));
            }
            const {list,index} = location;
            if (!location.boundary && c.plan.format !== deviceRecordingFormat &&
                [...stepEntries(c.plan.steps)].length + [...stepEntries([step])].length > maxSteps)
                throw new Error(this.words("The workflow has reached its step limit.","已达到流程的步骤上限。"));
            const copy = structuredClone(step);
            list.splice(index+1,0,copy);
            const originals = [...stepEntries([step])], copies = [...stepEntries([copy])];
            originals.forEach(({step:original},i)=>{
                const description = caseDescription(copies[i].step);
                if (description) description.id = randomUUID();
                const {evidence,...display} = c.presentation.get(original) || {};
                setStepPresentation(c,copies[i].step,display);
            });
            c.removedStep = undefined;
        } else if (!this.removeSelectedSteps(c,action==="removeSelected" ? paths : [path],action==="removeSelected")) {
            return;
        }
        c.stepTargets = undefined;
        c.reordered = true;
        c.revision++;
        this.update();
    }

    async organize({id,revision}) {
        const c = this.candidate, b = this.bench;
        if (!c || c.id !== id || c.revision !== revision || c.organizationJob || c.uri || b.state.busy) return;
        const steps = Array.from(stepEntries(c.plan.steps)).filter(({step})=>!caseDescription(step) && !step.ruleGroup);
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
            for (const [i,{step}] of steps.entries())
                setStepPresentation(c,step,{...c.presentation.get(step),...proposed[i],role:proposed[i].role});
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
            const pick = await win.showQuickPick([...options,{label:w("Enter a control ID","输入控件 ID")}],{title,ignoreFocusOut:true});
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
            {label:w("Control text equals","控件文字等于"),property:"text"},
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
        if (!c || c.id !== id || !c.plan.steps.length && !descriptionText(c.plan.editNote)) return;
        this.stopOrganizing(id);
        const w = (en,zh)=>this.words(en,zh);
        const presentation = storePresentation(c.plan,c.presentation);
        const {plan:compiled,pending} = compileCase(c.plan);
        const priorPresentation = Object.hasOwn(c,"metadataPresentation") ? c.metadataPresentation : c.presentationData;
        let composition;
        if (c.plan!==compiled || c.compositionData) {
            const revised = compositionRecord(c.plan,compiled,presentation);
            const before = c.edit && readWorkflow(c.edit.original).plan;
            const previous = before && (c.compositionData?.find(item=>item.digest===signature(before)) ||
                compositionRecord(before,before,priorPresentation));
            composition = [revised,...(previous && previous.digest!==revised.digest ? [previous] : [])];
        }
        // If indexing or opening fails after the files were created, retry that step on the same directory.
        if (c.edit && !c.uri) {
            if (!c.added && !c.reordered && !c.presentationChanged && !c.groupChanged && c.name === c.originalName) return;
            if (c.presentationChanged && !c.added && !c.reordered && !c.groupChanged) {
                const raw=await fs.readFile(c.edit.uri.fsPath,"utf8");
                const edited=v.workspace.textDocuments?.find(doc=>doc.isDirty && doc.uri.toString()===c.edit.uri.toString());
                if (raw.replace(/^\uFEFF/,"")!==c.edit.original.replace(/^\uFEFF/,"") || (edited && edited.getText()!==c.edit.original))
                    throw new Error(w("The case file changed. Reopen it before saving step details.","用例文件有改动，请重新打开后再保存步骤信息。"));
            }
            if ((c.presentationChanged || c.presentationData && (c.added || c.reordered)) &&
                !isDeepStrictEqual((await readCaseMetadata(c.edit.uri))?.presentation,priorPresentation))
                throw new Error(w("The step details changed on disk. Reopen the case before saving.","磁盘上的步骤信息有改动，请重新打开用例后再保存。"));
            if (composition && (c.added || c.reordered || c.presentationChanged)) {
                await b.caseLibrary.updateMetadata(c.edit.uri,{composition},priorPresentation,c.compositionData);
                c.compositionData = composition;
            }
            if (c.added || c.reordered || c.groupChanged) await this.updateDraft(c,compiled);
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
            const folder = readiness(compiled) ? await writeReplay(parent[0].fsPath,name,compiled,c.group) :
                (await writeCase(parent[0].fsPath,name,compiled,c.group)).folder;
            c.uri = v.Uri.file(path.join(folder,"workflow.json"));
            c.savedName = name;
        }
        this.update();
        if (c.edit && c.groupChanged) {
            if (!c.group) await this.clearRequiredGroup(c.uri);
            await b.networks.clearCaseBinding(c.uri.toString());
        }
        if (c.edit && !c.savedMetadata) {
            const changes = {...(c.savedName !== c.originalName && {name:c.savedName}),
                ...(Boolean(pending?.length)!==Boolean(pendingCaseWork(readWorkflow(c.edit.original).plan).length) && {draft:Boolean(pending?.length)}),
                ...((c.presentationChanged || (c.added || c.reordered) && (presentation || c.presentationData)) && {presentation})};
            if (Object.keys(changes).length) await b.caseLibrary.updateMetadata(c.uri,changes,priorPresentation);
            c.savedMetadata = true;
        }
        await b.caseLibrary.add(c.uri,{name:c.savedName,source:c.source,origin:c.origin,presentation,composition,section:c.section,draft:Boolean(pending?.length)});
        await b.refreshCases();
        if (!c.returnDraft) await b.setPlan(c.uri);
        if (c.recording && b.state.draft === c.recording) b.state.draft = undefined;
        await c.onSave?.();
        this.cancel(true);
        if (c.returnDraft) this.vscode.window.showInformationMessage?.(w(
            `Saved “${c.savedName}” as a new case. Your original draft is open.`,
            `已另存为新用例「${c.savedName}」，已返回原草稿。`));
    }

    async saveSection(c, anchorPath, {from=anchorPath,through,name}, paths) {
        const cleaned=typeof name==="string" ? name.trim() : "";
        if (!safeCaseName(cleaned)) throw new Error(this.words("Enter a valid section name.","请填写有效的片段名称。"));
        if (!paths) {
            const range=sectionRangePaths(c.plan,anchorPath);
            const start=range.indexOf(from),end=range.indexOf(through);
            if (start<0 || end<start)
                throw new Error(this.words("Choose a continuous range.","请选择连续步骤。"));
            paths=range.slice(start,end+1);
        }
        const selected=sectionSelection(c.plan,paths);
        if (!selected) throw new Error(this.words("Select steps from the same sequence.","请在同一组步骤中选择。"));
        const steps=selected.filter(row=>!row.boundary).map(row=>row.step);
        const checks={};
        const display=new Map(c.presentation);
        const onlyChecks=!steps.length;
        if (onlyChecks) {
            if (selected.length>maxSteps) throw new Error(this.words("The workflow has reached its step limit.","已达到流程的步骤上限。"));
            for (const row of selected) steps.push(asAssertionStep(row.step,row.list===c.plan.preconditions ? "Given" : "Then",display));
        } else {
            for (const field of ["preconditions","goals"]) {
                const values=selected.filter(row=>row.boundary && row.list===c.plan[field]).map(row=>row.step);
                if (values.length) checks[field]=values;
            }
        }
        const revision=c.revision;
        const plan={version:c.plan.version,steps,...checks,...(!onlyChecks && c.plan.format && {format:c.plan.format})};
        const {plan:compiled,pending}=compileCase(plan);
        if (pending?.length) throw new Error(this.words("Generate the steps before saving a reusable section.","先生成选中范围内的步骤，再保存可复用片段。"));
        const presentation=storePresentation(plan,display);
        const [parent]=await this.vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,
            defaultUri:this.vscode.workspace.workspaceFolders?.[0]?.uri,
            openLabel:this.words("Save reusable section here","在此保存可复用片段")}) || [];
        if (!parent || parent.scheme!=="file" || this.candidate!==c || c.revision!==revision) return;
        const folder=await writeReplay(parent.fsPath,cleaned,compiled,c.group);
        const uri=this.vscode.Uri.file(path.join(folder,"workflow.json"));
        const composition=plan!==compiled ? [compositionRecord(plan,compiled,presentation)] : undefined;
        await this.bench.caseLibrary.add(uri,{name:cleaned,source:"workflow",section:true,presentation,composition});
        await this.bench.refreshCases();
        return true;
    }

    async clearRequiredGroup(uri) {
        const entry = await findCase(uri);
        if (!entry?.requiresRuleGroup) return;
        const v = this.vscode;
        const script = v.Uri.file(path.join(entry.folder,entry.filename));
        const doc = await v.workspace.openTextDocument(script);
        const source = doc.getText();
        const match = /^REQUIRES_RULE_GROUP = True\r?$/m.exec(source);
        if (!match || doc.isDirty)
            throw new Error(this.words("Save the Python test file before removing its rule group.","请先保存 Python 测试文件，再移除规则组。"));
        const edit = new v.WorkspaceEdit();
        const start = match.index;
        edit.replace(script,new v.Range(doc.positionAt(start),doc.positionAt(start+"REQUIRES_RULE_GROUP = True".length)),
            "REQUIRES_RULE_GROUP = False");
        if (!await v.workspace.applyEdit(edit) || !await doc.save())
            throw new Error(this.words("Could not save the Python test file.","无法保存 Python 测试文件。"));
    }

    async updateDraft(c, compiled = c.plan) {
        const v=this.vscode, {uri,original}=c.edit;
        const doc = await v.workspace.openTextDocument(uri);
        const conflict = ()=>new Error(this.words("The case file changed. Go back, save your edits, and review the latest version.",
            "用例文件有其他修改。请返回并保存编辑，再核对最新版本。"));
        const unchanged = async()=>!doc.isDirty && doc.getText()===original &&
            (await fs.readFile(uri.fsPath,"utf8")).replace(/^\uFEFF/,"")===original.replace(/^\uFEFF/,"");
        if (!await unchanged()) throw conflict();
        const next = JSON.stringify(workflowForSave(compiled,c.group),null,2) + "\n";
        const folder = path.dirname(uri.fsPath);
        let script, content;
        try {
            if (c.added && !readiness(compiled) && !await findCase(uri)) {
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

module.exports = {CaseAuthoring,caseDefinitions,canEditCase,stepLocation};
