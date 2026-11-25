import {escapeHtml as h} from "./ui/controls.js";

function facts(rows) {
    const entries=rows.filter(([,value])=>value!==undefined && value!==null && value!=="");
    if (!entries.length) return "";
    return `<dl class="case-step-facts selected-step-facts" data-selection-detail>${entries.map(([label,value])=>
        `<div><dt>${h(label)}</dt><dd><code>${h(value)}</code></dd></div>`).join("")}</dl>`;
}

const milliseconds=value=>Number.isFinite(value) ? value+" ms" : undefined;

export function caseStepPreview(step,definition,w) {
    const {action,gesture}=definition || {};
    const check=definition?.check || (definition?.property ? definition : undefined);
    return facts([
        [w("Command","命令"),action?.command || gesture?.kind],
        [w("Locator","定位器"),definition?.locator],
        [w("Property","属性"),check?.property || action?.property],
        [w("Expected","预期"),check?.protectedValue ? "••••" : check?.expected ?? action?.expected],
        [w("Timeout","超时"),milliseconds(action?.timeout)],
        [w("Replay delay","回放间隔"),milliseconds(gesture?.delay)],
        [w("Referenced version","引用版本"),step.reference?.digest],
    ]);
}

export function recordedStepPreview(step,w) {
    const input=step.input || {};
    const selector=input.target;
    return facts([
        [w("Command","命令"),step.gesture?.kind || (step.command==="deviceGesture" ? input.kind : step.command)],
        [w("Locator","定位器"),typeof selector==="string" ? selector : selector && JSON.stringify(selector)],
        [w("Page before","操作前页面"),step.evidence?.from],
        [w("Page after","操作后页面"),step.evidence?.to],
        [w("Replay delay","回放间隔"),milliseconds(step.delayMs)],
    ]);
}
