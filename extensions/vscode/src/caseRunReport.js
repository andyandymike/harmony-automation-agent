"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createBdd, readCaseMetadata } = require("./caseLibrary");
const { restorePresentation } = require("./casePresentation");
const { rulePlanForRun } = require("./caseRuleSteps");
const { runView, withAuthoredTargets } = require("./model");
const { loadPytestRun } = require("./pytestReport");
const { withRunReceipts } = require("./runProgress");
const { getScreenshot } = require("./problemExport");
const { timeRange } = require("./networkController");
const { gatewayIssue } = require("./aiEvidence");
const { renderReport, renderEvidence, renderTree, reportDocument, words } = require("./caseRunReportView");
const { buildStandaloneReport } = require("./caseRunReportExport");
const { saveReportHtml } = require("./reportHtmlFile");

const { buildRunReportData } = require("./caseRunOutline");
const { reportContext } = require("./caseRunReportContext");
const { buildRunAggregates, readRunNetwork, runtimeMeasurements, summarizeNetwork } = require("./caseRunAggregates");

async function archivedRunPlan(directory, id) {
    if (typeof id!=="string" || !/^[\w-]+$/.test(id)) return;
    try {
        return await rulePlanForRun(directory,id) ||
            JSON.parse(await fs.readFile(path.join(directory,"runs",id,"plan.json"),"utf8"));
    } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
}

async function readDetailedRun(bench, vscode, entry) {
    if (entry.source === "device") {
        const replay = bench.context.workspaceState.get("gestures." + entry.id, {steps:[]});
        const receipts=replay.steps || [];
        const fullTiming=receipts.length>0 && receipts.every(step=>Number.isFinite(step.stepElapsedMs) && step.stepElapsedMs>=0);
        // The report includes playback pacing. Network evidence stays bound to
        // the dispatched gesture, even when a recorded pause precedes it.
        const steps=fullTiming ? receipts.map(step=>({...step,
            actionTiming:{at:step.at,elapsedMs:step.elapsedMs},startedAt:step.stepStartedAt,elapsedMs:step.stepElapsedMs})) : receipts;
        return {...replay,steps,entry,actionTimingOnly:!fullTiming,goalStatus:"not_requested",cleanup:entry.cleanup};
    }
    const uri = bench.planForEntry(entry)?.uri;
    const metadata = uri && await readCaseMetadata(vscode.Uri.parse(uri));
    if (entry.source === "pytest") {
        const report = await loadPytestRun(entry,bench.language,metadata?.presentation,detailedRunView);
        return {...report, bdd:entry.composedBdd || report.bdd};
    }
    const plan = await archivedRunPlan(bench.stateDir,entry.id);
    let record;
    try {
        record = await bench.reportAgent(entry).call("report",{run_id:entry.id,full:true});
    } catch (error) {
        const current = bench.state.run;
        if (current?.entry.id===entry.id && Array.isArray(current.steps)) return {...current,plan};
        if (!entry.failureMessage) throw error;
        return {entry,steps:[],error:entry.failureMessage,errorCode:entry.failureCode};
    }
    record = await withRunReceipts(bench.stateDir,entry.id,record);
    const detailed = detailedRunView(record,plan);
    return {...detailed,entry,cleanup:entry.cleanup || detailed.cleanup,
        bdd:entry.composedBdd || createBdd(plan,bench.language,undefined,restorePresentation(plan,metadata?.presentation))};
}

function detailedRunView(record,plan) {
    const view = withAuthoredTargets(runView(record),plan);
    const raw = record.receipts || record.result?.steps || record.steps || [];
    const steps = view.steps.map((step,index)=>{
        const detail = raw[index]?.result || raw[index]?.error?.details;
        const condition = ["if","repeat"].includes(step.kind) && !step.errorCode && ["passed","failed"].includes(detail?.status) && detail.status;
        const assertion=["assert","precondition","goal"].includes(step.kind) ? detail : detail?.assertion;
        return {...step,
            ...(detail?.action && (detail.action.dispatched==="acknowledged" ||
                (detail.action.status==="completed" && detail.action.dispatched!=="no")) && {actionRecorded:true}),
            ...(Number.isFinite(detail?.timings?.actionMs) && detail.timings.actionMs>=0 && {nativeActionMs:detail.timings.actionMs}),
            ...(Number.isSafeInteger(assertion?.attempts) && assertion.attempts>0 && {assertionAttempts:assertion.attempts}),
            ...(condition && {condition,selector:detail.selector,property:detail.property,expected:detail.expected,actual:detail.actual}),
            ...(detail?.evidence?.screenshotCapturedAt && {screenshotAt:detail.evidence.screenshotCapturedAt})};
    });
    const wallMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
    return {...view, steps, plan, startedAt:record.startedAt,measurements:runtimeMeasurements(record),
        ...(Number.isFinite(wallMs) && wallMs>=0 && {runtimeMs:wallMs}),
        finalAssertions:(record.result || record).goalVerification?.assertions};
}

function cropForAssertion(row, frame) {
    if (row.property!=="text" || row.assertionStatus!=="failed" || typeof row.actual!=="string") return;
    const delay = Date.parse(row.screenshotAt) - Date.parse(frame?.capturedAt);
    if (Number.isFinite(delay) && (delay<0 || delay>5000)) return;
    const screen = frame?.nodes?.[0]?.bounds;
    if (screen?.left!==0 || screen.top!==0 || !Number.isFinite(screen.right) || !Number.isFinite(screen.bottom)) return;
    const matches = frame.nodes.filter(node=>node.text===row.actual && node.visible!==false && (!row.selector?.type || node.type===row.selector.type));
    const bounds = matches.length===1 && matches[0].bounds;
    if (!bounds || ![bounds.left,bounds.top,bounds.right,bounds.bottom].every(Number.isFinite) ||
        bounds.left<0 || bounds.top<0 || bounds.right<=bounds.left || bounds.bottom<=bounds.top ||
        bounds.right>screen.right || bounds.bottom>screen.bottom) return;
    const pad = Math.max(8,Math.round(screen.right*.025));
    const width = Math.min(screen.right,Math.max(bounds.right-bounds.left+2*pad,Math.round(screen.right*.58)));
    const height = Math.min(screen.bottom,Math.max(bounds.bottom-bounds.top+2*pad,Math.round(width*.38)));
    if (height>=screen.bottom*.9) return;
    const left = Math.max(0,Math.min(screen.right-width,bounds.left-pad));
    const top = Math.max(0,Math.min(screen.bottom-height,bounds.bottom+pad-height));
    const highlight = Math.max(2,Math.round(pad/3));
    return {screen:{width:screen.right,height:screen.bottom}, left,top,width,height,bounds:{
        left:Math.max(left,bounds.left-highlight),top:Math.max(top,bounds.top-highlight),
        right:Math.min(left+width,bounds.right+highlight),bottom:Math.min(top+height,bounds.bottom+highlight)}};
}

function scopedRequests(records, runId) {
    return (records || []).filter(record=>!record.caseRunId || record.caseRunId===runId).sort((a,b)=>
        Number(b.caseRunId===runId)-Number(a.caseRunId===runId) || Date.parse(a.startedAt)-Date.parse(b.startedAt));
}

async function loadReport(bench,vscode,entry) {
    const run=await readDetailedRun(bench,vscode,entry);
    const {rows,outline}=buildRunReportData(run,bench.language);
    const aggregates=buildRunAggregates(run,rows,outline);
    const frames=new Map();
    function readFrame(id) {
        if (!frames.has(id)) {
            const frame=Promise.resolve().then(()=>bench.reportAgent(entry).call("inspect",
                {run_id:entry.id,frame_id:id,max_nodes:500})).catch(()=>undefined);
            frames.set(id,frame);
        }
        return frames.get(id);
    }
    async function readEvidence(row) {
        const timing=row.actionTiming || row;
        const hasTime=Boolean(timeRange(timing));
        const [image,frame,network]=await Promise.all([
            row.screenshot && getScreenshot(entry.pytest?.stateDir || bench.stateDir,row.screenshot).catch(()=>undefined),
            row.screenshot && row.after && row.assertionStatus==="failed" && readFrame(row.after),
            hasTime && bench.networks?.evidenceForStep(entry.id,row.path,timing).catch(()=>({unavailable:true})),
        ]);
        return renderEvidence(row,{image,crop:image && cropForAssertion(row,frame),
            ...(hasTime && {requests:scopedRequests(network?.records,entry.id),logs:scopedRequests(network?.logs,entry.id),
                networkUnavailable:!network || network.unavailable,gatewayIssue,runId:entry.id})},bench.language);
    }
    return {run:{...run,outline},rows,aggregates,readFrame,readEvidence};
}

async function reportSnapshot(bench,model) {
    const {run,rows,aggregates}=model;
    const entry=bench.state.runs.find(candidate=>candidate.id===run.entry.id) || run.entry;
    const archive=await readRunNetwork(bench.networks,entry.id);
    const context=await reportContext(bench,{...run,entry},rows,archive);
    const network=summarizeNetwork(archive,rows);
    const rootId=entry.repairOf || entry.id;
    const related=bench.state.runs.filter(candidate=>candidate.id!==entry.id && candidate.status!=="running" &&
        (candidate.id===rootId || candidate.repairOf===rootId));
    return {run:{...run,entry,context,aggregates:{...aggregates,network}},related};
}

class CaseRunReports {
    constructor(bench, vscode) {
        this.bench = bench;
        this.vscode = vscode;
        this.panels = new Map();
        this.exports = new Map();
    }

    async export(id) {
        if (this.exports.has(id)) return this.exports.get(id);
        const {bench,vscode}=this;
        const entry=bench.state.runs.find(candidate=>candidate.id===id);
        if (!entry || entry.status==="running") return;
        const w=words(bench.language);
        const name=entry.plan?.name || w("Test case","测试用例");
        const saving=saveReportHtml(vscode,{
            title:w("Export full report","导出完整报告"),filename:name+"-"+id+".html",language:bench.language,
            build:async()=>{
                const model=this.panels.get(id)?.model || await loadReport(bench,vscode,entry);
                const snapshot=await reportSnapshot(bench,model);
                return buildStandaloneReport({...model,...snapshot,language:bench.language,
                    title:w("Full report","完整报告")+" · "+name});
            },
        });
        this.exports.set(id,saving);
        try { return await saving; }
        finally { this.exports.delete(id); }
    }

    async open(id, index) {
        const {bench,vscode} = this;
        const entry = bench.state.runs.find(run=>run.id===id);
        if (!entry || entry.status==="running") return;
        const existing = this.panels.get(id);
        if (existing) {
            existing.panel.reveal();
            if (Number.isInteger(index)) existing.index = index;
            await existing.refresh?.(index);
            return;
        }
        const w = words(bench.language);
        const media = vscode.Uri.joinPath(bench.context.extensionUri,"media");
        const title = w("Full report","完整报告") + " · " + (entry.plan?.name || w("Test case","用例"));
        const panel = vscode.window.createWebviewPanel("harmonyAgent.caseRunReport",title,vscode.ViewColumn.Active,
            {enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[media]});
        const item = {panel,index};
        this.panels.set(id,item);
        panel.onDidDispose(()=>this.panels.delete(id));
        const webview = panel.webview;
        const document = (body, interactive) => reportDocument(webview,name=>webview.asWebviewUri(vscode.Uri.joinPath(media,name)),
            bench.language,title,body,interactive);
        webview.html = document(`<p class="report-loading" role="status">${w("Loading run…","正在读取运行记录…")}</p>`);
        try {
            const model = await loadReport(bench,vscode,entry);
            if (this.panels.get(id)!==item) return;
            item.model = model;
            const {rows,readFrame,readEvidence} = model;
            let related = [], previousState, refreshId = 0, documentId = 0;
            webview.onDidReceiveMessage(async message=>{
                if (this.panels.get(id)!==item || !message || typeof message!=="object") return;
                if (message.type==="export") {
                    await this.export(id);
                    return;
                }
                if (message.type==="related" && related.some(run=>run.id===message.id)) {
                    await this.open(message.id);
                    return;
                }
                const row = Number.isInteger(message.index) && rows[message.index];
                if (!row || !Number.isInteger(message.request)) return;
                const origin = documentId;
                let html;
                if (message.type==="evidence") {
                    item.index = row.index;
                    html = await readEvidence(row);
                } else if (message.type==="tree" && ["before","after"].includes(message.phase) && row[message.phase]) {
                    html = renderTree(await readFrame(row[message.phase]),bench.language);
                }
                if (html!==undefined && origin===documentId && this.panels.get(id)===item) await webview.postMessage({type:message.type,
                    request:message.request,index:row.index,phase:message.phase,html});
            });
            item.refresh = async requested => {
                const refresh = ++refreshId;
                const snapshot=await reportSnapshot(bench,model);
                if (refresh!==refreshId || this.panels.get(id)!==item) return;
                const {run}=snapshot;
                related=snapshot.related;
                const state = JSON.stringify([run.context,run.aggregates.network,run.entry.status,run.entry.repairApplied,
                    related.map(candidate=>[candidate.id,candidate.status,candidate.repairApplied])]);
                if (state===previousState) {
                    if (Number.isInteger(requested) && rows[requested]) await webview.postMessage({type:"focus",index:requested});
                    return;
                }
                const selected = Number.isInteger(item.index) && rows[item.index] ? item.index : run.outline.focusIndex;
                documentId++;
                webview.html = document(renderReport(run,rows,selected,related,bench.language),true);
                previousState = state;
            };
            await item.refresh();
        } catch (error) {
            if (this.panels.get(id)===item) {
                webview.html = document(renderReport({entry,error:bench.errorMessage(error)},[],undefined,[],bench.language,{canExport:false}));
            }
        }
    }

    dispose() {
        for (const {panel} of this.panels.values()) panel.dispose();
        this.panels.clear();
    }
}

module.exports = { CaseRunReports, archivedRunPlan, buildRunReportData, cropForAssertion, scopedRequests };
