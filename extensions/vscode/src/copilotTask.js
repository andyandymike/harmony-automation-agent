"use strict";

const messages = {
    unsupported: ["Embedded Copilot requires VS Code 1.91 or newer.", "内嵌 Copilot 需要 VS Code 1.91 或更新版本。"],
    unavailable: ["No Copilot model is available. Sign in to GitHub Copilot in VS Code and check your account’s model access.", "未找到可用的 Copilot 模型。请在 VS Code 登录 GitHub Copilot，并检查账号的模型访问权限。"],
    denied: ["Copilot denied model access. Check the extension’s model access and your organization’s Copilot settings.", "Copilot 拒绝了模型访问。请检查扩展的模型使用权限和组织的 Copilot 设置。"],
    empty: ["Copilot returned an empty response.", "Copilot 返回了空回复。"],
};

async function withCancellation(signal, action, cancel) {
    signal?.throwIfAborted();
    if (!signal) return action();
    let abort;
    const stopped = new Promise((_, reject) => {
        abort = () => { cancel?.(); reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
    });
    try {
        return await Promise.race([action(), stopped]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

async function createCopilotAsk(vscode, { signal, language }) {
    const index = /^zh/i.test(language) ? 1 : 0;
    const error = key => {
        const failure = new Error(messages[key][index]);
        if (key === "unsupported" || key === "unavailable" || key === "denied") {
            failure.code = "COPILOT_" + key.toUpperCase();
        }
        return failure;
    };
    function explain(cause) {
        signal?.throwIfAborted();
        if (cause.code === "NoPermissions" || cause.code === "Blocked") return error("denied");
        if (cause.code === "NotFound") return error("unavailable");
        return cause;
    }

    if (!vscode.lm?.selectChatModels) throw error("unsupported");
    let model;
    try {
        [model] = await withCancellation(signal, () => vscode.lm.selectChatModels({ vendor: "copilot" }));
    } catch (cause) {
        throw explain(cause);
    }
    if (!model) throw error("unavailable");

    return async (prompt, roundSignal) => {
        const source = new vscode.CancellationTokenSource();
        const pendingSignal = roundSignal && signal ? AbortSignal.any([roundSignal, signal]) : roundSignal || signal;
        try {
            return await withCancellation(pendingSignal, async () => {
                const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, source.token);
                let text = "";
                for await (const fragment of response.text) text += fragment;
                if (!text.trim()) throw error("empty");
                return text;
            }, () => source.cancel());
        } catch (cause) {
            throw explain(cause);
        } finally {
            source.dispose();
        }
    };
}

module.exports = { createCopilotAsk };
