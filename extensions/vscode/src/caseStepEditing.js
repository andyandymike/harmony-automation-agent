"use strict";

const {targetCommands} = require("./caseLocators");
const {validateGesture} = require("./deviceRecorder");

const commands = ["press","fill","scroll","back","wait","open","find","observe"];
const mutations = new Set(["press","fill","scroll","back","open"]);
const directions = ["up","down","left","right"];
const checkProperties = ["visible","text","enabled","checked","selected","focused"];
const sensitive = /pass(?:word|code)|secret|token|密码|口令|验证码/i;

function editableCommands(step) {
    return step?.before?.length || step?.refresh || step?.input?.expect ? commands.filter(command=>mutations.has(command)) : commands;
}

function actionDefinition(step) {
    const {command,input={}} = step;
    if (!commands.includes(command)) return;
    const bound = command==="fill" && input.text && typeof input.text==="object";
    const keepExpected = command==="wait" && (typeof input.equals==="object" ||
        (input.property || "text")==="text" && sensitive.test(JSON.stringify(input.target)));
    return {command,choices:editableCommands(step),timeout:input.timeout_ms,
        ...(command==="scroll" && {direction:input.direction || "down"}),
        ...(command==="open" && {app:input.app,ability:input.ability}),
        ...(command==="find" && {queryText:input.text}),
        ...(command==="fill" && {bound:Boolean(bound)}),
        ...(command==="wait" && {property:input.property || "text",expected:keepExpected ? "" : String(input.equals ?? ""),keepExpected}),
    };
}

function integer(value, minimum, maximum, error) {
    const parsed = typeof value==="number" || typeof value==="string" && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed<minimum || parsed>maximum) throw new Error(error);
    return parsed;
}

function buildAction(previous, fields, selector, w) {
    const {command} = fields;
    if (!editableCommands(previous).includes(command))
        throw new Error(w("Choose an action compatible with the step’s existing checks.","请选择能保留此步骤已有检查的操作。"));
    const same = previous?.command===command, prior = previous?.input || {};
    const input = same ? {...prior} : (prior.expect && mutations.has(command) ? {expect:prior.expect} : {});
    if (targetCommands.has(command) && selector) input.target=selector;
    else delete input.target;
    if (command==="scroll") {
        if (!directions.includes(fields.direction)) throw new Error(w("Choose a scroll direction.","请选择滑动方向。"));
        input.direction = fields.direction;
    }
    if (command==="fill" && (!same || fields.replaceInput===true)) {
        if (typeof fields.text!=="string" || fields.text.length>4096 || fields.text.includes("\0"))
            throw new Error(w("Enter text of up to 4096 characters.","请输入不超过 4096 个字符的内容。"));
        input.text = fields.text;
    }
    if (command==="find") {
        if (typeof fields.queryText!=="string" || !fields.queryText.trim() || fields.queryText.length>4096)
            throw new Error(w("Enter the text to find.","请输入要查找的文字。"));
        input.text = fields.queryText;
    }
    if (command==="open") {
        const app = typeof fields.app==="string" && fields.app.trim();
        const ability = typeof fields.ability==="string" ? fields.ability.trim() : "";
        if (!app || app.startsWith("-") || app.length>256 || ability.length>256 || /[\x00-\x1f]/.test(app+ability))
            throw new Error(w("Enter the app bundle name and, if needed, its ability.","请输入应用包名，需要时可填 Ability。"));
        input.app = app;
        if (ability) input.ability=ability;
        else delete input.ability;
    }
    if (command==="wait") {
        const {property,expected} = fields;
        if (!checkProperties.includes(property)) throw new Error(w("Choose a property to wait for.","请选择等待的属性。"));
        const old = same && actionDefinition(previous);
        if (!(old?.keepExpected && old.property===property && expected==="")) {
            const valid = property==="text" ? typeof expected==="string" && expected.length<=4096 : ["true","false"].includes(expected);
            if (!valid) throw new Error(w("Enter an expected value.","请输入预期值。"));
            input.equals = property==="text" ? expected : expected==="true";
        }
        input.property = property;
    }
    if (mutations.has(command) || command==="wait") {
        if (fields.timeout!==undefined && fields.timeout!=="") input.timeout_ms=integer(fields.timeout,1,60000,
            w("Use a timeout from 1 to 60000 milliseconds.","超时需在 1 至 60000 毫秒之间。"));
        else delete input.timeout_ms;
    }
    const next = {...previous,command,input};
    if (!mutations.has(command)) {
        delete next.before;
        delete next.refresh;
    }
    return next;
}

function gestureDefinition(step) {
    if (step.command!=="deviceGesture" || !step.input || step.input.kind==="unsupported") return;
    const {input} = step, {kind} = input;
    const keys = ["x","y","toX","toY"];
    const fields = Object.fromEntries(keys.filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
    if (kind==="pinch" && Array.isArray(input.fingers)) input.fingers.forEach((finger,index)=>{
        for (const key of keys) if (finger && Object.hasOwn(finger,key)) fields["finger"+(index+1)+"-"+key]=finger[key];
    });
    if (input.velocity!==undefined) fields.velocity=input.velocity;
    return {kind,fields,delay:step.delayMs ?? 0};
}

function buildGesture(previous, fields, w) {
    const gesture = gestureDefinition(previous);
    if (!gesture) return;
    const input = structuredClone(previous.input);
    for (const field of Object.keys(gesture.fields)) {
        const point = /^finger([12])-(\w+)$/.exec(field);
        const velocity = field==="velocity";
        const value = integer(fields.coordinates?.[field],velocity?200:0,velocity?40000:2147483647,
            w("Enter valid gesture coordinates or speed.","请输入有效的手势坐标或速度。"));
        if (point) input.fingers[Number(point[1])-1][point[2]]=value;
        else input[field]=value;
    }
    const delay = integer(fields.delay,0,2147483647,w("Enter a non-negative step delay.","请输入非负的步骤间隔。"));
    if (input.kind==="typeText" && fields.replaceInput===true) input.text=fields.text;
    validateGesture(input);
    const changed = JSON.stringify(input)!==JSON.stringify(previous.input);
    const next = {...previous,input,...((delay || previous.delayMs!==undefined) && {delayMs:delay})};
    if (changed) delete next.label;
    return next;
}

module.exports = {editableCommands,actionDefinition,buildAction,gestureDefinition,buildGesture};
