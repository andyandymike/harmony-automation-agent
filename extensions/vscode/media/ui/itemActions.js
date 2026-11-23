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

export function closeItemMenu(restore = false) {
    if (!openMenu) return;
    const {menu, trigger, anchor} = openMenu;
    openMenu = undefined;
    trigger?.setAttribute("aria-expanded","false");
    menu.remove();
    if (restore && anchor?.isConnected) anchor.focus({preventScroll:true});
}

export function showItemMenu(items, {anchor, trigger, point, label} = {}) {
    const actions = items.filter(item=>item && !item.disabled);
    if (!actions.length) return false;
    closeItemMenu();
    const menu = document.createElement("div");
    menu.className = "item-action-menu";
    menu.setAttribute("role","menu");
    menu.setAttribute("aria-label",label || trigger?.getAttribute("aria-label") || "");
    const buttons = actions.map((item,index)=>{
        if(index && item.group!==actions[index-1].group) {
            const separator=document.createElement("div");
            separator.setAttribute("role","separator");
            menu.append(separator);
        }
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role","menuitem");
        button.tabIndex = -1;
        button.textContent = item.label;
        button.addEventListener("click",()=>{
            closeItemMenu(true);
            item.run();
        });
        menu.append(button);
        return button;
    });
    document.body.append(menu);
    const anchorBox = (trigger || anchor).getBoundingClientRect();
    const {width,height} = menu.getBoundingClientRect();
    const {x,y} = point || {x:anchorBox.right-width, y:anchorBox.bottom+4};
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth-width-6))+"px";
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight-height-6))+"px";
    trigger?.setAttribute("aria-expanded","true");
    openMenu = {menu, trigger, anchor};
    buttons[0].focus({preventScroll:true});
    menu.addEventListener("keydown",event=>{
        const index = buttons.indexOf(document.activeElement);
        const next = {ArrowDown:(index+1)%buttons.length, ArrowUp:(index+buttons.length-1)%buttons.length,
            Home:0, End:buttons.length-1}[event.key];
        if (next!==undefined || event.key==="Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (next===undefined) closeItemMenu(true);
            else buttons[next].focus({preventScroll:true});
        } else if (event.key==="Tab") closeItemMenu(true);
    });
    return true;
}

export function bindItemMenus(root, otherItems) {
    function open(target, point, anchorOverride) {
        const owner = target.closest(ownerSelector);
        if (!owner || target.closest(editingSelector)) return false;
        const scoped = selector=>[...owner.querySelectorAll(selector)].filter(node=>node.closest(ownerSelector)===owner);
        const trigger = scoped("[data-item-menu-trigger]")[0];
        if (trigger?.disabled) return false;
        const anchor = anchorOverride || target.closest("button,summary") || trigger || scoped("button,summary")[0];
        if (!anchor || anchor.matches(":disabled")) return false;
        const items = [...menuItems(scoped("[data-item-menu] button")), ...(otherItems(owner) || [])];
        return showItemMenu(items,{anchor,trigger,point,label:owner.dataset.itemLabel});
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
