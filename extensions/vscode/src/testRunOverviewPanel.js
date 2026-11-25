"use strict";

const fs=require("node:fs/promises");
const path=require("node:path");
const {buildTestRunOverview}=require("./testRunOverview");
const {overviewDocument,overviewContent,overviewExportDocument,choiceList}=require("./testRunOverviewView");
const {saveReportHtml}=require("./reportHtmlFile");

async function readJson(file) {
    try {
        return JSON.parse((await fs.readFile(file,"utf8")).replace(/^\uFEFF/,""));
    } catch (error) {
        if (error instanceof SyntaxError || ["ENOENT","ENOTDIR","EACCES","EPERM","EBUSY"].includes(error.code)) return;
        throw error;
    }
}

// Read immutable local receipts. Listing historical results does not need a running device or agent.
async function archiveFacts(bench,entry) {
    if (entry.status==="running" || !/^[\w-]+$/.test(entry.id)) return {};
    if (entry.source==="device") {
        const replay=bench.context.workspaceState.get("gestures."+entry.id);
        const failed=replay?.steps?.find(row=>row.errorCode);
        return {durationMs:replay?.runtimeMs,failureCode:failed?.errorCode,failurePath:failed?.path};
    }
    const pytest=entry.pytest;
    const runId=pytest ? pytest.deviceRun : entry.id;
    const directory=pytest ? pytest.stateDir : bench.stateDir;
    const session=pytest?.directory && await readJson(path.join(pytest.directory,"pytest.json"));
    let journal;
    if (directory && runId && /^[\w-]+$/.test(runId)) {
        journal=await readJson(path.join(directory,"runs",runId,"run.json"));
        if (!journal && pytest?.directory) {
            const exported=await readJson(path.join(pytest.directory,runId,"report.json"));
            if (exported?.success) journal=exported.data;
        }
    }
    if (!journal || journal.runId!==runId) return {durationMs:session?.elapsedMs};
    const failure=journal.result?.error;
    const rows=journal.receipts || journal.result?.steps || [];
    const blocker=rows.find(row=>row.error?.code);
    const wall=Date.parse(journal.finishedAt)-Date.parse(journal.startedAt);
    return {durationMs:session?.elapsedMs ?? (Number.isFinite(wall) && wall>=0 ? wall : undefined),
        planDigest:journal.planDigest,device:journal.device,failureCode:blocker?.error?.code || failure?.code,
        failurePath:blocker?.path};
}

class TestRunOverviewPanel {
    constructor(bench,vscode) {
        this.bench=bench;
        this.vscode=vscode;
        this.version=0;
        this.facts=new Map();
    }

    scheduleRefresh() {
        if (!this.panel) return;
        clearTimeout(this.timer);
        this.timer=setTimeout(()=>void this.refresh().catch(()=>{}),120);
    }

    async open() {
        if (this.panel) {
            this.panel.reveal();
            return this.refresh();
        }
        const {bench,vscode}=this;
        const media=vscode.Uri.joinPath(bench.context.extensionUri,"media");
        const panel=vscode.window.createWebviewPanel("harmonyAgent.testRunOverview",/^zh/i.test(bench.language) ? "运行总览" : "Run overview",
            vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[media]});
        this.panel=panel;
        this.ready=false;
        this.scope="recent";
        this.selected=new Set();
        panel.onDidDispose(()=>{
            if (this.panel!==panel) return;
            this.panel=undefined;
            this.snapshot=undefined;
            this.version++;
            clearTimeout(this.timer);
            this.facts.clear();
        });
        const webview=panel.webview;
        webview.onDidReceiveMessage(async message=>{
            if (this.panel!==panel || !message || typeof message!=="object") return;
            const entries=bench.state.runs;
            if (message.type==="export") {
                const snapshot=this.snapshot;
                if (!snapshot || snapshot.ticket!==message.ticket || this.exporting) return;
                const title=/^zh/i.test(snapshot.lang) ? "导出运行总览" : "Export run overview";
                this.exporting=true;
                try {
                    await saveReportHtml(vscode,{title,language:snapshot.lang,
                        filename:(/^zh/i.test(snapshot.lang) ? "运行总览" : "run-overview")+"-"+snapshot.asOf.toISOString().slice(0,10),
                        build:()=>overviewExportDocument(snapshot)});
                } finally {
                    this.exporting=false;
                }
                return;
            }
            if (message.type==="report") {
                const record=entries.find(entry=>entry.id===message.id && entry.status!=="running");
                if (record) await bench.caseRunReports.open(record.id);
                return;
            }
            if (message.type==="ready") this.ready=true;
            else if (message.type==="scope" && ["recent","month","all","custom"].includes(message.scope)) {
                this.scope=message.scope;
                if (this.scope==="custom" && Array.isArray(message.ids))
                    this.selected=new Set(entries.filter(entry=>message.ids.includes(entry.id)).map(entry=>entry.id));
            } else return;
            await this.refresh();
        });
        const resource=name=>webview.asWebviewUri(vscode.Uri.joinPath(media,name));
        webview.html=overviewDocument(webview.cspSource,resource,bench.language);
    }

    async refresh() {
        if (!this.panel || !this.ready) return;
        const ticket=++this.version;
        const entries=[...this.bench.state.runs].sort((a,b)=>(Date.parse(b.time)||0)-(Date.parse(a.time)||0));
        const kept=new Set(entries.map(entry=>entry.id));
        for (const id of this.facts.keys()) if (!kept.has(id)) this.facts.delete(id);
        let scoped=entries;
        if (this.scope==="recent") scoped=entries.slice(0,10);
        if (this.scope==="month") scoped=entries.filter(entry=>Date.parse(entry.time)>=Date.now()-30*86400000);
        if (this.scope==="custom") scoped=entries.filter(entry=>this.selected.has(entry.id));
        const facts=new Map();
        // Keep the number of simultaneously parsed journals small for long recordings.
        for (let i=0;i<scoped.length;i+=4) {
            if (ticket!==this.version) return;
            await Promise.all(scoped.slice(i,i+4).map(async entry=>{
                const signature=[entry.status,entry.pytest?.deviceRun,entry.pytest?.code,entry.repairApplied].join("|");
                let saved=this.facts.get(entry.id);
                if (!saved || saved.signature!==signature) {
                    const value=await archiveFacts(this.bench,entry).catch(()=>({}));
                    saved={signature,value};
                    if (ticket===this.version && entry.status!=="running" && Number.isFinite(value.durationMs))
                        this.facts.set(entry.id,saved);
                }
                let value=saved.value;
                if (entry.repairOf && entry.repairTarget) {
                    const views=[this.bench.state.repair,this.bench.caseRepair?.history?.get(entry.repairOf)?.view];
                    const targetVerified=views.some(view=>view?.id===entry.repairOf && view.trial===entry.id &&
                        ["verified","applied"].includes(view.stage));
                    value={...value,targetVerified};
                }
                facts.set(entry.id,value);
            }));
        }
        if (ticket!==this.version || !this.panel) return;
        const overview=buildTestRunOverview(scoped,facts);
        const lang=this.bench.language;
        this.snapshot={data:overview,entries:scoped.map(({id,status,time,plan,repairOf,repairTarget,compositionTrial})=>
            ({id,status,time,plan:{name:plan?.name},repairOf,repairTarget,compositionTrial})),lang,scope:this.scope,asOf:new Date(),ticket};
        await this.panel.webview.postMessage({type:"overview",ticket,scope:this.scope,selected:[...this.selected].filter(id=>kept.has(id)),
            choices:choiceList(entries,lang),content:overviewContent(overview,scoped,lang)});
    }

    dispose() {
        clearTimeout(this.timer);
        this.panel?.dispose();
        this.facts.clear();
    }
}

module.exports={TestRunOverviewPanel,archiveFacts};
