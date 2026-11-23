"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const {randomUUID} = require("node:crypto");
const {NetworkSession,exampleScenario,scenarioFromRecord,validateScenario} = require("./network");
const {reverseFixture} = require("./deviceNetwork");
const {startNative,stopNative,finishNative,closeNative,nativeDevicesChanged}=require("./nativeCaptureController");
const {discoverArkWeb,attachArkWeb} = require("./arkwebNetwork");
const {readWorkflow,workflowWithScenario} = require("./workflowFile");
const {ScenarioLibrary} = require("./networkScenarioLibrary");

function during(records,logs,range) {
    if (!range) return {records:[],logs:[]};
    const overlaps = item => {
        const start=Date.parse(item.startedAt || item.at);
        return start <= range.end && start+(item.durationMs || 0)>=range.start;
    };
    return {window:range,records:records.filter(overlaps),logs:logs.filter(overlaps)};
}
function timeRange(row) {
    const end=Date.parse(row?.at);
    if(!Number.isFinite(end)) return;
    const dispatched=Date.parse(row?.startedAt);
    if(Number.isFinite(dispatched) && dispatched<=end) return {start:dispatched,end};
    return Number.isFinite(row?.elapsedMs) && row.elapsedMs>=0 ? {start:end-row.elapsedMs,end} : undefined;
}

class NetworkController {
    constructor(bench,vscode,{connectPhone=reverseFixture}={}) {
        this.bench=bench; this.vscode=vscode;
        this.file=path.join(bench.storage.fsPath,"network","evidence.json");
        this.logs=[]; this.markers=[]; this.writes=Promise.resolve();
        this.removedRules=new Map();
        this.groupVersions=new Map();
        this.connectPhone=connectPhone;
        this.retiredMappings=new Map();
        this.net=new NetworkSession({onChange:()=>this.changed(),scenarioId:()=>this.activeScenarioId});
    }
    word(en,zh) { return /^zh/i.test(this.bench.language)?zh:en; }
    get bindings() { return this.bench.context.workspaceState.get("network.scenarios",{}); }
    get activeScenarioId() { return this.library?.activeId; }
    get viewedScenarioId() { return this.library?.entries.has(this.browsedGroup) ? this.browsedGroup : this.activeScenarioId; }
    groupVersion(id) {
        if (id===this.activeScenarioId) return this.scenarioVersion;
        const scenario=this.library.get(id), previous=this.groupVersions.get(id);
        if (previous?.scenario!==scenario) this.groupVersions.set(id,{scenario,version:this.nextGroupVersion()});
        return this.groupVersions.get(id).version;
    }
    nextGroupVersion() {
        this.groupClock=(this.groupClock||0)+1;
        return this.groupClock;
    }
    ruleGroup(id=this.activeScenarioId) {
        if (id!==this.activeScenarioId && id!==this.viewedScenarioId)
            throw new Error(this.word("This draft belongs to another rule group. Reopen it there.","这份草稿属于其他规则组，请到原规则组重新打开。"));
        return this.library.get(id);
    }
    editSession(id) {
        const scenario=this.ruleGroup(id);
        if (id===this.activeScenarioId) return this.net;
        const editor=new NetworkSession({onChange:snapshot=>this.library.entries.set(id,snapshot.scenario)});
        editor.scenario=scenario;
        editor.upstream=this.net.upstream;
        editor.baseUrl=this.net.baseUrl;
        return editor;
    }
    async init() {
        this.initialized??=this.load().catch(error=>{
            this.initialized=undefined;
            throw error;
        });
        return this.initialized;
    }
    async load() {
        let data;
        try {data=JSON.parse(await fs.readFile(this.file,"utf8"));}
        catch(e){if(e.code!=="ENOENT") throw e;}
        if(data) {
            this.net.collection.restore(data.favorites);
            this.net.restoreRecords(data.records,data.omittedRecords);
            this.logs=data.logs || [];
            this.markers=data.markers || [];
            this.lastImport=data.lastImport;
            this.captureInfo=data.capture;
            if(["starting","recording","reading"].includes(this.captureInfo?.status)) {
                this.captureInfo={...this.captureInfo,status:"error",
                    error:this.word("The previous capture ended before results were saved.","上次采集在结果保存前已中断。")};
            }
            if(data.upstream) this.net.setUpstream(data.upstream);
        }
        this.library = new ScenarioLibrary(data?.scenarioLibrary,data?.scenario || exampleScenario(),
            this.word("Untitled rule group","未命名规则组"));
        this.net.setScenario(this.library.active);
    }
    changed() {
        if (this.disposed) return;
        const snapshot=this.net.snapshot();
        if (this.lastScenario !== snapshot.scenario) {
            this.lastScenario = snapshot.scenario;
            this.scenarioVersion = this.nextGroupVersion();
            if (this.library) this.library.entries.set(this.activeScenarioId,snapshot.scenario);
        }
        const scope=this.bench.state.plan?.uri, binding=scope&&this.bindings[scope];
        const capturing=Boolean(this.activeCapture);
        const captureStateChanged=capturing!==Boolean(this.bench.state.network?.capturing);
        const mapping=snapshot.running?this.mapping:undefined;
        const viewed=this.viewedScenarioId, detached=viewed && viewed!==this.activeScenarioId && this.library.get(viewed);
        this.bench.state.network={...snapshot,mapping:mapping?.url,mappedDevice:mapping?.device,pendingMappingCleanup:[...this.retiredMappings.keys()],capture:this.captureInfo,
            arkweb:this.web?.target?.title || this.web?.target?.origin, capturing,
            logs:this.logs,markers:this.markers,bound:binding&&(binding.name||this.word("Unnamed rule group","未命名规则组")),boundFor:scope,
            boundMatchesCurrent:!!binding&&JSON.stringify(binding)===JSON.stringify(snapshot.scenario),range:this.range,stepLabel:this.stepLabel,
            sequenceTest:this.sequenceTest,
            returnTo:this.returnTo,originStep:this.originStep,lastImport:this.lastImport,webStatus:this.webStatus,
            filterVersion:this.filterVersion,evidenceRecord:this.evidenceRecord,
            removedRule:this.removedRules.get(this.activeScenarioId)?.rule.id,
            operation:this.operation,scenarioVersion:this.scenarioVersion,scenarioReceipt:this.scenarioReceipt,
            activeScenarioId:this.activeScenarioId,scenarioLibrary:this.library?.listing() || [],
            viewedGroup:detached ? {id:viewed,scenario:detached,version:this.groupVersion(viewed),
                removedRule:this.removedRules.get(viewed)?.rule.id,boundMatches:!!binding&&JSON.stringify(binding)===JSON.stringify(detached)} : undefined};
        if(captureStateChanged || this.bench.state.tool==="network" || this.bench.state.mode==="run") this.bench.publish();
        clearTimeout(this.timer);
        this.timer=setTimeout(()=>this.persist().catch(e=>this.showError(e)),200);
    }
    showError(e) { this.bench.state.error=this.bench.errorMessage(e);this.bench.publish(); }
    persist() {
        clearTimeout(this.timer);
        const {records,favorites,scenario,omittedRecords,upstream}=this.net.snapshot();
        const body=JSON.stringify({records,favorites,scenario,scenarioLibrary:this.library?.serialize(),omittedRecords,upstream,logs:this.logs,markers:this.markers,capture:this.captureInfo,lastImport:this.lastImport});
        this.writes=this.writes.catch(()=>{}).then(async()=>{
            await fs.mkdir(path.dirname(this.file),{recursive:true});
            const tmp=this.file+"."+randomUUID()+".tmp";
            try {await fs.writeFile(tmp,body,{mode:0o600}); await fs.rename(tmp,this.file);}
            finally {await fs.rm(tmp,{force:true});}
        });
        return this.writes;
    }
    async stopServer() {
        this.retireMapping();
        try {await this.cleanMappings(this.bench.state.devices || [...this.retiredMappings.keys()]);}
        finally { await this.net.stop(); }
    }
    retireMapping() {
        if(!this.mapping)return;
        this.retiredMappings.set(this.mapping.device,this.mapping);
        this.mapping=undefined;
    }
    async cleanMappings(devices,requiredDevice) {
        for(const [device,owned] of this.retiredMappings){
            if(!devices.includes(device))continue;
            try {await owned.close();this.retiredMappings.delete(device);}
            catch(error){if(device===requiredDevice)throw error;}
        }
    }
    async close() {
        const captureDone=closeNative(this);
        await this.web?.stop();
        await this.stopServer();
        await this.activeReplay;
        await this.activeSequenceTest;
        await captureDone;
        if(this.initialized) {await this.init();await this.persist();}
        this.disposed=true;
    }
    async scenarioForRun(id) {
        if(!/^[0-9a-f-]{36}$/i.test(id)) return;
        try { return JSON.parse(await fs.readFile(path.join(path.dirname(this.file),"scenarios",id+".json"),"utf8")); }
        catch(e) { if(e.code!=="ENOENT")throw e; }
    }
    async prepareFlow(plan,scenario,id,savedHits) {
        const scope=plan?.uri;
        const bound=scenario || (scope && this.bindings[scope]);
        if(!bound) return;
        await this.init();
        // Keep the current group and its sequence counters until preparation completes.
        const validated=validateScenario(bound);
        const wasRunning=!!this.net.baseUrl;
        let runSnapshot;
        try {
            if(id) {
                const dest=path.join(path.dirname(this.file),"scenarios");
                await fs.mkdir(dest,{recursive:true});
                const target=path.join(dest,id+".json"),handle=await fs.open(target,"wx",0o600);
                runSnapshot=target;
                try {await handle.writeFile(JSON.stringify(validated));} finally {await handle.close();}
            }
            if(!wasRunning) await this.net.start();
            if(!this.mapping || this.mapping.device!==this.bench.state.device) await this.mapDevice();
            this.net.setScenario(this.library.forFlow(validated),savedHits);
        } catch(error) {
            try {
                if(runSnapshot)await fs.rm(runSnapshot,{force:true});
            } finally {
                if(!wasRunning)await this.stopServer();
                this.changed?.();
            }
            throw error;
        }
        return bound;
    }
    async mapDevice() {
        const snap=this.net.snapshot(), {device,devices}=this.bench.state;
        if(!snap.running || !devices.includes(device)) throw new Error(this.word("Start the test gateway and select a phone first.","请先启动测试网关并选择手机。"));
        if(this.mapping?.device===device) return;
        await this.cleanMappings(devices,device);
        let next;
        try {next=await this.connectPhone(device,this.bench.config.get("hdcPath"),snap.baseUrl);}
        catch(error){
            if(error.ownedMapping)this.retiredMappings.set(device,error.ownedMapping);
            this.changed();
            throw error;
        }
        this.retireMapping();
        this.mapping=next;
        await this.cleanMappings(devices);
        this.changed();
    }
    async evidenceForStep(runId,receiptPath,receipt) {
        await this.init();
        const range=timeRange(receipt);
        const records=this.net.collection.recordsWithHistory(this.net.snapshot().records);
        if(range) return during(records,this.logs,range);
        const record=await this.bench.agent.call("report",{run_id:runId,full:true});
        const row=record.receipts?.find(r=>r.path===receiptPath);
        return during(records,this.logs,timeRange(row));
    }
    mark(label,start,end) {
        const capture=this.captureInfo;
        const overlapsCapture=capture?.device===this.bench.state.device && Number.isFinite(capture?.startedAt) &&
            end>=capture.startedAt && start<=(capture.endedAt??(capture.status==="recording"?Infinity:-Infinity));
        if(!overlapsCapture && !this.web && !this.net.baseUrl)return;
        this.markers=[{id:randomUUID(),label,start,end},...this.markers].slice(0,100);
        this.changed();
    }
    async inspectRunStep(run,index) {
        const row=run?.steps?.[index];
        if(!row) return;
        // Gesture receipts and old runs may have no wall clock.
        let range=timeRange(row);
        if(!range && run.entry?.id && run.entry.source!=="device") {
            try {
                const record=await this.bench.agent.call("report",{run_id:run.entry.id,full:true});
                range=timeRange(record.receipts?.[index]);
            } catch(error) {this.bench.state.error=this.bench.errorMessage(error);}
        }
        this.range=range;
        this.stepLabel=row.path;
    }
    openNative(options) {startNative(this,options);}
    finishNative() {return finishNative(this);}
    async devicesChanged(devices) {
        nativeDevicesChanged(this,devices);
        if(this.mapping&&!devices.includes(this.mapping.device))this.retireMapping();
        if(this.retiredMappings.size){await this.cleanMappings(devices);this.changed();}
    }
    async arkweb() {
        if(this.web) {await this.web.stop();this.web=undefined;this.changed();return;}
        const vscode=this.vscode;
        const value=await vscode.window.showInputBox({prompt:this.word("Local forwarded port of your debug ArkWeb application","输入已转发到本机的 ArkWeb 调试端口"),placeHolder:"9222"});
        if(!value) return;
        const port=Number(value), targets=await discoverArkWeb(port);
        if(!targets.length) throw new Error(this.word("No debuggable page on this port.","该端口没有可调试的网页。"));
        const item=await vscode.window.showQuickPick(targets.map(target=>({label:target.title || target.origin,description:target.origin,target})),
            {title:this.word("Select the page to observe","选择要观察的网页")});
        if(!item) return;
        const batch={id:randomUUID(),label:item.target.title || item.target.origin};
        const web=await attachArkWeb({port,targetId:item.target.id,expectedOrigin:item.target.origin,
            onEntries:entries=>this.net.importHar({log:{entries}},{source:"arkweb",batch}),
            onClose:reason=>{
                this.web=undefined;
                this.webStatus={batch,reason};
                this.changed();
            }});
        this.web=web;
        this.webStatus={batch,reason:"connected"};
        this.changed();
    }
    // The webview correlates replies to the current editor revision. Historical
    // previews and replay receipts stay independent of persisted rules and hits.
    async studioAction(message, action) {
        const operation = {type:message.type, revision:message.revision};
        try { Object.assign(operation, await action()); }
        catch(error) { operation.error = this.bench.errorMessage(error); }
        this.operation = operation;
        this.changed();
    }

    editRule(message) {
        const {type,originalRule,id}=message;
        if (!message.scenarioId) throw new Error(this.word("Choose a rule group first.","请先选择规则组。"));
        const net=this.editSession(message.scenarioId);
        if (message.scenarioVersion!==undefined && message.scenarioVersion!==this.groupVersion(message.scenarioId))
            throw new Error(this.word("The rule list changed. Check the current order and try again.","规则列表已更新，请核对当前顺序后重试。"));
        if(type==="networkUpsertRule"){
            net.saveEditedRule(message.rule,originalRule);
            return;
        }
        const state=net.snapshot();
        if(type==="networkRuleUndo"){
            const removed=this.removedRules.get(message.scenarioId);
            if(!removed || removed.rule.id!==id) return;
            net.restoreRemovedRule(removed);
            this.removedRules.delete(message.scenarioId);
            return;
        }
        const index=state.scenario.rules.findIndex(item=>item.id===id);
        const rule=state.scenario.rules[index];
        if(!rule || !originalRule || JSON.stringify(rule)!==JSON.stringify(originalRule))
            throw new Error(this.word("The rule changed. Check the current list and try again.","规则已变更，请核对当前列表后重试。"));
        if(type==="networkRuleRemove"){
            this.removedRules.set(message.scenarioId,{rule,index,hits:state.hits.find(item=>item.ruleId===id)?.count});
            net.removeRule(id);
        } else if(type==="networkRuleToggle") net.upsertRule({...rule,enabled:rule.enabled===false});
        else if(type==="networkRuleOrder") net.moveRule(id,message.direction);
        else if(type==="networkRuleRename") net.saveEditedRule({...rule,id:message.name.trim()},rule);
        else if(type==="networkRuleCopy") net.saveEditedRule({...rule,id:message.name,enabled:false},null);
    }
    async resend(message) {
        if(this.activeReplay || (message.revision && this.replayRevision === message.revision)) return;
        this.replayRevision = message.revision;
        this.activeReplay = this.studioAction(message, async () => {
            const record = await this.net.replay(message.request);
            return {recordId:record.id};
        });
        try { await this.activeReplay; }
        finally { this.activeReplay = undefined; }
    }
    async scenarioFile(message) {
        const {vscode,bench}=this;
        const receipt={type:message.type,revision:message.revision};
        try {
            const id=message.scenarioId ?? this.activeScenarioId;
            this.ruleGroup(id);
            const create=scenario=>{
                if (message.browse) this.browsedGroup=this.library.create(scenario);
                else {
                    this.browsedGroup=undefined;
                    this.net.setScenario(this.library.add(scenario));
                }
            };
            if(message.type==="networkApply"){
                if(message.scenarioVersion!==undefined && message.scenarioVersion!==this.groupVersion(id))
                    throw new Error(this.word("The rule group changed. Reopen it before applying edits.","规则组已更新，请重新打开后再应用修改。"));
                const name=this.library.named(message.scenario.name || this.library.untitled,id);
                this.editSession(id).setScenario({...message.scenario,name});
            } else if(message.type==="networkScenarioCreate"){
                create({version:1,name:this.library.named(message.name),rules:[]});
            } else if(message.type==="networkScenarioSelect"){
                if (message.id!==this.activeScenarioId) this.net.setScenario(this.library.select(message.id));
                this.browsedGroup=undefined;
            } else if(message.type==="networkScenarioDuplicate"){
                const original=this.library.get(message.id);
                create({...original,name:this.library.named(message.name)});
            } else if(message.type==="networkScenarioRename"){
                const current=this.library.get(message.id);
                this.library.entries.set(message.id,{...current,name:this.library.named(message.name,message.id)});
                if (message.id===this.activeScenarioId) {
                    this.net.scenario=this.library.active;
                    this.net.notify();
                }
            } else if(message.type==="networkScenarioPause"){
                const current=this.library.get(message.id);
                if (typeof message.paused!=="boolean") throw new Error(this.word("Invalid pause state.","暂停状态无效。"));
                if(message.id===this.activeScenarioId) this.net.setScenarioPaused(message.paused);
                else this.library.entries.set(message.id,{...current,paused:message.paused});
            } else if(message.type==="networkScenarioDelete"){
                const active=message.id===this.activeScenarioId;
                this.library.remove(message.id);
                this.removedRules.delete(message.id);
                this.groupVersions.delete(message.id);
                if(active) this.net.setScenario(this.library.active);
            } else if(message.type==="networkLoadScenario"){
                const [uri]=await vscode.window.showOpenDialog({canSelectMany:false,filters:{JSON:["json"]}})||[];
                if(uri){
                    const doc=await vscode.workspace.openTextDocument(uri);
                    // Import a new library entry; the current scenario stays available.
                    create(doc.getText().replace(/^\uFEFF/,""));
                } else receipt.cancelled=true;
            } else {
                const scenario=this.ruleGroup(id);
                const folder=vscode.workspace.workspaceFolders?.[0]?.uri;
                const uri=await vscode.window.showSaveDialog({defaultUri:folder&&vscode.Uri.joinPath(folder,"network.rule-group.json"),filters:{JSON:["json"]}});
                if(uri) await vscode.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify(scenario,null,2)+"\n"));
                else receipt.cancelled=true;
            }
            if (!receipt.cancelled && message.type!=="networkSaveScenario") await this.persist();
        } catch(error) {receipt.error=bench.errorMessage(error);}
        this.scenarioReceipt=receipt;
        this.changed();
    }
    async handle(m) {
        const {bench,vscode}=this;
        await this.init();
        const snap=()=>this.net.snapshot();
        switch(m.type) {
            case "networkOpen": this.range=this.stepLabel=this.returnTo=this.originStep=undefined; bench.state.tool="network";break;
            case "networkEvidenceRecord": {
                if (bench.state.draft || !Object.values(bench.state.aiResults || {}).some(result=>
                    result.evidence?.some(receipt=>receipt.records?.some(row=>row.id===m.id)))) return;
                if (!this.net.findRecord(m.id)) throw new Error(this.word("This request is no longer retained.","历史和收藏中已找不到这条请求。"));
                this.returnTo=bench.state.tool==="exploration" ? "exploration" : bench.state.mode==="run" ? "run" : undefined;
                this.originStep=this.returnTo ? bench.state.run?.steps?.[bench.state.run.selected]?.path : undefined;
                this.range=this.stepLabel=undefined;
                this.filterVersion=randomUUID();
                this.evidenceRecord={version:this.filterVersion,id:m.id};
                bench.state.mode="network";
                bench.state.tool="network";
                break;
            }
            case "networkSaveFavorite": this.net.collection.save(this.net.findRecord(m.id));break;
            case "networkRemoveFavorite": this.net.collection.remove(m.id);break;
            case "networkUndoFavorite": this.net.collection.undoRemoval(m.id);break;
            case "networkRenameFavorite": {
                const favorite=this.net.collection.items.get(m.id);
                if(!favorite) break;
                const name=await vscode.window.showInputBox({title:this.word("Name this favorite","为收藏命名"),value:favorite.name,
                    validateInput:value=>value.trim()?undefined:this.word("Enter a name","请输入名称")});
                if(name!==undefined) this.net.collection.rename(m.id,name);
                break;
            }
            case "networkDeleteCapture": this.net.removeRecord(m.id);break;
            case "networkUndoCapture": this.net.undoRecordRemoval(m.id);break;
            case "networkCopyRetained":
                if (this.net.findRecord(m.id) && typeof m.text==="string" && m.text.length<=256*1024)
                    await vscode.env.clipboard.writeText(m.text);
                return;
            case "networkUpstream":
                return this.studioAction(m, () => { this.net.setUpstream(m.origin); });
            case "networkPreviewRule":
                return this.studioAction(m, () => {
                    const net=this.editSession(m.scenarioId ?? this.activeScenarioId);
                    if(m.originalRule && JSON.stringify(net.scenario.rules.find(r=>r.id===m.originalRule.id))!==JSON.stringify(m.originalRule))
                        throw new Error(this.word("This rule changed. Reopen it before previewing.","该规则已变更，请重新打开后再预览。"));
                    if(m.originalRule===null && net.scenario.rules.some(r=>r.id===m.rule.id))
                        throw new Error(this.word("This name already exists. Choose a new rule name to preview it.","该名称已存在，请更换规则名称后再预览。"));
                    const originalId=Object.hasOwn(m,"originalRule")?(m.originalRule?.id??null):m.rule.id;
                    const records=this.net.collection.recordsWithHistory(this.net.records);
                    return {preview:{...net.previewRule(m.rule,records,m.seedId,originalId),scenarioVersion:this.groupVersion(m.scenarioId ?? this.activeScenarioId)}};
                });
            case "networkUpsertRule": case "networkRuleOrder": case "networkRuleRemove":
            case "networkRuleUndo": case "networkRuleToggle": case "networkRuleCopy": case "networkRuleRename":
                return this.studioAction(m, () => this.editRule(m));
            case "networkReplay": return this.resend(m);
            case "networkStep":
                if(!bench.state.run?.steps?.[bench.state.run.selected])return;
                bench.state.tool="network";this.returnTo="run";this.filterVersion=randomUUID();
                await this.inspectRunStep(bench.state.run,bench.state.run.selected);
                this.originStep=this.stepLabel;break;
            case "networkExplorationStep": {
                const report=bench.state.exploration;
                const step=report?.steps.find(s=>s.id===m.id);
                if(!step?.runId) return;
                const receipt=step.receipts?.[m.index];
                if(Number.isInteger(m.index) && !receipt)return;
                this.range=timeRange(receipt);
                if(!this.range) {
                    try {
                        const agent=bench.explorations.reportAgent(report);
                        const result=await agent.call("report",{run_id:step.runId,full:true});
                        this.range=receipt?timeRange(result.receipts?.[m.index]):timeRange({startedAt:result.startedAt,at:result.finishedAt});
                    } catch(error) {bench.state.error=bench.errorMessage(error);}
                }
                this.returnTo="exploration";this.filterVersion=randomUUID();
                this.originStep=this.stepLabel=step.label;bench.state.tool="network";break;
            }
            case "networkMarker": {
                const marker=this.markers.find(s=>s.id===m.id);
                this.range=marker && {start:marker.start,end:marker.end};
                this.stepLabel=marker?.label;this.filterVersion=randomUUID();break;
            }
            case "networkAll": this.range=this.stepLabel=undefined;break;
            case "networkNative": this.openNative();break;
            case "networkNativeChoose": this.openNative({choose:true});break;
            case "networkNativeTimed": this.openNative({timed:true});break;
            case "networkNativeStop": stopNative(this,m.id);break;
            case "networkArkWeb": await this.arkweb();break;
            case "networkImportHar": {
                const [uri]=await vscode.window.showOpenDialog({canSelectMany:false,filters:{HAR:["har","json"]}}) || [];
                if(!uri) return;
                const doc=await vscode.workspace.openTextDocument(uri);
                const label=path.basename(uri.fsPath || uri.path);
                const batch={id:randomUUID(),label};
                const count=this.net.importHar(doc.getText(),{batch});
                this.lastImport={batch,count};
                break;
            }
            case "networkScenarioBrowse":
                this.library.get(m.id);
                this.browsedGroup=m.id;
                break;
            case "networkLoadScenario":
            case "networkSaveScenario":
            case "networkScenarioCreate":
            case "networkScenarioSelect":
            case "networkScenarioDuplicate":
            case "networkScenarioRename":
            case "networkScenarioPause":
            case "networkScenarioDelete":
            case "networkApply": return this.scenarioFile(m);
            case "networkSaveCase": {
                const plan=bench.state.plan;
                if(!plan) throw new Error(bench.text.chooseSavedPlan);
                const active=this.ruleGroup(m.scenarioId ?? this.activeScenarioId);
                const doc=await vscode.workspace.openTextDocument(vscode.Uri.parse(plan.uri));
                const {plan:workflow,scenario:embedded}=readWorkflow(doc.getText());
                if(!Array.isArray(workflow?.steps))throw new Error(bench.text.planFileInvalid);
                const effective=embedded || this.bindings[plan.uri];
                let chosen=active;
                if(effective && JSON.stringify(effective)!==JSON.stringify(active)){
                    const choice=await vscode.window.showQuickPick([
                        {label:this.word("Workflow replay · ","流程回放使用 · ")+(effective.name||"—"),
                            description:embedded?this.word("Embedded in the file","文件内嵌"):this.word("Workspace binding snapshot","工作区绑定快照"),value:effective},
                        {label:this.word("Current rule group · ","当前规则组 · ")+(active.name||"—"),value:active}
                    ],{title:this.word("Choose the rule group to embed in the exported workflow","选择要嵌入导出流程的规则组")});
                    if(!choice)return;
                    chosen=choice.value;
                }
                const folder=vscode.workspace.workspaceFolders?.[0]?.uri;
                const uri=await vscode.window.showSaveDialog({title:this.word("Export workflow with ","导出流程与规则组 · ")+(chosen.name||"—"),
                    defaultUri:folder && vscode.Uri.joinPath(folder,"workflow-with-mock.json"),filters:{JSON:["json"]}});
                if(uri) await vscode.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify(workflowWithScenario(workflow,chosen),null,2)+"\n"));
                break;
            }
            case "networkFrom": {
                const record=this.net.findRecord(m.id);
                if(record) {
                    const scenario=structuredClone(snap().scenario), rule=scenarioFromRecord(record).rules[0];
                    const base=record.method+" "+record.path, ids=new Set(scenario.rules.map(item=>item.id));
                    rule.id=base;
                    for(let index=2;ids.has(rule.id);index++) rule.id=base+" ("+index+")";
                    scenario.rules.unshift(rule);
                    this.browsedGroup=undefined;
                    bench.state.networkDraft={revision:randomUUID(),scenario,focusRuleId:rule.id,sourceId:record.id,
                        scenarioId:this.activeScenarioId,scenarioVersion:this.scenarioVersion};
                }
                break;
            }
            case "networkServer": if(snap().running) await this.stopServer();else await this.net.start();break;
            case "networkMap": await this.mapDevice();break;
            case "networkBind": {
                const uri=bench.state.plan?.uri;
                if(!uri) throw new Error(bench.text.chooseSavedPlan);
                const group=this.ruleGroup(m.scenarioId ?? this.activeScenarioId);
                if(!m.remove){
                    const doc=await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
                    const file=readWorkflow(doc.getText());
                    if(!Array.isArray(file.plan?.steps))throw new Error(bench.text.planFileInvalid);
                    if(file.scenario)throw new Error(this.word("Replay uses the embedded rule group. Export a copy to choose another group.","回放会使用文件内嵌的规则组。可导出副本并选择其他规则组。"));
                }
                const bindings={...this.bindings};
                if(m.remove) delete bindings[uri];else bindings[uri]=group;
                await bench.context.workspaceState.update("network.scenarios",bindings);break;
            }
            case "networkResetHits": this.net.resetHits();break;
            case "networkTry": {
                const state=snap(),groupId=this.activeScenarioId,rule=state.scenario.rules.find(r=>r.id===m.id && r.enabled!==false);
                if(this.activeSequenceTest || (m.scenarioId && m.scenarioId!==groupId) || !state.running || state.scenario.paused || !rule?.steps) return;
                const receipt=this.sequenceTest={groupId,id:rule.id,pending:true};
                this.changed();
                this.activeSequenceTest=this.net.testSequence(rule);
                try {
                    const record=await this.activeSequenceTest;
                    Object.assign(receipt,{recordId:record.id,status:record.status,winner:record.ruleId,hit:record.ruleHit,
                        matched:record.ruleScenarioId===groupId && record.ruleId===rule.id});
                } catch(error) {receipt.error=bench.errorMessage(error);}
                finally {receipt.pending=false;this.activeSequenceTest=undefined;}
                break;
            }
        }
        this.changed();
    }
}
module.exports={NetworkController,during,timeRange};
