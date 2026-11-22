"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareFlow, draftFlow, regressionPlan } = require("../src/explorationFlow");

const target = { bundleName: "example.app", id: "language" };
const rule = { selector: target, property: "text", equals: "English" };
const route = { version: "1", steps: [{ command: "press", input: { target } }, { command: "back" }],
    preconditions: [rule], goals: [rule] };
const page = { nodes: [{ ref: "a", bundleName: "example.app", id: "language", text: "English", visible: true },
    { ref: "b", type: "TextInput", text: "hidden input", editable: true }] };

test("an edited control flow keeps its checks and original zero-based checkpoint boundaries", () => {
    const cleaned = prepareFlow("\uFEFF" + JSON.stringify(route), "zh-CN");
    assert.deepEqual(cleaned.plan, route);
    assert.equal(cleaned.kind, "linear");
    assert.deepEqual(cleaned.checkpoints.map(c => c.index), [0,1]);
    assert.match(cleaned.checkpoints[0].label, /点按.*language/);
    assert.deepEqual(cleaned.defaultCheckpoints, [0]);
    assert.throws(() => prepareFlow("{bad", "zh-CN"), /JSON/);
    assert.throws(() => prepareFlow({ format: "harmony-agent.device-recording", steps: [] }, "en"), /coordinate/i);
});

test("loops and v2 bindings stay intact with only an endpoint checkpoint", () => {
    const v2 = { version: "2", steps: [{ read: { name: "original", selector: target } }, ...route.steps],
        goals: [{ selector: target, equals: { var: "original" } }] };
    const withLoop = { version: "1", steps: [{ repeat: { limit: 2, until: rule, steps: route.steps } }] };
    for (const plan of [withLoop,v2]) {
        const flow = prepareFlow(plan);
        assert.equal(flow.kind, "endpoint");
        assert.deepEqual(flow.defaultCheckpoints, [plan.steps.length-1]);
        assert.deepEqual(flow.plan, plan);
    }
});

test("a natural-language draft grounds the original value and omits editable content", async () => {
    const result = await draftFlow({ description: "Open the language menu and go back without changing the language.",
        observation: page, ask: async prompt => {
            assert.doesNotMatch(prompt, /hidden input/);
            assert.match(prompt, /English/);
            return JSON.stringify(route);
        } });
    assert.deepEqual(result.plan, route);
    const future = { version: "1", steps: [{ command: "press", input: { target: { text: "Details" } } }] };
    assert.deepEqual((await draftFlow({ description: 'Tap "Details"', ask: async () => JSON.stringify(future) })).plan,future);
    const asReturned = { ...route, steps: [{ command: "press", input: { selector: { id: "language" } } }, { command: "back" }] };
    const normalized = await draftFlow({ description: "Open the language selector and return.", observation: page,
        ask: async () => JSON.stringify(asReturned) });
    assert.deepEqual(normalized.plan.steps[0].input, { target });
});

test("inferred identifiers, text expectations, and unreviewable control flow are rejected in AI drafts", async () => {
    const run = plan => draftFlow({ description: "Open the language menu", observation: page, ask: async () => JSON.stringify(plan) });
    await assert.rejects(run({ ...route, goals: [{ ...rule, equals: "not observed" }] }), /could not be matched/);
    await assert.rejects(run({ ...route, steps: [{ command: "press", input: { target: { id: "invented" } } }] }), /could not be matched/);
    await assert.rejects(run({ needs: "What is the exact label?" }), /exact label/);
    const c = new AbortController(); c.abort();
    await assert.rejects(draftFlow({ description: "go", signal: c.signal, ask: () => assert.fail() }), { name: "AbortError" });
});

test("only adopted evidence-backed failures export their own independent regression plan", () => {
    assert.equal(regressionPlan({ kind:"review", plan:route }), undefined);
    assert.equal(regressionPlan({ kind:"failure" }), undefined);
    const result=regressionPlan({ kind:"failure", plan:route });
    result.steps.pop();
    assert.equal(route.steps.length,2);
});
