// Field names and literal comparisons follow harmony_agent.observation.select_nodes.
const flags = new Set(["enabled","visible","clickable","longClickable","checkable","checked","selected","focused","scrollable","editable"]);
const fields = new Set([...flags,"bundleName","abilityName","pagePath","hostWindowId","displayId","id","key","text","originalText","type","hint","description","value","accessibilityId","uniqueId","textPrefix"]);
const aliases = {app:"bundleName",window:"hostWindowId",windowId:"hostWindowId",display:"displayId"};

function parseLocator(input) {
    const object = typeof input === "string" ? JSON.parse(input) : input;
    if (!object || typeof object !== "object" || Array.isArray(object) || !Object.keys(object).length)
        throw Error("object");
    const parsed = {};
    for (const [key, value] of Object.entries(object)) {
        const field = Object.hasOwn(aliases,key) ? aliases[key] : key;
        if (Object.hasOwn(parsed, field)) throw Error(key);
        if (field === "within") { parsed.within = parseLocator(value); continue; }
        if (!fields.has(field) || field === "textPrefix" && !value ||
            (flags.has(field) ? typeof value !== "boolean" : typeof value !== "string")) throw Error(key);
        parsed[field] = value;
    }
    return parsed;
}

function selectNodes(nodes, locator) {
    const {within, ...tests} = locator;
    const predicates = Object.entries(tests);
    const local = nodes.filter(node => predicates.every(([field,value]) => field === "textPrefix" ?
        node.attributes?.text?.startsWith(value) : node.attributes?.[field] === value));
    if (!within) return local;
    const scopes = new Set(selectNodes(nodes, within).map(n => n.ref));
    const parents = new Map(nodes.map(n => [n.ref, n.parent]));
    return local.filter(n => {
        for (let ref = n.parent; ref; ref = parents.get(ref)) if (scopes.has(ref)) return true;
        return false;
    });
}

function ancestors(nodes, node) {
    const parents = new Map(nodes.map(n => [n.ref,n]));
    const chain = [];
    for (let parent=parents.get(node?.parent); parent; parent=parents.get(parent.parent)) chain.unshift(parent);
    return chain;
}

function suggestLocator(nodes, node) {
    if (node.selector && selectNodes(nodes,node.selector).length === 1) return node.selector;
    const attrs = node.attributes || {};
    const scope = attrs.bundleName ? {bundleName:attrs.bundleName} : {};
    const candidates = [];
    for (const field of ["id","description","hint","text"]) if (attrs[field]) {
        candidates.push({...scope,[field]:attrs[field],...(field !== "id" && attrs.type && {type:attrs.type})});
    }
    if (!candidates.length && attrs.type) candidates.push({...scope,type:attrs.type});
    for (const target of candidates) if (selectNodes(nodes,target).length === 1) return target;
    for (const parent of ancestors(nodes,node).reverse()) {
        if (!parent.selector) continue;
        for (const target of candidates) {
            const scoped = {...target,within:parent.selector};
            if (selectNodes(nodes,scoped).length === 1) return scoped;
        }
    }
    return candidates[0];
}

function hitsAt(nodes, point) {
    return nodes.map((node,index) => ({node,index})).filter(({node})=>{
        const b=node.bounds;
        return b && node.attributes?.visible !== false && point.x>=b.left && point.y>=b.top && point.x<b.right && point.y<b.bottom;
    }).sort((a,b)=>{
        const size=n=>(n.bounds.right-n.bounds.left)*(n.bounds.bottom-n.bounds.top);
        return size(a.node)-size(b.node) || b.index-a.index;
    }).map(hit=>hit.node);
}

// Shared by the extension host (CommonJS) and the sandboxed webview (module).
const elementLocators = {parseLocator, selectNodes, ancestors, suggestLocator, hitsAt};
if (typeof module === "object" && module.exports) module.exports = elementLocators;
else globalThis.harmonyElementLocators = elementLocators;
