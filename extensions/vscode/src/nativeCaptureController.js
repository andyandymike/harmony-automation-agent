"use strict";
const {randomUUID}=require("node:crypto");
const {captureDevice,supportsManual,timedSeconds,maxTimedSeconds,focusedApp,isCaptureApp}=require("./deviceNetwork");
const {projectHdc}=require("./projectRuntime");

async function discoverTargets(host,device,choose) {
    const active=await focusedApp(device,projectHdc(host.bench));
    if(active.bundle && !choose)return {foreground:active.bundle,candidates:[active.bundle]};
    if(active.system && !choose)return {candidates:[]};
    const agent=host.bench.agent,session="vscode-net-"+randomUUID();
    let observation;
    try {observation=(await agent.call("start",{session,device,compact:true,max_nodes:500})).observation;}
    finally {await agent.call("detach",{session});}
    const nodes=observation.nodes.filter(node=>node.visible!==false && isCaptureApp(node.bundleName));
    const bundles=rows=>[...new Set(rows.map(node=>node.bundleName))];
    const candidates=[...new Set([...(active.bundle?[active.bundle]:[]),...bundles(nodes)])];
    const sameWindow=bundles(nodes.filter(node=>String(node.hostWindowId)===active.windowId));
    const focused=bundles(nodes.filter(node=>node.focused===true));
    const foreground=active.bundle || (sameWindow.length===1 ? sameWindow[0] :
        focused.length===1 ? focused[0] : candidates.length===1 ? candidates[0] : undefined);
    return {foreground,candidates};
}
async function runNative(host,job,{probe=supportsManual,capture=captureDevice,targets=discoverTargets}={}) {
    const {bench,vscode}=host,{device,id,choose,timed}=job;
    const w=(en,zh)=>host.word(en,zh);
    if(job.disconnected.signal.aborted)return;
    const previous=host.captureInfo;
    const info=host.captureInfo={id,device,status:"starting"};
    host.changed();
    try {
        const hdcPath=projectHdc(bench);
        const {foreground,candidates}=await targets(host,device,choose);
        job.close.signal.throwIfAborted();
        if(!candidates.length)throw new Error(w("Open the target app on the selected phone.","请先在所选手机上打开目标应用。"));
        if(!choose && !foreground)throw new Error(w(
            "Could not identify the current app. Bring it to the foreground or choose an app in More capture options.",
            "无法确认当前 App。请把目标应用切到前台，或从「更多采集选项」选择应用。"));
        const target=choose ? await vscode.window.showQuickPick(candidates,{
            title:w("Select an app for native HTTP capture","选择要采集原生 HTTP 的应用")+" · "+device,
        },job.picker?.token) : foreground;
        if(!candidates.includes(target) || job.close.signal.aborted){
            if(!job.disconnected.signal.aborted)host.captureInfo=previous;
            return;
        }
        info.bundle=target;host.changed();
        const manual=!timed && await probe(device,hdcPath);
        job.close.signal.throwIfAborted();
        info.mode=timed?"timed":"manual";
        if(!manual && !timed){info.status="timedOnly";return;}
        if(timed){
            const value=await vscode.window.showInputBox({title:w("Timed native capture","定时原生采集")+" · "+target,
                prompt:w("Choose a capture duration in seconds.","输入采集时长（秒）。"),value:"30",
                validateInput:v=>timedSeconds(v)===undefined?w("Enter 1–"+maxTimedSeconds+" whole seconds.","请输入 1 到 "+maxTimedSeconds+" 之间的整数秒数。"):undefined},job.picker?.token);
            if(value===undefined || job.close.signal.aborted){if(!job.disconnected.signal.aborted)host.captureInfo=previous;return;}
            info.seconds=timedSeconds(value);
            if(info.seconds===undefined)throw new Error(w("Invalid capture duration.","采集时长无效。"));
        }
        if(bench.state.device!==device || !bench.state.devices.includes(device))
            throw new Error(w("The selected phone changed. Start a new capture.","所选设备已更改，请重新开始采集。"));
        const result=await capture({device,bundle:target,hdcPath,mode:info.mode,seconds:info.seconds,
            stopSignal:job.stop.signal,closeSignal:job.close.signal,disconnectSignal:job.disconnected.signal,
            onReady:start=>{
                info.startedAt=start;info.status="recording";
                host.changed();
            },onReading:end=>{info.endedAt=end;info.status="reading";host.changed();}});
        if(job.disconnected.signal.aborted)return;
        const batch={id,label:target};
        const {records,count}=result;
        for(const record of records)record.batch=batch;
        host.net.append(records,count-records.length);
        host.logs=[...host.logs,...result.logs].slice(-500);
        Object.assign(info,{startedAt:info.startedAt??result.start,endedAt:result.end,count,batch,
            unreadable:result.unreadable,logsAvailable:result.logsAvailable,endedBy:result.endedBy,status:count?"finished":"empty"});
    } catch(e) {
        if(job.disconnected.signal.aborted)return;
        if(job.close.signal.aborted && info.status==="starting"){host.captureInfo=previous;return;}
        info.status="error";info.error=e.message;
    }
}
function startNative(host,{choose=false,timed=false}={},services) {
    if(host.activeCapture || host.closingNative || host.disposed)return;
    const {device,devices}=host.bench.state;
    if(!devices.includes(device) || !device)throw new Error(host.bench.text.selectDevice);
    const picker=host.vscode.CancellationTokenSource?new host.vscode.CancellationTokenSource():undefined;
    const job=host.nativeJob={id:randomUUID(),device,choose,timed,stop:new AbortController(),close:new AbortController(),disconnected:new AbortController(),picker};
    // Reserve the capture before either discovery or a picker can yield.
    host.activeCapture=Promise.resolve().then(()=>runNative(host,job,services)).finally(()=>{
        job.picker?.dispose();host.nativeJob=host.activeCapture=undefined;host.changed();
    });
}
function stopNative(host,id) {
    const job=host.nativeJob,info=host.captureInfo;
    if(!job || job.id!==id || info?.status!=="recording" || info.mode!=="manual")return;
    info.status="reading";info.endedAt=Date.now();job.stop.abort();host.changed();
}
function finishNative(host) {
    const job=host.nativeJob;
    job?.picker?.cancel();job?.stop.abort();job?.close.abort();
    return host.activeCapture;
}
function closeNative(host) {
    host.closingNative=true;
    return finishNative(host);
}
function nativeDevicesChanged(host,devices) {
    const job=host.nativeJob;
    if(!job || devices.includes(job.device) || job.disconnected.signal.aborted)return;
    job.disconnected.abort();job.picker?.cancel();job.stop.abort();job.close.abort();
    const current=host.captureInfo?.id===job.id?host.captureInfo:{id:job.id,device:job.device};
    host.captureInfo={...current,status:"error",error:host.word("Phone disconnected. Capture results could not be confirmed.","手机已断开，无法确认本次采集结果。")};
    host.changed();
}
module.exports={startNative,stopNative,finishNative,closeNative,nativeDevicesChanged};
