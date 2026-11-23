import {html} from "./networkInspector.js";
import {actionButton} from "./ui/controls.js";
import {itemMenuTrigger} from "./ui/itemActions.js";

const action=(id,text,disabled=false,primary=false)=>actionButton(text,{disabled,primary,attrs:{"data-net":id}});
const titles={
    create:["New rule group","新建规则组"],duplicate:["Duplicate rule group","复制规则组"],
    rename:["Rename rule group","重命名规则组"],delete:["Delete rule group","删除规则组"]
};
const messages={create:"networkScenarioCreate",duplicate:"networkScenarioDuplicate",rename:"networkScenarioRename",delete:"networkScenarioDelete"};
let form;
export function resetShelf(){form=undefined;}
function nextName(list,base){
    const names=new Set(list.map(s=>s.name));
    if(!names.has(base))return base;
    let i=2;
    while(names.has(base+" ("+i+")"))i++;
    return base+" ("+i+")";
}
function management(n,w,busy) {
    if(!form || form.owner!==n.activeScenarioId || form.kind==="rename") return "";
    const target=n.scenarioLibrary.find(s=>s.id===form.owner);
    if(!target) return "";
    const deleting=form.kind==="delete";
    const next=n.scenarioLibrary.find(s=>s.id!==form.owner)?.name || w("a blank rule group","空白规则组");
    const removal = w("Remove “"+target.name+"” from this workspace?","从工作区删除「"+target.name+"」？");
    const gatewayChange = !n.gatewayScenarioId || n.gatewayScenarioId===target.id ?
        w(" The gateway will use "+next+".","网关将改用「"+next+"」。") : "";
    return `<section class="sc-library-form" aria-labelledby="sc-library-form-title">
        <h3 id="sc-library-form-title">${w(...titles[form.kind])}</h3>
        ${deleting ? `<p>${html(removal+gatewayChange)}</p>` :
            `<label>${w("Rule group name","规则组名称")}<input id="sc-library-name" class="vscode-textfield" value="${html(form.name)}" autocomplete="off"></label>`}
        <div class="sc-extra">${action("sc-confirm",deleting?w("Delete rule group","确认删除规则组"):w(...titles[form.kind]),busy,true)}
            ${action("sc-dismiss",w("Cancel","取消"),busy)}</div></section>`;
}
export function scenarioName(n,w,busy) {
    const name=n.scenario.name || w("Untitled rule group","未命名规则组");
    if (form?.owner===n.activeScenarioId && form.kind==="rename") return `<div class="sc-title-edit">
        <input id="sc-library-name" class="vscode-textfield" aria-label="${w("Rule group name","规则组名称")}"
            value="${html(form.name)}" autocomplete="off" ${busy?"disabled":""}>
        ${action("sc-confirm",w("Save","保存"),busy,true)}${action("sc-dismiss",w("Cancel","取消"),busy)}</div>`;
    return `<h2><button type="button" id="scenario-title" class="inline-edit-title" data-net="sc-rename" ${busy?"disabled":""}
        title="${w("Rename rule group (F2)","重命名规则组（F2）")}">${html(name)}</button></h2>`;
}
export function shelfView(n,w,busy,currentDrafts) {
    const list=n.scenarioLibrary || [];
    return `<aside class="sc-shelf" aria-labelledby="sc-library-title">
        <header><h2 id="sc-library-title">${w("Rule groups","工作区规则组")}</h2>
        ${action("sc-create",w("New rule group","新建规则组"),busy)}</header>
        <ul>${list.map(s=>`<li class="sc-library-row" data-item-actions="rule-group" data-group-id="${html(s.id)}"
            data-item-label="${html(s.name)}"><button type="button" class="sc-library-item" data-net="sc-select" data-id="${html(s.id)}"
            ${s.id===n.activeScenarioId?'aria-current="true"':""} ${busy?"disabled":""}>
            <strong>${html(s.name)}</strong><small>${s.id===(n.gatewayScenarioId||n.activeScenarioId)?w("Used by gateway · ","网关使用 · "):""}${s.paused?w("Disabled · ","已停用 · "):""}
            ${html(s.ruleCount)} ${w("rules","条规则")}${currentDrafts.has(s.id)?w(" · Draft"," · 草稿"):""}</small></button>
            ${itemMenuTrigger(w("Rule group actions","规则组操作"),busy)}</li>`).join("")}</ul>
        ${action("load",w("Import rule group…","导入规则组…"),busy)}
        ${management(n,w,busy)}</aside>`;
}
export function scenarioTools(n,w,busy) {
    const active=!n.gatewayScenarioId || n.gatewayScenarioId===n.activeScenarioId;
    return `<div class="sc-file-actions">${!active ? action("sc-activate",w("Use for gateway","设为网关使用的规则组"),busy) : ""}
        ${action("sc-pause",n.scenario.paused?w("Enable rule group","启用规则组"):w("Disable rule group","停用规则组"),busy)}
        <details id="sc-management"><summary>${w("Manage rule group","管理规则组")}</summary>
        <div>${action("edit",w("Bulk edit response sequences","批量编辑顺序响应"),busy)}
        ${action("sc-duplicate",w(...titles.duplicate),busy)}
        ${action("save",w("Export rule group…","导出规则组…"),busy)}${action("sc-delete",w(...titles.delete),busy)}</div></details></div>`;
}
function focusName() {
    if (typeof document!=="undefined") queueMicrotask(()=>{
        const input=document.getElementById("sc-library-name");
        if(input){input.focus();input.select();}
        else document.querySelector('[data-net="sc-dismiss"]')?.focus();
    });
}
export function shelfClick(el,n,w,send,request){
    if(!el.dataset.net?.startsWith("sc-"))return false;
    const id=el.dataset.net.slice(3);
    const attrs={id:n.activeScenarioId,scenarioId:n.activeScenarioId};
    el.closest?.("#sc-management")?.removeAttribute("open");
    if(id==="select"){
        form=undefined;
        if(el.dataset.id!==n.activeScenarioId) send({type:"networkScenarioBrowse",id:el.dataset.id});
    } else if(id==="activate"){
        const target=el.dataset.id || n.activeScenarioId;
        if (target===n.activeScenarioId || n.scenarioLibrary.some(group=>group.id===target))
            request("networkScenarioSelect",send,{...attrs,id:target});
    } else if(titles[id]){
        const name=id==="rename"?n.scenario.name:id==="duplicate"?
            nextName(n.scenarioLibrary,w(n.scenario.name+" copy",n.scenario.name+" 副本")):"";
        form={kind:id,owner:n.activeScenarioId,name};
        focusName();
    } else if(id==="confirm" && form?.owner===n.activeScenarioId){
        request(messages[form.kind],send,{...attrs,name:form.name,browse:true});
    } else if(id==="pause"){
        request("networkScenarioPause",send,{...attrs,paused:!n.scenario.paused});
    } else if(id==="dismiss"){
        const rename=form?.kind==="rename";
        form=undefined;
        if (rename && typeof document!=="undefined") queueMicrotask(()=>document.getElementById("scenario-title")?.focus());
    }
    else return false;
    return true;
}
export function shelfInput(el){
    if(!form||el.id!=="sc-library-name")return false;
    form.name=el.value;return true;
}
