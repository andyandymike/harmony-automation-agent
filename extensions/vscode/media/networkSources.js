import {html} from "./networkInspector.js";
import {button,clock} from "./networkDetail.js";

export function retainedRecords(network) {
    const history = new Set(network.records.map(row => row.id));
    const archived = (network.favorites || []).map(item => item.record).filter(row => !history.has(row.id));
    return archived.concat(network.records);
}

function sourceReceipts(network, records, currentBatch, w) {
    const notes = [];
    function add(batch, message, keepStatus=false) {
        if (!batch || (batch.id === currentBatch?.id && !keepStatus)) return;
        const available = records.some(row => row.batch?.id === batch.id);
        const inspect = available && batch.id!==currentBatch?.id ? button("captureResults",w("View these requests","查看这批请求"),{id:batch.id}) : "";
        notes.push(`<div class="net-source-receipt"><span>${html(message)}</span>${inspect}</div>`);
    }
    const imported = network.lastImport;
    if (imported) {
        const label=imported.batch.label, count=imported.count;
        add(imported.batch,count ? w(`Imported ${label} · ${count} requests`,`已导入 ${label} · ${count} 条请求`) :
            w(`${label} contains no requests.`,`${label} 没有请求记录。`));
    }
    const web=network.webStatus;
    if (web) {
        const status={
            connected:w("Observing this page","正在观察此页面"),
            "page-changed":w("The page changed site. Connect again to choose the new page.","网页已跳转到其他站点。请重新连接并选择新页面。"),
            disconnected:w("The debug connection closed. Reconnect to continue.","调试连接已断开。请重新连接后继续。"),
            stopped:w("Observation stopped","已停止观察")
        };
        add(web.batch,`ArkWeb · ${web.batch.label} · ${status[web.reason] || status.disconnected}`,true);
    }
    return notes.length ? `<div class="net-source-receipts" role="status">${notes.join("")}</div>` : "";
}

export function captureActivity(n, records, batch, w, lang) {
    const receipts=sourceReceipts(n,records,batch,w);
    const markers=batch ? [] : n.markers || [];
    const logs=batch ? [] : (n.logs || []).filter(log=>!n.stepLabel ||
        (n.range && Date.parse(log.at)>=n.range.start && Date.parse(log.at)<=n.range.end));
    if (!receipts && !markers.length && !logs.length) return "";
    const web=n.webStatus;
    const connection=web ? web.reason==="connected" ? w("ArkWeb connected","ArkWeb 已连接") :
        ["disconnected","page-changed"].includes(web.reason) ? w("ArkWeb disconnected","ArkWeb 已断开") : "" : "";
    return `<details id="net-activity" class="net-activity"><summary>${w("Capture activity & logs","采集记录与日志")}
        ${connection ? `<span>${html(connection)}</span>` : ""}</summary>${receipts}
        ${markers.length ? `<details id="net-markers"><summary>${w("Phone actions","手机操作")} · ${markers.length}</summary>
            ${markers.map(marker=>button("marker",clock(marker.start,lang)+" · "+marker.label,{id:marker.id})).join("")}</details>` : ""}
        ${logs.length ? `<details id="net-logs"><summary>HiLog · ${logs.length}</summary>
            <ul>${logs.map(log=>`<li>${html(clock(log.at,lang))} · ${html(log.level)} · ${html(log.tag)}</li>`).join("")}</ul></details>` : ""}</details>`;
}
