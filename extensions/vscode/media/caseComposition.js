import {actionButton, escapeHtml as h} from "./ui/controls.js";
import {menuItems} from "./ui/itemActions.js";

let form = {};
const words = (language,en,zh)=>/^zh/i.test(language)?zh:en;
const disabled = condition=>condition ? " disabled" : "";
const selected = condition=>condition ? " selected" : "";

function control(label,action,{primary=false,quiet=false,off=false,attrs={},className}={}) {
    return actionButton(label,{primary,quiet,disabled:off,className,attrs:{"data-compose":action,...attrs}});
}

export function compositionStepMenu(step,model,w) {
    if (!step.path || model.busy) return "";
    const attrs={"data-path":step.path};
    const open=(side,label)=>actionButton(label,{attrs:{...attrs,"data-case-insert":"open","data-side":side}});
    return (step.reference ? control(w("Manage reference","管理引用"),"reference",{attrs}) : "") +
        open("before",w("Insert before","在此之前插入"))+open("after",w("Insert after","在此之后插入"))+
        ((!step.description || step.description.implemented) ? control(w("Save a reusable section","保存可复用片段"),"section",{attrs}) : "");
}

function continuationOptions(step,side,model,w) {
    const position=step?.exploration?.[side];
    if (!position || model.busy) return [];
    const {checkpoint,pathsReason,followUpReason,copyReason}=position;
    const {id,revision}=model.caseReview || {};
    const uri=model.plan?.uri, digest=model.planDigest;
    const supplement={destination:"current",label:w("Add steps to this case with AI","用 AI 补充当前用例"),reason:followUpReason,
            attrs:{"data-compose":"explore","data-destination":"current","data-path":step.path,"data-side":side},
            message:{type:"caseCompose",action:"explore",destination:"current",id,revision,uri,digest,path:step.path,side}};
    if (step.path==="steps") return [supplement];
    return [supplement,
        {destination:"new",label:w("Copy the steps up to here","复制到这里的步骤"),reason:copyReason,
            description:w("Open a separate draft to continue editing.","复制已有步骤，打开一份可继续编辑的新草稿。"),
            attrs:{"data-compose":"forkCase","data-path":step.path,"data-side":side},
            message:{type:"caseCompose",action:"forkCase",id,revision,uri,digest,path:step.path,side}},
        {destination:"new",label:w("Explore other paths","探索其他走法"),reason:pathsReason || (!Number.isInteger(checkpoint) ?
            w("Choose a replayable position in this case.","请选择脚本可到达的分叉位置。") : undefined),
            description:w("Try up to two other entries on this screen.","试试当前画面的其他入口，最多两处，分别记录结果。"),
            attrs:{"data-type":"explorationFromCase","data-uri":uri,"data-digest":digest,"data-checkpoint":checkpoint},
            message:{type:"explorationFromCase",uri,digest,checkpoint}},
    ];
}

export function caseForkStepMenu(step,model,w) {
    return continuationOptions(step,"after",model,w).map(({destination,label,description,reason,attrs})=>
        actionButton(label,{disabled:Boolean(reason),attrs:{...attrs,"data-case-continue":destination,"data-menu-description":description,"data-menu-reason":reason}})).join("");
}

function forkSubmenu(children,w,side) {
    const heading = side==="before" ? w("Start with the steps before this row.","新用例从第一行复制到这行之前。") :
        w("Start with the steps through this row.","新用例从第一行复制到当前行。");
    return children.length ? [{label:w("New case from here","从此处新建用例"),group:"reuse",children,heading,backLabel:w("Back","返回")}] : [];
}

export function caseContinuationChoices(model,path,side,w) {
    const find=rows=>{
        for (const step of rows || []) {
            if (step.path===path) return step;
            for (const branch of step.branches || []) {
                if (branch.readOnly) continue;
                const found=find(branch.steps);
                if (found) return found;
            }
        }
    };
    const step=find((model.caseReview?.bdd || model.caseBdd)?.steps);
    if (!step && path==="steps" && model.caseReview?.empty && !model.caseReview.coordinates) {
        return continuationOptions({path,exploration:{[side]:{}}},side,model,w);
    }
    return continuationOptions(step,side,model,w);
}

export function casePositionMenuItems(slot,model,w,send) {
    const {path,side}=slot.dataset;
    const choices=caseContinuationChoices(model,path,side,w).map(({destination,label,description,reason,message})=>({
        destination,label,description,disabled:Boolean(reason),reason,run:()=>{if (!reason && slot.isConnected) send(message);},
    }));
    return [{label:w("Insert a step here","在此插入步骤"),run:()=>{if (slot.isConnected) slot.click();}},
        ...choices.filter(item=>item.destination==="current"),...forkSubmenu(choices.filter(item=>item.destination==="new"),w,side)];
}

export function caseStepMenuItems(buttons,w) {
    const direct=[], insert=[], move=[], reuse=[], ai=[], current=[], fork=[], remove=[];
    for (const button of buttons) {
        const d=button.dataset;
        if (d.caseContinue) {
            const item={...menuItems([button])[0],description:d.menuDescription,reason:d.menuReason};
            if (d.caseContinue==="current") current.push({...item,group:"position"});
            else fork.push(item);
        }
        else if (button.disabled) continue;
        else if (d.stepAction==="remove") remove.push(button);
        else if (d.caseInsert==="open") insert.push(button);
        else if (d.orderOffset!==undefined) move.push(button);
        else if (d.compose==="section") reuse.push(button);
        else if (d.caseArea==="stepFeedback" || d.area==="stepFeedback" || d.compose==="generateDescription") ai.push(button);
        else direct.push(button);
    }
    const items=(entries,group)=>menuItems(entries).map(item=>({...item,group}));
    const submenu=(label,children,group)=>children.length>1 ?
        [{label,children:menuItems(children),group,backLabel:w("Back","返回")}] : items(children,group);
    return [
        ...menuItems(direct),
        ...items(insert,"position"), ...current, ...submenu(w("Move step","移动步骤"),move,"position"),
        ...items(ai,"tools"), ...items(reuse,"reuse"), ...forkSubmenu(fork,w,"after"),
        ...items(remove,"remove"),
    ];
}

export function compositionControls(bdd,w,off) {
    const steps=bdd?.steps || [];
    if (!bdd) return "";
    const references=rows=>rows.some(step=>step.reference || step.branches?.some(branch=>references(branch.steps)));
    return actionButton(w("Insert step","插入步骤"),{quiet:true,disabled:off,attrs:{id:"case-insert-start","data-case-insert":"open"}}) +
        (references(steps) ? control(w("References","引用管理"),"references",{quiet:true,off}) : "");
}

export function issueText(issue,w) {
    return ({
        identity:w("Save this workflow as a case with a unique ID first.","请先保存成具有唯一 ID 的用例。"),
        draft:w("This case still has steps awaiting generation.","此用例还有待生成的步骤。"),
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
        draft:w("Source is a draft · saved version","来源为草稿 · 已保存版本"),
        update:w("Update available","有新版本"),current:w("Up to date","已采用当前版本")})[value] || "";
}

function pick(state,model,w) {
    const catalog=(state.items || []).filter(item=>item.uri!==model.plan?.uri);
    const appList=[...new Set(catalog.map(item=>item.app).filter(Boolean))].sort();
    const tags=[...new Set(catalog.flatMap(item=>item.tags||[]))].sort();
    const query=(form.search||"").trim().toLowerCase();
    const terms=query.split(/\s+/).filter(Boolean);
    const items=catalog.filter(item=>{
        const content=[item.name,item.location,item.app,...(item.tags||[]),
            ...(item.preview?.flatMap(row=>[row.text,row.details])||[])].join(" ").toLowerCase();
        return terms.every(part=>content.includes(part)) && (!form.app || form.app===item.app) &&
            (!form.kind || form.kind===(item.section?"section":item.source)) && (!form.tag || item.tags?.includes(form.tag));
    }).sort((a,b)=>Number(Boolean(a.issue))-Number(Boolean(b.issue)) ||
        Number(b.name.toLowerCase().startsWith(query))-Number(a.name.toLowerCase().startsWith(query)));
    const item=items.find(row=>row.id===form.sourceId) || items[0];
    const preview=item?.preview || [];
    const start=preview.filter(row=>row.area==="start");
    const goals=preview.filter(row=>row.area==="goal");
    const steps=preview.filter(row=>row.area==="step");
    const source=({section:w("Reusable section","可复用片段"),recording:w("Recording","录制"),
        exploration:w("Exploration","探索"),workflow:w("Workflow","流程")});
    const info=item && issueText(item.issue,w);
    const attrs=item && {"data-source-id":item.id,"data-digest":item.digest};
    const metadata=row=>[source[row.section?"section":row.source],row.location || row.app].filter(Boolean).join(" · ");
    const filterCount=[form.app,form.kind,form.tag].filter(Boolean).length;
    const filterName=w("Filters","筛选")+(filterCount ? " ("+filterCount+")" : "");
    const filters=`<details id="case-insert-filters" class="case-task-disclosure"><summary>${filterName}</summary>
        <div class="case-task-fields">
        ${appList.length ? field(w("App","应用"),`<select data-compose-field="app">${option("",w("All apps","所有应用"),form.app)}
            ${appList.map(app=>option(app,app,form.app)).join("")}</select>`) : ""}
        ${field(w("Source","来源"),`<select data-compose-field="kind">${option("",w("All sources","所有来源"),form.kind)}
            ${Object.entries(source).map(([value,label])=>option(value,label,form.kind)).join("")}</select>`)}
        ${tags.length ? field(w("Tag","标签"),`<select data-compose-field="tag">${option("",w("All tags","所有标签"),form.tag)}
            ${tags.map(tag=>option(tag,tag,form.tag)).join("")}</select>`) : ""}</div>
        ${filterCount ? control(w("Clear filters","清除筛选"),"clearFilters",{quiet:true,off:model.busy}) : ""}</details>`;
    const results=items.map(row=>`<button type="button" class="case-source-choice"
            data-compose="select" data-source-id="${h(row.id)}" aria-pressed="${row===item}"${disabled(model.busy)}>
            <span><strong>${h(row.name)}</strong><small>${h(metadata(row))}</small></span><span class="case-source-arrow" aria-hidden="true">›</span>
        </button>`).join("");
    const previewBlock=(label,steps)=>steps.length ? `<section class="case-preview-block"><h3>${label}</h3>${rows(steps)}</section>` : "";
    const previewContent=item ? `
        ${control(w("← Back to results","← 返回搜索结果"),"backToSources",{quiet:true,className:"case-source-back"})}
        <header class="case-source-heading"><h2 id="case-source-heading" tabindex="-1">${h(item.name)}</h2>
            <small>${h(metadata(item))}</small></header>
        ${info ? `<p class="case-composition-warning">${h(info)}</p>` : ""}
        ${previewBlock(w("Entry conditions","入口条件"),start)}
        ${previewBlock(w("Steps","步骤"),steps)}
        ${previewBlock(w("Outcome checks","结果断言"),goals)}` : "";
    const body=`<div class="case-insert-canvas">
        <section class="case-insert-catalog" aria-label="${w("Case library","用例库")}">
            ${field(w("Search the case library","搜索用例库"),input("search",form.search,w("Case name, step, or tag","用例名称、步骤或标签")))}
            ${filters}
            <div class="case-composition-results" id="case-insert-results">${results || `<p class="empty" role="status">${
                !state.items && model.busy ? w("Reading the case library…","正在读取用例库…") : w("No matching cases.","没有符合条件的用例。")}</p>`}</div></section>
        ${item ? `<div class="case-insert-preview" aria-labelledby="case-source-heading">${previewContent}</div>` : ""}</div>`;
    const actions=item ? (state.replace ? "" : control(w("Copy as local steps","复制为本地步骤"),"copy",{off:model.busy||Boolean(info),attrs}))+
        control(state.replace?w("Replace reference","替换引用"):w("Insert reference","插入引用"),"insert",
            {primary:true,off:model.busy||Boolean(info),attrs}) : "";
    return {body,actions};
}

function usages(items,w,off) {
    return items?.length ? `<ul class="case-composition-preview">${items.map(item=>`<li>${control(item.name,"gotoUsage",
        {quiet:true,off,attrs:{"data-uri":item.uri,"data-path":item.path}})}
        <small>${h([item.before,item.after].filter(Boolean).join(" → "))}</small></li>`).join("")}</ul>` :
        `<p class="empty">${w("No saved cases reference this source.","没有已保存用例引用此来源。")}</p>`;
}

function reference(state,model,w) {
    const ref=state.reference;
    if (!ref) return {body:""};
    const c=(label,action,attrs={})=>control(label,action,{quiet:true,off:model.busy,attrs});
    if (state.mode==="update") {
        if (!state.latest) return {body:`<p class="case-composition-warning">${w("The source is unavailable.","来源用例不可用。")}</p>`};
        const review=state.verification;
        const issue=issueText(state.latest.issue,w);
        const attrs={"data-digest":state.latest.digest};
        const old=state.diff?.removed || [];
        const next=state.diff?.added || [];
        const body=`<div class="case-task-stack">
            <div class="case-version-diff">
                <section><h2>${w("Saved version","已采用版本")}</h2><small><code>${h(ref.version)}</code></small>
                    ${old.length ? rows(old,"case-diff-removed") : ""}</section>
                <section><h2>${w("Source revision","来源新版")}</h2><small><code>${h(state.latest.digest?.slice(0,8))}</code></small>
                    ${next.length ? rows(next,"case-diff-added") : ""}</section></div>
            ${!old.length && !next.length ? `<p>${w("Execution details changed. Open the source workflow to check them.",
                "执行细节有变化，可打开来源流程核对。")}</p>${c(w("Open source workflow","打开来源流程"),"openSource")}` : ""}
            ${issue ? `<p class="case-composition-warning">${h(issue)}</p>` : ""}
            ${review ? `<div class="case-task-stack"><p role="status">${review.status==="passed"?
                w("The copy reached this reference and passed.","副本执行了这条引用并通过。"):review.status==="completed" ?
                w("The copy replayed through this reference.","副本已回放这条引用并完成。"):review.status==="notReached"?
                w("The copy passed without reaching this reference.","副本通过，但没有执行到此引用。"):
                w("Verification did not pass.","副本验证未通过。")}</p>
                ${review.run ? c(w("View verification steps","查看验证步骤"),"trialDetails") : ""}</div>` : ""}
            ${form.showTrial && review?.run && review.run===model.run?.entry?.id ? `<ol class="case-composition-preview">${model.run.steps?.map(row=>
                `<li>${h([row.path,row.command,row.status,row.errorCode].filter(Boolean).join(" · "))}</li>`).join("")||""}</ol>` : ""}
            ${model.pytestCase ? field(w("Verification runner","副本执行方式"),`<select data-compose-field="runner">
                ${option("workbench",w("Workbench","工作台"),form.runner||"workbench")}${option("pytest","pytest",form.runner)}</select>`) : ""}
        </div>`;
        const actions=c(w("Keep saved version","保留现有版本"),"referenceMode")+
            control(w("Verify a copy","用副本验证"),"verifyUpdate",{off:model.busy||Boolean(issue),attrs})+
            control(w("Adopt in draft","采用新版到草稿"),"adopt",{primary:true,off:model.busy||Boolean(issue),attrs});
        return {body,actions};
    }
    const body=`<div class="case-task-stack"><p>${h(status(ref.status,w))} · <code>${h(ref.version)}</code></p>
        <div class="toolbar">
            ${ref.status==="update"?control(w("Review update","查看版本差异"),"reviewUpdate",{primary:true,off:model.busy}):""}
            ${ref.uri?c(w("Open source workflow","打开来源流程"),"openSource"):c(w("Locate source","查找来源"),"locateSource")}
            ${c(w("Where used","引用位置"),"usages")}</div>
        <details id="case-reference-actions" class="case-task-disclosure"><summary>${w("Reference actions","更多引用操作")}</summary>
            <div class="toolbar">${c(w("Replace reference","替换引用"),"replace")}
            ${c(w("Convert to local steps","转为本地步骤"),"detach")}</div></details>
        ${state.usages ? usages(state.usages,w,model.busy) : ""}</div>`;
    return {body};
}

function browseRefs(state,model,w) {
    const items=(state.references || []).filter(item=>!form.refFilter || item.status===form.refFilter);
    return field(w("Show","查看"),`<select data-compose-field="refFilter">
        ${option("",w("All references","全部引用"),form.refFilter)}${option("update",w("Updates available","待更新"),form.refFilter)}
        ${option("missing",w("Missing sources","来源不可用"),form.refFilter)}</select>`)+
        (items.length ? `<div class="case-composition-results">${items.map(ref=>`<button type="button" class="case-source-choice"
            data-compose="reference" data-path="${h(ref.path)}"${disabled(model.busy)}>
            <span><strong>${h(ref.name)}</strong><small>${h(status(ref.status,w))}</small></span>
            <span aria-hidden="true">›</span></button>`).join("")}</div>` : `<p class="empty">${w("No matching references.","没有符合条件的引用。")}</p>`);
}

function sectionView(state,model,w) {
    const range=state.range || [];
    const first=Math.max(0,range.findIndex(row=>row.path===(form.from || state.sectionStart)));
    const last=Math.max(first,range.findIndex(row=>row.path===(form.through || state.sectionStart)));
    const included=state.sectionPaths ? range.filter(row=>state.sectionPaths.includes(row.path)) : range.slice(first,last+1);
    form.through=range[last]?.path;
    const preview=w(included.length===1 ? "1 step selected" : `${included.length} steps selected`, `已选 ${included.length} 步`);
    return {
        body:`<div class="case-task-stack">
            ${state.sectionPaths ? "" : `<div class="case-task-fields">
                ${field(w("First step","起始步骤"),`<select data-compose-field="from">${range.map((row,index)=>
                    option(row.path,`${index+1}. ${row.text}`,range[first]?.path)).join("")}</select>`)}
                ${field(w("Last step","结束步骤"),`<select data-compose-field="through">${range.slice(first).map((row,index)=>
                    option(row.path,`${first+index+1}. ${row.text}`,form.through)).join("")}</select>`)}
            </div>`}
            ${field(w("Section name","片段名称"),input("name",form.name))}
            ${included.length ? `<details id="case-section-steps" class="case-task-disclosure" open>
                <summary>${preview}</summary>${rows(included)}</details>` : ""}
            ${state.notice ? `<p role="status">${h(state.notice)}</p>` : ""}</div>`,
        actions:control(w("Save to case library","保存到用例库"),"sectionSave",{primary:true,off:model.busy||!included.length||Boolean(state.notice)})
    };
}

function positionEditor(state,model,w) {
    if (!state.positions?.length) return "";
    const current=state.positions.find(row=>row.path===state.anchor?.path);
    const title=state.anchor?.side==="before" ? w("Before","在此步之前") : w("After","在此步之后");
    return `<details id="case-task-position" class="case-task-position">
        <summary><span class="case-placement-label">${w("Insert at","插入位置")}</span> <span class="case-placement-step">
            ${h([state.location?.scope,title,current?.name].filter(Boolean).join(" · "))}</span></summary>
        <div class="case-task-fields">
            ${field(w("Step","用例步骤"),`<select data-compose-field="position">
                ${state.positions.map(row=>option(row.path,row.name,form.position || state.anchor?.path)).join("")}</select>`)}
            ${field(w("Placement","放在该步"),`<select data-compose-field="side">
                ${option("before",w("Before","之前"),form.side || state.anchor?.side)}
                ${option("after",w("After","之后"),form.side || state.anchor?.side)}</select>`)}
        </div>
        ${control(w("Set position","确定位置"),"setPosition",{off:model.busy})}</details>`;
}

function resultWarnings(state,w) {
    return (state.entryIssue ? `<p class="case-composition-warning">${state.entryIssue==="different" ?
        w("This starts on a different page. Change the insertion position or return to the expected page.",
            "这段操作从另一个页面开始。请调整插入位置，或将手机切回该位置对应的页面。") :
        w("The entry page is unconfirmed. Run the case after saving to verify the connection.",
            "入口页面尚未确认。保存后可运行整个用例，核对前后步骤是否接得上。")}</p>` : "") +
        (state.exitIssue ? `<p class="case-composition-warning">${w("This ends on a different page. Review the next step.",
            "这段操作结束在另一个页面，请核对后续步骤。")}</p>` : "");
}

function explorationProposal(state,w,back) {
    return `<div class="case-task-stack">
        <div class="case-task-heading"><h2>${w("Review steps to add","核对要加入的步骤")}</h2>${back}</div>
        ${state.result.from || state.result.to ? `<p class="muted">${h([state.result.from,state.result.to].filter(Boolean).join(" → "))}</p>` : ""}
        ${resultWarnings(state,w)}
        ${rows(state.result.steps,"case-diff-added")}</div>`;
}

function originalNextStep(next,reviewed,w) {
    const detail=next ? `<small>${w("Original next step","原下一步")}</small><strong>${h(next)}</strong>` :
        w("End of case","用例末尾");
    const status=next && reviewed ? `<small>${w("Not run in this exploration","本次探索未执行")}</small>` : "";
    return `<p class="case-followup-next">${detail}${status}</p>`;
}

function exploreView(state,model,w) {
    const offline=!model.devices?.includes(model.device);
    const c=(label,action,{primary=false,quiet=false,off=false,attrs={}}={})=>
        control(label,action,{off:model.busy||off,primary,quiet,attrs});
    const add=()=>c(w("Add to case draft","加入用例草稿"),"addExplore",{primary:true,off:state.entryIssue==="different"});
    const review=state.result?.steps?.length > 0;
    if (state.method==="history") {
        if (review && !form.historyList) return {body:explorationProposal(state,w,c(w("Choose another result","换一个探索结果"),
            "browseHistory",{quiet:true})),actions:add()};
        const history=(state.history||[]).filter(run=>!form.history ||
            [run.goal,run.mode,run.status].join(" ").toLowerCase().includes(form.history.trim().toLowerCase()));
        return {body:`<div class="case-task-stack">
            ${field(w("Find a past exploration","搜索探索记录"),input("history",form.history))}
            <div class="case-composition-results">${history.length ? history.map(run=>c(run.goal,"savedExplore",
                {quiet:true,attrs:{"data-report-id":run.id}})).join("") :
                `<p class="empty">${w("No matching explorations.","没有符合条件的探索记录。")}</p>`}</div>
            ${review ? c(w("Back to selected result","返回已选结果"),"viewHistory",{quiet:true}) : ""}</div>`};
    }
    const prefix=state.followUp?.prefix || [];
    const checkpoint=state.followUp?.checkpoint;
    const current=state.followUp?.destination==="current";
    const nextRow=current ? originalNextStep(state.followUp.nextLabel,review && !form.aiEdit,w) : "";
    const checkpointTitle=checkpoint ? w("Replay through “"+checkpoint+"”","回放至「"+checkpoint+"」") : w("Case start","用例起点");
    const retained=prefix.length ? `<details id="case-followup-prefix"><summary>${h(checkpointTitle)} <small>· ${w(prefix.length+" steps",prefix.length+" 步")}</small></summary>${rows(prefix)}</details>` :
        `<p class="muted">${h(checkpointTitle)}</p>`;
    const progress=state.progress?.length ? `<ol class="case-composition-progress">${state.progress.map(text=>`<li>${h(text)}</li>`).join("")}</ol>` : "";
    if (state.working) return {body:`<div class="case-task-stack">${retained}
        <h2>${w("Running on device","正在设备上执行")}</h2><p>${h(form.goal)}</p><div role="log">${progress}</div></div>`,
        actions:control(w("Stop","停止"),"stop")};
    if (review && !form.aiEdit) return {body:`<div class="case-task-stack">${retained}
        <div class="case-task-heading"><h2>${w("New steps","新增步骤")} · ${state.result.steps.length}</h2>
            ${c(w("Change goal","修改目标"),"editAI",{quiet:true})}</div>
        ${rows(state.result.steps,"case-diff-added")}${nextRow}</div>`,
        actions:current ? c(w("Insert into this case","插入当前用例"),"insertFollowUp",{primary:true}) :
            c(w("Review new case","核对新用例"),"reviewFollowUp",{primary:true})};
    const info=!state.canReplay ? w("Choose a position the script can reach.","请选择前置脚本能回放到的位置。") :
        offline ? w("Select a connected device to run the script.","请选择已连接的设备来回放脚本。") : "";
    return {body:`<div class="case-task-stack">${retained}
        ${nextRow}
        <p class="muted">${current ? w("The script replays to this point. AI then follows your goal on the device. Review the new steps before inserting them here.",
            "脚本先回放到此处，再由 AI 在设备上按目标操作。核对生成的步骤后，即可插入这里。") :
            w("The script runs to this point. AI then follows your goal. The new case keeps the script prefix and the steps observed on the device.",
            "脚本先回放到这里，再由 AI 按目标操作。新用例由这段脚本和本次实际走出的步骤组成。")}</p>
        ${field(w("What should the new steps do or verify?","新步骤要执行什么操作、验证什么结果？"),
            `<textarea rows="3" data-compose-field="goal">${h(form.goal||"")}</textarea>`)}
        ${info?`<p class="muted">${h(info)}</p>`:""}${state.problem?`<p class="case-composition-warning" role="status">${h(state.problem)}</p>`:""}
        ${progress}${review ? c(w("View last result","查看上次探索结果"),"viewAI",{quiet:true}) : ""}</div>`,
        actions:c(w("Replay and explore","回放并探索"),"runExplore",{primary:true,off:offline||!state.canReplay||!form.goal?.trim(),attrs:{"data-start":"replay"}})};
}

function generationView(state,model,w) {
    const {description,location} = state;
    const offline = !model.devices.includes(model.device);
    const c = (label,action,attrs={})=>control(label,action,{...attrs,off:model.busy || attrs.off});
    const original = `<div class="case-generation-source"><p class="case-description-text">${h(description.text)}</p>
        ${location?.before ? `<small>${w("After","接在")} ${h(location.before)}${w(""," 之后")}</small>` :
            `<small>${w("At the start of the case","用例开头")}</small>`}</div>`;
    const progress = state.progress?.length ? `<ol class="case-composition-progress" role="log">${state.progress.map(text=>`<li>${h(text)}</li>`).join("")}</ol>` : "";
    if (state.working) return {body:`<div class="case-task-stack">${original}${progress}</div>`,
        actions:control(w("Stop generation","停止生成"),"stop")};
    const review = state.result?.steps?.length;
    if (review && !form.aiEdit) return {body:`<div class="case-task-stack">${original}
        ${explorationProposal(state,w,c(w("Generate again","重新生成"),"editAI",{quiet:true,off:offline}))}</div>`,actions:
        c(w("Apply to case","应用到用例"),"addDescription",{primary:true,off:state.entryIssue==="different"}) +
        (description.hasNext ? c(w("Apply and go to next","应用并处理下一条"),"nextDescription",{quiet:true,off:state.entryIssue==="different"}) : "")};
    const start = state.canReplay ? field(w("Start from","从哪里开始"),`<select data-compose-field="start">
        ${option("replay",w("Replay the preceding steps","回放前面的步骤"),form.start || "replay")}
        ${option("current",w("Current phone screen","手机当前页面"),form.start)}</select>`) :
        `<p class="muted">${w("Put the phone on the page where this step starts.","请将手机停在这条步骤开始的页面。")}</p>`;
    const issue = state.mismatch ? w(`Expected ${state.mismatch.expected || "the recorded page"}.`,
        `请先回到这一位置对应的页面${state.mismatch.expected ? " · "+state.mismatch.expected : ""}。`) : state.problem;
    return {body:`<div class="case-task-stack">${original}${start}
        ${offline ? `<p class="muted">${w("Connect a phone to generate steps.","连接手机后可生成步骤。")}</p>` : ""}
        ${issue ? `<p class="case-composition-warning" role="status">${h(issue)}</p>` : ""}${progress}
        ${review ? c(w("View generated steps","查看生成结果"),"viewAI",{quiet:true}) : ""}</div>`,
        actions:c(w("Generate steps","生成步骤"),"runExplore",{primary:true,off:offline})};
}

function revisionView(state,model,w) {
    const r=state.revisionWork;
    const offline=!model.devices.includes(model.device);
    const c=(label,action,options={})=>control(label,action,{...options,off:model.busy || options.off});
    const initial=!r.path ? w("Prepare the phone at the case’s starting state.","请将手机准备到用例的起始状态。") :
        w("Put the phone on the page where this step starts.","请将手机停在这一步对应的起始页面。");
    const progress=r.progress?.length ? `<ol class="case-composition-progress" role="log">${r.progress.map(line=>`<li>${h(line)}</li>`).join("")}</ol>` : "";
    if (r.phase==="exploring" || r.phase==="verifying") {
        return {body:`<div class="case-task-stack"><h2>${r.phase==="verifying" ?
            w("Replaying the candidate from the start","正在从用例起点验证回放") : w("Exploring the draft in order","正在按顺序探索草稿")}</h2>
            ${progress}</div>`,actions:control(r.phase==="verifying" ? w("Stop verification","停止验证") : w("Stop exploration","停止探索"),"stop")};
    }
    const problem=r.problem ? `<p class="case-composition-warning" role="status">${h(r.problem)}</p>` : "";
    if (["ready","blocked"].includes(r.phase)) {
        const tasks=r.tasks.map(item=>{
            const label=item.label || item.text || item.path;
            return `<li><strong>${h(label)}</strong>${item.text && item.text!==label ? `<p>${h(item.text)}</p>` : ""}</li>`;
        }).join("");
        const start=r.path && r.canReplay ? field(w("Start from","从哪里开始"),`<select data-compose-field="start">
            ${option("replay",w("Replay to this step","回放到这一步"),form.start || "replay")}
            ${option("current",w("Current phone screen","手机当前页"),form.start)}</select>`) : "";
        return {body:`<div class="case-task-stack">
            ${start || `<p class="muted">${initial}</p>`}
            ${tasks ? `<div><h2>${r.path ? w("Requested change","修改意见") : w("Changes in this draft","本次处理的改动")}</h2>
            <ul class="case-revision-tasks">${tasks}</ul></div>` : ""}
            ${offline ? `<p class="muted">${w("Connect a phone first.","请先连接手机。")}</p>` : ""}
            ${problem}${r.verification ? revisionReceipt(r.verification,w) : ""}${progress}</div>`,
            actions:c(r.phase==="blocked" ? w("Explore again","重新探索") : r.path ? w("Explore and verify","探索并验证") :
                w("Start from the case’s entry point","从用例起点开始探索"),"revisionRun",{primary:true,off:offline})+
                (r.phase==="blocked" && r.blockedPath ? c(w("Go to the issue","返回处理该处"),"revisionEditBlocked",{quiet:true}) : "")};
    }
    const diff=r.diffs.map((line,index)=>`<details class="case-revision-diff" id="case-revision-diff-${index}"${index===0?" open":""}>
        <summary><strong>${h(line.label || w("Inserted steps","插入步骤"))}</strong>
            <small>${line.before.length ? (line.after.length ? w("Replace","替换") : w("Remove","删除")) : w("Insert","插入")}
                ${line.after.length ? " · "+line.after.length+" "+w("steps","步") : ""}</small></summary>
        ${line.before.length ? `<div><small>${w("Before","原步骤")}</small>${rows(line.before,"case-diff-removed")}</div>` : ""}
        ${line.after.length ? `<div><small>${w("Proposed","候选步骤")}</small>${rows(line.after,"case-diff-added")}</div>` : ""}
        ${line.checkedNext ? `<p class="case-revision-passed">${w("Next assertion passed","紧邻的断言已通过")}</p>` : ""}</details>`).join("");
    const whole=r.path ? "" : `<details class="case-revision-diff" id="case-revision-plan"><summary>${w("View the full replay","查看整条回放")}</summary>
        ${rows(r.plan)}</details>`;
    const ready=r.phase==="passed";
    return {body:`<div class="case-task-stack">
        ${!r.path && !ready ? `<p class="muted">${w("Return the phone to the case’s starting state before verifying the replay.",
            "验证回放前，请将手机恢复到用例的起始状态。")}</p>` : ""}
        ${diff ? `<div><h2>${w("Review the changes","核对改动")}</h2>${diff}</div>` : ""}
        ${whole}${problem}${r.verification ? revisionReceipt(r.verification,w) : ""}</div>`,
        actions:r.path ? c(w("Apply to draft","应用到草稿"),"revisionApply",{primary:true}) :
            ready ? c(w("Save as a replayable version","保存为可回放版本"),"revisionApply",{primary:true}) :
                c(w("Verify the full replay","验证整条回放"),"revisionVerify",{primary:true,off:offline})};
}

function revisionReceipt(result,w) {
    const checks=result.steps?.filter(item=>item.assertionStatus && item.assertionStatus!=="not_requested") || [];
    const failed=result.steps?.find(item=>!["completed","passed"].includes(item.status) ||
        item.assertionStatus && !["passed","not_requested"].includes(item.assertionStatus));
    return `<div class="case-revision-verification">
        <strong class="${result.complete?"case-revision-passed":""}" role="status">${result.complete ?
            w("Full replay passed","整条回放通过") : w("Replay did not complete","回放未通过")}</strong>
        ${failed ? `<p>${h(failed.label || failed.path)} · ${h(failed.error || failed.assertionStatus || failed.status)}</p>` : ""}
        ${checks.length ? `<details id="case-revision-evidence"><summary>${w("Assertion results","断言结果")} · ${checks.length}</summary>
            <ul class="case-revision-tasks">${checks.map(row=>`<li><span>${h(row.label || row.path)} ·
                ${row.assertionStatus==="passed"?w("Passed","通过"):w("Mismatch or unknown","不符或未确认")}</span>
                ${row.expected!==undefined ? `<small>${w("Expected","预期")} ${h(JSON.stringify(row.expected))} ·
                    ${w("Actual","实际")} ${h(JSON.stringify(row.actual))}</small>` : ""}</li>`).join("")}</ul></details>` : ""}</div>`;
}

export function compositionPage(model,language) {
    const state=model.caseComposition;
    if (!state) return "";
    const key=state.viewId+"|"+state.mode;
    if (form.keyFor!==key) form={keyFor:key};
    const w=(en,zh)=>words(language,en,zh);
    const title=({pick:state.replace?w("Replace reference","替换引用"):w("Insert a case","插入用例"),
        explore:state.description ? w("Generate case steps","生成用例步骤") : state.method==="history" ? w("Insert exploration result","插入探索结果") :
            state.followUp?.destination==="current" ? w("Add steps to this case with AI","用 AI 补充当前用例") : w("Explore a new continuation","探索新的后续步骤"),
        section:w("Save a reusable section","保存可复用片段"),
        revision:state.revisionWork?.path ? w("Revise step","修改步骤") : w("Explore the case draft","探索用例草稿"),
        reference:state.reference?.name,update:w("Compare versions","对比版本"),references:w("Case references","用例引用"),
        usages:w("Where this case is used","用例引用位置")})[state.mode];
    let content;
    if (state.stale) content={body:`<p class="case-composition-warning">${w("The steps changed. Return to the case to choose the position again.",
        "步骤已变化，请返回用例重新选择位置。")}</p>`};
    else switch (state.mode) {
        case "pick": content=pick(state,model,w); break;
        case "reference": case "update": content=reference(state,model,w); break;
        case "references": content={body:`<div class="case-task-stack">${browseRefs(state,model,w)}</div>`}; break;
        case "explore": content=state.description ? generationView(state,model,w) : exploreView(state,model,w); break;
        case "revision": content=revisionView(state,model,w); break;
        case "usages": content={body:`<div class="case-task-stack">${usages(state.usages,w,model.busy)}</div>`}; break;
        case "section": content=sectionView(state,model,w); break;
    }
    if (!content) return "";
    const sourcePreview = state.mode==="pick" && form.viewSource && !state.stale;
    const origin=state.name || [state.caseName,(state.mode==="update" || state.replace) && state.reference?.name].filter(Boolean).join(" / ");
    const backLabel=state.mode==="usages" ? w("Back to tests","返回测试") : w("Back to case","返回用例");
    const back=control("← "+backLabel,"close",{quiet:true,off:model.busy,attrs:{id:"case-task-back"}});
    return `<section class="case-task" data-view-id="${h(state.viewId)}" data-mode="${state.followUp ? "followUp" : h(state.mode)}" data-source-preview="${Boolean(sourcePreview)}" aria-labelledby="case-task-title">
        <header class="case-task-header">${back}<h1 id="case-task-title">${h(title)}</h1>
            ${origin ? `<p class="case-task-origin">${h(origin)}</p>` : ""}</header>
        ${!state.stale && !state.description && state.mode!=="revision" ? positionEditor(state,model,w) : ""}
        <div id="case-task-body" class="case-task-body" data-scroll-key="${h(key+"|"+(state.method||"")+"|"+Boolean(sourcePreview))}">${content.body}</div>
        ${content.actions ? `<footer class="case-task-footer">${content.actions}</footer>` : ""}</section>`;
}

export function compositionClick(button,model,send,render) {
    const action=button.dataset.compose;
    if (!action) return false;
    if (action==="select") {
        form.sourceId=button.dataset.sourceId;
        form.resultsTop=document.getElementById("case-insert-results").scrollTop;
        form.viewSource=true;
        render();
        if (!document.querySelector(".case-insert-catalog")?.getClientRects().length)
            document.getElementById("case-source-heading")?.focus({preventScroll:true});
        return true;
    }
    if (action==="backToSources") {
        form.viewSource=false;
        render();
        document.getElementById("case-insert-results").scrollTop=form.resultsTop || 0;
        const selected=document.querySelector('[data-compose="select"][aria-pressed="true"]');
        selected?.focus({preventScroll:true});
        return true;
    }
    if (action==="clearFilters") {
        form.app=form.kind=form.tag=undefined;
        render();
        return true;
    }
    if (action==="trialDetails") {form.showTrial=!form.showTrial;render();return true;}
    if (action==="browseHistory" || action==="viewHistory") {form.historyList=action==="browseHistory";render();return true;}
    if (action==="editAI" || action==="viewAI") {form.aiEdit=action==="editAI";render();return true;}
    if (action==="stop") {send({type:"caseComposeCancel"});return true;}
    if (model.busy) return true;
    const {path,side,uri,sourceId,digest,reportId,start,pick,independent,method,descriptionId,destination}=button.dataset;
    const review=model.caseReview;
    const page=button.closest(".case-task");
    const value=key=>page?.querySelector(`[data-compose-field="${key}"]`)?.value;
    const settingPosition=action==="setPosition";
    if (settingPosition) {
        const position=button.closest("details");
        position.open=false;
        position.querySelector("summary")?.focus();
    }
    if (action==="savedExplore") form.historyList=false;
    if (action==="runExplore") form.aiEdit=false;
    send({type:"caseCompose",action,id:review?.id,revision:review?.revision,uri:uri||model.plan?.uri,digest:digest||model.planDigest,
        path:settingPosition?value("position"):path,side:settingPosition?value("side"):side,sourceId,reportId,method,descriptionId,
        ...(destination && {destination}),
        ...(page?.dataset?.viewId && {viewId:page.dataset.viewId}),
        start:start || value("start"),
        goal:value("goal"),key:value("key"),property:value("property"),expected:value("expected"),runner:value("runner"),
        from:value("from"),through:value("through"),name:value("name"),pick:pick==="true",independent:independent==="true"});
    return true;
}

export function compositionInput(field,render) {
    const key=field.dataset.composeField;
    if (!key) return false;
    form[key]=field.value;
    if (["search","app","kind","tag"].includes(key)) form.viewSource=false;
    if (["search","app","kind","tag","key","property","expected","history","refFilter","goal","from","through"].includes(key)) render();
    return true;
}

export function compositionKeydown(event) {
    const page=event.target.closest(".case-task");
    if (!page || event.isComposing) return;
    if (event.key==="Escape") {
        const detail=event.target.closest("details[open]");
        const back=page.querySelector(".case-source-back");
        if (detail) {detail.open=false;detail.querySelector("summary")?.focus();}
        else if (back?.getClientRects().length) back.click();
        else page.querySelector('#case-task-back:enabled')?.click();
        event.preventDefault();
        return;
    }
    if (!["ArrowDown","ArrowUp"].includes(event.key) ||
        !event.target.matches('[data-compose-field="search"],.case-source-choice')) return;
    const choices=[...page.querySelectorAll(".case-source-choice:enabled")];
    if (!choices.length) return;
    const from=choices.indexOf(event.target);
    const to=from<0 ? (event.key==="ArrowDown"?0:choices.length-1) :
        (choices.length+from+(event.key==="ArrowDown"?1:-1))%choices.length;
    event.preventDefault();
    choices[to].focus();
}
