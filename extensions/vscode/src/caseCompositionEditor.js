"use strict";

const {randomUUID} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {readWorkflow, workflowWithScenario} = require("./workflowFile");
const {readCaseMetadata, createBdd} = require("./caseLibrary");
const {stepLocation} = require("./caseAuthoring");
const {maxSteps, stepEntries, restorePresentation, storePresentation, stepEvidence, pageCue} = require("./casePresentation");
const {signature, sourceIds, referencesFor, appFor, hasEscape, authoredDocument, compileCase, referenceStatus,
    bindingNames, scopedSnapshot} = require("./caseComposition");
const {sourceDigest} = require("./caseRepair");
const {readiness} = require("./pytestCase");
const {runPhoneTask} = require("./aiTasks");
const {explorationCandidate} = require("./explorationCases");
const {pageView, deviceRecordingFormat} = require("./model");
const {observationsForStep} = require("./caseLocators");
const {selectNodes} = require("../media/elementsLocator");

function atInsertion(plan, anchor, presentation) {
    const {path,side} = anchor;
    const shift = side==="after" ? 1 : 0;
    const condition = /^(preconditions|goals)\[(\d+)\]$/.exec(path || "");
    if (!condition) {
        const location = stepLocation(plan,path);
        if (!location?.list?.[location.index]) return;
        return {list:location.list,index:location.index+shift};
    }
    const [,field,index] = condition;
    if (!plan[field]?.[Number(index)]) return;
    const cut = Number(index)+shift;
    const preceding = plan[field].slice(0,cut);
    const following = plan[field].slice(cut);
    if (field==="preconditions") {
        plan.preconditions = preceding;
        const checks = following.map(assert=>({assert}));
        checks.forEach(step=>presentation.set(step,{role:"Given"}));
        plan.steps.unshift(...checks);
        return {list:plan.steps,index:0};
    }
    plan.goals = following;
    plan.steps.push(...preceding.map(assert=>({assert})));
    return {list:plan.steps,index:plan.steps.length};
}

function replayPrefix(plan, anchor) {
    const match = /^(steps|preconditions|goals)\[(\d+)\]$/.exec(anchor.path || "");
    if (!match) return;
    const [,field,index] = match;
    const count = Number(index)+(anchor.side==="after"?1:0);
    const prefix = {...plan,steps:field==="preconditions" ? [] : field==="steps" ? plan.steps.slice(0,count) : plan.steps,
        preconditions:field==="preconditions" ? plan.preconditions?.slice(0,count) : plan.preconditions,
        goals:field==="goals" ? plan.goals?.slice(0,count) : []};
    if (hasEscape(prefix)) return;
    return compileCase(prefix).plan;
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

function previewTitle(bdd, path, side) {
    function locate(rows, scope) {
        const index=rows.findIndex(row=>row.path===path);
        if (index>=0) {
            const before=rows[index+(side==="after"?0:-1)], after=rows[index+(side==="after"?1:0)];
            return {scope,before:before?.name || before?.text,after:after?.name || after?.text};
        }
        for (const row of rows) for (const branch of row.branches || []) {
            if (branch.readOnly) continue;
            const result=locate(branch.steps,[row.name || row.text,branch.label].filter(Boolean).join(" · "));
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
            const issue = authored.stale ? "layout" : !plan?.steps?.length || !["1","2"].includes(plan.version) || plan.format ||
                hasEscape(plan) ? "workflow" : undefined;
            return {...item,name:metadata.name,caseId:metadata.id,app:appFor(authored.plan),issue,group,plan,
                dependencies:sourceIds(authored.plan),presentation:flattenSnapshotPresentation(authored),
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
        const parent = this.b.state.activeCase;
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
        const bdd = this.b.state.caseReview?.bdd;
        const row = draft.path && stepLocation(c.plan,draft.path);
        const step = row?.list?.[row.index];
        const ref = step?.useCase && referenceStatus(step.useCase,this.sources);
        const latest = ref && this.sources.get(ref.caseId);
        const working = draft.explore;
        const outcome = working?.result;
        const mode = draft.mode;
        const proposed = mode==="explore" && outcome && createBdd({...outcome.plan,
            steps:[...outcome.plan.steps,...(working.check ? [{assert:working.check}] : [])]},
            this.b.language,undefined,restorePresentation(outcome.plan,outcome.presentation));
        this.b.state.caseComposition = {
            mode, anchor:draft.anchor, location:draft.anchor && previewTitle(bdd,draft.anchor.path,draft.anchor.side),
            ...(mode==="pick" && {items:draft.items?.map(item=>this.publicSource(c,item)),replace:Boolean(draft.path),app:appFor(c.plan)}),
            ...(mode==="references" && {references:referencesFor(c.plan).map(({path,step})=>{
                const ref = referenceStatus(step.useCase,this.sources);
                return {path,caseId:ref.caseId,name:ref.name,status:ref.status,digest:ref.digest.slice(0,8),
                    ...previewTitle(bdd,path,"before")};
            })}),
            ...(ref && {reference:{name:ref.name,status:ref.status,path:draft.path,uri:ref.uri,version:ref.digest.slice(0,8),bound:ref.plan.version==="2"},
                latest:latest && this.publicSource(c,latest),diff:mode==="update" && latest && changePreview(ref,latest,this.b.language)}),
            ...(mode==="section" && {range:row && row.list.slice(row.index).map((step,index)=>({
                path:draft.path.replace(/\[\d+\]$/,"["+(row.index+index)+"]"),
                title:allRows(bdd).find(item=>item.path===draft.path.replace(/\[\d+\]$/,"["+(row.index+index)+"]"))?.text || String(row.index+index+1)
            }))}),
            ...(mode==="explore" && {canReplay:Boolean(replayPrefix(c.plan,draft.anchor)),working:working?.working,progress:working?.progress,
                mismatch:working?.mismatch,matching:working?.matching,entryIssue:working?.entryIssue,exitIssue:working?.exitIssue,
                controls:working?.controls?.map(({key,label,detail,property,current,protectedValue})=>({key,label,detail,property,current,protectedValue})),
                verification:working?.verification, result:outcome && {steps:previewSteps(proposed),
                    from:outcome.start?.title || outcome.start?.route,to:outcome.end?.title || outcome.end?.route,
                    checkOnly:!outcome.plan.steps.length,bound:outcome.plan.version==="2"},
                history:this.b.state.explorationHistory || []}),
            usages:draft.usages,notice:draft.notice,...(mode==="update" && {verification:draft.verification}),stale:draft.revision!==c.revision,
        };
    }

    async begin(message) {
        const c = await this.b.caseAuthoring.stepDraft(message);
        if (!c || c.plan.format===deviceRecordingFormat) return;
        if (this.draft?.id!==c.id) this.draft={id:c.id};
        this.draft.revision=c.revision;
        return c;
    }

    async show(message) {
        const c = await this.begin(message);
        if (!c) return;
        const draft = this.draft;
        const mode = message.action;
        draft.path = ["reference","section"].includes(mode) ? message.path : undefined;
        draft.mode = mode==="open" ? "pick" : mode;
        draft.usages = draft.verification = draft.notice = undefined;
        if (mode==="open") draft.anchor = {path:message.path,side:message.side==="before"?"before":"after"};
        if (mode==="explore") {
            draft.anchor = {path:message.path,side:message.side==="before"?"before":"after"};
            draft.explore = {};
        }
        if (["open","reference","references"].includes(mode)) {
            draft.items = await this.loadSources(mode==="open"?undefined:sourceIds(c.plan),{fresh:true});
            this.b.caseAuthoring.update();
        } else if (mode==="explore") await this.b.explorations.history();
        this.refresh();
    }

    staged(c, anchor, steps, {replace,display=new Map(),version,startCount=0,goalCount=0}={}) {
        const plan = structuredClone(c.plan), presentation = restorePresentation(plan,storePresentation(c.plan,c.presentation));
        const slot = replace ? stepLocation(plan,replace) : atInsertion(plan,anchor,presentation);
        if (!slot?.list) throw new Error(this.words("Choose an insertion position in this case.","请重新选择用例中的插入位置。"));
        const inserted=[...steps];
        if (version==="2") plan.version="2";
        if (slot.list===plan.steps && slot.index===0 && !plan.preconditions?.length && startCount)
            plan.preconditions=inserted.splice(0,startCount).map(step=>step.assert);
        if (slot.list===plan.steps && slot.index+(replace?1:0)===plan.steps.length && !plan.goals?.length && goalCount)
            plan.goals=inserted.splice(inserted.length-goalCount,goalCount).map(step=>step.assert);
        slot.list.splice(slot.index,replace?1:0,...inserted);
        for (const [step,info] of display) presentation.set(step,info);
        if (Array.from(stepEntries(plan.steps)).length>maxSteps) throw new Error(this.words("Too many steps in this case.","用例步骤已达到上限。"));
        const compiled = compileCase(plan);
        return {plan,presentation,compiled};
    }

    commit(c, staged) {
        c.plan = staged.plan;
        c.presentation = staged.presentation;
        c.added = true;
        c.compositionStale = false;
        c.stepTargets = c.removedStep = undefined;
        c.revision++;
        this.draft.revision=c.revision;
        this.b.caseAuthoring.update();
    }

    referenceStep(source) {
        return {useCase:{caseId:source.caseId,name:source.name,digest:source.digest,plan:source.plan,
            presentation:source.presentation,dependencies:source.dependencies,app:source.app}};
    }

    localSteps(ref,c) {
        const {preconditions,steps,goals,version} = scopedSnapshot(ref.plan,bindingNames(c.plan));
        const checks = (preconditions || []).map(assert=>({assert}));
        const original = restorePresentation(ref.plan,ref.presentation);
        const originalSteps = Array.from(stepEntries(ref.plan.steps),({step})=>step);
        const display = new Map(Array.from(stepEntries(steps),({step},index)=>[step,original.get(originalSteps[index])]).filter(([,item])=>item));
        for (const step of checks) display.set(step,{role:"Given"});
        return {steps:[...checks,...steps,...(goals || []).map(assert=>({assert}))],display,version,
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
        const entry = await this.b.verifyCompositionCopy(contents,bdd,runner);
        const block = staged.compiled.layouts.get(this.draft.path);
        const prefix = block?.map("steps[0]");
        const reachable = prefix && this.b.state.run?.steps?.some(step=>
            step.path?.replace(/\.repeat\.iteration\[\d+\]/g,".repeat.steps")===prefix &&
                ["completed","passed"].includes(step.status));
        this.draft.verification = {status:entry?.status==="passed" && !reachable ? "notReached" : entry?.status || "unknown",
            run:entry?.id,digest:latest.digest};
    }

    async archivedAnchor(c, anchor) {
        if (!c.edit || c.added || c.reordered) return;
        const b = this.b, digest = sourceDigest(c.edit.original);
        const uri = c.edit.uri.toString();
        const entry = b.state.runs.find(row=>row.status==="passed" && !row.compositionTrial &&
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

    async readScreen(c, pick=false) {
        const b = this.b, device = b.state.device, revision=c.revision;
        if (!device || !b.state.devices.includes(device)) throw new Error(b.text.selectDevice);
        const current=()=>this.context()===c && c.revision===revision && b.state.device===device;
        let page, picture;
        const read=async()=>{
            await b.observe(current,true);
            if (!current()) return;
            page = b.state.page;
            if (!pick || !page) return;
            const capture=await b.agent.call("screenshot",{session:b.session});
            if (!current()) return;
            const src=b.image(capture.path);
            if (src) picture={id:randomUUID(),src,device};
        };
        if (b.livePanel) await b.livePanel.withDeviceOperation(read);
        else await read();
        if (!page?.nodes) throw new Error(this.words("The device screen could not be read.","无法读取手机当前页面。"));
        return {page,picture,device};
    }

    async scan(c, pick) {
        const result = await this.readScreen(c,pick), {page,picture,device}=result;
        const working = this.draft.explore ||= {};
        const choices = observationsForStep(undefined,[{nodes:page.nodes,source:"live",complete:page.complete}],appFor(c.plan)).choices
            .filter(choice=>selectNodes(page.nodes,choice.selector).length===1).slice(0,180);
        working.controls = choices.map((choice,index)=>{
            const node = selectNodes(page.nodes,choice.selector)[0];
            const protectedValue = Boolean(node.editable || protectedControl.test(JSON.stringify(choice.selector)));
            return {...choice,key:String(index),protectedValue,property:node.text && !protectedValue?"text":"visible",
                current:protectedValue ? undefined : node.text || undefined};
        });
        working.targetDevice=device;
        working.screen=cue(page);
        if (!working.result || !working.result.plan.steps.length) {
            working.result={plan:{version:"1",steps:[]},start:working.screen,end:working.screen};
            working.check=working.verification=undefined;
            await this.checkEntry(c,working);
        }
        c.stepTargets = picture && {area:"composeCheck",path:this.draft.anchor.path,device,picture,choices};
        this.b.caseAuthoring.update();
    }

    async verifyCheck(c, message) {
        const working = this.draft.explore;
        const choice = working?.controls?.find(row=>row.key===message.key);
        const property = message.property;
        const boolean = ["visible","enabled","checked","selected","focused"].includes(property);
        if (!choice || working.targetDevice!==this.b.state.device || (!boolean && property!=="text") ||
            typeof message.expected!=="string" || message.expected.length>20000 || (boolean && !["true","false"].includes(message.expected))) return;
        const check = {selector:choice.selector,property,equals:boolean?message.expected==="true":message.expected};
        const {page}=await this.readScreen(c);
        const found=selectNodes(page.nodes,check.selector);
        const field = found.length===1 ? found[0].attributes?.[property] : undefined;
        const value = field ?? (page.complete && !found.length && property==="visible" ? false : undefined);
        working.verification = {status:value===undefined?"unknown":value===check.equals?"passed":"failed",
            actual:choice.protectedValue && property==="text"?undefined:value,key:choice.key,
            property,expected:choice.protectedValue && property==="text" ? undefined : message.expected};
        working.verification.device=working.targetDevice;
        working.check = check;
        c.stepTargets = undefined;
        this.b.caseAuthoring.update();
    }

    async explore(c, message) {
        const b = this.b, draft = this.draft, working = draft.explore ||= {};
        const goal = typeof message.goal==="string" ? message.goal.trim().slice(0,1200) : "";
        if (!goal || !b.state.device) throw new Error(this.words("Select a phone and describe what to explore or verify.",
            "请选择手机并说明要探索或验证的内容。"));
        const replay = message.start==="replay";
        const prefix = replay && replayPrefix(c.plan,draft.anchor);
        if (replay && !prefix) throw new Error(this.words("Use the current phone screen for this position.","请从手机当前页在此位置继续。"));
        const expected = replay ? undefined : await this.archivedAnchor(c,draft.anchor);
        const controller = this.job = new AbortController();
        const progress = [];
        Object.assign(working,{working:true,mismatch:undefined,entryIssue:undefined,exitIssue:undefined,progress,
            result:undefined,check:undefined,verification:undefined,controls:undefined});
        c.stepTargets = undefined;
        this.b.caseAuthoring.update();
        this.refresh();
        b.publish();
        const w=(en,zh)=>this.words(en,zh), signal=controller.signal;
        let from;
        try {
            const run = async()=>{
                let ask;
                const agent=b.agent, device=b.state.device;
                return runPhoneTask({agent,device,goal,signal,language:b.language,workbenchSession:b.sessionFor(device),
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
                        if (c.group) await b.prepareFlowScenario(undefined,c.group);
                        signal.throwIfAborted();
                        if (prefix.steps.length) {
                            const result=await agent.call("run",{session,run_id:randomUUID(),plan:prefix,output:"full"});
                            if (result.status!=="completed") throw new Error(w("The replay did not reach this position.","回放没有到达选中的插入位置。"));
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
                await this.checkEntry(c,working,replay);
            }
        } catch (error) {
            if (!signal.aborted) throw error;
            working.progress.push(w("Exploration stopped.","探索已停止。"));
        } finally {
            this.job=undefined;
            working.working=false;
            this.refresh();
        }
    }

    async checkEntry(c, working, replayed=false) {
        const result=working.result;
        if (!result?.start) return;
        const expected=await this.archivedAnchor(c,this.draft.anchor);
        const matched=replayed ? true : samePage(result.start,expected);
        working.entryIssue=matched===false ? "different" : matched===undefined ? "unconfirmed" : undefined;
        working.exitIssue=Boolean(samePage(result.end,expected)===false);
        working.matching=matched===false ? allRows(this.b.state.caseReview?.bdd).filter(row=>row.area!=="setup")
            .slice(0,200).map(row=>({path:row.path,name:row.name || row.text})) : undefined;
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
        const working=this.draft.explore={result:{plan:result.plan,start,end,presentation:storePresentation(result.plan,evidence)}};
        await this.checkEntry(c,working);
    }

    async importReport(message) {
        const b=this.b, v=this.v;
        if (b.state.draft || b.state.caseReview) return;
        await b.refreshCases();
        const choices=b.state.cases.filter(item=>item.editable).map(item=>({label:item.name,detail:item.location,item}));
        const selected=await v.window.showQuickPick(choices,{title:this.words("Insert into a test case","加入现有用例"),matchOnDetail:true});
        if (!selected) return;
        await b.openCase(selected.item.uri);
        const path=allRows(b.state.caseBdd).filter(row=>row.area==="step").at(-1)?.path;
        if (!path) return;
        await this.show({action:"explore",path,side:"after",uri:selected.item.uri,digest:b.state.planDigest});
        const c=this.context();
        if (!c) return;
        await this.savedExploration(c,message);
        this.draft.explore.matching=allRows(b.state.caseReview.bdd).filter(row=>row.area!=="setup").map(row=>({path:row.path,name:row.name||row.text}));
        this.refresh();
    }

    async handle(message) {
        const b=this.b, v=this.v, action=message.action;
        if (["open","reference","references","explore","section"].includes(action)) return this.show(message);
        if (action==="sourceUsages") {
            const source=(b.knownCases || b.state.cases).find(item=>item.uri===message.uri);
            await b.refreshCases();
            b.state.caseComposition={mode:"usages",name:source?.name,usages:await this.usages(source?.portableId)};
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
        if (message.id!==c.id || message.revision!==c.revision) return;
        if (action!=="close" && draft.revision!==c.revision) throw new Error(this.words("The case changed. Choose the insertion position again.",
            "用例步骤已变化，请重新选择插入位置。"));
        const row=draft.path && stepLocation(c.plan,draft.path);
        const ref=row?.list[row.index]?.useCase;
        switch (action) {
            case "close":
                c.stepTargets=undefined;
                this.closeDraft(c.id);
                b.caseAuthoring.update();
                return;
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
                if (draft.mode==="section" && row && await b.caseAuthoring.saveSection(c,row,message))
                    draft.notice=this.words("Saved in the case library.","已保存到用例库。");
                break;
            case "exploreMode":
                draft.mode="explore";
                draft.explore ||= {};
                await b.explorations.history();
                break;
            case "runExplore": if (draft.mode==="explore") await this.explore(c,message); break;
            case "scanCheck": if (draft.mode==="explore") await this.scan(c,message.pick===true); break;
            case "verifyCheck": if (draft.mode==="explore") await this.verifyCheck(c,message); break;
            case "savedExplore": if (draft.mode==="explore") await this.savedExploration(c,message); break;
            case "moveExplore":
                if (draft.mode==="explore" && draft.explore?.result && allRows(b.state.caseReview.bdd).some(row=>row.path===message.path)) {
                    draft.anchor={path:message.path,side:message.side==="before"?"before":"after"};
                    await this.checkEntry(c,draft.explore);
                }
                break;
            case "addExplore": {
                const work=draft.explore, result=work?.result;
                if (!result || work.entryIssue==="different" || !result.plan.steps.length && !work.check) break;
                if (work.check && (work.verification.device!==b.state.device || work.verification.key!==message.key ||
                    work.check.property!==message.property || String(work.check.equals)!==message.expected))
                    throw new Error(this.words("Verify the current check before adding it.","请验证当前检查后再加入用例。"));
                const {steps,...local}=this.localSteps(result,c);
                if (work.check) steps.push({assert:work.check});
                if (work.check) local.goalCount++;
                this.commit(c,this.staged(c,draft.anchor,steps,local));
                this.closeDraft(c.id);
                return;
            }
        }
        this.refresh();
    }
}

module.exports = {CaseCompositionEditor, atInsertion, replayPrefix, samePage};
