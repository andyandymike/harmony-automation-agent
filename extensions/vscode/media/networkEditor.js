import { actionButton } from "./ui/controls.js";
import { fieldView, readField } from "./ui/fieldEditor.js";
import { itemMenu } from "./ui/itemActions.js";
import { orderGrip, orderActions } from "./ui/listOrder.js";

const text = value => value===undefined?"":JSON.stringify(value,null,2);
const parse = value => value.trim()===""?undefined:JSON.parse(value);
const e = s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function formStep(step) {
    return {query:text(step.request?.query),requestHeaders:text(step.request?.headers),requestJson:text(step.request?.json),
        status:String(step.response.status),delay:String(step.response.delayMs??""),responseHeaders:text(step.response.headers),body:text(step.response.json)};
}
export function editScenario(scenario) {
    return {name:scenario.name,paused:scenario.paused,order:scenario.rules.map(r=>r.id),studioRules:scenario.rules.filter(r=>!r.steps),
        rules:scenario.rules.filter(r=>r.steps).map(r=>({...r,enabled:r.enabled!==false,steps:r.steps.map(formStep)}))};
}
function formError(message,fieldId,ruleIndex) {
    return Object.assign(new Error(message),{fieldId,ruleIndex});
}
function responseStepValue(step,ruleIndex,stepIndex,w) {
    const id="ne-"+ruleIndex+"-"+stepIndex+"-";
    const status=Number(step.status), delay=Number(step.delay);
    if (!Number.isInteger(status)||status<200||status>599)
        throw formError(w("Enter a status code from 200 to 599.","请输入 200 到 599 的状态码。"),id+"status",ruleIndex);
    if (step.delay!=="" && (!Number.isInteger(delay)||delay<0||delay>60000))
        throw formError(w("Enter a delay of 0–60000 ms.","请输入 0 到 60000 毫秒的延迟。"),id+"delay",ruleIndex);
    function value(key) {
        try {
            const result=parse(readField(step,key,w));
            if(key==="requestJson" && result!==undefined && (!result || typeof result!=="object" || Array.isArray(result)))
                throw new Error(w("Request body fields must form an object.","请求正文字段需要是一个对象。"));
            return result;
        } catch(error) {
            error.fieldId ||= id+key+"-raw";
            error.ruleIndex=ruleIndex;
            throw error;
        }
    }
    const request={query:value("query"),headers:value("requestHeaders"),json:value("requestJson")};
    const response={status,headers:value("responseHeaders"),json:value("body")};
    if (step.delay!=="") response.delayMs=delay;
    return Object.values(request).some(v=>v!==undefined)?{request,response}:{response};
}
export function scenarioValue(form,w=(en)=>en) {
    if (!form.name?.trim()) throw formError(w("Enter a rule group name.","请填写规则组名称。"),"ne-sc-name");
    const fixtures=form.rules.map((r,i)=>{
        if(!/^[a-z]+$/i.test(r.method)) throw formError(w("Choose an HTTP method.","请选择 HTTP 方法。"),"ne-"+i+"-method",i);
        if(!/^\/(?!\/)/.test(r.path) || /[\\#?]/.test(r.path)) throw formError(w("Enter an exact path such as /items.","请输入 /items 形式的路径。"),"ne-"+i+"-path",i);
        const steps=r.steps.map((step,j)=>responseStepValue(step,i,j,w));
        return {id:r.id,enabled:r.enabled,method:r.method,path:r.path,steps};
    });
    const rules=[...(form.studioRules||[]),...fixtures],byId=new Map(rules.map(r=>[r.id,r]));
    const order=form.order||[];
    return {version:1,name:form.name,...(form.paused!==undefined&&{paused:form.paused}),rules:[...order.map(id=>byId.get(id)).filter(Boolean),...rules.filter(r=>!order.includes(r.id))]};
}
function input(target,key,title,value) {
    const attrs=`id="ne-${target}-${key}" data-ne="${key}" data-row="${target}"`;
    return `<label>${title}<input class="vscode-textfield" ${attrs} value="${e(value)}"></label>`;
}
function button(action,title,target) {
    return actionButton(title, {attrs: {"data-net": action, "data-row": target}});
}
export function drawEditor(form,w,selectedRule=0,{locked=false,single=false}={}) {
    return `<div class="net-editor">${single?"":`${input("sc","name",w("Rule group name","规则组名称"),form.name)}
        <div class="sc-rule-picker">${form.rules.length?`<label for="ne-rule">${w("Response sequence","顺序响应")}<select id="ne-rule">${form.rules.map((r,i)=>
            `<option value="${i}" ${i===selectedRule?"selected":""}>${e(r.method)} ${e(r.path)} · ${e(r.id)}</option>`).join("")}</select></label>`:""}
            ${button("addrule",w("Add sequence","添加顺序响应"),"sc")}</div>`}
        ${form.rules.map((r,i)=>i!==selectedRule?"":`<fieldset><legend>${single?w("Responses in order","响应顺序"):e(r.id)}</legend>
            ${single?"":`<div class="ne-row">${input(i,"method",w("Method","方法"),r.method)}${input(i,"path",w("Match path","匹配路径"),r.path)}
            <label><input type="checkbox" data-ne="enabled" data-row="${i}" ${r.enabled?"checked":""}>${w("Enabled","启用")}</label></div>`}
            <div data-order-kind="responses" data-order-key="${i}">${r.steps.map((s,j)=>{const row=i+"-"+j;
                const edit=(key,label,kind,objectOnly=false)=>fieldView(s,key,{id:"ne-"+row+"-"+key,label,kind,objectOnly},w);
                const controls = r.steps.length>1 ? itemMenu(w("Response actions","响应操作"),
                    orderActions(w,j,r.steps.length)+button("rmreply",w("Remove response","移除此响应"),row),locked) : "";
                return `<div class="ne-step" data-item-actions data-order-index="${j}" data-order-label="${e(w("Response","响应")+" · HTTP "+s.status)}"><header class="ne-step-head" data-order-head>
                    ${!locked && r.steps.length>1?orderGrip(w):""}<h3>${w("On hit","第")} ${j+1} ${w("","次命中")}</h3>${controls}</header>
                <div class="ne-row">${input(row,"status",w("Response status","响应状态码"),s.status)}${input(row,"delay",w("Delay (ms)","延迟（毫秒）"),s.delay)}</div>
                ${edit("body",w("Response body","响应正文"),"json")}
                <details id="ne-more-${row}"><summary>${w("Request edits and headers","修改请求与响应头")}</summary>
                ${edit("query",w("Query parameters","查询参数"),"map")}
                ${edit("requestHeaders",w("Request headers","请求头"),"headers")}
                ${edit("requestJson",w("Request body fields","请求正文字段"),"json",true)}
                ${edit("responseHeaders",w("Response headers","响应头"),"headers")}</details></div>`}).join("")}</div>
            ${button("addreply",w("Add next response","增加下一次响应"),i)} ${single?"":button("rmrule",w("Remove sequence","移除顺序响应"),i)}</fieldset>`).join("")}
        </div>`;
}
export function updateEditor(form,el) {
    if(!el.dataset.ne || !form)return false;
    const [i,j]=el.dataset.row.split("-");
    const target=i==="sc"?form:j===undefined?form.rules[Number(i)]:form.rules[Number(i)].steps[Number(j)];
    target[el.dataset.ne]=el.type==="checkbox"?el.checked:el.value;
    return true;
}
export function editorAction(form,el) {
    if(!form)return false;
    const [i,j]=(el.dataset.row||"").split("-").map(Number);
    switch(el.dataset.net){
        case "addreply":form.rules[i].steps.push(formStep({response:{status:200}}));break;
        case "rmreply":form.rules[i].steps.splice(j,1);break;
        case "moveReply":{
            const steps=form.rules[i]?.steps,next=Number(el.dataset.to);
            if (!steps || ![j,next].every(index=>Number.isInteger(index) && index>=0 && index<steps.length) || j===next) return false;
            const [step]=steps.splice(j,1);
            steps.splice(next,0,step);
            break;
        }
        case "rmrule":form.rules.splice(i,1);break;
        case "addrule":{
            let n=form.rules.length+1;
            while([...form.rules,...(form.studioRules||[])].some(r=>r.id==="rule"+n))n++;
            form.rules.push({id:"rule"+n,enabled:true,method:"GET",path:"/items"+n,steps:[formStep({response:{status:200}})]});break;
        }
        default:return false;
    }
    return true;
}
