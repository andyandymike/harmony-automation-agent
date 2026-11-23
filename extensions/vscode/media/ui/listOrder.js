import { actionButton, escapeHtml } from "./controls.js";
import { closeItemMenu } from "./itemActions.js";

const rowSelector = "[data-order-index]";
const listSelector = "[data-order-kind]";
const gripSelector = ":scope > [data-order-grip], :scope > [data-order-head] > [data-order-grip]";
const interactive = "input, textarea, select, label, [contenteditable], [data-order-ignore], button:not([data-order-hit]), summary:not([data-order-hit])";
const rowChildren = list => Array.from(list.children).filter(child=>child.matches(rowSelector));

export function orderGrip(w) {
    return '<span class="list-order-grip" data-order-grip aria-hidden="true" title="' +
        escapeHtml(w("Drag to change order","拖动调整顺序")) + '">⠿</span>';
}

export function orderActions(w, index, count) {
    const item = (offset,label)=>actionButton(label,{attrs:{"data-order-offset":offset}});
    return (index>0 ? item(-1,w("Move up","上移")) : "") +
        (index<count-1 ? item(1,w("Move down","下移")) : "");
}

function locateRow(target) {
    const row=target.closest(rowSelector), list=row?.parentElement;
    if (list?.matches(listSelector) && row.querySelector(gripSelector)) return {row,list};
}

function scrollingParent(node) {
    for (let parent=node.parentElement; parent; parent=parent.parentElement) {
        if (parent.scrollHeight>parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
    }
    return document.scrollingElement;
}

function lift(row,index,box) {
    const ghost=document.createElement("div");
    ghost.className="list-order-ghost";
    ghost.setAttribute("aria-hidden","true");
    const number=document.createElement("span");
    number.textContent=String(index+1);
    const title=document.createElement("strong");
    title.textContent=row.dataset.orderLabel || row.textContent.trim();
    ghost.append(number,title);
    ghost.style.width=box.width+"px";
    document.body.append(ghost);
    return ghost;
}

export function bindListOrder(root, commit) {
    let pointer, suppressClick=false;

    function move(row,list,to) {
        const from=Number(row.dataset.orderIndex);
        if (from===to || to<0 || to>=rowChildren(list).length) return;
        commit({row,list,from,to});
    }

    function stop(accept=false) {
        const drag=pointer;
        pointer=undefined;
        if (!drag?.ghost) return;
        cancelAnimationFrame(drag.animation);
        drag.ghost.remove();
        drag.row.classList.remove("list-order-source");
        drag.list.classList.remove("list-order-active");
        for (const item of drag.items) item.row.style.removeProperty("--order-shift");
        if (root.hasPointerCapture(drag.id)) root.releasePointerCapture(drag.id);
        suppressClick=true;
        setTimeout(()=>{suppressClick=false;},0);
        if (accept && drag.row.isConnected) move(drag.row,drag.list,destination(drag));
    }

    function destination(drag) {
        const y=drag.y-drag.startY+drag.center-drag.list.getBoundingClientRect().top;
        return drag.items.filter((item,index)=>index!==drag.from && y>item.middle).length;
    }

    function preview(drag) {
        if (pointer!==drag || !drag.row.isConnected) {stop();return;}
        const scroller=drag.scroller;
        if (scroller) {
            const at=scroller===document.scrollingElement ? {top:0,bottom:innerHeight} : scroller.getBoundingClientRect();
            const edge=40;
            if (drag.y<at.top+edge) scroller.scrollTop-=Math.min(18,(at.top+edge-drag.y)*0.35);
            if (drag.y>at.bottom-edge) scroller.scrollTop+=Math.min(18,(drag.y-at.bottom+edge)*0.35);
        }
        const to=destination(drag);
        if (to!==drag.to) {
            drag.to=to;
            for (const [index,item] of drag.items.entries()) {
                const shift=index>drag.from && index<=to ? -drag.span : index<drag.from && index>=to ? drag.span : 0;
                item.row.style.setProperty("--order-shift",shift+"px");
            }
        }
        drag.ghost.style.transform="translate3d("+drag.left+"px,"+(drag.y-drag.ghostOffset)+"px,0)";
        drag.animation=requestAnimationFrame(()=>preview(drag));
    }

    function begin(drag) {
        const {row,list}=drag, box=row.getBoundingClientRect(), top=list.getBoundingClientRect().top;
        const rows=rowChildren(list), from=rows.indexOf(row);
        if(from<0)return;
        const rects=rows.map(item=>item.getBoundingClientRect());
        const gap=rects[from+1] ? rects[from+1].top-box.bottom : from ? box.top-rects[from-1].bottom : 0;
        closeItemMenu();
        try {root.setPointerCapture(drag.id);} catch {pointer=undefined;return;}
        window.getSelection()?.removeAllRanges();
        const ghost=lift(row,from,box);
        Object.assign(drag,{from,to:from,ghost,items:rows.map((item,index)=>({row:item,middle:rects[index].top+rects[index].height/2-top})),
            center:box.top+box.height/2,span:box.height+gap,scroller:scrollingParent(list),left:box.left,
            ghostOffset:Math.max(0,Math.min(ghost.offsetHeight,drag.startY-box.top))});
        row.classList.add("list-order-source");
        list.classList.add("list-order-active");
        preview(drag);
    }

    root.addEventListener("pointerdown",event=>{
        if (pointer || event.button!==0 || event.pointerType==="touch") return;
        const location=locateRow(event.target);
        const control=event.target.closest(interactive);
        if (location && !location.row.contains(control))
            pointer={...location,id:event.pointerId,startX:event.clientX,startY:event.clientY,y:event.clientY};
    });
    document.addEventListener("pointermove",event=>{
        const drag=pointer;
        if (!drag || drag.id!==event.pointerId) return;
        drag.y=event.clientY;
        if (!drag.ghost && Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>=6) begin(drag);
        if (drag.ghost) event.preventDefault();
    });
    document.addEventListener("pointerup",event=>{
        if (pointer?.id===event.pointerId) {
            pointer.y=event.clientY;
            stop(true);
        }
    });
    document.addEventListener("pointercancel",event=>{
        if (pointer?.id===event.pointerId) stop();
    });
    root.addEventListener("lostpointercapture",event=>{
        if (pointer?.id===event.pointerId) stop();
    });
    window.addEventListener("blur",()=>stop());
    window.addEventListener("resize",()=>stop());
    root.addEventListener("click",event=>{
        if (!suppressClick) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    },true);

    function byOffset(target,offset) {
        const location=locateRow(target);
        if (!location) return false;
        const {row,list}=location;
        move(row,list,Number(row.dataset.orderIndex)+offset);
        return true;
    }
    root.addEventListener("click",event=>{
        const control=event.target.closest("[data-order-offset]");
        if (control && !control.disabled) byOffset(control,Number(control.dataset.orderOffset));
    });
    root.addEventListener("keydown",event=>{
        if (event.key==="Escape" && pointer?.ghost) {
            stop();
            event.preventDefault();
            event.stopImmediatePropagation();
        }
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp","ArrowDown"].includes(event.key) ||
            !event.target.closest("button,summary")) return;
        if (byOffset(event.target,event.key==="ArrowUp"?-1:1)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    });
    return ()=>stop();
}
