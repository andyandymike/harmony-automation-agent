"use strict";

const path = require("node:path");
const {spawn} = require("node:child_process");
const {createInterface} = require("node:readline");
const {getMcpLaunch} = require("./aiIntegration");
const {planWithRuleCheckpoints} = require("./caseRuleSteps");

function launchWorker(interpreter, request, onEvent, env) {
    const child = spawn(interpreter, ["-u", path.join(__dirname, "flowDebugWorker.py")], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: env && { ...process.env, ...env },
    });
    let result, failure, details = "";
    child.stderr.setEncoding("utf8").on("data", data => { details = (details + data).slice(-4000); });
    const lines = createInterface({ input: child.stdout });
    const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
        lines.on("line", line => {
            try {
                const event = JSON.parse(line);
                if (event.type === "complete" || event.type === "error") {
                    result = event;
                    child.stdin.end();
                } else onEvent(event);
            } catch (error) {
                failure = error;
                child.stdin.end();
            }
        });
        child.on("close", code => {
            if (failure) reject(failure);
            else if (result?.type === "error") reject(Object.assign(new Error(result.message), { code: result.code }));
            else if (code !== 0 || !result) reject(new Error(details.trim() || "Debug worker exited without a result."));
            else resolve(result);
        });
    });
    const write = value => {
        if (child.stdin.writable && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(value) + "\n");
    };
    write(request);
    return { done, write };
}

function launchWorkflow(launch, interpreter, request, {plan,switches}, scope, onEvent=()=>{}) {
    const active = scope ? switches : new Map();
    const ruleSteps = Object.fromEntries([...active].map(([path,effect])=>
        [path,effect.action==="enable" ? "enableRuleGroup" : "disableRuleGroup"]));
    let stopped = false;
    const worker = launch(interpreter.command,{...request,plan,ruleSteps,hdcPath:interpreter.hdcPath},event=>{
        if (event.type!=="ruleGroup") return onEvent(event);
        if (stopped) return;
        const path = event.path.replace(/\.repeat\.iteration\[\d+\]/g,".repeat.steps");
        let error;
        try {
            if (!active.has(path)) throw new Error("Unknown rule group step.");
            scope.apply(active.get(path));
        } catch (cause) { error=cause.message; }
        worker.write({action:"ruleGroupResult",token:event.token,error});
    },interpreter.env);
    return {...worker,write(message) {
        if (message.action==="stop") stopped=true;
        worker.write(message);
    }};
}

async function runCasePlan(bench, command, request, {scope,signal}={}) {
    const prepared = planWithRuleCheckpoints(request.plan);
    if (!scope || !prepared.switches.size) return bench.agent.call(command,{...request,plan:prepared.plan},{signal});
    signal?.throwIfAborted();
    const interpreter = await getMcpLaunch(bench);
    signal?.throwIfAborted();
    const {session,run_id:runId,plan,...options} = request;
    const worker = launchWorkflow(launchWorker,interpreter,{session,runId,stateDir:bench.stateDir,method:command,options},
        prepared,scope);
    const stop = ()=>worker.write({action:"stop"});
    signal?.addEventListener("abort",stop,{once:true});
    if (signal?.aborted) stop();
    try { return (await worker.done).result; }
    catch (error) {
        if (error.code==="RULE_STEP_CORE_REQUIRED" && /^zh/i.test(bench.language))
            error.message="用例内的规则组步骤需要 Harmony Agent 运行时 0.1.0a10 或更高版本。";
        throw error;
    } finally { signal?.removeEventListener("abort",stop); }
}

module.exports = {launchWorker,launchWorkflow,runCasePlan};
