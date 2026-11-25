"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {stepEntries} = require("./casePresentation");
const {validateScenario,ruleGroupName} = require("./network");

function hasRuleSteps(plan,action) {
    for (const {step} of stepEntries(plan?.steps)) {
        if (Object.hasOwn(step,"ruleGroup") && (!action || step.ruleGroup?.action===action)) return true;
    }
    return false;
}

function validateRuleStep(step) {
    const effect = step.ruleGroup;
    if (Object.keys(step).length===1 && effect && typeof effect==="object" && !Array.isArray(effect)) {
        const fields = Object.keys(effect).length;
        if (effect.action==="disable" && (fields===1 || fields===2 && typeof effect.name==="string"))
            return effect;
        if (effect.action==="enable" && fields===2 && Object.hasOwn(effect,"scenario"))
            return {action:"enable",scenario:{...validateScenario(effect.scenario),paused:false}};
    }
    throw new Error("Invalid rule group step / 规则组步骤无效");
}

function validateRuleSteps(plan) {
    for (const {step} of stepEntries(plan?.steps)) if (Object.hasOwn(step,"ruleGroup")) validateRuleStep(step);
}

const startingRulePath = "rule-group";

function joinRuleStates(left,right) {
    if (!left || !right) return left || right;
    const possible = new Map(left.possible);
    for (const [name,origins] of right.possible) {
        const existing = possible.get(name);
        possible.set(name,existing ? new Set([...existing,...origins]) : origins);
    }
    return {active:new Set([...left.active].filter(name=>right.active.has(name))),possible};
}

function sameRuleStates(left,right) {
    // A join can only discard definite activations and add possible origins.
    return left.active.size===right.active.size && left.possible.size===right.possible.size &&
        [...left.possible].every(([name,origins])=>origins.size===right.possible.get(name).size);
}

function changeRuleState(state,effect,location) {
    if (effect.action==="enable") {
        const name = ruleGroupName(effect.scenario);
        if (state.active.has(name)) return state;
        const possible = new Map(state.possible);
        possible.set(name,new Set([...(possible.get(name) || []),location]));
        return {active:new Set([...state.active,name]),possible};
    }
    if (typeof effect.name!=="string")
        return {active:new Set(),possible:state.possible.size<=1 ? new Map() : state.possible};
    const possible = new Map(state.possible);
    possible.delete(effect.name);
    return {active:new Set([...state.active].filter(name=>name!==effect.name)),possible};
}

function ruleGroupsByPosition(plan,initial) {
    const starting = initial && !initial.paused ? [ruleGroupName(initial)] : [];
    const entry = {active:new Set(starting),possible:new Map(starting.map(name=>[name,new Set([startingRulePath])]))};
    const positions = new Map();

    function walk(steps,prefix,state,record,depth=0) {
        if (!Array.isArray(steps) || depth>8) return state;
        for (const [index,step] of steps.entries()) {
            if (!state) break;
            const location = prefix+"["+index+"]";
            const before = state;
            if (step?.ruleGroup) state = changeRuleState(state,step.ruleGroup,location);
            else if (step?.if) state = joinRuleStates(
                walk(step.then,location+".then",before,record,depth+1),
                walk(step.else,location+".else",before,record,depth+1));
            else if (step?.repeat) {
                const body = location+".repeat.steps";
                const limit = Number.isInteger(step.repeat.limit) ? Math.max(1,Math.min(100,step.repeat.limit)) : 1;
                let bodyEntry = before;
                for (let iteration=1; iteration<=limit; iteration++) {
                    state = joinRuleStates(bodyEntry,walk(step.repeat.steps,body,bodyEntry,false,depth+1));
                    if (iteration===limit || sameRuleStates(bodyEntry,state)) break;
                    bodyEntry = state;
                }
                if (record) walk(step.repeat.steps,body,bodyEntry,true,depth+1);
            } else if (step?.useCase) state = walk(step.useCase.plan?.steps,location+".linked.steps",before,record,depth+1);
            else if (step?.description?.steps) state = walk(step.description.steps,location+".description.steps",before,record,depth+1);
            else if (Object.hasOwn(step || {},"yield") || Object.hasOwn(step || {},"stop")) state = undefined;
            if (record) positions.set(location,{before,after:state,
                enabledGroup:step?.ruleGroup?.action==="enable" ? ruleGroupName(step.ruleGroup.scenario) : undefined});
        }
        return state;
    }

    positions.set("steps",{before:entry,after:entry});
    const exit = walk(plan?.steps,"steps",entry,true);
    for (const [field,state] of [["preconditions",entry],["goals",exit]]) {
        if (!Array.isArray(plan?.[field])) continue;
        for (const [index] of plan[field].entries()) positions.set(field+"["+index+"]",{before:state,after:state});
    }
    return positions;
}

function overlapsPreviousRuleEnable(state,name,location) {
    const origins = state?.possible.get(name);
    return Boolean(origins?.size && (origins.size>1 || !origins.has(location)));
}

function ruleEnableConflict(plan,initial,location,name) {
    const positions = ruleGroupsByPosition(plan,initial);
    const origin = location || startingRulePath;
    const before = positions.get(origin)?.before;
    if (overlapsPreviousRuleEnable(before,name,origin)) return before.active.has(name) ? "active" : "possible";
    for (const [elsewhere,{enabledGroup,before}] of positions)
        if (elsewhere!==origin && enabledGroup===name && before?.possible.get(name)?.has(origin)) return "later";
}

function planWithRuleCheckpoints(plan) {
    if (!hasRuleSteps(plan)) return {plan,switches:new Map()};
    const runtime = structuredClone(plan);
    const ruleSteps = [...stepEntries(runtime.steps)].filter(({step})=>Object.hasOwn(step,"ruleGroup"));
    const switches = new Map(ruleSteps.map(({step,path})=>[path,validateRuleStep(step)]));
    for (const {step} of ruleSteps) {
        // The worker switches the gateway at step_started, before collecting a frame for the receipt.
        delete step.ruleGroup;
        Object.assign(step,{command:"observe",input:{max_nodes:1,compact:true}});
    }
    return {plan:runtime,switches};
}

function savedPlanPath(stateDir,id) {
    return path.join(stateDir,"runs",id,"workbench-plan.json");
}

async function saveRulePlanForRun(stateDir,id,plan) {
    if (!hasRuleSteps(plan)) return;
    const target = savedPlanPath(stateDir,id);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,JSON.stringify(plan),{flag:"wx",mode:0o600});
}

async function rulePlanForRun(stateDir,id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
    try { return JSON.parse(await fs.readFile(savedPlanPath(stateDir,id),"utf8")); }
    catch (error) { if (error.code!=="ENOENT" && error.code!=="ENOTDIR") throw error; }
}

module.exports = {hasRuleSteps,validateRuleStep,validateRuleSteps,ruleGroupsByPosition,overlapsPreviousRuleEnable,ruleEnableConflict,
    planWithRuleCheckpoints,saveRulePlanForRun,rulePlanForRun};
