"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const {readFileSync} = require("node:fs");
const { safeValue } = require("./networkEvidence");

const format = "harmony-agent.problem-clip/1";
const w = (language,en,zh) => /^zh/i.test(language) ? zh : en;
const h = value => String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const json = value => JSON.stringify(value,null,2);
const fields = (value,keys) => Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
function receiptFields(receipt, keys) {
    const result = fields(receipt, keys);
    if (result.gesture?.kind === "typeText") result.gesture = {kind:"typeText"};
    return result;
}
const privateKey = /^(?:cookie|set-cookie|authorization|proxy-authorization|password|passwd|secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key)$/i;

function redactNetwork(value) {
    if (Array.isArray(value)) return value.map(redactNetwork);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,privateKey.test(k) ||
            k === "value" && privateKey.test(value.name || "") ? "[redacted]" : redactNetwork(v)]));
    }
    if (typeof value !== "string") return value;
    return value.replace(/([?&](?:access_token|refresh_token|token|api[_-]?key|password)=)[^&#\s]+/gi,"$1[redacted]")
        .replace(/\b(Bearer|Basic)\s+[\w.+=\/-]+/gi,"$1 [redacted]");
}

function clipSource(bench, options) {
    if (options.source === "exploration") {
        const report=bench.state.exploration;
        if (!report || report.id!==options.id) return;
        const agent=bench.agent;
        const dir=report.evidenceDir || bench.stateDir;
        agent.stateDir=dir;
        return {title:report.goal,at:report.createdAt,source:"exploration",steps:report.steps,dir,agent,
            findings:report.findings,plan:report.plan,mockScenario:report.mockScenario};
    }
    const run=bench.state.run;
    if (!run || run.entry.id!==options.id || !Array.isArray(run.steps)) return;
    const agent=bench.agent;
    const dir=run.entry.pytest?.stateDir || bench.stateDir;
    if(run.entry.pytest?.stateDir) agent.stateDir=dir;
    return {title:run.entry.plan.name,at:run.entry.time,source:run.entry.source==="device" ? "gesture" : "workflow",
        steps:run.steps,dir,agent,runId:run.entry.id};
}

function stepReceipts(source, step) {
    if (source.source !== "exploration") return [step];
    return step.receipts?.length ? step.receipts : [step];
}

async function getScreenshot(dir,file) {
    if (!file || !path.isAbsolute(file)) return;
    const full=await fs.realpath(file);
    const relative=path.relative(await fs.realpath(dir),full);
    if (relative.startsWith(".."+path.sep) || relative===".." || path.isAbsolute(relative)) return;
    const bytes=await fs.readFile(full);
    const mime = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" :
        bytes[0]===255 && bytes[1]===216 ? "image/jpeg" : "";
    if (mime) return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function createProblemClip(bench, options) {
    const source=clipSource(bench,options);
    if (!source) throw new Error(w(bench.language,"Open the recorded run first.","请先打开对应的运行记录。"));
    const {from,to}=options;
    if (!Number.isInteger(from)||!Number.isInteger(to)||from<0||from>to||to>=source.steps.length) {
        throw new Error(w(bench.language,"Choose a valid step range.","请选择有效的步骤范围。"));
    }
    const selected=source.steps.slice(from,to+1);
    const clip={format,title:source.title,recordedAt:source.at,source:source.source,steps:[],frames:{},findings:[]};
    const frameErrors={};
    async function addFrame(runId,id) {
        if (!id || !runId) return;
        const key=runId+"/"+id;
        if (!Object.hasOwn(clip.frames,key) && !Object.hasOwn(frameErrors,key)) {
            try {
                const frame=await source.agent.call("inspect",{run_id:runId,frame_id:id,max_nodes:5000});
                clip.frames[key]={frameId:id,capturedAt:frame.capturedAt,complete:frame.quality?.complete===true &&
                    !frame.quality?.truncated && !frame.projection?.omittedMatches,nodes:frame.nodes.map(n=>
                    fields(n,["ref","parent","id","type","text","description","hint","bounds","enabled","checked","selected","visible"]))};
            } catch (error) { frameErrors[key]=error.code || "FRAME_UNAVAILABLE"; }
        }
        return key;
    }
    for (const [offset,step] of selected.entries()) {
        const runId=step.runId || source.runId;
        const group={number:from+offset+1,label:step.label || step.path,status:step.status,receipts:[]};
        for (const record of stepReceipts(source,step)) {
            const row=receiptFields(record,["path","kind","command","label","status","gesture","dispatched","selector",
                "property","expected","actual","error","elapsedMs"]);
            row.before=await addFrame(runId,record.before);
            row.after=await addFrame(runId,record.after);
            if (record.screenshot) {
                try {row.image=await getScreenshot(source.dir,record.screenshot);}
                catch (error) {row.imageError=error.code || "IMAGE_UNAVAILABLE";}
            }
            const wallClock=Number.isFinite(Date.parse(record.at)) && (Number.isFinite(record.elapsedMs) || Number.isFinite(Date.parse(record.startedAt)));
            if (options.includeNetwork && runId && record.path && (source.source!=="gesture" || wallClock) && bench.networks?.evidenceForStep) {
                const network=await bench.networks.evidenceForStep(runId,record.path,record);
                if (network?.records?.length || network?.logs?.length) row.network=redactNetwork(safeValue("",network));
            }
            group.receipts.push(row);
        }
        clip.steps.push(group);
    }
    if (Object.keys(frameErrors).length) clip.frameErrors=frameErrors;
    if (source.findings) {
        const ids=new Set(selected.map(s=>s.id));
        clip.findings=source.findings.filter(f=>ids.has(f.stepId) || f.evidenceSteps?.some(id=>ids.has(id)))
            .map(f=>fields(f,["title","kind","expected","actual","source","note","reviewStatus"]));
    }
    if (options.includePlan) {
        if (options.includeNetwork) {
            const scenario=source.mockScenario || (source.runId && await bench.networks?.scenarioForRun?.(source.runId));
            if (scenario) clip.mockScenario=redactNetwork(safeValue("",scenario));
        }
        if (source.plan) clip.plan=source.plan;
        else if (source.source==="gesture") {
            // The recording file may since have changed; only confirmed historical inputs are available here.
            clip.gestures=selected.map(s=>receiptFields(s,["path","gesture","status","dispatched"]));
        } else if (source.runId && /^[a-zA-Z0-9_-]+$/.test(source.runId)) {
            try {
                clip.plan=JSON.parse(await fs.readFile(path.join(source.dir,"runs",source.runId,"plan.json"),"utf8"));
            } catch (error) {clip.planError=error.code || "PLAN_UNAVAILABLE";}
        } else if (source.source==="exploration") {
            // Free exploration has no authored route. Keep the actual selections and receipts.
            clip.route=selected.map(s=>fields(s,["label","from","to","phase","status"]));
        }
    }
    return clip;
}

function renderProblemClip(clip,language) {
    const word=(en,zh)=>w(language,en,zh);
    const block=(name,value)=>value===undefined ? "" : `<details><summary>${h(name)}</summary><pre>${h(json(value))}</pre></details>`;
    const frame=(label,key)=>{
        if (!key) return "";
        const f=Object.hasOwn(clip.frames,key) && clip.frames[key];
        return f ? `<details><summary>${h(label)} · ${h(f.nodes.length)}</summary><small>${h(f.capturedAt)}
            ${f.complete?"":word("Partial tree","部分控件树")}</small><pre>${h(json(f.nodes))}</pre></details>` :
            `<p>${h(label)} · ${word("Frame unavailable","冻结帧不可用")} · ${h(clip.frameErrors?.[key])}</p>`;
    };
    const groups=clip.steps.map(g=>`<section><h2>${h(g.number)}. ${h(g.label || g.status)}</h2>
        ${g.receipts.map(row=>`<article><h3>${h(row.command || row.kind || row.path)} · ${h(row.status)}</h3>
            <small>${h(row.path)} ${row.elapsedMs===undefined?"":h(row.elapsedMs)+" ms"}</small>
            ${row.expected===undefined && row.actual===undefined ? "" : `<p>${word("Expected","预期")} <code>${h(json(row.expected))}</code>
            · ${word("Actual","实际")} <code>${h(json(row.actual))}</code></p>`}
            ${row.error?`<p>${h(row.error)}</p>`:""}${block("Locator",row.selector)}${block(word("Gesture","手势"),row.gesture)}
            ${row.dispatched ? `<p>${word("Device receipt","设备回执")} · ${h(row.dispatched)}</p>` : ""}
            ${frame(word("Before","操作前"),row.before)}${frame(word("After","操作后"),row.after)}
            ${/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(row.image||"")?`<img alt="${word("Recorded screen","当时的画面")}" src="${row.image}">`:""}
            ${row.imageError?`<p>${word("Image unavailable","截图不可用")} · ${h(row.imageError)}</p>`:""}
            ${block(word("Network & logs in this interval","同时段网络与日志"),row.network)}</article>`).join("")}</section>`).join("");
    const encoded=Buffer.from(JSON.stringify(clip)).toString("base64");
    const disclosures=readFileSync(path.join(__dirname,"..","media","ui","disclosure.css"),"utf8");
    return `<!doctype html><html lang="${/^zh/i.test(language)?"zh-CN":"en"}" class="problem-clip"><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
        <meta name="viewport" content="width=device-width, initial-scale=1"><title>${h(clip.title)}</title><style>${disclosures}
        :root{color-scheme:light dark}body{font:15px/1.55 system-ui,sans-serif;max-width:58rem;margin:2rem auto;padding:0 1.5rem}
        h1,h2,h3{line-height:1.3}h2{border-top:1px solid #8888;padding-top:1rem}article{padding:.3rem 1rem;border-left:3px solid #648eaa;margin:1rem 0}
        small{opacity:.8}summary{cursor:pointer;padding:.3rem 0}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;max-height:60vh}
        </style></head><body><small>Harmony Agent · ${clip.source==="exploration" ? word("Exploration evidence","探索证据") : word("Run evidence","运行证据")}</small><h1>${h(clip.title)}</h1><p>${h(clip.recordedAt)}</p>
        ${clip.findings?.length ? block(word("Findings","发现"),clip.findings) : ""}${groups}
        ${block(word("Recorded workflow","当时执行的流程"),clip.plan)}${block(word("Recorded route","实际路线"),clip.route || clip.gestures)}
        ${block(word("Regression material · recorded rule group (redacted)","回归材料 · 当时使用的 规则组（已脱敏）"),clip.mockScenario)}
        ${clip.planError ? `<p>${word("Workflow unavailable","流程不可用")} · ${h(clip.planError)}</p>` : ""}
        <template id="harmony-problem-clip">${encoded}</template></body></html>`;
}

function parseClip(html) {
    const match=/<template id="harmony-problem-clip">([A-Za-z0-9+/=]+)<\/template>/.exec(html);
    if (!match) return;
    try {
        const data=JSON.parse(Buffer.from(match[1],"base64").toString("utf8"));
        if (data?.format===format && Array.isArray(data.steps) && data.frames &&
            data.steps.every(g=>Array.isArray(g?.receipts) && g.receipts.every(r=>r && typeof r==="object")) &&
            Object.values(data.frames).every(f=>Array.isArray(f?.nodes))) return data;
    } catch { return; }
}

async function exportProblemClip(bench,vscode,message) {
    const uri=await vscode.window.showSaveDialog({filters:{HTML:["html"]},
        defaultUri:vscode.workspace.workspaceFolders?.[0] && vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,"harmony-evidence.html")});
    if (!uri) return;
    const clip=await createProblemClip(bench,message);
    await vscode.workspace.fs.writeFile(uri,Buffer.from(renderProblemClip(clip,bench.language),"utf8"));
}

async function openProblemClip(bench,vscode) {
    const [uri]=await vscode.window.showOpenDialog({canSelectMany:false,filters:{HTML:["html"]}}) || [];
    if (!uri) return;
    const clip=parseClip(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"));
    if (!clip) throw new Error(w(bench.language,"Choose an evidence HTML file exported by Harmony Agent.","请选择 Harmony Agent 导出的证据 HTML 文件。"));
    const panel=vscode.window.createWebviewPanel("harmonyAgent.problemClip",String(clip.title),vscode.ViewColumn.Active,
        {enableScripts:false,localResourceRoots:[]});
    panel.webview.html=renderProblemClip(clip,bench.language);
}

module.exports={createProblemClip,renderProblemClip,parseClip,exportProblemClip,openProblemClip,getScreenshot};
