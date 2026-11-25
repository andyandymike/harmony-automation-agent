import { actionButton } from "./controls.js";

const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const types = {
    string:["Text","文本"], number:["Number","数字"], boolean:["Boolean","布尔值"],
    null:["Null","空值"], object:["Object","对象"], array:["Array","数组"],
};
const stores = new WeakMap();
const visible = new Map();

function tree(value, key = "") {
    const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const children = type === "array" ? value.map(item => tree(item)) :
        type === "object" ? Object.entries(value).map(([name,item]) => tree(item,name)) : [];
    return {key,type,children,value:children.length || type === "object" || type === "array" ? "" : String(value)};
}
const empty = (type,key) => tree(({string:"",number:0,boolean:false,null:null,object:{},array:[]})[type],key);
const isPairs = kind => ["headers","map","query"].includes(kind);
const nodeId = (editor, path, prop) => editor.id+"-"+(path.length ? path.join("-") : "root")+"-"+prop;

function invalid(editor,id,en,zh) {
    const message = editor.label+" · "+editor.w(en,zh);
    if(editor.root && !editor.rawMode && id.startsWith(editor.id+"-")){
        const segments=id.slice(editor.id.length+1).split("-").slice(0,-1);
        let node=editor.root;
        for(const index of segments){
            if(!/^\d+$/.test(index))break;
            node.open=true;
            node.limit=Math.max(node.limit??40,Number(index)+1);
            node=node.children[Number(index)];
        }
    }
    editor.error = {id,message};
    throw Object.assign(new Error(message),{fieldId:id});
}
function valueOf(editor,node,path) {
    if (node.type === "array") return node.children.map((child,i) => valueOf(editor,child,[...path,i]));
    if (node.type === "object") {
        const entries=[], names=new Set();
        for (const [i,child] of node.children.entries()) {
            if (names.has(child.key)) invalid(editor,nodeId(editor,[...path,i],"key"),"Property names must be unique.","此对象中已有同名属性。");
            names.add(child.key);
            entries.push([child.key,valueOf(editor,child,[...path,i])]);
        }
        return Object.fromEntries(entries);
    }
    if (node.type === "number") {
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(node.value) || !Number.isFinite(Number(node.value)))
            invalid(editor,nodeId(editor,path,"value"),"Enter a finite JSON number.","请输入有效的 JSON 数字。");
        return Number(node.value);
    }
    if (node.type === "boolean") return node.value === "true";
    if (node.type === "null") return null;
    return node.value;
}
function populate(editor,text) {
    if (editor.kind === "query") {
        editor.rows = [...new URLSearchParams(text)].map(([key,value])=>({key,value}));
        return;
    }
    const value = text.trim() === "" ? undefined : JSON.parse(text);
    const isObject = value && typeof value === "object" && !Array.isArray(value);
    if (isPairs(editor.kind)) {
        if (value !== undefined && (!isObject || Object.values(value).some(v=>typeof v!=="string")))
            throw new Error(editor.w("Use an object with text values.","请使用值为文本的键值对象。"));
        editor.rows = Object.entries(value || {}).map(([key,value])=>({key,value}));
    } else {
        if (value !== undefined && editor.objectOnly && !isObject)
            throw new Error(editor.w("Use a JSON object.","请填写 JSON 对象。"));
        editor.root = value === undefined ? undefined : tree(value);
    }
}
function editorFor(owner,key,config,w) {
    let fields=stores.get(owner);
    if (!fields) {fields=new Map();stores.set(owner,fields);}
    let editor=fields.get(key);
    const text=owner[key] ?? "";
    if (!editor || editor.source!==text || config.kind!==editor.kind) {
        editor={...config,w,source:text,raw:text,rawMode:false,dirty:false,undo:[]};
        try {populate(editor,text);}
        catch {editor.rawMode=true;}
        fields.set(key,editor);
    }
    Object.assign(editor,config,{w});
    visible.set(editor.id,new WeakRef(editor));
    return editor;
}

function fieldText(editor) {
    if (editor.rawMode) {
        if (editor.kind !== "body" && editor.kind !== "query") {
            try {populate(editor,editor.raw);}
            catch (err) {invalid(editor,editor.id+"-raw","Check the JSON and field types.","请检查 JSON 格式和字段类型。");}
        }
        return editor.raw;
    }
    if (isPairs(editor.kind)) {
        const entries=[],seen=new Set();
        for (const [i,row] of editor.rows.entries()) {
            const key = editor.kind === "headers" ? row.key.trim() : row.key;
            if (!key && !row.value) continue;
            const identity = editor.kind==="headers" ? key.toLowerCase() : key;
            if ((!key && editor.kind!=="query") || (editor.kind !== "query" && seen.has(identity)))
                invalid(editor,nodeId(editor,[i],"key"),"Choose a non-empty, unique name.","请填写非空且唯一的名称。");
            if (editor.kind==="headers" && !/^[!#$%&'*+.^_\u0060|~A-Za-z0-9-]+$/.test(key))
                invalid(editor,nodeId(editor,[i],"key"),"Invalid header name.","HTTP 头名称无效。");
            if (editor.kind==="headers" && /[^\t\x20-\x7e\x80-\xff]/.test(row.value))
                invalid(editor,nodeId(editor,[i],"value"),"Invalid HTTP header value.","HTTP 头值含有不支持的字符。");
            seen.add(identity);entries.push([key,row.value]);
        }
        if (editor.kind === "query") return new URLSearchParams(entries).toString();
        return entries.length ? JSON.stringify(Object.fromEntries(entries),null,2) : "";
    }
    return editor.root ? JSON.stringify(valueOf(editor,editor.root,[]),null,2) : "";
}
export function readField(owner,key,w) {
    const editor=stores.get(owner)?.get(key);
    if (!editor || editor.source!==(owner[key]??"")) return owner[key] ?? "";
    if (w) editor.w=w;
    // Raw mode can hold invalid JSON imported or entered before the latest editing session.
    const text=!editor.dirty && !editor.rawMode ? editor.source : fieldText(editor);
    if(editor.required && !text.trim())invalid(editor,editor.rawMode?editor.id+"-raw":nodeId(editor,[],"create"),
        "Enter the replacement value.","请填写替换值。");
    return text;
}
export function resetField(owner,key) {
    stores.get(owner)?.delete(key);
}

function button(editor,action,label,path=[],title=label,disabled=false,attrs={}) {
    const id=nodeId(editor,path,action);
    return actionButton(label,{quiet:true,disabled,className:"fe-action",attrs:{
        id,"data-net":"field-"+action,"data-fe":editor.id,"data-path":path.join("."),
        title,"aria-label":title,...attrs,
        ...(editor.error?.id===id && {"aria-invalid":true,"aria-describedby":editor.id+"-error"}),
    }});
}
function control(editor,path,prop,value,label,choices) {
    const id=nodeId(editor,path,prop);
    const attrs=' id="'+escape(id)+'" data-fe="'+escape(editor.id)+'" data-prop="'+prop+'" data-path="'+path.join(".")+
        '" aria-label="'+escape(label)+'"'+(editor.error?.id===id?' aria-invalid="true" aria-describedby="'+escape(editor.id)+'-error"':"");
    if (choices) return '<select'+attrs+'>'+choices.map(([key,text])=>'<option value="'+escape(key)+'" '+(value===key?'selected':'')+'>'+escape(text)+'</option>').join("")+'</select>';
    if (prop==="value" && typeof value==="string" && /[\r\n]/.test(value))
        return '<textarea'+attrs+' rows="2" spellcheck="false">'+escape(value)+'</textarea>';
    return '<input type="text" class="vscode-textfield"'+attrs+' value="'+escape(value)+'" placeholder="'+escape(label)+'" spellcheck="false">';
}
function treeNode(editor,node,path,parentType) {
    const {w}=editor, root=path.length===0, container=["object","array"].includes(node.type);
    const desc=root ? editor.label : parentType==="object" ? node.key : "["+path.at(-1)+"]";
    const typeChoices=Object.entries(types).filter(([key])=>!root || !editor.objectOnly || key==="object").map(([k,p])=>[k,w(...p)]);
    const type=control(editor,path,"type",node.type,w("Type","类型")+" "+desc,typeChoices);
    const key=root ? "" : parentType==="object" ? control(editor,path,"key",node.key,w("Property name","属性名")) : '<code>['+path.at(-1)+']</code>';
    const value=container || node.type==="null" ? "" : control(editor,path,"value",node.value,w("Value","值")+" "+desc,
        node.type==="boolean"?[["true","true"],["false","false"]]:undefined);
    const removeLabel=root && editor.required ? w("Clear value","清空新值") : w("Delete","删除");
    const remove=button(editor,"delete",removeLabel,path,removeLabel+" "+desc);
    const add=container ? button(editor,"add",node.type==="array"?w("+ Item","+ 元素"):w("+ Property","+ 属性"),path) : "";
    const open=node.open??root, count=node.children.length, limit=node.limit??40;
    const members=nodeId(editor,path,"children");
    const fold=container&&count ? button(editor,"fold",String(count),path,(open?w("Collapse","收起"):w("Expand","展开"))+" "+desc,false,
        {"aria-expanded":open,"aria-controls":members}) : "";
    const children=container?'<div class="fe-children" id="'+escape(members)+'" '+(open?"":"hidden")+'>'+
        (open?node.children.slice(0,limit).map((child,i)=>treeNode(editor,child,[...path,i],node.type)).join(""):"")+
        (open&&count>limit?button(editor,"more",w("Show more","显示更多")+" ("+(count-limit)+")",path):"")+'</div>':"";
    return '<div class="fe-node"><div class="fe-node-row">'+key+type+value+fold+add+remove+'</div>'+children+'</div>';
}
function pairsView(editor) {
    const {w}=editor;
    const rows=editor.rows.map((row,i)=>'<div class="fe-pair">'+control(editor,[i],"key",row.key,w("Name","名称"))+
        control(editor,[i],"value",row.value,w("Value","值"))+button(editor,"delete",w("Delete","删除"),[i],w("Delete","删除")+" "+(row.key||String(i+1)))+'</div>');
    return '<div class="fe-pairs">'+rows.join("")+'</div>'+button(editor,"add",editor.kind==="headers"?w("+ Header","+ 头部"):w("+ Parameter","+ 参数"));
}
export function fieldView(owner,key,config,w) {
    const ed=editorFor(owner,key,config,w);
    const mode=ed.rawMode ? w("Use fields","按字段编辑") : w("Edit source","编辑原文");
    const switcher=button(ed,"mode",mode);
    const undo=button(ed,"undo",w("Undo","撤销"),[],w("Undo last edit","撤销上次修改"),!ed.undo.length);
    const rawId=ed.id+"-raw";
    const content=ed.rawMode ? '<textarea class="fe-raw" data-fe="'+escape(ed.id)+'" data-prop="raw" id="'+escape(rawId)+'" aria-label="'+escape(ed.label)+
        '" spellcheck="false" rows="4"'+(ed.error?.id===rawId?' aria-invalid="true" aria-describedby="'+escape(ed.id)+'-error"':"")+'>'+escape(ed.raw)+'</textarea>' :
        isPairs(ed.kind) ? pairsView(ed) : ed.root ? treeNode(ed,ed.root,[],"") : button(ed,"create",w("+ Add value","+ 添加值"));
    return '<section class="fe-editor" aria-labelledby="'+escape(ed.id)+'-title"><div class="fe-heading"><span id="'+escape(ed.id)+'-title">'+escape(ed.label)+
        '</span><div>'+switcher+undo+'</div></div>'+content+(ed.error?'<p class="fe-error" id="'+escape(ed.id)+'-error" role="alert">'+escape(ed.error.message)+'</p>':"")+'</section>';
}
function snapshot(ed) {
    const old=ed.undo;
    old.push(structuredClone({root:ed.root,rows:ed.rows,raw:ed.raw,rawMode:ed.rawMode,dirty:ed.dirty}));
    if (old.length>20) old.shift();
}
function resolve(ed,path) {return path.reduce((node,i)=>node.children[i],ed.root);}
function get(el) {return el?.dataset.fe && visible.get(el.dataset.fe)?.deref();}
function pathOf(el) {return (el.dataset.path||"").split(".").filter(Boolean).map(Number);}
function focusId(id) {
    if (typeof document==="undefined") return;
    const el=document.getElementById(id);
    if (!el) return;
    for (let anchor=el.parentElement;anchor;anchor=anchor.parentElement) if(anchor.tagName==="DETAILS") anchor.open=true;
    el.focus();
}
export function fieldClick(el,render) {
    const ed=get(el),action=el.dataset.net?.slice(6);
    if (!ed || !el.dataset.net?.startsWith("field-")) return false;
    const path=pathOf(el),pair=isPairs(ed.kind);
    let focus;
    ed.error=undefined;ed.typing=undefined;
    if (action==="mode") {
        try {
            if (ed.rawMode) populate(ed,ed.raw); else ed.raw=fieldText(ed);
            ed.rawMode=!ed.rawMode;
            focus=ed.rawMode ? ed.id+"-raw" : nodeId(ed,[],"mode");
        } catch (error) {
            if (!ed.error) ed.error={id:ed.id+"-raw",message:ed.label+" · "+ed.w("Check the JSON and field types.","请检查 JSON 格式和字段类型。")};
            focus=ed.error.id;
        }
    } else if(action==="fold"||action==="more"){
        const node=resolve(ed,path);
        if(action==="fold"){node.open=!(node.open??(path.length===0));focus=nodeId(ed,path,"fold");}
        else {
            const shown=node.limit??40;node.limit=shown+40;
            focus=nodeId(ed,[...path,shown],node.type==="object"?"key":"type");
        }
    } else if (action==="undo") {
        const old=ed.undo.pop();if (old) Object.assign(ed,old);
        focus=nodeId(ed,[],"mode");
    } else {
        snapshot(ed);ed.dirty=true;
        if (action==="create") {
            ed.root=empty(ed.scalarDefault?"string":"object","");
            if(!ed.scalarDefault)ed.root.children.push(empty("string",""));
            focus=ed.root.children.length ? nodeId(ed,[0],"key") : nodeId(ed,[],ed.scalarDefault?"value":"type");
        } else if(action==="add" && pair) {
            ed.rows.push({key:"",value:""});focus=nodeId(ed,[ed.rows.length-1],"key");
        } else if(action==="add") {
            const node=resolve(ed,path);node.children.push(empty("string",""));
            node.open=true;node.limit=Math.max(node.children.length,node.limit??40);
            focus=nodeId(ed,[...path,node.children.length-1],node.type==="array"?"value":"key");
        } else if(action==="delete") {
            if (!pair && !path.length) {ed.root=undefined;focus=nodeId(ed,[],"create");}
            else {
                const scope=path.slice(0,-1), parent=pair?undefined:resolve(ed,scope), rows=pair?ed.rows:parent.children;
                const i=path.at(-1);rows.splice(i,1);
                focus=rows.length ? nodeId(ed,[...scope,Math.min(i,rows.length-1)],pair||parent.type==="object"?"key":"type") : nodeId(ed,scope,"add");
            }
        }
    }
    render();focusId(focus);return true;
}
export function fieldInput(el,render) {
    const ed=get(el),prop=el.dataset.prop;
    if (!ed || !prop) return false;
    if (ed.typing!==el.id) {snapshot(ed);ed.typing=el.id;}
    const error=ed.error;
    ed.dirty=true;ed.error=undefined;
    const path=pathOf(el);
    if(prop==="raw")ed.raw=el.value;
    else if(isPairs(ed.kind))ed.rows[path[0]][prop]=el.value;
    else {
        const node=resolve(ed,path);
        if(prop==="type") Object.assign(node,empty(el.value,node.key));
        else node[prop]=el.value;
    }
    if (prop==="type"||error) render();
    else if(typeof document!=="undefined") {const undo=document.getElementById(nodeId(ed,[],"undo"));if(undo)undo.disabled=false;}
    return true;
}
