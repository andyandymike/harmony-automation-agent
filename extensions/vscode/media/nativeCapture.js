import {html} from "./networkInspector.js";
import {button} from "./networkDetail.js";

let timer;
function timeLabel(started,seconds,mode,w) {
    const elapsed=Math.max(0,Math.floor((Date.now()-started)/1000));
    return mode==="timed" ? Math.max(0,seconds-elapsed)+w(" s remaining"," 秒后结束") : elapsed+w(" s elapsed"," 秒");
}
function updateClock() {
    clearInterval(timer);
    if(typeof document==="undefined")return;
    timer=setInterval(()=>{
        const el=document.getElementById("network-native-clock");
        if(!el){clearInterval(timer);timer=undefined;return;}
        el.textContent=timeLabel(Number(el.dataset.started),Number(el.dataset.seconds),el.dataset.mode,
            (en,zh)=>el.dataset.lang==="zh"?zh:en);
    },1000);
}
export function nativeCaptureStatus(n,w,model) {
    const c=n.capture;
    const connected=model.devices.includes(model.device);
    const active=Boolean(n.capturing),sameDevice=c?.device===model.device;
    const timed=c?.mode==="timed" && sameDevice,recording=c?.status==="recording";
    const canStop=active && recording && c.mode==="manual";
    const labels={starting:w("Preparing capture…","准备采集…"),reading:w("Reading requests…","正在读取请求…"),
        recording:w("Capturing","采集中"),timedOnly:w("Could not confirm manual capture support","未能确认设备支持手动启停"),
        empty:w("No HTTP requests captured","本次没有采集到 HTTP 请求"),error:w("Native capture failed","原生采集失败"),
        finished:c?.count===0?w("No HTTP requests captured","本次没有采集到 HTTP 请求"):w("Capture complete","采集完成")};
    const retained=c?.batch && (n.records?.some(row=>row.batch?.id===c.batch.id) ||
        n.favorites?.some(f=>f.record.batch?.id===c.batch.id));
    const clock=recording && Number.isFinite(c.startedAt) ? `<span id="network-native-clock" data-started="${c.startedAt}" data-mode="${timed?"timed":"manual"}"
        data-seconds="${Number(c.seconds)||0}" data-lang="${w("en","zh")}">${timeLabel(c.startedAt,c.seconds,c.mode,w)}</span>` : "";
    if(clock && typeof document!=="undefined" && !timer)updateClock();
    else if(!clock){clearInterval(timer);timer=undefined;}
    const target=active && c?.bundle ? c.bundle : w("Current app","当前 App");
    const note=c?.status==="error"?html(c.error):c?.status==="empty"?
        w("Operate the app during capture to generate a Network Kit request.","请在采集期间操作应用，触发 Network Kit 请求。"):
        c?.status==="timedOnly"?w("Set a duration in More capture options.","请在「更多采集选项」设置时长。"):
        c?.status==="finished"&&c.count>0?html(c.count)+" HTTP":"";
    const detail=c && !active ? `<div class="net-native-result"><span id="network-native-phase" tabindex="-1" role="status">
        <strong>${labels[c.status]||html(c.status)}</strong>
        ${[c.bundle,!sameDevice && c.device].filter(Boolean).map(html).join(" · ")} ${note}
        ${c.unreadable ? html(c.unreadable)+" "+w("unsupported events","条未识别事件"):""}</span>
        ${retained?button("captureResults",w("View this capture","查看本次请求"),{id:c.batch.id}):""}</div>` : "";
    const mainAction=!active || canStop ? button(canStop ? "nativeStop" : "native",
        canStop ? w("End capture","结束采集") : w("Start capture","开始采集"),{
            primary:true,id:canStop ? c.id : undefined,disabled:!canStop && (!connected || model.busy),
            focusId:"network-native-button",
        }) : "";
    const options=!active && connected ? `<details id="network-native-options" class="net-native-options">
        <summary>${w("More capture options","更多采集选项")}</summary><div class="net-native-options-menu">
            ${button("nativeChoose",w("Capture another app…","采集其他 App…"),{quiet:true,disabled:model.busy})}
            ${button("nativeTimed",w("Timed capture…","定时采集…"),{quiet:true,disabled:model.busy})}
        </div></details>` : "";
    return `<section id="network-native-status" class="net-native" aria-labelledby="net-native-title">
        <div class="net-native-bar"><div class="net-native-context"><strong id="net-native-title">${w("Native HTTP capture","原生 HTTP 采集")}</strong>
            <span class="net-native-app">${html(connected || active ? target : w("Connect a phone","请连接手机"))}</span>
            ${active ? `<span id="network-native-phase" tabindex="-1" role="status">${labels[c?.status] || labels.starting}</span>` : ""}${clock}
        </div><div class="net-native-actions">${mainAction}${options}</div></div>${detail}</section>`;
}
