"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createCopilotAsk } = require("../src/copilotTask");

function host(selectChatModels) {
    return {
        lm: { selectChatModels },
        LanguageModelChatMessage: { User: content => ({ role: "user", content }) },
        CancellationTokenSource: class {
            token = { isCancellationRequested: false };
            cancel() { this.token.isCancellationRequested = true; }
            dispose() { this.token.disposed = true; }
        },
    };
}

test("one user-initiated selection serves several turns and reads all response fragments", async () => {
    const requests = [], selectors = [];
    const vscode = host(async selector => {
        selectors.push(selector);
        return [{ async sendRequest(messages, options, token) {
            requests.push({ messages, options, token });
            return { text: (async function* () { yield "first"; yield " second"; })() };
        } }];
    });
    const ask = await createCopilotAsk(vscode, { language: "en" });
    assert.equal(await ask("turn one"), "first second");
    assert.equal(await ask("turn two"), "first second");
    assert.deepEqual(selectors, [{ vendor: "copilot" }]);
    assert.deepEqual(requests.map(r => r.messages[0].content), ["turn one", "turn two"]);
    assert.deepEqual(requests[0].options, {});
    assert.ok(requests.every(r => r.token.disposed));
});

test("missing models, refusal and a provider error during streaming have actionable results", async () => {
    await assert.rejects(createCopilotAsk({}, { language: "en" }), /1\.91/);
    await assert.rejects(createCopilotAsk(host(async () => []), { language: "zh-CN" }), /登录 GitHub Copilot/);
    const ask = await createCopilotAsk(host(async () => [{ async sendRequest() {
        return { text: (async function* () { yield "partial"; throw Object.assign(new Error(), { code: "NoPermissions" }); })() };
    } }]), { language: "en" });
    await assert.rejects(ask("summarize"), /model access/);
});

test("stopping a task cancels the in-flight Copilot request and rejects subsequent turns", async () => {
    const controller = new AbortController();
    let token;
    const ask = await createCopilotAsk(host(async () => [{ async sendRequest(_, __, requestToken) {
        token = requestToken;
        return new Promise(() => {});
    } }]), { signal: controller.signal, language: "zh" });
    const pending = ask("inspect");
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(token.isCancellationRequested, true);
    assert.equal(token.disposed, true);
    await assert.rejects(ask("again"), { name: "AbortError" });
});
