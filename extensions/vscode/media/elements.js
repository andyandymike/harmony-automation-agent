import {vscode} from "./bridge.js";
import {showItemMenu} from "./ui/itemActions.js";
import {ListSelection} from "./ui/listSelection.js";
import "./elementsLocator.js";

const watchSelection = new ListSelection("element-watches");
const elementStepSelection = new ListSelection("element-steps");
const {ancestors,hitsAt,parseLocator,selectNodes,suggestLocator} = globalThis.harmonyElementLocators;

const escape = value => String(value ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const properties = ["text","enabled","checked","selected","visible","focused"];
const words = {
    pick:["Pick element","选取元素"], operate:["Live phone","实时操作"], attrs:["Native attributes","原生属性"],
    props:["Observable properties","可观察属性"], check:["Add assertion","加断言"], step:["Add press step","加入点按步骤"],
    pin:["Watch","观察"], copy:["Copy locator","复制定位器"], locator:["Locator","定位器"],
    actions:["Element actions","控件操作"],
    matches:["matches","个匹配"], matchesOne:["1 match","1 个匹配"], noMatch:["No matches in this snapshot","当前快照未匹配到控件"],
    selected:["selected control","当前选中控件"], other:["different control","其他控件"],
    includesSelected:["includes selected control","包含当前选中控件"], excludesSelected:["excludes selected control","未匹配当前选中控件"],
    useLocator:["Observe or add to a workflow","观察属性或加入流程"],
    operateSelected:["Operate selected control","操作选中控件"],
    casePick:["Click to select. Right-click to choose overlapping controls.","单击选取，右键可选重叠控件。"],
    caseNone:["No unique locator for this action at this point.","此处没有适用于当前动作的唯一定位器。"],
    caseEmpty:["No selectable controls on this page.","当前页没有可点选的控件。"],
    casePhotoError:["Could not load the preview. You can still choose from the control list.","无法加载画面，可以在右侧控件列表中选取。"],
    caseExit:["Exit selection","退出选取"],
    noTree:["No exposed native element here.","这里没有可识别的原生控件。"], loading:["Capturing the screen…","正在读取画面…"],
    inspectHint:["Point to highlight. Click to select.","移动指针高亮，单击选中控件。"], partial:["Partial tree · visible matches only","控件树不完整，计数仅代表已读取部分"],
    bad:["Invalid locator. Use a JSON object with native selector fields.","定位器无效，请输入包含原生定位字段的 JSON 对象。"],
    watch:["Watched properties","固定观察的属性"], unpin:["Unwatch","取消观察"], saved:["Open snapshot","查看快照"],
    sample:["Switch to the live phone to update watched properties automatically.","切回实时操作后，固定观察的属性会自动刷新。"],
    steps:["Workflow draft","流程草稿"], remove:["Remove","移除"], save:["Save workflow","保存流程"],
    unknown:["Unavailable","未采集"], absent:["matches","个匹配"], attrsHint:["Select a control in the picture or list.","点击手机画面或从列表选择控件。"],
    busy:["Reading screen","正在读取画面"], pic:["Screen snapshot","画面快照"], copyDone:["Locator copied.","已复制定位器。"],
};
let model, language, render, choose;
let selected, edit, tested={}, hover, pictureKey;
const $=id=>document.getElementById(id);
const w=k=>words[k][/^zh/i.test(language)?1:0];
const btn=(key,action,off=false,attrs="")=>'<button type="button" class="button" data-el="'+action+'" '+(off?'disabled':'')+' '+attrs+'>'+escape(w(key))+'</button>';
const send=(type,extra={})=>vscode.postMessage({type,...extra});
const validNode=()=>tested.matches?.length===1 && model?.page?.complete ? tested.matches[0] : undefined;
const casePicker=()=>{
    const picker = model?.caseReview?.stepTargets;
    if (!picker?.picture || model.deviceDisconnected || picker.picture.device!==model.device || !model.devices.includes(model.device)) return;
    if (model.tool==="recordings") return picker;
};

export function bindElements(onRender,onSelect,{selectCaseTarget,endCasePick}={}) {
    render=onRender; choose=onSelect;
    $("element-pick-mode").addEventListener("click",()=>{
        if (!model?.elements?.picking) send("elementMode",{picking:true});
    });
    $("element-operate-mode").addEventListener("click",()=>{
        if (model?.elements?.picking) send("elementMode",{picking:false});
    });
    const canvas=$("element-overlay");
    new ResizeObserver(paint).observe(canvas);
    canvas.addEventListener("pointermove",event=>{
        hover=under(event);
        const message=$("element-picker-message");
        if (hover && casePicker() && message.textContent) message.textContent="";
        paint();
    });
    canvas.addEventListener("pointerleave",()=>{hover=undefined;paint();});
    canvas.addEventListener("click",event=>{
        const node=under(event);
        const picker = casePicker();
        if (picker) {
            if (model.busy) return;
            $("element-picker-message").textContent=node ? "" : w("caseNone");
            if (node) selectCaseTarget?.(node.key,picker.picture.id);
            return;
        }
        $("element-picker-message").textContent=node?"":w("noTree");
        if(node) choose(node.ref);
    });
    canvas.addEventListener("contextmenu",event=>{
        const picker = casePicker();
        if (picker && model.busy) return;
        const items=picker ? hits(event).map(node=>({
            label:[node.label,node.detail].filter(Boolean).join(" · "),run:()=>selectCaseTarget?.(node.key,picker.picture.id),
        })) : elementMenuItems(under(event)?.ref);
        if(showItemMenu(items,{anchor:canvas,label:w("actions"),point:{x:event.clientX,y:event.clientY}})) event.preventDefault();
        else if (picker) {
            event.preventDefault();
            $("element-picker-message").textContent=w("caseNone");
        }
    });
    $("case-pick-exit").addEventListener("click",()=>{
        if (endCasePick?.()) ($("bdd-pick-screen") || $("case-check-picture"))?.focus();
    });
    $("live-device").addEventListener("keydown",event=>{
        if (event.key==="Escape" && !event.isComposing && casePicker() && endCasePick?.()) {
            event.preventDefault();
            ($("bdd-pick-screen") || $("case-check-picture"))?.focus();
        }
    });
    $("element-photo").addEventListener("load",()=>{
        const picker = casePicker();
        $("element-picker-message").textContent=picker && !picker.choices.some(choice=>choice.bounds) ? w("caseEmpty") : "";
        paint();
    });
    $("element-photo").addEventListener("error",()=>{
        if (casePicker()) $("element-picker-message").textContent=w("casePhotoError");
    });
    setInterval(()=>{
        if (!document.hidden && model?.tool==="inspect" && !model.busy && !model.deviceDisconnected &&
            !model.elements?.picking && model.elements?.watches.length)
            send("elementSample");
    },2500);
}

export function elementMenuItems(ref) {
    const page=model?.page;
    if(model?.busy || model?.tool!=="inspect" || !page?.elements) return [];
    const node=page.nodes.find(item=>item.ref===ref);
    if (!node) return [];
    const locator=(selected?.ref===ref && tested.locator) || suggestLocator(page.nodes,node);
    if (!locator) return [];
    const candidates=selectNodes(page.nodes,locator);
    const item=(key,type)=>({label:w(key),run:()=>send(type,{frameId:page.frameId,locator})});
    return [item("copy","elementCopy"),
        !model.draft && page.complete && node.pressable && candidates.length===1 && candidates[0]===node &&
            item("step","elementStep")];
}

export function updateElements(next,lang,t) {
    const switched = model?.device!==next.device;
    if (switched) { selected=edit=hover=undefined; tested={}; }
    model=next;language=lang;
    const pick=$("element-pick-mode"),operate=$("element-operate-mode");
    const inspect=next.tool==="inspect" && !next.deviceDisconnected && next.devices.includes(next.device);
    const picking=inspect && !!next.elements?.picking;
    const casePick = casePicker();
    $("case-pick-controls").hidden=!casePick;
    $("case-pick-instructions").textContent=w("casePick");
    $("case-pick-exit").textContent=w("caseExit");
    $("case-pick-exit").disabled=Boolean(next.busy);
    $("element-view-modes").hidden=!inspect;
    $("element-view-modes").setAttribute("aria-label",t.stationModeGroup);
    pick.disabled=operate.disabled=Boolean(next.busy || !inspect);
    pick.querySelector("span").textContent=w("pick");
    operate.querySelector("span").textContent=w("operate");
    pick.setAttribute("aria-pressed",String(picking));
    operate.setAttribute("aria-pressed",String(!picking));
    const shown = picking || Boolean(casePick);
    const layer=$("element-picker");layer.hidden=!shown;
    const pic=casePick?.picture || next.elements?.picture;
    const valid=shown && pic?.src && (casePick || pic.frameId===next.page?.frameId);
    const key = casePick?.picture.id || (valid && pic.frameId);
    if (pictureKey!==key) hover=undefined;
    pictureKey=key;
    const img=$("element-photo");
    if(valid && img.getAttribute("src")!==pic.src) {
        img.src=pic.src;hover=undefined;$("element-picker-message").textContent=w("loading");
    } else if(!valid) {
        img.removeAttribute("src");$("element-picker-message").textContent=next.busy?w("busy"):w("unknown");
        $("element-overlay").getContext("2d").clearRect(0,0,$("element-overlay").width,$("element-overlay").height);
    }
    if(!shown)hover=undefined;
    img.hidden=!valid;img.alt=w("pic");
    $("element-overlay").setAttribute("aria-label",w(casePick ? "casePick" : "inspectHint"));
    $("element-overlay").setAttribute("aria-describedby",casePick ? "case-pick-instructions" : "gesture-help");
    if (valid && img.complete) paint();
}

function coords(event) {
    const img=$("element-photo");
    if (img.hidden || !img.complete || !img.naturalWidth) return;
    const box=$("element-overlay").getBoundingClientRect();
    const scale=Math.min(box.width/img.naturalWidth,box.height/img.naturalHeight);
    if (!scale) return;
    return {x:(event.clientX-box.left-(box.width-img.naturalWidth*scale)/2)/scale,
        y:(event.clientY-box.top-(box.height-img.naturalHeight*scale)/2)/scale};
}
function hits(event) {
    const xy=coords(event);
    return xy ? hitsAt(casePicker()?.choices || model.page?.nodes || [],xy) : [];
}
const under = event=>hits(event)[0];

function paint() {
    const canvas=$("element-overlay"), img=$("element-photo");
    if(!img.naturalWidth || img.hidden || !img.complete) return;
    if(canvas.width!==img.naturalWidth || canvas.height!==img.naturalHeight) {
        canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
    }
    const ctx=canvas.getContext("2d");
    ctx.clearRect(0,0,canvas.width,canvas.height);
    const scale=Math.min(canvas.getBoundingClientRect().width/canvas.width,canvas.getBoundingClientRect().height/canvas.height);
    if(!scale) return;
    function frame(node,color,fill) {
        const b=node?.bounds;if(!b || node.attributes?.visible===false) return;
        ctx.strokeStyle=color;ctx.lineWidth=2/scale;ctx.fillStyle=fill;
        ctx.fillRect(b.left,b.top,b.right-b.left,b.bottom-b.top);ctx.strokeRect(b.left,b.top,b.right-b.left,b.bottom-b.top);
    }
    const pickingLocator = Boolean(casePicker());
    const matches=pickingLocator ? [] : tested.matches||[];
    for(const node of matches) frame(node,"#72dfc1","#39bd9122");
    if(!pickingLocator && selected && !matches.some(n=>n.ref===selected.ref)) {
        ctx.setLineDash([5/scale,4/scale]);
        frame(model.page?.nodes.find(n=>n.ref===selected.ref),"#c9d0d4","transparent");
        ctx.setLineDash([]);
    }
    if(hover && (pickingLocator || hover.ref!==selected?.ref)) {
        frame(hover,"#ffd272","#f1b5322b");
        const b=hover.bounds, label=pickingLocator ? hover.label.slice(0,40) :
            (hover.type||"")+" · "+(b.right-b.left)+" × "+(b.bottom-b.top);
        ctx.font=(12/scale)+"px sans-serif";
        const width=ctx.measureText(label).width+8/scale, top=Math.max(0,b.top-19/scale),
            left=Math.max(0,Math.min(b.left,canvas.width-width));
        if(width>canvas.width) return;
        ctx.fillStyle="#1d252b";ctx.fillRect(left,top,width,19/scale);
        ctx.fillStyle="#fff";ctx.fillText(label,left+4/scale,top+14/scale);
    }
}

function validate() {
    try {
        const locator=parseLocator(edit);
        tested={locator,matches:selectNodes(model.page?.nodes || [],locator)};
    }catch{tested={};}
}

export function selectElement(node,manual=false) {
    if (!node) {
        selected=edit=undefined;
        tested={};
        paint();
        return;
    }
    if(manual || !selected || selected.ref!==node.ref && selected.frameId===model.page.frameId) {
        const suggestion=suggestLocator(model.page.nodes,node);
        edit=suggestion ? JSON.stringify(suggestion,null,2) : "{}";
    }
    selected={ref:node.ref,frameId:model.page.frameId,locator:suggestLocator(model.page.nodes,node)};
    validate();paint();
}

export function rebindElement(page) {
    if (!selected?.locator || !page.complete) return;
    const nodes = selectNodes(page.nodes,selected.locator);
    return nodes.length===1 ? nodes[0] : undefined;
}

export function elementControls(node,actions) {
    if(!node || !model?.page?.elements) return "";
    selectElement(node);
    const a=node.attributes || {};
    const props=Object.entries(a).map(([key,value])=>'<div><dt>'+escape(key)+'</dt><dd>'+escape(value)+'</dd></div>');
    if(node.bounds) props.push('<div><dt>bounds</dt><dd>'+escape(JSON.stringify(node.bounds))+'</dd></div>');
    const chain=ancestors(model.page.nodes,node).map(n=>'<button type="button" class="el-crumb" data-type="parentControl" data-target="'+escape(n.ref)+'">'+escape(n.label)+'</button>');
    const disabled=Boolean(model.busy);
    const copied=model.elements?.copied;
    const sameCopy=copied && copied.frameId===model.page.frameId && copied.key===JSON.stringify(tested.locator);
    return (chain.length?'<nav class="el-crumbs">'+chain.join(' › ')+'</nav>':'')+
      '<section class="el-locator"><div class="el-locator-head"><label for="el-locator">'+w("locator")+'</label>'+
      '<button type="button" class="el-inline-action" data-el="copy" '+(disabled||!tested.locator?'disabled':'')+'>'+w("copy")+'</button></div>'+
      '<textarea id="el-locator" spellcheck="false" rows="3" aria-describedby="el-locator-result">'+escape(edit)+'</textarea>'+
      '<div class="el-result-line"><span id="el-locator-result" role="status" data-result="'+locatorState()+'">'+escape(outcome())+'</span>'+
      '<span id="el-copy-result" role="status">'+(sameCopy?w("copyDone"):'')+'</span></div></section>'+
      '<section class="el-observable"><h2>'+w("props")+'</h2><div id="el-observable">'+propertyRows()+'</div></section>'+
      '<details id="el-attributes"><summary>'+w("attrs")+'</summary>'+
      '<dl class="el-properties">'+props.join("")+'</dl></details>'+
      (node.pressable?'<div class="el-step">'+btn("step","step",disabled||!validNode()?.pressable)+'</div>':'')+
      (actions?'<details id="el-device-actions"><summary>'+w("operateSelected")+'</summary><div class="node-actions">'+actions+'</div></details>':'');
}
function locatorState() {
    if (!tested.matches) return "invalid";
    return selected && validNode()?.ref === selected.ref ? "matched" : "unresolved";
}
function outcome() {
    const matches=tested.matches;
    if(!matches) return w("bad");
    const partial=model.page.complete?"":" · "+w("partial");
    if(!matches.length) return w("noMatch")+partial;
    const name=node=>{
        const label=node.label || node.type || node.ref;
        if(node.id && node.id!==label) return label+" ("+node.id+")";
        if(model.page.nodes.some(other=>other.ref!==node.ref && other.label===label)) {
            const parent=model.page.nodes.find(other=>other.ref===node.parent);
            if(parent) return (parent.label || parent.id || parent.ref)+" › "+label;
        }
        return label;
    };
    const includes=matches.some(node=>node.ref===selected?.ref);
    if(matches.length===1) return [w("matchesOne"),name(matches[0]),w(includes?"selected":"other")].join(" · ")+partial;
    const preview=new Intl.ListFormat(language,{style:"short"}).format(matches.slice(0,3).map(name));
    return [matches.length+" "+w("matches"),preview+(matches.length>3?"…":""),w(includes?"includesSelected":"excludesSelected")].join(" · ")+partial;
}
function propertyRows() {
    const values=validNode()?.attributes;
    const available=properties.filter(property=>values?.[property]!=null);
    if (!available.length) return '<p class="muted">'+escape(w("attrsHint"))+'</p>';
    return '<dl class="el-property-rows">'+available.map(property=>{
        const action=(label,command)=>'<button type="button" class="el-inline-action" data-el="'+command+'" data-property="'+property+'" aria-label="'+
            escape(w(label)+" · "+property)+'" '+(model.busy?'disabled':'')+'>'+w(label)+'</button>';
        return '<div><dt><code>'+property+'</code></dt><dd><code>'+escape(JSON.stringify(values[property]))+'</code>'+
            '<span>'+action("pin","watch")+action("check","assert")+'</span></dd></div>';
    }).join("")+'</dl>';
}

function shown(result) {
    if(result?.state==="value")return JSON.stringify(result.value);
    if(result?.state==="matches")return result.count+" "+w("absent");
    return result?.state==="partial"?w("partial"):w("unknown");
}

export function elementsFooter(onPreviewNode,inspection="") {
    const view=model?.elements;if(!view) return inspection;
    const pair=(en,zh)=>/^zh/i.test(language) ? zh : en;
    const previewLocator=locator=>{
        if (!onPreviewNode) return;
        const matches=locator ? selectNodes(model.page?.nodes || [],locator) : [];
        onPreviewNode(matches.length===1 ? matches[0] : undefined);
    };
    watchSelection.update(model.device,view.watches.map(watch=>watch.id),model.busy);
    const tools=watchSelection.tools(pair,[{id:"remove",label:pair("Unwatch selected","取消观察所选"),
        message:ids=>({type:"elementUnwatchSelected",ids})}],{
        onPreview:id=>previewLocator(view.watches.find(item=>item.id===id)?.locator),
    });
    const watches=view.watches.map(watch=>{
        const preview=watchSelection.previewId===watch.id;
        const history=(!watchSelection.active || preview) && watch.history.length ? '<div class="el-watch-history" data-selection-ignore data-selection-detail><h3>'+pair("Property changes","属性变化")+'</h3><ol>'+watch.history.map(change=>
            '<li><time>'+escape(new Date(change.time).toLocaleTimeString(language))+'</time><span class="el-watch-change"><code>'+escape(shown(change.previous))+'</code><span> → </span><code>'+escape(shown(change.current))+'</code></span>'+
            (change.picture?.src?'<details id="el-snapshot-'+escape(watch.id+change.frameId)+'"><summary>'+w("saved")+'</summary><img class="el-snapshot" alt="'+w("pic")+'" src="'+escape(change.picture.src)+'"></details>':'')+'</li>').join("")+'</ol></div>' : '';
        return '<li'+watchSelection.row(watch.id)+'><div class="el-watch-head">'+
            watchSelection.checkbox(watch.id,pair("Select ","选择 ")+watch.label+" · "+watch.property)+'<strong>'+escape(watch.label)+'</strong>'+
            (watchSelection.active ? '' : ' '+btn("unpin","unwatch",model.busy,'data-id="'+escape(watch.id)+'"'))+'</div>'+
            '<div class="el-watch-readout" data-state="'+escape(watch.current?.state)+'"><code>'+escape(watch.locator?.id ? watch.locator.id+"."+watch.property : watch.property)+'</code><strong>'+escape(shown(watch.current))+'</strong></div>'+
            (preview ? '<div class="el-watch-locator" data-selection-detail><small>'+w("locator")+'</small> <code>'+escape(JSON.stringify(watch.locator))+'</code></div>' : '')+history+'</li>';
    }).join("");
    const revision=view.stepsRevision || 0;
    elementStepSelection.update(revision,view.steps.map((_,i)=>i),model.busy || Boolean(model.draft));
    const stepTools=elementStepSelection.tools(pair,[{id:"remove",label:pair("Delete selected","删除所选"),
        message:ids=>({type:"elementRemoveSelected",indices:ids.map(Number),revision})}],{
        onPreview:id=>{
            const step=view.steps[id];
            previewLocator(step?.assert?.selector || step?.input?.target);
        },
    });
    const steps=view.steps.map((step,i)=>'<li'+elementStepSelection.row(i)+'>'+
        elementStepSelection.checkbox(i,pair("Select step ","选择步骤 ")+(i+1))+
        '<code>'+escape(JSON.stringify(step))+'</code> '+
        (elementStepSelection.active ? '' : btn("remove","remove",model.busy,'data-index="'+i+'"'))+'</li>').join("");
    const undo=view.removedSteps?.length ? '<button type="button" class="button" data-el="undoRemoval"'+
        (model.busy || model.draft ? ' disabled' : '')+'>'+pair("Undo deletion","撤销删除")+'</button>' : "";
    const watchPanel=watches ? '<section class="el-group el-watch-panel"><h2>'+w("watch")+'</h2>'+(view.picking ? '<p>'+w("sample")+'</p>' : '')+tools+'<ul>'+watches+'</ul></section>' : '';
    return (view.picking ? inspection+watchPanel : watchPanel+inspection)+
        (steps || undo ? '<section class="el-group"><h2>'+w("steps")+'</h2>'+stepTools+undo+'<ol>'+steps+'</ol>'+
            (steps ? btn("save","save",model.busy) : "")+'</section>' : '');
}

export function elementInput(input) {
    if(input.id!=="el-locator") return false;
    edit=input.value;validate();
    const result=$("el-locator-result");
    result.textContent=outcome();
    result.dataset.result=locatorState();
    $("el-copy-result").textContent="";
    $("el-observable").innerHTML=propertyRows();
    for(const [action,bad] of [["copy",!tested.locator],["step",!validNode()?.pressable]]) {
        const button=document.querySelector('[data-el="'+action+'"]'); if(button)button.disabled=model.busy||bad;
    }
    paint();return true;
}

export function elementClick(button) {
    const action=button.dataset.el;if(!action) return false;
    const type="element"+action[0].toUpperCase()+action.slice(1);
    send(type,{frameId:model.page?.frameId,locator:tested.locator,property:button.dataset.property,
        id:button.dataset.id,index:Number(button.dataset.index),...(action==="undoRemoval" && {revision:model.elements?.stepsRevision || 0})});
    return true;
}
