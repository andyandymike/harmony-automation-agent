"use strict";

const {createHash} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {maxSteps, stepEntries, restorePresentation, storePresentation, caseDescription, pendingCaseWork,rewritePlanExpressions} = require("./casePresentation");
const {deviceRecordingFormat} = require("./model");
const {validateRecording} = require("./deviceRecorder");

function signature(value) {
    return createHash("sha256").update(JSON.stringify(value, (_,item) =>
        item && typeof item==="object" && !Array.isArray(item) ?
            Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])) : item)).digest("hex");
}

function referencesFor(plan) {
    return Array.from(stepEntries(plan?.steps)).filter(({step})=>step.useCase);
}

function sourceIds(plan) {
    return [...new Set(referencesFor(plan).flatMap(({step})=>[step.useCase.caseId,...(step.useCase.dependencies || [])]))];
}

function compositionRecord(plan, compiled, presentation) {
    return {digest:signature(compiled),...(plan!==compiled && {plan}),presentation};
}

function readComposition(plan, records) {
    if (!Array.isArray(records)) return {};
    const match = records.find(record=>record?.digest===signature(plan));
    if (!match?.plan) return {presentation:match?.presentation, stale:!match};
    // A sidecar never supersedes executable steps. Check both the digest and the reconstruction.
    try {
        const compiled = compileCase(match.plan);
        if (isDeepStrictEqual(compiled.plan,plan)) return {...compiled, authored:match.plan,presentation:match.presentation};
    } catch { /* Keep the executable workflow readable when its authoring metadata is damaged. */ }
    return {stale:true};
}

function hasEscape(plan) {
    return Array.from(stepEntries(plan?.steps)).some(({step})=>Object.hasOwn(step,"stop") || Object.hasOwn(step,"yield"));
}

function appFor(plan) {
    const apps = new Set();
    function selector(target) {
        if (!target || typeof target!=="object") return;
        const app = target.bundleName || target.app;
        if (typeof app==="string" && app) apps.add(app);
        if (target.within) selector(target.within);
    }
    for (const check of [...(plan?.preconditions || []),...(plan?.goals || [])]) selector(check?.selector);
    for (const {step} of stepEntries(plan?.steps)) {
        if (step.command==="open" && typeof step.input?.app==="string") apps.add(step.input.app);
        selector(step.input?.target || step.assert?.selector || step.read?.selector);
        if (step.useCase?.app) apps.add(step.useCase.app);
    }
    return apps.size===1 ? apps.values().next().value : undefined;
}

function compositionType(plan) {
    if (plan?.format===deviceRecordingFormat && plan.version===1) return "coordinates";
    if (!plan?.format && ["1","2"].includes(plan?.version)) return "controls";
}

function hasGestures(plan) {
    return Array.from(stepEntries(plan?.steps)).some(({step})=>step.command==="deviceGesture");
}

function normalizeGesture(step) {
    const {kind,x,y,toX,toY,velocity,fingers,text} = step.input;
    const input = {kind};
    if (kind==="pinch") input.fingers = fingers.map(({x,y,toX,toY})=>({x,y,toX,toY}));
    else if (kind==="typeText") input.text = text;
    else if (!["home","back"].includes(kind)) {
        Object.assign(input,{x,y});
        if (["swipe","drag","fling","recents"].includes(kind)) Object.assign(input,{toX,toY,...(velocity!==undefined && {velocity})});
    }
    step.input = input;
    delete step.label;
}

function promoteRecording(plan) {
    const gestures = Array.from(stepEntries(plan.steps),({step})=>step).flatMap(step=>
        step.useCase?.plan.steps || (caseDescription(step) ? [] : [step])).filter(step=>!step.ruleGroup);
    if (gestures.length || !plan.steps.some(step=>step.ruleGroup)) validateRecording({...plan,steps:gestures});
    const duration = gestures.reduce((total,step)=>total+(step.delayMs || 0),0);
    plan.limits = {maxSteps:Math.min(500,Math.max(50,gestures.length+25)),maxActions:Math.min(100,Math.max(20,gestures.length+10)),
        timeoutMs:Math.min(600000,60000+duration+gestures.length*1000)};
    delete plan.format;
    plan.version = "1";
    for (const {step} of stepEntries(plan.steps)) if (step.command==="deviceGesture") normalizeGesture(step);
}

function stepLocation(plan, path) {
    const parts = /^steps\[\d+\](?:\.(?:then|else|repeat\.steps|description\.steps)\[\d+\])*$/u;
    if (typeof path !== "string" || path.length > 200 || !parts.test(path)) return;
    const keys = path.split(/[.\[\]]+/).filter(Boolean);
    const index = Number(keys.pop());
    const list = keys.reduce((item,key)=>item?.[key],plan);
    return {list,index};
}

function boundaryLocation(plan, path) {
    const condition = /^(preconditions|goals)\[(\d+)\]$/.exec(path || "");
    if (!condition) return;
    const [,field,position] = condition;
    const index = Number(position);
    const check = plan[field]?.[index];
    if (check) return {field,index,check};
}

function selectedStepLocations(plan, paths) {
    if (!Array.isArray(paths) || !paths.length) return;
    const selected = [...new Set(paths)];
    if (selected.some(path=>typeof path!=="string")) return;
    const locations = [];
    for (const path of selected) {
        const boundary = boundaryLocation(plan,path);
        const location = boundary ? {list:plan[boundary.field],index:boundary.index} : stepLocation(plan,path);
        const step = location?.list?.[location.index];
        if (!step) return;
        if (!selected.some(parent=>path.startsWith(parent+"."))) {
            locations.push({path,...location,step,boundary:Boolean(boundary)});
        }
    }
    return locations;
}

function sectionSelection(plan, paths) {
    const selected = selectedStepLocations(plan,paths);
    if (!selected?.length) return;
    const list = selected.find(row=>!row.boundary)?.list || plan.steps;
    if (!selected.every(row=>row.list===list || row.boundary && list===plan.steps)) return;
    const order = new Map([[plan.preconditions,0],[list,1],[plan.goals,2]]);
    return selected.sort((a,b)=>order.get(a.list)-order.get(b.list) || a.index-b.index);
}

function sectionRangePaths(plan,path) {
    const location=selectedStepLocations(plan,[path])?.[0];
    if (!location) return [];
    if (location.boundary || location.list===plan.steps)
        return ["preconditions","steps","goals"].flatMap(field=>(plan[field] || []).map((_,i)=>`${field}[${i}]`));
    const prefix=path.slice(0,path.lastIndexOf("["));
    return location.list.map((_,i)=>`${prefix}[${i}]`);
}

function insertionAnchor(plan, path) {
    if (path==="steps" && !plan.steps.length) return {};
    const location = stepLocation(plan,path);
    if (location?.list) return location.list[location.index];
    const boundary = boundaryLocation(plan,path);
    if (boundary) return {assert:boundary.check};
}

function asAssertionStep(assert,role,presentation) {
    const step={assert}, info=presentation.get(assert);
    if (role==="Given" || info) presentation.set(step,{...info,role:info?.role || role});
    return step;
}

function checkInsertionPosition(plan,{path,side}) {
    if (!plan.steps.length || plan.format===deviceRecordingFormat || !["before","after"].includes(side)) return;
    const boundary=boundaryLocation(plan,path);
    if (boundary) return {field:boundary.field,index:boundary.index+(side==="after" ? 1 : 0)};
    if (path==="steps[0]" && side==="before") return {field:"preconditions",index:plan.preconditions?.length || 0};
    if (path===`steps[${plan.steps.length-1}]` && side==="after") return {field:"goals",index:0};
}

function atInsertion(plan, {path,side}, presentation) {
    if (side!=="before" && side!=="after") return;
    if (path==="steps" && !plan.steps.length) return {list:plan.steps,index:0};
    const shift = side==="after" ? 1 : 0;
    const boundary = boundaryLocation(plan,path);
    if (!boundary) {
        const location = stepLocation(plan,path);
        if (location?.list?.[location.index]) return {list:location.list,index:location.index+shift};
        return;
    }
    const {field,index} = boundary;
    const cut = index+shift;
    const preceding = plan[field].slice(0,cut);
    const following = plan[field].slice(cut);
    const checkedStep = assert=>asAssertionStep(assert,field==="preconditions" ? "Given" : "Then",presentation);
    if (field==="preconditions") {
        plan.preconditions = preceding;
        plan.steps.unshift(...following.map(checkedStep));
        return {list:plan.steps,index:0};
    }
    plan.goals = following;
    plan.steps.push(...preceding.map(checkedStep));
    return {list:plan.steps,index:plan.steps.length};
}

function needsControlPlan(step) {
    const description = caseDescription(step);
    if (description) return Array.isArray(description.steps) && description.steps.some(needsControlPlan);
    return !step.ruleGroup && step.command!=="deviceGesture" && compositionType(step.useCase?.plan)!=="coordinates";
}

function stageInsertion(c, anchor, steps, {replace,display=new Map(),version,startCount=0,goalCount=0,positionedCheck=false}={}, w=(en)=>en) {
    const plan = structuredClone(c.plan), presentation = restorePresentation(plan,storePresentation(c.plan,c.presentation));
    const edge = positionedCheck && steps.length===1 && steps[0].assert && checkInsertionPosition(plan,anchor);
    if (edge) {
        const list=plan[edge.field] ||= [];
        list.splice(edge.index,0,steps[0].assert);
        const info=display.get(steps[0]);
        if (info) presentation.set(steps[0].assert,info);
        return {plan,presentation,compiled:compileCase(plan),insertedPath:`${edge.field}[${edge.index}]`};
    }
    const slot = replace ? stepLocation(plan,replace) : atInsertion(plan,anchor,presentation);
    if (!slot?.list) throw new Error(w("Choose an insertion position in this case.","请重新选择用例中的插入位置。"));
    const inserted = [...steps];
    if (plan.format===deviceRecordingFormat && inserted.some(needsControlPlan)) promoteRecording(plan);
    if (version==="2") plan.version="2";
    if (plan.format!==deviceRecordingFormat) for (const {step} of stepEntries(inserted)) {
        if (step.command==="deviceGesture") normalizeGesture(step);
    }
    const promoteCheck=step=>{
        const info=display.get(step);
        if (info) presentation.set(step.assert,info);
        return step.assert;
    };
    if (slot.list===plan.steps && slot.index===0 && !plan.preconditions?.length && startCount)
        plan.preconditions=inserted.splice(0,startCount).map(promoteCheck);
    if (slot.list===plan.steps && slot.index+(replace?1:0)===plan.steps.length && !plan.goals?.length && goalCount)
        plan.goals=inserted.splice(inserted.length-goalCount,goalCount).map(promoteCheck);
    slot.list.splice(slot.index,replace?1:0,...inserted);
    for (const [step,info] of display) presentation.set(step,info);
    const entries = Array.from(stepEntries(plan.steps));
    if (entries.length>maxSteps) throw new Error(w("Too many steps in this case.","用例步骤已达到上限。"));
    const compiled = compileCase(plan);
    const insertedPath = entries.find(({step})=>step===inserted[0])?.path;
    return {plan,presentation,compiled,insertedPath};
}

function rememberInsertion(c, anchor, {insertedPath,notice}, startedReview) {
    const {plan,presentation,added,compositionStale,presentationChanged,removedStep,group,groupChanged} = c;
    c.insertionUndo = {revision:c.revision+1,path:insertedPath,notice,anchor:anchor.path,startedReview,
        before:{plan,presentation,added,compositionStale,presentationChanged,removedStep,group,groupChanged}};
}

function validateSnapshot(ref, type) {
    const sourceType = compositionType(ref?.plan);
    if (!ref || typeof ref.caseId!=="string" || !ref.caseId || typeof ref.name!=="string" ||
        !sourceType || (type==="coordinates" && sourceType!==type) ||
        !Array.isArray(ref.plan.steps) || !ref.plan.steps.length ||
        Array.from(stepEntries(ref.plan.steps)).some(({step})=>step.useCase || caseDescription(step)) || hasEscape(ref.plan))
        throw new Error("A referenced case has no executable snapshot.");
    if (sourceType==="coordinates") validateRecording(ref.plan);
}

function remapPath(path, branch, offset, start, promotedStart, promotedGoals, size) {
    const boundary = /^(preconditions|goals)\[(\d+)\]$/.exec(path);
    if (boundary) {
        const index = Number(boundary[2]);
        if (boundary[1]==="preconditions") return promotedStart ? path : branch+"["+(offset+index)+"]";
        return promotedGoals ? path : branch+"["+(offset+start+size+index)+"]";
    }
    return path.replace(/^steps\[(\d+)\]/,(_,index)=>branch+"["+(offset+start+Number(index))+"]");
}

const bindingNames = plan=>new Set(Array.from(stepEntries(plan.steps),({step})=>step.read?.name).filter(Boolean));

function scopedSnapshot(source, used = new Set()) {
    const copy = structuredClone(source);
    if (copy.version!=="2") return copy;
    const scoped = new Map();
    let sequence=0;
    for (const {step} of stepEntries(copy.steps)) {
        if (!step.read?.name) continue;
        let name;
        do { name = "case_binding_" + (++sequence); } while (used.has(name));
        used.add(name);
        scoped.set(step.read.name,name);
        step.read.name = name;
    }
    return rewritePlanExpressions(copy,part=>part && typeof part==="object" &&
        Object.keys(part).length===1 && scoped.has(part.var) ? {var:scoped.get(part.var)} : part);
}

// Expand authoring rows into the steps accepted by the workflow's existing runner.
// Entry and exit checks sit at the exact point the surrounding case reaches them.
function compileCase(authored) {
    const entries = Array.from(stepEntries(authored?.steps));
    const pending = pendingCaseWork(authored);
    if (pending.length) return {plan:authored,pending};
    if (!entries.some(({step})=>step.useCase || caseDescription(step))) return {plan:authored};
    const type = compositionType(authored);
    if (!type) throw new Error("This workflow format does not support case composition.");
    const {steps, ...head} = authored;
    const plan = {...head};
    const paths = new Map(), layouts = new Map(), boundaries = new Map();
    const names = bindingNames(authored);
    let total = 0;

    function expand(list, authorPath, outputPath, depth, firstIndex=0) {
        if (depth>8) throw new Error("The composed workflow has reached its nesting limit.");
        const output = [];
        function append(from, steps) {
            output.push(...steps);
            if (depth===0 && steps.length) boundaries.set(from,output.length-1);
        }
        for (const [index, step] of list.entries()) {
            const from = authorPath+"["+index+"]";
            const offset = firstIndex+output.length;
            const to = outputPath+"["+offset+"]";
            const description = caseDescription(step);
            if (description) {
                append(from,expand(description.steps,from+".description.steps",outputPath,depth+1,offset));
                continue;
            }
            if (step.useCase) {
                const ref = step.useCase;
                validateSnapshot(ref,type);
                const copy = scopedSnapshot(ref.plan,names);
                if (type!=="coordinates" && copy.format===deviceRecordingFormat)
                    copy.steps.filter(step=>step.command==="deviceGesture").forEach(normalizeGesture);
                if (copy.version==="2") plan.version = "2";
                const first = authorPath==="steps" && index===0 && !plan.preconditions?.length && Boolean(copy.preconditions?.length);
                const last = authorPath==="steps" && index===list.length-1 && !plan.goals?.length && Boolean(copy.goals?.length);
                if (first) plan.preconditions = copy.preconditions;
                if (last) plan.goals = copy.goals;
                const start = first ? [] : (copy.preconditions || []).map(assert=>({assert}));
                const end = last ? [] : (copy.goals || []).map(assert=>({assert}));
                const nested = Array.from(stepEntries(copy.steps));
                if (nested.some(({path})=>depth+(path.match(/\.(?:then|else|repeat\.steps)\[/g)?.length || 0)>8))
                    throw new Error("The referenced workflow exceeds the nesting limit at this position.");
                layouts.set(from,{map:path=>remapPath(path,outputPath,offset,start.length,first,last,copy.steps.length)});
                append(from,[...start,...copy.steps,...end]);
                total += start.length+nested.length+end.length;
                continue;
            }
            const node = {...step};
            paths.set(from,to);
            if (step.if) {
                node.then = expand(step.then,from+".then",to+".then",depth+1);
                if (step.else) node.else = expand(step.else,from+".else",to+".else",depth+1);
            }
            if (step.repeat) node.repeat = {...step.repeat,steps:expand(step.repeat.steps,from+".repeat.steps",to+".repeat.steps",depth+1)};
            append(from,[node]);
            total++;
        }
        return output;
    }

    plan.steps = expand(steps,"steps","steps",0);
    if (total>maxSteps) throw new Error("The expanded case exceeds the workflow step limit.");
    if (type==="coordinates") validateRecording(plan);
    return {plan,paths,layouts,boundaries};
}

// Exploration can leave a top-level case row only after all of its expanded steps and exit checks.
function checkpointAfterRow(document, path) {
    if (document.boundaries) return document.boundaries.get(path);
    const match = /^steps\[(\d+)\]$/.exec(path);
    const index = match && Number(match[1]);
    return Number.isInteger(index) && document.plan?.steps?.[index] ? index : undefined;
}

function authoredDocument(file, metadata) {
    const composition = readComposition(file.plan,metadata?.composition);
    const plan = composition.authored || file.plan;
    const display = composition.authored ? composition.presentation : composition.presentation || metadata?.presentation;
    return {...composition,plan,execution:file.plan,display,presentation:restorePresentation(plan,display)};
}

function referenceStatus(ref, available) {
    const source = available?.get(ref.caseId);
    return {...ref,name:source?.name || ref.name,uri:source?.uri,status:!source ? "missing" :
        source.issue==="draft" ? "draft" : source.digest && source.digest!==ref.digest ? "update" : "current"};
}

module.exports = {signature,referencesFor,sourceIds,compositionRecord,readComposition,authoredDocument,compileCase,checkpointAfterRow,compositionType,appFor,hasEscape,checkInsertionPosition,
    stepLocation,selectedStepLocations,sectionSelection,sectionRangePaths,insertionAnchor,atInsertion,asAssertionStep,stageInsertion,rememberInsertion,hasGestures,promoteRecording,
    referenceStatus,bindingNames,scopedSnapshot};
