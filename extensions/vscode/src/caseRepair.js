"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {readWorkflow} = require("./workflowFile");
const {readiness} = require("./pytestCase");
const {readCaseMetadata} = require("./caseLibrary");
const {restorePresentation, stepEvidence, transferPresentation} = require("./casePresentation");
const {canonicalLocator} = require("./caseLocators");
const {validateScenario} = require("./network");
const {selectNodes} = require("../media/elementsLocator");

const sourceDigest = text => createHash("sha256").update(text).digest("hex");
const at = (obj, keys) => keys.reduce((part,key) => part?.[key], obj);
const authoredPath = path => typeof path==="string" ? path.replace(/\.repeat\.iteration\[\d+\]/g, ".repeat.steps") : undefined;

// Translate the execution path back to its authored operation, including a loop iteration.
function locatorPath(plan, receipt) {
    if (!receipt.locatorFailure || typeof receipt.path !== "string") return;
    const location = authoredPath(receipt.path);
    if (!/^(?:preconditions|goals)\[\d+\]$|^steps\[\d+\](?:\.(?:then|else|repeat\.steps)\[\d+\])*$/u.test(location)) return;
    const keys = (location.match(/[A-Za-z]+|\d+/g) || []).map(k => /^\d+$/.test(k) ? Number(k) : k);
    const step = at(plan, keys);
    if (!step) return;
    if (keys[0] !== "steps" && step.selector) return [...keys,"selector"];
    if (receipt.kind === "assert" && step.assert?.selector) return [...keys,"assert","selector"];
    if (receipt.kind === "command" && ["press","fill","wait","scroll"].includes(step.command) && step.input?.target)
        return [...keys,"input","target"];
}

// Locate one value in valid JSON. Keep comments out of the format and preserve all surrounding source bytes.
function replaceAt(text, keys, replacement) {
    JSON.parse(text.replace(/^\uFEFF/,""));
    const tokens = [...text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:"]+/g)];
    if (tokens[0]?.[0] === "\uFEFF") tokens.shift();
    function end(i) {
        if (!["[","{"].includes(tokens[i][0])) return i + 1;
        let depth = 0;
        do {
            const token = tokens[i++][0];
            if (token === "[" || token === "{") depth++;
            if (token === "]" || token === "}") depth--;
        } while (depth);
        return i;
    }
    let i = 0;
    for (const key of keys) {
        const object = tokens[i++][0] === "{";
        let index = 0, found = false;
        while (i < tokens.length && tokens[i][0] !== "}" && tokens[i][0] !== "]") {
            const name = object ? JSON.parse(tokens[i++][0]) : index++;
            if (object) i++;
            if (name === key) { found = true; break; }
            i = end(i);
            if (tokens[i]?.[0] === ",") i++;
        }
        if (!found) throw new Error("Workflow selector is missing");
    }
    const first = tokens[i].index, last = tokens[end(i)-1];
    const updated = text.slice(0,first) + JSON.stringify(replacement) + text.slice(last.index+last[0].length);
    if (JSON.stringify(at(JSON.parse(updated.replace(/^\uFEFF/,"")), keys)) !== JSON.stringify(replacement))
        throw new Error("Workflow contains conflicting selector fields");
    return updated;
}

function candidatesFor(page, old, command) {
    const selector = canonicalLocator(old);
    if (!page?.complete || page.truncated || !selector || selectNodes(page.nodes,selector).length===1) return [];
    return page.nodes.filter(n => n.visible !== false && n.selector &&
        (!selector.bundleName || n.bundle === selector.bundleName) &&
        (command !== "press" || n.pressable) && (command !== "fill" || n.editable) &&
        (command !== "scroll" || n.scrollable) && (!n.editable || n.selector.id))
        .map(n => ({node:n,selector:n.selector,label:n.editable ? n.id : String(n.label || "").slice(0,100),type:n.type}));
}

const normalize = value => typeof value==="string" ? value.normalize("NFKC").trim().toLowerCase() : "";
const idWords = value => normalize(String(value || "").replace(/([a-z0-9])([A-Z])/g,"$1 $2"))
    .split(/[^\p{L}\p{N}]+/u).filter(word=>word && !/^(?:old|new|legacy|updated|v?\d+|button|btn)$/.test(word)).join(" ");
const identityFields = new Set(["id","key","text","description","hint","textPrefix","accessibilityId","uniqueId","originalText","value"]);

function sameScreen(left,right) {
    const contexts = (page,field) => new Set(page?.nodes.filter(n=>n.visible!==false).map(n=>n.attributes?.[field]).filter(Boolean));
    return ["bundleName","pagePath"].every(field=>{
        const a=contexts(left,field), b=contexts(right,field);
        return !a.size || !b.size || [...a].some(x=>b.has(x));
    });
}

function targetName(selector) {
    return stepEvidence({control:selector?.id || selector?.text || selector?.description || selector?.type})?.control;
}

function locatorOptions({plan,step,page,passing,recorded}) {
    if (!step || step.dispatched==="acknowledged" || step.dispatched==="unknown") return [];
    const keys = locatorPath(plan,step);
    if (!keys) return [];
    const old = at(plan,keys), selector = canonicalLocator(old);
    if (!selector) return [];
    const earlier = passing?.sameVersion && passing.sameRunner && passing.page?.complete && !passing.page.truncated ? passing.page : undefined;
    const matched = earlier ? selectNodes(earlier.nodes,selector) : [];
    const previous = matched.length===1 && matched[0].visible!==false ? matched[0] : undefined;
    if (!sameScreen(page,earlier)) return [];
    const priorLabel = previous?.attributes?.editable ? previous.attributes.description || previous.attributes.hint :
        previous?.text || previous?.attributes?.description;
    const knownLabel = normalize(selector.text || selector.description || selector.hint || priorLabel || recorded?.control);
    const knownId = idWords(selector.id || selector.key || previous?.id);
    const scope = Object.fromEntries(Object.entries(selector).filter(([key])=>!identityFields.has(key)));
    const options = [];
    for (const item of candidatesFor(page,old,step.command)) {
        if (previous?.bundle && item.node.bundle!==previous.bundle) continue;
        const route = previous?.attributes?.pagePath;
        if (route && item.node.attributes?.pagePath && item.node.attributes.pagePath!==route) continue;
        const label = normalize(item.node.attributes?.editable ? item.node.attributes?.hint || item.node.attributes?.description :
            item.node.text || item.node.attributes?.description);
        const sameLabel = knownLabel && knownLabel===label && (!previous?.type || previous.type===item.type);
        const sameId = knownId && knownId===idWords(item.node.id) && (!previous?.type || previous.type===item.type);
        if (!sameLabel && !sameId) continue;
        const proposed = {...item.selector,...scope};
        const matches = selectNodes(page.nodes,proposed);
        if (matches.length!==1 || matches[0]!==item.node || isDeepStrictEqual(selector,proposed)) continue;
        options.push({kind:"locator",keys,path:step.path,old,proposed,label:stepEvidence({control:item.label})?.control || targetName(proposed),
            basis:sameLabel ? "same recorded control label" : "same control identifier stem"});
    }
    return options.slice(0,12);
}

function waitOption({plan,step,previous,page,passing}) {
    if (!step?.locatorFailure || !["press","fill","scroll"].includes(step.command) || step.dispatched!=="no" ||
        !passing?.sameVersion || !passing.sameRunner || !passing.page?.complete || passing.page.truncated ||
        !page?.complete || page.truncated || previous?.dispatched!=="acknowledged") return;
    const index = Number(/^steps\[(\d+)\]$/.exec(step.path)?.[1]);
    if (!index || previous.path!=="steps["+(index-1)+"]") return;
    const keys = ["steps",index-1], operation = at(plan,keys);
    if (!["press","open","back","scroll"].includes(operation?.command) || operation.command!==previous.command || operation.input?.expect) return;
    const selectorKeys = locatorPath(plan,step);
    const target = selectorKeys && at(plan,selectorKeys), selector = canonicalLocator(target);
    if (!selector || !sameScreen(page,passing.page) || selectNodes(page.nodes,selector).length) return;
    const priorMatches = selectNodes(passing.page.nodes,selector);
    if (priorMatches.length!==1 || priorMatches[0].visible!==true) return;
    const busy = page.nodes.find(node=>node.visible===true &&
        (/^(?:Progress|ProgressBar|LoadingProgress|LoadingSpinner)$/i.test(node.type || "") ||
            /\b(?:loading|please wait)\b|加载中|请稍候/i.test(node.text || node.attributes?.description || "")));
    if (!busy) return;
    const proposed = {selector:target,property:"visible",equals:true,timeoutMs:3000};
    return {kind:"wait",keys,path:previous.path,verifyPath:step.path,old:operation.command,proposed,label:targetName(selector),
        basis:"visible loading indicator and a matching control on the passing page"};
}

class CaseRepair {
    constructor(bench, vscode) { this.b = bench; this.v = vscode; }
    word(en, zh) { return /^zh/i.test(this.b.language) ? zh : en; }
    async source(entry) {
        const plan = this.b.planForEntry?.(entry) || entry.plan;
        const doc = await this.v.workspace.openTextDocument(this.v.Uri.parse(plan.uri));
        if (!entry.sourceDigest || sourceDigest(doc.getText()) !== entry.sourceDigest) {
            const error = new Error(this.word("The case differs from this run. Run the current case first.","用例与本次运行的版本不一致，请先运行当前用例。"));
            error.code = "CASE_SOURCE_CHANGED";
            throw error;
        }
        return doc;
    }
    async prepare(input) {
        const {run,step,page,failure} = input, original = run.entry;
        const caseName = stepEvidence({control:original.plan?.name})?.control;
        if (original.repairOf || original.source==="device" || !step || !["locator","page","assertion"].includes(failure.kind))
            return {caseName};
        let doc, file, source;
        try {
            doc = await this.source(original);
            source = doc.getText();
            file = readWorkflow(source);
        } catch (error) {
            return {caseName,reason:error.code==="CASE_SOURCE_CHANGED"?"sourceChanged":"sourceUnavailable"};
        }
        const {plan,scenario} = file;
        const metadata = await readCaseMetadata(doc.uri).catch(()=>undefined);
        const workflowPath = authoredPath(step.path);
        const authoredStep = /^steps\[/.test(workflowPath || "") &&
            at(plan,(workflowPath.match(/[A-Za-z]+|\d+/g) || []).map(key=>/^\d+$/.test(key)?Number(key):key));
        const display = restorePresentation(plan,metadata?.presentation).get(authoredStep);
        const context = {caseName:stepEvidence({control:metadata?.name})?.control || caseName,
            stepName:stepEvidence({control:display?.name})?.control,recorded:display?.evidence};
        if (!step.locatorFailure) return context;
        if (readiness(plan)) return {...context,reason:"missingChecks"};
        if (!page?.complete || page.truncated) return {...context,reason:"missingPage"};
        const b = this.b, uri = doc.uri?.toString() || original.plan.uri;
        const group = scenario || b.networks.bindings[uri];
        if (original.source!=="pytest" && !scenario) {
            const recorded = await b.networks.scenarioForRun?.(original.id);
            if (!isDeepStrictEqual(recorded,group && validateScenario(group))) return {...context,reason:"groupChanged"};
        }
        const inputs = {...input,plan,recorded:context.recorded};
        const options = locatorOptions(inputs);
        const wait = waitOption(inputs);
        if (wait) options.push(wait);
        return {...context,options:options.map(option=>{
            const keys = scenario ? ["workflow",...option.keys] : option.keys;
            const operation = at(plan,option.keys);
            const replacement = option.kind==="locator" ? option.proposed :
                {...operation,input:{...operation.input,expect:option.proposed}};
            const candidate = replaceAt(source,keys,replacement);
            return {...option,candidate,source,group:JSON.stringify(group),uri,original};
        }), ...(!options.length && {reason:"noMatch"})};
    }

    propose(item) {
        if (!item || this.b.state.run?.entry.id!==item.original.id) return;
        this.pending = item;
        const {original,kind,path,old,proposed,label} = item;
        this.b.state.repair = {id:original.id,kind,path,old,proposed,label,stage:"proposed"};
    }
    async verify(message) {
        const b = this.b, item = this.pending, view = b.state.repair;
        if (!item || message.id!==view?.id || b.state.run?.entry.id!==view.id || !["proposed","failed"].includes(view.stage)) return;
        const doc = await this.source(item.original);
        if (!b.state.device && !(item.original.source === "pytest" && process.env.HARMONY_DEVICE)) throw new Error(b.text.selectDevice);
        const group = readWorkflow(item.source).scenario || b.networks.bindings[item.uri];
        if (item.group !== JSON.stringify(group)) throw new Error(this.word("The bound rule group has changed. Run the case again.","绑定规则组已变化，请重新运行用例。"));
        view.stage = "verifying";
        view.trial = undefined;
        b.publish?.();
        let entry;
        try {
            if (item.original.source === "pytest") {
                const dir = path.join(b.storage.fsPath,"repair-verification");
                await fs.mkdir(dir,{recursive:true});
                const trial = await fs.mkdtemp(path.join(dir,"trial-"));
                const workflowOverride = path.join(trial,"workflow.json");
                try {
                    await fs.writeFile(workflowOverride,item.candidate,{flag:"wx",mode:0o600});
                    await b.setPlan(doc.uri);
                    entry = await b.usePytest(true,{workflowOverride,repairOf:item.original.id});
                } finally {
                    await fs.unlink(workflowOverride).catch(()=>{});
                    await fs.rmdir(trial).catch(()=>{});
                }
            } else entry = await b.executePlan(true,{contents:item.candidate,repairOf:item.original.id});
            const run = b.state.run;
            view.trial = entry?.id;
            const completed = (path,check) => run?.steps?.some(step=>authoredPath(step.path)===authoredPath(path) &&
                ["completed","passed"].includes(step.status) && (!check || step.assertionStatus==="passed"));
            const reached = completed(item.path,item.kind==="wait") && (!item.verifyPath || completed(item.verifyPath));
            view.stage = entry?.status==="passed" && run?.entry.id===entry.id && run.goalStatus==="passed" && reached ? "verified" : "failed";
            view.notReached = entry?.status==="passed" && !reached;
        } finally {
            if (view.stage==="verifying") {
                view.stage = "failed";
                const trial = b.state.run?.entry;
                if (trial?.repairOf===item.original.id) view.trial = trial.id;
            }
        }
    }
    async apply(message) {
        const b = this.b, item = this.pending, view = b.state.repair;
        if (!item || view?.stage!=="verified" || message.id!==view.trial || ![view.id,view.trial].includes(b.state.run?.entry.id)) return;
        const trial = b.state.runs?.find(entry=>entry.id===view.trial) || (b.state.run.entry.id===view.trial ? b.state.run.entry : undefined);
        if (!trial || trial.repairOf!==item.original.id || trial.status!=="passed") return;
        const doc = await this.source(item.original);
        const from = doc.getText();
        const metadata = await readCaseMetadata(doc.uri);
        if (doc.getText()!==from) throw new Error(this.word("The case changed while applying the repair.","用例在应用修复时发生了变化。"));
        const edit = new this.v.WorkspaceEdit();
        let start=0, a=from.length, z=item.candidate.length;
        while (start<a && from[start]===item.candidate[start]) start++;
        while (a>start && z>start && from[a-1]===item.candidate[z-1]) { a--; z--; }
        edit.replace(doc.uri,new this.v.Range(doc.positionAt(start),doc.positionAt(a)),item.candidate.slice(start,z));
        if (!(await this.v.workspace.applyEdit(edit)) || doc.getText() !== item.candidate || !(await doc.save()))
            throw new Error(this.word("Review the editor and save the verified change.","请核对编辑器中的修改并保存。"));
        if (metadata?.presentation) {
            const presentation = transferPresentation(readWorkflow(from).plan,readWorkflow(item.candidate).plan,metadata.presentation);
            if (presentation) try {
                await b.caseLibrary.updateMetadata(doc.uri,{presentation},metadata.presentation);
            } catch {
                b.state.error = this.word("The change was saved. The case's step titles could not be updated.","修改已保存，未能同步步骤名称。");
            }
        }
        view.stage = "applied";
        trial.repairApplied = true;
        trial.sourceDigest = sourceDigest(item.candidate);
        await b.persistRuns();
        await b.refreshCases();
        this.pending = undefined;
        await b.refreshPlanSummary();
    }
}

module.exports = {CaseRepair,sourceDigest,replaceAt,locatorPath,candidatesFor};
