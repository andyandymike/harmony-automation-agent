"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises");
const {createHash}=require("node:crypto");
const {captureDevice,supportsManual,timedSeconds,focusedApp}=require("../src/deviceNetwork");
const {startNative,stopNative,closeNative,nativeDevicesChanged}=require("../src/nativeCaptureController");
const {NetworkController}=require("../src/networkController");
const {NetworkSession,historyLimit}=require("../src/network");
const path=require("node:path"),os=require("node:os");
const loadWebview=require("../test-support/loadWebview");

const bundle="org.example.debug";
const current=async()=>({foreground:bundle,candidates:[bundle,"org.example.background"]});
function trace(){
    const data=Buffer.alloc(1024);data.write("OHOSPROF");data.writeBigUInt64LE(1024n,8);createHash("sha256").digest().copy(data,24);return data;
}
function deviceStub({visible=true,final=false,autoEnd=false,flushPending=false,manualStart="OK",startLog="",timed,signature="debug",archive=trace(),remoteSize=archive.length}={}){
    const calls=[];
    let stats=0,ended=false,localConfig,transferTimeout;
    async function hdc(args,timeout,signal) {
        calls.push(args);
        if(args[1]==="bm")return JSON.stringify({appProvisionType:signature});
        if(args[1]==="pidof")return "31";
        if(args[1]==="send"){localConfig=args[2];assert.match(await fs.readFile(localConfig,"utf8"),/pid: 31/);return "";}
        if(args[1]==="date")return String(Date.now());
        if(args[1]==="hiprofiler_cmd"){
            if(args[2]==="start"){
                if(manualStart instanceof Error)throw manualStart;
                return manualStart;
            }
            const result=args[2]==="stop"?"OK":timed?await timed(signal):"DONE";
            ended=true;return result;
        }
        if(args[1]==="stat"){
            stats++;
            if(!visible)return "";
            if(ended && flushPending){flushPending=false;return "0";}
            return final || ended || (autoEnd && stats>1)?String(remoteSize):"0";
        }
        if(args[1]==="od")return [...archive.subarray(8,56)].join(" ");
        if(args[1].startsWith("command -v strings"))return final || ended || (autoEnd && stats>1)?"ended":"active";
        if(args[1]==="recv"){transferTimeout=timeout;await fs.writeFile(args[3],archive);return "";}
        if(args[1].startsWith("if [ -f "))return startLog;
        if(args[1]==="hilog" || args[1]==="rm" || args[1].startsWith("for p in") || args[1].startsWith("set -- "))return "";
        assert.fail("unexpected HDC command "+args[1]);
    }
    return {hdc,calls,get transferTimeout(){return transferTimeout;},cleaned:async()=>{assert.equal(calls.at(-1)[1],"rm");await assert.rejects(fs.stat(localConfig),{code:"ENOENT"});}};
}
test("manual capability checks the command's own messages when current devices still print legacy help",async()=>{
    const legacy="--start -s : start service\n--kill -k : stop service";
    const start="hiprofiler_cmd start command shouldn't use time parameter";
    const stop="Use 'hiprofiler_cmd stop' to stop profiling";
    const probe=(api,help,usage="")=>supportsManual("device","",async args=>{
        if(args[1]==="param")return api;
        if(args[1]==="hiprofiler_cmd")return help;
        assert.match(args[1],/strings.*command -v hiprofiler_cmd/);
        return usage;
    });
    assert.equal(await probe("24","  start : start profiling\n  stop : stop profiling"),true);
    assert.equal(await probe("23","hiprofiler_cmd start\nhiprofiler_cmd stop"),false);
    assert.equal(await probe("26",legacy),false);
    assert.equal(await probe("26",legacy,stop),false);
    assert.equal(await probe("26",legacy,start+"\n"+stop),true);
    assert.equal(await probe("23",legacy,start+"\n"+stop),false);
    assert.equal(await probe("unknown","hiprofiler_cmd start\nhiprofiler_cmd stop"),false);
});
test("the focused window identifies its app even if another app is first in the window list",async()=>{
    const windows="WindowName DisplayId Pid WinId Type Mode Flag ZOrd\n" +
        "Visible in background 0 19 5 1 1 1 0\nCurrent App 0 31 7 1 1 1 1\nFocus window: 7\n";
    const calls=[];
    const app=await focusedApp("D","",async args=>{
        calls.push(args);
        return args[1]==="hidumper" ? windows : bundle+":ui\0";
    });
    assert.deepEqual(app,{windowId:"7",bundle});
    assert.deepEqual(calls[1],["shell","cat","/proc/31/cmdline"]);
    const system=await focusedApp("D","",async args=>{
        assert.equal(args[1],"hidumper");
        return windows.replace("Current App","ScreenLockWindow");
    });
    assert.deepEqual(system,{windowId:"7",system:true});
});
test("owned manual trace publishes readiness, stops once and waits for a finalized archive",async()=>{
    const mock=deviceStub({flushPending:true}), stop=new AbortController(), phases=[];
    const result=await captureDevice({device:"D",bundle,mode:"manual",stopSignal:stop.signal,
        onReady(){phases.push("recording");stop.abort();},onReading(){phases.push("reading");}},
        {hdc:mock.hdc,pause:async()=>{}});
    assert.deepEqual(phases,["recording","reading"]);assert.equal(result.records.length,0);assert.equal(result.count,0);
    const launches=mock.calls.filter(c=>c[2]==="start");
    assert.equal(launches.length,1);
    const launchLog=mock.calls.find(c=>c[1]==="send")[3].replace(/\.cfg$/,".log");
    assert.deepEqual(launches[0].slice(-3),["</dev/null",">"+launchLog,"2>&1"]);
    assert.ok(mock.calls.at(-1).includes(launchLog));
    assert.equal(mock.calls.filter(c=>c[2]==="stop").length,1);
    assert.equal(mock.calls.filter(c=>c[1]==="recv").length,1);
    assert.equal(mock.calls.some(c=>c[1]==="hiprofiler_cmd" && (c.includes("-k")||c.includes("-t"))),false);
    await mock.cleaned();
});
test("a manual launch that times out on the host can still be stopped when the phone created its trace",async()=>{
    const mock=deviceStub({manualStart:new Error("HDC timed out after 15s")}), stop=new AbortController();
    await captureDevice({device:"D",bundle,mode:"manual",stopSignal:stop.signal,onReady(){stop.abort();}},
        {hdc:mock.hdc,pause:async()=>{}});
    assert.equal(mock.calls.filter(c=>c[2]==="start").length,1);
    assert.equal(mock.calls.filter(c=>c[2]==="stop").length,1);
    await mock.cleaned();
});
test("unconfirmed manual launch never stops another profiler; closed traces and device auto expiry skip stop",async()=>{
    const missing=deviceStub({visible:false,manualStart:new Error("HDC timed out after 15s"),startLog:"CreateSession failed: another profiler session is active"});
    await assert.rejects(captureDevice({device:"D",bundle,mode:"manual"},{hdc:missing.hdc,pause:async()=>{}}),
        /CreateSession failed: another profiler session is active/);
    const ownConfig=missing.calls.find(c=>c[1]==="send")[3];
    const stop=missing.calls.find(c=>c[1].startsWith("set -- "))[1];
    assert.ok(stop.includes(`grep -Fxq '${ownConfig}'`));
    assert.ok(stop.includes("grep -Fxq 'start'"));
    assert.equal(missing.calls.some(c=>c[2]==="stop"),false);assert.ok(missing.calls.length<40);await missing.cleaned();
    for(const alreadyFinal of [false,true]){
        const mock=deviceStub({final:alreadyFinal,autoEnd:!alreadyFinal}), stop=new AbortController();
        const result=await captureDevice({device:"D",bundle,mode:"manual",stopSignal:stop.signal,onReady(){if(alreadyFinal)stop.abort();}},
            {hdc:mock.hdc,pause:async()=>{}});
        assert.equal(result.endedBy,alreadyFinal?"user":"device");
        assert.equal(mock.calls.some(c=>c[2]==="stop"),false);await mock.cleaned();
    }
});
test("legacy captures accept a validated duration and interrupt only the invocation with this config at shutdown",async()=>{
    for(const val of ["","12.5","1e2","3601","-1"])assert.equal(timedSeconds(val),undefined);
    assert.equal(timedSeconds(" 45 "),45);
    const mock=deviceStub(), seen=[];
    const result=await captureDevice({device:"D",bundle,mode:"timed",seconds:45,onReading:()=>seen.push("reading")},{hdc:mock.hdc,pause:async()=>{}});
    assert.equal(result.endedBy,"timer");
    const command=mock.calls.find(c=>c[1]==="hiprofiler_cmd");
    assert.equal(command[command.indexOf("-t")+1],"45");assert.deepEqual(seen,["reading"]);await mock.cleaned();
    const close=new AbortController(), ended=deviceStub({timed:async signal=>{close.abort();signal.throwIfAborted();}});
    await assert.rejects(captureDevice({device:"D",bundle,mode:"timed",seconds:60,closeSignal:close.signal},{hdc:ended.hdc,pause:async()=>{}}));
    const ownConfig=ended.calls.find(c=>c[1]==="send")[3];
    assert.ok(ended.calls.find(c=>c[1].startsWith("for p in"))[1].includes(ownConfig));
    assert.equal(ended.calls.some(c=>c[2]==="stop"),false);await ended.cleaned();
});

function fakeHost(ui={}){
    const batches=[];
    return {batches,bench:{state:{device:"D",devices:["D"]},config:{get(){}}},vscode:{window:{
        showQuickPick:async()=>assert.fail("A detected app should skip the app picker"),...ui}},
        word:en=>en,logs:[],changed(){},net:{append(records){batches.push(...records.map(r=>r.batch));}}};
}
test("duplicate starts and stale stops do not take ownership of a pending or ongoing collection",async()=>{
    const host=fakeHost(),ready=Promise.withResolvers(),calls=[];
    const services={targets:current,probe:async()=>true,capture:async o=>{
        calls.push(o);o.onReady(400);ready.resolve();
        await new Promise(resolve=>o.stopSignal.addEventListener("abort",resolve,{once:true}));
        o.onReading(500);
        return {records:[{}],count:1,logs:[],logsAvailable:true,unreadable:0,start:400,end:500};}};
    startNative(host,{},services);const done=host.activeCapture;
    startNative(host,{},services);await ready.promise;
    assert.equal(host.captureInfo.status,"recording");stopNative(host,"old-id");
    assert.equal(calls[0].bundle,bundle);
    assert.equal(calls[0].seconds,undefined);
    assert.equal(calls[0].stopSignal.aborted,false);
    const id=host.captureInfo.id;stopNative(host,id);stopNative(host,id);await done;
    assert.equal(calls.length,1);assert.equal(host.captureInfo.status,"finished");
    assert.deepEqual(host.batches,[{id,label:bundle}]);
    assert.deepEqual(host.captureInfo.batch,host.batches[0]);assert.equal(host.activeCapture,undefined);
});
test("legacy timed capture is opt-in and a cancelled duration picker preserves the previous summary",async()=>{
    const prior={status:"finished",count:5,bundle};
    let actual;
    let prompts=0;
    const host=fakeHost({showInputBox:async()=>{prompts++;}});host.captureInfo=prior;
    const services={targets:current,probe:async()=>false,capture:async opts=>{
        actual=opts;opts.onReading(100);return {records:[],count:0,logs:[],end:100,start:20,unreadable:2};}};
    startNative(host,{timed:true},services);await host.activeCapture;assert.equal(host.captureInfo,prior);
    startNative(host,{},services);await host.activeCapture;
    assert.equal(host.captureInfo.status,"timedOnly");assert.equal(prompts,1);assert.equal(actual,undefined);
    host.vscode.window.showQuickPick=async choices=>choices[0];
    startNative(host,{choose:true},services);await host.activeCapture;
    assert.equal(host.captureInfo.status,"timedOnly");assert.equal(prompts,1);assert.equal(actual,undefined);
    host.vscode.window.showInputBox=async()=>"75";
    startNative(host,{timed:true},{...services,probe:async()=>true});await host.activeCapture;
    assert.equal(actual.mode,"timed");assert.equal(actual.seconds,75);assert.equal(host.captureInfo.status,"empty");
    startNative(host,{},{...services,probe:async()=>{throw Error("offline");}});await host.activeCapture;
    assert.equal(host.captureInfo.error,"offline");
    const before=host.captureInfo;startNative(host,{},services);await closeNative(host);
    assert.equal(host.captureInfo,before);assert.equal(host.activeCapture,undefined);
});
test("start capture requires an identified foreground app and reserves the app picker for the explicit alternative",async()=>{
    const host=fakeHost({showQuickPick:async targets=>targets[1]});
    const candidates=[bundle,"org.example.background"];
    let captured;
    const services={targets:async()=>({candidates}),probe:async()=>true,capture:async opts=>{
        captured=opts.bundle;
        return {records:[],count:0,logs:[],start:20,end:100};
    }};
    startNative(host,{},services);await host.activeCapture;
    assert.match(host.captureInfo.error,/Could not identify the current app/);
    assert.equal(captured,undefined);
    startNative(host,{choose:true},services);await host.activeCapture;
    assert.equal(captured,candidates[1]);
});
test("reported disconnect ends the owned capture and never sends stop or cleanup to a reconnected phone",async()=>{
    const mock=deviceStub(),host=fakeHost(),ready=Promise.withResolvers();
    const services={targets:current,probe:async()=>true,capture:opts=>captureDevice({...opts,onReady(start){opts.onReady(start);ready.resolve();}},{hdc:mock.hdc})};
    startNative(host,{},services);const done=host.activeCapture;
    await ready.promise;
    nativeDevicesChanged(host,["other"]);nativeDevicesChanged(host,["D"]);
    assert.match(host.captureInfo.error,/disconnected/);await done;
    assert.equal(host.captureInfo.status,"error");assert.equal(host.batches.length,0);
    assert.equal(mock.calls.some(c=>["stop","recv","rm"].includes(c[1])||c[2]==="stop"),false);
});
test("legacy unfinished recordings reopen as interrupted and finished history stays readable",async t=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"ha-native-history-"));
    t.after(()=>fs.rm(dir,{recursive:true,force:true}));
    await fs.mkdir(path.join(dir,"network"));
    for(const status of ["starting","recording","reading","finished"]){
        const bench={storage:{fsPath:dir},language:"en",state:{mode:"network"},context:{workspaceState:{get:(_key,d)=>d}},publish(){},errorMessage:e=>e.message};
        const c=new NetworkController(bench,{});
        await fs.writeFile(c.file,JSON.stringify({records:[],capture:{bundle,status,count:3}}));
        await c.init();
        assert.equal(bench.state.network.capture.status,status==="finished"?"finished":"error");
        assert.equal(bench.state.network.capture.bundle,bundle);await c.close();
    }
});
test("the same capture button starts the current app and ends an active run",async()=>{
    const {nativeCaptureStatus:view}=await loadWebview("nativeCapture"),w=en=>en,model={device:"D",devices:["D"]};
    const n={capture:{bundle,status:"finished",count:3},records:[]};assert.match(view(n,w,model),/3 HTTP/);
    assert.doesNotMatch(view(n,w,model),/captureResults/);
    n.capture={...n.capture,device:"D",batch:{id:"B"}};n.favorites=[{record:{batch:{id:"B"}}}];
    assert.match(view(n,w,model),/data-net="captureResults" data-id="B"/);
    assert.match(view(n,w,model),/Current app/);
    assert.match(view(n,w,model),/id="network-native-button" data-net="native"[^>]*>Start capture/);
    n.capture={status:"recording",mode:"manual",id:"C",bundle,device:"D",startedAt:Date.now()};n.capturing=true;
    assert.match(view(n,w,model),/id="network-native-button" data-net="nativeStop" data-id="C"[^>]*>End capture/);
    assert.match(view(n,w,model),/org\.example\.debug/);
    assert.doesNotMatch(view(n,w,model),/Start capture/);
    n.capturing=false;n.capture={status:"timedOnly",mode:"timed",device:"D"};
    const oldDevice=view(n,w,model);
    assert.match(oldDevice,/id="network-native-button" data-net="native"[^>]*>Start capture/);
    assert.match(oldDevice,/<details id="network-native-options"[^>]*>\s*<summary>More capture options/);
    assert.match(oldDevice,/class="button" data-net="nativeChoose"[^>]*>Capture another app/);
    assert.match(oldDevice,/class="button" data-net="nativeTimed"[^>]*>Timed capture/);
    assert.match(view(n,w,{device:"other",devices:["D","other"]}),/Start capture/);
    n.capture={status:"finished",device:"D",count:2,endedBy:"device"};
    assert.match(view(n,w,model),/The device ended capture[\s\S]*2 HTTP/);
});
test("a gesture finishing after stop is associated only if it overlapped this phone's capture",()=>{
    const mock={captureInfo:{status:"finished",device:"D",startedAt:20,endedAt:80},bench:{state:{device:"D"}},net:{},markers:[],changed(){}};
    const mark=(start,end)=>NetworkController.prototype.mark.call(mock,"gesture",start,end);
    mark(10,19);mark(70,90);mark(81,90);
    mock.bench.state.device="other";mark(70,90);
    assert.deepEqual(mock.markers.map(m=>[m.start,m.end]),[[70,90]]);
});
function archiveOf(count,damaged=false) {
    const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
    const varint=n=>{const bytes=[];while(n>=128){bytes.push((n%128)+128);n=Math.floor(n/128);}return Buffer.from([...bytes,n]);};
    const msg=fields=>Buffer.concat(fields.flatMap(([n,value])=>Buffer.isBuffer(value)?[varint(n*8+2),varint(value.length),value]:[varint(n*8),varint(value)]));
    const tlv=(type,b)=>Buffer.concat([u32(type),u32(b.length),b]);
    const text=s=>tlv(3,Buffer.from(s));
    function segment(i) {
        const url="https://sample.test/"+i;
        const payload=Buffer.concat([...Array.from({length:7},()=>tlv(1,Buffer.alloc(8))),...["req",url,"GET",""].map(text),
            tlv(2,u32(200)),...["Content-Type: application/json",url,"","HTTP/1.1","OK",'{"token":"sensitive"}'].map(text)]);
        const event=msg([[1,1700000000],[5,31],[9,payload]]);
        const block=msg([[1,Buffer.from("network-profiler")],[3,msg([[1,event]])]]);
        return Buffer.concat([u32(block.length),block]);
    }
    const blocks=Array.from({length:count},(_,i)=>segment(i));
    if(damaged)blocks.push(u32(4096),Buffer.from([0]));
    const archive=Buffer.concat([trace(),...blocks]);archive.writeBigUInt64LE(BigInt(archive.length),8);return archive;
}
test("manual capture waits past a matching trace length and a complete header while its own profiler is still active",async()=>{
    const archive=archiveOf(2),mock=deviceStub({archive}),stop=new AbortController();
    const provisional=Buffer.from(archive.subarray(8,56));
    provisional.fill(0,16);
    let waited=0,inspections=0;
    const hdc=async(args,...rest)=>{
        const value=await mock.hdc(args,...rest);
        if(mock.calls.some(call=>call[2]==="stop"))return value;
        if(args[1]==="stat")return String(archive.length);
        if(args[1]==="od" && inspections++===0)return [...provisional].join(" ");
        return value;
    };
    const result=await captureDevice({device:"D",bundle,stopSignal:stop.signal},{hdc,pause:async ms=>{
        assert.equal(ms,3000);
        waited+=ms;
        if(waited===15000)stop.abort();
    }});
    assert.equal(waited,15000);
    assert.equal(result.endedBy,"user");
    assert.equal(result.count,2);
    assert.equal(mock.calls.filter(c=>c[2]==="stop").length,1);
    const launch=mock.calls.find(c=>c[2]==="start");
    assert.ok(!launch.includes("-t"));
    await mock.cleaned();
});
test("explicitly stopping a manual capture still reads non-empty archives without a digest",async()=>{
    const archive=archiveOf(1),stop=new AbortController();
    archive.fill(0,24,56);
    const mock=deviceStub({archive});
    const result=await captureDevice({device:"D",bundle,stopSignal:stop.signal,onReady(){stop.abort();}},
        {hdc:mock.hdc,pause:async()=>{}});
    assert.equal(result.endedBy,"user");
    assert.equal(result.count,1);
    assert.equal(mock.calls.filter(c=>c[2]==="stop").length,1);
    await mock.cleaned();
});
test("large batches retain the last 500 in order, count all decoded HTTP events and commit once after complete validation",async()=>{
    const host=fakeHost();host.net=new NetworkSession();
    host.net.append([{id:"old-1"},{id:"old-2"}]);
    const services=mock=>({targets:current,probe:async()=>false,capture:opts=>captureDevice(opts,{hdc:mock.hdc,pause:async()=>{}})});
    host.vscode.window.showInputBox=async()=>"45";
    const mock=deviceStub({archive:archiveOf(507),flushPending:true});
    startNative(host,{timed:true},services(mock));await host.activeCapture;
    assert.equal(host.captureInfo.count,507);assert.equal(host.net.records.length,historyLimit);
    assert.equal(host.net.omittedRecords,9);assert.equal(host.net.records[0].path,"/7");
    assert.equal(host.net.records.at(-1).path,"/506");assert.ok(host.net.records.every(r=>r.batch.id===host.captureInfo.id));
    assert.doesNotMatch(JSON.stringify(host.net.records),/sensitive/);
    assert.equal(mock.calls.filter(c=>c[1]==="recv").length,1);
    const before=host.net.records;
    const broken=deviceStub({archive:archiveOf(510,true)});
    startNative(host,{timed:true},services(broken));await host.activeCapture;
    assert.equal(host.captureInfo.status,"error");assert.equal(host.net.records,before);
    assert.equal(host.net.omittedRecords,9);assert.equal(broken.calls.filter(c=>c[1]==="recv").length,1);
});
test("archive transfer budget scales with remote bytes, saturates, and a truncated transfer is not replayed",async()=>{
    for(const [size,expected] of [[128*1024*1024,542000],[4*1024**3,3600000]]){
        const mock=deviceStub({remoteSize:size});
        await assert.rejects(captureDevice({device:"D",bundle,mode:"timed",seconds:600},{hdc:mock.hdc,pause:async()=>{}}),/transfer was incomplete/);
        assert.equal(mock.transferTimeout,expected);assert.equal(mock.calls.filter(c=>c[1]==="recv").length,1);
    }
});
