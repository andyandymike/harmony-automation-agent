const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => entities[character]);

// Tab IDs and data keys are internal component identifiers. Labels and data values
// may include localized text and are always escaped before entering the DOM.
export function tabList({id, label, active, items, className = "", panelId, locked = false}) {
    const buttons = items.map(item => {
        const selected = item.id === active;
        const data = Object.entries(item.data).map(([name, value]) => `data-${name}="${escape(value)}"`).join(" ");
        return `<button type="button" role="tab" id="${id}-tab-${item.id}" ${data}
            aria-selected="${selected}" aria-controls="${panelId || id + "-panel-" + item.id}" tabindex="${selected ? 0 : -1}">${escape(item.label)}</button>`;
    });
    return `<nav role="tablist" class="ui-tabs ${escape(className)}" aria-label="${escape(label)}"${locked ? ' aria-disabled="true"' : ""}>${buttons.join("")}</nav>`;
}

export function tabPanels({id, active, items}, contents) {
    return items.map(item => {
        const selected = item.id === active;
        return `<section role="tabpanel" id="${id}-panel-${item.id}" aria-labelledby="${id}-tab-${item.id}"
            class="ui-tab-panel" ${selected ? 'tabindex="0"' : "hidden"}>${selected ? contents : ""}</section>`;
    }).join("");
}

export function tabKeydown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const current = event.target.closest('.ui-tabs > [role="tab"]');
    if (!current) return false;
    const list = current.parentElement;
    if (list.getAttribute("aria-disabled") === "true") return false;
    const tabs = Array.from(list.children);
    const index = tabs.indexOf(current);
    let next;
    switch (event.key) {
        case "Home": next = tabs[0]; break;
        case "End": next = tabs.at(-1); break;
        case "ArrowLeft": next = tabs[(index + tabs.length - 1) % tabs.length]; break;
        case "ArrowRight": next = tabs[(index + 1) % tabs.length]; break;
        default: return false;
    }
    event.preventDefault();
    next.focus({preventScroll: true});
    next.click();
    // Selection can replace the tablist when the caller renders the new panel.
    const result = document.getElementById(next.id);
    if (result) {
        result.focus({preventScroll: true});
        const strip = result.parentElement;
        const item = result.getBoundingClientRect();
        const viewport = strip.getBoundingClientRect();
        if (item.left < viewport.left) strip.scrollLeft -= viewport.left - item.left;
        else if (item.right > viewport.right) strip.scrollLeft += item.right - viewport.right;
    }
    return true;
}
