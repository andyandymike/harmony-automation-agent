import {actionButton, escapeHtml as h} from "./ui/controls.js";

let form = {};
const words = (language,en,zh)=>/^zh/i.test(language)?zh:en;
const disabled = condition=>condition ? " disabled" : "";
const selected = condition=>condition ? " selected" : "";

function control(label,action,{primary=false,quiet=false,off=false,attrs={}}={}) {
    return actionButton(label,{primary,quiet,disabled:off,attrs:{"data-compose":action,...attrs}});
}

export function compositionGap(step,side,model,language) {
    if (!step.path || step.area==="setup" || !model.caseDefinitions && !model.caseReview || model.busy ||
        model.caseReview?.issue==="gestures" || model.planSummary?.source==="coordinates") return "";
    const label=words(language,side==="before"?"Insert before":"Insert after",side==="before"?"在此之前插入":"在此之后插入");
    const active=model.caseComposition?.anchor?.path===step.path && model.caseComposition.anchor.side===side;
    return `<li class="case-composition-gap">${control("+","open",{quiet:true,attrs:{"data-path":step.path,
        "data-side":side,"aria-label":label+" · "+(step.name||step.text),"aria-expanded":active,title:label}})}</li>`;
}

export function compositionStepMenu(step,model,w) {
    if (model.busy || model.caseReview?.issue==="gestures" || model.planSummary?.source==="coordinates") return "";
    const attrs={"data-path":step.path};
    const open=(side,label)=>control(label,"open",{attrs:{...attrs,"data-side":side}});
    return (step.reference ? control(w("Manage reference…","管理引用…"),"reference",{attrs}) : "") +
        open("before",w("Insert before…","在此之前插入…"))+open("after",w("Insert after…","在此之后插入…"))+
        control(w("Explore after this step…","从此步后继续探索…"),"explore",{attrs:{...attrs,"data-side":"after"}})+
        control(w("Save a reusable section…","保存可复用片段…"),"section",{attrs});
}

function issueText(issue,w) {
    return ({
        identity:w("Save this workflow as a case with a unique ID first.","请先保存成具有唯一 ID 的用例。"),
        workflow:w("This workflow cannot execute as a section of another case.","此流程无法作为其他用例中的片段执行。"),
        cycle:w("This would create a circular reference.","这会形成循环引用。"),
        application:w("This source starts in a different app.","来源用例使用另一个应用。"),
        ruleGroup:w("The two cases use different network rule groups.","两个用例的网络规则组不同。"),
        layout:w("The source workflow changed outside the case editor.","来源流程已在用例编辑器之外修改。"),
        unavailable:w("The source could not be read.","无法读取来源用例。"),
    })[issue] || "";
}
const option = (value,label,current)=>`<option value="${h(value)}"${selected(value===current)}>${h(label)}</option>`;
const field = (label,body)=>`<label class="case-composition-field"><span>${label}</span>${body}</label>`;
const input = (key,value,placeholder="",attributes="")=>`<input type="text" data-compose-field="${key}"
    value="${h(value||"")}" placeholder="${h(placeholder)}" ${attributes}>`;
function rows(values,style="") {
    return `<ol class="case-composition-preview ${style}">${(values||[]).map(row=>
        `<li>${row.role?`<span>${h(row.role)}</span>`:""}${h(row.text)}${row.details?`<small>${h(row.details)}</small>`:""}</li>`).join("")}</ol>`;
}
function status(value,w) {
    return ({missing:w("Source unavailable · saved version","来源不可用 · 使用已保存版本"),
        update:w("Update available","有新版本"),current:w("Up to date","已采用当前版本")})[value] || "";
}

function pick(state,model,w) {
    const appList=[...new Set((state.items||[]).map(item=>item.app).filter(Boolean))].sort();
    const tags=[...new Set((state.items||[]).flatMap(item=>item.tags||[]))].sort();
    const query=(form.search||"").trim().toLowerCase();
    const terms=query.split(/\s+/).filter(Boolean);
    const items=(state.items||[]).filter(item=>{
        const content=[item.name,item.location,item.app,...(item.tags||[]),
            ...(item.preview?.flatMap(row=>[row.text,row.details])||[])].join(" ").toLowerCase();
        return terms.every(part=>content.includes(part)) && (!form.app || form.app===item.app) &&
            (!form.kind || form.kind===(item.section?"section":item.source)) && (!form.tag || item.tags?.includes(form.tag));
    }).sort((a,b)=>Number(b.name.toLowerCase().startsWith(query))-Number(a.name.toLowerCase().startsWith(query)));
    const item=items.find(row=>row.id===form.sourceId) || items[0];
    const start=item?.preview?.filter(row=>row.area==="start").map(row=>row.text);
    const goals=item?.preview?.filter(row=>row.area==="goal").map(row=>row.text);
    const source=({section:w("Reusable section","可复用片段"),recording:w("Recording","录制"),
        exploration:w("Exploration","探索"),workflow:w("Workflow","流程")});
    const info=item && issueText(item.issue,w);
    const attrs=item && {"data-source-id":item.id,"data-digest":item.digest};
    return field(w("Find a case or section","搜索用例或片段"),input("search",form.search,w("Search names, steps or tags","输入名称、步骤或标签"))) +
        `<div class="case-composition-filters">
        ${appList.length>0 ? field(w("App","应用"),`<select data-compose-field="app">${option("",w("All apps","所有应用"),form.app)}
            ${appList.map(app=>option(app,app,form.app)).join("")}</select>`) : ""}
        ${field(w("Source","来源"),`<select data-compose-field="kind">${option("",w("All sources","所有来源"),form.kind)}
            ${Object.entries(source).map(([value,label])=>option(value,label,form.kind)).join("")}</select>`)}
        ${tags.length?field(w("Tag","标签"),`<select data-compose-field="tag">${option("",w("All tags","所有标签"),form.tag)}
            ${tags.map(tag=>option(tag,tag,form.tag)).join("")}</select>`):""}</div>
        <div class="case-composition-results">${items.length ? items.map(row=>`<button type="button" class="case-source-choice"
            data-compose="select" data-source-id="${h(row.id)}" aria-pressed="${row===item}"${disabled(model.busy)}>
            <strong>${h(row.name)}</strong><small>${h([source[row.section?"section":row.source],row.app,row.location].filter(Boolean).join(" · "))}</small>
        </button>`).join("") : `<p class="empty">${w("No matching cases.","没有符合条件的用例。")}</p>`}</div>
        ${item ? `<div class="case-composition-review">
            <h4>${h(item.name)}</h4>
            ${start?.length ? `<p><strong>${w("Starts when","入口条件")}</strong> · ${h(start.join(" · "))}</p>`:""}
            ${goals?.length ? `<p><strong>${w("Verifies","验证结果")}</strong> · ${h(goals.join(" · "))}</p>`:""}
            ${item.preview?.length ? `<details open id="case-module-preview"><summary>${w("Preview steps and checks","预览步骤和检查")}</summary>${rows(item.preview)}</details>`:""}
            ${info ? `<p class="case-composition-warning">${h(info)}</p>`:""}
            <div class="toolbar">${control(state.replace?w("Replace reference","替换引用"):w("Insert reference","插入引用"),"insert",
                {primary:true,off:model.busy||Boolean(info),attrs})}
            ${!state.replace ? control(w("Copy steps","复制为本地步骤"),"copy",{quiet:true,off:model.busy||Boolean(info),attrs}) : ""}</div>
        </div>` : ""}`;
}

function usages(items,w,off) {
    return items?.length ? `<ul class="case-composition-preview">${items.map(item=>`<li>${control(item.name,"gotoUsage",
        {quiet:true,off,attrs:{"data-uri":item.uri,"data-path":item.path}})}
        <small>${h([item.before,item.after].filter(Boolean).join(" → "))}</small></li>`).join("")}</ul>` :
        `<p class="empty">${w("No saved cases reference this source.","没有已保存用例引用此来源。")}</p>`;
}

function reference(state,model,w) {
    const ref=state.reference;
    if (!ref) return "";
    const c=(label,action,attrs={})=>control(label,action,{quiet:true,off:model.busy,attrs});
    if (state.mode==="update") {
        if (!state.latest) return `<p class="case-composition-warning">${w("The source is unavailable.","来源用例不可用。")}</p>`;
        const review=state.verification;
        const issue=issueText(state.latest.issue,w);
        const attrs={"data-digest":state.latest.digest};
        return `<p>${h(ref.version)} → ${h(state.latest.digest?.slice(0,8))}</p>
            ${state.diff?.removed.length ? rows(state.diff.removed,"case-diff-removed") : ""}
            ${state.diff?.added.length ? rows(state.diff.added,"case-diff-added") : ""}
            ${!state.diff?.removed.length && !state.diff?.added.length ? `<p>${w("Execution details changed. Review the source workflow.","执行细节有变化，可打开来源流程核对。")}</p>`:""}
            ${issue?`<p class="case-composition-warning">${h(issue)}</p>`:""}
            ${review ? `<p role="status">${review.status==="passed"?w("The copy reached this reference and passed.","副本执行了这条引用并通过。"):
                review.status==="notReached"?w("The copy passed without reaching this reference.","副本通过，但没有执行到此引用。"):
                w("Verification did not pass.","副本验证未通过。")}</p>
                ${review.run ? control(w("View verification steps","查看验证步骤"),"trialDetails",{quiet:true,off:model.busy}) : ""}`:""}
            ${form.showTrial && review?.run===model.run?.entry?.id ? `<ol class="case-composition-preview">${model.run.steps?.map(row=>
                `<li>${h([row.path,row.command,row.status,row.errorCode].filter(Boolean).join(" · "))}</li>`).join("")||""}</ol>`:""}
            ${model.pytestCase ? field(w("Verification runner","验证方式"),`<select data-compose-field="runner">
                ${option("workbench",w("Workbench","工作台"),form.runner||"workbench")}${option("pytest","pytest",form.runner)}</select>`) : ""}
            <div class="toolbar">${control(w("Verify a copy","用副本验证"),"verifyUpdate",{off:model.busy||Boolean(issue),attrs})}
             ${control(w("Adopt in draft","采用新版到草稿"),"adopt",{primary:true,off:model.busy||Boolean(issue),attrs})}
             ${c(w("Keep saved version","保留现有版本"),"referenceMode")}</div>`;
    }
    return `<p class="case-composition-version">${h(status(ref.status,w))} · <code>${h(ref.version)}</code></p>
        <div class="toolbar">
            ${ref.status==="update"?control(w("Review update","查看版本差异"),"reviewUpdate",{primary:true,off:model.busy}):""}
            ${ref.uri?c(w("Open source workflow","打开来源流程"),"openSource"):c(w("Locate source…","查找来源…"),"locateSource")}
            ${c(w("Where used","引用位置"),"usages")}
        </div>
        <details id="case-reference-actions"><summary>${w("Reference actions","引用操作")}</summary><div class="toolbar">
            ${c(w("Replace reference","替换引用"),"replace")}
            ${c(w("Convert to local steps","转为本地步骤"),"detach")}</div></details>
        ${state.usages ? usages(state.usages,w,model.busy) : ""}`;
}

function browseRefs(state,model,w) {
    const items=state.references.filter(item=>!form.refFilter || item.status===form.refFilter);
    return field(w("Show","筛选"),`<select data-compose-field="refFilter">
        ${option("",w("All references","全部引用"),form.refFilter)}${option("update",w("Updates available","待更新"),form.refFilter)}
        ${option("missing",w("Missing sources","来源不可用"),form.refFilter)}</select>`)+
        (items.length ? `<div class="case-composition-results">${items.map(ref=>control(ref.name+" · "+status(ref.status,w),"reference",
            {quiet:true,off:model.busy,attrs:{"data-path":ref.path}})).join("")}</div>`:`<p class="empty">${w("No matching references.","没有符合条件的引用。")}</p>`);
}

function sectionView(state,model,w) {
    const range=state.range || [];
    return field(w("Name","片段名称"),input("name",form.name))+
        field(w("Through step","结束步骤"),`<select data-compose-field="through">${range.map(row=>option(row.path,row.title,form.through)).join("")}</select>`)+
        control(w("Save to case library…","保存到用例库…"),"sectionSave",{primary:true,off:model.busy||!range.length})+
        (state.notice?`<p role="status">${h(state.notice)}</p>`:"");
}

function exploreView(state,model,w) {
    const offline=!model.devices.includes(model.device);
    const c=(label,action,attrs={},off=false,primary=false)=>control(label,action,{off:model.busy||off,primary,attrs});
    const chosen=state.controls?.find(item=>item.key===form.key) || state.controls?.[0];
    const property=form.property || chosen?.property || "visible";
    const expected=form.expected ?? (property==="text" ? chosen?.current || "" : "true");
    const history=(state.history||[]).filter(run=>!form.history || [run.goal,run.mode,run.status].join(" ").toLowerCase().includes(form.history.toLowerCase()));
    const verification=state.verification;
    return field(w("Start from","起点"),`<select data-compose-field="start">
        ${state.canReplay ? option("replay",w("Replay to this position","回放到这个位置"),form.start||"replay") : ""}
        ${option("current",w("Current phone screen","手机当前页面"),form.start)}</select>`)+
        field(w("What should happen?","要探索或验证什么？"),`<textarea rows="2" data-compose-field="goal">${h(form.goal||"")}</textarea>`)+
        `<div class="toolbar">${c(w("Explore","开始探索"),"runExplore",{},offline,true)}
        ${c(w("Read current controls","读取当前页控件"),"scanCheck",{},offline)}
        ${c(w("Pick on phone preview","从手机画面选取"),"scanCheck",{"data-pick":"true"},offline)}</div>
        ${state.working ? actionButton(w("Stop","停止"),{quiet:true,attrs:{"data-compose":"stop"}}) : ""}
        ${state.progress?.length ? `<ul class="case-composition-progress">${state.progress.map(text=>`<li>${h(text)}</li>`).join("")}</ul>`:""}
        ${state.mismatch?`<div class="case-composition-warning">
            <div>${w("Phone screen","手机当前页")} · ${h(state.mismatch.actual || w("Different page","另一页面"))}</div>
            <div>${w("Saved at this position","该位置记录的页面")} · ${h(state.mismatch.expected||"—")}</div>
            <div class="toolbar">${state.canReplay?c(w("Replay to this position","回放到此处"),"runExplore",{"data-start":"replay"},offline):""}
            ${c(w("Explore from this screen","从当前页独立探索"),"runExplore",{"data-start":"current","data-independent":true},offline)}</div>
        </div>`:""}
        ${chosen ? `<div class="case-composition-review">
            <h4>${w("Verification","验证")}</h4>
            ${field(w("Control","控件"),`<select data-compose-field="key">${state.controls.map(item=>option(item.key,item.label+" · "+item.detail,chosen.key)).join("")}</select>`)}
            ${field(w("Check","检查属性"),`<select data-compose-field="property">${["text","visible","enabled","checked","selected","focused"].map(key=>
                option(key,key,property)).join("")}</select>`)}
            ${field(w("Expected","预期值"),property==="text" ? input("expected",expected,"",chosen.protectedValue?'autocomplete="off"':"") :
                `<select data-compose-field="expected">${option("true","True",expected)}${option("false","False",expected)}</select>`)}
            ${verification ? `<p role="status">${({passed:w("Passed","通过"),failed:w("Mismatch","与预期不符"),
                unknown:w("Unable to verify","无法确认")})[verification.status]}
                ${verification.actual!==undefined ? " · "+w("Actual","实际")+" "+h(verification.actual) : ""}</p>`:""}
            ${c(w("Verify now","立即验证"),"verifyCheck",{},offline)}
        </div>`:""}
        ${state.result ? `<div class="case-composition-review">
            <h4>${w("Proposed additions","拟加入的内容")}</h4>
            ${state.result.from || state.result.to ? `<p>${h([state.result.from,state.result.to].filter(Boolean).join(" → "))}</p>`:""}
            ${rows(state.result.steps,"case-diff-added")}
            ${state.entryIssue ? `<p class="case-composition-warning">${state.entryIssue==="different"?
                w("This route starts on a different screen. Select another position.","路径起点与当前插入点不同，请选择其他位置。"):
                w("Entry screen is unconfirmed. Review the draft and verify the whole case.","入口页面尚未确认，请核对草稿并运行整个用例。")}</p>`:""}
            ${state.exitIssue ? `<p class="case-composition-warning">${w("The route ends on a different screen. Check the next step before saving.",
                "这段路径结束在另一个页面，保存前请核对后续步骤。")}</p>`:""}
            ${state.matching?.length ? field(w("Move to another position","选择其他插入位置"),
                `<select data-compose-field="position">${state.matching.map(row=>option(row.path,row.name,form.position)).join("")}</select>`)+
                field(w("Insert","插入方式"),`<select data-compose-field="side">${option("after",w("After selected step","在该步骤之后"),form.side)}
                    ${option("before",w("Before selected step","在该步骤之前"),form.side)}</select>`)+
                c(w("Check this position","核对插入位置"),"moveExplore") : ""}
            ${c(w("Add to this case","加入当前用例"),"addExplore",{},state.entryIssue==="different" ||
                state.result.checkOnly&&!verification,true)}
        </div>`:""}
        <details id="case-composition-history"><summary>${w("Use a saved exploration","使用已保存的探索")}</summary>
            ${field(w("Search explorations","搜索探索记录"),input("history",form.history))}
            ${history.slice(0,12).map(run=>c(run.goal,"savedExplore",{"data-report-id":run.id})).join("")}
        </details>`;
}

export function compositionPanel(model,language) {
    const state=model.caseComposition;
    if (!state) { form={}; return ""; }
    const key=(model.caseReview?.id||"")+"|"+state.mode+"|"+state.anchor?.path+"|"+state.reference?.path;
    if (form.keyFor!==key) form={keyFor:key,app:state.app||""};
    const w=(en,zh)=>words(language,en,zh);
    const title=({pick:w("Insert into case","插入到用例"),explore:w("Explore at this position","探索此位置"),
        section:w("Save reusable section","保存可复用片段"),reference:state.reference?.name,update:w("Review source update","查看来源更新"),
        references:w("References","用例引用"),usages:w("Used by","引用位置")})[state.mode];
    let body="";
    if (state.stale) body=`<p class="case-composition-warning">${w("The steps changed. Select the insertion point again.","步骤已变化，请重新选择插入位置。")}</p>`;
    else switch (state.mode) {
        case "pick": body=pick(state,model,w); break;
        case "reference": case "update": body=reference(state,model,w); break;
        case "references": body=browseRefs(state,model,w); break;
        case "explore": body=exploreView(state,model,w); break;
        case "usages": body=`<h4>${h(state.name)}</h4>${usages(state.usages,w,model.busy)}`; break;
        case "section": body=sectionView(state,model,w); break;
    }
    return `<aside class="case-composition-panel" aria-labelledby="case-composition-heading">
        <header><h3 id="case-composition-heading">${h(title)}</h3>${control(w("Close","关闭"),"close",{quiet:true,off:model.busy})}</header>
        ${state.location ? `<div class="case-composition-position">
            ${state.location.scope ? `<p>${h(state.location.scope)}</p>`:""}
            ${state.location.before?`<p>${w("After","在此步之后")} · ${h(state.location.before)}</p>`:""}
            ${state.location.after?`<p>${w("Before","在此步之前")} · ${h(state.location.after)}</p>`:""}</div>`:""}
        ${state.mode==="pick" && !state.replace ? control(w("Explore here","从此处探索"),"exploreMode",{off:model.busy,quiet:true}) : ""}
        ${body}</aside>`;
}

export function compositionClick(button,model,send,render) {
    let action=button.dataset.compose;
    if (!action) return false;
    if (action==="select") {form.sourceId=button.dataset.sourceId;render();return true;}
    if (action==="trialDetails") {form.showTrial=!form.showTrial;render();return true;}
    if (action==="stop") {send({type:"caseComposeCancel"});return true;}
    const {path,side,uri,sourceId,digest,reportId,start,pick,independent}=button.dataset;
    const review=model.caseReview;
    const panel=button.closest(".case-composition-panel");
    const value=key=>panel?.querySelector(`[data-compose-field="${key}"]`)?.value;
    send({type:"caseCompose",action,id:review?.id,revision:review?.revision,uri:uri||model.plan?.uri,digest:digest||model.planDigest,
        path:action==="moveExplore"?value("position"):path,side:action==="moveExplore"?value("side"):side,sourceId,reportId,start:start||value("start"),
        goal:value("goal"),key:value("key"),property:value("property"),expected:value("expected"),runner:value("runner"),
        through:value("through"),name:value("name"),pick:pick==="true",independent:independent==="true"});
    return true;
}

export function compositionInput(field,render) {
    const key=field.dataset.composeField;
    if (!key) return false;
    form[key]=field.value;
    if (key==="key" || key==="property") {
        if (key==="key") form.property=undefined;
        form.expected=undefined;
    }
    if (["search","app","kind","tag","key","property","history","refFilter"].includes(key)) render();
    return true;
}

export function compositionPickControl(key,model,render) {
    if (model.caseReview?.stepTargets?.area!=="composeCheck") return false;
    form.key=key;
    form.property=form.expected=undefined;
    render();
    return true;
}

export function compositionKeydown(event) {
    const pane = event.target.closest(".case-composition-panel");
    if (!pane) return;
    if (event.key==="Escape") {
        pane.querySelector('[data-compose="close"]:enabled')?.click();
        event.preventDefault();
    }
    if (!["ArrowDown","ArrowUp"].includes(event.key) ||
        !event.target.matches('[data-compose-field="search"],.case-source-choice')) return;
    const choices=[...pane.querySelectorAll(".case-source-choice:enabled")];
    if (!choices.length) return;
    const from=choices.indexOf(event.target);
    const to=from<0 ? (event.key==="ArrowDown"?0:choices.length-1) :
        (choices.length+from+(event.key==="ArrowDown"?1:-1))%choices.length;
    event.preventDefault();
    choices[to].focus();
}

export const referenceControls = (model,w) => control(w("References","引用"),"references",{quiet:true,off:model.busy});
