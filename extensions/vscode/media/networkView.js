import { trafficView, trafficClick, trafficInput, resetTraffic, openExchange, returnToExchange, inspectBatch } from "./networkTraffic.js";
import { nativeCaptureStatus } from "./nativeCapture.js";
import { studioView, studioClick, studioInput, openStudio, resumeStudioRules, resumeStudioReplay, resumeStudioComposer, closeStudioComposer, observeStudio, studioActive, editingRuleId, resendSourceId, moveStudioRule } from "./networkStudio.js";
import { scenarioView, scenarioClick, scenarioInput, editMatchedScenario, receiveScenarioDraft, showScenarioOverview, moveScenarioResponse } from "./networkScenarios.js";
import { tabList, tabPanels } from "./ui/tabs.js";
import { fieldSeed } from "./networkFieldActions.js";

let tab="requests", requestPage="traffic", mockPage="groups", filterVersion, pendingExchange;
const words=lang=>(en,zh)=>/^zh/i.test(lang)?zh:en;

function showRequests() {
    tab="requests";
    requestPage="traffic";
}

function ruleModel(model) {
    const n=model.network, viewed=n.viewedGroup;
    const scope={...n,gatewayScenarioId:n.activeScenarioId};
    if (viewed) Object.assign(scope,{activeScenarioId:viewed.id,scenario:viewed.scenario,scenarioVersion:viewed.version,
        hits:[],removedRule:viewed.removedRule,boundMatchesCurrent:viewed.boundMatches});
    return {...model,network:scope};
}

function exchangeFor(n,id) {
    return n.records.find(item=>item.id===id) || n.favorites?.find(item=>item.record.id===id)?.record;
}

export function requestMenuItems(owner,model,lang,send,render) {
    const n=model.network, id=owner.dataset.recordId, w=words(lang);
    if (!n || model.busy || !exchangeFor(n,id)) return [];
    const saved=n.favorites?.some(item=>item.record.id===id);
    const inHistory=n.records.some(item=>item.id===id);
    const item=(net,label)=>({label,run:()=>networkClick({dataset:{net,id}},model,send,render)});
    return [item("createRule",w("Create rule","创建规则")),item("resend",w("Edit & resend","编辑并重发")),
        item(saved?"unfavorite":"favorite",saved?w("Remove favorite","取消收藏"):w("Favorite request","收藏请求")),
        saved && item("renameFavorite",w("Rename favorite","给收藏改名")),
        inHistory && item("deleteCapture",w("Remove from history","从历史移除"))];
}

export function networkView(model,lang) {
    const w=words(lang), n=model.network;
    if(!n) return `<section class="net-view"><header class="net-heading"><h1>${w("Network","网络调试")}</h1></header>
        <div class="net-empty"><p role="status">${model.busy ? w("Loading requests and rule groups…","正在读取请求和规则组…") :
            w("Could not open network data.","无法打开网络调试数据。")}</p>
        ${model.busy ? "" : `<button type="button" class="button vscode-button secondary" data-type="networkOpen">${w("Try again","重试")}</button>`}</div></section>`;
    observeStudio(n);
    if(n.filterVersion && filterVersion!==n.filterVersion){
        filterVersion=n.filterVersion; pendingExchange=undefined; showRequests(); resetTraffic();
        if(n.evidenceRecord?.version===filterVersion) openExchange(n.evidenceRecord.id,!n.records.some(r=>r.id===n.evidenceRecord.id));
    }
    if(pendingExchange && !n.stepLabel){
        openExchange(pendingExchange.id,!n.records.some(r=>r.id===pendingExchange.id),pendingExchange.baselineId);
        pendingExchange=undefined;
    }
    if(receiveScenarioDraft(model)) {tab="mock";mockPage="groups";}
    const tabs={id:"network",label:w("Network workspace","网络工作区"),active:tab,className:"net-nav",items:[
        {id:"requests",label:w("Requests","网络请求"),data:{net:"requests"}},
        {id:"mock",label:w("Mock & rewrite","模拟与改写"),data:{net:"mock"}}
    ]};
    let panel;
    if(tab==="mock"){
        const rules=ruleModel(model);
        if(mockPage==="create" && resumeStudioComposer())panel=studioView(rules,w,{creating:true});
        else {
            mockPage="groups";
            resumeStudioRules(rules.network);
            const editingRule=editingRuleId();
            panel=scenarioView(rules,w,{editingRule,studio:studioView(rules,w,{embedded:true})});
        }
    } else {
        const replay=requestPage==="resend" && resumeStudioReplay();
        panel=trafficView(model,n,w,lang,record=>replay && resendSourceId()===record.id ? studioView(model,w,{embedded:true}) : "");
    }
    const capture=tab!=="mock" || mockPage!=="create" || n.capturing ? nativeCaptureStatus(n,w,model) : "";
    return `<section class="net-view"><header class="net-heading">${tabList(tabs)}</header>${capture}${tabPanels(tabs,panel)}</section>`;
}
export function networkClick(el,model,send,render) {
    let id=el.dataset.net;
    if(!id)return false;
    if(id==="explorationStep"){
        send({type:"networkExplorationStep",id:el.dataset.id,index:Number(el.dataset.receipt)});
        return true;
    }
    const live=model.network;
    if(!live)return false;
    const rules=ruleModel(model), n=tab==="mock" ? rules.network : live;
    if (tab==="mock" && mockPage==="groups" && ["sceneNewSequence","editSequence","edit"].includes(id) && studioActive()==="rule")
        openStudio("rules",n);
    if(studioClick(el,tab==="mock"?rules:model,send,render) || trafficClick(el,render) ||
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
        showRequests();inspectBatch(n,el.dataset.id);
        focusAfter='[data-net="previousList"]';
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
    else if(id==="createRule"||id==="fieldRule"||id==="resend"){
        const record=lookup(el.dataset.id);
        const seed=id==="fieldRule" ? fieldSeed(record,el.dataset) : undefined;
        if(!record || (id==="fieldRule" && !seed)) return true;
        if(id==="resend"){
            tab="requests";requestPage="resend";
            if(!returnToExchange(live,record.id))openExchange(record.id,!live.records.some(row=>row.id===record.id));
            if(!resumeStudioReplay() || resendSourceId()!==record.id) openStudio("resend",live,record);
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
    else if(id==="matchedRule" || id==="sceneRule"){
        const record=id==="matchedRule"?lookup(el.dataset.id):undefined;
        if(id==="matchedRule" && (!record || record.ruleScenarioId!==live.activeScenarioId))return true;
        const group=record ? live : rules.network;
        const rule=group.scenario.rules.find(item=>item.id===(record?record.ruleId:el.dataset.id));
        if(!rule)return true;
        if (record && live.viewedGroup) send({type:"networkScenarioBrowse",id:live.activeScenarioId});
        tab="mock";mockPage="groups";
        if(rule.steps){openStudio("rules",group);editMatchedScenario(group,rule.id,record?.id);}
        else {
            showScenarioOverview(group);
            if (id==="sceneRule" && editingRuleId()===rule.id) openStudio("rules",group);
            else {openStudio("rule",group,record,rule);focusAfter="#ns-id";}
        }
    }
    else if(id==="backrun")send(model.network.returnTo==="exploration"?{type:"explorationOpen"}:{type:"view",view:"run"});
    else {
        const type={native:"networkNative",nativeChoose:"networkNativeChoose",nativeTimed:"networkNativeTimed",
            arkweb:"networkArkWeb",har:"networkImportHar",all:"networkAll",from:"networkFrom",
            favorite:"networkSaveFavorite",unfavorite:"networkRemoveFavorite",renameFavorite:"networkRenameFavorite",undoFavorite:"networkUndoFavorite",
            deleteCapture:"networkDeleteCapture",undoCapture:"networkUndoCapture",
            server:"networkServer",map:"networkMap",try:"networkTry",reset:"networkResetHits",bind:"networkBind",unbind:"networkBind",
            marker:"networkMarker",saveCase:"networkSaveCase"}[id];
        if(id==="nativeStop"){
            send({type:"networkNativeStop",id:el.dataset.id});
            focusAfter="#network-native-phase";
        }
        else if(type)send({type,id:el.dataset.id,remove:id==="unbind",
            ...(["bind","unbind","saveCase"].includes(id) && {scenarioId:n.activeScenarioId})});
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
    if (!model.network || model.tool!=="network" || model.busy || tab!=="mock" || mockPage!=="groups") return false;
    const rules=ruleModel(model), n=rules.network, key=list.dataset.orderKey;
    if (list.dataset.orderKind==="responses")return moveScenarioResponse(rules,Number(key),from,to,render);
    if (String(n.activeScenarioId)!==key || n.scenario.rules[from]?.id!==row.dataset.ruleId) return false;
    moveStudioRule(rules,row.dataset.ruleId,to,send,render);
    return true;
}
