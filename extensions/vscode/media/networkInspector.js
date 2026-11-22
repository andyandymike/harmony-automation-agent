export const fieldNames = {
    url: ["URL", "URL"],
    requestHeaders: ["Request headers", "请求头"],
    requestBody: ["Request body", "请求正文"],
    responseHeaders: ["Response headers", "响应头"],
    responseBody: ["Response body", "响应正文"],
};

export const html = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
})[ch]);

export function requestHost(record) {
    return new URL(record.request.url).host;
}

export function matchesStatus(status, expression) {
    if (!expression) return true;
    return /^\dxx$/i.test(expression) ? Math.floor(status / 100) === Number(expression[0]) :
        /^\d{1,3}$/.test(expression) && status === Number(expression);
}

// The unqualified filter searches the URL. A status filter must match the HTTP status itself.
export function filterRecords(records, filters, favorites) {
    const terms = filters.query.trim().split(/\s+/).filter(Boolean);
    return records.filter(record => {
        if ((filters.method && filters.method !== record.method) ||
            (filters.source && filters.source !== record.source) || !matchesStatus(record.status, filters.status)) return false;
        return terms.every(term => {
            const match = /^(status|method|host|path|source|rule):(.+)$/i.exec(term);
            if (!match) return record.request.url.toLowerCase().includes(term.toLowerCase()) ||
                Boolean(favorites?.get(record.id)?.name.toLowerCase().includes(term.toLowerCase()));
            const field = match[1].toLowerCase(), value = match[2].toLowerCase();
            if (field === "status") return matchesStatus(record.status, value);
            if (field === "method" || field === "source") return record[field].toLowerCase() === value;
            if (field === "rule") return record.ruleId?.toLowerCase() === value;
            if (field === "host") return requestHost(record).toLowerCase() === value;
            return record.path.toLowerCase().includes(value);
        });
    });
}

export function fieldText(record, field) {
    if (field === "url") return record.request.url;
    const part = field.startsWith("response") ? record.response : record.request;
    if (field.endsWith("Headers")) {
        return Object.entries(part.headers || {}).flatMap(([name, value]) =>
            [value].flat().map(item => name + ": " + item)).join("\n");
    }
    if (part.body === undefined) return "";
    return typeof part.body === "string" ? part.body : JSON.stringify(part.body, null, 2);
}

export function searchFields(records, search) {
    const hits = [];
    if (!search.term) return {hits};
    let pattern;
    try {
        const expression = search.regex ? search.term : search.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        pattern = new RegExp(expression, "giu");
    } catch (error) {
        return {hits, error:error.message};
    }
    const fields = search.scope === "all" ? Object.keys(fieldNames) : [search.scope];
    for (const record of records) {
        for (const field of fields) {
            const value = fieldText(record, field);
            if (!value) continue;
            for (const match of value.matchAll(pattern)) {
                if (hits.length === 500) return {hits, truncated:true};
                hits.push({id:record.id, field, start:match.index, end:match.index + match[0].length});
            }
        }
    }
    return {hits};
}

export function highlight(value, hit) {
    if (!hit) return html(value);
    return html(value.slice(0, hit.start)) + '<mark id="net-current-match">' +
        (html(value.slice(hit.start, hit.end)) || "▏") + "</mark>" + html(value.slice(hit.end));
}

function isObject(value) {
    return value !== null && typeof value === "object";
}

// Report changed fields with stable names; JSON key order alone never produces a difference.
export function changedFields(before, after, path = "") {
    if (Object.is(before, after)) return [];
    if (isObject(before) && isObject(after) && Array.isArray(before) === Array.isArray(after)) {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        return Array.from(keys).flatMap(key => changedFields(
            Object.hasOwn(before,key) ? before[key] : undefined, Object.hasOwn(after,key) ? after[key] : undefined,
            Array.isArray(before) ? path + "[" + key + "]" : path ? path + "." + key : key));
    }
    return [{path, before, after}];
}

function requestPart(request) {
    return {method:request.method, url:request.url, headers:request.headers, bodyState:request.bodyState, body:request.body};
}
function responsePart(response) {
    return {status:response.status, headers:response.headers, bodyState:response.bodyState, body:response.body};
}

export function ruleDifferences(record) {
    const changes = [];
    if (record.effectiveRequest) changes.push(...changedFields(requestPart(record.request), requestPart(record.effectiveRequest), "request"));
    if (record.originalResponse) changes.push(...changedFields(responsePart(record.originalResponse), responsePart(record.response), "response"));
    return changes;
}

export function isTransportChange(change) {
    return /^(?:request|response)\.headers\.(?:host|connection|keep-alive|proxy-connection|transfer-encoding|te|trailer|upgrade|accept-encoding|content-length|date)(?:\[\d+\])?$/i.test(change.path);
}

export function exchangeDifferences(before, after) {
    return [...changedFields(requestPart(before.request), requestPart(after.request), "request"),
        ...changedFields(responsePart(before.response), responsePart(after.response), "response"),
        ...changedFields(before.durationMs, after.durationMs, "durationMs")];
}
