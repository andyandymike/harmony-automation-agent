import {html} from "./networkInspector.js";
import {button} from "./networkDetail.js";

export function retainedRecords(network) {
    const history = new Set(network.records.map(row => row.id));
    const archived = (network.favorites || []).map(item => item.record).filter(row => !history.has(row.id));
    return archived.concat(network.records);
}

export function sourceReceipts(network, records, currentBatch, w) {
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
