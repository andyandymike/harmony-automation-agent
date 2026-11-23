"use strict";

const { parseLocator, selectNodes } = require("../media/elementsLocator");

const targetCommands = new Set(["press", "fill", "scroll", "wait"]);
const capability = {press:"pressable", fill:"editable", scroll:"scrollable"};
const locatorFields = new Set(["id", "text", "description"]);
const sensitive = /pass(?:word|code)|secret|token|密码|口令|验证码/i;

function stepLocator(step) {
    if (targetCommands.has(step?.command) && step.input?.target)
        return {owner:step.input, field:"target", capability:capability[step.command]};
    const check = step?.assert || step?.read || step?.if || step?.repeat?.until;
    if (check?.selector) return {owner:check, field:"selector"};
}

function canonicalLocator(target) {
    if (typeof target === "string") {
        const index = target.indexOf("=");
        if (index <= 0) return;
        target = {[target.slice(0,index)]:target.slice(index+1)};
    } else if (target?.kind === "selector") target = target.selector;
    try { return parseLocator(target); } catch { return undefined; }
}

function describeLocator(target) {
    return (typeof target === "string" ? target : JSON.stringify(target)).slice(0, 450);
}

function observationsForStep(locator, sources, bundle) {
    const current = canonicalLocator(locator?.owner[locator.field]);
    const choices = [];
    const seen = new Set();
    let matches;
    for (const {nodes, source, complete} of sources) {
        if (source === "live" && current) matches = {count:selectNodes(nodes,current).length, complete};
        const accessible = new Map();
        const labelSelector = (node, key) => {
            const text = node.attributes?.[key];
            if (!text || sensitive.test(text)) return;
            return {...(node.bundle && {bundleName:node.bundle}), [key]:text, ...(node.type && {type:node.type})};
        };
        for (const node of nodes) for (const key of ["description","hint"]) {
            const candidate = labelSelector(node,key);
            if (!candidate) continue;
            const encoded = JSON.stringify(candidate);
            accessible.set(encoded, (accessible.get(encoded) || 0) + 1);
        }
        for (const node of nodes) {
            // Legacy recorded boundary snapshots lack some action flags.
            if (node.visible === false || (locator?.capability && node[locator.capability] === false) ||
                (bundle && node.bundle && node.bundle !== bundle)) continue;
            let selector = node.selector;
            if (!selector || node.editable && selector.text || sensitive.test(selector.text || "")) {
                selector = ["description","hint"].map(key=>labelSelector(node,key))
                    .find(candidate=>candidate && accessible.get(JSON.stringify(candidate)) === 1);
            }
            if (!selector) continue;
            const encoded = JSON.stringify(selector);
            if (seen.has(encoded)) continue;
            const attrs = node.attributes;
            const label = (node.editable ? attrs?.description || attrs?.hint : node.label) || node.id || node.type;
            if (!label) continue;
            seen.add(encoded);
            choices.push({selector, source, label:String(label).slice(0,120), detail:[node.id, node.type].filter(Boolean).join(" · ").slice(0,210),
                ...(source==="live" && node.bounds && {bounds:node.bounds})});
        }
    }
    return {choices, matches};
}

function manualLocator(field, value, scope) {
    if (typeof value !== "string" || !locatorFields.has(field)) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 256 || /[\x00-\x1f]/u.test(trimmed)) return;
    return {...(scope && {bundleName:scope}),[field]:trimmed};
}

module.exports = {stepLocator, canonicalLocator, describeLocator, observationsForStep, manualLocator};
