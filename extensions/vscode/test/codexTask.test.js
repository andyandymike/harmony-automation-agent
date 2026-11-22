"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const { PassThrough } = require("node:stream");
const { mock, test } = require("node:test");

function loadCodex(run, version = "0.146.0") {
    const original = Module._load;
    const loader = mock.method(Module, "_load", function (name, ...args) {
        if (name !== "node:child_process") return original.call(this, name, ...args);
        return {
            execFile(_file, _args, _options, done) {
                if (version instanceof Error) return done(version);
                done(null, { stdout: "codex-cli " + version });
            },
            spawn(file, argv, options) {
                const child = new EventEmitter();
                for (const key of ["stdin", "stdout", "stderr"]) child[key] = new PassThrough();
                child.kill = signal => { child.killedWith = signal; child.emit("close", 1); };
                if (options.signal) options.signal.addEventListener("abort", child.kill, { once: true });
                setImmediate(() => run(child, argv, options, file));
                return child;
            },
        };
    });
    const target = require.resolve("../src/codexTask");
    delete require.cache[target];
    try { return require(target).askCodex; } finally { loader.mock.restore(); }
}

test("Codex receives only the task via stdin in an ephemeral workspace without device or shell access", async () => {
    let call;
    const ask = loadCodex((child, argv, options) => {
        call = { argv, options, input: child.stdin.read().toString() };
        child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}\n');
        child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"final"}}\n');
        child.stdout.end('{"type":"turn.completed"}\n');
        child.emit("close", 0);
    });
    const prompt = "Review synthetic text: & / $env:TEMP";
    assert.equal(await ask({ prompt, executable: process.execPath }), "final");
    assert.equal(call.input, prompt);
    assert(!call.argv.includes(prompt));
    assert(call.argv.includes("--ignore-user-config"));
    assert(call.argv.includes("--ephemeral"));
    assert(call.argv.includes("read-only"));
    assert(call.argv.includes("features.shell_tool=false"));
    assert.equal(call.options.env.CODEX_EXEC_SERVER_URL, "none");
    assert.equal(call.options.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
    assert.equal(fs.existsSync(call.options.cwd), false);
});

test("a tool event or an incomplete turn cannot return an answer", async () => {
    const action = loadCodex(child => {
        child.stdout.write('{"type":"item.started","item":{"type":"mcp_tool_call"}}\n');
    });
    await assert.rejects(action({ prompt: "x", executable: process.execPath }), { code: "CODEX_TOOL_CALL" });
    const incomplete = loadCodex(child => {
        child.stdout.end('{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}\n');
        child.emit("close", 1);
    });
    await assert.rejects(incomplete({ prompt: "x", executable: process.execPath }), { code: "CODEX_REQUEST_FAILED" });
});

test("stopping a model round aborts the active process and clears its temporary directory", async () => {
    const controller = new AbortController();
    let attempts = 0;
    let cwd;
    const ask = loadCodex((_child, _args, options) => {
        attempts++;
        cwd = options.cwd;
        controller.abort();
    });
    await assert.rejects(ask({ prompt: "x", executable: process.execPath, signal: controller.signal }),
        { name: "AbortError" });
    assert.equal(attempts, 1);
    assert.equal(fs.existsSync(cwd), false);
});

test("a stalled model is killed at sixty seconds and only the same question is retried", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const questions = [];
    const ask = loadCodex(child => {
        questions.push(child.stdin.read().toString());
        if (questions.length === 1) {
            t.mock.timers.tick(59_999);
            assert.equal(child.killedWith, undefined);
            t.mock.timers.tick(1);
            assert.equal(child.killedWith, "SIGKILL");
        } else {
            child.stdout.write('{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n');
            child.stdout.end('{"type":"turn.completed"}\n');
            child.emit("close", 0);
        }
    });
    const prompt = "Summarize the completed device action in this observation.";
    assert.equal(await ask({ prompt, executable: process.execPath }), "done");
    assert.deepEqual(questions, [prompt, prompt]);
});

test("a second timeout ends the request with a specific error and cleans up both attempts", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const dirs = [];
    const ask = loadCodex((child, _argv, options) => {
        dirs.push(options.cwd);
        t.mock.timers.tick(60_000);
        assert.equal(child.killedWith, "SIGKILL");
    });
    await assert.rejects(ask({ prompt: "x", executable: process.execPath }), { code: "CODEX_TIMEOUT" });
    assert.equal(dirs.length, 2);
    for (const dir of dirs) assert.equal(fs.existsSync(dir), false);
});

test("an incompatible Codex version never receives the prompt", async () => {
    const ask = loadCodex(() => assert.fail("unsupported binary was launched"), "0.99.2");
    await assert.rejects(ask({ prompt: "x", executable: process.execPath }), { code: "CODEX_VERSION" });
});

test("a missing executable during the version probe reports a Codex setup error", async () => {
    const missing = Object.assign(new Error("executable not found"), { code: "ENOENT" });
    const ask = loadCodex(() => assert.fail("missing executable was launched"), missing);
    await assert.rejects(ask({ prompt: "x", executable: process.execPath }), { code: "CODEX_NOT_FOUND" });
});
