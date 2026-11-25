import {selectAllLabel} from "./ui/listSelection.js";

const savedBreaks = new Map();
const locators = new Map();
const escape = value => String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const words = (language,en,zh) => /^zh/i.test(language) ? zh : en;
const off = value => value ? " disabled" : "";
const action = (key,label,attrs = "") => `<button type="button" class="button" data-flow-action="${key}" ${attrs}>${escape(label)}</button>`;

export function workflowDebugView(model,language,t) {
    const w=(en,zh)=>words(language,en,zh), plan=model.plan, summary=model.planSummary;
    if (!plan || !summary || summary.error) return "";
    if (summary.source === "coordinates") return `<p class="guide-copy">${w("Step debugging is available for control-based workflows.","按控件执行的流程支持断点和单步调试。")}</p>`;
    const debug = model.flowDebug?.planUri === plan.uri && model.flowDebug;
    if (debug) {
        const paused = debug.status === "paused", probe=debug.probe;
        return `<section class="plan-preview"><h2>${w("Debug workflow","调试流程")}</h2>
            <p role="status">${escape(paused ? w("Paused before ","已暂停，即将执行 ") + debug.path + " · " + (t[debug.operation] || debug.operation) :
                debug.status === "stopping" ? w("Stopping…","正在停止…") : w("Running…","正在运行…"))}</p>
            <div class="toolbar">${action("step",w("Step once","执行一步"),off(!paused))}${action("continue",w("Continue","继续"),off(!paused))}
                ${action("stop",w("Stop debugging","停止调试"),off(debug.status === "stopping"))}</div>
            ${paused ? `<label>${w("Check a locator in the paused frame","在暂停帧中验证定位器")}
                <input id="debug-locator" value="${escape(locators.get(debug.id) || "")}" placeholder='{"id":"…"}'></label>
                ${action("probe",w("Find matches","查看匹配"))}
                ${probe ? `<p role="status">${escape(probe.error || (probe.count == null ? w("No recorded frame","没有已记录的帧") :
                probe.count+" "+w("matches","个匹配")+(probe.complete===false ? w(" · partial frame"," · 控件树不完整") : "")))}</p>
                ${(probe.matches || []).map(n=>`<code>${escape([n.type,n.id,n.text || n.description].filter(Boolean).join(" · "))}</code><br>`).join("")}` : ""}` : ""}
            </section>`;
    }
    const rows = summary.rows || (summary.debugSteps || summary.commands || []).map(kind=>({kind}));
    const selected = savedBreaks.get(plan.uri) || new Set();
    return `<details id="flow-debug-tools" class="plan-preview"><summary>${w("Breakpoints & step debugging","断点与单步调试")}</summary>
        <p>${w("Choose where to pause. With no breakpoint, the runner pauses at the first check or step.","勾选要暂停的位置。未设断点时，会停在第一个检查或步骤前。")}</p>
        ${rows.length>1 ? action("allBreaks",selectAllLabel(w,rows.every((_,i)=>selected.has(i))),off(model.busy)) : ""}
        <div>${rows.map((row,i)=>`<label><input type="checkbox" data-debug-break="${i}" ${selected.has(i) ? "checked" : ""}>
            ${i+1}. ${escape([t[row.kind] || row.kind,row.detail].filter(Boolean).join(" · "))}</label>`).join("")}</div>
        ${action("start",w("Start debugging","开始调试"),off(model.busy || !model.devices.includes(model.device)))}</details>`;
}

export function evidenceExport(model,language,source,stepId) {
    const report=source==="exploration"?model.exploration:model.run;
    const count=report?.steps?.length || 0;
    if (!count) return "";
    const w=(en,zh)=>words(language,en,zh);
    const picked=source==="run" ? report.selected ?? 0 : report.steps.findIndex(x=>x.id===stepId);
    const index=picked>=0 ? picked : 0;
    const id=report.id || report.entry.id;
    return `<details class="problem-clip" id="problem-clip-${source}-${escape(id)}-${index}" data-clip-source="${source}" data-clip-id="${escape(id)}">
        <summary>${source==="exploration" ? w("Export exploration evidence","导出探索证据") : w("Export run evidence","导出运行证据")}</summary>
        <label>${w("First step","起始步骤")}<input data-clip-from type="number" min="1" max="${count}" value="${Math.max(1,index)}"></label>
        <label>${w("Last step","结束步骤")}<input data-clip-to type="number" min="1" max="${count}" value="${Math.min(count,index+2)}"></label>
        <label><input type="checkbox" data-clip-plan>${w("Include the recorded workflow","附上当时执行的流程")}</label>
        <label><input type="checkbox" data-clip-network>${w("Include recorded network & logs","附上已有的同期网络和日志")}</label>
        ${action("export",w("Save HTML evidence","保存为 HTML"),off(model.busy))}</details>`;
}

export function flowDebugInput(input,model,language) {
    if (!input.hasAttribute("data-debug-break")) return false;
    const container=input.closest("details");
    const boxes=[...container.querySelectorAll("[data-debug-break]")];
    savedBreaks.set(model.plan.uri,new Set(boxes.filter(box=>box.checked).map(box=>Number(box.dataset.debugBreak))));
    const toggle=container.querySelector('[data-flow-action="allBreaks"]');
    if (toggle) toggle.textContent=selectAllLabel((en,zh)=>words(language,en,zh),boxes.every(box=>box.checked));
    return true;
}

export function flowDebugClick(control,model,send,language) {
    const act=control.dataset.flowAction;
    if (!act) return false;
    if (act==="allBreaks") {
        const boxes=[...control.closest("details").querySelectorAll("[data-debug-break]")];
        const checked=!boxes.every(box=>box.checked);
        for (const box of boxes) box.checked=checked;
        if (boxes.length) flowDebugInput(boxes[0],model,language);
    } else if (act==="start") {
        const breaks=Array.from(control.closest("details").querySelectorAll("[data-debug-break]:checked"), e=>Number(e.dataset.debugBreak));
        savedBreaks.set(model.plan.uri,new Set(breaks));
        send({type:"flowDebugStart",breakpoints:breaks});
    } else if (act==="export") {
        const box=control.closest(".problem-clip");
        const from=box.querySelector("[data-clip-from]"),to=box.querySelector("[data-clip-to]");
        if (!from.reportValidity() || !to.reportValidity() || Number(from.value)>Number(to.value)) return true;
        send({type:"problemExport",source:box.dataset.clipSource,id:box.dataset.clipId,
            from:Number(from.value)-1,to:Number(to.value)-1,includePlan:box.querySelector("[data-clip-plan]").checked,
            includeNetwork:box.querySelector("[data-clip-network]").checked});
    } else {
        const debug=model.flowDebug;
        if (!debug) return true;
        const selector=act==="probe" ? control.closest("section").querySelector("#debug-locator").value : undefined;
        if (selector !== undefined) locators.set(debug.id,selector);
        send({type: {step:"flowDebugStep",continue:"flowDebugContinue",stop:"flowDebugStop",probe:"flowDebugProbe"}[act],
            id:debug.id,token:debug.token,selector});
    }
    return true;
}
