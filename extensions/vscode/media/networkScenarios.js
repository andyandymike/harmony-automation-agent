import { editScenario, scenarioValue, drawEditor, updateEditor, editorAction } from "./networkEditor.js";
import {ListSelection} from "./ui/listSelection.js";
import { html } from "./networkInspector.js";
import { actionButton } from "./ui/controls.js";
import {shelfView,scenarioName,scenarioTools,shelfClick,shelfInput,resetShelf} from "./networkScenarioShelf.js";
import {openStudio,gatewayView,manualMockStatus,ruleActionLabel,ruleEffectRows,studioRuleControls} from "./networkStudio.js";
import {orderGrip} from "./ui/listOrder.js";

const ruleSelection = new ListSelection("network-rules");
const drafts=new Map();
let editor, pending, feedback, incomingDraft, overviewOwner, words=(en)=>en;
const button = (action, text, {primary=false, disabled=false, id, focus, describedBy}={}) =>
    actionButton(text, {primary, disabled, attrs: {"data-net": action, "data-id": id, id: focus, "aria-describedby": describedBy}});

function focusAfterRender(selector) {
    if (typeof document !== "undefined") queueMicrotask(()=>document.querySelector(selector)?.focus());
}
export function showScenarioOverview(n, focusSelector="#scenario-title") {
    overviewOwner=n.activeScenarioId;
    focusAfterRender(focusSelector);
}
export function ruleToggleSelector(network,id) {
    const index=network.scenario.rules.findIndex(rule=>rule.id===id);
    return `.sc-rule[data-order-index="${index}"] .sc-rule-select`;
}
function startEditor(n,scenario=n.scenario,ruleId,sourceId) {
    const form=editScenario(scenario);
    const index=form.rules.findIndex(r=>r.id===ruleId);
    editor={form, owner:n.activeScenarioId, sourceId, ruleId, base:JSON.stringify(n.scenario), advanced:false, ruleIndex:Math.max(0,index)};
    drafts.set(editor.owner,editor);
    overviewOwner=undefined;
    feedback=undefined;
    focusAfterRender(index<0 ? "#ne-sc-name" : "#ne-"+index+"-path");
}
export function editMatchedScenario(n,ruleId,sourceId) {
    overviewOwner=undefined;
    editor=drafts.get(n.activeScenarioId);
    if(!editor) startEditor(n,n.scenario,ruleId,sourceId);
    else {
        if(sourceId) editor.sourceId=sourceId;
        const index=editor.form.rules.findIndex(r=>r.id===ruleId);
        if(index>=0 && !editor.advanced) {
            editor.ruleIndex=index;
            editor.ruleId=ruleId;
        }
        focusAfterRender("#scenario-editor-title");
    }
}
export function receiveScenarioDraft(model) {
    const draft=model.networkDraft;
    if(!draft?.revision || draft.revision===incomingDraft) return false;
    incomingDraft=draft.revision;
    const n=model.network;
    // Only the captured rule is copied. Saving checks the live destination and duplicate IDs.
    // A concurrent edit to that group's other rules cannot invalidate this independent draft.
    if(draft.scenarioId && draft.scenarioId!==n.activeScenarioId)return false;
    const record=n.records.find(item=>item.id===draft.sourceId) || n.favorites?.find(item=>item.record.id===draft.sourceId)?.record;
    const rule=draft.scenario.rules.find(item=>item.id===draft.focusRuleId);
    if(!record || !rule?.steps)return false;
    openStudio("create",n,record,rule,"sequence");
    return true;
}
function receiveReceipt(n,w) {
    const receipt=n.scenarioReceipt;
    if(!pending || !receipt || receipt.revision!==pending.revision || receipt.type!==pending.type) return;
    const owner=pending.scenarioId;
    pending=undefined;
    if(receipt.cancelled) return;
    if(receipt.error){
        feedback={error:true,text:receipt.error};
        return;
    }
    const messages={
        networkApply:w("Changes saved to this workspace rule group.","修改已保存到当前工作区规则组。"),
        networkSaveScenario:w("Rule group exported.","规则组已导出。"),
        networkLoadScenario:w("Rule group imported into this workspace.","规则组已导入工作区。"),
        networkScenarioCreate:w("Rule group created.","已新建规则组。"),networkScenarioDuplicate:w("Rule group duplicated.","已复制规则组。"),
        networkScenarioDelete:w("Rule group deleted.","已删除规则组。"),networkScenarioRename:w("Rule group renamed.","已重命名规则组。"),
        networkScenarioSelect:w("Rule group selected for manual mocking.","已将规则组用于手动模拟。")
    };
    feedback=messages[receipt.type]?{text:messages[receipt.type]}:undefined;
    resetShelf();
    if(receipt.type==="networkApply"||receipt.type==="networkScenarioDelete") drafts.delete(owner);
    if(receipt.type==="networkScenarioRename" && drafts.has(owner)) {
        const draft=drafts.get(owner), base=JSON.parse(draft.base);
        const name=n.scenarioLibrary?.find(group=>group.id===owner)?.name;
        if(name) {
            draft.base=JSON.stringify({...base,name});
            if(!draft.advanced && draft.form.name===base.name)draft.form.name=name;
        }
    }
    if(receipt.type!=="networkSaveScenario"){
        editor=drafts.get(n.activeScenarioId);
        focusAfterRender("#scenario-title");
    }
}
function request(type,send,extra={}) {
    if(pending)return;
    pending={type,revision:crypto.randomUUID(),scenarioId:extra.scenarioId};
    feedback=undefined;
    send({...pending,...extra});
}
function feedbackView(){
    return feedback ? `<p class="sc-feedback" role="${feedback.error?"alert":"status"}">${html(feedback.text)}</p>` : "";
}
function scenarioEditor(n,w,busy){
    const stale=editor.base!==JSON.stringify(n.scenario) && !pending;
    const sourceId=editor.sourceId;
    const source=sourceId && (n.records?.find(r=>r.id===sourceId) || n.favorites?.find(f=>f.record.id===sourceId)?.record);
    return `<article class="sc-editor" aria-labelledby="scenario-editor-title"><nav class="sc-breadcrumb" aria-label="${w("Editor navigation","编辑器导航")}">
        ${button("sequenceOverview",n.scenario.name ? w("Back to ","返回规则组 · ")+n.scenario.name : w("Back to rule groups","返回规则组"))}
        ${source?button("returnExchange",w("Back to request","返回来源请求"),{id:sourceId}):""}</nav><header class="sc-title">
        <div><div class="sc-caption">${w("Editing response sequences","编辑顺序响应")}</div><h2 id="scenario-editor-title" tabindex="-1">${html(editor.form.name||w("Untitled rule group","未命名规则组"))}</h2></div>
        ${button("cancel",w("Discard edits","放弃编辑"),{disabled:!!pending})}</header>
        ${stale ? `<p class="sc-feedback" role="alert">${w("The active rule group changed. Discard these edits to reopen the current version.","当前规则组已更新。放弃此草稿后，可重新打开当前版本。")}</p>` : ""}
        <fieldset class="sc-draft" ${pending?"disabled":""}><div class="sc-formats">${button("format",editor.advanced?w("Use form","切换到表单"):w("Edit JSON","编辑 JSON"))}</div>
        ${editor.advanced?`<label for="net-draft" class="sc-caption">${w("Rule group JSON","规则组 JSON")}</label><textarea id="net-draft" rows="16" spellcheck="false">${html(editor.raw)}</textarea>`:
            drawEditor(editor.form,w,editor.ruleIndex,{locked:busy||Boolean(pending)||stale})}</fieldset>
        ${feedbackView()}<div class="sc-commit">${button("apply",pending?.type==="networkApply"?w("Saving…","正在保存…"):w("Save rule group","保存规则组"),{primary:true,disabled:busy||!!pending||stale})}</div></article>`;
}
function sceneRule(rule,index,model,w,blocked,editorPanel) {
    const n=model.network;
    const hits=n.hits.find(h=>h.ruleId===rule.id)?.count||0;
    const match=rule.match || {field:"path",type:"exact",value:rule.path};
    const pattern={exact:w("Exact","精确"),glob:w("Glob","通配"),regex:w("Regex","正则")}[match.type];
    const matchField=match.field==="url"?"URL":w("path","路径");
    const enabled=rule.enabled!==false;
    const test=n.sequenceTest?.groupId===n.activeScenarioId && n.sequenceTest.id===rule.id?n.sequenceTest:undefined;
    const prerequisite=n.rulesEnabled===false || n.scenario.paused || n.gatewayScenarioId && n.activeScenarioId!==n.gatewayScenarioId ?
        w("Use this group for manual mocking first","先将此组用于手动模拟"):
        !enabled?w("Enable this rule first","先启用这条规则"):!n.running?w("Start the gateway first","先启动网关"):"";
    const hintId="sc-test-hint-"+index;
    const nextSlot=rule.steps && Math.min(hits+1,rule.steps.length);
    const testHint=prerequisite || (rule.steps && w("If matched, uses response "+nextSlot+" (HTTP "+rule.steps[nextSlot-1].response.status+") and advances the hit count.",
        "若命中，将使用第 "+nextSlot+" 项响应（HTTP "+rule.steps[nextSlot-1].response.status+"），并计入真实命中次数。"));
    const controls=ruleSelection.active ? {} : studioRuleControls(n,w,{...model,busy:blocked},rule,index);
    const preview=ruleSelection.active && ruleSelection.previewId===rule.id;
    const effects=preview && !rule.steps ? ruleEffectRows(rule,w) : [];
    return `<li class="sc-rule"${ruleSelection.row(rule.id)}${ruleSelection.active ? "" : " data-item-actions"} data-rule-id="${html(rule.id)}" data-order-index="${index}" data-order-label="${html(rule.id)}">
        ${ruleSelection.active ? ruleSelection.checkbox(rule.id,w("Select ","选择 ")+rule.id) : `<span class="sc-priority" data-order-head aria-hidden="true">${!blocked && n.scenario.rules.length>1?orderGrip(w):""} ${index+1}</span>`}<div class="sc-rule-main">
        <button type="button" class="sc-rule-select" data-net="${rule.steps?"editSequence":"sceneRule"}" data-id="${html(rule.id)}" data-order-hit data-selection-hit
            ${ruleSelection.active ? "" : `aria-expanded="${Boolean(editorPanel)}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"`} ${blocked?"disabled":""}>
        <span class="sc-rule-line"><strong>${html(rule.id)}</strong><span class="sc-caption">${ruleActionLabel(rule,w)}</span></span>
        <span class="sc-match"><code>${html(rule.method)} ${html(match.value)}</code><span class="sc-caption">${pattern} · ${matchField}</span></span>
        <span class="sc-caption">${enabled?w("Enabled","已启用"):w("Disabled","已停用")} · ${hits} ${w("gateway hits","次网关命中")}</span></button>
        ${effects.length ? `<dl class="sc-rule-effects" data-selection-detail>${effects.map(({label,value})=>
            `<dt>${html(label)}</dt><dd><code>${html(value)}</code></dd>`).join("")}</dl>` : ""}
        ${rule.steps && (!ruleSelection.active || preview)?`<details class="sc-response-preview" id="sc-responses-${preview ? "pick-" : ""}${html(n.activeScenarioId)}-${html(encodeURIComponent(rule.id))}"${preview ? " open" : ""}><summary>${w("Preview sequence","预览序列")} · ${rule.steps.map(s=>html(s.response.status)).join(" → ")}</summary>
        <ol class="sc-sequence" data-selection-ignore data-selection-detail>${rule.steps.map((s,j)=>`<li><span class="sc-number">${j+1}</span><strong>HTTP ${html(s.response.status)}</strong>
            ${s.response.delayMs?`<small>${html(s.response.delayMs)} ms</small>`:""}
            ${s.response.json!==undefined?`<code>${html(JSON.stringify(s.response.json).slice(0,140))}</code>`:""}</li>`).join("")}</ol></details>`:""}
        </div><div class="sc-rule-actions">${controls.tools || ""}
        ${rule.steps && !ruleSelection.active?`<span class="sc-test-action">${button("try",test?.pending?w("Sending…","正在发送…"):w("Send a test request","发送测试请求"),
            {id:rule.id,disabled:Boolean(prerequisite)||blocked||n.sequenceTest?.pending,describedBy:hintId})}
            <small id="${hintId}" class="sc-caption">${testHint}</small></span>`:""}</div>
        ${test&&!test.pending?`<div class="sc-feedback" role="${test.error?"alert":"status"}">${test.error?html(test.error):
            `<strong>HTTP ${html(test.status)}</strong> · ${html(test.winner?w("Matched ","实际命中 ")+test.winner+" #"+test.hit:w("No rule matched","未命中规则"))}
            ${!test.matched?html(w(" · This sequence did not advance."," · 本序列未推进。")):""}
            ${n.records.some(r=>r.id===test.recordId)?button("openExchange",w("View test request","查看测试请求"),{id:test.recordId}):""}`}</div>`:""}
        ${controls.edit ? `<div class="sc-inline-editor" data-order-ignore>${controls.edit}</div>` : ""}
        ${editorPanel ? `<div class="sc-inline-editor" data-order-ignore>${editorPanel}</div>` : ""}</li>`;
}
export function scenarioView(model,w,{studio="",editingRule}={}){
    const n=model.network, sc=n.scenario;
    words=w;
    receiveReceipt(n,w);
    editor=drafts.get(n.activeScenarioId);
    const blocked=Boolean(model.busy||pending);

    const shelf=shelfView(n,w,blocked,drafts);
    if (!n.activeScenarioId) {
        ruleSelection.reset();
        return `<div class="sc-workspace">${shelf}<article class="sc-overview">
            ${editor && overviewOwner!==n.activeScenarioId ? scenarioEditor(n,w,model.busy) :
                `<p class="sc-caption">${w("No rule groups yet.","还没有规则组。")}</p>${editor ?
                    button("edit",w("Resume draft","继续编辑草稿"),{disabled:blocked}) : ""}`}
            ${feedbackView()}${gatewayView(model,w)}</article></div>`;
    }
    ruleSelection.update(n.activeScenarioId,sc.rules.map(rule=>rule.id),blocked);
    const picked=new Set(ruleSelection.values);
    const batchAction=(id,label,eligible=()=>true)=>({id,label,
        disabled:!sc.rules.some(rule=>picked.has(rule.id) && eligible(rule)),
        message:ids=>({type:"networkRulesChange",action:id,ids,scenarioId:n.activeScenarioId,scenarioVersion:n.scenarioVersion})});
    const selectionTools=ruleSelection.tools(w,[batchAction("enable",w("Enable selected","启用所选"),rule=>rule.enabled===false),
        batchAction("disable",w("Disable selected","停用所选"),rule=>rule.enabled!==false),
        batchAction("remove",w("Remove selected rules","移除所选规则"))]);
    const sequenceOpen=!ruleSelection.active && editor && overviewOwner!==n.activeScenarioId;
    const sequence=sequenceOpen?scenarioEditor(n,w,model.busy):"";
    const inSequence=sequenceOpen && sc.rules.some(rule=>rule.id===editor.ruleId);
    const gateway=!n.gatewayScenarioId || n.activeScenarioId===n.gatewayScenarioId;
    return `<div class="sc-workspace">
        <header class="sc-title"><div class="sc-editing-name"><span class="sc-caption">${w("Editing group","正在编辑")}</span>${scenarioName(n,w,blocked)}</div>
            ${manualMockStatus(n,w,blocked)}
            ${editor&&!sequenceOpen?button("edit",w("Resume draft","继续编辑草稿"),{disabled:blocked}):""}</header>
        ${shelf}<article class="sc-overview" aria-labelledby="scenario-title">
        ${scenarioTools(n,w,blocked,model.plan && model.planSummary && !model.planSummary.error)}${feedbackView()}
        ${gatewayView(model,w,{manualInHeader:true})}
        <section class="sc-rules" aria-labelledby="sc-rules-title"><header class="sc-rules-head">
            <div><h3 id="sc-rules-title">${w("Rules in this group","组内规则")} <span class="sc-caption">${sc.rules.length}</span></h3>
                ${sc.rules.length>1?`<p class="sc-caption">${w("The first enabled match handles each request.","每个请求由首条匹配的已启用规则处理。")}</p>`:""}</div>
            <div class="sc-rule-actions">${button("sceneNewRule",w("New rewrite rule","新建改写规则"),{primary:true,disabled:blocked})}
            ${button("sceneNewSequence",w("New response sequence","新建顺序响应"),{disabled:blocked})}${ruleSelection.active?"":selectionTools}</div></header>
            ${ruleSelection.active ? selectionTools : ""}
            ${n.removedRule ? button("studio-undo",w("Undo rule removal","撤销移除规则"),{id:n.removedRule,disabled:blocked}) : ""}
            ${ruleSelection.active || editingRule && sc.rules.some(rule=>rule.id===editingRule) ? "" : studio}${sequenceOpen&&!inSequence ? sequence : ""}
            ${sc.rules.length?`<ol class="sc-rule-list"${ruleSelection.active?"":` data-order-kind="rules" data-order-key="${html(n.activeScenarioId)}"`}>${sc.rules.map((r,i)=>{
                const panel=(sequenceOpen && r.id===editor.ruleId ? sequence : "") + (!ruleSelection.active && r.id===editingRule ? studio : "");
                return sceneRule(r,i,model,w,blocked,panel);
            }).join("")}</ol>`:
            `<p class="sc-caption">${w("This rule group has no rules.","此规则组还没有规则。")}</p>`}
            ${gateway&&n.hits.some(h=>h.count)?button("reset",w("Reset hit counts","重置命中次数"),{disabled:blocked}):""}</section>
        </article></div>`;
}
export function moveScenarioResponse(model,ruleIndex,from,to,render) {
    const n=model.network, draft=drafts.get(n.activeScenarioId);
    if (model.busy || pending || !draft || overviewOwner===n.activeScenarioId || draft.advanced ||
        draft.ruleIndex!==ruleIndex || draft.base!==JSON.stringify(n.scenario)) return false;
    const moved=editorAction(draft.form,{dataset:{net:"moveReply",row:ruleIndex+"-"+from,to:String(to)}});
    if (!moved) return false;
    feedback=undefined;
    render();
    return true;
}
function fieldError(error){
    feedback={error:true,text:error.message};
    if(error.ruleIndex!==undefined)editor.ruleIndex=error.ruleIndex;
    if(typeof document==="undefined" || !error.fieldId)return;
    queueMicrotask(()=>{
        const field=document.getElementById(error.fieldId);
        if(!field)return;
        for(let el=field.parentElement;el;el=el.parentElement)if(el.tagName==="DETAILS")el.open=true;
        const target=field.matches("input,textarea,select")?field:field.querySelector("input,textarea,select")||field;
        target.setAttribute("aria-invalid","true");target.focus();
    });
}
export function scenarioClick(el,model,send,render) {
    const id=el.dataset.net,n=model.network;
    editor=drafts.get(n.activeScenarioId);
    if(id==="try") {send({type:"networkTry",id:el.dataset.id,scenarioId:n.activeScenarioId});}
    else if(shelfClick(el,n,words,send,request)){feedback=undefined;}
    else if(id==="sequenceOverview" && editor){
        showScenarioOverview(n);
    } else if(id==="sceneNewSequence"){
        if(model.busy || pending)return true;
        editMatchedScenario(n);
        if(editor.base===JSON.stringify(n.scenario) && !editor.advanced){
            editorAction(editor.form,{dataset:{net:"addrule"}});
            editor.ruleIndex=editor.form.rules.length-1;
            editor.ruleId=undefined;
            focusAfterRender("#ne-"+editor.ruleIndex+"-path");
            feedback=undefined;
        } else if(editor.advanced && editor.base===JSON.stringify(n.scenario)){
            feedback={text:words("Switch to the form to add a response sequence to this draft.","先切换到表单，即可向这份草稿添加顺序响应。")};
        }
    } else if(editor && overviewOwner!==n.activeScenarioId && !editor.advanced && editorAction(editor.form,el)) {
        if(id==="addrule" || id==="rmrule"){
            editor.ruleIndex=id==="addrule"?editor.form.rules.length-1:Math.max(0,Math.min(editor.ruleIndex,editor.form.rules.length-1));
            focusAfterRender(editor.form.rules.length?"#ne-"+editor.ruleIndex+"-path":'[data-net="addrule"]');
        }
        feedback=undefined;
    } else if(id==="edit" || id==="editSequence") {
        if (id==="editSequence" && editor?.ruleId===el.dataset.id && overviewOwner!==n.activeScenarioId)
            showScenarioOverview(n,ruleToggleSelector(n,el.dataset.id));
        else editMatchedScenario(n,el.dataset.id);
    }
    else if(id==="cancel"){
        drafts.delete(n.activeScenarioId);editor=undefined; feedback=undefined; focusAfterRender("#scenario-title");
    } else if(id==="format" && editor){
        try{
            if(editor.advanced){
                editor.form=editScenario(JSON.parse(editor.raw));
                editor.ruleIndex=Math.max(0,Math.min(editor.ruleIndex,editor.form.rules.length-1));
            }
            else editor.raw=JSON.stringify(scenarioValue(editor.form,words),null,2);
            editor.advanced=!editor.advanced;
            feedback=undefined;
            focusAfterRender(editor.advanced?"#net-draft":"#ne-sc-name");
        }catch(e){fieldError(e);}
    } else if(id==="apply" && editor){
        try{
            if(editor.owner!==n.activeScenarioId || editor.base!==JSON.stringify(n.scenario))
                throw new Error(words("Rule group changed. Reopen the current version.","规则组已更新，请重新打开当前版本。"));
            const scenario=editor.advanced?JSON.parse(editor.raw):scenarioValue(editor.form,words);
            if(!editor.advanced && n.scenario.paused)scenario.paused=true;
            request("networkApply",send,{scenario,scenarioVersion:n.scenarioVersion,scenarioId:editor.owner});
        }catch(e){fieldError(e);}
    } else if(id==="load"||id==="save"){
        request(id==="load"?"networkLoadScenario":"networkSaveScenario",send,{scenarioId:el.dataset.id || n.activeScenarioId,browse:id==="load"});
    } else return false;
    render();
    return true;
}
export function scenarioInput(el,render){
    if(shelfInput(el))return true;
    if(!editor) return false;
    if(el.id==="ne-rule"){
        editor.ruleIndex=Number(el.value);
        render();
        return true;
    }
    if(!editor.advanced) return updateEditor(editor.form,el);
    if(el.id==="net-draft"){editor.raw=el.value;return true;}
    return false;
}
