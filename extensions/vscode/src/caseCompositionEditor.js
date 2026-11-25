"use strict";

const {randomUUID} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {readWorkflow, workflowWithScenario} = require("./workflowFile");
const {hasRuleSteps,ruleGroupsByPosition,ruleEnableConflict} = require("./caseRuleSteps");
const {ruleGroupName} = require("./network");
const {runCasePlan} = require("./workflowWorker");
const {readCaseMetadata, createBdd} = require("./caseLibrary");
const {stepEntries, restorePresentation, storePresentation, stepEvidence, pageCue, descriptionText, caseDescription,
    pendingDescriptions, pendingCaseWork} = require("./casePresentation");
const {signature, sourceIds, referencesFor, appFor, hasEscape, authoredDocument, compileCase, compositionType, referenceStatus,
    bindingNames, scopedSnapshot, stepLocation, sectionSelection, sectionRangePaths, asAssertionStep, atInsertion, stageInsertion, rememberInsertion, promoteRecording, checkInsertionPosition} = require("./caseComposition");
const {sourceDigest} = require("./caseRepair");
const {readiness} = require("./pytestCase");
const {runPhoneTask} = require("./aiTasks");
const {explorationCandidate} = require("./explorationCases");
const {stageBranchDifference} = require("./explorationCaseEdit");
const {pageView, deviceRecordingFormat} = require("./model");
const {validateRecording} = require("./deviceRecorder");
const {workItems, discoverCaseRevision, verifyCaseRevision} = require("./caseRevision");

function copyPrefix(plan, anchor) {
    const path=anchor.path || "";
    const at= /^(steps|preconditions|goals)\[(\d+)\](.*)$/.exec(path);
    if (!["before","after"].includes(anchor.side)) return;
    if (path==="steps" && !plan.steps.length) return {...plan,steps:[],goals:[]};
    if (!at) return;
    const [,field,rawIndex,inner]=at, index=Number(rawIndex);
    if (!plan[field]?.[index]) return;
    const count=index+(anchor.side==="after"?1:0);
    const prefix={...plan,steps:field==="steps" ? plan.steps.slice(0,count) : field==="goals" ? plan.steps : [],
        preconditions:field==="preconditions" ? plan.preconditions.slice(0,count) : plan.preconditions,
        goals:field==="goals" ? plan.goals.slice(0,count) : []};
    if (inner) {
        // Generated descriptions are linear groups. Conditional arms and loop iterations
        // require a runtime decision and cannot be selected by slicing their authored path.
        const group=field==="steps" && caseDescription(plan.steps[index]);
        if (!group?.steps?.length || !inner.startsWith(".description.steps[")) return;
        const nested=copyPrefix({steps:group.steps},{path:inner.slice(".description.".length),side:anchor.side});
        if (!nested) return;
        prefix.steps=plan.steps.slice(0,index);
        if (nested.steps.length) prefix.steps.push({...plan.steps[index],description:{...group,steps:nested.steps}});
    }
    delete prefix.editNote;
    return prefix;
}

function authoredPrefix(plan, anchor) {
    const prefix=copyPrefix(plan,anchor);
    if (prefix && !hasEscape(prefix) && !pendingCaseWork(prefix).length) return prefix;
}

function replayPrefix(plan, anchor) {
    const prefix=authoredPrefix(plan,anchor);
    if (!prefix) return;
    const compiled = compileCase(prefix);
    if (compiled.pending?.length || hasEscape(compiled.plan)) return;
    if (compiled.plan.format===deviceRecordingFormat && compiled.plan.steps.length) {
        const converted=structuredClone(compiled.plan);
        promoteRecording(converted);
        return converted;
    }
    return compiled.plan;
}

function descriptionAt(plan,path) {
    const row = stepLocation(plan,path);
    return caseDescription(row?.list?.[row.index]);
}

function allRows(bdd) {
    const rows = [];
    function collect(list) {
        for (const row of list) {
            rows.push(row);
            for (const branch of row.branches || []) if (!branch.readOnly) collect(branch.steps);
        }
    }
    collect(bdd?.steps || []);
    return rows;
}

function sectionRows(bdd, paths) {
    const byPath = new Map(allRows(bdd).map(row=>[row.path,row]));
    return paths.map((path,index)=>{
        const row = byPath.get(path);
        return {path,text:row?.name || row?.text || String(index+1),role:row?.role};
    });
}

function defaultInsertion(bdd) {
    const rows = bdd?.steps || [];
    const goal = rows.find(row=>row.area==="goal");
    if (goal) return {path:goal.path,side:"before"};
    const end = rows.findLast(row=>row.path);
    if (end) return {path:end.path,side:"after"};
}

function previewTitle(bdd, path, side) {
    function locate(rows, scope, precedingRow, followingRow) {
        const index=rows.findIndex(row=>row.path===path);
        if (index>=0) {
            const before=rows[index+(side==="after"?0:-1)] || precedingRow, after=rows[index+(side==="after"?1:0)] || followingRow;
            return {scope,before:before?.name || before?.text,after:after?.name || after?.text};
        }
        for (const [i,row] of rows.entries()) for (const branch of row.branches || []) {
            if (branch.readOnly) continue;
            const result=locate(branch.steps,[row.name || row.text,branch.label].filter(Boolean).join(" · "),
                row.description ? rows[i-1] || precedingRow : undefined,
                row.description ? rows[i+1] || followingRow : undefined);
            if (result) return result;
        }
    }
    return locate(bdd?.steps || []) || {};
}

function previewSteps(bdd) {
    return allRows(bdd).filter(row=>row.area!=="setup").map(({role,name,text,path,area})=>({
        role,text:name || text,details:name && name!==text ? text : undefined,path,area
    }));
}

function prefixPresentation(source,prefix) {
    const display = new Map(source.presentation);
    // A truncated description wrapper has a new identity at its original path.
    for (const {path,step} of stepEntries(prefix.steps)) {
        if (!step.description || display.has(step)) continue;
        const row=stepLocation(source.plan,path);
        const info=row && display.get(row.list[row.index]);
        if (info) display.set(step,info);
    }
    return display;
}

function changePreview(previous, next, language) {
    const summarize = ref=>previewSteps(createBdd(ref.plan,language,undefined,restorePresentation(ref.plan,ref.presentation)));
    const old = summarize(previous), revised = summarize(next);
    // Compare by executable order as well as text. A rename alone has the same execution digest.
    let first = 0, last = 0;
    while (first<old.length && first<revised.length && isDeepStrictEqual(old[first],revised[first])) first++;
    while (last<old.length-first && last<revised.length-first &&
        old[old.length-last-1].role===revised[revised.length-last-1].role &&
        old[old.length-last-1].text===revised[revised.length-last-1].text &&
        old[old.length-last-1].details===revised[revised.length-last-1].details) last++;
    return {removed:old.slice(first,old.length-last),added:revised.slice(first,revised.length-last)};
}

function flattenSnapshotPresentation(authored) {
    if (!authored.authored) return authored.display;
    const executed = new Map(Array.from(stepEntries(authored.execution.steps),({path,step})=>[path,step]));
    const display = new Map();
    for (const field of ["preconditions","goals"]) {
        for (const [i,check] of (authored.plan[field] || []).entries()) {
            const info=authored.presentation.get(check);
            if (info && authored.execution[field]?.[i]) display.set(authored.execution[field][i],info);
        }
    }
    for (const {path,step} of stepEntries(authored.plan.steps)) {
        const original = authored.presentation.get(step);
        const runtime = executed.get(authored.paths.get(path));
        if (original && runtime) display.set(runtime,original);
    }
    return storePresentation(authored.execution,display);
}

const protectedControl = /password|passcode|secret|token|密码|口令|验证码/i;
function cue(page) {
    if (!page?.nodes?.length) return;
    const nodes = page.nodes.filter(node=>node.visible!==false);
    const routes = [...new Set(nodes.map(node=>node.attributes?.pagePath).filter(Boolean))];
    const apps = [...new Set(nodes.map(node=>node.bundle).filter(Boolean))];
    const keys = [...new Set(nodes.filter(node=>node.id).map(node=>node.id))];
    return {title:pageCue(page),route:routes.length===1?routes[0]:undefined,
        app:apps.length===1?apps[0]:undefined,keys:keys.slice(0,160)};
}
function samePage(left,right) {
    if (!left || !right) return undefined;
    if (left.app && right.app && left.app!==right.app) return false;
    if (left.route && right.route && left.route!==right.route) return false;
    if (left.title && right.title && left.title!==right.title && !left.route && !right.route) return false;
    if (left.keys?.length && right.keys?.length) {
        const keys = new Set(right.keys);
        if (left.keys.some(key=>keys.has(key))) return true;
        if (left.keys.length>2 && right.keys.length>2) return false;
    }
    if (left.route && right.route) return true;
    if (left.title && right.title) return left.title===right.title;
}

class CaseCompositionEditor {
    constructor(bench,vscode) {
        this.b = bench;
        this.v = vscode;
        this.sources = new Map();
    }

    words(en,zh) { return /^zh/i.test(this.b.language) ? zh : en; }

    cancelJob() { this.job?.abort(); }

    closeDraft(id) {
        if (this.draft?.id!==id) return;
        this.cancelJob();
        this.draft = undefined;
        this.b.state.caseComposition = undefined;
    }

    returnToCase(c) {
        const {startedReview} = this.draft;
        this.closeDraft(c.id);
        this.b.state.tool = "recordings";
        if (startedReview && !this.b.state.caseReview?.dirty) this.b.caseAuthoring.cancel(true);
        else {
            c.stepTargets = undefined;
            this.b.caseAuthoring.update();
        }
    }

    async forkCase(message) {
        const author=this.b.caseAuthoring;
        const source=await author.forkSource(message);
        if (!source || author.candidate!==source.returnDraft || source.returnDraft && source.returnDraft.revision!==message.revision) return;
        const c=source.candidate;
        let plan,display,position;
        if (message.paths!==undefined) {
            const rows=sectionSelection(c.plan,message.paths);
            if (!rows?.length || rows.some(row=>!row.boundary && row.list!==c.plan.steps))
                throw new Error(this.words("Select top-level steps. Select a whole condition, loop, description or reference to copy its children.",
                    "请选择顶层步骤。要复制内部步骤，请选择整个条件、循环、描述或引用。"));
            plan={...c.plan};
            for (const field of ["steps","preconditions","goals"]) {
                if (c.plan[field]) plan[field]=rows.filter(row=>row.list===c.plan[field]).map(row=>row.step);
            }
            display=new Map(c.presentation);
            position=this.words(`Copied ${rows.length} selected rows`,`已复制选中的 ${rows.length} 步`);
        } else {
            plan=copyPrefix(c.plan,message);
            if (!plan) throw new Error(this.words("Choose a position in the case before or after the whole condition, loop or reference.",
                "请选择用例中有效的位置。条件、循环和引用请选在整个步骤之前或之后。"));
            display=prefixPresentation(c,plan);
            const bdd=source.returnDraft ? this.b.state.caseReview.bdd : this.b.state.caseBdd;
            const previous=previewTitle(bdd,message.path,message.side).before;
            position=previous ? this.words("After "+previous,previous+" 之后") : this.words("Case start","用例起点");
        }
        delete plan.editNote;
        // A saved workflow requires a body. Promote just the adjacent check,
        // retaining every other setup/final check and the visible order.
        if (!plan.steps.length && plan.goals?.length) {
            plan.steps=[asAssertionStep(plan.goals[0],"Then",display)];
            plan.goals=plan.goals.slice(1);
        } else if (!plan.steps.length && plan.preconditions?.length) {
            plan.steps=[asAssertionStep(plan.preconditions.at(-1),"Given",display)];
            plan.preconditions=plan.preconditions.slice(0,-1);
        }
        if (!plan.steps.length && plan.format===deviceRecordingFormat) {
            delete plan.format;
            plan.version="1";
        }
        const origin={parentCaseName:c.name,parentCaseId:source.parentCaseId,parentCaseDigest:source.parentCaseDigest,forkPosition:position};
        author.begin({name:c.name.slice(0,50)+this.words(" - new case"," - 新用例"),source:"workflow",origin,group:c.group,
            plan,added:true,emptyCase:!plan.steps.length,returnDraft:source.returnDraft},storePresentation(plan,display));
        this.closeDraft(c.id);
    }

    async readSource(item) {
        if (!item?.portableId) return item && {...item,issue:"identity"};
        const uri = this.v.Uri.parse(item.uri);
        try {
            const [raw,metadata] = await Promise.all([this.v.workspace.fs.readFile(uri),readCaseMetadata(uri)]);
            if (metadata?.id!==item.portableId) return {...item,issue:"identity"};
            const file = readWorkflow(Buffer.from(raw).toString("utf8"));
            const authored = authoredDocument(file,metadata);
            const group = file.scenario || this.b.networks.bindings[item.uri];
            const plan = file.plan;
            const type = compositionType(plan);
            let issue = file.draft || pendingCaseWork(plan).length ? "draft" : authored.stale ? "layout" : !plan?.steps?.length || !type ||
                hasEscape(plan) ? "workflow" : undefined;
            if (!issue && type==="coordinates") {
                try { validateRecording(plan); }
                catch { issue="workflow"; }
            }
            return {...item,name:metadata.name,caseId:metadata.id,app:appFor(authored.plan),issue,group,plan,
                dependencies:sourceIds(authored.plan),presentation:issue ? undefined : flattenSnapshotPresentation(authored),
                digest:signature({plan,group}),preview:previewSteps(createBdd(authored.plan,this.b.language,undefined,authored.presentation,authored))};
        } catch {
            return {...item,issue:"unavailable"};
        }
    }

    async loadSources(ids, {fresh=false}={}) {
        if (fresh) await this.b.refreshCases();
        const items = this.b.knownCases || this.b.state.cases;
        const seen = new Set();
        const matches = items.filter(item=>!ids || ids.includes(item.portableId));
        const output = [];
        for (let start=0;start<matches.length;start+=12) {
            const batch=await Promise.all(matches.slice(start,start+12).map(item=>this.readSource(item)));
            for (const record of batch) {
                output.push(record);
                if (record.portableId && record.issue!=="unavailable") {
                    this.sources.set(record.portableId,record);
                    seen.add(record.portableId);
                }
            }
        }
        for (const id of ids || this.sources.keys()) if (!seen.has(id)) this.sources.delete(id);
        return output;
    }

    insertionContext({id,revision,uri,digest,path,side}) {
        const {state,caseAuthoring} = this.b;
        const candidate = caseAuthoring.candidate;
        const bdd = candidate ? state.caseReview?.bdd : state.caseBdd;
        const current = candidate ? id===candidate.id && revision===candidate.revision && !candidate.uri :
            !id && !state.draft && state.caseDefinitions && digest && state.planDigest===digest;
        const row = allRows(bdd).find(item=>item.path===path);
        const position = path==="steps" ? candidate && !candidate.plan.steps.length : Boolean(row);
        if (state.tool==="recordings" && state.plan?.uri===uri && current &&
            (side==="before" || side==="after") && position) return {candidate,path,side,row};
        throw new Error(this.words("The steps changed. Choose the insertion point again.","用例步骤已变化，请重新选择插入位置。"));
    }

    async insertionDetails(message, context) {
        if (context.candidate) return context.candidate;
        const doc = await this.v.workspace.openTextDocument(this.v.Uri.parse(message.uri));
        const contents = doc.getText();
        if (sourceDigest(contents)!==message.digest)
            throw new Error(this.words("The case changed. Reopen it before inserting.","用例已更新，请重新打开后再插入。"));
        const {plan,scenario} = readWorkflow(contents);
        return {plan,group:scenario || this.b.networks.bindings?.[message.uri]};
    }

    insertionSources(uri) {
        const candidate = this.b.caseAuthoring.candidate;
        const currentUri = candidate ? candidate.edit?.uri?.toString() : uri;
        return this.b.state.cases.filter(item=>item.portableId && item.uri!==currentUri);
    }

    async indexInsertion(message, reply) {
        const job = this.insertionIndex = message.session;
        try {
            const target=await this.insertionDetails(message,this.insertionContext(message));
            const candidates=this.insertionSources(message.uri);
            for (let start=0;start<candidates.length && this.insertionIndex===job;start+=8) {
                const batch=await Promise.all(candidates.slice(start,start+8).map(item=>this.readSource(item)));
                if (this.insertionIndex!==job) return;
                reply({entries:batch.map(source=>({id:source.id,name:source.name,app:source.app,issue:this.issue(target,source),
                    steps:source.preview?.filter(row=>row.area==="step").length,
                    search:source.preview?.flatMap(row=>[row.text,row.details]).filter(Boolean).join(" ")}))});
            }
        } finally {
            if (this.insertionIndex===job) {
                this.insertionIndex=undefined;
                reply({indexed:true});
            }
        }
    }

    cancelInsertionIndex(session) {
        if (session===undefined || this.insertionIndex===session) this.insertionIndex=undefined;
    }

    async requestInsertion(message, reply) {
        if (typeof message.session!=="string" || !message.session) return;
        try {
            if (message.action==="cancel") return this.cancelInsertionIndex(message.session);
            if (message.action==="index") return await this.indexInsertion(message,reply);
            if (message.action==="preview") {
                const target=await this.insertionDetails(message,this.insertionContext(message));
                const source=await this.insertionSource(message);
                return reply({source:this.publicSource(target,source)});
            }
            if (message.action==="ruleGroups" || message.action==="ruleClosures") {
                const {ruleGroups} = message.action==="ruleClosures" ? await this.ruleClosuresFor(message) : await this.ruleGroupsFor(message);
                return reply({ruleGroups});
            }
            if (!["apply","undo","step","describe","applyRuleGroup"].includes(message.action)) return;
            let result;
            const busy = await this.b.perform(async()=>{
                try {
                    if (message.action==="undo") result=this.undoInsertion(message);
                    else if (message.action==="step") result=await this.prepareStep(message);
                    else if (message.action==="describe") result=await this.saveDescription(message);
                    else if (message.action==="applyRuleGroup") result=await this.applyRuleGroup(message);
                    else result=await this.applyInsertion(message);
                } catch (error) { result={error:this.b.errorMessage(error)}; }
            },{runtime:false});
            reply(result || {error:busy});
        } catch (error) { reply({error:this.b.errorMessage(error)}); }
    }

    async ruleStepTarget(message,context) {
        const target = await this.insertionDetails(message,context);
        if (context.candidate) return target;
        const authored = authoredDocument(target,await readCaseMetadata(this.v.Uri.parse(message.uri)));
        this.insertionContext(message);
        return {...target,...authored};
    }

    async ruleGroupsFor(message) {
        const context = this.insertionContext(message);
        if (context.candidate?.organizationJob)
            throw new Error(this.words("Wait for the current edit to finish.","请等待当前编辑完成。"));
        const target = await this.ruleStepTarget(message,context);
        const previous = this.ruleGroupBeingEdited(message,context,target);
        await this.b.networks.init();
        this.insertionContext(message);
        const library = this.b.networks.library;
        const existingNames = new Set();
        if (target.group && !target.group.paused) existingNames.add(ruleGroupName(target.group));
        for (const {enabledGroup} of ruleGroupsByPosition(target.plan,target.group).values())
            if (enabledGroup!==undefined) existingNames.add(enabledGroup);

        let placement;
        const previewStep = {ruleGroup:{action:"enable",scenario:null}};
        const legacy = message.ruleEdit==="legacy";
        const previousActivation = legacy && previous?.paused ? undefined : previous;
        const conflict = scenario=>{
            const name = ruleGroupName(scenario);
            if (!existingNames.has(name) || previousActivation && ruleGroupName(previousActivation)===name) return;
            if (legacy) return ruleEnableConflict(target.plan,scenario,undefined,name);
            previewStep.ruleGroup.scenario = scenario;
            placement ??= this.staged(target,context,[previewStep],{replace:message.ruleEdit==="step" ? context.path : undefined});
            return ruleEnableConflict(placement.plan,target.group,placement.insertedPath,name);
        };
        const entries = library.listing().flatMap(({id,name})=>{
            const scenario = {...library.get(id),paused:false};
            const enabled = scenario.rules.filter(rule=>rule.enabled!==false).length;
            if (!enabled) return [];
            const blocked = conflict(scenario);
            return [{scenario,option:{id,name,enabled,digest:signature(scenario),current:isDeepStrictEqual(scenario,previous),blocked}}];
        });
        const ruleGroups = {options:entries.map(({option})=>option),
            current:previous && (previous.name || this.words("Unnamed rule group","未命名规则组"))};
        return {context,previous,entries,ruleGroups};
    }

    async ruleClosuresFor(message) {
        const context = this.insertionContext(message);
        if (context.candidate?.organizationJob)
            throw new Error(this.words("Wait for the current edit to finish.","请等待当前编辑完成。"));
        const editing = message.ruleEdit==="close";
        if (message.ruleEdit && (!editing || context.row?.ruleGroup?.action!=="disable"))
            throw new Error(this.words("The rule group step changed. Open it again.","规则组步骤已变化，请重新打开。"));
        const target = await this.ruleStepTarget(message,context);
        this.insertionContext(message);

        const active = ruleGroupsByPosition(target.plan,target.group).get(context.path)?.[editing ? "before" : context.side]?.active;
        const location = editing ? stepLocation(target.plan,context.path) : undefined;
        const previous = location?.list[location.index]?.ruleGroup?.name;
        const nameFor = name=>name || this.words("Unnamed rule group","未命名规则组");
        const entries = Array.from(active || [],name=>({
            name,option:{id:JSON.stringify(name),name:nameFor(name),current:name===previous},
        }));
        return {context,entries,ruleGroups:{options:entries.map(({option})=>option),
            current:typeof previous==="string" ? nameFor(previous) : undefined}};
    }

    ruleGroupBeingEdited({ruleEdit},context,target) {
        if (!ruleEdit) return;
        const bdd = context.candidate ? this.b.state.caseReview?.bdd : this.b.state.caseBdd;
        const first = bdd?.steps?.find(row=>row.path)?.path || "steps";
        if (ruleEdit==="legacy" && context.path===first && context.side==="before" && target.group) return target.group;
        if (ruleEdit==="step" && context.row?.ruleGroup?.action==="enable") {
            const location = stepLocation(target.plan,context.path);
            const effect = location?.list[location.index]?.ruleGroup;
            if (effect?.action==="enable") return effect.scenario;
        }
        throw new Error(this.words("The rule group step changed. Open it again.","规则组步骤已变化，请重新打开。"));
    }

    duplicateRuleEnableError() {
        return new Error(this.words("The same rule group can only be enabled once at a time.","同一规则组在同一时间只能启用一次。"));
    }

    async applyRuleGroup(message) {
        const disable = message.disable===true;
        const remove = message.remove===true;
        const legacy = message.ruleEdit==="legacy";
        const closingEdit = message.ruleEdit==="close";
        if ((disable && (remove || message.ruleEdit && !closingEdit)) || (closingEdit && !disable) || (remove && !legacy))
            throw new Error(this.words("Choose a rule group action.","请选择一个规则组操作。"));

        let context, group, closingName;
        if (disable) {
            const choices = await this.ruleClosuresFor(message);
            context = choices.context;
            const selected = choices.entries.find(({option})=>option.id===message.groupId);
            if (!selected) throw new Error(this.words("Choose a rule group enabled at this position.","请选择在这个位置已启用的规则组。"));
            if (selected.option.current) return {path:context.path};
            closingName = selected.name;
        } else if (!remove) {
            const options = await this.ruleGroupsFor(message);
            context = options.context;
            const entry = options.entries.find(({option})=>option.id===message.groupId);
            if (!entry || entry.option.digest!==message.groupDigest)
                return {ruleGroups:options.ruleGroups,changed:true};
            if (entry.option.blocked) throw this.duplicateRuleEnableError();
            if (isDeepStrictEqual(entry.scenario,options.previous)) return {path:legacy ? "rule-group" : context.path};
            group = structuredClone(entry.scenario);
        } else {
            context = this.insertionContext(message);
            if (context.candidate?.organizationJob)
                throw new Error(this.words("Wait for the current edit to finish.","请等待当前编辑完成。"));
            if (remove) this.ruleGroupBeingEdited(message,context,await this.ruleStepTarget(message,context));
            this.insertionContext(message);
        }

        const author = this.b.caseAuthoring;
        const c = await author.stepDraft(message);
        if (!c) throw new Error(this.words("The steps changed. Choose the insertion point again.","用例步骤已变化，请重新选择插入位置。"));
        try {
            if (legacy) {
                if (group && (!c.group || c.group.paused || ruleGroupName(c.group)!==ruleGroupName(group)) &&
                    ruleEnableConflict(c.plan,group,undefined,ruleGroupName(group))) throw this.duplicateRuleEnableError();
                const path = group ? "rule-group" : context.path;
                rememberInsertion(c,{path:"rule-group"},{insertedPath:path,notice:remove ? "ruleGroupRemoved" : "applied"},!context.candidate);
                c.group = group;
                c.groupChanged = true;
                c.stepTargets = undefined;
                c.revision++;
                author.update();
                return {path,id:c.id,revision:c.revision};
            }
            if (disable && !ruleGroupsByPosition(c.plan,c.group).get(context.path)?.[closingEdit ? "before" : context.side]?.active.has(closingName))
                throw new Error(this.words("Choose a rule group enabled at this position.","请选择在这个位置已启用的规则组。"));
            const step = {ruleGroup:disable ? {action:"disable",name:closingName} : {action:"enable",scenario:group}};
            const replace = message.ruleEdit==="step" || closingEdit ? context.path : undefined;
            const staged = this.staged(c,context,[step],{replace});
            if (!disable) {
                const location = replace ? stepLocation(c.plan,replace) : undefined;
                const previous = location?.list[location.index]?.ruleGroup?.scenario;
                const name = ruleGroupName(group);
                if ((!previous || ruleGroupName(previous)!==name) &&
                    ruleEnableConflict(staged.plan,c.group,staged.insertedPath,name)) throw this.duplicateRuleEnableError();
            }
            rememberInsertion(c,context,{...staged,notice:replace ? "applied" : undefined},!context.candidate);
            this.commit(c,staged,false);
            return {path:staged.insertedPath,id:c.id,revision:c.revision};
        } catch (error) {
            if (!context.candidate) author.cancel(true);
            throw error;
        }
    }

    async insertionSource(message) {
        const item=this.insertionSources(message.uri).find(row=>row.id===message.sourceId);
        if (!item) throw new Error(this.words("This source is no longer in the case library.","来源用例已不在用例库中。"));
        const source=await this.readSource(item);
        if (!source.issue && source.caseId) this.sources.set(source.caseId,source);
        return source;
    }

    async prepareStep(message) {
        const context = this.insertionContext(message);
        const target = await this.insertionDetails(message,context);
        const coordinates = target.plan.format===deviceRecordingFormat;
        const {kind} = message;
        if (!["given","action","check"].includes(kind))
            throw new Error(this.words("Choose a step supported by this workflow.","请选择此流程支持的步骤类型。"));
        this.insertionContext(message);
        const c = await this.b.caseAuthoring.stepDraft(message);
        if (!c) throw new Error(this.words("The steps changed. Choose the insertion point again.","用例步骤已变化，请重新选择插入位置。"));
        const area = kind!=="action" ? "stepCheck" : coordinates ? "stepGesture" : "stepOperation";
        const startingCheck = kind==="given" || checkInsertionPosition(c.plan,context)?.field==="preconditions";
        const role = kind==="action" ? "When" : startingCheck ? "Given" : "Then";
        return {editor:{id:c.id,revision:c.revision,area,role,path:context.path,side:context.side}};
    }

    async saveDescription(message) {
        const context = this.insertionContext(message);
        const value = descriptionText(message.description);
        if (!value) throw new Error(this.words("Enter a step description of up to 1,200 characters.","请输入步骤描述，最多 1200 个字符。"));
        const author = this.b.caseAuthoring;
        const c = await author.stepDraft(message);
        if (!c) throw new Error(this.words("The steps changed. Choose the insertion point again.","用例步骤已变化，请重新选择插入位置。"));
        try {
            const previous = message.descriptionId && descriptionAt(c.plan,context.path);
            if (message.descriptionId && previous?.id!==message.descriptionId)
                throw new Error(this.words("This description changed. Open it again.","步骤描述已变化，请重新打开。"));
            if (previous?.text===value) {
                if (!context.candidate) author.cancel(true);
                return {path:context.path};
            }
            const step = {description:{id:previous?.id || randomUUID(),text:value}};
            const staged = this.staged(c,context,[step],{replace:previous && context.path});
            rememberInsertion(c,context,staged,!context.candidate);
            this.commit(c,staged,false);
            return {path:staged.insertedPath,id:c.id,revision:c.revision};
        } catch (error) {
            if (!context.candidate) author.cancel(true);
            throw error;
        }
    }

    async applyInsertion(message) {
        const context = this.insertionContext(message);
        const target = await this.insertionDetails(message,context);
        const source = await this.insertionSource(message);
        const preview = this.publicSource(target,source);
        if (preview.issue || (message.sourceDigest && message.sourceDigest!==source.digest))
            return {source:preview,changed:!preview.issue};
        this.insertionContext(message);
        const author = this.b.caseAuthoring;
        const c = await author.stepDraft(message);
        if (!c) throw new Error(this.words("The steps changed. Choose the insertion point again.","用例步骤已变化，请重新选择插入位置。"));
        try {
            const {steps,...options} = message.copy ? this.localSteps(source,c) : this.insertionReference(source,message.role);
            const staged=this.staged(c,context,steps,options);
            rememberInsertion(c,context,staged,!context.candidate);
            this.commit(c,staged,false);
            return {path:staged.insertedPath,id:c.id,revision:c.revision};
        } catch (error) {
            if (!context.candidate) author.cancel(true);
            throw error;
        }
    }

    undoInsertion({id,revision}) {
        const author=this.b.caseAuthoring, c=author.candidate, undo=c?.insertionUndo;
        if (this.b.state.tool!=="recordings" || !undo || c.id!==id || undo.revision!==c.revision || c.revision!==revision || c.uri) return {};
        Object.assign(c,undo.before,{insertionUndo:undefined,stepTargets:undefined,revision:c.revision+1});
        author.update();
        if (undo.startedReview && !this.b.state.caseReview?.dirty) author.cancel(true);
        return {path:undo.anchor};
    }

    async refreshFor(plan) {
        const ids = referencesFor(plan).map(({step})=>step.useCase.caseId);
        if (ids.length) await this.loadSources(ids);
        return this.sources;
    }

    async usages(caseId) {
        if (!caseId) return [];
        const entries = this.b.knownCases || this.b.state.cases;
        const result = [];
        for (let start=0;start<entries.length;start+=12) {
            const batch = await Promise.all(entries.slice(start,start+12).map(async item=>{
                try {
                    const uri = this.v.Uri.parse(item.uri);
                    const metadata = await readCaseMetadata(uri);
                    if (!metadata?.composition?.some(record=>sourceIds(record.plan).includes(caseId))) return [];
                    const bytes = await this.v.workspace.fs.readFile(uri);
                    const file = readWorkflow(Buffer.from(bytes).toString("utf8"));
                    const authored = authoredDocument(file,metadata);
                    const bdd = createBdd(authored.plan,this.b.language,undefined,authored.presentation,authored);
                    return referencesFor(authored.plan).filter(({step})=>step.useCase.caseId===caseId ||
                        step.useCase.dependencies?.includes(caseId)).map(({path,step})=>({uri:item.uri,name:metadata.name,path,
                            reference:step.useCase.name,...previewTitle(bdd,path,"before")}));
                } catch { return []; }
            }));
            result.push(...batch.flat());
        }
        return result;
    }

    issue(c, source) {
        if (source.issue) return source.issue;
        const candidate = this.b.caseAuthoring?.candidate;
        const parent = candidate && !candidate.edit ? undefined : this.b.state.activeCase;
        if (parent?.portableId && (source.caseId===parent.portableId || source.dependencies?.includes(parent.portableId))) return "cycle";
        if (source.group && !isDeepStrictEqual(c.group,source.group)) return "ruleGroup";
        const app=appFor(c.plan);
        if (app && source.app && app!==source.app) return "application";
    }

    publicSource(c, source) {
        return {id:source.id,name:source.name,uri:source.uri,app:source.app,source:source.source,section:source.section,
            tags:source.tags,issue:this.issue(c,source),preview:source.preview,digest:source.digest,bound:source.plan?.version==="2",
            location:source.location || this.v.workspace.asRelativePath?.(this.v.Uri.parse(source.uri),true)};
    }

    context() {
        const c = this.b.caseAuthoring.candidate;
        return c?.id===this.draft?.id ? c : undefined;
    }

    refresh() {
        const c = this.context(), draft = this.draft;
        if (!c || !draft) return;
        if (draft.mode==="revision") {
            this.revisionView(c,draft);
            return;
        }
        const bdd = this.b.state.caseReview?.bdd;
        const row = draft.path && stepLocation(c.plan,draft.path);
        const step = row?.list?.[row.index];
        const ref = step?.useCase && referenceStatus(step.useCase,this.sources);
        const latest = ref && this.sources.get(ref.caseId);
        const working = draft.explore;
        const outcome = working?.result;
        const mode = draft.mode;
        const description = draft.descriptionId && descriptionAt(c.plan,draft.anchor.path);
        const pending = description && pendingDescriptions(c.plan);
        const prefix = mode==="explore" && replayPrefix(c.plan,draft.anchor);
        const followUp = mode==="explore" && !description && draft.method==="ai";
        const retained = followUp && prefix && authoredPrefix(c.plan,draft.anchor);
        const location = draft.anchor && previewTitle(bdd,draft.anchor.path,draft.anchor.side);
        const positions = (mode==="pick" && !draft.path || mode==="explore" && !description && !followUp) && allRows(bdd)
            .filter(row=>row.path)
            .map(row=>({path:row.path,name:row.name || row.text}));
        const proposed = mode==="explore" && outcome && createBdd({...outcome.plan,
            steps:outcome.plan.steps},
            this.b.language,undefined,restorePresentation(outcome.plan,outcome.presentation));
        this.b.state.caseComposition = {
            mode, viewId:draft.viewId, caseName:c.name, anchor:draft.anchor, positions,
            location:draft.anchor && (description ? {...previewTitle(bdd,draft.anchor.path,"before"),
                after:previewTitle(bdd,draft.anchor.path,"after").after} : location),
            ...(mode==="pick" && {items:draft.items?.map(item=>this.publicSource(c,item)),replace:Boolean(draft.path)}),
            ...(mode==="references" && {references:referencesFor(c.plan).map(({path,step})=>{
                const ref = referenceStatus(step.useCase,this.sources);
                return {path,caseId:ref.caseId,name:ref.name,status:ref.status,digest:ref.digest.slice(0,8),
                    ...previewTitle(bdd,path,"before")};
            })}),
            ...(ref && {reference:{name:ref.name,status:ref.status,path:draft.path,uri:ref.uri,version:ref.digest.slice(0,8),bound:ref.plan.version==="2"},
                latest:latest && this.publicSource(c,latest),diff:mode==="update" && latest && changePreview(ref,latest,this.b.language)}),
            ...(mode==="section" && {sectionStart:draft.path,range:sectionRows(bdd,draft.sectionPaths || sectionRangePaths(c.plan,draft.path)),sectionPaths:draft.sectionPaths}),
            ...(mode==="explore" && {method:draft.method,canReplay:Boolean(prefix),
                ...(followUp && {followUp:{prefix:retained ? createBdd(retained,this.b.language,undefined,prefixPresentation(c,retained)).steps
                    .filter(row=>row.area!=="setup").map(row=>({role:row.role,text:row.name || row.text})) : [],
                    checkpoint:location.before,destination:draft.destination,
                    ...(draft.destination==="current" && {nextLabel:location.after})},
                    problem:working?.problem}),
                working:working?.working,progress:working?.progress,
                mismatch:working?.mismatch,entryIssue:working?.entryIssue,exitIssue:working?.exitIssue,
                result:outcome && {steps:previewSteps(proposed),
                    from:outcome.start?.title || outcome.start?.route,to:outcome.end?.title || outcome.end?.route},
                history:description ? undefined : this.b.state.explorationHistory || [],
                ...(description && {description:{id:description.id,text:description.text,implemented:Boolean(description.steps?.length),
                    hasNext:pending.some(row=>row.id!==description.id)},
                    canReplay:Boolean(prefix && (prefix.steps.length || prefix.preconditions?.length)),problem:working?.problem})}),
            usages:draft.usages,notice:draft.notice,...(mode==="update" && {verification:draft.verification}),stale:draft.revision!==c.revision,
        };
    }

    async begin(message) {
        const startedReview = !this.b.caseAuthoring.candidate;
        const c = await this.b.caseAuthoring.stepDraft(message);
        if (!c) return;
        if (message.action==="explore" && c.plan.format===deviceRecordingFormat) {
            if (startedReview) this.b.caseAuthoring.cancel();
            return;
        }
        if (this.draft?.id!==c.id) this.draft={id:c.id,startedReview};
        this.draft.revision=c.revision;
        return c;
    }

    async show(message) {
        const c = await this.begin(message);
        if (!c) return;
        const draft = this.draft;
        const mode = message.action;
        const bdd = this.b.state.caseReview.bdd;
        draft.path = ["reference","section"].includes(mode) ? message.path : undefined;
        draft.sectionPaths = undefined;
        if (mode==="section" && message.paths !== undefined) {
            const selected = sectionSelection(c.plan,message.paths);
            if (!selected) throw new Error(this.words("Select steps from the same sequence.","请在同一组步骤中选择。"));
            draft.sectionPaths = selected.map(row=>row.path);
            draft.path = selected[0].path;
        }
        draft.mode = mode==="open" ? "pick" : mode;
        draft.viewId = randomUUID();
        draft.usages = draft.verification = draft.notice = undefined;
        draft.anchor = undefined;
        draft.descriptionId = undefined;
        draft.destination = undefined;
        if (mode==="reviseCase" || mode==="reviseStep") {
            const path = mode==="reviseStep" ? message.path : undefined;
            const tasks = workItems(c.plan,bdd,this.b.language);
            const selected = path && tasks.find(item=>item.path===path && item.kind==="stepOpinion");
            if (mode==="reviseStep" && !selected || mode==="reviseCase" && !c.plan.steps.length && !tasks.length) return this.returnToCase(c);
            const prefix = path && replayPrefix(c.plan,{path,side:"before"});
            draft.mode="revision";
            draft.anchor=path ? {path,side:"before"} : undefined;
            draft.revisionWork={path,prefix,tasks:selected ? [selected] : tasks,phase:"ready"};
            this.b.state.tool="exploration";
            c.stepTargets=undefined;
            this.b.caseAuthoring.update();
            this.refresh();
            return;
        }
        if (mode==="generateDescription") {
            const description = descriptionAt(c.plan,message.path);
            if (!description || description.id!==message.descriptionId) return this.returnToCase(c);
            return this.openDescription(c,message.path,description);
        }
        if (["open","explore"].includes(mode)) {
            const emptyStart = message.path==="steps" && c.plan.steps.length===0;
            if (message.path && !emptyStart && !allRows(bdd).some(row=>row.path===message.path)) {
                this.returnToCase(c);
                throw new Error(this.words("This step is no longer available. Choose the position again.","这一步已不可用，请重新选择位置。"));
            }
            const anchor = message.path ? {path:message.path,side:message.side==="before"?"before":"after"} : defaultInsertion(bdd);
            if (!anchor) return this.returnToCase(c);
            draft.anchor = anchor;
        }
        if (mode==="explore") {
            draft.method = message.method==="history" ? "history" : "ai";
            if (draft.method==="ai") draft.destination = message.destination==="current" ? "current" : "new";
            draft.explore = {};
            this.b.state.tool = "exploration";
            c.stepTargets = undefined;
            this.b.caseAuthoring.update();
            if (draft.method==="history") await this.b.explorations.history();
        }
        if (["open","reference","references"].includes(mode)) {
            if (mode==="open") {
                draft.items=undefined;
                this.refresh();
                this.b.publish();
            }
            draft.items = await this.loadSources(mode==="open"?undefined:sourceIds(c.plan),{fresh:true});
            this.b.caseAuthoring.update();
        }
        this.refresh();
    }

    openDescription(c,path,description) {
        Object.assign(this.draft,{mode:"explore",method:"ai",explore:{},descriptionId:description.id,
            anchor:{path,side:"before"},viewId:randomUUID(),revision:c.revision});
        this.b.state.tool = "exploration";
        c.stepTargets = undefined;
        this.b.caseAuthoring.update();
        this.refresh();
    }

    revisionView(c,draft) {
        const work = draft.revisionWork, candidate = work.candidate;
        this.b.state.caseComposition = {mode:"revision",viewId:draft.viewId,caseName:c.name,anchor:draft.anchor,
            stale:draft.revision!==c.revision,
            revisionWork:{path:work.path,tasks:work.tasks,phase:work.phase,progress:work.progress,
                problem:work.problem,blockedPath:work.blockedPath,verification:work.verification,
                canReplay:Boolean(work.prefix && (work.prefix.steps.length || work.prefix.preconditions?.length)),
                ...(candidate && {diffs:candidate.diffs,plan:previewSteps(createBdd(candidate.plan,this.b.language,c.group,
                    candidate.presentation,candidate.compiled))})}};
    }

    async handleRevision(c,message) {
        const b = this.b, draft = this.draft, work = draft.revisionWork;
        if (message.action==="close" || message.action==="revisionEditBlocked") {
            if (message.action==="revisionEditBlocked" && work.blockedPath) c.revisionFocus={path:work.blockedPath,token:randomUUID()};
            return this.returnToCase(c);
        }
        if (message.action==="revisionApply") {
            const candidate=work.candidate;
            if (!candidate || (work.path ? work.phase!=="review" : work.phase!=="passed")) return;
            rememberInsertion(c,{path:work.path}, {...candidate,insertedPath:work.path},draft.startedReview);
            this.commit(c,candidate);
            this.returnToCase(c);
            if (!work.path) await b.caseAuthoring.save({id:c.id,name:c.name});
            return;
        }
        const verify = message.action==="revisionVerify";
        if (verify ? !work.candidate || work.path || !["review","failed"].includes(work.phase) :
            message.action!=="revisionRun" || !["ready","blocked"].includes(work.phase)) return;
        if (!b.state.device || !b.state.devices.includes(b.state.device)) throw new Error(b.text.selectDevice);
        const controller = this.job = new AbortController();
        work.phase=verify ? "verifying" : "exploring";
        work.progress=[];
        work.problem=work.verification=undefined;
        const publish = ()=>{
            if (this.draft===draft) {this.refresh();b.publish();}
        };
        const setPath = path=>{work.blockedPath=path;};
        const notify = (path,text)=>{
            if (path) setPath(path);
            if (text) work.progress=[...work.progress.slice(-11),text];
            publish();
        };
        publish();
        try {
            if (verify) {
                work.verification=await verifyCaseRevision(b,c,work.candidate,controller.signal);
                work.phase=work.verification.complete ? "passed" : "failed";
            } else {
                work.candidate=await discoverCaseRevision(b,c,{signal:controller.signal,notify,setPath,path:work.path,
                    prefix:work.prefix,useReplay:message.start==="replay"});
                work.phase="review";
            }
        } catch (error) {
            if (controller.signal.aborted) work.phase=verify ? "review" : "ready";
            else {
                work.phase=verify ? "failed" : "blocked";
                work.problem=b.errorMessage(error);
                work.verification=error.replay;
            }
        } finally {
            if (this.job===controller) this.job=undefined;
            publish();
        }
    }

    staged(c, anchor, steps, options) {
        return stageInsertion(c,anchor,steps,options,(en,zh)=>this.words(en,zh));
    }

    commit(c, staged, syncDraft=true) {
        c.plan = staged.plan;
        c.presentation = staged.presentation;
        c.added = true;
        c.compositionStale = false;
        c.stepTargets = c.removedStep = undefined;
        c.revision++;
        if (syncDraft && this.draft?.id===c.id) this.draft.revision=c.revision;
        this.b.caseAuthoring.update();
    }

    referenceStep(source) {
        return {useCase:{caseId:source.caseId,name:source.name,digest:source.digest,plan:source.plan,
            presentation:source.presentation,dependencies:source.dependencies,app:source.app}};
    }

    insertionReference(source, role) {
        const step = this.referenceStep(source);
        return {steps:[step],...(role==="Given" && {display:new Map([[step,{role}]])})};
    }

    localSteps(ref,c) {
        const {preconditions,steps,goals,version} = scopedSnapshot(ref.plan,bindingNames(c.plan));
        const original = restorePresentation(ref.plan,ref.presentation);
        const originalSteps = Array.from(stepEntries(ref.plan.steps),({step})=>step);
        const display = new Map(Array.from(stepEntries(steps),({step},index)=>[step,original.get(originalSteps[index])]).filter(([,item])=>item));
        const fromBoundary = (values,field,role)=>(values || []).map((assert,i)=>{
            const step={assert}, info=original.get(ref.plan[field][i]);
            if (info || role==="Given") display.set(step,{...info,role:info?.role || role});
            return step;
        });
        const checks=fromBoundary(preconditions,"preconditions","Given");
        return {steps:[...checks,...steps,...fromBoundary(goals,"goals","Then")],display,version,
            startCount:checks.length,goalCount:goals?.length || 0};
    }

    checkedSource(c, source) {
        if (!source || this.issue(c,source)) throw new Error(this.words("Choose a compatible case from the library.","请选择兼容的来源用例。"));
        return source;
    }

    async doInsert(c, message) {
        const draft = this.draft;
        const record = await this.readSource(draft.items?.find(item=>item.id===message.sourceId && !item.hidden));
        const source = this.checkedSource(c,record);
        if (message.digest!==source.digest) throw new Error(this.words("The source changed. Reopen the picker to review it.","来源用例已变更，请重新打开选择面板核对。"));
        const copy = message.action==="copy";
        const {steps,...pinned} = copy ? this.localSteps(source,c) : {steps:[this.referenceStep(source)]};
        this.commit(c,this.staged(c,draft.anchor,steps,{replace:draft.path,...pinned}));
        this.closeDraft(c.id);
    }

    async verifyUpdate(c, latest, runner) {
        const staged = this.staged(c,null,[this.referenceStep(latest)],{replace:this.draft.path});
        const plan = staged.compiled.plan;
        if (readiness(plan)) throw new Error(this.words("Set an initial condition and final assertion to verify a copy.",
            "请先补齐起始条件和最终断言，再运行副本验证。"));
        const contents = JSON.stringify(c.group ? workflowWithScenario(plan,c.group) : plan,null,2)+"\n";
        const bdd = createBdd(staged.plan,this.b.language,c.group,staged.presentation,{...staged.compiled,sources:this.sources});
        const entry = await this.b.verifyCompositionCopy(contents,bdd,plan.format===deviceRecordingFormat ? "workbench" : runner);
        const block = staged.compiled.layouts.get(this.draft.path);
        const prefix = block?.map("steps[0]");
        const reachable = prefix && this.b.state.run?.steps?.some(step=>
            step.path?.replace(/\.repeat\.iteration\[\d+\]/g,".repeat.steps")===prefix &&
                ["completed","passed"].includes(step.status));
        const finished = entry?.status==="passed" || entry?.source==="device" && entry.status==="completed";
        this.draft.verification = {status:finished && !reachable ? "notReached" : entry?.status || "unknown",
            run:entry?.id,digest:latest.digest};
    }

    async archivedAnchor(c, anchor) {
        if (!c.edit || c.added || c.reordered) return;
        const b = this.b, digest = sourceDigest(c.edit.original);
        const uri = c.edit.uri.toString();
        const entry = b.state.runs.find(row=>row.status==="passed" && !row.compositionTrial && !row.repairTarget &&
            row.sourceDigest===digest && b.planForEntry(row)?.uri===uri);
        if (!entry) return;
        try {
            const run = b.state.run?.entry.id===entry.id ? b.state.run : await b.readRunView(entry);
            const compiled = compileCase(c.plan);
            let location = compiled.paths?.get(anchor.path) || anchor.path;
            const ref = compiled.layouts?.get(anchor.path);
            if (ref) {
                const snapshot = stepLocation(c.plan,anchor.path);
                const plan = snapshot?.list[snapshot.index]?.useCase?.plan;
                if (plan) {
                    const checks = anchor.side==="before" ? plan.preconditions : plan.goals;
                    const index = anchor.side==="before" ? 0 : (checks?.length || plan.steps.length)-1;
                    const group = checks?.length ? anchor.side==="before" ? "preconditions" : "goals" : "steps";
                    location = ref.map(group+"["+index+"]");
                }
            }
            const receipt = run.steps?.find(row=>row.path===location);
            const frame = anchor.side==="before" ? receipt?.before : receipt?.after;
            if (!frame) return;
            const observation = await b.reportAgent(entry).call("inspect",{run_id:entry.id,frame_id:frame,max_nodes:5000});
            if (observation.frameId===frame && Array.isArray(observation.nodes)) return cue(pageView(observation,{elements:true}));
        } catch { /* No archived screen for this insertion point. */ }
    }

    async explore(c, message) {
        if (this.job) return;
        const b = this.b, draft = this.draft, working = draft.explore ||= {};
        const description = draft.descriptionId && descriptionAt(c.plan,draft.anchor.path);
        const goal = description?.text || (typeof message.goal==="string" ? message.goal.trim().slice(0,1200) : "");
        if (!goal || !b.state.device) throw new Error(this.words("Select a phone and describe what to explore or verify.",
            "请选择手机并说明要探索或验证的内容。"));
        const replay = !description || message.start==="replay";
        const prefix = replay && replayPrefix(c.plan,draft.anchor);
        if (replay && !prefix) throw new Error(this.words("The script cannot reach this position. Choose a position after executable steps.",
            "脚本无法回放到这个位置，请选择已实现步骤之后的位置。"));
        const location = description && previewTitle(b.state.caseReview.bdd,draft.anchor.path,"before");
        const controller = this.job = new AbortController();
        const device=b.state.device;
        const progress = [];
        Object.assign(working,{working:true,mismatch:undefined,entryIssue:undefined,exitIssue:undefined,progress,
            result:undefined,check:undefined,verification:undefined,controls:undefined,problem:undefined});
        c.stepTargets = undefined;
        this.b.caseAuthoring.update();
        this.refresh();
        b.publish();
        const w=(en,zh)=>this.words(en,zh), signal=controller.signal;
        let from, ruleScope;
        try {
            const expected = replay ? undefined : await this.archivedAnchor(c,draft.anchor);
            if (prefix) await b.requireGestureRuntime?.(prefix);
            signal.throwIfAborted();
            if (prefix) ruleScope = await b.networks?.beginCaseRules?.(c.group,undefined,{prepare:hasRuleSteps(prefix,"enable")});
            const run = async()=>{
                let ask;
                const agent=b.agent;
                return runPhoneTask({agent,device,goal,signal,language:b.language,workbenchSession:b.sessionFor(device),
                    ...(description && {caseDescription:{before:location?.before,after:previewTitle(b.state.caseReview.bdd,draft.anchor.path,"after").after}}),
                    ask:async prompt=>{
                        ask ??= await b.modelAsk(signal);
                        return ask(prompt);
                    },
                    onEvent:({type,text})=>{
                        if (["step","answer"].includes(type) && text) {
                            progress.push(text);
                            this.refresh();
                            b.publish();
                        }
                    },
                    prepare:async session=>{
                        if (!prefix) return;
                        signal.throwIfAborted();
                        if (prefix.steps.length || prefix.preconditions?.length) {
                            progress.push(w("Replaying the script to the selected position.","正在回放到所选位置。"));
                            this.refresh();b.publish();
                        }
                        if (prefix.steps.length) {
                            const result=await runCasePlan(b,"run",{session,run_id:randomUUID(),plan:prefix,output:"full"},
                                {scope:ruleScope,signal});
                            if (result.status!=="completed") {
                                const failed=(result.steps || []).find(row=>!["completed","passed"].includes(row.status));
                                const detail=[failed?.path,failed?.error?.message || result.error?.message].filter(Boolean).join(" · ");
                                throw new Error([w("The replay did not reach this position.","脚本回放没有到达所选位置。"),detail].filter(Boolean).join(" "));
                            }
                        } else for (const check of prefix.preconditions || []) {
                            signal.throwIfAborted();
                            const result=await agent.call("wait",{session,target:check.selector,property:check.property||"text",
                                equals:check.equals,timeout_ms:check.timeoutMs || 3000});
                            if (result.assertion?.status!=="passed") throw new Error(w("The starting condition did not pass.","起始条件未通过。"));
                        }
                    },
                    acceptStart:observation=>{
                        from=cue(pageView(observation,{elements:true}));
                        if (!message.independent && samePage(from,expected)===false) {
                            working.mismatch={actual:from?.title || from?.route,expected:expected.title || expected.route};
                            return false;
                        }
                        return true;
                    },
                });
            };
            const outcome = await run();
            signal.throwIfAborted();
            if (outcome?.draft) {
                // The runtime chose and verified these checks. Keep their expected values in the draft.
                const steps=outcome.draft.steps;
                const plan={version:"1",steps:steps.map(({command,input})=>command==="wait" ? {
                    assert:{selector:input.target,property:input.property,equals:input.equals,timeoutMs:input.timeout_ms}
                } : {command,input})};
                const presentation=storePresentation(plan,new Map(plan.steps.map((step,index)=>{
                    const authored=steps[index];
                    return [step,{name:authored.name,evidence:stepEvidence({control:authored.label,...authored.evidence})}];
                })));
                working.result={plan,start:from,end:cue(outcome.screen && pageView(outcome.screen,{elements:true})),
                    presentation};
                if (!description && draft.destination!=="current") await this.checkEntry(c,working,replay);
            } else if (!working.mismatch && outcome?.status!=="blocked") working.problem=description ?
                w("No repeatable steps were captured for this description.","这次没有生成可以稳定回放的步骤。") :
                w("No new replayable steps were recorded. Edit the exploration goal and try again.",
                    "这次没有记录到可回放的新步骤。请调整探索目标后重试。");
        } catch (error) {
            if (signal.aborted) working.progress.push(w("Exploration stopped.","探索已停止。"));
            else working.problem=b.errorMessage?.(error) || error.message;
        } finally {
            working.working=false;
            try { await ruleScope?.close(); }
            finally {
                if (this.job===controller) this.job=undefined;
                this.refresh();
            }
        }
    }

    applyDescription(c,continueWithNext) {
        const draft = this.draft, result = draft.explore?.result;
        const previous = descriptionAt(c.plan,draft.anchor.path);
        if (previous?.id!==draft.descriptionId || !result?.plan.steps.length || draft.explore.entryIssue==="different") return;
        const {steps,display,version} = this.localSteps(result,c);
        const step = {description:{id:previous.id,text:previous.text,steps}};
        const staged = this.staged(c,draft.anchor,[step],{replace:draft.anchor.path,display,version});
        rememberInsertion(c,draft.anchor,staged,draft.startedReview);
        this.commit(c,staged);
        const next = continueWithNext && pendingDescriptions(c.plan)[0];
        if (next) return this.openDescription(c,next.path,descriptionAt(c.plan,next.path));
        return this.returnToCase(c);
    }

    insertFollowUp(c) {
        const draft=this.draft, work=draft.explore;
        if (draft.destination!=="current" || draft.method!=="ai" || draft.descriptionId || c.uri ||
            work?.working || !work?.result?.plan.steps.length || !replayPrefix(c.plan,draft.anchor)) return;
        const {steps,...options}=this.localSteps(work.result,c);
        const staged=this.staged(c,draft.anchor,steps,options);
        rememberInsertion(c,draft.anchor,staged,draft.startedReview);
        this.commit(c,staged);
        this.returnToCase(c);
    }

    reviewFollowUp(c) {
        const draft=this.draft, result=draft.explore?.result;
        if (draft.destination==="current" || draft.descriptionId || draft.method!=="ai" || !result?.plan.steps.length ||
            draft.explore.working || draft.explore.entryIssue==="different" || c.uri || !replayPrefix(c.plan,draft.anchor)) return;
        const prefix=authoredPrefix(c.plan,draft.anchor);
        const display=prefixPresentation(c,prefix);
        const steps=[...prefix.steps];
        // A source goal already reached at the checkpoint runs before the new actions.
        for (const check of prefix.goals || []) {
            const step={assert:check};
            steps.push(step);
            if (display.has(check)) display.set(step,display.get(check));
        }
        const follow=this.localSteps(result,c);
        for (const [step,info] of follow.display) display.set(step,info);
        // Only terminal assertions observed on this route become its final checks. A runnable case needs a step.
        const lastAction=follow.steps.findLastIndex(step=>!step.assert || Object.keys(step).length!==1);
        const boundary=Math.max(lastAction+1,steps.length ? 0 : 1);
        steps.push(...follow.steps.slice(0,boundary));
        const checks=follow.steps.slice(boundary);
        for (const step of checks) if (display.has(step)) display.set(step.assert,display.get(step));
        const plan={...prefix,steps,goals:checks.map(step=>step.assert)};
        if (follow.version==="2") plan.version="2";
        const b=this.b;
        const position=previewTitle(b.state.caseReview.bdd,draft.anchor.path,draft.anchor.side).before;
        const origin={parentCaseName:c.name,forkPosition:position || this.words("Case start","用例起点"),
            ...(c.edit && {parentCaseDigest:sourceDigest(c.edit.original),parentCaseId:b.state.activeCase?.portableId})};
        b.caseAuthoring.begin({source:"exploration",origin,group:c.group,plan,
            name:c.name.slice(0,50)+this.words(" - follow up"," - 补充分支"),
            returnDraft:draft.startedReview ? undefined : c},storePresentation(plan,display));
        b.caseAuthoring.candidate.previousTool="recordings";
        this.closeDraft(c.id);
    }

    async checkEntry(c, working, replayed=false) {
        const result=working.result;
        if (!result) return;
        working.checkedAnchor = this.draft.anchor;
        const expected=await this.archivedAnchor(c,this.draft.anchor);
        const matched=replayed ? true : samePage(result.start,expected);
        working.entryIssue=matched===false ? "different" : matched===undefined ? "unconfirmed" : undefined;
        working.exitIssue=Boolean(samePage(result.end,expected)===false);
    }

    async savedExploration(c, message) {
        const b=this.b;
        const report=await b.explorations.store.load(message.reportId);
        const result=explorationCandidate(report,message);
        if (!result?.plan?.steps?.length || hasEscape(result.plan) || result.group && !isDeepStrictEqual(c.group,result.group))
            throw new Error(this.words("The selected route is unavailable or uses a different rule group.","这条路径不可用，或使用了不同的规则组。"));
        const frame=async side=>{
            const ref=result.frames[side];
            if (!ref) return;
            try {
                const frozen=await b.explorations.reportAgent(report).call("inspect",{run_id:ref.runId,frame_id:ref.frame,max_nodes:5000});
                if (Array.isArray(frozen.nodes)) return cue(pageView(frozen,{elements:true}));
            } catch { /* Older reports can lack their saved frames. */ }
        };
        const [start,end]=await Promise.all([frame("start"),frame("goal")]);
        const evidence=new Map(Array.from(stepEntries(result.plan.steps),({path,step})=>
            [step,{evidence:stepEvidence(result.stepEvidence?.[path])}]));
        const working=this.draft.explore;
        working.result={plan:result.plan,start,end,presentation:storePresentation(result.plan,evidence)};
        await this.checkEntry(c,working);
    }

    async openExplorationSource(message) {
        const b=this.b, state=b.state, author=b.caseAuthoring;
        const onReport=()=>state.tool==="exploration" && state.exploration?.id===message.reportId &&
            !state.draft && !state.caseReview && !["ready","running","paused"].includes(state.exploration.status);
        if (!onReport()) return;
        const report=await b.explorations.store.load(message.reportId);
        const source=report.sourceCase;
        if (!source?.uri) return;
        await b.refreshCases();
        const matches=state.cases.filter(row=>source.id ? row.portableId===source.id : row.uri===source.uri);
        const item=matches.find(row=>row.uri===source.uri) || (matches.length===1 && matches[0]);
        if (!item) throw new Error(this.words("The source case could not be located in the library.","无法在用例库中定位本次探索的来源用例。"));
        if (!onReport()) return;
        if (message.action==="viewExplorationSource") {
            await b.openCase(item.uri);
            state.tool="recordings";
            return;
        }
        const uri=this.v.Uri.parse(item.uri);
        const doc=await this.v.workspace.openTextDocument(uri);
        const metadata=await readCaseMetadata(uri);
        const original=doc.getText();
        const changed=this.words("The source case changed. Run exploration again to apply this change.",
            "来源用例已变化，请基于当前版本重新探索后再采用更改。");
        if (!item.editable || source.id && source.id!==metadata?.id || sourceDigest(original)!==source.digest) throw new Error(changed);
        const authored=authoredDocument(readWorkflow(original),metadata);
        const preview=stageBranchDifference(report,message.branchId,{...authored,compositionStale:authored.stale},b.language);
        const accept=this.words("Add to case draft","加入用例草稿");
        const answer=await this.v.window.showInformationMessage(item.name,{modal:true,detail:preview.detail},accept);
        if (answer!==accept || !onReport()) return;
        if (doc.getText()!==original || source.id && (await readCaseMetadata(uri))?.id!==source.id) throw new Error(changed);
        await b.openCase(item.uri);
        const c=await author.stepDraft({uri:item.uri,digest:source.digest});
        if (!c) throw new Error(changed);
        try {
            const {anchor,staged,detail}=stageBranchDifference(report,message.branchId,c,b.language);
            if (detail!==preview.detail || anchor.path!==preview.anchor.path) throw new Error(changed);
            rememberInsertion(c,anchor,{...staged,notice:"applied"},true);
            this.commit(c,staged,false);
            state.tool="recordings";
        } catch (error) {
            author.cancel(true);
            throw error;
        }
    }

    async importReport(message) {
        const b=this.b, v=this.v;
        if (b.state.draft || b.state.caseReview) return;
        await b.refreshCases();
        const choices=b.state.cases.filter(item=>item.editable).map(item=>({label:item.name,detail:item.location,item}));
        const selected=await v.window.showQuickPick(choices,{title:this.words("Insert into a test case","加入现有用例"),matchOnDetail:true});
        if (!selected) return;
        await b.openCase(selected.item.uri);
        await this.show({action:"explore",method:"history",uri:selected.item.uri,digest:b.state.planDigest});
        const c=this.context();
        if (!c) return;
        await this.savedExploration(c,message);
        this.refresh();
    }

    async handle(message) {
        const b=this.b, v=this.v, action=message.action;
        if (action==="forkCase") return this.forkCase(message);
        if (action==="viewExplorationSource" || action==="reviewBranchDifference") return this.openExplorationSource(message);
        if (["open","reference","references","explore","section","generateDescription","reviseCase","reviseStep"].includes(action)) return this.show(message);
        if (action==="sourceUsages") {
            const source=(b.knownCases || b.state.cases).find(item=>item.uri===message.uri);
            await b.refreshCases();
            b.state.caseComposition={mode:"usages",viewId:randomUUID(),name:source?.name,usages:await this.usages(source?.portableId)};
            return;
        }
        if (action==="importReport") return this.importReport(message);
        if (action==="gotoUsage") {
            const draft=this.context();
            if (draft && (draft.added || draft.reordered || draft.presentationChanged || draft.name!==draft.originalName))
                throw new Error(this.words("Save or cancel the current edit before opening another case.","请先保存或取消当前编辑，再打开其他用例。"));
            if (draft) b.caseAuthoring.cancel(true);
            const source=b.state.cases.find(item=>item.uri===message.uri);
            if (!source) return;
            await b.openCase(source.uri);
            return this.show({action:"reference",path:message.path,uri:source.uri,digest:b.state.planDigest});
        }
        const c=this.context(), draft=this.draft;
        if (!c) {
            if (action==="close") b.state.caseComposition=undefined;
            return;
        }
        if (message.id!==c.id || message.revision!==c.revision || message.viewId && message.viewId!==draft.viewId) return;
        if (action!=="close" && draft.revision!==c.revision) throw new Error(this.words("The case changed. Choose the insertion position again.",
            "用例步骤已变化，请重新选择插入位置。"));
        if (draft.mode==="revision") return this.handleRevision(c,message);
        const row=draft.path && stepLocation(c.plan,draft.path);
        const ref=row?.list[row.index]?.useCase;
        if (draft.descriptionId && !["close","runExplore","addDescription","nextDescription"].includes(action)) return;
        switch (action) {
            case "close": return this.returnToCase(c);
            case "insert": case "copy":
                if (draft.mode==="pick") return this.doInsert(c,message);
                break;
            case "referenceMode": draft.mode="reference"; break;
            case "replace":
                if (ref) {
                    draft.anchor={path:draft.path,side:"before"};
                    draft.mode="pick";
                    draft.items=await this.loadSources(undefined,{fresh:true});
                }
                break;
            case "openSource": {
                const source=ref && this.sources.get(ref.caseId);
                if (source) await v.window.showTextDocument(v.Uri.parse(source.uri),{preview:false});
                break;
            }
            case "locateSource": {
                if (!ref) break;
                const [uri]=await v.window.showOpenDialog({canSelectMany:false,filters:{JSON:["json"]}}) || [];
                if (!uri) break;
                const metadata=await readCaseMetadata(uri);
                if (metadata?.id!==ref.caseId) throw new Error(this.words("This file belongs to another case. Use Replace reference to select it.",
                    "此文件属于另一个用例，请用「替换引用」选择。"));
                await b.caseLibrary.add(uri,{name:metadata.name,source:metadata.source});
                await this.loadSources([ref.caseId],{fresh:true});
                b.caseAuthoring.update();
                break;
            }
            case "usages":
                if (ref) draft.usages=await this.usages(ref.caseId);
                break;
            case "reviewUpdate":
                if (ref) {
                    await this.loadSources([ref.caseId],{fresh:true});
                    draft.mode="update";
                    draft.verification=undefined;
                }
                break;
            case "adopt": case "verifyUpdate": {
                if (!ref) break;
                const source=await this.readSource(this.sources.get(ref.caseId));
                const latest=this.checkedSource(c,source);
                if (message.digest!==latest.digest) throw new Error(this.words("Review the latest revision before adopting it.",
                    "来源版本已变化，请先重新查看差异。"));
                if (action==="verifyUpdate") await this.verifyUpdate(c,latest,message.runner);
                else {
                    this.commit(c,this.staged(c,null,[this.referenceStep(latest)],{replace:draft.path}));
                    draft.mode="reference";
                    draft.verification=undefined;
                }
                break;
            }
            case "detach": {
                if (!ref) break;
                const {steps,...local}=this.localSteps(ref,c);
                this.commit(c,this.staged(c,null,steps,{replace:draft.path,...local}));
                this.closeDraft(c.id);
                return;
            }
            case "sectionSave":
                if (draft.mode==="section" && !draft.notice && await b.caseAuthoring.saveSection(c,draft.path,message,draft.sectionPaths))
                    draft.notice=this.words("Saved in the case library.","已保存到用例库。");
                break;
            case "runExplore": if (draft.mode==="explore" && draft.method==="ai") await this.explore(c,message); break;
            case "insertFollowUp": if (draft.mode==="explore") return this.insertFollowUp(c); break;
            case "reviewFollowUp": if (draft.mode==="explore") return this.reviewFollowUp(c); break;
            case "addDescription": case "nextDescription":
                if (draft.descriptionId) return this.applyDescription(c,action==="nextDescription");
                break;
            case "savedExplore": if (draft.mode==="explore" && draft.method==="history") await this.savedExploration(c,message); break;
            case "setPosition":
                if ((draft.mode==="pick" && !draft.path || draft.mode==="explore" && draft.method==="history") &&
                    allRows(b.state.caseReview.bdd).some(row=>row.path===message.path)) {
                    draft.anchor={path:message.path,side:message.side==="before"?"before":"after"};
                    if (draft.mode==="explore") {
                        draft.explore.mismatch=undefined;
                        await this.checkEntry(c,draft.explore);
                    }
                }
                break;
            case "addExplore": {
                if (draft.mode!=="explore" || draft.method!=="history") break;
                const work=draft.explore, result=work?.result;
                if (!result || work.entryIssue==="different" || !result.plan.steps.length) break;
                const {steps,...local}=this.localSteps(result,c);
                this.commit(c,this.staged(c,draft.anchor,steps,local));
                return this.returnToCase(c);
            }
        }
        this.refresh();
    }
}

module.exports = {CaseCompositionEditor, atInsertion, authoredPrefix, replayPrefix, samePage};
