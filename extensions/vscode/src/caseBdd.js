"use strict";

const {targetLabel, deviceRecordingFormat} = require("./model");
const {stepRoles, restorePresentation, caseDescription, descriptionText} = require("./casePresentation");
const {referenceStatus} = require("./caseComposition");
const {ruleGroupsByPosition,overlapsPreviousRuleEnable} = require("./caseRuleSteps");
const {ruleGroupName} = require("./network");

const secret = /pass(?:word|code)|secret|token|密码|口令|验证码/i;
const properties = {visible: ["visible", "可见", "不可见"], enabled: ["enabled", "可用", "不可用"],
    checked: ["checked", "已勾选", "未勾选"], selected: ["selected", "已选中", "未选中"],
    focused: ["focused", "获得焦点", "未获得焦点"]};
const directions = {up: ["up", "向上"], down: ["down", "向下"], left: ["left", "向左"], right: ["right", "向右"]};
const gestures = {click: ["Tap", "点击"], doubleClick: ["Double tap", "双击"], longClick: ["Long press", "长按"],
    swipe: ["Swipe", "滑动"], drag: ["Drag", "拖动"], fling: ["Fling", "快速滑动"], back: ["Go back", "返回"],
    pinch: ["Pinch the screen", "双指缩放"], home: ["Go to the Home screen", "返回主页"],
    recents: ["Open recent apps", "打开最近任务"], typeText: ["Enter text in the focused field", "在当前输入框输入文字"],
    unsupported: ["Unrecognized gesture", "未识别的手势"]};

function selectorLabel(selector, words) {
    const sensitive = secret.test(JSON.stringify(selector || ""));
    if (sensitive && typeof selector === "string") {
        return selector.startsWith("id=") ? selector.slice(0, 100) : words("Protected control", "敏感控件");
    }
    if (sensitive) return String(selector.id || selector.type || words("Protected control", "敏感控件")).slice(0, 100);
    return (targetLabel(selector) || (typeof selector?.key === "string" && selector.key) ||
        (typeof selector?.textPrefix === "string" && selector.textPrefix + "…") || words("Matching control", "匹配控件")).slice(0, 120);
}

function expectation(check, w) {
    if (!check || !check.selector || !Object.hasOwn(check, "equals")) return w("Incomplete check", "检查条件不完整");
    const target = selectorLabel(check.selector, w);
    const property = check.property || "text", value = check.equals;
    if (Object.hasOwn(properties, property) && typeof value === "boolean") {
        const [state, yes, no] = properties[property];
        return w(target + (value ? " is " : " is not ") + state, target + (value ? " " + yes : " " + no));
    }
    let expected;
    if (secret.test(JSON.stringify(check.selector))) expected = "••••";
    else if (typeof value?.var === "string") expected = "$" + value.var;
    else if (Array.isArray(value?.concat)) expected = value.concat.map(part =>
        typeof part === "string" ? JSON.stringify(part.slice(0, 120)) : "$" + part?.var).join(" + ");
    else expected = JSON.stringify(value);
    const display = String(expected ?? "").slice(0, 200);
    return property === "text" ? w(target + " shows " + display, target + " 显示 " + display) :
        target + " · " + property + " = " + display;
}

function gesture(input, w) {
    const verb = Object.hasOwn(gestures, input.kind) ? w(...gestures[input.kind]) : w("Unknown gesture", "未知手势");
    if (input.kind === "recents") return verb;
    const point = (x, y) => Number.isFinite(x) && Number.isFinite(y) ? "(" + x + ", " + y + ")" : "";
    return [verb, [point(input.x, input.y), point(input.toX, input.toY)].filter(Boolean).join(" → ")].filter(Boolean).join(" ");
}

function commandText(command, input, w) {
    const target = selectorLabel(input.target, w);
    switch (command) {
        case "press": return w("Tap " + target, "点击 " + target);
        case "fill": return w("Fill " + target, "填写 " + target);
        case "observe": return w("Read the current page", "读取当前页面");
        case "open": return w("Open " + (input.app || "app"), "打开 " + (input.app || "应用"));
        case "wait": return w("Wait until ", "等待 ") + expectation({selector: input.target, property: input.property, equals: input.equals}, w);
        case "scroll": {
            const direction = Object.hasOwn(directions, input.direction) ? w(...directions[input.direction]) : "";
            return w("Scroll " + direction, direction + "滚动") + (input.target ? " · " + target : "");
        }
        case "back": return w("Go back", "返回上一页");
        case "find": return w("Find text", "查找文字") + (input.text ? " · " + String(input.text).slice(0, 100) : "");
        default: return w("Unknown operation", "未知操作");
    }
}

function createBdd(plan, language = "en", ruleGroup, presentation, composition) {
    if (!Array.isArray(plan?.steps)) return;
    const index = /^zh/i.test(language) ? 1 : 0;
    const w = (...pair) => pair[index];
    const checks = values => Array.isArray(values) ? values.map(check => expectation(check, w)) : [];
    const coordinate = plan.format === deviceRecordingFormat;
    const positions = ruleGroupsByPosition(plan,ruleGroup);
    const ruleClosures = {};
    for (const [path,{before,after}] of positions) {
        if (before?.active.size || after?.active.size)
            ruleClosures[path] = {before:Boolean(before?.active.size),after:Boolean(after?.active.size)};
    }
    function rows(steps, path = "steps", depth = 0) {
        if (!Array.isArray(steps) || depth > 8) return [];
        return steps.map((step, i) => {
            const location = path + "[" + i + "]";
            const input = step?.input || {};
            const display = presentation?.get(step);
            const receiptPath = composition?.paths?.get(location);
            const editNote = descriptionText(step?.editNote);
            const row = {area:"step", index:i, path:location, ...(receiptPath && receiptPath!==location && {receiptPath}),
                ...(display?.name && {name:display.name}), ...(display?.group && {group:display.group}),
                ...(display?.description && {displayDescription:display.description}),...(editNote && {editNote})};
            const description = caseDescription(step);
            if (description) {
                const implemented = Array.isArray(description.steps) && description.steps.length>0;
                return {...row,role:display?.role || stepRoles(step)[0],text:description.text,description:{id:description.id,implemented},
                    ...(implemented && {branches:[{steps:rows(description.steps,location+".description.steps",depth+1)}]})};
            }
            if (step?.useCase) {
                const ref = referenceStatus(step.useCase,composition?.sources);
                const preview = createBdd(ref.plan,language,undefined,restorePresentation(ref.plan,ref.presentation));
                const layout = composition?.layouts?.get(location);
                function linked(child) {
                    return {...child,path:location+".linked."+child.path,receiptPath:layout?.map(child.path),
                        ...(child.branches && {branches:child.branches.map(branch=>({...branch,steps:branch.steps.map(linked)}))})};
                }
                return {...row,role:display?.role || stepRoles(step)[0],text:ref.name,
                    reference:{caseId:ref.caseId,status:ref.status,digest:ref.digest?.slice(0,8)},
                    branches:[{steps:preview?.steps?.map(linked) || [],readOnly:true}]};
            }
            if (step.ruleGroup) {
                const {action,scenario,name:target} = step.ruleGroup;
                const before = positions.get(location)?.before;
                const enable = action==="enable";
                const legacyTarget = before?.possible.size===1 && before.active.size===1 ? before.active.values().next().value : undefined;
                const name = enable ? ruleGroupName(scenario) : target ?? legacyTarget;
                const label = name===undefined ? undefined : name || w("Unnamed rule group","未命名规则组");
                const unavailable = !enable && Boolean(before) &&
                    (typeof target==="string" ? !before.active.has(target) : !before.possible.size);
                const repeated = enable && overlapsPreviousRuleEnable(before,name,location);
                return {...row,role:display?.role || stepRoles(step)[0],ruleGroup:{action,name:label,unavailable,repeated,
                    editable:enable || Boolean(before?.active.size)},
                    text:enable ? w("Enable rule group ","启用规则组 ")+label :
                        label!==undefined ? w("Turn off rule group ","关闭规则组 ")+label :
                            w("Turn off the most recently enabled rule group","关闭最近启用的规则组")};
            }
            if (coordinate || step?.command==="deviceGesture") return {...row,role:display?.role || "When",text:gesture(input,w)};
            row.role = display?.role || stepRoles(step)[0];
            if (step?.if) {
                const branches = [{label: w("If true", "满足时"), steps: rows(step.then, location + ".then", depth + 1)}];
                if (step.else?.length) branches.push({label: w("Otherwise", "否则"), steps: rows(step.else, location + ".else", depth + 1)});
                return {...row, text: w("If ", "如果 ") + expectation(step.if, w), branches};
            }
            if (step?.repeat) return {...row, text: w("Repeat until ", "重复直到 ") + expectation(step.repeat.until, w),
                branches: [{label: w("At most " + step.repeat.limit + " iterations", "最多重复 " + step.repeat.limit + " 次"),
                    steps: rows(step.repeat.steps, location + ".repeat.steps", depth + 1)}]};
            if (step?.assert) return {...row, text: w("Verify ", "验证 ") + expectation(step.assert, w)};
            if (step?.read) {
                const read = step.read;
                return {...row, text: w("Read ", "读取 ") + selectorLabel(read.selector, w) + " · " +
                    String(read.property || "text") + (read.name ? " → $" + read.name : "")};
            }
            if (step?.yield || step?.stop) return {...row, text: step.yield ? w("Yield execution", "暂停执行") : w("Stop execution", "停止执行")};
            return {...row, text: commandText(step?.command, input, w),
                ...(step?.before?.length && {before: checks(step.before)}),
                ...(input.expect && {after: expectation(input.expect, w)})};
        });
    }
    const boundaries = (list, area, path, role) => checks(list).map((text,index)=>{
        const display=presentation?.get(list[index]);
        return {text,area,index,path:path+"["+index+"]",role:display?.role || role,
            ...(display?.name && {name:display.name}),...(display?.description && {displayDescription:display.description}),
            ...(display?.group && {group:display.group})};
    });
    const setup = ruleGroup ? [{area:"setup",role:"Given",text:w("Use rule group ","使用规则组 ")+
        (ruleGroup.name || w("Unnamed rule group","未命名规则组"))}] : [];
    return {...(descriptionText(plan.editNote) && {editNote:plan.editNote}),
        ...(Object.keys(ruleClosures).length && {ruleClosures}),steps:[...setup, ...boundaries(plan.preconditions,"start","preconditions","Given"),
        ...rows(plan.steps), ...boundaries(plan.goals,"goal","goals","Then")]};
}

module.exports = {createBdd, expectation};
