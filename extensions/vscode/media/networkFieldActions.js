import {html} from "./networkInspector.js";

const redacted = value => typeof value === "string" && value.includes("[redacted]");
const lockedHeaders = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","proxy-connection",
    "te","trailer","transfer-encoding","upgrade","host","content-length","x-workbench-replay"]);
const isObject = value => value !== null && typeof value === "object";
const pathLabel = path => path.reduce((label,key) => typeof key==="number" ? label+"["+key+"]" :
    /^[a-zA-Z_$][\w$]*$/.test(key) ? (label ? label+"." : "")+key : label+"["+JSON.stringify(key)+"]", "");

// Resolve the field from the original retained record. Capture contents are
// never embedded as executable code or serialized into DOM data attributes.
export function fieldSeed(record,{target,ref}) {
    let path;
    try {path=JSON.parse(ref);} catch {return;}
    if (!Array.isArray(path) || !record) return;
    if (target==="requestJson" || target==="responseJson") {
        const part=target==="requestJson" ? record.request : record.response;
        if(part.bodyState!=="json") return;
        let value=part.body;
        for(const key of path) {
            if(!isObject(value) || !Object.hasOwn(value,key) ||
                (Array.isArray(value) ? !Number.isInteger(key) : typeof key!=="string")) return;
            value=value[key];
        }
        if(value===undefined || JSON.stringify(value).includes("[redacted]")) return;
        return {target,path,op:"set",value:structuredClone(value)};
    }
    const [key,occurrence]=path;
    if(typeof key!=="string") return;
    if(target==="query"){
        const value=new URL(record.request.url).searchParams.getAll(key)[occurrence];
        if(typeof value==="string" && !redacted(value)) return {target,key,occurrence,op:"set",value};
    }
    if(target==="requestHeader" || target==="responseHeader"){
        const headers=(target==="requestHeader" ? record.request : record.response).headers;
        if(!headers || !Object.hasOwn(headers,key) || lockedHeaders.has(key.toLowerCase())) return;
        const value=[headers[key]].flat().join(", ");
        if(!redacted(value)) return {target,key,op:"set",value};
    }
}

function fieldAction(record,target,path,label,w,title,disabled=false) {
    if(disabled) return label;
    const hint=w("Create rule for ","为此字段创建规则 · ")+title;
    return `<button type="button" class="net-field-action" data-net="fieldRule" data-id="${html(record.id)}" data-target="${target}"
        data-ref="${html(JSON.stringify(path))}" aria-label="${html(hint)}" title="${html(hint)}">${label}</button>`;
}
function scalar(value,root=false) {
    const kind=typeof value==="string" ? "string" : typeof value==="number" ? "number" : "literal";
    return `<span class="net-json-${kind}">${html(root && typeof value==="string"?value:JSON.stringify(value))}</span>`;
}
export function jsonFields(record,target,w) {
    const body=(target==="requestJson" ? record.request : record.response).body;
    function draw(value,path,depth,labeled) {
        if(!isObject(value)) {
            const token=scalar(value,depth===0);
            return labeled ? token : fieldAction(record,target,path,token,w,pathLabel(path)||"$",redacted(value));
        }
        const array=Array.isArray(value), entries=Object.entries(value), open=array?"[":"{", close=array?"]":"}";
        const opening=labeled ? open : fieldAction(record,target,path,open,w,pathLabel(path)||"$",JSON.stringify(value).includes("[redacted]"));
        if(!entries.length) return opening+close;
        return opening+"\n"+entries.map(([key,item])=>{
            const branch=[...path,array?Number(key):key];
            const name=array ? "" : fieldAction(record,target,branch,`<span class="net-json-key">${html(JSON.stringify(key))}</span>`,
                w,pathLabel(branch),JSON.stringify(item).includes("[redacted]"))+": ";
            return "  ".repeat(depth+1)+name+draw(item,branch,depth+1,!array);
        }).join(",\n")+"\n"+"  ".repeat(depth)+close;
    }
    return draw(body,[],0,false);
}

export function headerFields(record,target,w) {
    const part=target==="requestHeader" ? record.request : record.response;
    return Object.entries(part.headers||{}).flatMap(([name,value])=>{
        const locked=lockedHeaders.has(name.toLowerCase()) || [value].flat().some(redacted);
        const label=fieldAction(record,target,[name],html(name),w,name,locked);
        return [value].flat().map(item=>label+": "+html(item));
    }).join("\n");
}
export function queryFields(record,w) {
    const query=new URL(record.request.url).searchParams, seen=new Map(), lines=[];
    for(const [key,value] of query) {
        const occurrence=seen.get(key)||0;
        seen.set(key,occurrence+1);
        lines.push(fieldAction(record,"query",[key,occurrence],html(key),w,key+" = "+value,redacted(value))+" = "+html(value));
    }
    if(!lines.length) return "";
    return `<section class="net-detail-field"><h3>${w("Query parameters","查询参数")}</h3>
        <pre class="net-field-value">${lines.join("\n")}</pre></section>`;
}

// A page at a time keeps very large captured arrays keyboard navigable without
// making every element in a 96 KiB response a permanent button.
const pageSize=24;
export function fieldBrowser(record,target,cursor,w) {
    const body=(target==="requestJson" ? record.request : record.response).body;
    const active=cursor?.id===record.id && cursor.target===target;
    const path=active ? cursor.path : [], page=active ? cursor.page : 0;
    let data=body;
    for(const key of path) data=data[key];
    const control=(action,next,pageNumber,text)=>`<button type="button" class="button secondary vscode-button"
        data-net="${action}" data-id="${html(record.id)}" data-target="${target}" data-ref="${html(JSON.stringify(next))}"
        data-index="${pageNumber}">${html(text)}</button>`;
    if(!active) return control("browseFields",[],0,w("Choose a field for a rule","选取字段建规则"));
    const entries=isObject(data)?Object.entries(data):[], start=page*pageSize;
    return `<div class="net-field-browser"><div class="net-field-browse-nav">
        ${path.length?control("browseFields",path.slice(0,-1),0,w("← Parent","← 上一级")):""}
        <code>${html(pathLabel(path)||"$")}</code>${control("closeFields",[],0,w("Close","收起"))}</div>
        ${entries.slice(start,start+pageSize).map(([key,value])=>{
            const branch=[...path,Array.isArray(data)?Number(key):key], valueText=isObject(value) ?
                Array.isArray(value)?"["+value.length+"]":"{…}":JSON.stringify(value);
            return `<div class="net-field-browse-row">${fieldAction(record,target,branch,html(key),w,pathLabel(branch),JSON.stringify(value).includes("[redacted]"))}
                <code>${html(valueText.slice(0,160))}</code>${isObject(value)?control("browseFields",branch,0,w("Open","展开")):""}</div>`;
        }).join("")}
        ${!entries.length?fieldAction(record,target,path,html(JSON.stringify(data)),w,pathLabel(path)||"$",JSON.stringify(data).includes("[redacted]")):""}
        <div class="net-field-browse-nav">${page ? control("browseFields",path,page-1,w("Previous fields","上页")):""}
        ${start+pageSize<entries.length ? control("browseFields",path,page+1,w("Next fields","下页")):""}</div></div>`;
}
