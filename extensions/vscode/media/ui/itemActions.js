import { actionButton } from "./controls.js";

const ownerSelector = "[data-item-actions]";
const editingSelector = "input, textarea, select, [contenteditable]:not([contenteditable=false])";
let openMenu;

export function itemMenuTrigger(label, disabled = false, tabIndex) {
    return actionButton("⋯", {quiet:true, className:"item-menu-trigger", disabled, attrs:{
        "data-item-menu-trigger":"", "aria-haspopup":"menu", "aria-expanded":"false", "aria-label":label, title:label, tabindex:tabIndex,
    }});
}

export function itemMenu(label, buttons, disabled = false) {
    return buttons ? itemMenuTrigger(label,disabled) + '<div data-item-menu hidden>' + buttons + '</div>' : "";
}

export function menuItems(buttons) {
    return Array.from(buttons, button => ({
        label:button.textContent.trim(), disabled:button.matches(":disabled"), run:()=>{if (button.isConnected) button.click();},
    }));
}

export function itemMenuAnchor(target) {
    return openMenu?.menu.contains(target) ? openMenu.anchor : undefined;
}

export function closeItemMenu(restore = false) {
    if (!openMenu) return;
    const {menu, trigger, anchor, hoverTimer} = openMenu;
    clearTimeout(hoverTimer);
    openMenu = undefined;
    anchor?.removeAttribute("data-context-open");
    trigger?.setAttribute("aria-expanded","false");
    menu.remove();
    if (restore && anchor?.isConnected) anchor.focus({preventScroll:true});
}

function menuHeading(text) {
    const heading=document.createElement("div");
    heading.className="item-action-heading";
    heading.title=text;
    heading.textContent=text;
    return heading;
}

export function showItemMenu(items, {anchor, trigger, point, label, title} = {}) {
    const actions = items.filter(item=>item && (!item.disabled || item.reason));
    if (!actions.length) return false;
    closeItemMenu();
    const menu = document.createElement("div");
    menu.className = "item-action-menu";
    menu.setAttribute("role","menu");
    menu.setAttribute("aria-label",title || label || trigger?.getAttribute("aria-label") || "");
    if (title) {
        const heading=menuHeading(title);
        heading.setAttribute("aria-hidden","true");
        menu.append(heading);
    }
    const session={menu,trigger,anchor};
    function dismissChild(restore) {
        clearTimeout(session.hoverTimer);
        if (!session.child) return;
        const {popup,opener}=session.child;
        session.child=undefined;
        opener.setAttribute("aria-expanded","false");
        popup.remove();
        if (restore) opener.focus({preventScroll:true});
    }
    function openChild(opener,item,focus) {
        clearTimeout(session.hoverTimer);
        if (session.child?.opener!==opener) {
            dismissChild(false);
            const popup=document.createElement("div");
            popup.className="item-action-menu item-submenu";
            popup.setAttribute("role","menu");
            popup.setAttribute("aria-label",item.label);
            if (item.heading) {
                const heading=menuHeading(item.heading);
                heading.id="item-submenu-context";
                popup.setAttribute("aria-describedby",heading.id);
                popup.append(heading);
            }
            const children=populate(popup,item.children);
            const firstAction=children[0];
            menu.append(popup);
            const parent=menu.getBoundingClientRect(), row=opener.getBoundingClientRect();
            const {width}=popup.getBoundingClientRect();
            const fitsRight=parent.right+width<=innerWidth-6, fitsLeft=parent.left-width>=6;
            const left=fitsRight ? parent.right-1 : fitsLeft ? parent.left-width+1 : Math.min(parent.left,innerWidth-width-6);
            if (!fitsRight && !fitsLeft) {
                const back=document.createElement("button");
                back.type="button";
                back.tabIndex=-1;
                back.setAttribute("role","menuitem");
                back.textContent="‹ "+item.backLabel;
                back.addEventListener("click",()=>dismissChild(true));
                popup.prepend(back);
                children.unshift(back);
            }
            popup.style.left=Math.max(6,left)+"px";
            popup.style.top=Math.max(6,Math.min(row.top-4,innerHeight-popup.offsetHeight-6))+"px";
            session.child={popup,opener,firstAction};
            opener.setAttribute("aria-expanded","true");
            popup.addEventListener("pointerenter",()=>clearTimeout(session.hoverTimer));
        }
        if (focus) session.child.firstAction.focus({preventScroll:true});
    }
    function populate(popup,entries) {
        const buttons=entries.map((item,index)=>{
            if (index && item.group!==entries[index-1].group) {
                const separator=document.createElement("div");
                separator.setAttribute("role","separator");
                popup.append(separator);
            }
            const button=document.createElement("button");
            button.type="button";
            button.setAttribute("role","menuitem");
            button.tabIndex=-1;
            button.textContent=item.label;
            const detail=item.disabled ? item.reason : item.description;
            if (detail) {
                const note=document.createElement("small");
                note.className="item-action-description";
                note.id="item-action-detail-"+(popup===menu?"main-":"child-")+index;
                note.textContent=detail;
                button.setAttribute("aria-label",item.label);
                button.setAttribute("aria-describedby",note.id);
                button.append(note);
            }
            if (item.disabled) {
                button.setAttribute("aria-disabled","true");
            } else if (item.children?.length) {
                button.setAttribute("aria-haspopup","menu");
                button.setAttribute("aria-expanded","false");
                button.addEventListener("click",()=>openChild(button,item,true));
            } else button.addEventListener("click",()=>{
                closeItemMenu(true);
                item.run();
            });
            if (popup===menu && actions.some(action=>action.children?.length)) button.addEventListener("pointerenter",event=>{
                if (event.pointerType==="touch") return;
                clearTimeout(session.hoverTimer);
                session.hoverTimer=setTimeout(()=>{
                    if (openMenu!==session || !button.matches(":hover")) return;
                    if (!item.disabled && item.children?.length) openChild(button,item,false);
                    else dismissChild(false);
                },150);
            });
            popup.append(button);
            return button;
        });
        popup.addEventListener("keydown",event=>{
            if (event.target.closest('[role="menu"]')!==popup) return;
            const index=buttons.indexOf(document.activeElement);
            const next={ArrowDown:(index+1)%buttons.length,ArrowUp:(index+buttons.length-1)%buttons.length,
                Home:0,End:buttons.length-1}[event.key];
            if (next!==undefined) {
                if (popup===menu) dismissChild(false);
                buttons[next].focus();
            } else if (event.key==="ArrowRight" && popup===menu && !entries[index]?.disabled && entries[index]?.children?.length) {
                openChild(buttons[index],entries[index],true);
            } else if ((event.key==="ArrowLeft" && popup!==menu) || (event.key==="Escape" && session.child)) {
                dismissChild(true);
            } else if (event.key==="Escape") closeItemMenu(true);
            else if (event.key==="Tab") {closeItemMenu(true);return;}
            else return;
            event.preventDefault();
            event.stopPropagation();
        });
        return buttons;
    }
    const buttons=populate(menu,actions);
    document.body.append(menu);
    const anchorBox = (trigger || anchor).getBoundingClientRect();
    const {width,height} = menu.getBoundingClientRect();
    const {x,y} = point || {x:anchorBox.right-width, y:anchorBox.bottom+4};
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth-width-6))+"px";
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight-height-6))+"px";
    trigger?.setAttribute("aria-expanded","true");
    anchor?.setAttribute("data-context-open","");
    openMenu = session;
    buttons[0].focus({preventScroll:true});
    return true;
}

export function bindItemMenus(root, otherItems, organize, positionItems) {
    function open(target, point, anchorOverride) {
        if (target.closest(editingSelector)) return false;
        const slot = target.closest(".case-insert-slot") ||
            target.closest("[data-case-empty]")?.querySelector(":scope > .case-insert-slot");
        if (slot && positionItems) {
            return !slot.disabled && showItemMenu(positionItems(slot),{anchor:slot,point,title:slot.dataset.menuTitle});
        }
        const owner = target.closest(ownerSelector);
        if (!owner) return false;
        if (owner.hasAttribute("data-case-step") && (target.closest("[data-case-step]")!==owner ||
            target.closest(".case-inline-insert,.case-step-insertion-editor,.case-step-evidence"))) return false;
        const scoped = selector=>[...owner.querySelectorAll(selector)].filter(node=>node.closest(ownerSelector)===owner);
        const trigger = scoped("[data-item-menu-trigger]")[0];
        if (trigger?.disabled) return false;
        const anchor = anchorOverride || target.closest("button,summary") || trigger || scoped("button,summary")[0];
        if (!anchor || anchor.matches(":disabled")) return false;
        const buttons=scoped("[data-item-menu] button");
        const items=organize?.(owner,buttons) ?? [...menuItems(buttons), ...(otherItems(owner) || [])];
        return showItemMenu(items,{anchor,trigger,point,label:owner.dataset.itemLabel,title:owner.dataset.menuTitle});
    }
    root.addEventListener("click",event=>{
        const trigger = event.target.closest("[data-item-menu-trigger]");
        if (!trigger) return;
        if (openMenu?.trigger===trigger) closeItemMenu(true);
        else open(trigger,undefined,trigger);
    });
    root.addEventListener("contextmenu",event=>{
        if (open(event.target,{x:event.clientX,y:event.clientY})) event.preventDefault();
    });
    root.addEventListener("keydown",event=>{
        if (event.key!=="ContextMenu" && !(event.shiftKey && event.key==="F10")) return;
        if (open(event.target)) {
            event.preventDefault();
            event.stopPropagation();
        }
    });
    document.addEventListener("pointerdown",event=>{
        if (openMenu && !openMenu.menu.contains(event.target) && !openMenu.trigger?.contains(event.target)) closeItemMenu();
    });
    window.addEventListener("blur",()=>closeItemMenu());
    window.addEventListener("resize",()=>closeItemMenu(true));
}
