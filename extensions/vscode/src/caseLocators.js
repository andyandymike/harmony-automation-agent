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

const identityFields = ["id","key","accessibilityId","description","hint","text"];

function frameLocators(nodes) {
    const byRef = new Map(), index = new Map(), ancestry = new Map(), cache = new Map();
    for (const node of nodes) {
        if (node.ref) byRef.set(node.ref,node);
        const attrs = node.attributes || {};
        for (const field of identityFields) {
            if (!attrs[field]) continue;
            const key = JSON.stringify([field,attrs[field]]);
            if (!index.has(key)) index.set(key,[]);
            index.get(key).push(node);
        }
    }
    function parents(node) {
        if (ancestry.has(node)) return ancestry.get(node);
        const ancestors = [];
        for (let parent=byRef.get(node.parent); parent && !ancestors.includes(parent); parent=byRef.get(parent.parent))
            ancestors.push(parent);
        ancestry.set(node,ancestors);
        return ancestors;
    }
    function matches(selector) {
        const key = JSON.stringify(selector);
        if (cache.has(key)) return cache.get(key);
        let group = nodes;
        for (const field of identityFields) {
            if (!Object.hasOwn(selector,field)) continue;
            const indexed = index.get(JSON.stringify([field,selector[field]])) || [];
            if (indexed.length<group.length) group=indexed;
        }
        const found = selectNodes(group,selector);
        cache.set(key,found);
        return found;
    }
    const candidates = new Map(), direct = new Map();
    for (const node of nodes) {
        const attrs = node.attributes || {};
        const scope = attrs.bundleName ? {bundleName:attrs.bundleName} : {};
        const options = [];
        for (const field of identityFields) {
            const value = attrs[field];
            const label = ["description","hint","text"].includes(field);
            if (!value || label && sensitive.test(value) || field==="text" && (attrs.editable===true || node.editable)) continue;
            options.push({...scope,[field]:value,...(label && attrs.type && {type:attrs.type})});
            if (label && attrs.id) options.push({...scope,id:attrs.id,[field]:value});
        }
        candidates.set(node,options);
        direct.set(node,options.find(selector=>{
            const found = matches(selector);
            return found.length===1 && found[0]===node;
        }));
    }
    function locator(node, ancestors) {
        if (direct.get(node)) return direct.get(node);
        for (const parent of ancestors) {
            const within = direct.get(parent);
            if (!within) continue;
            for (const selector of candidates.get(node)) {
                const found = matches(selector).filter(candidate=>parents(candidate).includes(parent));
                if (found.length===1 && found[0]===node) return {...selector,within};
            }
        }
    }
    function fillId(node) {
        const attrs = node.attributes;
        if (!attrs?.id || /password/i.test(attrs.type || "")) return false;
        const scope = Object.fromEntries(["id","bundleName","hostWindowId"].filter(key=>attrs[key]).map(key=>[key,attrs[key]]));
        return matches(scope).length===1;
    }
    return {locator,parents,fillId};
}

function hasScreenBounds(node) {
    const bounds = node.bounds;
    return bounds && [bounds.left,bounds.top,bounds.right,bounds.bottom].every(Number.isFinite) &&
        bounds.right>bounds.left && bounds.bottom>bounds.top;
}

function observationsForStep(locator, sources, bundle) {
    const current = canonicalLocator(locator?.owner[locator.field]);
    const choices = [];
    const seen = new Set();
    let matches;
    for (const {nodes, source, complete} of sources) {
        if (source === "live" && current) matches = {count:selectNodes(nodes,current).length, complete};
        const live = source==="live";
        const frame = frameLocators(nodes);
        const required = locator?.capability;
        for (const node of nodes) {
            if (node.visible===false || !live && bundle && node.bundle && node.bundle!==bundle) continue;
            const attrs = node.attributes;
            const ancestors = frame.parents(node);
            if (required && live) {
                if (!hasScreenBounds(node) || [node,...ancestors].some(item=>item.visible===false || item.attributes?.enabled===false)) continue;
                if (required==="editable" && (!node.editable || !frame.fillId(node))) continue;
                if (required==="scrollable" && !node.scrollable) continue;
                if (required==="pressable" && !node.parent && !node.pressable && !node.editable &&
                    !node.text && !attrs?.description && !attrs?.hint && /^(?:root|window|page|column|row|stack|flex)$/i.test(node.type || "")) continue;
            } else if (required && !live && required!=="pressable" && node[required]===false) {
                continue;
            }
            const saved = !live && node.selector && !(node.editable && node.selector.text) &&
                !sensitive.test(node.selector.text || "") ? node.selector : undefined;
            const selector = frame.locator(node,ancestors) || saved;
            if (!selector) continue;
            const encoded = JSON.stringify(selector);
            if (seen.has(encoded)) continue;
            const label = (node.editable ? attrs?.description || attrs?.hint : node.label) || node.id || node.type;
            if (!label) continue;
            seen.add(encoded);
            const scope = selector.within?.id || selector.within?.description || selector.within?.text;
            const detail = [node.id,node.type,scope].filter(value=>value && value!==label).join(" · ").slice(0,210);
            choices.push({selector,source,label:String(label).slice(0,120),detail,
                ...(live && hasScreenBounds(node) && {bounds:node.bounds})});
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

module.exports = {stepLocator, canonicalLocator, describeLocator, observationsForStep, manualLocator, targetCommands};
