"use strict";

const { deviceRecordingFormat, targetLabel } = require("./model");

const commands = new Set(["observe", "find", "press", "fill", "scroll", "back", "wait", "open"]);
const gestures = new Set(["click", "doubleClick", "longClick", "swipe", "drag", "fling", "pinch", "back", "home",
    "recents", "typeText", "unsupported"]);
const operations = ["assert", "read", "if", "repeat", "transform", "yield", "stop"];

function stepKind(step, coordinates) {
    if (!step || typeof step !== "object") return "unknownStep";
    if (coordinates) {
        return step.command === "deviceGesture" && gestures.has(step.input?.kind) ? step.input.kind : "unknownStep";
    }
    if (commands.has(step.command)) return step.command;
    return operations.find(kind => Object.hasOwn(step, kind)) || "unknownStep";
}

function controlFlow(steps) {
    const found = new Set();
    const pending = [steps];
    while (pending.length && found.size < 2) {
        for (const step of pending.pop()) {
            if (Object.hasOwn(step || {}, "if")) {
                found.add("if");
                if (Array.isArray(step.then)) pending.push(step.then);
                if (Array.isArray(step.else)) pending.push(step.else);
            }
            if (Object.hasOwn(step || {}, "repeat")) {
                found.add("repeat");
                if (Array.isArray(step.repeat?.steps)) pending.push(step.repeat.steps);
            }
        }
    }
    return [...found];
}

function describeCheck(check) {
    const target = targetLabel(check?.selector);
    if (!target || !Object.hasOwn(check, "equals")) return "";
    const property = check.property ?? "text";
    if (typeof property !== "string") return "";
    let value = check.equals;
    if (value && typeof value === "object") value = value.var ? "$" + value.var : undefined;
    const masked = property === "text" && /password|passcode|secret|token|密码|口令|验证码/i.test(JSON.stringify(check.selector));
    const expected = value === undefined ? "" : masked ? " = ••••" : " = " + JSON.stringify(value).slice(0, 120);
    return target.slice(0, 100) + " · " + property.slice(0, 32) + expected;
}

function point(x, y) {
    return Number.isFinite(x) && Number.isFinite(y) ? `(${x}, ${y})` : "";
}

function describeStep(step, kind, coordinates) {
    const input = step?.input || {};
    if (coordinates) return kind === "recents" ? "" :
        [point(input.x, input.y), point(input.toX, input.toY)].filter(Boolean).join(" → ");
    const check = kind === "wait" ? {selector: input.target, property: input.property, equals: input.equals} :
        step?.assert || step?.if || step?.repeat?.until;
    return describeCheck(check) || targetLabel(input.target || step?.read?.selector) ||
        (kind === "open" && typeof input.app === "string" ? input.app : "");
}

function summarizePlan(plan) {
    if (!Array.isArray(plan?.steps)) return undefined;
    const coordinates = plan.format === deviceRecordingFormat;
    const rows = plan.steps.map(step => {
        const kind = stepKind(step, coordinates);
        return {kind, detail: describeStep(step, kind, coordinates).slice(0, 260)};
    });
    return {
        source: coordinates ? "coordinates" : "workflow",
        stepCount: plan.steps.length,
        commands: rows.slice(0, 5).map(row => row.kind),
        rows,
        initialChecks: Array.isArray(plan.preconditions) ? plan.preconditions.map(describeCheck).filter(Boolean) : [],
        finalChecks: Array.isArray(plan.goals) ? plan.goals.map(describeCheck).filter(Boolean) : [],
        hasGoal: Array.isArray(plan.goals) && plan.goals.length > 0,
        controlFlow: coordinates ? [] : controlFlow(plan.steps),
    };
}

module.exports = { summarizePlan };
