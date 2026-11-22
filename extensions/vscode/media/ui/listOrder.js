import { actionButton, escapeHtml } from "./controls.js";
import { closeItemMenu } from "./itemActions.js";

const rowSelector = "[data-order-index]";
const listSelector = "[data-order-kind]";

export function orderGrip(w) {
    return '<span class="list-order-grip" data-order-grip draggable="true" aria-hidden="true" title="' +
        escapeHtml(w("Drag to change order","拖动调整顺序")) + '">⠿</span>';
}

export function orderActions(w, index, count) {
    const item = (offset,label)=>actionButton(label,{attrs:{"data-order-offset":offset}});
    return (index>0 ? item(-1,w("Move up","上移")) : "") +
        (index<count-1 ? item(1,w("Move down","下移")) : "");
}

export function dropIndex(from, target, after) {
    const slot = target + Number(after);
    return slot - Number(from<slot);
}

export function bindListOrder(root, commit) {
    let drag, cue;
    function clearCue() {
        cue?.classList.remove("list-drop-before","list-drop-after");
        cue = undefined;
    }
    function reset() {
        clearCue();
        drag?.row.classList.remove("list-dragging");
        drag = undefined;
    }
    function move(row,list,to) {
        const from = Number(row.dataset.orderIndex);
        if (from===to || to<0 || to>=Array.from(list.children).filter(child=>child.matches(rowSelector)).length) return;
        commit({row,list,from,to});
    }
    root.addEventListener("dragstart",event=>{
        const grip = event.target.closest('[data-order-grip][draggable=true]');
        const row = grip?.closest(rowSelector), list = row?.parentElement;
        if (!list?.matches(listSelector) || !event.dataTransfer) return;
        closeItemMenu();
        reset();
        drag = {row,list,from:Number(row.dataset.orderIndex)};
        row.classList.add("list-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain"," ");
    });
    function dropLocation(event) {
        const row = event.target.closest(rowSelector);
        if (!drag?.row.isConnected || row?.parentElement!==drag.list) return;
        const rect = row.getBoundingClientRect();
        const after = event.clientY>rect.top+rect.height/2;
        return {row,after,to:dropIndex(drag.from,Number(row.dataset.orderIndex),after)};
    }
    root.addEventListener("dragover",event=>{
        clearCue();
        const location = dropLocation(event);
        if (!location) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (location.to===drag.from) return;
        cue = location.row;
        cue.classList.add(location.after?"list-drop-after":"list-drop-before");
    });
    root.addEventListener("drop",event=>{
        const location = dropLocation(event);
        const source = drag;
        reset();
        if (!location) return;
        event.preventDefault();
        move(source.row,source.list,location.to);
    });
    root.addEventListener("dragend",reset);
    root.addEventListener("dragleave",event=>{if (!root.contains(event.relatedTarget)) clearCue();});
    function byOffset(target,offset) {
        const row = target.closest(rowSelector), list = row?.parentElement;
        if (!list?.matches(listSelector) || !row.querySelector(":scope > [data-order-grip], :scope > [data-order-head] > [data-order-grip]"))
            return false;
        move(row,list,Number(row.dataset.orderIndex)+offset);
        return true;
    }
    root.addEventListener("click",event=>{
        const control = event.target.closest("[data-order-offset]");
        if (control && !control.disabled) byOffset(control,Number(control.dataset.orderOffset));
    });
    root.addEventListener("keydown",event=>{
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp","ArrowDown"].includes(event.key) ||
            !event.target.closest("button,summary")) return;
        if (byOffset(event.target,event.key==="ArrowUp"?-1:1)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    });
}
