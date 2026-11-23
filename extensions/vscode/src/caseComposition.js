"use strict";

const {createHash} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {maxSteps, stepEntries, restorePresentation} = require("./casePresentation");
const {deviceRecordingFormat} = require("./model");

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
    return {digest:signature(compiled),...(referencesFor(plan).length && {plan}),presentation};
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

function validateSnapshot(ref) {
    if (!ref || typeof ref.caseId!=="string" || !ref.caseId || typeof ref.name!=="string" ||
        !ref.plan || !["1","2"].includes(ref.plan.version) || ref.plan.format===deviceRecordingFormat ||
        !Array.isArray(ref.plan.steps) || !ref.plan.steps.length || referencesFor(ref.plan).length || hasEscape(ref.plan))
        throw new Error("A referenced case has no executable snapshot.");
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
    return JSON.parse(JSON.stringify(copy,(_,part)=>part && typeof part==="object" &&
        Object.keys(part).length===1 && scoped.has(part.var) ? {var:scoped.get(part.var)} : part));
}

// Inline into ordinary Harmony workflow steps for the CLI and standalone pytest.
// Entry and exit checks sit at the exact point the surrounding case reaches them.
function compileCase(authored) {
    const linked = referencesFor(authored);
    if (!linked.length) return {plan:authored};
    if (authored.format || !["1","2"].includes(authored.version)) throw new Error("A control-based case is required.");
    const {steps, ...head} = authored;
    const plan = {...head};
    const paths = new Map(), layouts = new Map();
    const names = bindingNames(authored);
    let total = 0;

    function expand(list, authorPath, outputPath, depth) {
        if (depth>8) throw new Error("The composed workflow has reached its nesting limit.");
        const output = [];
        for (const [index, step] of list.entries()) {
            const from = authorPath+"["+index+"]";
            const to = outputPath+"["+output.length+"]";
            if (step.useCase) {
                const ref = step.useCase;
                validateSnapshot(ref);
                const copy = scopedSnapshot(ref.plan,names);
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
                const offset = output.length;
                layouts.set(from,{map:path=>remapPath(path,outputPath,offset,start.length,first,last,copy.steps.length)});
                output.push(...start,...copy.steps,...end);
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
            output.push(node);
            total++;
        }
        return output;
    }

    plan.steps = expand(steps,"steps","steps",0);
    if (total>maxSteps) throw new Error("The expanded case exceeds the workflow step limit.");
    return {plan,paths,layouts};
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
        source.digest && source.digest!==ref.digest ? "update" : "current"};
}

module.exports = {signature,referencesFor,sourceIds,compositionRecord,readComposition,authoredDocument,compileCase,appFor,hasEscape,
    referenceStatus,bindingNames,scopedSnapshot};
