"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {isDeepStrictEqual} = require("node:util");
const {readWorkflow} = require("./workflowFile");
const {readiness} = require("./pytestCase");
const {readCaseMetadata} = require("./caseLibrary");
const {maxSteps, stepEntries, restorePresentation, stepEvidence, transferPresentation} = require("./casePresentation");
const {canonicalLocator} = require("./caseLocators");
const {validateScenario} = require("./network");
const {selectNodes} = require("../media/elementsLocator");
const {readComposition} = require("./caseComposition");

const sourceDigest = text => createHash("sha256").update(text).digest("hex");
const at = (obj, keys) => keys.reduce((part,key) => part?.[key], obj);
const authoredPath = path => typeof path==="string" ? path.replace(/\.repeat\.iteration\[\d+\]/g, ".repeat.steps") : undefined;
const pathKeys = path => (path.match(/[A-Za-z]+|\d+/g) || []).map(key=>/^\d+$/.test(key)?Number(key):key);
const rootStep = path => Number(/^steps\[(\d+)\]$/.exec(path)?.[1]);

// Translate the execution path back to its authored operation, including a loop iteration.
function locatorPath(plan, receipt) {
    if (!receipt.locatorFailure || typeof receipt.path !== "string") return;
    const location = authoredPath(receipt.path);
    if (!/^(?:preconditions|goals)\[\d+\]$|^steps\[\d+\](?:\.(?:then|else|repeat\.steps)\[\d+\])*$/u.test(location)) return;
    const keys = pathKeys(location);
    const step = at(plan, keys);
    if (!step) return;
    if (keys[0] !== "steps" && step.selector) return [...keys,"selector"];
    if (receipt.kind === "assert" && step.assert?.selector) return [...keys,"assert","selector"];
    if (receipt.kind === "command" && ["press","fill","wait","scroll"].includes(step.command) && step.input?.target)
        return [...keys,"input","target"];
}

// Find the value to edit without reformatting the rest of the workflow.
function valueRange(text, keys) {
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
        if (!found) throw new Error("Workflow value is missing");
    }
    const last = tokens[end(i)-1];
    return [tokens[i].index, last.index+last[0].length];
}

function replaceAt(text, keys, replacement) {
    const [start,end] = valueRange(text,keys);
    const updated = text.slice(0,start) + JSON.stringify(replacement) + text.slice(end);
    if (JSON.stringify(at(JSON.parse(updated.replace(/^\uFEFF/,"")), keys)) !== JSON.stringify(replacement))
        throw new Error("Workflow contains conflicting fields");
    return updated;
}

function insertBefore(text, keys, inserted, following) {
    const [start] = valueRange(text,keys);
    const indent = text.slice(0,start).match(/(?:^|\n)([ \t]*)$/)?.[1];
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const value = indent === undefined ? JSON.stringify(inserted) :
        JSON.stringify(inserted,null,2).replaceAll("\n",newline+indent);
    const updated = text.slice(0,start) + value + "," + (indent === undefined ? " " : newline+indent) + text.slice(start);
    const parsed = JSON.parse(updated.replace(/^\uFEFF/,""));
    const later = [...keys.slice(0,-1),keys.at(-1)+1];
    if (!isDeepStrictEqual(at(parsed,keys),inserted) || !isDeepStrictEqual(at(parsed,later),following))
        throw new Error("Workflow contains conflicting step fields");
    return updated;
}

function canUseControl(node, command, parents) {
    if (command==="press" && !node.pressable || command==="fill" && (!node.editable || !node.selector.id) ||
        command==="scroll" && !node.scrollable) return false;
    if (!["press","fill","scroll"].includes(command)) return true;
    const {bounds} = node;
    if (bounds && (bounds.right<=bounds.left || bounds.bottom<=bounds.top)) return false;
    const seen = new Set();
    for (let current=node; current && !seen.has(current); current=parents.get(current.parent)) {
        if (current.visible===false || current.attributes?.enabled===false) return false;
        seen.add(current);
    }
    return true;
}

function candidatesFor(page, old, command) {
    const selector = canonicalLocator(old);
    if (!page?.complete || page.truncated || !selector || selectNodes(page.nodes,selector).length===1) return [];
    const byRef = new Map(page.nodes.map(node=>[node.ref,node]));
    return page.nodes.filter(n => n.visible !== false && n.selector &&
        (!selector.bundleName || n.bundle === selector.bundleName) &&
        (!n.editable || n.selector.id) && canUseControl(n,command,byRef))
        .map(n => ({node:n,selector:n.selector,label:n.editable ? n.attributes.hint || n.attributes.description || n.id :
            String(n.label || "").slice(0,100),type:n.type}));
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
    return stepEvidence({control:selector?.text || selector?.description || selector?.hint || selector?.id || selector?.type})?.control;
}

function findPriorControl(passing, selector) {
    if (!passing?.sameVersion || !passing.sameRunner || !passing.page?.complete || passing.page.truncated) return;
    const matches = selectNodes(passing.page.nodes,selector);
    return matches.length===1 && matches[0].visible!==false ? matches[0] : undefined;
}

function expectedBundle(plan, selector, priorTarget, previous) {
    const app = previous?.command==="open" && previous.dispatched==="acknowledged" &&
        at(plan,pathKeys(previous.path || ""))?.input?.app;
    const named = selector.bundleName || selector.within?.bundleName || priorTarget?.bundle || (typeof app==="string" ? app : undefined);
    if (named) return named;
    const boundary = [plan.preconditions,plan.goals].filter(Array.isArray).flat();
    const bundles = new Set(boundary.map(check=>canonicalLocator(check?.selector)?.bundleName).filter(Boolean));
    return bundles.size===1 ? bundles.values().next().value : undefined;
}

function locatorOptions({plan,step,page,passing,previous,recorded,stepName,live}) {
    if (!step || step.dispatched==="acknowledged" || step.dispatched==="unknown") return [];
    const keys = locatorPath(plan,step);
    if (!keys) return [];
    const old = at(plan,keys), selector = canonicalLocator(old);
    if (!selector) return [];
    const priorTarget = findPriorControl(passing,selector);
    const bundle = expectedBundle(plan,selector,priorTarget,previous);
    const priorLabel = priorTarget?.attributes?.editable ? priorTarget.attributes.description || priorTarget.attributes.hint :
        priorTarget?.text || priorTarget?.attributes?.description;
    const knownLabel = normalize(selector.text || selector.description || selector.hint || priorLabel || recorded?.control);
    const knownId = idWords(selector.id || selector.key || priorTarget?.id);
    const knownWords = new Set(idWords([knownId,knownLabel,stepName].filter(Boolean).join(" ")).split(" ").filter(Boolean));
    const route = priorTarget?.attributes?.pagePath;
    const scope = Object.fromEntries(Object.entries(selector).filter(([key])=>!identityFields.has(key)));
    const options = [];
    for (const item of candidatesFor(page,old,step.command)) {
        if (bundle && item.node.bundle!==bundle) continue;
        const label = normalize(item.node.attributes?.editable ? item.node.attributes?.hint || item.node.attributes?.description :
            item.node.text || item.node.attributes?.description);
        const compatibleType = !priorTarget?.type || priorTarget.type===item.type;
        const sameLabel = knownLabel && knownLabel===label;
        const sameId = knownId && knownId===idWords(item.node.id);
        const sameRoute = !route || !item.node.attributes?.pagePath || item.node.attributes.pagePath===route;
        const supported = !live && Boolean(sameLabel || sameId) && compatibleType && sameRoute;
        const overlap = new Set(idWords([label,item.node.id].filter(Boolean).join(" ")).split(" ").filter(word=>knownWords.has(word))).size;
        if (!supported && !bundle && !overlap && !stepName && !recorded?.control) continue;
        const proposed = {...item.selector,...scope};
        const matches = selectNodes(page.nodes,proposed);
        if (matches.length!==1 || matches[0]!==item.node || isDeepStrictEqual(selector,proposed)) continue;
        const basis = supported ? (sameLabel ? "same recorded control label" : "same control identifier stem") :
            "unique usable control; assess against the recorded step's intent";
        options.push({kind:"locator",keys,path:step.path,old,proposed,label:stepEvidence({control:item.label})?.control || targetName(proposed),
            basis,supported,route:stepEvidence({control:item.node.attributes?.pagePath})?.control,
            score:(supported?100:0)+(sameLabel?10:0)+(sameId?6:0)+overlap*2+(sameRoute?1:0)});
    }
    return options.sort((a,b)=>b.score-a.score).slice(0,20);
}

function waitOption({plan,step,previous,page,passing}) {
    if (!step?.locatorFailure || !["press","fill","scroll"].includes(step.command) || step.dispatched!=="no" ||
        !passing?.sameVersion || !passing.sameRunner || !passing.page?.complete || passing.page.truncated ||
        !page?.complete || page.truncated || previous?.dispatched!=="acknowledged") return;
    const index = rootStep(step.path);
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
        supported:true,basis:"visible loading indicator and a matching control on the passing page"};
}

const navigationLabel = /^(?:continue|next|skip(?: for now)?|not now|got it|dismiss|close|go back|back|继续|下一步|跳过|稍后|以后再说|我知道了|知道了|关闭|返回)(?:\s*[›»→])?$/iu;

function navigationOptions({plan,step,previous,page,passing}) {
    const index = rootStep(step.path);
    if (!index || step.dispatched!=="no" || step.errorCode!=="TARGET_NOT_FOUND" ||
        !["press","fill","scroll"].includes(step.command) || previous?.path!=="steps["+(index-1)+"]" ||
        previous.dispatched!=="acknowledged" || [...stepEntries(plan.steps)].length>=maxSteps) return [];
    const selector = canonicalLocator(at(plan,locatorPath(plan,step) || []));
    if (!selector || selectNodes(page.nodes,selector).length) return [];
    const priorTarget = findPriorControl(passing,selector);
    const bundle = expectedBundle(plan,selector,priorTarget,previous);
    if (!bundle) return [];
    return candidatesFor(page,selector,"press").filter(item=>item.node.bundle===bundle &&
        navigationLabel.test(item.label.trim()) && selectNodes(page.nodes,item.selector).length===1)
        .slice(0,6).map(item=>({kind:"navigation",keys:["steps",index],path:step.path,verifyPath:"steps["+(index+1)+"]",
            old:targetName(selector),label:item.label,proposed:{command:"press",input:{target:item.selector}},
            basis:"an observed navigation control on the failing page; the original target is absent"}));
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
        const {run,step,page,livePage,failure} = input, original = run.entry;
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
        const issue = readiness(plan);
        if (["invalid","gestures"].includes(issue)) return {caseName,reason:"sourceUnavailable"};
        const metadata = await readCaseMetadata(doc.uri).catch(()=>undefined);
        if (metadata?.composition && readComposition(plan,metadata.composition).authored) return {caseName,reason:"composed"};
        const workflowPath = authoredPath(step.path);
        const authoredStep = /^steps\[/.test(workflowPath || "") &&
            at(plan,pathKeys(workflowPath));
        const presentation = restorePresentation(plan,metadata?.presentation);
        const display = presentation.get(authoredStep);
        const next = plan.steps[rootStep(step.path)+1];
        const context = {caseName:stepEvidence({control:metadata?.name})?.control || caseName,
            stepName:stepEvidence({control:display?.name})?.control,recorded:display?.evidence,
            nextStep:next && {command:next.command,name:stepEvidence({control:presentation.get(next)?.name})?.control,
                target:targetName(canonicalLocator(next.input?.target))},
            goal:Array.isArray(plan.goals) ? plan.goals.slice(0,6).map(goal=>
                ({target:targetName(canonicalLocator(goal?.selector)),property:goal?.property})).filter(goal=>goal.target) : undefined};
        if (!step.locatorFailure) return context;
        const observed = livePage || page;
        if (!observed?.complete || observed.truncated) return {...context,reason:"missingPage"};
        const b = this.b, uri = doc.uri?.toString() || original.plan.uri;
        const group = scenario || b.networks.bindings[uri];
        if (original.source!=="pytest" && !scenario) {
            const recorded = await b.networks.scenarioForRun?.(original.id);
            if (!isDeepStrictEqual(recorded,group && validateScenario(group))) return {...context,reason:"groupChanged"};
        }
        const inputs = {...input,plan,recorded:context.recorded,stepName:context.stepName};
        const options = locatorOptions({...inputs,page:observed,live:Boolean(livePage)});
        if (!livePage) {
            const wait = waitOption(inputs);
            if (wait) options.push(wait);
            options.push(...navigationOptions(inputs));
        }
        return {...context,options:options.map(option=>{
            const keys = scenario ? ["workflow",...option.keys] : option.keys;
            const operation = at(plan,option.keys);
            const candidate = option.kind==="navigation" ? insertBefore(source,keys,option.proposed,operation) :
                replaceAt(source,keys,option.kind==="locator" ? option.proposed :
                    {...operation,input:{...operation.input,expect:option.proposed}});
            return {...option,candidate,source,group:JSON.stringify(group),uri,original,issue,
                evidenceId:livePage?"livePage":"page"};
        }), ...(!options.length && {reason:"noMatch"})};
    }

    propose(item) {
        if (!item || this.b.state.run?.entry.id!==item.original.id) return;
        this.pending = item;
        const {original,kind,path,old,proposed,label,issue,evidenceId} = item;
        this.b.state.repair = {id:original.id,kind,path,old,proposed,label,issue,evidenceId,stage:"proposed"};
    }

    async checkedSource(item) {
        const doc = await this.source(item.original);
        const group = readWorkflow(item.source).scenario || this.b.networks.bindings[item.uri];
        if (item.group !== JSON.stringify(group)) throw new Error(this.word("The bound rule group has changed. Run the case again.","绑定规则组已变化，请重新运行用例。"));
        return {doc,group};
    }

    presentation(item, saved) {
        const index = item.kind==="navigation" ? rootStep(item.path) : Infinity;
        const shift = path => path.replace(/^steps\[(\d+)\]/,(prefix,n) => Number(n)>=index ? "steps["+(Number(n)+1)+"]" : prefix);
        return transferPresentation(readWorkflow(item.source).plan,readWorkflow(item.candidate).plan,saved,shift);
    }

    async stage(message) {
        const b = this.b, item = this.pending, view = b.state.repair;
        if (!item || message.id!==view?.id || ![view.id,view.trial].includes(b.state.run?.entry.id) ||
            !["proposed","failed"].includes(view.stage) || b.state.draft || b.state.caseReview) return;
        const {doc,group} = await this.checkedSource(item);
        const metadata = await readCaseMetadata(doc.uri);
        await b.caseAuthoring.beginRepair({doc,group,metadata,plan:readWorkflow(item.candidate).plan,source:item.source,
            entry:item.original,presentation:this.presentation(item,metadata?.presentation),onSave:()=>{
                view.stage = "draftSaved";
                this.pending = undefined;
            }});
    }

    async verify(message) {
        const b = this.b, item = this.pending, view = b.state.repair;
        if (!item || message.id!==view?.id || b.state.run?.entry.id!==view.id || !["proposed","failed"].includes(view.stage)) return;
        if (item.issue) throw new Error(this.word("Add a starting condition and final assertion before verifying this change.",
            "先补齐用例的起始条件和最终断言，再验证修改。"));
        const {doc} = await this.checkedSource(item);
        if (!b.state.device && !(item.original.source === "pytest" && process.env.HARMONY_DEVICE)) throw new Error(b.text.selectDevice);
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
            const completed = (path,check) => run?.steps?.some(step=>step.path===path &&
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
        const {doc} = await this.checkedSource(item);
        const from = doc.getText();
        const metadata = await readCaseMetadata(doc.uri);
        if (doc.isDirty || doc.getText()!==from) throw new Error(this.word("Save the current workflow before applying the repair.","请先保存当前流程，再应用修复。"));
        const edit = new this.v.WorkspaceEdit();
        let start=0, a=from.length, z=item.candidate.length;
        while (start<a && from[start]===item.candidate[start]) start++;
        while (a>start && z>start && from[a-1]===item.candidate[z-1]) { a--; z--; }
        edit.replace(doc.uri,new this.v.Range(doc.positionAt(start),doc.positionAt(a)),item.candidate.slice(start,z));
        if (!(await this.v.workspace.applyEdit(edit)) || doc.getText() !== item.candidate || !(await doc.save()))
            throw new Error(this.word("Review the editor and save the verified change.","请核对编辑器中的修改并保存。"));
        if (metadata?.presentation) {
            const presentation = this.presentation(item,metadata.presentation);
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
