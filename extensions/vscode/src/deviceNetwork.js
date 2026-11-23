"use strict";
const {execFile} = require("node:child_process");
const {promisify} = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {randomUUID} = require("node:crypto");
const {setTimeout:delay} = require("node:timers/promises");
const {hdcExecutable} = require("./deviceRecorder");
const {decodeTraceFile,emptyTraceDigest} = require("./deviceTrace");
const {historyLimit}=require("./network");
const exec = promisify(execFile);
const bundleName = /^[A-Za-z][\w]*(?:\.[\w]+)+$/;
const systemBundle = /(?:^|\.)(?:systemui|sceneboard|navigationbar|statusbar|inputmethod)(?:\.|$)|^com\.(?:ohos|huawei)\.launcher(?:\.|$)/i;

function commandOutput({stdout,stderr}) {
    return [stdout,stderr].filter(Boolean).join("\n").trim();
}

function transport(device, hdcPath) {
    if (!device) throw new Error("Select a device. / 请先选择设备。");
    return async (args, timeout=10000, signal) => {
        let result;
        try {
            result=commandOutput(await exec(hdcExecutable(hdcPath),["-t",device,...args],
                {windowsHide:true,timeout,signal,maxBuffer:8*1024*1024}));
        } catch(error) {
            signal?.throwIfAborted();
            const output=commandOutput(error).slice(-1000);
            const reason=error.code==="ENOENT" ? "HDC executable not found. / 找不到 HDC 可执行文件。" :
                error.killed ? `HDC timed out after ${timeout/1000}s. / HDC 命令超时（${timeout/1000} 秒）。` :
                    output || `HDC failed (${error.code ?? error.signal ?? "unknown"}). / HDC 执行失败。`;
            throw new Error(output && reason!==output ? reason+"\n"+output : reason,{cause:error});
        }
        if (/\[Fail\]|^error:/im.test(result)) throw new Error(result);
        return result;
    };
}

function isCaptureApp(value) {
    return typeof value === "string" && bundleName.test(value) && !systemBundle.test(value);
}

async function focusedApp(device,hdcPath,hdc=transport(device,hdcPath)) {
    const dump=await hdc(["shell","hidumper","-s","WindowManagerService","-a","-a"],4000).catch(()=>"");
    const ids=new Set([...dump.matchAll(/^\s*Focus(?:ed)?\s+window(?:\s*id)?\s*:\s*(\d+)\s*$/gim)].map(match=>match[1]));
    if(ids.size!==1)return {};
    const [windowId]=ids;
    // Read the focused process from the WindowManager table. Window names are not bundle names.
    const lines=dump.split(/\r?\n/);
    const header=lines.findIndex(line=>/\bWindowName\s+DisplayId\s+Pid\s+WinId\b/i.test(line));
    const row=header<0 ? undefined : lines.slice(header+1).map(line=>line.trim().match(/^(.+?)\s+\d+\s+(\d+)\s+(\d+)\s+/))
        .find(match=>match?.[3]===windowId);
    if(!row)return {windowId};
    const [,name,pid]=row;
    if(/^(?:ScreenLockWindow|RecentView|EntryView)$/i.test(name))return {windowId,system:true};
    if(pid==="0")return {windowId};
    const cmdline=await hdc(["shell","cat","/proc/"+pid+"/cmdline"],3000).catch(()=>"");
    const processName=cmdline.split(/[\u0000\s]/,1)[0].split(":",1)[0];
    return {windowId,...(isCaptureApp(processName) && {bundle:processName})};
}

async function reverseFixture(device,hdcPath,baseUrl,phonePort=18990,call=transport(device,hdcPath)) {
    const local="tcp:"+new URL(baseUrl).port, remote="tcp:"+phonePort;
    const mappedTo=async()=>{
        const listing=await call(["fport","ls"]);
        const match=listing.split(/\r?\n/).map(line=>line.trim().split(/\s+/))
            .find(([id,port,,direction])=>id===device && port===remote && direction?.toLowerCase()==="[reverse]");
        return match?.[2];
    };
    const mapping={device,url:"http://127.0.0.1:"+phonePort, close:async()=>{
        if(await mappedTo()===local) await call(["fport","rm",remote,local]);
    }};
    if(await mappedTo()) throw new Error("The selected phone port already has a mapping. Release it in the tool that created it. / 所选手机端口已有映射，请在创建它的工具中解除。");
    await call(["rport",remote,local]);
    try{
        if(await mappedTo()!==local) throw new Error("HDC did not confirm the device mapping. / HDC 未确认指定的设备映射。");
    }catch(error){
        // rport succeeded; retain its exact pair for a checked cleanup after a disconnect.
        try {await mapping.close();}
        catch {error.ownedMapping=mapping;}
        throw error;
    }
    return mapping;
}

function logMetadata(text,pid,start,end,clockOffsetMs) {
    const logs=[];
    for (const line of text.split(/\r?\n/)) {
        const row=line.match(/^\s*(\d{10}\.\d+)\s+(\d+)\s+\d+\s+([DIWEF])\s+([^: ]+):/);
        if (!row || Number(row[2])!==pid) continue;
        const at=Number(row[1])*1000+clockOffsetMs;
        if (at>=start && at<=end) logs.push({at:new Date(at).toISOString(),level:row[3],tag:row[4]});
    }
    return logs;
}

// The extension bounds a timed device job that cannot be finalized manually on legacy profilers.
const maxTimedSeconds=3600;
function timedSeconds(value) {
    const s=String(value).trim();
    if(!/^\d+$/.test(s) || Number(s)<1 || Number(s)>maxTimedSeconds) return undefined;
    return Number(s);
}
async function supportsManual(device,hdcPath,hdc=transport(device,hdcPath)) {
    const [version,help]=await Promise.all([hdc(["shell","param","get","const.ohos.apiversion"]).catch(()=>""),hdc(["shell","hiprofiler_cmd","-h"]).catch(()=>"")]);
    if (!/^\d+$/.test(version) || Number(version)<24) return false;
    // Older help also advertises "--start / -s" for starting the service.
    const hasCommand=name=>new RegExp("(?:^\\s*|\\bhiprofiler_cmd\\s+)"+name+"(?:\\s|:|$)","im").test(help);
    if (hasCommand("start") && hasCommand("stop")) return true;
    // Some recent phones still print the legacy option list. Check the command's
    // own start/stop messages without starting or stopping a profiler session.
    const usage=await hdc(["shell",`strings -n 4 "$(command -v hiprofiler_cmd)" | grep -F 'hiprofiler_cmd '`],3000).catch(()=>"");
    return usage.includes("hiprofiler_cmd start command shouldn't use time parameter") &&
        usage.includes("Use 'hiprofiler_cmd stop' to stop profiling");
}
function checkProfiler(text) {
    if(/(?:^|\n)\s*(?:fail(?:ed|ure)?\b|error\b|usage:|unknown (?:option|command)|invalid (?:option|command)|.*already (?:started|running))/i.test(text))
        throw new Error("Network profiler: "+text.slice(-600));
}
async function isFinalTrace(hdc,file,size,requireDigest=false) {
    if(size<1024)return false;
    const value=await hdc(["shell","od","-An","-v","-j","8","-N","48","-t","u1",file],2000);
    const bytes=value.trim().split(/\s+/).map(Number);
    if(bytes.length!==48 || !bytes.every(b=>Number.isInteger(b)&&b>=0&&b<256))return false;
    const header=Buffer.from(bytes);
    const digest=header.subarray(16,48);
    // A matching length during capture is insufficient. Once stopped, retain compatibility with non-empty traces without a digest.
    return header.readBigUInt64LE()===BigInt(size) &&
        (size===1024 ? digest.equals(emptyTraceDigest) : !requireDigest || digest.some(byte=>byte!==0));
}
async function manualTraceFinished(hdc,file,requireDigest) {
    const size=await hdc(["shell","stat","-c","%s",file],3000);
    if(!/^\d+$/.test(size))throw new Error("Capture no longer present on this phone. / 设备上找不到本次采集。");
    return isFinalTrace(hdc,file,Number(size),requireDigest);
}

async function ownedManualRunning(hdc,config) {
    const script=`command -v strings >/dev/null || exit 0; for p in $(pidof hiprofiler_cmd); do `+
        `argv=$(strings -n 4 "/proc/$p/cmdline" 2>/dev/null) || exit 0; `+
        `if printf '%s\\n' "$argv" | grep -Fxq 'start' && printf '%s\\n' "$argv" | grep -Fxq '${config}'; `+
        `then printf active; exit 0; fi; done; printf ended`;
    const state=await hdc(["shell",script],3000).catch(()=>"");
    return state==="active" ? true : state==="ended" ? false : undefined;
}
async function interruptTimed(hdc,config) {
    // Only the command whose argv contains this capture's generated UUID is ours.
    // The legacy service still has the explicit finite -t duration if the device disconnects.
    const script=`for p in $(pidof hiprofiler_cmd); do if strings -n 4 /proc/$p/cmdline | grep -Fxq '${config}'; then kill -INT "$p"; fi; done`;
    await hdc(["shell",script],3000);
}

async function stopUnconfirmedManual(hdc,config) {
    // A failed start may leave a background process. Only stop a sole manual invocation
    // whose command line contains this attempt's unique config.
    const script=`set -- $(pidof hiprofiler_cmd); [ "$#" -eq 1 ] || exit 0; argv=$(strings -n 4 /proc/$1/cmdline); `+
        `printf '%s\\n' "$argv" | grep -Fxq 'start' && printf '%s\\n' "$argv" | grep -Fxq '${config}' || exit 0; `+
        `exec hiprofiler_cmd stop </dev/null`;
    checkProfiler(await hdc(["shell",script],15000));
}

async function manualStartError(hdc,log,error) {
    let diagnostic;
    try { diagnostic=await hdc(["shell",`if [ -f '${log}' ]; then tail -c 1200 '${log}'; fi`],3000); }
    catch(failure) { diagnostic=failure.message; }
    const reason=diagnostic || error?.message || "";
    return new Error("Could not confirm this capture started. / 无法确认本次采集已开始。"+
        (reason ? "\n"+reason.slice(-1200) : ""),{cause:error});
}
async function readFinalTrace(hdc,remote,trace,pid,offset,pause,manual,disconnectSignal) {
    const file=remote+".htrace";
    // Non-blocking stop may return before the header is finalized. Poll bytes of
    // metadata; do not repeatedly transfer the archive to discover that it is still open.
    for(let attempt=0;attempt<8;attempt++){
        disconnectSignal?.throwIfAborted();
        const sizeText=await hdc(["shell","stat","-c","%s",file],3000);
        const bytes=/^\d+$/.test(sizeText)?Number(sizeText):0;
        if(Number.isSafeInteger(bytes) && bytes>=1024 && (!manual || await isFinalTrace(hdc,file,bytes))){
            // Allow a slow link 256 KiB/s plus startup time, with a bounded host operation.
            const timeout=Math.min(3600000,30000+Math.ceil(bytes/262144)*1000);
            await hdc(["file","recv",file,trace],timeout,disconnectSignal);
            if((await fs.stat(trace)).size!==bytes)
                throw new Error("The trace transfer was incomplete. / 采集文件传输不完整。");
            return await decodeTraceFile(trace,pid,offset,{keep:historyLimit,manual,signal:disconnectSignal});
        }
        if(attempt<7)await pause(250*(attempt+1));
    }
    throw new Error("The device has not finalized the trace file. / 设备尚未完成采集文件的写入。");
}
async function captureDevice({device,hdcPath,bundle,mode="manual",seconds,stopSignal,closeSignal,disconnectSignal,onReady,onReading},
    {hdc=transport(device,hdcPath),pause=delay,now=Date.now}={}) {
    if (typeof bundle!=="string" || !bundleName.test(bundle)) throw new Error("Select a running application. / 请选择正在运行的应用。");
    if(mode!=="manual" && (mode!=="timed" || timedSeconds(seconds)===undefined))
        throw new Error("Enter a whole number of seconds. / 请填写有效的整数秒数。");
    seconds=timedSeconds(seconds);
    closeSignal?.throwIfAborted();
    const [meta,processes] = await Promise.all([hdc(["shell","bm","dump","-n",bundle]),hdc(["shell","pidof",bundle])]);
    if (!/"appProvisionType"\s*:\s*"debug"/.test(meta)) throw new Error("Network profiling requires a debug-signed app. / 原生网络采集需要调试签名应用。");
    if (!/^\d+$/.test(processes)) throw new Error("Open the selected app on the phone before recording. / 请先在手机上打开所选应用。");
    const pid=Number(processes);
    const tag="ha-network-"+randomUUID(), remote="/data/local/tmp/"+tag;
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ha-network-"));
    const config=path.join(dir,"request.cfg"), trace=path.join(dir,"network.htrace");
    const remoteConfig=remote+".cfg", remoteTrace=remote+".htrace", launchLog=remote+".log";
    let failure;
    try {
        await fs.writeFile(config,`request_id: 1\nsession_config { buffers { pages: 4096 } }\nplugin_configs { plugin_name: "network-profiler" config_data { pid: ${pid} clock_id: 2 smb_pages: 4096 flush_interval: 1 } }\n`);
        await hdc(["file","send",config,remoteConfig]);
        const before=now(), deviceTime=Number(await hdc(["shell","date","+%s%3N"])), dispatched=now();
        if (!Number.isFinite(deviceTime) || deviceTime<1e12) throw new Error("Device clock unavailable. / 无法读取设备时间。");
        const offset=(before+dispatched)/2-deviceTime;
        closeSignal?.throwIfAborted();
        const options=["-s","-c",remoteConfig,"-o",remoteTrace];
        let start=dispatched,ready=false,commandEnded=false,endedBy=mode==="timed"?"timer":"user";
        const observeOutput=async()=>{
            disconnectSignal?.throwIfAborted();
            const size=await hdc(["shell","stat","-c","%s",remoteTrace],2000).catch(()=>"");
            disconnectSignal?.throwIfAborted();
            // The header can remain buffered on an idle app; existence of this fresh path matters.
            if(commandEnded || !/^\d+$/.test(size)) return false;
            start=now();ready=true;onReady?.(start);return true;
        };
        if(mode==="manual"){
            let launchError;
            try {
                // Some profilers keep the HDC shell streams open in the background process.
                checkProfiler(await hdc(["shell","hiprofiler_cmd","start",...options,"--nonblock",
                    "</dev/null",">"+launchLog,"2>&1"],15000));
            } catch(error) { launchError=error; }
            // A fresh output file is also confirmation when the host missed the launch result.
            let finalized=false;
            try {
                const readyBy=now()+10000;
                for(let i=0;i<24 && now()<readyBy;i++){
                    if(await observeOutput()) break;
                    await pause(250);
                }
                if(!ready) throw await manualStartError(hdc,launchLog,launchError);
                while(!stopSignal?.aborted){
                    try {await pause(3000,undefined,{signal:stopSignal});}
                    catch(e){if(!stopSignal?.aborted)throw e;}
                    if(stopSignal?.aborted)break;
                    disconnectSignal?.throwIfAborted();
                    if(await manualTraceFinished(hdc,remoteTrace,true).catch(()=>false) && await ownedManualRunning(hdc,remoteConfig)===false){
                        finalized=true;
                        if(!stopSignal?.aborted)endedBy="device";
                        break;
                    }
                }
            } finally {
                if(!disconnectSignal?.aborted){
                    if(!ready) await stopUnconfirmedManual(hdc,remoteConfig).catch(()=>{});
                    else {
                        onReading?.(now());
                        if(!finalized) {
                            const final=await manualTraceFinished(hdc,remoteTrace).catch(()=>undefined);
                            const running=final===true ? await ownedManualRunning(hdc,remoteConfig) : undefined;
                            disconnectSignal?.throwIfAborted();
                            if(final===false || running===true)checkProfiler(await hdc(["shell","hiprofiler_cmd","stop"],15000));
                            else if(running===undefined)await stopUnconfirmedManual(hdc,remoteConfig);
                        }
                    }
                }
            }
        } else {
            const finished=hdc(["shell","hiprofiler_cmd",...options,"-t",String(seconds)],(seconds+18)*1000,closeSignal)
                .then(value=>({value}),error=>({error})).then(outcome=>{commandEnded=true;return outcome;});
            // Short recordings may finish before the first readiness probe. Never show an
            // interactive recording phase after an already completed command.
            let result;
            while(!ready && !commandEnded){
                const poll=now()-dispatched>10000?2000:250;
                result=await Promise.race([finished,pause(poll).then(()=>undefined)]);
                if(result) break;
                await observeOutput();
            }
            result??=await finished;
            if(result.error){
                if(closeSignal?.aborted && !disconnectSignal?.aborted)await interruptTimed(hdc,remoteConfig).catch(()=>{});
                throw result.error;
            }
            checkProfiler(result.value);
            if(!/\bDONE\b/.test(result.value))throw new Error("Network profiler: "+result.value.slice(-600));
            onReading?.(now());
        }
        const end=now();
        const decoded=await readFinalTrace(hdc,remote,trace,pid,offset,pause,mode==="manual",disconnectSignal);
        disconnectSignal?.throwIfAborted();
        let logs=[], logsAvailable=true;
        try { logs=logMetadata(await hdc(["shell","hilog","-t","app","-P",String(pid),"-v","epoch","-z","500"]),pid,start,end,offset); }
        catch { logsAvailable=false; }
        return {...decoded,logs,logsAvailable,start,end,bundle,endedBy:closeSignal?.aborted?"closed":endedBy};
    } catch(error) {
        failure=error;
        throw error;
    } finally {
        try {
            if(!disconnectSignal?.aborted) await hdc(["shell","rm","-f",remoteConfig,remoteTrace,...(mode==="manual" ? [launchLog] : [])]);
        } catch(error) {
            if(!failure) throw error;
        } finally {
            await fs.rm(dir,{recursive:true,force:true}).catch(error=>{if(!failure)throw error;});
        }
    }
}
module.exports={captureDevice,supportsManual,timedSeconds,maxTimedSeconds,focusedApp,isCaptureApp,reverseFixture,logMetadata};
