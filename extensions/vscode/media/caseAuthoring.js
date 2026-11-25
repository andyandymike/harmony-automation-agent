import {caseBddView,caseStepLabel,casePendingNotice} from "./caseLibrary.js";
import {compositionStepMenu, caseForkStepMenu, compositionControls} from "./caseComposition.js";
import {stepSelectionFor, stepSelectionControls} from "./caseSelection.js";
import {pytestCheckHint} from "./pytestCase.js";
import {actionButton,escapeHtml as h} from "./ui/controls.js";

const properties = {visible:["Visibility","可见性"], text:["Text","文字"], enabled:["Enabled","可用状态"],
    checked:["Checked","勾选状态"], selected:["Selected","选中状态"], focused:["Focused","焦点状态"]};
let editor;
const stepAreas = ["step","stepName","stepCheck","stepOperation","stepGesture","stepFeedback","stepDetails"];
const feedbackAreas = new Set(["stepFeedback","caseFeedback"]);
const targetActions = new Set(["press","fill","scroll","wait"]);
const operationArea = current=>current?.area==="stepDetails" ? current.operationArea : current?.area;
const usesPicker = current=>["step","stepCheck"].includes(operationArea(current)) ||
    operationArea(current)==="stepOperation" && targetActions.has(current.values.command);
const actions = {press:["Tap","点按"],fill:["Enter text","输入文字"],scroll:["Scroll","滑动"],back:["Go back","返回"],
    wait:["Wait for a condition","等待条件"],open:["Open app","打开应用"],find:["Find text","查找文字"],observe:["Read page","读取页面"]};
const gestures = {click:["Tap","点按"],doubleClick:["Double tap","双击"],longClick:["Long press","长按"],
    swipe:["Swipe","滑动"],drag:["Drag","拖拽"],fling:["Fling","快速滑动"],pinch:["Pinch","缩放"],back:actions.back,
    home:["Home","主页"],recents:["Recent apps","最近任务"],typeText:actions.fill};
const directions = {up:["Up","向上"],down:["Down","向下"],left:["Left","向左"],right:["Right","向右"]};

function requestTargets(current, send, extra = {}) {
    const {id,revision,path,index,existing,values} = current, area = operationArea(current);
    send({type:"caseTargets",id,revision,area,path,index,add:!existing,...(area==="stepOperation" && {command:values.command}),...extra});
}

function currentPicker(review, current) {
    const picker = review.stepTargets;
    const area = operationArea(current);
    const command = area==="stepOperation" ? current.values.command : undefined;
    return picker?.path===current.path && picker.area===area && picker.command===command &&
        picker.insert===(!current.existing && area!=="step") ? picker : undefined;
}

export function endCasePicture(model, send) {
    const review = model.caseReview, picture = review?.stepTargets?.picture;
    if (!picture || model.busy) return false;
    send({type:"caseEndPick",id:review.id,revision:review.revision,picture:picture.id});
    return true;
}

export function selectCasePictureTarget(key, id, model, send, render) {
    const review = model.caseReview;
    if (!review || model.busy || !usesPicker(editor) ||
        editor.id!==review.id || editor.revision!==review.revision) return false;
    const picker = currentPicker(review,editor);
    if (!picker?.picture || picker.picture.id!==id || !picker.choices.some(choice=>choice.key===key && choice.bounds)) return false;
    editor.values.query = "";
    editor.values.target = key;
    editor.operationChanged = true;
    endCasePicture(model,send);
    render();
    document.getElementById("bdd-apply")?.focus();
    return true;
}

function options(values, current) {
    return values.map(([value,label])=>`<option value="${h(value)}" ${value===current ? "selected" : ""}>${h(label)}</option>`).join("");
}

function locatorFields(model, review, w, field, input) {
    const {path, values, existing} = editor, area = operationArea(editor);
    const insert = area!=="step" && !existing;
    const operation = area==="stepOperation";
    const locator = insert || operation && editor.action?.command!==values.command ? undefined : editor.locator;
    const picker = currentPicker(review,editor);
    const normalize = value=>value.normalize("NFKC").toLocaleLowerCase();
    const terms = normalize(values.query.trim()).split(/\s+/);
    const found = (picker?.choices || []).filter(item=>{
        const text = normalize([item.label,item.detail,item.locator].join(" "));
        return terms.every(term=>text.includes(term));
    });
    const shown = found.slice(0,20);
    const pick = picker?.choices.find(item=>item.key===values.target);
    const sourceName = source=>source==="live" ? w("Current page","当前页面") : w("Recorded pages","已记录的页面");
    const results = ["live","recorded"].map(source=>{
        const choices = shown.filter(item=>item.source===source);
        if (!choices.length) return "";
        return `<div class="case-target-group"><strong>${h(sourceName(source))}</strong>${choices.map(item=>
            `<button type="button" class="case-target" id="bdd-pick-${h(item.key)}" data-bdd="pick" data-target="${h(item.key)}"
                aria-pressed="${item.key===values.target}"><span>${h(item.label)}</span>${item.detail ? `<small>${h(item.detail)}</small>` : ""}</button>`).join("")}</div>`;
    }).join("");
    const matches = picker?.matches;
    const matchText = matches && (matches.complete ? w(`Matches ${matches.count} controls on this page`,`当前页面匹配 ${matches.count} 个控件`) :
        w(`${matches.count} matches in the available controls`,`已读取的控件中有 ${matches.count} 个匹配`));
    const choices = [["id",w("Control ID","控件 ID")],["text",w("Visible text","可见文字")],["description",w("Accessibility label","无障碍标签")]];
    const scan = Boolean(model.device && model.devices.includes(model.device));
    return `${locator ? `<div class="case-locator-current"><strong>${w("Current locator","当前定位器")}</strong><code>${h(locator)}</code>
        ${matchText ? `<small>${h(matchText)}</small>` : ""}
        ${area!=="step" && values.target!=="keep" ? actionButton(w("Keep current locator","保留当前定位器"),
            {quiet:true,attrs:{"data-bdd":"keep"}}) : ""}</div>` : ""}
        ${pick ? `<div class="case-locator-current case-locator-chosen"><strong>${h((insert ? w("Selected control","已选控件") : w("Replacement locator","替换为"))+" · "+pick.label)}</strong><code>${h(pick.locator)}</code></div>` : ""}
        ${operation && values.command==="scroll" ? actionButton(w("Use the page’s scroll area","使用页面滚动区域"),
            {quiet:true,attrs:{"data-bdd":"auto","aria-pressed":values.target==="auto"}}) : ""}
        <div class="case-target-head">${picker?.picture ? "" : `<p class="muted">${scan ? w("Open the page containing the target control.","先打开目标控件所在的页面。") :
            w("Connect a phone to read controls from its current page.","连接手机后，就可以读取当前页面的控件。")}</p>`}
        ${actionButton(picker?.picture ? w("Cancel screen selection","取消画面选取") : w("Pick on screen","在画面中选取"),
            {primary:!picker?.picture,attrs:{id:"bdd-pick-screen","data-bdd":"picture","aria-pressed":Boolean(picker?.picture)},disabled:!scan})}
        ${actionButton(picker?.live ? w("Scan again","重新读取") : w("Read current page","读取当前页控件"),
            {attrs:{id:"bdd-scan","data-bdd":"scan"},disabled:!scan})}</div>
        ${picker?.choices.length ? field(w("Search controls","搜索控件"),input("query",values.query,'type="search" autocomplete="off"')) : ""}
        ${results ? `<div class="case-targets" id="bdd-target-results" data-scroll-key="${h(path)}">${results}</div>` :
            picker?.choices.length ? `<p class="muted">${w("No controls match this search.","没有符合搜索条件的控件。")}</p>` :
            picker?.live ? `<p class="muted">${w("No suitable visible controls were found on this page.","当前页没有找到可以执行这一步的可见控件。")}</p>` : ""}
        ${found.length>shown.length ? `<small class="muted">${w(`Showing ${shown.length} of ${found.length}. Refine the search to see other controls.`,
            `显示 ${shown.length} 个，共 ${found.length} 个。可缩小搜索范围。`)}</small>` : ""}
        <details id="bdd-manual" ${values.target==="manual"?"open":""}><summary>${w("Enter a locator manually","手动输入定位条件")}</summary>
        ${field(w("Match by","匹配方式"),`<select id="bdd-locator-field" data-bdd-field="locatorField">${options(choices,values.locatorField)}</select>`)}
        ${field(w("Exact value","精确值"),input("controlId",values.controlId,'maxlength="256" autocomplete="off"'))}</details>`;
}

function roleFields(w, roles, selected) {
    if (!roles?.length) return "";
    return `<fieldset class="case-role-field"><legend>${w("BDD role","BDD 角色")}</legend><div class="case-role-options">
        ${roles.map(role=>`<label><input type="radio" name="bdd-role" id="bdd-role-${h(role)}" value="${h(role)}"
            data-bdd-field="role" ${role===selected ? "checked" : ""}><span>${h(role)}</span></label>`).join("")}</div></fieldset>`;
}

function checkFields(w, values, protectedValue, field, input) {
    const property = field(w("Check","检查属性"),
        `<select id="bdd-property" data-bdd-field="property">${options(Object.entries(properties).map(([key,pair])=>[key,w(...pair)]),values.property)}</select>`);
    const booleanValues = values.property === "visible" ?
        [["true",w("Visible","可见")],["false",w("Hidden","不可见")]] : [["true","True"],["false","False"]];
    const value = values.property === "text" ?
        input("expected",values.expected,'maxlength="4096"'+(protectedValue ? ' type="password" autocomplete="off"' : "")) :
        `<select id="bdd-expected" data-bdd-field="expected">${options(booleanValues,values.expected)}</select>`;
    return property + field(w("Expected value","预期值"),value) +
        (protectedValue && values.property === "text" && values.target === "keep" ?
            `<p class="muted">${w("Leave the value empty to keep the current text.","留空可保留现有预期文字。")}</p>` : "");
}

function inputTextFields(w, values, field, input, required) {
    const change = !required ? `<label class="case-inline-field"><input type="checkbox" data-bdd-field="replaceInput"
        ${values.replaceInput ? "checked" : ""}>${w("Replace saved text","替换已保存的输入内容")}</label>` : "";
    if (!required && !values.replaceInput) return change;
    const text = field(w("Text to enter","输入内容"),input("text",values.text,
        'type="'+(values.revealInput?"text":"password")+'" autocomplete="off" spellcheck="false" maxlength="4096"'));
    return change+text+`<label class="case-inline-field"><input type="checkbox" data-bdd-field="revealInput"
        ${values.revealInput?"checked":""}>${w("Show entered text","显示输入内容")}</label>`;
}

function operationFields(model, review, w, field, input) {
    const {action,existing,values} = editor, {command} = values;
    const choices = (action?.choices || review.definitions.commands).map(name=>[name,w(...actions[name])]);
    const select = (key,items)=>`<select id="bdd-${key}" data-bdd-field="${key}">${options(items,values[key])}</select>`;
    const actionField = field(w("Action","操作"),select("command",choices));
    let parameters = "";
    if (command==="fill") parameters = inputTextFields(w,values,field,input,!existing || action?.command!=="fill");
    if (command==="scroll") parameters = field(w("Direction","方向"),
        select("direction",Object.entries(directions).map(([name,label])=>[name,w(...label)])));
    if (command==="open") parameters = `<div class="case-editor-fields">${field(w("App bundle name","应用包名"),
        input("app",values.app,'required maxlength="256"'))}${field(w("Ability (optional)","Ability（可选）"),
        input("ability",values.ability,'maxlength="256"'))}</div>`;
    if (command==="find") parameters = field(w("Find text","查找文字"),input("queryText",values.queryText,'required maxlength="4096"'));
    if (command==="wait") parameters = `<div class="case-editor-fields">${checkFields(w,values,
        action?.command==="wait" && action.keepExpected,field,input)}</div>`;
    const timeout = !["find","observe"].includes(command) ? field(w("Timeout in milliseconds (optional)","超时毫秒数（可选）"),
        input("timeout",values.timeout,'type="number" min="1" max="60000" step="1"')) : "";
    return actionField+parameters+(usesPicker(editor) ? locatorFields(model,review,w,field,input) : "")+timeout;
}

function gestureFields(review, w, field, input) {
    const {gesture,values,existing} = editor;
    const names = {x:w("Start X","起点 X"),y:w("Start Y","起点 Y"),toX:w("End X","终点 X"),toY:w("End Y","终点 Y"),
        velocity:w("Speed (px/s)","速度（像素/秒）")};
    const coordinates = Object.keys(gesture.fields).map(key=>{
        const finger = /^finger([12])-(\w+)$/.exec(key);
        const label = finger ? w("Finger ","手指 ")+finger[1]+" · "+names[finger[2]] : names[key];
        const velocity = key==="velocity";
        return field(label,`<input id="bdd-${key}" type="number" min="${velocity?200:0}" max="${velocity?40000:2147483647}"
            step="1" required data-bdd-field="coordinate" data-coordinate="${key}" value="${h(values.coordinates[key])}">`);
    }).join("");
    const kind = existing ? `<strong>${h(w(...(gestures[gesture.kind] || [gesture.kind,gesture.kind])))}</strong>` :
        field(w("Action","操作"),`<select id="bdd-kind" data-bdd-field="kind">${options(
            review.definitions.gestures.map(({kind})=>[kind,w(...gestures[kind])]),gesture.kind)}</select>`);
    return kind+
        (coordinates ? `<div class="case-editor-fields">${coordinates}</div>` : "")+
        (gesture.kind==="typeText" ? inputTextFields(w,values,field,input,!existing) : "")+
        field(w("Delay before this step (ms)","执行前间隔（毫秒）"),input("delay",values.delay,'type="number" min="0" max="2147483647" step="1" required'));
}

function boundaryFields(review,w,field,input,area) {
    const {values} = editor;
    const suggestions = (review.targets?.[area] || []).map(item=>[item.key,item.label]);
    const controls = [...(editor.existing ? [["keep",w("Keep current locator","保留当前定位器")]] : []),
        ["manual",w("Enter a control ID","输入控件 ID")], ...suggestions];
    const target = field(w("Locator","定位器"),`<select id="bdd-target" data-bdd-field="target">${options(controls,values.target)}</select>`);
    const custom = values.target === "manual" ? field(w("Control ID","控件 ID"),input("controlId",values.controlId,'maxlength="256" required')) : "";
    return target + custom + checkFields(w,values,editor.protectedValue,field,input);
}

function stepDetailsFields(model,review,w,field,input,blocked) {
    const {values,operationArea:area,executionOpen,defaultName} = editor;
    const summary = h(defaultName || "");
    let execution = "";
    if (executionOpen || editor.operationChanged) {
        if (area==="stepOperation") execution = operationFields(model,review,w,field,input);
        else if (area==="stepGesture") execution = gestureFields(review,w,field,input);
        else if (area==="start" || area==="goal") execution = boundaryFields(review,w,field,input,area);
        else if (area) execution = locatorFields(model,review,w,field,input) +
            (area==="stepCheck" ? checkFields(w,values,editor.protectedValue,field,input) : "");
    }
    return `<div class="case-step-identity">
        ${field(w("Step name","步骤名称"),input("name",values.name,'maxlength="120" autocomplete="off"'))}
        ${roleFields(w,editor.roles,values.role)}</div>
        ${field(w("Description","描述"),`<textarea id="bdd-description" data-bdd-field="descriptionText" rows="2" maxlength="1200" ${editor.description?"required":""}>${h(values.descriptionText)}</textarea>`)}
        ${field(w("Group","分组"),input("group",values.group,`maxlength="120" placeholder="${h(w("Ungrouped","未分组"))}"`))}
        ${area ? `<details class="case-step-execution"${executionOpen ? " open" : ""}><summary id="bdd-execution-toggle"${blocked ? " inert" : ""}><span>${w("Execution settings","执行设置")}</span>
            ${summary ? `<small>${summary}</small>` : ""}</summary>
            <div class="case-step-execution-fields" id="bdd-execution-fields">${execution}</div></details>` : ""}`;
}

function editForm(model, review, w, blocked) {
    if (!editor) return "";
    const {area, values} = editor;
    if (feedbackAreas.has(area)) {
        const step=area==="stepFeedback";
        return `<form class="case-editor case-feedback-editor" id="bdd-editor" data-bdd-form>
            <fieldset ${blocked?"disabled":""}>
            ${step && editor.defaultName ? '<p class="case-feedback-current"><small>'+w("Current step","当前步骤")+'</small> '+h(editor.defaultName)+'</p>' : ""}
            ${editor.fromFailure ? '<p class="case-review-note">'+h(w("From the selected failed run","来自选中的失败运行"))+
                (model.failureReview?.code ? ' · '+h(model.failureReview.code) : '')+'</p>' : ""}
            <label for="bdd-note">${step?w("What should change?","想怎么改"):w("Case feedback","用例修改意见")}</label>
            <textarea id="bdd-note" data-bdd-field="note" rows="3" maxlength="1200"
                placeholder="${h(step?w("Open Account settings first, then open Profile.","先打开账号设置，再进入个人资料。"):
                    w("Verify the profile nickname before returning to the home page.","在返回首页之前，校验个人资料页的昵称。"))}">${h(values.note)}</textarea>
            <div class="toolbar">
            ${step ? `<button type="submit" name="explore" id="bdd-explore-note" class="button vscode-button primary"${values.note.trim()?"":" disabled"}>${w("Revise in AI Exploration","去 AI 探索修改")}</button>` : ""}
            <button type="submit" class="button vscode-button${step?"":" primary"}">${w("Add to draft","加入草稿")}</button>
            ${step && !editor.description ? actionButton(w("Edit manually","手动编辑"),{quiet:true,attrs:{"data-bdd":"manualStep"}}) : ""}
            ${actionButton(w("Cancel","取消"),{quiet:true,attrs:{"data-bdd":"cancel"}})}</div></fieldset></form>`;
    }
    const field = (label,body) => `<label>${h(label)}${body}</label>`;
    const input = (key,value,attrs="") => `<input id="bdd-${key}" data-bdd-field="${key}" value="${h(value)}" ${attrs}>`;
    let fields;
    if (area === "name") {
        fields = field(w("Case name","用例名称"),input("name",values.name,'maxlength="70" required'));
    } else if (area === "stepDetails") {
        fields = stepDetailsFields(model,review,w,field,input,blocked);
    } else if (area === "stepName") {
        fields = field(w("Step name","步骤名称"),input("name",values.name,`maxlength="120" placeholder="${h(editor.defaultName)}"`)) +
            field(w("Group name (optional)","分组名称（可选）"),input("group",values.group,'maxlength="120"')) +
            roleFields(w,editor.roles,values.role);
    } else if (area==="stepOperation") {
        fields = operationFields(model,review,w,field,input);
    } else if (area==="stepGesture") {
        fields = gestureFields(review,w,field,input);
    } else if (usesPicker(editor)) {
        fields = locatorFields(model,review,w,field,input);
        if (area==="stepCheck") fields = roleFields(w,editor.roles,values.role) + fields +
            checkFields(w,values,editor.protectedValue,field,input);
    } else {
        fields = boundaryFields(review,w,field,input,area);
    }
    const canApply = (area==="stepDetails" && !editor.operationChanged) || !usesPicker(editor) || ["keep","auto"].includes(values.target) || (values.target === "manual" ? values.controlId.trim() :
        currentPicker(review,editor)?.choices.some(item=>item.key===values.target));
    const variant = area==="stepDetails" ? " case-step-details" : area === "name" ? " case-rename" : usesPicker(editor) ? " case-locator-editor" : "";
    const heading = area==="stepDetails" ? w("Edit step","编辑步骤") : editor.side ? (area==="stepCheck" ? w("Insert a check","插入验证") : w("Insert an action","插入操作")) : "";
    return `<form class="case-editor${variant}" id="bdd-editor" data-bdd-form>
        <fieldset ${blocked ? "disabled" : ""}>${heading ? `<legend>${h(heading)}</legend>` : ""}${fields}
        <div class="toolbar"><button id="bdd-apply" type="submit" class="button vscode-button primary" ${canApply?"":"disabled"}>${area==="stepDetails" ? w("Apply to draft","应用到草稿") : area==="name"&&review.edit&&!review.dirty?w("Save","保存"):w("Apply","应用")}</button>
        ${editor.feedbackBack ? actionButton(w("Back to feedback","返回修改意见"),{quiet:true,attrs:{"data-bdd":"backFeedback"}}) : ""}
        ${actionButton(w("Cancel","取消"),{quiet:true,attrs:{"data-bdd":"cancel"}})}</div></fieldset></form>`;
}

export function caseEditorToggle(detail,model,send,render) {
    if (!detail.isConnected || !detail.classList.contains("case-step-execution") || editor?.area!=="stepDetails" ||
        Boolean(editor.executionOpen)===detail.open) return;
    editor.executionOpen=detail.open;
    const review=model.caseReview;
    if (!detail.open) endCasePicture(model,send);
    else if (review && (usesPicker(editor) && !currentPicker(review,editor) ||
        ["start","goal"].includes(editor.operationArea) && !review.targets?.[editor.operationArea])) requestTargets(editor,send);
    // Edited fields stay mounted while closed, including any field currently reporting a validation error.
    if (!editor.operationChanged) render();
}

export function caseEditorClick(control, model, send, render) {
    const action = control.dataset.bdd;
    if (!action) return false;
    const review = model.caseReview;
    if (!review || model.busy || review.pendingSave) return true;
    const request = {id:review.id,revision:review.revision};
    if (action === "organize" || action === "stopOrganizing") {
        send({type:action==="organize" ? "caseOrganize" : "caseOrganizeCancel",...request});
        return true;
    }
    if (review.organization?.working) return true;
    if (action==="manualStep" && editor?.area==="stepFeedback") {
        return openCaseEditor({area:"stepDetails",path:editor.path,existing:true,
            stepDefault:editor.defaultName,feedbackBack:editor},model,send,render);
    }
    if (action==="backFeedback" && editor?.feedbackBack) {
        endCasePicture(model,send);
        editor=editor.feedbackBack;
        render();
        document.getElementById("bdd-note")?.focus();
        return true;
    }
    if (["pick","keep","auto"].includes(action) && usesPicker(editor)) {
        editor.values.target = action==="pick" ? control.dataset.target : action;
        editor.operationChanged = true;
        render();
        return true;
    }
    if (["scan","picture"].includes(action) && usesPicker(editor)) {
        if (action==="picture" && currentPicker(review,editor)?.picture) {
            endCasePicture(model,send);
            return true;
        }
        editor.values.query = "";
        if (!["keep","auto","manual"].includes(editor.values.target)) editor.values.target = defaultTarget(editor);
        requestTargets(editor,send,{live:true,pick:action==="picture"});
        return true;
    }
    if (action === "cancel") {
        const {area,path,index,existing} = editor || {};
        editor = undefined;
        if (review.edit && !review.dirty) {
            send({type:"caseCancel",id:review.id});
            return true;
        }
        endCasePicture(model,send);
        render();
        const row = [...document.querySelectorAll("[data-bdd][data-area]")].find(el=>el.dataset.area===area &&
            !el.closest("[data-item-menu]") && (area==="name" || area==="caseFeedback" || (stepAreas.includes(area) ? el.dataset.path===path :
                Number(el.dataset.index)===index && (el.dataset.bdd==="edit")===existing)));
        const menu = path && [...document.querySelectorAll("[data-case-step]")].find(el=>el.dataset.caseStep===path);
        (row || menu?.querySelector(":scope > [data-item-menu-trigger]"))?.focus();
        return true;
    }
    return openCaseEditor({...control.dataset,existing:action==="edit"},model,send,render);
}

export function openCaseEditor({area,path,side,index,role,existing=false,stepDefault,feedbackBack,fromFailure}, model, send, render) {
    const review = model.caseReview;
    if (!review || model.busy || review.pendingSave || review.organization?.working) return false;
    index = Number(index);
    const boundary = area==="stepDetails" && /^(preconditions|goals)\[(\d+)\]$/.exec(path);
    const boundaryArea = boundary ? boundary[1]==="preconditions" ? "start" : "goal" : undefined;
    if (boundary) index=Number(boundary[2]);
    const step = boundary ? review.definitions?.[boundaryArea]?.[index] : review.definitions?.steps?.[path];
    if (area==="stepDetails" && !step) return false;
    const technical = area==="stepDetails" ? (boundary ? step.property && "stepCheck" :
        step.action ? "stepOperation" : step.gesture ? "stepGesture" : step.check ? "stepCheck" : step.locator ? "step" : undefined) : area;
    const check = technical==="stepCheck" ? (existing && (boundary ? step : step?.check)) : review.definitions?.[technical]?.[index];
    const roles = area==="stepCheck" ? ["Then","Given"] : step?.roles;
    endCasePicture(model,send);
    editor = {id:review.id,revision:review.revision,area,path,side,index,existing,roles,defaultName:stepDefault,operationArea:technical,
        description:step?.description,feedbackBack,fromFailure:fromFailure==="true",protectedValue:check?.protectedValue,
        action:existing ? step?.action : undefined,gesture:step?.gesture,locator:step?.locator,
        initialName:step?.name,initialDescription:step?.descriptionText ?? stepDefault ?? "",
        values:{name:area==="name" ? review.name : existing ? step?.name || (area==="stepDetails" ? stepDefault : "") || "" : "",
            descriptionText:step?.descriptionText ?? stepDefault ?? "",group:step?.group || "",query:"",locatorField:"id",
            ...(feedbackAreas.has(area) && {note:(area==="caseFeedback" ? review.bdd?.editNote : step?.editNote) || ""}),
            role:area==="stepCheck" && !existing ? role || "Then" : step?.role,
            target:area==="step" ? "" : existing ? "keep" : area==="stepCheck" ? "" : "manual",
            controlId:"",property:check?.property || "visible",expected:check?.expected ?? "true",text:"",replaceInput:false,
            coordinates:{...step?.gesture?.fields},delay:existing ? step?.gesture?.delay : undefined}};
    if (technical==="stepOperation") setCommand(editor,editor.action?.command || "press");
    if (area==="stepGesture" && !existing) setGesture(editor,review.definitions.gestures[0]);
    render();
    const field = area==="stepDetails" ? document.getElementById("bdd-name") : feedbackAreas.has(area) ? document.getElementById("bdd-note") : area==="stepOperation" ? document.getElementById("bdd-command") : area==="stepGesture" && !existing ?
        document.getElementById("bdd-kind") : usesPicker(editor) ?
        document.querySelector("#bdd-pick-screen:enabled, #bdd-query, #bdd-scan:enabled, #bdd-manual > summary") :
        document.querySelector("#bdd-editor input, #bdd-editor select");
    field?.focus();
    if (area === "name" || area === "stepName" || area==="stepDetails") field?.select();
    if (area!=="stepDetails" && ((["start","goal"].includes(area) && !review.targets?.[area]) || (usesPicker(editor) && !currentPicker(review,editor))))
        requestTargets(editor,send);
    return true;
}

function defaultTarget(current) {
    if (operationArea(current)==="stepOperation") {
        if (current.locator && current.action?.command===current.values.command) return "keep";
        return current.values.command==="scroll" ? "auto" : "";
    }
    return operationArea(current)==="stepCheck" && current.existing ? "keep" : "";
}

function setCommand(current, command) {
    const saved = current.action?.command===command ? current.action : undefined;
    Object.assign(current.values,{command,direction:saved?.direction || "down",app:saved?.app || "",ability:saved?.ability || "",
        timeout:saved?.timeout ?? "",queryText:saved?.queryText || "",property:saved?.property || "visible",
        expected:saved?.expected ?? "true",text:"",replaceInput:command==="fill" && !saved,revealInput:false,
        query:"",controlId:"",locatorField:"id"});
    current.values.target = defaultTarget(current);
}

function setGesture(current, gesture) {
    current.gesture = gesture;
    Object.assign(current.values,{kind:gesture.kind,coordinates:Object.fromEntries(Object.keys(gesture.fields).map(key=>[key,""])),
        delay:current.values.delay ?? gesture.delay,text:"",revealInput:false});
}

export function caseEditorInput(field, model, send, render) {
    const key = field.dataset.bddField;
    if (!key || !editor) return false;
    if (field.type==="radio" && !field.checked) return true;
    const value = field.type === "checkbox" ? field.checked : field.value;
    if (key==="coordinate") {
        editor.values.coordinates[field.dataset.coordinate] = value;
        editor.operationChanged = true;
        return true;
    }
    if (editor.values[key] === value) return true;
    if (!["name","group","descriptionText","role","query","note","revealInput"].includes(key)) editor.operationChanged=true;
    if (key==="command" && operationArea(editor)==="stepOperation") {
        endCasePicture(model,send);
        setCommand(editor,value);
        render();
        if (usesPicker(editor)) requestTargets(editor,send);
        return true;
    }
    if (key==="kind" && editor.area==="stepGesture" && !editor.existing) {
        const option = model.caseReview.definitions.gestures.find(gesture=>gesture.kind===value);
        if (option) { setGesture(editor,option); render(); }
        return true;
    }
    editor.values[key] = value;
    if (key==="note") {
        const explore=document.getElementById("bdd-explore-note");
        if (explore) explore.disabled=!value.trim();
    }
    if (key === "property") editor.values.expected = value === "text" ? "" : "true";
    const manual = usesPicker(editor) && ["controlId","locatorField"].includes(key);
    if (manual) editor.values.target = "manual";
    if (["property","target","query","replaceInput","revealInput"].includes(key) || manual) render();
    return true;
}

export function caseEditorSubmit(event, model, send) {
    if (!event.target.hasAttribute("data-bdd-form")) return;
    event.preventDefault();
    if (editor && !model.busy) {
        const {id,revision,area,path,side,index,existing,values,fromFailure} = editor;
        if (area==="stepDetails") {
            const {name,role,group,descriptionText,...parameters}=values;
            send({type:"caseEdit",id,revision,area,path,index,group,role,
                name:!editor.initialName && name===editor.defaultName ? "" : name,
                ...(descriptionText!==editor.initialDescription && {descriptionText}),
                ...(editor.operationChanged && {operationArea:editor.operationArea,...parameters})});
            return;
        }
            send({type:"caseEdit",id,revision,area,path,side,index,...values,add:!existing,
                ...(area==="stepCheck" && !existing && {positionedCheck:true}),explore:event.submitter?.name==="explore",fromFailure,
            saveName:area==="name"&&model.caseReview.edit&&!model.caseReview.dirty});
    }
}

export function stepEditArea(definition) {
    return definition.action ? "stepOperation" : definition.gesture ? "stepGesture" :
        definition.check ? "stepCheck" : definition.locator ? "step" : "stepName";
}

export function ruleGroupStepButton(step,label,w,menu=false) {
    return actionButton(label,{quiet:!menu,className:menu ? "" : "case-value case-step-name",attrs:{
        "data-case-insert":"editRuleGroup","data-path":step.path,"data-rule-action":step.ruleGroup?.action,
        ...(!menu && {"data-order-hit":"","data-selection-hit":"",title:w("Edit rule group","编辑规则组")})}});
}

export function caseStepActions(step, definition, edit, w) {
    if (!definition) return "";
    const context = {path:step.path,index:step.index,defaultName:step.text};
    const main = edit(w("Edit step","编辑步骤"),"stepDetails",{...context,primaryStep:true});
    const change = (action,label)=>actionButton(label,{attrs:{"data-type":"caseStepAction","data-step-action":action,"data-case-path":step.path}});
    if (step.area==="start" || step.area==="goal") return main +
        change("duplicate",w("Duplicate step","复制步骤")) + change("remove",w("Delete step","删除步骤"));
    if (definition.reference) return main + (definition.removable ? change("remove",w("Remove reference","移除引用")) : "");
    if (definition.ruleGroup) return main + (step.ruleGroup?.editable ? ruleGroupStepButton(step,w("Configure rule group","配置规则组"),w,true) : "") +
        (definition.removable ? change("remove",w("Delete step","删除步骤")) : "");
    const feedback = edit(w("Revise with AI","用 AI 修改此步"),"stepFeedback",context);
    if (definition.description) {
        const attrs = {"data-path":step.path,"data-description-id":step.description.id};
        return main + (step.description.implemented ? feedback : "") +
            actionButton(step.description.implemented ? w("Generate again","重新生成") : w("Generate steps","生成步骤"),
                {attrs:{...attrs,"data-compose":"generateDescription"}}) +
            change("duplicate",w("Duplicate step","复制步骤")) + (definition.removable ? change("remove",w("Delete step","删除步骤")) : "");
    }
    return main + feedback +
        change("duplicate",w("Duplicate step","复制步骤")) + (definition.removable ? change("remove",w("Delete step","删除步骤")) : "");
}

export function caseReviewView(model,language,runSummary="") {
    const review = model.caseReview;
    if (!review) return "";
    if (editor && (editor.id !== review.id || editor.revision !== review.revision)) editor = undefined;
    const w = (en,zh)=>/^zh/i.test(language)?zh:en;
    const editingDisabled = model.busy || review.pendingSave || review.organization?.working;
    const stepSelection = stepSelectionFor(model,!editor && !review.pendingSave && !review.organization?.working &&
        review.bdd?.steps?.some(step=>step.path));
    const button = (type,label,extra={},primary=false)=>actionButton(label,{primary,disabled:model.busy ||
        (type==="caseSave" && (review.empty && !review.pending?.length || Boolean(editor) || (review.edit && !review.dirty))) || (type==="caseCancel" && review.pendingSave),
        attrs:{"data-type":type,"data-id":review.id,...extra}});
    const edit = (label,area,{index,path,add,defaultName,stepLabel,primaryStep}={})=>actionButton(label,{quiet:true,
        className:stepLabel ? "case-value case-step-name" : "",
        disabled:editingDisabled,
        attrs:{"data-bdd":add ? "add" : "edit","data-area":area,"data-index":index,"data-path":path,"data-step-default":defaultName,
            "data-order-hit":stepLabel ? "" : undefined,"data-selection-hit":stepLabel ? "" : undefined,
            "data-step-editor":primaryStep ? "" : undefined}});
    const sources = {recording:w("Recording","录制"),exploration:w("AI exploration","AI 探索"),workflow:w("Workflow file","流程文件")};
    const outcomes = {
        observed:w("The original run recorded these actions.","原始记录已确认这些操作。"),
        checksPassed:w("The original run passed its recorded checks.","原运行已通过对应的检查。"),
        checkFailed:w("The original run failed a check. This case keeps the original expectation for reproduction.",
            "原运行有检查失败。用例保留原预期，可用于复现。"),
        review:w("The exploration observed this behavior. Its intended result needs confirmation.","这是探索观察到的行为，预期结果需要确认。"),
    };
    const fork=review.origin?.forkPosition;
    const position=typeof fork==="number" || review.origin?.branchId && /^\d+$/.test(fork) ?
        (Number(fork)>0 ? w("After step "+fork,"第 "+fork+" 步后") : w("Case start","用例起点")) : fork;
    const source = review.origin?.parentCaseName ?
        [review.source==="workflow" ? w("Copied from “"+review.origin.parentCaseName+"”","复制自「"+review.origin.parentCaseName+"」") :
            w("Branched from “"+review.origin.parentCaseName+"”","分叉自「"+review.origin.parentCaseName+"」"),position].filter(Boolean).join(" · ") :
        [sources[review.source], review.origin?.label!==review.name && review.origin?.label].filter(Boolean).join(" · ");
    const issue = review.issue;
    const missingReads=review.missingReads?.map(name=>"$"+name).join(", ");
    const status = review.empty || issue==="description" ? "" : issue==="ruleSteps" ?
        w("Run this case in the workbench to apply its rule group steps.","在工作台运行此用例时会执行规则组步骤。") :
        issue==="gestures" ? w("Coordinate replay · requires the original screen size and orientation. Business assertions are unavailable for gesture recordings.",
        "坐标回放 · 需要原屏幕尺寸和方向，手势录制不包含业务断言。") :
        pytestCheckHint(issue,language) || "";
    const form = editForm(model,review,w,model.busy);
    const editingStep = path=>stepAreas.includes(editor?.area) && editor?.path === path;
    const outline = review.bdd?.steps || review.bdd?.when || [];
    const splitEditor = editor?.area==="stepDetails" && outline.some(step=>step.path===editor.path)
        ? {path:editor.path,form} : undefined;
    const inserting = ["stepCheck","stepOperation","stepGesture"].includes(editor?.area) && !editor.existing;
    const renderRow = (text,{area,index,path,step}) => {
        if (stepSelection?.active) return;
        const editable = area === "step" ? review.definitions?.steps[path] : review.definitions?.[area]?.[index];
        if (!editable) return;
        if (area==="step" && editingStep(path) && !inserting && editor.area!=="stepDetails") return form;
        if (area!=="step" && editor?.area===area && editor.index===index) return form;
        return caseStepLabel(text,step,!editor && edit(step.name || text,"stepDetails",{path,index,defaultName:text,stepLabel:true}));
    };
    const save = issue==="description" ? w("Save draft","保存草稿") : review.edit ? w("Save case changes","保存用例修改") : issue==="gestures" ? w("Save replay case","保存回放用例") :
        issue && issue!=="ruleSteps" ? w("Save case draft","保存用例草稿") : w("Save test case","保存测试用例");
    const organization = review.organization;
    const selectionTools = stepSelectionControls(stepSelection,w,model);
    const tools = stepSelection?.active ? selectionTools : `<div class="case-step-tools">${organization?.working ? `<small role="status">${w("Organizing steps…","正在整理步骤…")}</small>` : ""}
        ${actionButton(organization?.working ? w("Stop","停止") : w("Organize with AI","用 AI 整理步骤"),{
            quiet:true,disabled:Boolean(editor || model.busy || review.pendingSave || review.empty || issue==="description"),attrs:{id:"bdd-organize","data-area":"organize",
                "data-bdd":organization?.working ? "stopOrganizing" : "organize"}})}
        ${review.undoRemove ? button("caseStepAction",w("Undo deletion","撤销删除"),{"data-step-action":"undoRemove"}) : ""}
        ${compositionControls(review.bdd,w,Boolean(editor || editingDisabled))}${selectionTools}</div>`;
    const organizationNote = organization?.error || (organization?.ready && w("Review the suggested step details, then save the case.",
        "请核对 AI 建议的步骤名称、分组和角色，然后保存用例。"));
    const whole = Boolean(review.pending?.length || review.dirty && !review.empty);
    const explore = whole ? actionButton(w("Explore the whole draft","探索整个草稿"),{primary:true,
        disabled:Boolean(editor || editingDisabled),attrs:{"data-compose":"reviseCase"}}) : "";
    const opinion = editor?.area==="caseFeedback" ? form : caseFeedbackView(review.bdd,
        edit(review.bdd?.editNote?w("Edit feedback","编辑意见"):w("Case feedback","用例修改意见"),"caseFeedback"),w);
    return `<section class="plan-sheet case-detail-sheet"><header class="case-detail-head">
        <div class="case-heading">
            ${review.edit ? "" : `<p class="kicker">${h(w("Review test case","核对测试用例"))}</p>`}
            ${editor?.area === "name" ? form : `<h1><button type="button" class="case-value case-title"
                data-bdd="edit" data-area="name" ${editingDisabled?"disabled":""}>${h(review.name)}</button></h1>`}
        </div>
        <div class="case-header-actions">${explore}${button("caseSave",save,{id:"bdd-save"},!whole)}${button("caseCancel",w("Cancel","取消"))}</div>
        </header>${review.edit ? runSummary : ""}
        ${!review.edit && source ? `<p class="case-review-note">${h(source)}</p>` : ""}
        ${!review.edit && outcomes[review.origin?.outcome] ? `<p class="case-review-note">${h(outcomes[review.origin.outcome])}</p>` : ""}
        ${missingReads ? `<p class="case-composition-warning">${h(w("Add a step to read "+missingReads+" before using it in this case.",
            "有步骤用到了 "+missingReads+"。请在使用前加入读取这些变量的步骤。"))}</p>` : ""}
        ${casePendingNotice(review.pending,language)}
        ${opinion}
        ${issue!=="description" && (review.added || review.undoRemove) ? `<p class="case-review-note">${h(w("The next run will use these changes.","修改将在下次运行时验证。"))}</p>` : ""}
        ${review.timingUnknown ? `<p>${h(w("This older report retained the confirmed gestures only. Their original delays are unavailable.","旧报告仅保留了已确认的手势，无法恢复原先的操作间隔。"))}</p>` : ""}
        ${status && (!review.edit || issue!=="gestures") ? `<p class="case-review-note">${h(status)}</p>` : ""}
        ${organizationNote ? `<p class="case-review-note" role="status">${h(organizationNote)}</p>` : ""}
        ${review.compositionStale ? `<p class="case-composition-warning">${w("Workflow JSON changed. Review the executable steps before saving.",
            "流程 JSON 已修改。保存前请核对当前执行步骤。")}</p>` : ""}
        ${caseBddView(review.bdd,language,{renderRow,tools,coordinates:review.coordinates,stepSelection,definitions:review.definitions,splitEditor,
            renderAfterStep:step=>!inserting && editingStep(step.path) && !splitEditor && (editor.area==="stepDetails" || step.branches) ? form : "",
            insertionForm:inserting ? {path:editor.path,side:editor.side || "after",form} : undefined,
            stepActions:!editor && !editingDisabled ? step=>caseStepActions(step,review.definitions.steps[step.path] || review.definitions[step.area]?.[step.index],edit,w)+
                compositionStepMenu(step,model,w)+caseForkStepMenu(step,model,w) : undefined,
            insert:!editor && !editingDisabled,insertedPath:review.insertionUndo,insertionNotice:review.insertionNotice,
            editingOpinionPath:editor?.area==="stepFeedback" ? editor.path : undefined,
            reorder:!editor && !editingDisabled})}
        </section>`;
}

export function caseFeedbackView(bdd,action,w) {
    if (!bdd?.editNote) return `<div class="case-feedback-link">${action}</div>`;
    return `<section class="case-feedback-summary"><div><small>${w("Case feedback","用例修改意见")}</small>
        <p>${h(bdd.editNote)}</p></div>${action}</section>`;
}
