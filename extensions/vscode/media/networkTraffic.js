import {fieldNames, filterRecords, hasRetainedRule, html, requestHost, searchFields} from "./networkInspector.js";
import {button, comparisonView, detailView, duration, option, sourceNames, statusTone} from "./networkDetail.js";
import {retainedRecords, captureActivity} from "./networkSources.js";
import {itemMenu, itemMenuTrigger} from "./ui/itemActions.js";
import {ListSelection} from "./ui/listSelection.js";

const requestSelection = new ListSelection("requests",{modifiers:true});

const freshFilters = () => ({query:"", method:"", status:"", source:""});
const freshFind = () => ({open:false, draft:"", term:"", scope:"all", regex:false, cursor:0});
let filters = freshFilters(), find = freshFind(), selected, visibleId;
let refine = false, reading = false, failuresOnly = false, favoritesOnly = false, returnTop = 0;
const detail = {tab:"response", comparison:undefined};
let searchCache, currentResults = {hits:[]}, goToHit = false, batch, previousList;
let previousHistory, sort={key:"startedAt",descending:true}, removableIds=[];
const failed = row => row.status === 0 || (row.status >= 400 && row.status < 600);

export function resetTraffic() {
    requestSelection.reset();
    batch = previousList = previousHistory = undefined;
    sort={key:"startedAt",descending:true};
    removableIds=[];
    filters = freshFilters();
    find = freshFind();
    selected = undefined;
    visibleId = undefined;
    refine = reading = failuresOnly = favoritesOnly = false;
    detail.fieldCursor = undefined;
    detail.tab = "response";
    detail.comparison = undefined;
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
    if (baselineId && baselineId!==id) detail.comparison={ids:[baselineId,id],fromSelection:false};
}
export function inspectBatch(network,id) {
    const row=retainedRecords(network).find(item=>item.batch?.id===id);
    if(!row || batch?.id===id)return;
    const previous=previousList || {...listState(),entryBatchId:id,previousHistory};
    resetTraffic();
    previousList=previous;
    batch=row.batch;
}
function leaveBatch() {
    const previous=previousList;
    resetTraffic();
    if(!previous)return;
    restoreList(previous);
    previousHistory=previous.previousHistory;
}
function listState() {
    const list=typeof document!=="undefined" && document.getElementById("net-record-list");
    const scroll=list?.clientHeight ? list.scrollTop : returnTop;
    return {filters,find,sort,selected,visibleId,refine,reading,failuresOnly,favoritesOnly,returnTop:scroll,detail:{...detail}};
}
function restoreList(state) {
    ({filters,find,sort,selected,visibleId,refine,reading,failuresOnly,favoritesOnly,returnTop}=state);
    Object.assign(detail,state.detail);
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
    detail.comparison=undefined;
    reading = true;
    return true;
}
export function showExchangeTab(tab) { detail.tab=tab; }
export function filterByExchangePath(record) {
    filters={...freshFilters(),query:"path:"+record.path};
    failuresOnly=false;
    reading=false;
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
function sortRows(rows) {
    const value=sort.key==="startedAt" ? row=>Date.parse(row.startedAt) : row=>row[sort.key];
    // Keep the archive order for ties and unknown values last in either direction.
    return rows.sort((a,b)=>{
        const left=value(a),right=value(b);
        if (!Number.isFinite(left)) return Number.isFinite(right) ? 1 : 0;
        if (!Number.isFinite(right)) return -1;
        return sort.descending ? right-left : left-right;
    });
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
        detail.comparison=undefined;
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
        ${failures || failuresOnly ? button("failures",w(failures+" "+(failures===1 ? "failure" : "failures"),failures+" 条异常"),
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
        ${button("findGo",w("Find","查找"))}${button("toggleFind",w("Close search","关闭查找"),{quiet:true})}</div>
        ${summary ? `<div class="net-find-nav" aria-live="polite">${summary}${count>0 ?
            button("previousHit","↑",{disabled:count===1,title:w("Previous match","上一个匹配")})+
            button("nextHit","↓",{disabled:count===1,title:w("Next match","下一个匹配")}) : ""}</div>` : ""}
    </section>`;
}
function sortHeader(key,label,w) {
    const current=sort.key===key;
    const direction=sort.descending ? w("descending","降序") : w("ascending","升序");
    const description=current ? label+" · "+direction : w("Sort by "+label,"按"+label+"排序");
    return `<button type="button" class="net-sort" data-net="sort" data-id="${key}" data-current="${current}"
        aria-label="${html(description)}" title="${html(description)}" aria-pressed="${current}">${html(label)}<span class="net-sort-arrow" aria-hidden="true">${current ? sort.descending?"↓":"↑" : ""}</span></button>`;
}
let timeLocale,timeFormatter;
function recordList(rows, record, result, favorites, w, lang) {
    const counts = new Map();
    const sources = sourceNames(w);
    const longest = rows.reduce((max,row) => Math.max(max,row.durationMs || 0),1);
    if (timeLocale!==lang || !timeFormatter) {
        timeLocale=lang;
        timeFormatter=new Intl.DateTimeFormat(lang,{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
    }
    for (const hit of result.hits) counts.set(hit.id,(counts.get(hit.id) || 0)+1);
    return `<section id="net-record-list" class="net-record-list">
        <div class="net-columns"><span class="net-start">${sortHeader("startedAt",w("Start","时间"),w)}</span><span class="net-method-col">${w("Method","方法")}</span><span class="net-path-col">${w("Path / host","路径 / 主机")}</span>
            ${sortHeader("status",w("Status","状态"),w)}${sortHeader("durationMs",w("Duration","耗时"),w)}</div>
        <div role="${requestSelection.active?"group":"listbox"}" aria-label="${w("Captured exchanges","网络请求列表")}">
        ${rows.map(row => {
            const started=Date.parse(row.startedAt);
            return `<div class="net-record-item" role="presentation"${requestSelection.row(row.id)}${requestSelection.active?"":' data-item-actions="request"'} data-record-id="${html(row.id)}">
            ${requestSelection.checkbox(row.id,w("Select ","选择 ")+row.method+" "+row.path)}
            <button type="button" class="net-row" data-selection-hit${requestSelection.active ? "" : ' role="option"'} data-net="select" data-id="${html(row.id)}" ${requestSelection.active ? `aria-current="${row.id===requestSelection.previewId}" tabindex="-1"` : `aria-selected="${row.id===record.id}" tabindex="${row.id===record.id?0:-1}" aria-keyshortcuts="F Shift+F10"`}>
            <span class="net-start">${Number.isFinite(started) ? '<time datetime="'+html(row.startedAt)+'">'+timeFormatter.format(started)+'</time>' : "—"}</span>
            <span class="net-method">${html(row.method)}</span>
            <span class="net-resource"><strong title="${html(row.request.url)}">${html(favoritesOnly ? favorites.get(row.id)?.name || row.path : row.path)}</strong>
            <small>${favoritesOnly?html(row.path)+" · ":""}${html(requestHost(row))} · ${html(sources[row.source] || row.source)}</small>${counts.has(row.id) ? `<small class="net-has-hit">${counts.get(row.id)} ${w("matches","处匹配")}</small>` : ""}</span>
            <span class="net-status" data-tone="${statusTone(row.status)}" ${row.status === 0 ? `title="${w("No HTTP response","未收到 HTTP 响应")}"` : ""}>${html(row.status)}</span>
            <span class="net-ms">${duration(row.durationMs)}${Number.isFinite(row.durationMs) ? `<meter aria-hidden="true" value="${row.durationMs}" min="0" max="${longest}"></meter>` : ""}</span></button>
            ${requestSelection.active ? "" : `<button type="button" class="net-row-star" id="net-star-${html(row.id)}" tabindex="-1" data-net="${favorites.has(row.id)?"unfavorite":"favorite"}" data-id="${html(row.id)}"
                title="${favorites.has(row.id)?w("Remove favorite (F)","取消收藏 (F)"):w("Save request and response (F)","收藏请求与响应 (F)")}"
                aria-pressed="${favorites.has(row.id)}" aria-label="${html(w("Favorite ","收藏 ")+row.path)}">${favorites.has(row.id)?"★":"☆"}</button>
            ${itemMenuTrigger(w("Request actions","请求操作"),false,row.id===record.id?undefined:-1)}`}</div>`;}).join("")}</div></section>`;
}
function scopeNotes(n,w) {
    return `${n.stepLabel ? `<div class="net-context">${html(n.stepLabel)} · ${n.range ? w("Requests in this step’s time window","本步骤时段的请求") :
        w("This step has no recorded time window","本步骤缺少时间戳")} ${button("all",w("Show all","查看全部"))} ${n.returnTo ? button("backrun",w("Return to step","返回步骤")) : ""}</div>` :
        n.returnTo ? `<div class="net-context">${html(n.originStep || "")} ${button("backrun",w("Return to step","返回步骤"))}</div>` : ""}`;
}
const sourceIcons = {
    arkweb: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20m-16-2h1m2 0h1m3 5-3 3 3 3"/>',
    har: '<path d="M5 3h9l5 5v13H5zM14 3v6h5m-7 3v6m-3-3 3 3 3-3"/>',
};
function captureSources(model,n,w,empty) {
    const web = {id:"arkweb",label:n.arkweb ? w("Disconnect ArkWeb","断开 ArkWeb") : w("Connect ArkWeb","连接 ArkWeb"),
        help:n.arkweb || w("Connect to a forwarded ArkWeb debug port.","通过已转发到本机的调试端口读取网页请求。")};
    const har = {id:"har",label:w("Import HAR","导入 HAR"),help:w("Inspect a saved capture from disk.","打开本地抓包文件，离线查看请求。")};
    const actions = [har,web];
    if (!empty) return `<details id="net-add-source" class="net-source-actions"><summary${n.arkweb?' title="'+html(n.arkweb)+'"':""}>${n.arkweb?w("ArkWeb connected","ArkWeb 已连接"):w("Add source","添加来源")}</summary>
        <div class="net-source-menu">${actions.map(action => button(action.id,action.label,{disabled:model.busy})).join("")}</div></details>`;
    return `<section class="net-intake"><h2>${n.arkweb ? w("Waiting for ArkWeb requests","等待 ArkWeb 请求") : w("Other request sources","其他请求来源")}</h2>
        <div class="net-source-list">${actions.map(action => `<button type="button" data-net="${action.id}" class="net-source-option" ${model.busy || action.disabled ? "disabled" : ""}>
            <svg width="20" height="20" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">${sourceIcons[action.id]}</svg>
            <span><strong>${html(action.label)}</strong><small>${html(action.help)}</small></span><span class="net-source-arrow" aria-hidden="true">→</span>
            </button>`).join("")}</div></section>`;
}
function historyMenu(n,w,busy,filtered,rows) {
    const matching=find.open && find.term ? new Set(currentResults.hits.map(hit=>hit.id)) : undefined;
    const retained=new Set(n.records.map(record=>record.id));
    removableIds=rows.filter(row=>retained.has(row.id) && (!matching || matching.has(row.id))).map(row=>row.id);
    if (favoritesOnly || requestSelection.active) return "";
    const scoped=batch || n.stepLabel || filtered || find.open;
    let action;
    if (scoped) {
        if (!removableIds.length || (find.open && !find.term && !filtered && !batch && !n.stepLabel)) return "";
        const count=removableIds.length;
        const label=matching ? w("Remove "+count+" content matches from history","从历史移除内容命中的 "+count+" 条请求") :
            filtered ? w("Remove "+count+" filtered requests from history","从历史移除筛选出的 "+count+" 条请求") :
            batch ? w("Remove "+count+" requests in this capture from history","从历史移除本次采集的 "+count+" 条请求") :
            w("Remove "+count+" requests in this step from history","从历史移除本步骤的 "+count+" 条请求");
        action=button("removeVisible",label,{disabled:busy});
    } else if (retained.size || n.omittedRecords) {
        action=button("clearTraffic",w("Clear all request history ("+retained.size+")","清空全部请求历史（"+retained.size+" 条）"),{disabled:busy});
    }
    return action ? `<span data-item-actions="history">${itemMenu(w("Request history actions","请求历史操作"),action,busy)}</span>` : "";
}
export function trafficView(model,n,w,lang,renderEditor,hasRuleDraft) {
    const favorites=new Map((n.favorites||[]).map(item=>[item.record.id,item]));
    const retained=retainedRecords(n);
    const scope = scopeRows(n,retained), filtered = filterRecords(scope,filters,favorites);
    const failures = filtered.filter(failed);
    const rows = sortRows(failuresOnly ? failures : filtered);
    requestSelection.update(JSON.stringify([filters,failuresOnly,favoritesOnly,batch?.id,n.filterVersion,n.stepLabel]),rows.map(row=>row.id),model.busy);
    if (requestSelection.active) {
        reading=false;
        if (requestSelection.previewId) selected=requestSelection.previewId;
    }
    const picked=requestSelection.values;
    const historyIds=new Set(n.records.map(record=>record.id));
    const batchAction=(id,label,allowed)=>({id,label,disabled:!picked.some(allowed),
        message:ids=>({type:"networkSelectedRequests",action:id,ids:ids.filter(allowed)})});
    const libraryActions=favoritesOnly ?
        [batchAction("unfavorite",w("Remove selected favorites","取消所选收藏"),id=>favorites.has(id))] :
        [batchAction("favorite",w("Favorite selected","收藏所选"),id=>!favorites.has(id)),
            batchAction("remove",w("Remove selected from history","从历史移除所选"),id=>historyIds.has(id))];
    const compare={id:"compare",label:w("Compare requests","对比请求"),disabled:picked.length!==2,
        run:()=>{
            if (requestSelection.selected.size!==2) return;
            // A range can be selected in either direction. Its active end is request B.
            const ids=[...requestSelection.selected];
            if (ids[0]===requestSelection.previewId) ids.reverse();
            detail.comparison={ids,fromSelection:true};
            if (typeof document!=="undefined") queueMicrotask(()=>{
                const heading=document.getElementById("net-comparison-title");
                heading?.focus({preventScroll:true});
                heading?.scrollIntoView({block:"nearest",inline:"nearest"});
            });
        }};
    const selectionTools=requestSelection.tools(w,[compare,...libraryActions],{
        count:w(picked.length===1 ? "1 request selected" : picked.length+" requests selected","已选 "+picked.length+" 条请求"),
        help:picked.length===2 ? undefined : w("Select two requests to compare.","勾选两条请求可对比。"),
    });
    if (detail.comparison?.fromSelection &&
        (!requestSelection.active || picked.length!==2 || !picked.every(id=>detail.comparison.ids.includes(id)))) {
        detail.comparison=undefined;
    } else if (detail.comparison && !detail.comparison.fromSelection && requestSelection.active) detail.comparison=undefined;
    const pair=detail.comparison?.ids.map(id=>retained.find(row=>row.id===id));
    if (pair && !pair.every(Boolean)) detail.comparison=undefined;
    const switchCollection=!batch && (favoritesOnly || favorites.size || n.records.length) ? button("favoritesOnly",
        favoritesOnly?w("All requests","返回全部请求"):w("Favorites","收藏")+" · "+favorites.size,
        {pressed:favoritesOnly,className:"net-favorites-filter"}) : "";
    const historyView = !favoritesOnly;
    const undos=[n.deletedCapture && button("undoCapture",w("Undo removal from history","撤销移除历史请求"),{id:n.deletedCapture,quiet:true}),
        historyView && n.clearedHistory && `<span>${w("Request history cleared","请求列表已清空")}</span>` +
            button("undoClearTraffic",w("Undo clear","撤销清空"),{id:n.clearedHistory,quiet:true,disabled:model.busy}),
        n.removedFavorite && !favorites.has(n.removedFavorite) && button("undoFavorite",w("Undo removal from favorites","撤销取消收藏"),{id:n.removedFavorite,quiet:true})].filter(Boolean);
    const context = batch ? `<div class="net-context">${html(batch.label)} · ${w("Requests in this batch","本次请求")}
        ${button("previousList",w("Back to previous list","返回之前的列表"),{id:previousList.entryBatchId})}</div>` : scopeNotes(n,w);
    const notes = context + (undos.length?`<aside class="net-undo" role="status">${undos.join("")}</aside>`:"");
    const activity=captureActivity(n,retained,batch,w,lang);
    const listFooter=activity ? `<div class="net-list-only">${activity}</div>` : "";
    const filtering=failuresOnly || Object.values(filters).some(Boolean);
    if (!scope.length) {
        currentResults = {hits:[]};
        const clear=historyMenu(n,w,model.busy,filtering,[]);
        if(batch)return notes+`<p class="net-empty">${w("No requests from this batch remain in history or favorites.","历史和收藏中已没有这批请求。")}</p>`+listFooter;
        if(favoritesOnly) return notes+`<div class="net-empty"><h3>${w("No favorites here","这里还没有收藏")}</h3>
            <p>${w("Use the star on a request to keep its response.","点请求旁的星标即可保留这次请求和响应。")}</p>${switchCollection}</div>`+listFooter;
        if (!n.stepLabel) return notes + switchCollection + clear + captureSources(model,n,w,true)+listFooter;
        return notes + clear + `<div class="net-empty"><h3>${n.range ? w("No requests in this step","本步骤时段没有请求") :
            w("No timestamp for this step","此步骤没有可用于关联请求的时间戳")}</h3></div>`+listFooter;
    }
    const previousHit = currentResults.hits[find.cursor];
    const results = search(rows);
    if (!goToHit && previousHit && results !== currentResults) {
        const index = results.hits.findIndex(hit => hit.id === previousHit.id && hit.field === previousHit.field &&
            hit.start === previousHit.start && hit.end === previousHit.end);
        if (index !== -1) find.cursor = index;
    }
    currentResults = results;
    if (find.cursor<0) find.cursor=Math.max(0,currentResults.hits.length-1);
    if (find.cursor >= currentResults.hits.length) find.cursor = 0;
    const hit = currentResults.hits[find.cursor];
    if (goToHit) {openHit(hit);goToHit=false;}
    const record = rows.find(row=>row.id===selected) || rows.find(row=>row.id===visibleId) || rows[0];
    if (record) {
        visibleId = record.id;
        if (!scope.some(row=>row.id===selected)) selected = record.id;
    }
    const clear=historyMenu(n,w,model.busy,filtering,rows);
    return `<div class="net-list-only">${notes}
        <div class="net-traffic-head"><div class="net-collection-heading"><h2>${favoritesOnly?w("Saved requests","收藏的请求"):w("Traffic","请求列表")} <span class="net-count">${rows.length}${rows.length !== scope.length ? " / "+scope.length : ""}</span></h2>${switchCollection}${requestSelection.active?"":selectionTools}${clear}</div>
        ${captureSources(model,n,w,false)}</div>
        ${filtersBar(scope,failures.length,w)}${requestSelection.active?selectionTools:""}</div>${findBar(currentResults,w)}
        ${record ? `<div class="net-grid" data-reading="${reading || Boolean(detail.comparison)}"${requestSelection.active && requestSelection.previewId && !detail.comparison ? " data-picking" : ""}>${recordList(rows,record,currentResults,favorites,w,lang)}${detail.comparison ?
            comparisonView(pair[0],pair[1],w,lang,detail.comparison.fromSelection) : detailView(record,retained,detail,hit?.id===record.id ? hit : undefined,w,lang,
            hasRetainedRule(n,record),
            {favorite:favorites.get(record.id),ai:model.aiResults?.exchange,busy:model.busy,hasRuleDraft:hasRuleDraft?.(record.id),picking:requestSelection.active,
                editor:renderEditor?.(record)})}</div>` :
        `<div class="net-empty"><h3>${w("No requests match these filters","没有符合筛选条件的请求")}</h3></div>`}
        ${n.omittedRecords && !favoritesOnly ? `<p class="net-footnote net-list-only">${html(n.omittedRecords)} ${w("older records outside the retention window","条较早的请求已超出保留上限")}</p>` : ""}${listFooter}`;
}
export function trafficClick(el,render,send) {
    const action=el.dataset.net;
    if (action==="removeVisible") {
        if (removableIds.length) send?.({type:"networkSelectedRequests",action:"remove",ids:removableIds.slice()});
        return true;
    }
    if (action==="previousList") leaveBatch();
    else if (action==="select" && requestSelection.active) {
        el.closest(".net-record-item")?.querySelector("input[data-list-pick]")?.click();
        return true;
    } else if (action==="select") {
        selected=el.dataset.id;
        detail.comparison=undefined;
        returnTop=el.closest("#net-record-list").scrollTop;
        reading=true;
    }
    else if (action==="backToList") reading=false;
    else if (action==="closeComparison") {
        detail.comparison=undefined;
        reading=false;
    }
    else if (action==="favoritesOnly") {
        if (favoritesOnly) {
            const saved=previousHistory;
            resetTraffic();
            if (saved) restoreList(saved);
        } else {
            const saved=listState();
            resetTraffic();
            previousHistory=saved;
            favoritesOnly=true;
        }
    }
    else if (action==="sort" && ["startedAt","durationMs","status"].includes(el.dataset.id)) {
        const key=el.dataset.id;
        sort={key,descending:sort.key!==key || !sort.descending};
    }
    else if(action==="browseFields") detail.fieldCursor={id:el.dataset.id,target:el.dataset.target,path:JSON.parse(el.dataset.ref),page:Number(el.dataset.index)};
    else if(action==="closeFields") detail.fieldCursor=undefined;
    else if (action==="filters") refine=!refine;
    else if (action==="failures") {failuresOnly=!failuresOnly;reading=false;}
    else if (action==="detail" && ["request","response","timing","changes"].includes(el.dataset.id)) detail.tab=el.dataset.id;
    else if (action==="clearFilters") {filters=freshFilters();reading=false;failuresOnly=false;}
    else if (action==="toggleFind") {find.open=!find.open;}
    else if (action==="regex") {find.regex=!find.regex;find.term="";}
    else if (["findGo","previousHit","nextHit"].includes(action)) {
        if (find.term!==find.draft || !find.term) {
            find.term=find.draft;find.cursor=action==="previousHit" ? -1 : 0;
        } else if (currentResults.hits.length) {
            const length=currentResults.hits.length;
            find.cursor=(find.cursor+(action==="previousHit" ? -1 : 1)+length)%length;
        }
        goToHit=true;
    } else return false;
    render();
    if (typeof document==="undefined") return true;
    if (action==="favoritesOnly" || action==="previousList") {
        const list=document.getElementById("net-record-list");
        if (list) list.scrollTop=returnTop;
    }
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
    if (action==="closeComparison") {
        const target=requestSelection.active ? document.querySelector('[data-list-name="requests"][data-list-action="compare"]') :
            document.querySelector('.net-row[tabindex="0"]');
        target?.focus({preventScroll:true});
        target?.scrollIntoView({block:"nearest",inline:"nearest"});
    }
    if (action==="clearFilters") document.getElementById("net-filter")?.focus();
    if (action==="toggleFind") {
        if (find.open) document.getElementById("net-find")?.focus();
        else {
            const toggle=document.querySelector('.net-filters [data-net="toggleFind"]');
            (toggle?.getClientRects().length ? toggle : document.querySelector('[data-net="backToList"]'))?.focus();
        }
    }
    if (action==="nextHit" || action==="previousHit" || action==="findGo") document.getElementById("net-current-match")?.scrollIntoView({block:"nearest"});
    return true;
}
export function trafficKeydown(event,render) {
    if (event.isComposing) return false;
    const target=event.target;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase()==="f" &&
        (target===document.body || target.closest("#tool-navigation,#tool-content")) && document.getElementById("net-filter") &&
        !target.closest('textarea,select,[contenteditable=true],input:not(#net-filter):not(#net-find):not([data-list-pick])')) {
        event.preventDefault();
        if (!find.open) { find.open=true;render(); }
        const input=document.getElementById("net-find");
        input?.focus();input?.select();
        return true;
    }
    if (target.id==="net-find" && !event.ctrlKey && !event.altKey && !event.metaKey && ["Enter","Escape"].includes(event.key)) {
        event.preventDefault();
        return trafficClick({dataset:{net:event.key==="Escape" ? "toggleFind" : event.shiftKey ? "previousHit" : "findGo"}},render);
    }
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
    detail.comparison=undefined;
    requestSelection.anchor=selected;
    render();
    const active = document.querySelector('.net-row[tabindex="0"]');
    active?.focus({preventScroll:true});
    active?.scrollIntoView({block:"nearest"});
    return true;
}
export function trafficInput(el,render) {
    const name={"net-filter":"query","net-method":"method","net-status":"status","net-source":"source"}[el.id];
    if (name) {filters[name]=el.value;reading=false;}
    else if (el.id==="net-find") {
        find.draft=el.value;
        if (!find.term) return true;
        find.term="";
    } else if (el.id==="net-scope") {find.scope=el.value;find.cursor=0;goToHit=true;}
    else return false;
    render();
    return true;
}
