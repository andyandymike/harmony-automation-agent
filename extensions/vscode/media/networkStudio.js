import { actionButton } from "./ui/controls.js";
import { itemMenu } from "./ui/itemActions.js";
import { orderGrip, orderActions } from "./ui/listOrder.js";
import { changedFields, exchangeDifferences } from "./networkInspector.js";
import { editScenario, drawEditor, updateEditor, editorAction, scenarioValue } from "./networkEditor.js";
import { diffRows } from "./networkDetail.js";
import { fieldView, readField, resetField, fieldClick, fieldInput } from "./ui/fieldEditor.js";

const opaque = value => /\[redacted\]/i.test(String(value));
const requestMethods = ["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"];
const entityAllowed = method => !["GET","HEAD"].includes(method);
const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const pretty = value => JSON.stringify(value,null,2);
const copy = value => JSON.parse(JSON.stringify(value));
const actions = {
    rewrite:["Rewrite fields","修改指定字段"], replaceRequest:["Replace request","替换整个请求"],
    replaceResponse:["Replace upstream response","替换上游响应"], local:["Return a mock response","直接返回模拟响应"], reroute:["Forward to another path","转发到其他路径"]
};
export function ruleActionLabel(rule,w) {
    return rule.steps?w("Response sequence","顺序响应"):w(...actions[rule.action]);
}
const targets = {query:["Query parameter","查询参数"],requestHeader:["Request header","请求头"],requestJson:["Request JSON field","请求 JSON 属性"],
    responseJson:["Response JSON field","响应 JSON 属性"],responseHeader:["Response header","响应头"],requestBody:["Request body text","请求正文文本"],responseBody:["Response body text","响应正文文本"]};
const operations = {set:["Set value","设置值"],remove:["Remove field","移除字段"],literal:["Replace text","文本替换"],regex:["Replace by regex","正则替换"]};
export function ruleEffectRows(rule,w) {
    if (rule.action==="rewrite") return rule.edits.map(edit=>{
        const field=edit.path ? JSON.stringify(edit.path) : edit.key;
        const operation=operations[edit.op];
        const target=targets[edit.target];
        const value=typeof edit.value==="string" ? edit.value : JSON.stringify(edit.value);
        return {label:[target ? w(...target) : edit.target,field].filter(Boolean).join(" · "),
            value:[operation ? w(...operation) : edit.op,edit.find,edit.find && "→",value].filter(part=>part!==undefined && part!=="").join(" ")};
    });
    if (rule.action==="reroute") return [{label:w("Upstream path","上游路径"),value:rule.path}];
    if (rule.request) return [{label:w("Replacement request","替换请求"),value:rule.request.method+" "+rule.request.path}];
    if (rule.response) return [{label:w("Response","响应"),value:"HTTP "+rule.response.status},
        ...(rule.response.fileName ? [{label:w("File","文件"),value:rule.response.fileName}] :
            rule.response.body ? [{label:w("Response body","响应正文"),value:rule.response.body}] : [])];
    return [];
}
const actionNotes = {
    rewrite:["Edits run from top to bottom. Unedited fields pass through to the configured upstream or back to the app.","从上往下应用编辑。其余字段原样传至已配置的上游或返回应用。"],
    replaceRequest:["Sends the following request to the configured upstream when the match succeeds.","匹配时，用下方的完整请求访问已配置的上游。"],
    replaceResponse:["Calls the upstream, then returns your replacement to the app.","先访问上游，再将替换后的响应返回给应用。"],
    local:["Returns this response directly from the gateway. A selected text file is saved with the rule.","网关直接返回此响应；选择的文本文件内容会随规则保存。"],
    reroute:["Forwards the request to this path on the same configured upstream.","将请求转发至同一上游的指定路径。"]
};

function safeHeaders(headers,request=false) {
    const entries=Object.entries(headers||{}).filter(([key,value]) => !opaque(value) &&
        (request?/^(?:accept|accept-language|content-type)$/i:/^(?:content-type|cache-control|content-language)$/i).test(key));
    return Object.fromEntries(entries.map(([key,value])=>[key,Array.isArray(value)?value.join(", "):String(value)]));
}
function retainedBody(part) {
    if(part?.body===undefined || opaque(pretty(part.body))) return "";
    if(part.bodyState==="form") {
        const pairs=Object.entries(part.body).flatMap(([key,item])=>[item].flat().map(value=>[key,value]));
        return new URLSearchParams(pairs).toString();
    }
    return part.bodyState==="json"?pretty(part.body):String(part.body);
}
function retainedPath(record) {
    const path=record?.path||"/";
    if(!record?.request?.url) return path;
    const url=new URL(record.request.url);
    if([...url.searchParams.values()].some(opaque)) url.search=new URLSearchParams([...url.searchParams].filter(([,value])=>!opaque(value))).toString();
    return url.pathname+url.search;
}
function draftId(network,base) {
    const ids=new Set(network.scenario.rules.map(r=>r.id));
    if(!ids.has(base)) return base;
    let suffix=2;
    while(ids.has(base+" ("+suffix+")")) suffix++;
    return base+" ("+suffix+")";
}
function emptyEdit() {return {target:"responseHeader",key:"",op:"set",find:"",value:""};}
export function replayDraft(record) {
    const method=record?.method||"GET",req=record?.request;
    const body=retainedBody(req);
    return {sourceId:record?.id,method,path:retainedPath(record),headers:pretty(safeHeaders(req?.headers,true)),body,
        removedQuery:req?.url && [...new URL(req.url).searchParams.values()].some(opaque),
        incomplete:entityAllowed(method) && Boolean(record) && (req?.body===undefined || opaque(pretty(req.body))),allowEmpty:false};
}
function ruleDraft(network,record,rule,seed) {
    const input=replayDraft(record), reply=record?.response;
    const capturedStatus=Number.isInteger(record?.status)&&record.status>=200&&record.status<=599?record.status:undefined;
    return {id:rule?.id||draftId(network,input.method+" "+(record?.path||"/items")),seedId:record?.id,existing:Boolean(rule),enabled:rule?.enabled!==false,
        method:rule?.method||input.method, field:rule?.match.field||"path", type:rule?.match.type||"exact", pattern:rule?.match.value||record?.path||"/items",
        suggestedPath:record?.path,suggestedUrl:record?.request?.url?new URL(retainedPath(record),record.request.url).href:undefined,
        action:rule?.action||"rewrite",edits:rule?.edits?copy(rule.edits):[seed?{...copy(seed),...(seed.value!==undefined&&{original:copy(seed.value)})}:emptyEdit()],
        requestMethod:rule?.request?.method||input.method,requestPath:rule?.request?.path||input.path,
        requestHeaders:rule?.request?pretty(rule.request.headers||{}):input.headers,requestBody:rule?.request?.body??input.body,
        responseStatus:String(rule?.response?.status??capturedStatus??(record?"":200)),
        missingResponseStatus:Boolean(record && capturedStatus===undefined && !rule?.response),
        responseHeaders:pretty(rule?.response?.headers||safeHeaders(reply?.headers)),responseBody:rule?.response?.body??retainedBody(reply),
        reroutePath:rule?.path||input.path,fileName:rule?.response?.fileName||""};
}

function parseHeaders(text,w) {
    let value;
    try {value=text.trim()?JSON.parse(text):{};} catch {throw new Error(w("Headers must be a JSON object with string values.","请用 JSON 对象填写请求头或响应头，值须为字符串。"));}
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.values(value).some(v=>typeof v!=="string"))
        throw new Error(w("Use a JSON object with string header values.","请用 JSON 对象填写，头部的值须为字符串。"));
    return value;
}
function headerValue(form,key,w) {
    return parseHeaders(readField(form,key,w),w);
}
function editedPath(form,key,w) {
    if (form[key+"Query"] === undefined) return localPath(form[key],w);
    const path=localPath(form[key],w);
    if(path.includes("?")) return path;
    const query=readField(form,key+"Query",w);
    return path+(query?"?"+query:"");
}
function localPath(value,w) {
    if(!/^\/(?!\/)/.test(value)||/[\\#\s]/.test(value)) throw new Error(w("Enter a relative path starting with /, including any query string.","请填写 / 开头的路径，可附带查询参数。"));
    return value;
}
export function toRule(form,w) {
    const id=form.id.trim(), value=form.pattern.trim();
    if(form.sequence) {
        if(!id)throw Object.assign(new Error(w("Enter a rule name.","请填写规则名称。")),{fieldId:"ns-id"});
        const editable=form.sequence.rules[0];
        const combined={...form.sequence,rules:[{...editable,id,method:form.method,path:value,enabled:form.enabled}],order:[id]};
        return scenarioValue(combined,w).rules[0];
    }
    if(!Object.hasOwn(actions,form.action))throw new Error(w("Choose what happens when the rule matches.","请先选择命中后的处理方式。"));
    if(!id||!value) throw new Error(w("Enter a rule name and match pattern.","请填写规则名称和匹配表达式。"));
    if(form.type==="regex") try {new RegExp(value);} catch {throw new Error(w("The match pattern is not a valid regular expression.","匹配表达式不是有效的正则表达式。"));}
    const rule={id,enabled:form.enabled,method:form.method,match:{type:form.type,field:form.field,value},action:form.action};
    if(form.action==="rewrite") {
        rule.edits=form.edits.map(edit=>{
            if(edit.target.endsWith("Json")){
                const path=pathParts(edit).map(part=>{
                    if(part.kind==="key")return part.value;
                    if(!/^(?:0|[1-9]\d*)$/.test(part.value)||!Number.isSafeInteger(Number(part.value)))throw new Error(w("Use a non-negative array index.","请输入非负整数作为数组下标。"));
                    return Number(part.value);
                });
                if(!path.length&&edit.op==="remove")throw new Error(w("Choose a field to remove.","请选择要删除的 JSON 属性。"));
                const operation={target:edit.target,path,op:edit.op};
                if(edit.op!=="remove"){
                    edit.jsonValue??=pretty(edit.value===undefined?"":edit.value);
                    const value=readField(edit,"jsonValue",w);
                    if(!value)throw Object.assign(new Error(w("Enter the replacement value.","请填写替换值。")),
                        {fieldId:"ns-edit-"+form.edits.indexOf(edit)+"-jsonValue-root-create"});
                    operation.value=JSON.parse(value);
                }
                return operation;
            }
            const isBody=edit.target.endsWith("Body"), find=["regex","literal"].includes(edit.op);
            if(!isBody&&!edit.key?.trim()) throw new Error(w("Enter a name for each header or query parameter.","请填写每条头部或查询参数修改的名称。"));
            if(find&&!edit.find) throw new Error(w("Enter the text or pattern to replace.","请填写要替换的文本或正则表达式。"));
            if(edit.op==="regex") try {new RegExp(edit.find);} catch {throw new Error(w("Check the replacement regular expression.","请检查替换操作的正则表达式。"));}
            if(edit.target==="query" && edit.occurrenceNumber!==undefined){
                if(edit.occurrenceNumber!=="" && (!/^[1-9]\d*$/.test(edit.occurrenceNumber)||!Number.isSafeInteger(Number(edit.occurrenceNumber))))
                    throw new Error(w("Enter a positive parameter position.","请输入从 1 开始的参数位置。"));
                edit.occurrence=edit.occurrenceNumber===""?undefined:Number(edit.occurrenceNumber)-1;
            }
            return {target:edit.target,op:edit.op,...(!isBody&&{key:edit.key.trim()}),...(find&&{find:edit.find}),
                ...(edit.target==="query" && edit.occurrence!==undefined && {occurrence:edit.occurrence}),
                ...(edit.op!=="remove"&&{value:edit.value||""})};
        });
    }
    if(form.action==="replaceRequest") rule.request={method:form.requestMethod,path:editedPath(form,"requestPath",w),
        headers:headerValue(form,"requestHeaders",w),...(entityAllowed(form.requestMethod)&&{body:readField(form,"requestBody",w)})};
    if(["local","replaceResponse"].includes(form.action)) {
        const status=Number(form.responseStatus);
        if(!Number.isInteger(status)||status<200||status>599) throw new Error(w("Enter a response status from 200 to 599.","响应状态码的范围为 200 至 599。"));
        rule.response={status,headers:headerValue(form,"responseHeaders",w),body:readField(form,"responseBody",w),
            ...(form.action==="local"&&form.fileName&&{fileName:form.fileName})};
    }
    if(form.action==="reroute") rule.path=localPath(form.reroutePath,w);
    return rule;
}
export function toReplay(form,w) {
    const hasBody=entityAllowed(form.method);
    const body=hasBody?readField(form,"body",w):"";
    if(hasBody && form.incomplete && !body && !form.allowEmpty) throw new Error(w("Enter a test body or select ‘Send with empty body’.","请填写测试正文，或勾选「使用空正文发送」。"));
    const value={method:form.method,path:editedPath(form,"path",w),headers:headerValue(form,"headers",w),...(hasBody&&{body}),sourceId:form.sourceId};
    if(opaque(pretty(value))) throw new Error(w("Replace redacted placeholders with test data.","请将脱敏占位符替换为测试数据。"));
    return value;
}

let state={page:"rules",feedback:{}}, replayPanel, composer;
const rulePanels=new Map(), pendingOperations=new Map(), composers=new Map();
const gateway={};
const translate=(en,zh)=>en;
function clearFeedback() {
    pendingOperations.delete(state.feedback.operationId);
    state.feedback={};
}
function parkPanel() {
    if(composers.get(state.key)===state) return;
    if(state.page==="resend") replayPanel=state;
    else rulePanels.set(state.scenarioId,state);
}
export function resumeStudioRules(network) {
    if(composers.get(state.key)!==state && state.page!=="resend" && state.scenarioId===network.activeScenarioId) return;
    parkPanel();
    if(network.scenarioLibrary) for(const id of rulePanels.keys()) {
        if(!network.scenarioLibrary.some(scene=>scene.id===id)) rulePanels.delete(id);
    }
    state=rulePanels.get(network.activeScenarioId)||{page:"rules",feedback:{},scenarioId:network.activeScenarioId};
}
export function resumeStudioReplay() {
    if(state.page==="resend") return true;
    if(!replayPanel) return false;
    parkPanel();
    state=replayPanel;
    return true;
}
export function resumeStudioComposer() {
    if(!composer)return false;
    parkPanel();
    state=composer;
    return true;
}
export function closeStudioComposer(network) {
    if(composer?.feedback.busyOperation==="networkUpsertRule")return false;
    if(composer)pendingOperations.delete(composer.feedback.operationId);
    resumeStudioRules(network);
    if(composer) composers.delete(composer.key);
    composer=undefined;
    return true;
}
function sourceDraftKey(id,seed) {
    return JSON.stringify(["request",id,seed==="sequence" ? "sequence" : seed?.target,seed?.path,seed?.key,seed?.occurrence]);
}
export function hasRequestRuleDraft(id,seed) {
    return composers.has(sourceDraftKey(id,seed));
}
export function resumeRequestRuleDraft(id,seed,network,send) {
    const saved=composers.get(sourceDraftKey(id,seed));
    if(!saved)return false;
    parkPanel();
    composer=state=saved;
    const owner=saved.form.owner.scenarioId;
    if(owner && owner!==network.activeScenarioId && network.scenarioLibrary?.some(group=>group.id===owner))
        send({type:"networkScenarioBrowse",id:owner});
    return true;
}
export function moveComposerResponse(from,to,render) {
    if(state!==composer || !state.form?.sequence || state.feedback.busyOperation)return false;
    if(!editorAction(state.form.sequence,{dataset:{net:"moveReply",row:"0-"+from,to:String(to)}}))return false;
    invalidate();render();return true;
}
export function openStudio(page,network,record,rule,seed) {
    if(page==="create") {
        const key=record ? sourceDraftKey(record.id,seed) : JSON.stringify(["group",network.activeScenarioId]);
        parkPanel();
        if(composers.has(key)) {
            composer=state=composers.get(key);
            return;
        }
        const sequence=seed==="sequence";
        const form=ruleDraft(network,record,undefined,sequence?undefined:seed);
        form.quickField=Boolean(seed && !sequence);
        if(sequence) {
            form.sequence=editScenario({name:"Sequence",rules:[rule]});
            form.id=rule.id;
            form.action="sequence";
        } else if(seed) form.id=draftId(network,record.method+" "+record.path+" · "+fieldName(seed));
        else if(record)form.action="";
        form.owner={scenarioId:network.activeScenarioId,originalRule:null};
        form.newGroupName="";
        composer=state={page:"rule",form,feedback:{},key};
        composers.set(key,composer);
        return;
    }
    if(page==="resend") {
        parkPanel();
        replayPanel=state={page,form:replayDraft(record),feedback:{}};
        return;
    }
    resumeStudioRules(network);
    const previous = state.parkedForm;
    const parked = rule && previous?.seedId===record?.id &&
        JSON.stringify(previous?.owner?.originalRule)===JSON.stringify(rule) ? previous : undefined;
    if(state.page==="rule") state.parkedForm=state.form;
    else if(parked) state.parkedForm=undefined;
    state.page=page;
    clearFeedback();
    state.removeId=state.rename=state.savedSourceId=undefined;
    state.form=undefined;
    if(page==="rule") {
        state.form=parked || ruleDraft(network,record,rule,seed);
        if(parked) return;
        state.form.quickField=Boolean(seed);
        if(seed) state.form.id=draftId(network,record.method+" "+record.path+" · "+fieldName(seed));
        state.form.owner={scenarioId:network.activeScenarioId,originalRule:rule?copy(rule):null};
    }
}
export function studioActive() {return state.page;}
export function editingRuleId() {return state.page==="rule" ? state.form.owner?.originalRule?.id : undefined;}
export function resendSourceId() {return state.page==="resend" ? state.form.sourceId : undefined;}
export function moveStudioRule(model,id,index,send,render) {
    const n=model.network;
    const originalRule=n.scenario.rules.find(rule=>rule.id===id);
    if (originalRule && !model.busy && !state.feedback.busyOperation) {
        request(send,"networkRuleOrder",{id,direction:index,scenarioId:n.activeScenarioId,scenarioVersion:n.scenarioVersion,originalRule});
        render();
    }
}
function request(send,type,payload) {
    const revision=crypto.randomUUID();
    clearFeedback();
    state.feedback={operationId:revision,busyOperation:type};
    pendingOperations.set(revision,state);
    send({type,...payload,revision});
}
export function observeStudio(n) {
    const op=n.operation;
    if(!op?.revision) return;
    if(op.revision===gateway.revision) {
        gateway.revision=undefined;
        gateway.notice={error:op.error};
        if(!op.error) {gateway.open=false;gateway.upstream=undefined;}
        return;
    }
    const panel=pendingOperations.get(op.revision);
    if(!panel) return;
    pendingOperations.delete(op.revision);
    const f=panel.feedback;
    f.busyOperation=undefined;
    if(f.changedDuringRequest && op.type==="networkPreviewRule") return;
    f.notice=op.error;f.noticeKind=op.error?"error":"success";
    if(op.error)return;
    if(op.type==="networkPreviewRule") {
        f.preview=op.preview;
        if(typeof document!=="undefined" && panel===state) queueMicrotask(()=>{
            const current=document.activeElement;
            if(current===document.body || current?.dataset.net==="studio-preview")
                document.querySelector(".ns-preview")?.scrollIntoView({block:"nearest"});
        });
    }
    if(op.type==="networkUpsertRule") {
        panel.savedSourceId=panel.form?.seedId;
        panel.page="rules";f.notice=["Rule saved","规则已保存"];
        if(composers.get(panel.key)===panel) {
            const focusRules=typeof document!=="undefined" && state===panel && document.getElementById("ns-compose-title");
            const scenarioId=panel.form.owner.scenarioId ?? n.activeScenarioId;
            const name=n.scenarioLibrary?.find(entry=>entry.id===scenarioId)?.name;
            if(name)f.notice=["Rule saved to “"+name+"”","规则已保存到「"+name+"」"];
            if(state===panel) {
                const group=rulePanels.get(scenarioId)||{scenarioId};
                if(group.page==="rule")group.parkedForm=group.form;
                if(!group.feedback?.busyOperation)
                    Object.assign(group,{page:"rules",form:undefined,feedback:f,savedSourceId:panel.savedSourceId});
                rulePanels.set(scenarioId,group);
                state=group;
            }
            composers.delete(panel.key);
            if(composer===panel)composer=undefined;
            if(focusRules)queueMicrotask(()=>document.getElementById("scenario-title")?.focus());
        }
    }
    if(op.type==="networkRuleUndo") f.notice=["Rule restored","规则已恢复"];
    if(op.type==="networkRuleCopy") f.notice=["Copy saved, currently disabled","已保存副本，暂未启用"];
    if(op.type==="networkRuleRename") {panel.rename=undefined;f.notice=["Rule renamed","规则已重命名"];}
    if(op.type==="networkReplay") f.replayId=op.recordId;
}
function button(id,title,options={}) {
    return actionButton(title, {primary: options.primary, disabled: options.disabled, attrs: {
        "data-net": "studio-"+id, "data-id": options.id, "data-index": options.index,
        "aria-label": options.title, title: options.title,
    }});
}
function fields(key,title,value,{choices,rows,placeholder="",disabled=false,index,mono=false,type="text"}={}) {
    const id="ns-"+(index==null?key:"edit-"+index+"-"+key);
    const attrs=`id="${id}" data-ns="${key}" ${index==null?"":`data-index="${index}"`} ${disabled?"disabled":""}`;
    const box=choices?`<select ${attrs}>${choices.map(([v,label])=>`<option value="${html(v)}" ${value===v?"selected":""}>${html(label)}</option>`).join("")}</select>`:
        rows?`<textarea ${attrs} rows="${rows}" spellcheck="false" placeholder="${html(placeholder)}">${html(value)}</textarea>`:
        `<input type="${type}" class="vscode-textfield" ${attrs} value="${html(value)}" spellcheck="false" placeholder="${html(placeholder)}">`;
    return `<label for="${id}" class="ns-field ${mono?"ns-mono":""}"><span>${html(title)}</span>${box}</label>`;
}
const methodOptions=any=>(any?["*",...requestMethods]:requestMethods).map(m=>[m,m]);
const options=(map,w)=>Object.entries(map).map(([key,v])=>[key,w(...v)]);
function note(msg){return `<p class="ns-note">${html(msg)}</p>`;}
export function manualMockStatus(n,w,busy) {
    const manual = Object.hasOwn(n,"gatewayRuleGroup") ? n.gatewayRuleGroup :
        n.rulesEnabled!==false && !n.scenario.paused && n.scenario.name;
    return `<div class="sc-manual-status" data-enabled="${!!manual}"><span>${w("Manual mocking","手动模拟")}</span>
        <strong>${html(manual || w("Off","已关闭"))}</strong>
        ${manual ? button("rulesOff",w("Turn off manual mocking","关闭手动模拟"),{disabled:busy}) : ""}</div>`;
}
function gatewayIndicator(n,w) {
    return `<div class="ns-gateway-status"><span class="ns-dot ${n.running?"on":""}" aria-hidden="true"></span>
        <strong>${w("Test gateway","测试网关")}</strong><span class="ns-quiet">${n.running?w("Running","运行中"):w("Stopped","已停止")}</span></div>`;
}
export function gatewayView(model,w,{replay=false,manualInHeader=false}={}) {
    const n=model.network;
    observeStudio(n);
    return `<section class="ns-gateway" aria-label="${w("Test gateway","测试网关")}">
        <div class="ns-gateway-head">${gatewayIndicator(n,w)}
        <div class="ns-tools">${!n.running||!replay?button("server",n.running?w("Stop gateway","停止网关"):w("Start gateway","启动网关"),{disabled:model.busy}):""}
        ${!replay && n.running && n.mappedDevice!==model.device?button("map",w("Connect phone","连接手机"),{disabled:!model.device||model.busy}):""}
        ${button("route",w("Configure route","配置路由"))}</div></div>
        ${!replay && !manualInHeader ? manualMockStatus(n,w,model.busy) : ""}
        ${!replay && n.caseRules ? `<p class="ns-route"><span>${w("Case run","用例运行")}</span>
            ${html(n.caseRules.names?.map(name=>name || w("Unnamed rule group","未命名规则组")).join(w(", ","、")) ||
                w("Rule groups off","规则组已关闭"))}</p>` : ""}
        <p class="ns-route"><span>${w("Upstream","上游")}</span>${n.upstream?`<code>${html(n.upstream)}</code>`:html(w("Local rules only","仅使用本地规则"))}</p>
        ${n.running?`<p class="ns-route"><span>${w("Gateway","网关")}</span><code>${html(n.baseUrl)}</code></p>`:""}
        ${!replay && n.running && n.mapping?`<p class="ns-route"><span>${w("Phone app base URL","手机应用 API 基址")} · ${html(n.mappedDevice)}</span><code>${html(n.mapping)}</code></p>`:""}
        ${gateway.open?`<div class="ns-route-form">${fields("upstream",w("Development upstream origin","开发上游地址"),gateway.upstream??n.upstream??"",
            {placeholder:"http://127.0.0.1:3000",mono:true})}
            ${note(w("Enter the origin of your local development service. Leave it empty to serve local rules only.","填写本机开发服务的源地址。留空时，网关仅提供本地规则。"))}
            <div class="ns-tools">${button("save-route",w("Save route","保存路由"),{primary:true,disabled:!!gateway.revision})}</div>
        </div>`:""}
        ${!replay && n.running && n.mapping?note(w("Set the test app’s API base URL to the phone address above.","将测试应用的 API 基址设为上方手机地址。")):""}
        ${!replay && n.pendingMappingCleanup?.length?note(w("Reconnect or refresh to release previous phone mappings · ","重新连接或刷新设备以清理旧映射 · ")+n.pendingMappingCleanup.join(", ")):""}
        ${gateway.notice?`<p class="ns-note" role="${gateway.notice.error?"alert":"status"}">${html(gateway.notice.error||w("Gateway route updated","网关路由已更新"))}</p>`:""}</section>`;
}
function originalRequest(n,id) {
    return n.records.find(r=>r.id===id) || n.favorites?.find(item=>item.record.id===id)?.record;
}
function returnExchange(n,id,w,quiet=false) {
    return id && originalRequest(n,id)?actionButton(w("Back to original request","返回原请求"),
        {quiet,className:quiet?"ns-parent":"",attrs:{"data-net":"returnExchange","data-id":id}}):"";
}
function backToRules(n,form,w) {
    return returnExchange(n,form.seedId,w)||button("list",w("Back to rules","返回规则列表"));
}
function parentScene(n,w) {
    return actionButton(n.scenario.name,{quiet:true,className:"ns-parent",attrs:{"data-net":"parentScene",
        "aria-label":w("Back to rule group ","返回规则组 ")+n.scenario.name}});
}
export function studioRuleControls(n,w,model,r,index) {
    const disabled=model.busy || Boolean(state.feedback.busyOperation);
    const enabled=r.enabled!==false;
    const name=(enabled?w("Disable ","停用 "):w("Enable ","启用 "))+r.id;
    return {
        tools:`<button type="button" class="sc-rule-switch" role="switch" aria-checked="${enabled}" data-net="studio-toggle"
            data-id="${html(r.id)}" aria-label="${html(r.id)} · ${w("Enabled","启用")}" title="${html(name)}" ${disabled?"disabled":""}><span></span></button>
            ${itemMenu(r.id+" · "+w("Rule actions","规则操作"),
                actionButton(w("Edit rule","编辑规则"),{disabled,attrs:{"data-net":"ruleOpen","data-id":r.id}})+
                button("toggle",enabled?w("Disable rule","停用规则"):w("Enable rule","启用规则"),{id:r.id,disabled})+
                button("copy",w("Duplicate","复制"),{id:r.id,disabled})+button("rename",w("Rename","重命名"),{id:r.id,disabled})+
                orderActions(w,index,n.scenario.rules.length)+button("remove",w("Remove","移除"),{id:r.id,disabled}),disabled)}`,
        edit:state.rename?.id===r.id?`<div class="ns-confirm"><label>${w("Rule name","规则名称")} <input id="ns-rename-rule" class="vscode-textfield" data-ns="renameRule" value="${html(state.rename.name)}"></label>
            ${button("rename-save",w("Save name","保存名称"),{id:r.id,disabled})} ${button("rename-cancel",w("Cancel","取消"))}</div>`:
            state.removeId===r.id?`<div class="ns-confirm"><span>${w("Remove this rule?","移除此规则？")}</span>${button("remove-confirm",w("Remove rule","确认移除"),{id:r.id,disabled})}
                ${button("remove-cancel",w("Cancel","取消"))}</div>`:""
    };
}
function ruleList(n,w,model) {
    const rules=n.scenario.rules;
    return `<div class="ns-heading"><div>${parentScene(n,w)}<h2>${w("Rules","规则")}</h2>${note(w("The first enabled match handles the request.","按优先级从上往下匹配，首条命中的启用规则处理请求。"))}</div>
        ${button("new",w("New rewrite rule","新建改写规则"),{primary:true})}</div>
        ${state.parkedForm?`<div class="ns-undo">${button("continue",w("Continue editing ","继续编辑 ")+state.parkedForm.id)}</div>`:""}
        ${n.removedRule?`<div class="ns-undo" role="status">${html(n.removedRule)} · ${w("Removed","已移除")} ${button("undo",w("Undo","撤销移除"),{id:n.removedRule})}</div>`:""}
        <ol class="ns-list" data-order-kind="rules" data-order-key="${html(n.activeScenarioId)}">${rules.map((r,i)=>{
            const legacy=!!r.steps,hit=n.hits.find(h=>h.ruleId===r.id)?.count||0;
            const title=ruleActionLabel(r,w);
            const controls=studioRuleControls(n,w,model,r,i);
            return `<li class="ns-rule-item ${r.enabled===false?"off":""}" data-item-actions data-rule-id="${html(r.id)}" data-order-index="${i}">
            <div class="ns-order" data-order-head>${!model.busy && rules.length>1?orderGrip(w):""}<span>${i+1}</span></div>
            <div class="ns-rule-main"><div><strong>${html(r.id)}</strong><span class="ns-mode">${title}</span></div>
            <code>${html(r.method)} ${html(r.match?.value||r.path)}</code><small>${r.enabled===false?w("Disabled","已停用"):w("Enabled","已启用")} · ${hit} ${w("gateway hits","次网关命中")}</small>
            </div><div class="ns-rule-actions">
            ${legacy?actionButton(w("Edit sequence","编辑顺序响应"),{attrs:{"data-net":"sceneRule","data-id":r.id}}):button("edit",w("Edit","编辑"),{id:r.id})}
            ${controls.tools}</div>${controls.edit}</li>`;
        }).join("")}</ol>${!rules.length?note(w("Add a rule here or create one from a captured request.","可以在此新建规则，也可以从已采集的请求创建规则。")):""}`;
}
function pathParts(edit) {
    return edit.pathParts??=(edit.path||[""]).map(part=>({kind:typeof part==="number"?"index":"key",value:String(part)}));
}
function jsonPathEditor(edit,index,w) {
    const parts=pathParts(edit);
    const rows=parts.map((part,j)=>{
        const attrs='data-index="'+index+'" data-segment="'+j+'"';
        return '<div class="ns-path-part"><select '+attrs+' data-ns="segmentKind" aria-label="'+w("Path segment type","路径片段类型")+'">'+
            '<option value="key" '+(part.kind==="key"?"selected":"")+'>'+w("Property","属性")+'</option><option value="index" '+(part.kind==="index"?"selected":"")+'>'+w("Array index","数组下标")+'</option></select>'+
            '<input class="vscode-textfield" id="ns-path-'+index+'-'+j+'" '+attrs+' data-ns="segmentValue" value="'+html(part.value)+'" aria-label="'+w("Path segment","路径片段")+' '+(j+1)+'">'+
            button("remove-segment",w("Remove","移除"),{index,id:String(j)})+'</div>';
    }).join("");
    return '<div class="ns-json-path"><strong>'+w("JSON field path","JSON 属性路径")+'</strong>'+rows+
        button("add-segment",w("+ Path segment","+ 路径片段"),{index})+'</div>';
}
function fieldName(edit) {
    if(!edit.path) return edit.key;
    return edit.path.reduce((label,part)=>typeof part==="number" ? label+"["+part+"]" :
        /^[a-zA-Z_$][\w$]*$/.test(part) ? (label?label+".":"")+part : label+"["+JSON.stringify(part)+"]","") || "$";
}
function editRow(edit,i,len,w,quick=false) {
    const isBody=edit.target.endsWith("Body"),json=edit.target.endsWith("Json"),find=["literal","regex"].includes(edit.op);
    const opOptions=options(operations,w).filter(([op])=>json?["set","remove"].includes(op):(!isBody||op!=="remove"));
    if(isBody&&edit.op==="remove") opOptions.push(["remove",w("Clear body","清空正文")]);
    let content;
    if(json){
        edit.jsonValue??=pretty(edit.value===undefined?"":edit.value);
        content=(quick?"":jsonPathEditor(edit,i,w))+(edit.op==="remove"?"":fieldView(edit,"jsonValue",{
            id:"ns-edit-"+i+"-jsonValue",label:w("New value","新值"),kind:"json",required:true,scalarDefault:true},w));
    }else if(find){
        content='<div class="ns-pair">'+fields("find",edit.op==="regex"?w("Regular expression","正则表达式"):w("Find text","查找文本"),edit.find,{index:i,mono:true})+
            fields("value",w("Replace with","替换为"),edit.value,{index:i,mono:true,placeholder:edit.op==="regex"?"$1":""})+'</div>';
    }else content=edit.op!=="remove"?fields("value",w("Value","值"),edit.value,{index:i,mono:true,rows:isBody?3:0}):"";
    if(quick) return `<section class="ns-quick-values"><div class="ns-quick-original"><strong>${w("Captured value","捕获值")}</strong>
        <pre>${html(pretty(edit.original))}</pre></div><div>${fields("op",w("Change","变更"),edit.op,{choices:options(operations,w).filter(([op])=>["set","remove"].includes(op) && (op!=="remove" || !json || edit.path.length)),index:i})}
        ${content}</div></section>`;
    return '<div class="ns-edit-row"><div class="ns-edit-line">'+fields("target",w("Field","字段"),edit.target,{choices:options(targets,w),index:i})+
        (!isBody&&!json?fields("key",w("Name","名称"),edit.key,{index:i,placeholder:edit.target==="query"?"page":"X-Test-Mode",mono:true}):"")+
        fields("op",w("Operation","操作"),edit.op,{choices:opOptions,index:i})+button("remove-edit","×",{index:i,disabled:len===1,title:w("Remove edit","移除此项修改")})+'</div>'+
        (edit.target==="query"?fields("occurrenceNumber",w("Occurrence (blank = all)","第几项同名参数（留空表示全部）"),
            edit.occurrenceNumber??(edit.occurrence===undefined?"":String(edit.occurrence+1)),{index:i,type:"number"}):"")+
        (edit.original!==undefined?'<p class="ns-note">'+w("Captured value","捕获值")+' <code>'+html(JSON.stringify(edit.original))+'</code></p>':"")+content+'</div>';
}
function headerFields(form,key,title,w) {
    return fieldView(form,key,{id:"ns-"+key,label:title,kind:"headers"},w);
}
function pathFields(form,key,w) {
    if(form[key+"Query"]===undefined) {
        const full=form[key], split=full.indexOf("?");
        form[key+"Query"]=split<0?"":full.slice(split+1);
        form[key]=split<0?full:full.slice(0,split);
    }
    return fields(key,w("Path","路径"),form[key],{mono:true});
}
function queryFields(form,key,w) {
    return fieldView(form,key+"Query",{id:"ns-"+key+"Query",label:w("Query parameters","查询参数"),kind:"query"},w);
}
function bodyFields(form,key,headersKey,title,w) {
    // The raw mode remains available for plain-text, form and omitted bodies.
    const headers=JSON.parse(form[headersKey]||"{}");
    const json=Object.entries(headers).some(([k,v])=>k.toLowerCase()==="content-type" && /\bjson\b/i.test(v));
    return fieldView(form,key,{id:"ns-"+key,label:title,kind:json?"json":"body"},w);
}
function bodyRequest(form,w) {
    return `<div class="ns-method-path">${fields("requestMethod",w("Send as","请求方法"),form.requestMethod,{choices:methodOptions(false)})}
        ${pathFields(form,"requestPath",w)}</div>${queryFields(form,"requestPath",w)}
        ${headerFields(form,"requestHeaders",w("Request headers","请求头"),w)}
        ${entityAllowed(form.requestMethod)?bodyFields(form,"requestBody","requestHeaders",w("Request body","请求正文"),w):""}`;
}
function bodyResponse(form,w,{focused=false}={}) {
    const local=form.action==="local";
    const missing=form.missingResponseStatus?note(w("No usable HTTP response was captured. Enter the status and body for the test response.","此请求未采集到可用的 HTTP 响应。请填写测试响应的状态码和正文。")):"";
    const status=fields("responseStatus",w("Status code","状态码"),form.responseStatus,{mono:true});
    const file=local?`<label class="ns-file"><span>${w("Import text file","导入文本文件")}</span><input type="file" id="ns-file" data-ns="file"></label>`:"";
    const embedded=local&&form.fileName?`<div class="ns-note">${w("Embedded file","已嵌入文件")} <code>${html(form.fileName)}</code></div>`:"";
    const headers=headerFields(form,"responseHeaders",w("Response headers","响应头"),w);
    const body=bodyFields(form,"responseBody","responseHeaders",w("Response body","响应正文"),w);
    if(!focused)return `${missing}<div class="ns-response-top">${status}${file}</div>${embedded}${headers}${body}`;
    return `${missing}<div class="ns-response-top">${status}</div>${embedded}${body}
        <details id="ns-compose-response-options"><summary>${local?w("Response headers and file import","响应头和文件导入"):w("Response headers","响应头")}</summary>
            ${headers}${file}
        </details>`;
}
const matchFields={path:["Path","路径"],url:["Full URL","完整 URL"]};
const matchTypes={exact:["Exact","精确"],glob:["Wildcard","通配符"],regex:["Regular expression","正则表达式"]};
function ruleMatchFields(form,w) {
    return `<div class="ns-match-options">${fields("method",w("Method","方法"),form.method,{choices:methodOptions(true).map(([v,l])=>[v,v==="*"?w("Any","全部"):l])})}
        ${fields("field",w("Match against","匹配范围"),form.field,{choices:options(matchFields,w)})}
        ${fields("type",w("Pattern type","匹配方式"),form.type,{choices:options(matchTypes,w)})}</div>
        ${fields("pattern",w("Pattern","匹配表达式"),form.pattern,{mono:true,placeholder:form.type==="regex"?"^/catalog/[^/]+$":form.type==="glob"?"/catalog/*":"/catalog/items"})}
        ${note(form.field==="url"?w("Full URL includes the origin and query. Gateway traffic uses the configured upstream origin.","完整 URL 包含来源和查询参数。网关流量使用配置的上游来源。"):
            w("Path matching ignores the origin and query string.","路径匹配忽略来源和查询参数。"))}`;
}
function ruleOperationFields(form,w,options) {
    if(form.action==="rewrite")return `<div class="ns-edits">${form.edits.map((e,i)=>editRow(e,i,form.edits.length,w)).join("")}</div>
        ${button("add-edit",w("Add field edit","添加字段修改"))}`;
    if(form.action==="replaceRequest")return bodyRequest(form,w);
    if(form.action==="reroute")return fields("reroutePath",w("Upstream path","上游路径"),form.reroutePath,{mono:true});
    return bodyResponse(form,w,options);
}
function enableRule(form,w) {
    return `<label class="ns-check"><input type="checkbox" id="ns-enabled" data-ns="enabled" ${form.enabled?"checked":""}>${w("Enable when saved","保存后启用")}</label>`;
}
function ruleForm(n,w,model) {
    const form=state.form,onlyLocal=form.action==="local";
    const {busyOperation}=state.feedback;
    const commit=`<div class="ns-apply">${enableRule(form,w)}
        <div class="ns-tools">${button("preview",w("Preview on history","预览历史匹配"),{disabled:!!busyOperation||model.busy})}
            ${button("apply",w("Save rule","保存规则"),{primary:true,disabled:!!busyOperation||model.busy})}</div></div>`;
    if(form.quickField) {
        const edit=form.edits[0];
        return `<div class="ns-quick"><header class="ns-heading"><div><span class="ns-quiet">${w(...targets[edit.target])}</span>
            <h2><code>${html(fieldName(edit))}</code></h2><p class="ns-quick-route"><code>${html(form.method)} ${html(form.pattern)}</code>${edit.occurrence===undefined?"":" · "+w("Occurrence ","第 ")+(edit.occurrence+1)+w(""," 项")}</p></div>
            ${backToRules(n,form,w)}</header>
            ${editRow(edit,0,1,w,true)}
            <section class="ns-quick-destination">${fields("id",w("Rule name","规则名称"),form.id)}
            <div><span>${w("Save to rule group","保存到规则组")}</span>${parentScene(n,w)}</div></section>
            ${commit}<div class="ns-quick-more">${button("expand",w("Edit matching and additional fields","编辑匹配范围与其他字段"))}</div></div>`;
    }
    return `<div class="ns-heading"><div>${parentScene(n,w)}<h2>${form.existing?w("Edit rule","编辑规则"):w("New rule","新建规则")}</h2></div>
        ${backToRules(n,form,w)}</div>
        <section class="ns-block"><h3>${w("Match requests","匹配请求")}</h3>
        ${fields("id",w("Rule name","规则名称"),form.id)}
        ${ruleMatchFields(form,w)}</section>
        <section class="ns-block"><h3>${w("When a request matches","命中后的操作")}</h3>
        ${fields("action",w("Action","操作类型"),form.action,{choices:options(actions,w)})}
        ${note(w(...actionNotes[form.action]))}
        ${ruleOperationFields(form,w)}</section>
        ${commit}
        ${!onlyLocal&&!n.upstream?note(w("Configure a local upstream to apply this action to gateway traffic.","配置本机上游后，此操作才可处理经过网关的请求。")):""}`;
}

const mainActions=["local","rewrite"], moreActions=["replaceResponse","replaceRequest","reroute"];
const actionChoices={
    local:["The gateway returns a response you define.","由测试网关直接返回你填写的响应。"],
    rewrite:["Edit parameters, headers or fields in the body.","修改参数、头部或正文中的指定字段。"],
    replaceResponse:["Replace the response after the upstream returns.","等上游返回后，再替换整个响应。"],
    replaceRequest:["Send a different request to the upstream.","用你填写的完整请求访问上游。"],
    reroute:["Keep the same upstream and change the path.","沿用当前上游，改用另一个路径。"]
};
function actionChoice(key,form,w) {
    return `<label class="ns-action-choice"><input type="radio" name="ns-action" id="ns-action-${key}" data-ns="action" value="${key}" ${form.action===key?"checked":""}>
        <span><strong>${w(...actions[key])}</strong><small>${w(...actionChoices[key])}</small></span></label>`;
}
function ruleComposer(n,w,model,feedback) {
    const form=state.form, {busyOperation}=state.feedback;
    const canSave=Boolean(form.action) && form.owner.scenarioId===n.activeScenarioId && !busyOperation && !model.busy;
    const saving=busyOperation==="networkUpsertRule";
    const destinationGroups=(n.scenarioLibrary || []).map(group=>[group.id,
        group.name+(n.rulesEnabled!==false && !group.paused && group.id===(n.gatewayScenarioId||n.activeScenarioId)?
            w(" (manual mocking)","（手动模拟）"):"")]);
    const firstGroup=!destinationGroups.length;
    if(!destinationGroups.some(([id])=>id===form.owner.scenarioId))
        destinationGroups.unshift([form.owner.scenarioId,w("Select a rule group","请选择规则组")]);
    const destination=n.scenarioLibrary?.find(group=>group.id===form.owner.scenarioId);
    const name=destination?.name || form.newGroupName?.trim();
    const affectsLive=destination && destination.id===(n.gatewayScenarioId||n.activeScenarioId) &&
        n.running && form.enabled && n.rulesEnabled!==false && !destination.paused;
    const matchMethod=form.method==="*"?w("Any method","所有方法"):form.method;
    return `<article class="ns-compose" aria-labelledby="ns-compose-title">
        <header class="ns-compose-head">
            ${returnExchange(n,form.seedId,w,true) || actionButton(w("Back to rule group","返回规则组"),{quiet:true,className:"ns-parent",attrs:{"data-net":"parentScene"}})}
            <div class="ns-compose-title-row"><h2 id="ns-compose-title" tabindex="-1">${form.sequence?w("Create response sequence","创建顺序响应"):form.seedId?w("Create rule from request","从请求创建规则"):w("New rule","新建规则")}</h2>${gatewayIndicator(n,w)}</div>
        </header>
        <fieldset class="ns-compose-fields" ${saving?"disabled":""} aria-labelledby="ns-compose-title">
        <section class="ns-compose-match" aria-labelledby="ns-compose-match-title">
            <h3 id="ns-compose-match-title">${w("Which requests match?","匹配哪些请求")}</h3>
            <div class="ns-match-summary"><span class="net-method">${html(matchMethod)}</span><code>${html(form.pattern||w("No match pattern entered","尚未填写匹配表达式"))}</code>
                <small>${w(...matchTypes[form.type])} · ${w(...matchFields[form.field])}</small></div>
            ${form.quickField?"":`<details id="ns-compose-match"><summary>${w("Edit match conditions","修改匹配条件")}</summary><div class="ns-match-fields">${form.sequence?fields("method",w("Method","方法"),form.method)+fields("pattern",w("Match path","匹配路径"),form.pattern):ruleMatchFields(form,w)}</div></details>`}
        </section>
        <section class="ns-compose-action" aria-labelledby="ns-compose-action-title">
            <h3 id="ns-compose-action-title">${w("What happens on a match?","命中后怎么处理")}</h3>
            ${form.sequence?drawEditor(form.sequence,w,0,{single:true,locked:saving}):form.quickField?`<div class="ns-action-fields"><h4>${w(...targets[form.edits[0].target])} <code>${html(fieldName(form.edits[0]))}</code></h4>
                ${editRow(form.edits[0],0,1,w,true)}${button("expand",w("Edit matching and other fields","编辑匹配条件和其他字段"))}</div>`:
            `<div role="group" aria-labelledby="ns-compose-action-title">
                <div class="ns-action-choices">${mainActions.map(key=>actionChoice(key,form,w)).join("")}</div>
                <details id="ns-compose-more" ${moreActions.includes(form.action)?"open":""}><summary>${w("More actions","更多处理方式")}</summary>
                    <div class="ns-action-choices">${moreActions.map(key=>actionChoice(key,form,w)).join("")}</div></details></div>
                ${form.action?`<div class="ns-action-fields">${form.action==="rewrite"?note(w(...actionNotes.rewrite)):""}
                    ${ruleOperationFields(form,w,{focused:true})}
                    ${form.action!=="local"&&!n.upstream?note(w("This action needs a development upstream configured in the test gateway.","此操作需要在测试网关配置开发上游。")):""}</div>`:""}`}
        </section>
        <section class="ns-compose-destination" aria-labelledby="ns-compose-destination-title">
            <h3 id="ns-compose-destination-title">${w("Save to rule group","保存到规则组")}</h3>
            <div class="ns-destination-fields">${firstGroup ? fields("newGroupName",w("New rule group name","新规则组名称"),form.newGroupName,{disabled:saving}) :
                fields("destination",w("Rule group","规则组"),form.owner.scenarioId,{choices:destinationGroups,disabled:saving})}
                ${fields("id",w("Rule name","规则名称"),form.id,{disabled:saving})}</div>
            ${enableRule(form,w)}
            ${note(w("New rules take first priority.","新规则排在组内第一位。")+(affectsLive?w(" Saving affects the running gateway immediately.","保存后立即影响当前网关。"):""))}
            ${destination && form.owner.scenarioId!==n.activeScenarioId?button("browse-destination",w("Open destination","查看目标规则组")):""}
        </section>
        </fieldset>
        ${scopePreview(n,w)}
        ${feedback}
        <footer class="ns-compose-footer">
            ${actionButton(w("Cancel","取消"),{disabled:saving,attrs:{"data-net":"cancelRuleDraft","data-id":form.seedId}})}
            <div class="ns-tools">
                ${button("preview",busyOperation==="networkPreviewRule"?w("Previewing…","正在预览…"):w("Preview on captured requests","预览历史匹配"),{disabled:!canSave})}
                ${button("apply",saving?w("Saving…","正在保存…"):name?w("Save to ","保存到 ")+name:w("Save rule","保存规则"),{primary:true,disabled:!canSave})}
            </div>
        </footer></article>`;
}
function sampleDiff(before,after,response,w) {
    if(!after)return "";
    const project=part=>part && Object.fromEntries((response?["status","headers","body"]:["method","url","headers","body"])
        .filter(key=>part[key]!==undefined).map(key=>[key,part[key]]));
    const changes=changedFields(project(before),project(after));
    if(!changes.length)return "";
    function line(value,css,prefix){
        if(value===undefined)return "";
        const text=typeof value==="string"?JSON.stringify(value):pretty(value);
        return '<pre class="'+css+'"><span>'+prefix+' </span>'+html(text.slice(0,4000))+(text.length>4000?"…":"")+'</pre>';
    }
    return '<div class="ns-changes"><h4>'+(response?w("Response changes","响应变更"):w("Request changes","请求变更"))+'</h4>'+
        changes.map(change=>'<div class="ns-diff"><strong>'+html(change.path)+'</strong>'+line(change.before,"removed","−")+line(change.after,"added","+")+'</div>').join("")+'</div>';
}
function scopePreview(n,w) {
    const {preview}=state.feedback;
    if(!preview)return "";
    const count=preview.matchedIds.length, gateway=preview.gateway;
    const stale=gateway && ((gateway.origin||"")!==(n.upstream||n.baseUrl||"") || (gateway.upstream||"")!==(n.upstream||"")
        || preview.scenarioVersion!==undefined && preview.scenarioVersion!==n.scenarioVersion);
    const inactive=n.gatewayScenarioId && n.gatewayScenarioId!==n.activeScenarioId;
    const routeNotes=stale?note(w("The rule group or gateway route changed. Preview again to refresh the winning rule.","规则组或网关地址已变更，请重新预览以查看当前命中规则。")):gateway?`<div class="ns-route-result"><h4>${inactive?w("If the gateway used this rule group","网关使用此规则组时的匹配预估"):w("Gateway selection after saving","保存后网关的选取结果")}</h4>
        ${note(gateway.origin?w("Match origin · ","匹配源地址 · ")+gateway.origin:w("Start the gateway or configure its upstream to calculate the destination URLs.","启动测试网关或配置上游后，可计算实际匹配的 URL。"))}
        ${gateway.origin?note(w("Destination URLs matching the pattern · ","按网关目标 URL 符合条件 · ")+gateway.gatewayMatches+" / "+preview.total+
            w(" · Draft selected by priority · "," · 按优先级将选中此规则 · ")+gateway.applicable):""}
        ${gateway.paused?note(w("Resume the rule group to apply its rules.","恢复此规则组后，网关才会执行其中的规则。")):""}
        ${gateway.disabled?note(w("Enable this rule to make it eligible.","请启用此规则，使其参与匹配。")):""}
        ${gateway.needsUpstream?note(w("This action needs a local upstream. A winning match currently returns HTTP 503.","此操作需要本地上游。当前即使命中也会返回 HTTP 503。")):""}
        ${!gateway.origin||gateway.paused||gateway.needsUpstream?parentScene(n,w):""}</div>`:"";
    return `<section class="ns-preview" aria-live="polite"><div class="ns-preview-head"><h3>${w("History preview","历史匹配预览")}</h3>
        <strong>${count} / ${preview.total}</strong></div>
        ${note(w("Matching retained exchanges. Preview leaves gateway hit counts unchanged.","仅匹配已保留的记录。预览不会增加网关实际命中次数。"))}
        ${!count?note(w("No retained request matches the method and pattern.","已保留请求中没有符合当前方法及表达式的记录。")):""}
        ${routeNotes}
        ${preview.examples.map((item,i)=>{
            const rec=n.records.find(r=>r.id===item.id) || n.favorites?.find(f=>f.record.id===item.id)?.record;
            const req=sampleDiff(item.request,item.effectiveRequest,false,w);
            const resp=sampleDiff(item.originalResponse||rec?.response,item.response,true,w);
            const route=!stale&&item.route;
            return `<details id="ns-hit-${i}" ${i===0?"open":""}><summary><code>${html(item.request?.method||rec?.method)} ${html(item.request?.path||rec?.path)}</code></summary>
            ${route?`<p class="ns-route"><span>${w("Captured URL","采集 URL")}</span><code>${html(item.request.url)}</code></p>
            <p class="ns-route"><span>${w("Gateway match URL","网关匹配 URL")}</span><code>${html(route.url)}</code></p>
            ${note(route.winner?w("Winning rule · ","优先命中 · ")+route.winner:w("No enabled rule wins this request.","此请求不会命中启用的规则。"))}
            ${!route.matches&&item.historical?note(w("To match this path on the gateway, choose Path or update the URL pattern to its match URL.","如需在网关匹配此路径，可选择按路径匹配，或将 URL 匹配条件改为上方网关 URL。")):""}`:""}
            ${req||resp?note(w("Estimated edits on the retained exchange","以下改动按历史记录估算")):""}${req}${resp}${item.unavailable?note(w("Some fields were not retained in this exchange.","本条记录的部分字段未保留。")):""}
            ${!req&&!resp&&!item.unavailable&&item.historical!==false?note(w("No retained value changed in this example.","此样本中已保留的字段值没有变化。")):""}</details>`;
        }).join("")}</section>`;
}
function resendView(n,w,model,embedded) {
    const {replayId,busyOperation}=state.feedback;
    const f=state.form,rec=originalRequest(n,f.sourceId),entity=entityAllowed(f.method);
    const result=n.records.find(r=>r.id===replayId);
    return `<div class="ns-heading"><div><h2>${w("Edit and resend","编辑并重发")}</h2>
        ${note(w("Sends one request through the test gateway and records a new exchange.","通过测试网关发送一次请求，并保存为一条新记录。"))}</div>
        ${embedded ? actionButton(w("Close editor","收起重发编辑"),{quiet:true,attrs:{"data-net":"closeResend"}}) :
            returnExchange(n,f.sourceId,w)||actionButton(w("Back to requests","返回网络请求"),{attrs:{"data-net":"requests"}})}</div>
        ${rec?`<p class="ns-route"><span>${w("Original request","原始请求")}</span><code>${html(rec.method)} ${html(rec.request.url||rec.path)}</code></p>`:""}
        <section class="ns-block"><div class="ns-method-path">${fields("method",w("Method","方法"),f.method,{choices:methodOptions(false)})}
        ${pathFields(f,"path",w)}</div>${queryFields(f,"path",w)}
        ${headerFields(f,"headers",w("Request headers","请求头"),w)}
        ${f.removedQuery?note(w("Redacted query values were omitted. Add test values in the parameter rows.","已省略脱敏查询值。如需此参数，请在查询参数行补上测试值。")):""}
        ${entity?bodyFields(f,"body","headers",w("Request body","请求正文"),w):""}
        ${entity&&f.incomplete?`<div class="ns-missing">${note(w("The original body was unavailable or redacted. Enter test data or choose an empty body.","原始正文未保留或包含脱敏字段。请填写测试数据，也可选择发送空正文。"))}
            <label class="ns-check"><input type="checkbox" id="ns-allowEmpty" data-ns="allowEmpty" ${f.allowEmpty?"checked":""}>${w("Send with empty body","使用空正文发送")}</label></div>`:""}
        ${note(w("Only retained content headers are copied. The gateway receives the edited request at the relative path above.","仅带入已保留的内容相关请求头。编辑后的请求会发往测试网关的上述相对路径。"))}</section>
        ${gatewayView(model,w,{replay:true})}
        <div class="ns-apply"><span class="ns-quiet">${n.running?html(w("Rule group · ","规则组 · ")+n.scenario.name):w("Start the test gateway to send.","启动测试网关后即可发送。")}</span>
        ${button("send",w("Send once","发送一次"),{primary:true,disabled:!n.running||!!busyOperation||model.busy})}</div>
        ${result?`<div class="ns-result" role="status"><strong>HTTP ${html(result.status)}</strong><span>${html(result.method)} ${html(result.path)}</span>
        ${actionButton(w("View new exchange","查看新记录"),{attrs:{"data-net":"openExchange","data-id":result.id}})}
        ${rec&&!embedded?actionButton(w("Compare with original","与原请求对比"),{attrs:{"data-net":"compareReplay","data-id":result.id}}):""}</div>
        ${rec&&embedded?`<details class="ns-resend-diff" id="ns-resend-diff" open><summary>${w("Original vs resend","原请求与本次重发")}</summary>
            ${diffRows(exchangeDifferences(rec,result),{before:w("Original","原请求"),after:w("Resend","重发结果")},w)}</details>`:""}`:""}`;
}
export function studioView(model,w,{embedded=false,creating=false}={}) {
    const n=model.network;
    if(!creating && state.page!=="resend") resumeStudioRules(n);
    observeStudio(n);
    state.words=w;
    const {busyOperation,noticeKind,notice}=state.feedback;
    const feedback=notice?`<div class="ns-message ${noticeKind==="error"?"error":""}" role="${noticeKind==="error"?"alert":"status"}">${html(Array.isArray(notice)?w(...notice):notice)}
        ${state.page==="rules"&&state.savedSourceId?returnExchange(n,state.savedSourceId,w):""}
        ${noticeKind==="error" && state.page==="rule" && state.form.existing?button("fork",w("Keep as new draft","保留为新规则草稿")):""}</div>`:"";
    if(creating)return `<section class="net-studio net-studio-compose">${ruleComposer(n,w,model,feedback)}</section>`;
    const resume=state.parkedForm ? button("continue",w("Continue editing ","继续编辑 ")+state.parkedForm.id) : "";
    if (embedded && state.page==="rules" && !feedback && !resume && !busyOperation) return "";
    return `<section class="net-studio${embedded?" net-studio-inline":""}">${state.page==="rules"?feedback+(embedded?resume:ruleList(n,w,model)):state.page==="rule"?ruleForm(n,w,model):resendView(n,w,model,embedded)}
        ${busyOperation?`<p class="ns-note" role="status">${w("Working…","处理中…")}</p>`:""}
        ${state.page==="rules"?"":feedback}
        ${scopePreview(n,w)}</section>`;
}
function setError(error){state.feedback={notice:error.message,noticeKind:"error"};}
function invalidate() {
    const f=state.feedback;
    if(!f.busyOperation){clearFeedback();return;}
    f.changedDuringRequest=true;f.notice=f.noticeKind=f.preview=f.replayId=undefined;
}
function defaultMethodChoices(value) {return ["method","requestMethod","field","type","target","op","action"].includes(value);}
function requestFile(input,render) {
    const file=input.files?.[0],form=state.form,w=state.words||translate;
    if(!file)return;
    if(file.size>96*1024){setError(new Error(w("Choose a text file under 96 KiB.","请选择不超过 96 KiB 的文本文件。")));render();return;}
    file.arrayBuffer().then(data=>{
        if(state.form!==form||state.page!=="rule")return;
        const text=new TextDecoder("utf-8",{fatal:true}).decode(data);
        if(text.includes("\0"))throw new Error();
        const headers=headerValue(form,"responseHeaders",w);
        if(!Object.keys(headers).some(key=>key.toLowerCase()==="content-type"))
            headers["content-type"]=file.type||(/\.json$/i.test(file.name)?"application/json":"text/plain; charset=utf-8");
        form.responseHeaders=pretty(headers);form.fileName=file.name;form.responseBody=text;
        resetField(form,"responseBody");resetField(form,"responseHeaders");
        render();
    }).catch(()=>{if(state.form===form){setError(new Error(w("Could not read this file as UTF-8 text. Check the file and response headers.","无法导入为 UTF-8 文本。请检查文件内容与响应头。")));render();}});
}
export function studioInput(el,render,send) {
    if(state===composer && state.form?.sequence && el.dataset.ne && updateEditor(state.form.sequence,el)) {
        invalidate();
        return true;
    }
    const {notice,preview,replayId}=state.feedback;
    if(el.dataset.fe && el.dataset.prop) {
        const studio=el.dataset.fe.startsWith("ns-") || state===composer && state.form?.sequence && el.dataset.fe.startsWith("ne-"),clear=studio && !!(notice||preview||replayId);
        if(studio){invalidate();if(el.dataset.fe==="ns-responseBody"&&state.form)state.form.fileName="";}
        const handled=fieldInput(el,render);
        if(handled && clear)render();
        return handled;
    }
    const key=el.dataset.ns;
    if(!key)return false;
    if(key==="newGroupName" && state===composer)state.form.owner.scenarioId=undefined;
    if(key==="destination"){
        if(state===composer && state.form.owner.scenarioId!==el.value && send){
            invalidate();
            state.form.owner.scenarioId=el.value;
            send({type:"networkScenarioBrowse",id:el.value});
            render();
        }
        return true;
    }
    if(key==="renameRule" && state.rename){state.rename.name=el.value;return true;}
    if(key==="upstream"){gateway.upstream=el.value;gateway.notice=undefined;return true;}
    const i=el.dataset.index;
    const hadFeedback=!!(preview||notice||replayId);
    invalidate();
    const target=i==null?state.form:state.form.edits[Number(i)];
    if(key==="segmentKind"||key==="segmentValue"){
        const part=pathParts(target)[Number(el.dataset.segment)];
        if(key==="segmentKind"){part.kind=el.value;if(el.value==="index"&&!/^\d+$/.test(part.value))part.value="0";render();}
        else {part.value=el.value;if(hadFeedback)render();}
        return true;
    }
    if(key==="file"){requestFile(el,render);return true;}
    if((key==="requestPath"||key==="path") && target[key+"Query"]!==undefined && el.value.includes("?")){
        const split=el.value.indexOf("?");
        target[key]=el.value.slice(0,split);target[key+"Query"]=el.value.slice(split+1);
        resetField(target,key+"Query");
        render();
        if(!target[key+"Query"] && typeof document!=="undefined")document.getElementById("ns-"+key+"Query-root-add")?.click();
        return true;
    }
    if(key==="field"&&target.suggestedUrl&&target.type==="exact") {
        if(el.value==="url"&&target.pattern===target.suggestedPath) target.pattern=target.suggestedUrl;
        if(el.value==="path"&&target.pattern===target.suggestedUrl) target.pattern=target.suggestedPath;
    }
    target[key]=el.type==="checkbox"?el.checked:el.value;
    if(key==="target"&&target.target.endsWith("Body")&&target.op==="remove")target.op="set";
    if(key==="target"&&target.target.endsWith("Json")&&!["set","remove"].includes(target.op))target.op="set";
    if(key==="responseBody")target.fileName="";
    if(defaultMethodChoices(key)||hadFeedback||(state===composer && ["pattern","newGroupName","enabled"].includes(key)))render();
    return true;
}
export function studioClick(el,model,send,render) {
    const action=el.dataset.net;
    if(state===composer && state.form?.sequence && ["addreply","rmreply","moveReply"].includes(action)) {
        if(!state.feedback.busyOperation && editorAction(state.form.sequence,el)){invalidate();render();}
        return true;
    }
    if(action?.startsWith("field-")){
        if((el.dataset.fe?.startsWith("ns-") || state===composer && state.form?.sequence && el.dataset.fe?.startsWith("ne-")) &&
            !["field-mode","field-fold","field-more"].includes(action)){
            invalidate();if(el.dataset.fe==="ns-responseBody"&&state.form)state.form.fileName="";
        }
        return fieldClick(el,render);
    }
    if(!action?.startsWith("studio-"))return false;
    const key=action.slice(7),id=el.dataset.id,n=model.network,w=state.words||translate;
    const {busyOperation}=state.feedback;
    try {
        switch(key) {
        case "browse-destination":if(state===composer && state.form.owner.scenarioId)send({type:"networkScenarioBrowse",id:state.form.owner.scenarioId});break;
        case "server":send({type:"networkServer"});break;
        case "map":send({type:"networkMap"});break;
        case "rulesOff":send({type:"networkManualRulesOff"});break;
        case "route":gateway.open=!gateway.open;gateway.upstream=n.upstream||"";gateway.notice=undefined;break;
        case "save-route":
            if(!gateway.revision){
                gateway.revision=crypto.randomUUID();gateway.notice=undefined;
                send({type:"networkUpstream",origin:(gateway.upstream||"").trim(),revision:gateway.revision});
            }
            break;
        case "new":openStudio("rule",n);break;
        case "expand":state.form.quickField=false;break;
        case "list":openStudio("rules",n);break;
        case "continue":
            if(state.parkedForm) {
                clearFeedback();state.form=state.parkedForm;state.parkedForm=undefined;state.page="rule";
            }
            break;
        case "edit":{const rule=n.scenario.rules.find(r=>r.id===id);if(rule?.match)openStudio("rule",n,undefined,rule);break;}
        case "up":case "down":case "toggle":case "copy":case "rename-save":case "remove-confirm":{
            const rule=n.scenario.rules.find(item=>item.id===id);
            if(!rule)break;
            const type={up:"networkRuleOrder",down:"networkRuleOrder",toggle:"networkRuleToggle",copy:"networkRuleCopy","rename-save":"networkRuleRename","remove-confirm":"networkRuleRemove"}[key];
            const originalRule=key==="rename-save"?state.rename?.original:rule;
            request(send,type,{id,direction:key,scenarioId:n.activeScenarioId,originalRule,name:key==="copy"?draftId(n,id+w(" copy"," 副本")):state.rename?.name});
            state.removeId=undefined;break;
        }
        case "undo":request(send,"networkRuleUndo",{id,scenarioId:n.activeScenarioId});break;
        case "rename":{state.rename={id,name:id,original:n.scenario.rules.find(item=>item.id===id)};
            queueMicrotask(()=>{const field=document.getElementById("ns-rename-rule");field?.focus();field?.select();});break;}
        case "rename-cancel":state.rename=undefined;break;
        case "fork":state.form.id=draftId(n,state.form.id+w(" copy"," 副本"));state.form.existing=false;state.form.enabled=false;
            state.form.owner={scenarioId:n.activeScenarioId,originalRule:null};clearFeedback();break;
        case "remove":state.removeId=id;break;
        case "remove-cancel":state.removeId=undefined;break;
        case "add-segment":case "remove-segment":{
            const parts=pathParts(state.form.edits[Number(el.dataset.index)]);
            const i=key==="add-segment"?parts.length:Number(id);
            if(key==="add-segment")parts.push({kind:"key",value:""});else parts.splice(i,1);
            invalidate();render();
            if(typeof document!=="undefined")document.getElementById("ns-path-"+el.dataset.index+"-"+Math.max(0,Math.min(i,parts.length-1)))?.focus();
            return true;
        }
        case "add-edit":invalidate();state.form.edits.push(emptyEdit());break;
        case "remove-edit":invalidate();state.form.edits.splice(Number(el.dataset.index),1);break;
        case "preview":case "apply":{
            if(busyOperation || (state===composer && state.form.owner.scenarioId!==n.activeScenarioId))break;
            const rule=toRule(state.form,w);
            if(key==="apply"&&!state.form.existing&&n.scenario.rules.some(r=>r.id===rule.id))
                throw new Error(w("A rule with this name already exists. Choose another name.","已存在同名规则，请使用其他名称。"));
            const newGroupName=state.form.owner.scenarioId===undefined && key==="apply" ? state.form.newGroupName?.trim() : undefined;
            if(key==="apply" && state===composer && state.form.owner.scenarioId===undefined && !newGroupName)
                throw Object.assign(new Error(w("Enter a rule group name.","请填写规则组名称。")),{fieldId:"ns-newGroupName"});
            request(send,key==="apply"?"networkUpsertRule":"networkPreviewRule",{rule,...state.form.owner,
                ...(newGroupName && {newGroupName}),...(key==="preview"&&state.form.seedId&&{seedId:state.form.seedId})});break;
        }
        case "send":if(!busyOperation&&n.running)request(send,"networkReplay",{request:toReplay(state.form,w)});break;
        }
    } catch(err){
        setError(err);
        if(typeof document!=="undefined")queueMicrotask(()=>{
            const target=err.fieldId && document.getElementById(err.fieldId);
            if(target){
                for(let detail=target.closest("details");detail;detail=detail.parentElement.closest("details"))detail.open=true;
                target.focus();
            }
            else if(state===composer)document.querySelector(".ns-compose .ns-message.error")?.scrollIntoView({block:"nearest"});
        });
    }
    render();return true;
}
