import { trafficView, trafficClick, trafficInput, resetTraffic, openExchange, returnToExchange, inspectBatch, showExchangeTab, filterByExchangePath } from "./networkTraffic.js";
import { nativeCaptureStatus } from "./nativeCapture.js";
import { studioView, studioClick, studioInput, openStudio, resumeStudioRules, resumeStudioReplay, resumeStudioComposer, resumeRequestRuleDraft, closeStudioComposer, observeStudio, studioActive, editingRuleId, resendSourceId, moveStudioRule, moveComposerResponse, hasRequestRuleDraft } from "./networkStudio.js";
import { scenarioView, scenarioClick, scenarioInput, editMatchedScenario, receiveScenarioDraft, showScenarioOverview, ruleToggleSelector, moveScenarioResponse } from "./networkScenarios.js";
import { tabList, tabPanels } from "./ui/tabs.js";
import { fieldSeed } from "./networkFieldActions.js";
import { fieldText, hasRetainedRule } from "./networkInspector.js";

let tab="requests", requestPage="traffic", mockPage="groups", filterVersion, pendingExchange, pendingMatch;
const words=lang=>(en,zh)=>/^zh/i.test(lang)?zh:en;

function showRequests() {
    tab="requests";
    requestPage="traffic";
}

function ruleModel(model) {
    const n=model.network, viewed=n.viewedGroup;
    const scope={...n,gatewayScenarioId:n.activeScenarioId,gatewayRuleGroup:n.scenario.paused || n.rulesEnabled===false ? undefined : n.scenario.name};
    if (viewed) Object.assign(scope,{activeScenarioId:viewed.id,scenario:viewed.scenario,scenarioVersion:viewed.version,
        hits:[],removedRule:viewed.removedRule,boundMatchesCurrent:viewed.boundMatches});
    return {...model,network:scope};
}

function exchangeFor(n,id) {
    return n.records.find(item=>item.id===id) || n.favorites?.find(item=>item.record.id===id)?.record;
}

function openMatchedRule(group,record) {
    const rule=group.scenario.rules.find(item=>item.id===record.ruleId);
    if (!rule) return;
    if (rule.steps) {
        openStudio("rules",group);
        editMatchedScenario(group,rule.id,record.id);
    } else {
        showScenarioOverview(group,"#ns-id");
        openStudio("rule",group,record,rule);
    }
}

export function requestMenuItems(owner,model,lang,send,render) {
    const n=model.network, id=owner.dataset.recordId, w=words(lang), record=n && exchangeFor(n,id);
    if (!record) return [];
    const saved=n.favorites?.some(item=>item.record.id===id);
    const inHistory=n.records.some(item=>item.id===id);
    const body=fieldText(record,"responseBody");
    const item=(group,net,label)=>({group,label,run:()=>networkClick({dataset:{net,id}},model,send,render)});
    const copy=(label,text)=>({group:"copy",label,run:()=>send({type:"networkCopyRetained",id,text})});
    const canSequence=record.status>=200 && record.status<=599 && (record.method==="HEAD" || [204,205,304].includes(record.status) ||
        (record.response?.bodyState==="json" && record.response.body!==undefined && !/\[redacted\]/i.test(body)));
    return [
        item("inspect","inspectRequest",w("View request","查看请求")),
        item("inspect","inspectResponse",w("View response","查看响应")),
        item("inspect","filterPath",w("Filter by this path","按此路径筛选")),
        record.batch && item("inspect","captureResults",w("View this capture","查看本次采集")),
        !model.busy && item("rules","createRule",hasRequestRuleDraft(id) ? w("Resume rule draft","继续编辑规则草稿") : w("Create rule","创建规则")),
        !model.busy && canSequence && item("rules","from",hasRequestRuleDraft(id,"sequence") ? w("Resume response sequence","继续编辑顺序响应") : w("Create response sequence","创建顺序响应")),
        !model.busy && hasRetainedRule(n,record) &&
            item("rules","matchedRule",w("Open matched rule","查看命中的规则")),
        !model.busy && item("rules","resend",w("Edit & resend","编辑并重发")),
        copy(w("Copy request URL","复制请求 URL"),record.request.url),
        copy(w("Copy request path","复制请求路径"),record.path),
        body && copy(w("Copy retained response body","复制保留的响应正文"),body),
        !model.busy && item("library",saved?"unfavorite":"favorite",saved?w("Remove favorite","取消收藏"):w("Favorite request","收藏请求")),
        !model.busy && saved && item("library","renameFavorite",w("Rename favorite","给收藏改名")),
        !model.busy && inHistory && item("library","deleteCapture",w("Remove from history","从历史移除"))].filter(Boolean);
}

export function requestFieldMenuItems(owner,model,lang,send,render) {
    const n=model.network, w=words(lang), {id,fieldLabel,target,ref}=owner.dataset;
    const record=n && exchangeFor(n,id);
    const seed=record && fieldSeed(record,owner.dataset);
    if (!seed) return [];
    const copy=(label,text)=>({group:"copy",label,run:()=>send({type:"networkCopyRetained",id,text})});
    return [
        !model.busy && {group:"edit",label:hasRequestRuleDraft(id,seed) ? w("Resume field rule draft","继续编辑字段规则") : w("Create rule for this field","为此字段创建规则"),
            run:()=>networkClick({dataset:{net:"fieldRule",id,target,ref}},model,send,render)},
        copy(w("Copy field name or path","复制字段名称或路径"),fieldLabel),
        copy(w("Copy field value","复制字段值"),typeof seed.value==="string"?seed.value:JSON.stringify(seed.value,null,2))].filter(Boolean);
}

export function ruleGroupMenuItems(owner,model,lang,send,render) {
    const id=owner.dataset.groupId, live=model.network, w=words(lang);
    const group=live?.scenarioLibrary?.find(item=>item.id===id);
    if (!group || model.busy) return [];
    const viewed=live.viewedGroup?.id || live.activeScenarioId;
    const item=(net,label)=>({label,run:()=>networkClick({dataset:{net,id}},model,send,render)});
    return [
        id!==viewed && item("sc-select",w("Open rule group","查看规则组")),
        group.ruleCount>0 && (id!==live.activeScenarioId || live.rulesEnabled===false || group.paused) &&
            item("sc-activate",w("Use for manual mocking","用于手动模拟")),
        item("sc-rename",w("Rename rule group","重命名规则组")),
        item("sc-duplicate",w("Duplicate rule group","复制规则组")),
        item("save",w("Export rule group","导出规则组")),
        item("sc-delete",w("Delete rule group","删除规则组"))];
}

export function networkView(model,lang) {
    const w=words(lang), n=model.network;
    const loading = model.busy || model.networkLoading;
    if(!n) return `<section class="net-view"><header class="net-heading"><h1>${w("Network","网络调试")}</h1></header>
        <div class="net-empty"><p role="status">${loading ? w("Loading requests and rule groups…","正在读取请求和规则组…") :
            w("Could not open network data.","无法打开网络调试数据。")}</p>
        ${loading ? "" : `<button type="button" class="button vscode-button secondary" data-type="networkOpen">${w("Try again","重试")}</button>`}</div></section>`;
    observeStudio(n);
    if(n.filterVersion && filterVersion!==n.filterVersion){
        filterVersion=n.filterVersion; pendingExchange=pendingMatch=undefined; showRequests(); resetTraffic();
        if(n.evidenceRecord?.version===filterVersion) openExchange(n.evidenceRecord.id,!n.records.some(r=>r.id===n.evidenceRecord.id));
    }
    if(pendingExchange && !n.stepLabel){
        openExchange(pendingExchange.id,!n.records.some(r=>r.id===pendingExchange.id),pendingExchange.baselineId);
        pendingExchange=undefined;
    }
    const rules=ruleModel(model);
    if(receiveScenarioDraft(rules)) {tab="mock";mockPage="create";}
    if (pendingMatch) {
        const record=exchangeFor(n,pendingMatch);
        if (!record || !hasRetainedRule(n,record)) pendingMatch=undefined;
        else if (rules.network.activeScenarioId===record.ruleScenarioId) {
            pendingMatch=undefined;
            tab="mock";mockPage="groups";
            openMatchedRule(rules.network,record);
        }
    }
    const tabs={id:"network",label:w("Network workspace","网络工作区"),active:tab,className:"net-nav",items:[
        {id:"requests",label:w("Requests","网络请求"),data:{net:"requests"}},
        {id:"mock",label:w("Mock & rewrite","模拟与改写"),data:{net:"mock"}}
    ]};
    let panel;
    if(tab==="mock"){
        if(mockPage==="create" && resumeStudioComposer())panel=studioView(rules,w,{creating:true});
        else {
            mockPage="groups";
            resumeStudioRules(rules.network);
            const editingRule=editingRuleId();
            panel=scenarioView(rules,w,{editingRule,studio:studioView(rules,w,{embedded:true})});
        }
    } else {
        const replay=requestPage==="resend" && resumeStudioReplay();
        panel=trafficView(model,n,w,lang,record=>replay && resendSourceId()===record.id ? studioView(model,w,{embedded:true}) : "",hasRequestRuleDraft);
    }
    const capture=tab==="requests" || n.capturing ? nativeCaptureStatus(n,w,model) : "";
    return `<section class="net-view"><header class="net-heading">${tabList(tabs)}</header>${capture}${tabPanels(tabs,panel)}</section>`;
}
export function networkClick(el,model,send,render) {
    let id=el.dataset.net;
    if(!id)return false;
    pendingMatch=undefined;
    if(id==="explorationStep"){
        send({type:"networkExplorationStep",id:el.dataset.id,index:Number(el.dataset.receipt)});
        return true;
    }
    const live=model.network;
    if(!live)return false;
    const rules=ruleModel(model), n=tab==="mock" ? rules.network : live;
    if (tab==="mock" && mockPage==="groups" && ["sceneNewSequence","editSequence","edit"].includes(id) && studioActive()==="rule")
        openStudio("rules",n);
    if(studioClick(el,tab==="mock"?rules:model,send,render) || trafficClick(el,render,send) ||
        (tab==="mock" && scenarioClick(el,rules,send,render)))return true;
    const lookup=id=>exchangeFor(n,id);
    if(id==="cancelRuleDraft"){
        if(!closeStudioComposer(rules.network))return true;
        mockPage="groups";
        id=lookup(el.dataset.id)?"returnExchange":"parentScene";
    }
    let focusAfter;
    if(id==="requests"){
        if(tab==="requests" || requestPage!=="resend" || !resumeStudioReplay()) showRequests();
        else tab="requests";
    }
    else if(id==="mock"){
        if(tab==="mock"){mockPage="groups";openStudio("rules",rules.network);showScenarioOverview(rules.network);}
        tab="mock";
    }
    else if(id==="parentScene"){
        tab="mock";mockPage="groups";openStudio("rules",rules.network);showScenarioOverview(rules.network);
    }
    else if(id==="sceneRules" || id==="sceneNewRule"){
        mockPage=id==="sceneRules"?"groups":"create";
        tab="mock";showScenarioOverview(rules.network);
        openStudio(id==="sceneRules"?"rules":"create",rules.network);
        focusAfter=id==="sceneRules"?"#scenario-title":"#ns-compose-title";
    }
    else if(id==="closeResend"){
        requestPage="traffic";
        focusAfter='[data-net="resend"]';
    }
    else if(id==="captureResults"){
        showRequests();inspectBatch(n,lookup(el.dataset.id)?.batch?.id || el.dataset.id);
        focusAfter='[data-net="previousList"]';
    }
    else if(id==="clearTraffic"){
        showRequests();resetTraffic();
        send({type:"networkClearTraffic"});
        return true;
    }
    else if(id==="inspectRequest" || id==="inspectResponse" || id==="filterPath"){
        const record=lookup(el.dataset.id);
        if(!record)return true;
        showRequests();
        if(!returnToExchange(live,record.id))openExchange(record.id,!live.records.some(row=>row.id===record.id));
        if (id==="filterPath") {
            filterByExchangePath(record);
            focusAfter="#net-filter";
        } else {
            showExchangeTab(id==="inspectRequest"?"request":"response");
            focusAfter=".net-detail-title h2";
        }
    }
    else if(id==="openExchange" || id==="returnExchange" || id==="compareReplay"){
        const target=el.dataset.id;
        const record=lookup(target);
        if(!record)return true;
        const baselineId=id==="compareReplay" && lookup(record.replayOf)?.id;
        if(id==="compareReplay" && !baselineId)return true;
        showRequests();
        if(id!=="returnExchange" || !returnToExchange(n,target)){
            if(n.stepLabel){pendingExchange={id:target,baselineId};send({type:"networkAll"});}
            openExchange(target,!n.records.some(row=>row.id===target),baselineId);
        }
        focusAfter=".net-detail-title h2";
    }
    else if(id==="createRule"||id==="fieldRule"||id==="from"||id==="resend"){
        const record=lookup(el.dataset.id);
        const seed=id==="fieldRule" ? fieldSeed(record,el.dataset) : undefined;
        if(model.busy || !record || (id==="fieldRule" && !seed)) return true;
        if(id==="resend"){
            tab="requests";requestPage="resend";
            if(!returnToExchange(live,record.id))openExchange(record.id,!live.records.some(row=>row.id===record.id));
            if(!resumeStudioReplay() || resendSourceId()!==record.id) openStudio("resend",live,record);
        }else if(resumeRequestRuleDraft(record.id,id==="from" ? "sequence" : seed,rules.network,send)){
            tab="mock";mockPage="create";
        }else if(id==="from"){
            send({type:"networkFrom",id:record.id,remove:false,scenarioId:rules.network.activeScenarioId});
            return true;
        }else{
            tab="mock";mockPage="create";showScenarioOverview(rules.network);
            openStudio("create",rules.network,record,undefined,seed);
        }
        render();
        if(typeof document!=="undefined") {
            const input=seed ? document.querySelector('#ns-edit-0-value, #ns-edit-0-jsonValue-root-value') ||
                document.getElementById("ns-edit-0-jsonValue-root-type") : document.querySelector(id==="resend"?"#ns-method":"#ns-compose-title");
            input?.focus();
            if(seed && (input?.tagName==="INPUT" || input?.tagName==="TEXTAREA")) input.select();
        }
        return true;
    }
    else if(id==="matchedRule"){
        const record=lookup(el.dataset.id);
        if (!record || !hasRetainedRule(live,record)) return true;
        if (record.ruleScenarioId!==rules.network.activeScenarioId) {
            pendingMatch=record.id;
            send({type:"networkScenarioBrowse",id:record.ruleScenarioId});
            return true;
        }
        tab="mock";mockPage="groups";
        openMatchedRule(rules.network,record);
    }
    else if(id==="sceneRule" || id==="ruleOpen"){
        const group=rules.network;
        const rule=group.scenario.rules.find(item=>item.id===el.dataset.id);
        if(!rule)return true;
        tab="mock";mockPage="groups";
        if(rule.steps){openStudio("rules",group);editMatchedScenario(group,rule.id);}
        else {
            const closing=id==="sceneRule" && editingRuleId()===rule.id;
            showScenarioOverview(group,closing ? ruleToggleSelector(group,rule.id) : "#ns-id");
            if (closing) openStudio("rules",group);
            else openStudio("rule",group,undefined,rule);
        }
    }
    else if(id==="backrun")send(model.network.returnTo==="exploration"?{type:"explorationOpen"}:{type:"view",view:"run"});
    else {
        const type={native:"networkNative",nativeChoose:"networkNativeChoose",nativeTimed:"networkNativeTimed",
            arkweb:"networkArkWeb",har:"networkImportHar",all:"networkAll",
            favorite:"networkSaveFavorite",unfavorite:"networkRemoveFavorite",renameFavorite:"networkRenameFavorite",undoFavorite:"networkUndoFavorite",
            deleteCapture:"networkDeleteCapture",undoCapture:"networkUndoCapture",undoClearTraffic:"networkUndoClearTraffic",
            server:"networkServer",map:"networkMap",try:"networkTry",reset:"networkResetHits",
            marker:"networkMarker",saveCase:"networkSaveCase"}[id];
        if(id==="nativeStop"){
            send({type:"networkNativeStop",id:el.dataset.id});
            focusAfter="#network-native-phase";
        }
        else if(type) send({type,id:el.dataset.id,remove:false,...(id==="saveCase" && {scenarioId:n.activeScenarioId})});
    }
    render();
    if(focusAfter && typeof document!=="undefined"){
        const target=document.querySelector(focusAfter);
        if(target?.tagName==="H2")target.tabIndex=-1;
        target?.focus();
        if(id==="captureResults" && globalThis.matchMedia?.("(max-width: 760px)").matches){
            target?.closest(".net-context")?.scrollIntoView({block:"start"});
        }
    }
    return true;
}
export function networkInput(el,render,send) {
    return studioInput(el,render,send)||trafficInput(el,render)||scenarioInput(el,render);
}

export function networkOrder({row,list,from,to},model,send,render) {
    if (!model.network || model.tool!=="network" || model.busy || tab!=="mock") return false;
    if (mockPage==="create") return list.dataset.orderKind==="responses" && moveComposerResponse(from,to,render);
    if (mockPage!=="groups") return false;
    const rules=ruleModel(model), n=rules.network, key=list.dataset.orderKey;
    if (list.dataset.orderKind==="responses")return moveScenarioResponse(rules,Number(key),from,to,render);
    if (String(n.activeScenarioId)!==key || n.scenario.rules[from]?.id!==row.dataset.ruleId) return false;
    moveStudioRule(rules,row.dataset.ruleId,to,send,render);
    return true;
}
