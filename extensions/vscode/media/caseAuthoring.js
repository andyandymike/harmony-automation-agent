import {caseBddView} from "./caseLibrary.js";
import {actionButton,escapeHtml as h} from "./ui/controls.js";

const properties = {visible:["Visibility","可见性"], text:["Text","文字"], enabled:["Enabled","可用状态"],
    checked:["Checked","勾选状态"], selected:["Selected","选中状态"], focused:["Focused","焦点状态"]};
let editor;

function options(values, current) {
    return values.map(([value,label])=>`<option value="${h(value)}" ${value===current ? "selected" : ""}>${h(label)}</option>`).join("");
}

function editForm(review, w, blocked) {
    if (!editor) return "";
    const {area, values} = editor;
    const field = (label,body) => `<label>${h(label)}${body}</label>`;
    const input = (key,value,attrs="") => `<input id="bdd-${key}" data-bdd-field="${key}" value="${h(value)}" ${attrs}>`;
    let fields;
    if (area === "name") {
        fields = field(w("Case name","用例名称"),input("name",values.name,'maxlength="70" required'));
    } else {
        const suggestions = (review.targets[area] || []).map(item=>[item.key,item.label]);
        const controls = [...(editor.existing ? [["keep",w("Keep current locator","保留当前定位器")]] : []),
            ["manual",w("Enter a control ID","输入控件 ID")], ...suggestions];
        const target = field(w("Locator","定位器"),`<select id="bdd-target" data-bdd-field="target">${options(controls,values.target)}</select>`);
        const custom = values.target === "manual" ? field(w("Control ID","控件 ID"),input("controlId",values.controlId,'maxlength="256" required')) : "";
        fields = target + custom;
        if (area !== "step") {
            const property = field(w("Check","检查属性"),
                `<select id="bdd-property" data-bdd-field="property">${options(Object.entries(properties).map(([key,pair])=>[key,w(...pair)]),values.property)}</select>`);
            const booleanValues = values.property === "visible" ?
                [["true",w("Visible","可见")],["false",w("Hidden","不可见")]] : [["true","True"],["false","False"]];
            const value = values.property === "text" ?
                input("expected",values.expected,'maxlength="4096"'+(editor.protectedValue ? ' type="password" autocomplete="off"' : "")) :
                `<select id="bdd-expected" data-bdd-field="expected">${options(booleanValues,values.expected)}</select>`;
            fields += property + field(w("Expected value","预期值"),value);
            if (editor.protectedValue && values.property === "text" && values.target === "keep")
                fields += `<p class="muted">${w("Leave the value empty to keep the current text.","留空可保留现有预期文字。")}</p>`;
        } else if (editor.canReplace) {
            fields += `<label class="case-replace"><input id="bdd-replace" type="checkbox" data-bdd-field="replaceText" ${values.replaceText ? "checked" : ""}>
                ${w("Replace the entered text","替换此步输入的文字")}</label>`;
            if (values.replaceText) fields += field(w("New text","新输入内容"),input("text",values.text,'type="password" autocomplete="off" maxlength="4096"'));
        }
    }
    return `<form class="case-editor${area==="name"?" case-rename":""}" id="bdd-editor" data-bdd-form>
        <fieldset ${blocked ? "disabled" : ""}>${fields}
        <div class="toolbar"><button type="submit" class="button vscode-button primary">${area==="name"&&review.edit&&!review.dirty?w("Save","保存"):w("Apply","应用")}</button>
        ${actionButton(w("Cancel","取消"),{quiet:true,attrs:{"data-bdd":"cancel"}})}</div></fieldset></form>`;
}

export function caseEditorClick(control, model, send, render) {
    const action = control.dataset.bdd;
    if (!action) return false;
    const review = model.caseReview;
    if (!review || model.busy) return true;
    if (action === "cancel") {
        const {area,path,index,existing} = editor || {};
        editor = undefined;
        if (review.edit && !review.dirty) {
            send({type:"caseCancel",id:review.id});
            return true;
        }
        render();
        const row = [...document.querySelectorAll("[data-bdd][data-area]")].find(el=>el.dataset.area===area &&
            (area==="name" || (area==="step" ? el.dataset.path===path :
                Number(el.dataset.index)===index && (el.dataset.bdd==="edit")===existing)));
        row?.focus();
        return true;
    }
    const {area,path} = control.dataset;
    const index = Number(control.dataset.index);
    const check = review.definitions?.[area]?.[index];
    const step = review.definitions?.steps?.[path];
    const existing = action === "edit";
    editor = {id:review.id,revision:review.revision,area,path,index,existing,canReplace:step?.replaceText,
        protectedValue:check?.protectedValue,values:{name:review.name,target:existing ? "keep" : "manual",controlId:"",
            property:check?.property || "visible",expected:check?.expected ?? "true",replaceText:false,text:""}};
    render();
    const field = document.querySelector("#bdd-editor input, #bdd-editor select");
    field?.focus();
    if (area === "name") field?.select();
    if (area !== "name" && !review.targets?.[area]) send({type:"caseTargets",id:review.id,area});
    return true;
}

export function caseEditorInput(field, render) {
    const key = field.dataset.bddField;
    if (!key || !editor) return false;
    const value = field.type === "checkbox" ? field.checked : field.value;
    if (editor.values[key] === value) return true;
    editor.values[key] = value;
    if (key === "property") editor.values.expected = value === "text" ? "" : "true";
    if (["property","target","replaceText"].includes(key)) render();
    return true;
}

export function caseEditorSubmit(event, model, send) {
    if (!event.target.hasAttribute("data-bdd-form")) return;
    event.preventDefault();
    if (editor && !model.busy) {
        const {id,revision,area,path,index,values} = editor;
        send({type:"caseEdit",id,revision,area,path,index,...values,saveName:area==="name"&&model.caseReview.edit&&!model.caseReview.dirty});
    }
}

export function caseReviewView(model,language,runSummary="") {
    const review = model.caseReview;
    if (!review) return "";
    if (editor && (editor.id !== review.id || editor.revision !== review.revision)) editor = undefined;
    const w = (en,zh)=>/^zh/i.test(language)?zh:en;
    const button = (type,label,extra={},primary=false)=>actionButton(label,{primary,disabled:model.busy ||
        (type==="caseSave" && (Boolean(editor) || (review.edit && !review.dirty))) || (type==="caseCancel" && review.pendingSave),
        attrs:{"data-type":type,"data-id":review.id,...extra}});
    const edit = (label,area,{index,path,add}={})=>actionButton(label,{quiet:true,
        disabled:model.busy || review.pendingSave,
        attrs:{"data-bdd":add ? "add" : "edit","data-area":area,"data-index":index,"data-path":path}});
    const sources = {recording:w("Recording","录制"),exploration:w("AI exploration","AI 探索"),workflow:w("Workflow file","流程文件")};
    const outcomes = {
        observed:w("The original run recorded these actions.","原始记录已确认这些操作。"),
        checksPassed:w("The original run passed its recorded checks.","原运行已通过对应的检查。"),
        checkFailed:w("The original run failed a check. This case keeps the original expectation for reproduction.",
            "原运行有检查失败。用例保留原预期，可用于复现。"),
        review:w("The exploration observed this behavior. Its intended result needs confirmation.","这是探索观察到的行为，预期结果需要确认。"),
    };
    const source = [sources[review.source], review.origin?.label!==review.name && review.origin?.label].filter(Boolean).join(" · ");
    const issue = review.issue;
    const status = issue==="gestures" ? w("Coordinate replay · requires the original screen size and orientation. Business assertions are unavailable for gesture recordings.",
        "坐标回放 · 需要原屏幕尺寸和方向，手势录制不包含业务断言。") :
        issue ? w("You can save this as a draft. Add the missing checks to run it with pytest.",
            "可以先保存为草稿，也可以补齐下面的检查后作为 pytest 用例保存。") : "";
    const form = editForm(review,w,model.busy);
    const renderRow = (text,{area,index,path}) => {
        const editable = area === "step" ? review.definitions?.steps[path] : review.definitions?.[area]?.[index];
        if (!editable) return;
        const opened = editor?.area === area && (area === "step" ? editor.path === path : editor.index === index);
        return opened ? form : `<button type="button" class="case-value" data-bdd="edit" data-area="${area}"
            data-index="${index}" data-path="${h(path)}" ${model.busy?"disabled":""}>${h(text)}</button>`;
    };
    const groupEnd = area => {
        if (area === "step" || issue === "gestures") return "";
        const index = review.definitions?.[area]?.length || 0;
        return `<div class="case-add-check">${edit(area === "start" ? w("Add condition","添加条件") : w("Add assertion","添加断言"),area,{index,add:true})}
            ${editor?.area === area && !editor.existing ? form : ""}</div>`;
    };
    const save = review.edit ? w("Save case changes","保存用例修改") : issue==="gestures" ? w("Save replay case…","保存回放用例…") :
        issue ? w("Save case draft…","保存用例草稿…") : w("Save test case…","保存测试用例…");
    return `<section class="plan-sheet case-detail-sheet"><header class="case-detail-head">
        <div class="case-heading">
            ${review.edit ? "" : `<p class="kicker">${h(w("Review test case","核对测试用例"))}</p>`}
            ${editor?.area === "name" ? form : `<h1><button type="button" class="case-value case-title"
                data-bdd="edit" data-area="name">${h(review.name)}</button></h1>`}
        </div>
        <div class="case-header-actions">${button("caseSave",save,{id:"bdd-save"},true)}${button("caseCancel",w("Cancel","取消"))}</div>
        </header>${runSummary}
        ${!review.edit && source ? `<p class="case-review-note">${h(source)}</p>` : ""}
        ${!review.edit && outcomes[review.origin?.outcome] ? `<p class="case-review-note">${h(outcomes[review.origin.outcome])}</p>` : ""}
        ${review.added ? `<p>${h(w("Run the case to verify the newly added conditions.","本次补充的条件将在下次运行时验证。"))}</p>` : ""}
        ${review.timingUnknown ? `<p>${h(w("This older report retained the confirmed gestures only. Their original delays are unavailable.","旧报告仅保留了已确认的手势，无法恢复原先的操作间隔。"))}</p>` : ""}
        ${status && (!review.edit || issue!=="gestures") ? `<p class="case-review-note">${h(status)}</p>` : ""}
        ${caseBddView(review.bdd,language,{renderRow,groupEnd,coordinates:issue==="gestures",
            reorder:!editor && !model.busy && !review.pendingSave})}</section>`;
}
