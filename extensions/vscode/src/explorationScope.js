"use strict";

const mutations = new Set(["press", "back", "scroll", "fill", "open"]);
const sensitive = /(?:delete|erase|reset|remove|destroy|pay(?:ment)?|purchase|buy|transfer|withdraw|submit|send|confirm|checkout|order now|sign[\s_-]*(?:in|out|up)|log[\s_-]*(?:in|out|off)|\bexit\b|register|authenticate|authorize|allow|install|uninstall|subscribe|unbind|注销|登[录出]|退出|付款|支付|转[帐账]|购买|提交|删除|清除|清空|发送|汇款|取款|确认|同意|授权|注册|卸载|下单|重置|解绑|开启权限)/i;

function restrictedInput(step) {
    if (step.command === "open") return "app";
    if (!mutations.has(step.command)) return;
    let target = step.input?.target;
    if (target?.kind === "selector") target = target.selector;
    if (typeof target === "string") {
        const split = target.indexOf("=");
        target = split > 0 ? {[target.slice(0,split)]:target.slice(split+1)} : undefined;
    }
    if (target && sensitive.test([target.id,target.text,target.description].join(" "))) return "data";
}

module.exports = {mutations,sensitive,restrictedInput};
