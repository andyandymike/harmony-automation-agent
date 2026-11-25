export function treeKeydown(event, root, busy, toggleNode) {
    const row = event.target.closest(".node-row");
    if (!row || busy || !["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return false;
    const rows = [...root.querySelectorAll("#node-list .node-row")];
    const index = rows.indexOf(row);
    const expanded = row.getAttribute("aria-expanded");
    event.preventDefault();
    if (row.querySelector("[data-tree-toggle]") &&
        ((event.key === "ArrowLeft" && expanded === "true") || (event.key === "ArrowRight" && expanded === "false"))) {
        toggleNode(row);
    } else {
        const next = {ArrowUp:rows[index-1], ArrowDown:rows[index+1], Home:rows[0], End:rows.at(-1),
            ArrowLeft:rows.find(item=>item.dataset.ref===row.dataset.nodeParent),
            ArrowRight:rows.find(item=>item.dataset.nodeParent===row.dataset.ref)}[event.key];
        next?.click();
    }
    return true;
}
