import {fieldNames, filterRecords, html, requestHost, searchFields} from "./networkInspector.js";
import {button, clock, detailView, duration, option, sourceNames, statusTone} from "./networkDetail.js";
import {retainedRecords, sourceReceipts} from "./networkSources.js";
import {itemMenuTrigger} from "./ui/itemActions.js";

const freshFilters = () => ({query:"", method:"", status:"", source:""});
const freshFind = () => ({open:false, draft:"", term:"", scope:"all", regex:false, cursor:0});
let filters = freshFilters(), find = freshFind(), selected, visibleId;
let refine = false, reading = false, failuresOnly = false, favoritesOnly = false, returnTop = 0;
const detail = {tab:"response", baselineId:""};
let searchCache, currentResults = {hits:[]}, goToHit = false, batch, previousList;
const failed = row => row.status === 0 || (row.status >= 400 && row.status < 600);

export function resetTraffic() {
    batch = previousList = undefined;
    filters = freshFilters();
    find = freshFind();
    selected = undefined;
    visibleId = undefined;
    refine = reading = failuresOnly = favoritesOnly = false;
    detail.fieldCursor = undefined;
    detail.tab = "response";
    detail.baselineId = "";
    searchCache = undefined;
    currentResults = {hits:[]};
    goToHit = false;
    returnTop = 0;
}
export function openExchange(id, savedOnly=false, baselineId) {
    resetTraffic();
    favoritesOnly=savedOnly;
    selected = id;
    reading = true;
    if(baselineId){detail.tab="compare";detail.baselineId=baselineId;}
}
export function inspectBatch(network,id) {
    const row=retainedRecords(network).find(item=>item.batch?.id===id);
    if(!row || batch?.id===id)return;
    const previous=previousList || {entryBatchId:id,filters,find,selected,visibleId,refine,reading,failuresOnly,favoritesOnly,returnTop,detail:{...detail}};
    resetTraffic();
    previousList=previous;
    batch=row.batch;
}
function leaveBatch() {
    const previous=previousList;
    resetTraffic();
    if(!previous)return;
    ({filters,find,selected,visibleId,refine,reading,failuresOnly,favoritesOnly,returnTop}=previous);
    Object.assign(detail,previous.detail);
}
export function returnToExchange(network,id) {
    const history = network.records.find(record => record.id === id);
    const favorites = new Map((network.favorites || []).map(item => [item.record.id,item]));
    const row = history || favorites.get(id)?.record;
    if (!row || (batch ? row.batch?.id!==batch.id : !inStep(row,network))) return false;
    if ((favoritesOnly && !favorites.has(id)) || (!favoritesOnly && !history) ||
        !filterRecords([row],filters,favorites).length || (failuresOnly && !failed(row))) {
        openExchange(id,!history);
        return true;
    }
    selected = visibleId = id;
    reading = true;
    return true;
}
function inStep(record,network) {
    if (!network.stepLabel) return true;
    const start = Date.parse(record.startedAt);
    return network.range && start <= network.range.end && start + (record.durationMs || 0) >= network.range.start;
}
function scopeRows(network,retained) {
    if(batch)return retained.filter(record=>record.batch?.id===batch.id).reverse();
    const pool=favoritesOnly ? (network.favorites || []).map(item=>item.record) : network.stepLabel ? retained : network.records;
    return pool.filter(record => inStep(record,network)).reverse();
}
function search(rows) {
    if (!find.open || !find.term) return {hits:[]};
    const key = JSON.stringify([find.term,find.regex,find.scope,rows.map(row => row.id)]);
    if (searchCache?.key !== key) searchCache = {key, result:searchFields(rows,find)};
    return searchCache.result;
}
function openHit(hit) {
    if (hit) {
        selected = hit.id;
        reading = true;
        detail.tab = hit.field.startsWith("response") ? "response" : "request";
    }
}
function picker(id, label, items, current) {
    return `<label class="net-picker"><span>${html(label)}</span><select id="${id}">${items.map(([value,caption]) =>
        option(value,caption,current)).join("")}</select></label>`;
}
function filtersBar(records, failures, w) {
    const allMethods = [...new Set(records.map(record => record.method))].sort();
    const sources = sourceNames(w);
    const statuses = [...new Set(records.map(record => record.status))].sort((a,b) => a-b);
    const active = failuresOnly || Object.values(filters).some(Boolean);
    const count = [filters.method, filters.status, filters.source].filter(Boolean).length;
    return `<div class="net-filters">
        <label class="net-url-filter"><input id="net-filter" class="vscode-textfield" type="search" value="${html(filters.query)}"
        aria-label="${w("Filter requests by URL or field","按 URL 或字段筛选请求")}" placeholder="${w("Filter by URL or status:503","筛选 URL 或 status:503")}" spellcheck="false"></label>
        ${failures ? button("failures",w(failures+" "+(failures===1 ? "failure" : "failures"),failures+" 条异常"),
            {pressed:failuresOnly,className:"net-failures",title:w("No HTTP response, HTTP 4xx or 5xx","未收到 HTTP 响应、4xx 或 5xx")}) : ""}
        ${button("filters",w("Filters","筛选条件")+(count ? " · "+count : ""),{expanded:refine,controls:"net-filter-options"})}
        ${button("toggleFind",w("Find in content","查找内容"),{expanded:find.open,controls:"net-find-tools"})}
        ${active ? button("clearFilters",w("Clear filters","清除筛选"),{className:"net-text-action",quiet:true}) : ""}
        </div><div class="net-filter-options" id="net-filter-options" ${refine?"":"hidden"}>
        ${picker("net-method",w("Method","方法"),[["",w("All methods","全部方法")],...allMethods.map(value=>[value,value])],filters.method)}
        ${picker("net-status",w("Status","状态"),[["",w("All statuses","全部状态")],...["1xx","2xx","3xx","4xx","5xx"].map(value=>[value,value]),
            ...statuses.map(value=>[String(value),String(value)])],filters.status)}
        ${picker("net-source",w("Source","来源"),[["",w("All sources","全部来源")],...Object.entries(sources)],filters.source)}
    </div>`;
}
function findBar(result,w) {
    if (!find.open) return '<div id="net-find-tools" hidden></div>';
    const count = result.hits.length;
    const hit = result.hits[find.cursor];
    let summary = "";
    if (result.error) summary = `<span role="alert">${w("Invalid regular expression","正则表达式无效")} · ${html(result.error)}</span>`;
    else if (find.term) summary = count ? `<span>${find.cursor+1} / ${count}${result.truncated ? "+" : ""} · ${w(...fieldNames[hit.field])}</span>` :
        `<span>${w("No matches in the retained fields.","保留的字段中没有匹配项。")}</span>`;
    return `<section class="net-find" id="net-find-tools" aria-label="${w("Find in retained data","在保留内容中查找")}">
        <div class="net-find-controls"><label class="net-find-input"><span>${w("Find in retained data","查找请求与响应内容")}</span>
        <input id="net-find" class="vscode-textfield" type="search" spellcheck="false" value="${html(find.draft)}" placeholder="${w("Text or pattern","文字或表达式")}"></label>
        ${picker("net-scope",w("Search in","范围"),[["all",w("All fields","全部字段")],...Object.entries(fieldNames).map(([key,label])=>[key,w(...label)])],find.scope)}
        ${button("regex",w("Regex","正则"),{pressed:find.regex,title:w("Use a regular expression","使用正则表达式")})}
        ${button("findGo",w("Find","查找"))}</div>
        ${summary ? `<div class="net-find-nav" aria-live="polite">${summary}${count>0 ?
            button("previousHit","↑",{disabled:count===1,title:w("Previous match","上一个匹配")})+
            button("nextHit","↓",{disabled:count===1,title:w("Next match","下一个匹配")}) : ""}</div>` : ""}
    </section>`;
}
function recordList(rows, record, result, favorites, w, busy) {
    const counts = new Map();
    const sources = sourceNames(w);
    const longest = rows.reduce((max,row) => Math.max(max,row.durationMs || 0),1);
    for (const hit of result.hits) counts.set(hit.id,(counts.get(hit.id) || 0)+1);
    return `<section id="net-record-list" class="net-record-list" role="listbox" aria-label="${w("Captured exchanges","网络请求列表")}">
        <div class="net-columns" aria-hidden="true"><span>${w("Method","方法")}</span><span>${w("Path / host","路径 / 主机")}</span>
            <span>${w("Status","状态")}</span><span>${w("Time","耗时")}</span></div>
        ${rows.map(row => `<div class="net-record-item" role="presentation" data-item-actions="request" data-record-id="${html(row.id)}"><button type="button" class="net-row" role="option" data-net="select" data-id="${html(row.id)}" aria-selected="${row.id === record.id}" tabindex="${row.id === record.id ? 0 : -1}" aria-keyshortcuts="F Shift+F10">
            <span class="net-method">${html(row.method)}</span>
            <span class="net-resource"><strong title="${html(row.request.url)}">${html(favoritesOnly ? favorites.get(row.id)?.name || row.path : row.path)}</strong>
            <small>${favoritesOnly?html(row.path)+" · ":""}${html(requestHost(row))} · ${html(sources[row.source] || row.source)}</small>${counts.has(row.id) ? `<small class="net-has-hit">${counts.get(row.id)} ${w("matches","处匹配")}</small>` : ""}</span>
            <span class="net-status" data-tone="${statusTone(row.status)}" ${row.status === 0 ? `title="${w("No HTTP response","未收到 HTTP 响应")}"` : ""}>${html(row.status)}</span>
            <span class="net-ms">${duration(row.durationMs)}${Number.isFinite(row.durationMs) ? `<meter aria-hidden="true" value="${row.durationMs}" min="0" max="${longest}"></meter>` : ""}</span></button>
            <button type="button" class="net-row-star" id="net-star-${html(row.id)}" tabindex="-1" data-net="${favorites.has(row.id)?"unfavorite":"favorite"}" data-id="${html(row.id)}"
                title="${favorites.has(row.id)?w("Remove favorite (F)","取消收藏 (F)"):w("Save request and response (F)","收藏请求与响应 (F)")}"
                aria-pressed="${favorites.has(row.id)}" aria-label="${html(w("Favorite ","收藏 ")+row.path)}">${favorites.has(row.id)?"★":"☆"}</button>
            ${itemMenuTrigger(w("Request actions","请求操作"),busy,row.id===record.id?undefined:-1)}</div>`).join("")}</section>`;
}
function scopeNotes(n,w,lang) {
    const logs = n.logs.filter(log => !n.stepLabel || (n.range && Date.parse(log.at) >= n.range.start && Date.parse(log.at) <= n.range.end));
    return `${n.stepLabel ? `<div class="net-context">${html(n.stepLabel)} · ${n.range ? w("Requests in this step’s time window","本步骤时段的请求") :
        w("This step has no recorded time window","本步骤缺少时间戳")} ${button("all",w("Show all","查看全部"))} ${n.returnTo ? button("backrun",w("Return to step","返回步骤")) : ""}</div>` :
        n.returnTo ? `<div class="net-context">${html(n.originStep || "")} ${button("backrun",w("Return to step","返回步骤"))}</div>` : ""}
        ${n.markers?.length ? `<details id="net-markers"><summary>${w("Phone actions","手机操作")} · ${n.markers.length}</summary>
        ${n.markers.map(marker => button("marker",clock(marker.start,lang)+" · "+marker.label,{id:marker.id})).join("")}</details>` : ""}
        ${logs.length ? `<details id="net-logs"><summary>HiLog · ${logs.length}</summary>
        <ul>${logs.map(log => `<li>${html(clock(log.at,lang))} · ${html(log.level)} · ${html(log.tag)}</li>`).join("")}</ul></details>` : ""}`;
}
const sourceIcons = {
    arkweb: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20m-16-2h1m2 0h1m3 5-3 3 3 3"/>',
    har: '<path d="M5 3h9l5 5v13H5zM14 3v6h5m-7 3v6m-3-3 3 3 3-3"/>',
};
function captureSources(model,n,w,empty) {
    const web = {id:"arkweb",label:n.arkweb ? w("Disconnect ArkWeb","断开 ArkWeb") : w("Connect ArkWeb","连接 ArkWeb"),
        help:n.arkweb || w("Connect to a forwarded ArkWeb debug port.","通过已转发到本机的调试端口读取网页请求。")};
    const har = {id:"har",label:w("Import HAR…","导入 HAR…"),help:w("Inspect a saved capture from disk.","打开本地抓包文件，离线查看请求。")};
    const actions = [har,web];
    if (!empty) return `<div class="net-source-actions">${actions.map(action => button(action.id,action.label,
        {disabled:model.busy || action.disabled})).join("")}</div>`;
    return `<section class="net-intake"><h2>${n.arkweb ? w("Waiting for ArkWeb requests","等待 ArkWeb 请求") : w("Other request sources","其他请求来源")}</h2>
        <div class="net-source-list">${actions.map(action => `<button type="button" data-net="${action.id}" class="net-source-option" ${model.busy || action.disabled ? "disabled" : ""}>
            <svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${sourceIcons[action.id]}</svg>
            <span><strong>${html(action.label)}</strong><small>${html(action.help)}</small></span><span class="net-source-arrow" aria-hidden="true">→</span>
            </button>`).join("")}</div></section>`;
}
export function trafficView(model,n,w,lang,renderEditor) {
    const favorites=new Map((n.favorites||[]).map(item=>[item.record.id,item]));
    const retained=retainedRecords(n);
    const scope = scopeRows(n,retained), filtered = filterRecords(scope,filters,favorites);
    const failures = filtered.filter(failed);
    if (!failures.length) failuresOnly = false;
    const rows = failuresOnly ? failures : filtered;
    const switchCollection=!batch && (favoritesOnly || favorites.size || n.records.length) ? button("favoritesOnly",
        favoritesOnly?w("All requests","返回全部请求"):w("Favorites","收藏")+" · "+favorites.size,
        {pressed:favoritesOnly,className:"net-favorites-filter"}) : "";
    const undos=[n.deletedCapture && button("undoCapture",w("Undo removal from history","撤销移除历史请求"),{id:n.deletedCapture,quiet:true}),
        n.removedFavorite && !favorites.has(n.removedFavorite) && button("undoFavorite",w("Undo removal from favorites","撤销取消收藏"),{id:n.removedFavorite,quiet:true})].filter(Boolean);
    const context = batch ? `<div class="net-context">${html(batch.label)} · ${w("Requests in this batch","本次请求")}
        ${button("previousList",w("Back to previous list","返回之前的列表"),{id:previousList.entryBatchId})}</div>` : scopeNotes(n,w,lang);
    const notes = sourceReceipts(n,retained,batch,w) + context + (undos.length?`<aside class="net-undo" role="status">${undos.join("")}</aside>`:"");
    if (!scope.length) {
        currentResults = {hits:[]};
        if(batch)return notes+`<p class="net-empty">${w("No requests from this batch remain in history or favorites.","历史和收藏中已没有这批请求。")}</p>`;
        if(favoritesOnly) return notes+`<div class="net-empty"><h3>${w("No favorites here","这里还没有收藏")}</h3>
            <p>${w("Use the star on a request to keep its response.","点请求旁的星标即可保留这次请求和响应。")}</p>${switchCollection}</div>`;
        if (!n.stepLabel) return notes + switchCollection + captureSources(model,n,w,true);
        return notes + `<div class="net-empty"><h3>${n.range ? w("No requests in this step","本步骤时段没有请求") :
            w("No timestamp for this step","此步骤没有可用于关联请求的时间戳")}</h3></div>`;
    }
    const previousHit = currentResults.hits[find.cursor];
    const results = search(rows);
    if (!goToHit && previousHit && results !== currentResults) {
        const index = results.hits.findIndex(hit => hit.id === previousHit.id && hit.field === previousHit.field &&
            hit.start === previousHit.start && hit.end === previousHit.end);
        if (index !== -1) find.cursor = index;
    }
    currentResults = results;
    if (find.cursor >= currentResults.hits.length) find.cursor = 0;
    const hit = currentResults.hits[find.cursor];
    if (goToHit) {openHit(hit);goToHit=false;}
    const record = rows.find(row=>row.id===selected) || rows.find(row=>row.id===visibleId) || rows[0];
    if (record) {
        visibleId = record.id;
        if (!scope.some(row=>row.id===selected)) selected = record.id;
    }
    return `${notes}
        <div class="net-traffic-head"><div class="net-collection-heading"><h2>${favoritesOnly?w("Saved requests","收藏的请求"):w("Traffic","请求列表")} <span class="net-count">${rows.length}${rows.length !== scope.length ? " / "+scope.length : ""}</span></h2>${switchCollection}</div>
        ${captureSources(model,n,w,false)}</div>
        ${filtersBar(scope,failures.length,w)}${findBar(currentResults,w)}
        ${record ? `<div class="net-grid" data-reading="${reading}">${recordList(rows,record,currentResults,favorites,w,model.busy)}${detailView(record,retained,detail,hit?.id===record.id ? hit : undefined,w,lang,
            record.ruleId && record.ruleScenarioId===n.activeScenarioId && n.scenario.rules.some(rule=>rule.id===record.ruleId),
            {favorite:favorites.get(record.id),inHistory:n.records.some(r=>r.id===record.id),ai:model.aiResults?.exchange,busy:model.busy,
                editor:renderEditor?.(record)})}</div>` :
        `<div class="net-empty"><h3>${w("No requests match these filters","没有符合筛选条件的请求")}</h3></div>`}
        ${n.omittedRecords && !favoritesOnly ? `<p class="net-footnote">${html(n.omittedRecords)} ${w("older records outside the retention window","条较早的请求已超出保留上限")}</p>` : ""}`;
}
export function trafficClick(el,render) {
    const action=el.dataset.net;
    if (action==="previousList") leaveBatch();
    else if (action==="select") {
        selected=el.dataset.id;
        returnTop=el.closest("#net-record-list").scrollTop;
        reading=true;
    }
    else if (action==="backToList") reading=false;
    else if (action==="favoritesOnly") {
        favoritesOnly=!favoritesOnly;
        filters=freshFilters();find=freshFind();failuresOnly=reading=false;returnTop=0;
    }
    else if(action==="browseFields") detail.fieldCursor={id:el.dataset.id,target:el.dataset.target,path:JSON.parse(el.dataset.ref),page:Number(el.dataset.index)};
    else if(action==="closeFields") detail.fieldCursor=undefined;
    else if (action==="filters") refine=!refine;
    else if (action==="failures") {failuresOnly=!failuresOnly;reading=false;}
    else if (action==="detail") detail.tab=el.dataset.id;
    else if (action==="clearFilters") {filters=freshFilters();reading=false;failuresOnly=false;}
    else if (action==="toggleFind") {find.open=!find.open;}
    else if (action==="regex") {find.regex=!find.regex;find.term="";}
    else if (action==="findGo") {find.term=find.draft;find.cursor=0;goToHit=true;}
    else if (action==="nextHit" || action==="previousHit") {
        const length=currentResults.hits.length;
        if (length) find.cursor=(find.cursor+(action==="nextHit" ? 1 : -1)+length)%length;
        goToHit=true;
    } else return false;
    render();
    if (action==="previousList" && typeof document!=="undefined") {
        const entry=document.querySelector('[data-net="captureResults"][data-id="'+CSS.escape(el.dataset.id)+'"]');
        (entry || document.getElementById("net-filter") || document.querySelector(".net-view [data-net='requests']"))?.focus();
    }
    if (action==="select") {
        const back = document.querySelector('[data-net="backToList"]');
        if (back?.getClientRects().length) back.focus();
    }
    if (action==="backToList") {
        const list = document.getElementById("net-record-list");
        if (list) list.scrollTop = returnTop;
        document.querySelector('.net-row[tabindex="0"]')?.focus();
    }
    if (action==="clearFilters") document.getElementById("net-filter")?.focus();
    if (action==="toggleFind" && find.open) document.getElementById("net-find")?.focus();
    if (action==="nextHit" || action==="previousHit" || action==="findGo") document.getElementById("net-current-match")?.scrollIntoView({block:"nearest"});
    return true;
}
export function trafficKeydown(event,render) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
    const row = event.target.closest(".net-row");
    if(!row) return false;
    if(event.key.toLowerCase()==="f"){event.preventDefault();row.parentElement.querySelector(".net-row-star")?.click();return true;}
    if (!["ArrowDown","ArrowUp","Home","End"].includes(event.key)) return false;
    const list = row.closest("#net-record-list");
    const rows = [...list.querySelectorAll(".net-row")];
    const index = rows.indexOf(row);
    const next = {ArrowDown:Math.min(rows.length-1,index+1),ArrowUp:Math.max(0,index-1),Home:0,End:rows.length-1}[event.key];
    event.preventDefault();
    selected = rows[next].dataset.id;
    render();
    const active = document.querySelector('.net-row[tabindex="0"]');
    active?.focus({preventScroll:true});
    active?.scrollIntoView({block:"nearest"});
    return true;
}
export function trafficInput(el,render) {
    const name={"net-filter":"query","net-method":"method","net-status":"status","net-source":"source"}[el.id];
    if (name) {filters[name]=el.value;reading=false;}
    else if (el.id==="net-baseline") detail.baselineId=el.value;
    else if (el.id==="net-find") {
        find.draft=el.value;
        if (!find.term) return true;
        find.term="";
    } else if (el.id==="net-scope") {find.scope=el.value;find.cursor=0;goToHit=true;}
    else return false;
    render();
    return true;
}
