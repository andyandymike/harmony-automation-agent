import {actionButton, escapeHtml as h} from "./controls.js";
import {itemMenuAnchor, menuItems, showItemMenu} from "./itemActions.js";
import {dragThreshold} from "./listOrder.js";

const lists = new Map();
const rowSelector = "[data-selection-list], [data-selection-ignore], [data-selection-detail]";
const rowControls = "button, a, input, textarea, select, [contenteditable], [data-order-grip], [data-tree-toggle]";
const holdDelay = 500;
let activeList;
let workspaceScope;
let libraryScope;

export const selectAllLabel = (w, all) => all ? w("Clear selection","取消全选") : w("Select all","全选");

export function exitListSelection() {
    if (!activeList) return false;
    activeList.reset();
    return true;
}

export function activeListPreview(name) {
    return activeList?.name===name ? activeList.previewId : undefined;
}

export function updateListSelectionScope(scope,caseLibraryScope) {
    const sameLibrary=activeList?.name==="case-library" && caseLibraryScope!==undefined && caseLibraryScope===libraryScope;
    if (workspaceScope!==scope && !sameLibrary) exitListSelection();
    workspaceScope = scope;
    libraryScope = caseLibraryScope;
}

const toolsSelector = list => '[data-list-tools="'+list.name+'"]';

export function exitHiddenListSelection(root) {
    if (activeList && !root.querySelector(toolsSelector(activeList))) exitListSelection();
}

export class ListSelection {
    constructor(name,{modifiers=true}={}) {
        this.name = name;
        this.modifiers=modifiers;
        this.ids = new Set();
        this.selected = new Set();
        lists.set(name,this);
    }

    update(scope, ids, busy) {
        if (this.scope!==scope) this.reset();
        this.scope = scope;
        this.ids = new Set(ids.map(String));
        this.busy = busy;
        if (!this.active) return;
        const hadSelection = this.selected.size > 0;
        for (const id of this.selected) if (!this.ids.has(id)) this.selected.delete(id);
        if (!this.ids.size || (hadSelection && !this.selected.size)) this.reset();
        else if (this.previewId && !this.selected.has(this.previewId)) this.preview();
    }

    start() {
        if (this.active) return;
        exitListSelection();
        activeList = this;
    }

    reset() {
        this.anchor=undefined;
        this.previewId=undefined;
        if (!this.active) return;
        this.selected.clear();
        activeList = undefined;
    }

    get active() { return activeList===this; }
    get values() { return [...this.ids].filter(id=>this.selected.has(id)); }
    get all() { return this.ids.size > 0 && this.selected.size === this.ids.size; }

    preview(id) {
        if (id!==undefined && this.selected.has(id)) {
            // The insertion order also remembers which remaining check was last inspected.
            this.selected.delete(id);
            this.selected.add(id);
        }
        const next=[...this.selected].at(-1);
        if (this.previewId===next) return;
        this.previewId=next;
        this.onPreview?.(next);
    }

    check(id,checked) {
        if (!this.active || this.busy || !this.ids.has(id)) return;
        this.anchor=id;
        if (checked) this.selected.add(id);
        else this.selected.delete(id);
        this.preview(checked ? id : this.previewId);
    }

    selectAll() {
        if (this.all) this.selected.clear();
        else for (const id of this.ids) this.selected.add(id);
        this.preview(this.previewId || this.ids.values().next().value);
    }

    selectModified(id,range,additive,focused) {
        const anchor=this.ids.has(this.anchor) ? this.anchor : this.ids.has(focused) ? focused : id;
        const wasActive=this.active;
        this.start();
        if (range) {
            const ids=[...this.ids],first=ids.indexOf(anchor),last=ids.indexOf(id);
            if (!additive) this.selected.clear();
            for (const value of ids.slice(Math.min(first,last),Math.max(first,last)+1)) this.selected.add(value);
            this.anchor=anchor;
        } else {
            if (!wasActive && this.anchor!==id && this.ids.has(this.anchor)) this.selected.add(this.anchor);
            if (this.selected.has(id)) this.selected.delete(id);
            else this.selected.add(id);
            this.anchor=id;
        }
        this.preview(this.selected.has(id) ? id : this.previewId);
    }

    row(id) {
        if (!this.ids.has(String(id))) return "";
        return ' data-selection-list="'+h(this.name)+'" data-selection-id="'+h(id)+'"'+
            (this.active ? ' data-selection-active' : '')+
            (this.active && this.previewId===String(id) ? ' data-selection-preview' : '')+
            (this.selected.has(String(id)) ? ' data-selection-checked' : '');
    }

    checkbox(id, label) {
        if (!this.active || !this.ids.has(String(id))) return "";
        return '<label class="list-selection-checkbox"><input type="checkbox" data-list-pick="'+h(this.name)+
            '" value="'+h(id)+'" aria-label="'+h(label)+'"'+(this.selected.has(String(id))?' checked':'')+
            (this.busy?' disabled':'')+'></label>';
    }

    tools(w, actions, {className, label, count, help, onPreview} = {}) {
        this.actions = new Map(actions.map(action=>[action.id,action]));
        this.onPreview=onPreview;
        const button=(caption,id,{disabled=false,primary=false}={})=>actionButton(caption,{
            quiet:!primary,primary,disabled:disabled || (this.busy && id!=="done"),
            attrs:{"data-list-action":id,"data-list-name":this.name},
        });
        if (!this.active) return this.ids.size ? button(w("Select multiple","多选"),"start") : "";
        const n = this.selected.size;
        return '<div class="'+h(["list-selection-tools",className].filter(Boolean).join(" "))+'" data-list-tools="'+
            h(this.name)+'" role="group" aria-label="'+h(label || w("Selected items","所选项目"))+'">'+
            '<small role="status">'+h(count || w(n===1?"1 selected":n+" selected","已选 "+n+" 项"))+'</small>'+
            button(selectAllLabel(w,this.all),"all",{disabled:!this.ids.size})+
            actions.map(action=>button(action.label,action.id,{disabled:!n || action.disabled,primary:action.primary})).join("")+
            button(w("Done","退出多选"),"done")+
            (help ? '<small class="list-selection-help">'+h(help)+'</small>' : '')+'</div>';
    }
}

function focusButton(list, action) {
    document.querySelector('[data-list-name="'+list.name+'"][data-list-action="'+action+'"]')?.focus({preventScroll:true});
}

export function listSelectionClick(control, send, render) {
    const {listName,listAction} = control.dataset;
    const list = lists.get(listName);
    if (!list || !listAction) return false;
    if (control.disabled || (list.busy && listAction!=="done")) return true;
    if (listAction==="start") list.start();
    else if (!list.active) return true;
    else if (listAction==="done") list.reset();
    else if (listAction==="all") list.selectAll();
    else {
        const action=list.actions.get(listAction);
        if (action && !action.disabled && list.selected.size) {
            if (action.run) {
                action.run(list.values);
                render();
            } else {
                const message=action.message(list.values);
                if (message) send(message);
            }
        }
        return true;
    }
    render();
    if (listAction==="start") focusButton(list,"all");
    if (listAction==="done") focusButton(list,"start");
    return true;
}

export function listSelectionChange(input, render) {
    const list=lists.get(input.dataset.listPick);
    if (!list) return false;
    if (list.active && !input.disabled && !list.busy && list.ids.has(input.value)) {
        list.check(input.value,input.checked);
        render();
    }
    return true;
}

function rowAt(target) {
    const row=target.closest(rowSelector);
    const list=lists.get(row?.dataset.selectionList);
    if (!list) return;
    const checkbox=target.closest(".list-selection-checkbox");
    const control=target.closest(rowControls);
    const part=row.contains(checkbox) ? "checkbox" :
        row.contains(control) && !control.hasAttribute("data-selection-hit") ? "action" :
        row.contains(target.closest("summary:not([data-selection-hit])")) ? "disclosure" : "row";
    return {list,row,id:row.dataset.selectionId,part};
}

function ownsTarget(list, target, hit) {
    const detail=target.closest("[data-selection-detail]")?.closest("[data-selection-preview]");
    return target.closest("[data-list-name]")?.dataset.listName===list.name ||
        target.closest("[data-list-tools]")?.dataset.listTools===list.name ||
        (detail?.dataset.selectionList===list.name && !target.closest(rowControls)) ||
        (hit?.list===list && hit.part!=="action");
}

function inputSelector(list, id) {
    return 'input[data-list-pick="'+list.name+'"][value="'+CSS.escape(id)+'"]';
}

export function bindListSelection(root, render, cancelDrag) {
    let press;
    let suppressClick = false;
    const cancelPress = () => {
        clearTimeout(press?.timer);
        press = undefined;
    };
    const exitAfterEvent = () => {
        // Let the original event and any native control action finish before replacing the view.
        if (exitListSelection()) setTimeout(render,0);
    };
    const focusRow = (list,id) => root.querySelector(inputSelector(list,id))?.focus({preventScroll:true});

    document.addEventListener("pointerdown",event=>{
        if (event.button!==0 || !event.isPrimary) return;
        cancelPress();
        suppressClick = false;
        if (event.pointerType==="touch" || !root.contains(event.target)) return;
        const hit=rowAt(event.target);
        if (!hit || hit.list.busy || !["row","disclosure"].includes(hit.part)) return;
        const {list,row,id}=hit, {pointerId,clientX,clientY}=event;
        press={pointerId,clientX,clientY,list,timer:setTimeout(()=>{
            press=undefined;
            if (!root.contains(row) || list.busy || !list.ids.has(id)) return;
            suppressClick=true;
            cancelDrag();
            window.getSelection()?.removeAllRanges();
            list.start();
            list.check(id,true);
            render();
            focusRow(list,id);
        },holdDelay)};
    },true);
    document.addEventListener("pointermove",event=>{
        if (!press || press.pointerId!==event.pointerId ||
            Math.hypot(event.clientX-press.clientX,event.clientY-press.clientY)<dragThreshold) return;
        if (press.list.active) suppressClick=true;
        cancelPress();
    },true);
    for (const type of ["pointerup","pointercancel"]) document.addEventListener(type,event=>{
        if (press?.pointerId===event.pointerId) cancelPress();
    },true);
    window.addEventListener("blur",()=>{
        cancelPress();
        suppressClick=false;
        exitAfterEvent();
    });

    document.addEventListener("click",event=>{
        if (suppressClick && event.detail>0) {
            suppressClick=false;
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (!(event.target instanceof Element)) return;
        const target=event.target;
        const hit=root.contains(target) ? rowAt(target) : undefined;
        if (hit?.list.modifiers && !hit.list.busy && (hit.part==="row" || hit.part==="checkbox")) {
            if (event.shiftKey || event.ctrlKey || event.metaKey) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const focused=hit.row.parentElement.querySelector('[aria-selected=true]')?.closest(rowSelector)?.dataset.selectionId;
                hit.list.selectModified(hit.id,event.shiftKey,event.ctrlKey||event.metaKey,focused);
                window.getSelection()?.removeAllRanges();
                render();
                focusRow(hit.list,hit.id);
                return;
            }
            hit.list.anchor=hit.id;
        }
        const list=activeList;
        if (!list) return;
        const anchor=itemMenuAnchor(event.target);
        if (anchor) {
            if (anchor.dataset.listPick!==list.name) exitAfterEvent();
            return;
        }
        // Keep popups usable while browsing their choices. Their action or change ends selection.
        if (target.closest("select, [data-item-menu-trigger]")) return;
        if (!ownsTarget(list,target,hit)) exitAfterEvent();
        else if (hit?.list===list && hit.part==="row") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (list.busy) return;
            list.check(hit.id,!list.selected.has(hit.id));
            render();
            focusRow(list,hit.id);
        }
    },true);
    for (const type of ["input","change","submit"]) document.addEventListener(type,event=>{
        if (activeList && event.target.dataset?.listPick!==activeList.name) exitAfterEvent();
    },true);

    function open(target, point) {
        const hit=rowAt(target);
        const gap=target.matches(".case-bdd-steps") && target.querySelector(":scope > [data-selection-active]");
        const list=gap ? activeList : hit?.list;
        if (!list?.active || list.busy || (!gap && hit.part==="action")) return false;
        const input=gap ? root.querySelector('input[data-list-pick="'+list.name+'"]:checked') :
            hit.row.querySelector(inputSelector(list,hit.id));
        const tools=root.querySelector(toolsSelector(list));
        if (!input || !tools || input.disabled) return false;
        const choice={label:input.getAttribute("aria-label"),run:()=>{if (input.isConnected) input.click();}};
        const items=input.checked ? menuItems(tools.querySelectorAll("button")) : [choice];
        const title=input.checked && list.name==="case-steps" ? tools.querySelector('[role="status"]')?.textContent : undefined;
        return showItemMenu(items,{anchor:input,point,label:tools.getAttribute("aria-label"),title});
    }
    root.addEventListener("contextmenu",event=>{
        if (!open(event.target,{x:event.clientX,y:event.clientY})) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    },true);
    root.addEventListener("keydown",event=>{
        if ((event.key==="ContextMenu" || event.shiftKey && event.key==="F10") && open(event.target)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    },true);
    document.addEventListener("keydown",event=>{
        const list=activeList;
        if (!list || event.key!=="Escape" || event.isComposing || !(event.target instanceof Element) ||
            itemMenuAnchor(event.target)) return;
        if (event.target!==document.body && !ownsTarget(list,event.target,rowAt(event.target))) {
            exitAfterEvent();
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        list.reset();
        render();
        focusButton(list,"start");
    },true);
}
