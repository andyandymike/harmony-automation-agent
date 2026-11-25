"use strict";

const {ancestors,hitsAt,selectNodes,suggestLocator} = require("../media/elementsLocator");

const controlCommands = new Map([["click","press"],["swipe","scroll"],["fling","scroll"],["typeText","fill"],["back","back"]]);

function controlTarget(page, command, point) {
    if (!page?.complete) return {issue:"recordingIncompleteTree"};
    const {nodes} = page;
    let node;
    if (command === "fill") {
        const focused = nodes.filter(item=>item.visible !== false && item.editable && item.attributes.focused === true);
        if (focused.length !== 1 || !focused[0].id) return {issue:"recordingFocusInput"};
        [node] = focused;
    } else {
        const hits = hitsAt(nodes,point);
        const leaf = hits[0];
        if (!leaf) return {issue:"recordingPickControl"};
        const path = new Set([leaf,...ancestors(nodes,leaf)]);
        const eligible = hits.filter(item=>command === "scroll" ? item.scrollable : item.pressable || item.editable);
        // A tap on a label can target its button, but two overlapping sibling controls are ambiguous.
        if (eligible.some(item=>!path.has(item))) return {issue:"recordingPickControl"};
        node = eligible[0];
        if (!node) return {issue:command === "scroll" ? "recordingScrollControl" : "recordingPickControl"};
    }
    const locator = suggestLocator(nodes,node);
    const matches = locator ? selectNodes(nodes,locator) : [];
    if (matches.length !== 1 || matches[0] !== node) return {issue:"recordingPickControl"};
    return {node,locator};
}

function phoneControlStep(page, step, control) {
    if (step.input.kind !== "click" || !control || !page?.complete) return step;
    const {bounds, ...attributes} = control;
    const hits = hitsAt(page.nodes, step.input).filter(node =>
        Object.entries(attributes).every(([field, value]) => node.attributes[field] === value) &&
        (!bounds || Object.entries(bounds).every(([edge, value]) => node.bounds[edge] === value)));
    if (hits.length !== 1) return step;

    const {node, locator} = controlTarget(page, "press", step.input);
    if (!locator || !(locator.id || locator.text || locator.description || locator.hint)) return step;
    if (node.editable && !locator.id) return step;
    // UiTest can report a label inside the actionable control.
    if (hits[0] !== node && !ancestors(page.nodes, hits[0]).includes(node)) return step;
    return {command:"press", input:{target:locator}, label:node.editable ? node.id : node.label};
}

function scrollDirection({x,y,toX,toY}) {
    const dx = toX - x, dy = toY - y;
    if (!dx && !dy) return;
    if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "right" : "left";
    return dy < 0 ? "down" : "up";
}

function boundaryControls(page) {
    return (page?.nodes || []).filter(node=>node.visible !== false && node.selector)
        .map(({ref,id,type,label,editable,text,visible,selector,bundle,pressable,scrollable})=>
            ({ref,id,type,label,editable,text,visible,selector,bundle,pressable,scrollable}));
}

module.exports = {controlCommands,controlTarget,phoneControlStep,scrollDirection,boundaryControls};
