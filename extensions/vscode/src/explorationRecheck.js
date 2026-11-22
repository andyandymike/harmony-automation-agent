"use strict";

const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { createExploration, runExploration, repeatable } = require("./explorationEngine");
const { runView } = require("./model");

const localize = (lang, en, zh) => /^zh/i.test(lang) ? zh : en;

function canRecheck(finding) {
    return Boolean(finding?.kind === "failure" && finding.plan?.steps?.length && repeatable(finding.plan) &&
        finding.selector && finding.property && finding.expected !== undefined && finding.actual !== undefined &&
        finding.regressionPath);
}

function classify(finding, result, language) {
    const row = result?.receipts?.find(r => r.kind !== "precondition" && r.path === finding.regressionPath &&
        r.property === finding.property && isDeepStrictEqual(r.selector, finding.selector) &&
        isDeepStrictEqual(r.expected, finding.expected));
    const data = row ? { path: row.path, before: row.before, after: row.after,
        expected: row.expected, actual: row.actual, selector: row.selector, property: row.property } : {};
    const passed = row && (row.status === "passed" || row.assertionStatus === "passed" ||
        row.kind === "command" && row.command === "wait" && row.status === "completed");
    const failed = row && (row.status === "failed" || row.assertionStatus === "failed");
    if (result?.status === "failed" && failed && isDeepStrictEqual(row.actual, finding.actual)) {
        return { status:"reproduced", ...data };
    }
    if (result?.status === "completed" && passed && isDeepStrictEqual(row.actual, finding.expected)) {
        return { status:"passed", ...data };
    }
    return { status:"inconclusive", ...data, reason:result?.error || localize(language,
        "The run did not establish the same check and outcome.", "本次运行未得到同一断言的可比结果。") };
}

async function recheckFinding({ report, findingId, device, agent, signal, onUpdate = async () => {}, workbenchSession, prepareRuleGroup }) {
    const lang=report.language, local=(en,zh)=>localize(lang,en,zh);
    const finding=report.findings.find(f=>f.id===findingId);
    if (!canRecheck(finding) || !["completed","stopped","blocked"].includes(report.status)) {
        throw new Error(local("This finding has no repeatable assertion to retest.", "这项发现没有可独立复测的断言。"));
    }
    const append = async (attempt, result) => {
        const row = { id:attempt.id, startedAt:attempt.startedAt, endedAt:new Date().toISOString(),
            ...(attempt.ruleGroup && {ruleGroup:attempt.ruleGroup}),
            ...(attempt.runId && { runId:attempt.runId }), ...result };
        (finding.retests ||= []).push(row);
        delete finding.pendingRetest;
        await onUpdate(report);
        return row;
    };

    if (finding.pendingRetest) {
        // A re-open after a host interruption only reads the original run ID.
        const pending=finding.pendingRetest;
        let recorded;
        if (pending.runId) {
            try { recorded=await agent.call("report",{ run_id:pending.runId,full:true }); }
            catch (error) {
                if (!["RUN_NOT_FOUND","NO_RUN"].includes(error.code)) throw error;
            }
        }
        const receipt = recorded && runView(recorded);
        if (receipt) {
            const raw=recorded.receipts || recorded.result?.steps || [];
            receipt.steps.forEach((r,i)=>{r.assertionStatus=(raw[i]?.result || raw[i]?.error?.details)?.assertion?.status;});
        }
        await agent.call("detach",{session:"vscode-explore-"+pending.id});
        return append(pending, classify(finding,receipt && {status:recorded.result?.status || recorded.status,receipts:receipt.steps},lang));
    }

    if (!device || device !== report.device) throw new Error(local("Select the original phone before retesting.", "请选中原探索设备再复测。"));
    const attempt={id:randomUUID(),startedAt:new Date().toISOString()};
    const origin=report.pages.find(p=>p.states.some(s=>s.id===report.initialStateId));
    const state=origin?.states.find(s=>s.id===report.initialStateId);
    const anchors=(state?.entries || []).map(e=>e.input?.target).filter(Boolean);
    const hasConditions=Boolean(finding.plan.preconditions?.length);
    if (!report.bundle || (!hasConditions && (!state?.complete || !anchors.length))) {
        return append(attempt,{status:"inconclusive",reason:local("The original starting state lacks a verifiable control or precondition.",
            "探索起点缺少可以核对的稳定控件或前置条件。")});
    }
    const replay=createExploration({id:attempt.id,device,mode:"flow",goal:finding.title,language:lang,
        bundle:report.bundle,maxInputs:report.maxInputs,maxMinutes:report.maxMinutes});
    if (origin && state) {
        replay.currentStateId=state.id;
        replay.currentPage=origin.label;
        replay.pages=[{id:origin.id,label:origin.label,route:origin.route,states:[{id:state.id,label:state.label,complete:state.complete,entries:[]}]}];
    }
    finding.pendingRetest=attempt;
    await onUpdate(report);
    let outcome;
    await runExploration({report:replay,agent,signal,workbenchSession,drive:async ctx=>{
        // The native plan also evaluates all authored preconditions before its first input.
        if (!hasConditions && !ctx.current.entries.some(e=>anchors.some(t=>isDeepStrictEqual(t,e.input?.target)))) {
            ctx.stop("blocked",local("Restore the original screen and its controls before retrying.", "请先恢复原始页面及其控件。"));
        }
        if (report.mockScenario) {
            ctx.guard();
            const applied = await prepareRuleGroup?.(report.mockScenario);
            if (!applied) ctx.stop("blocked",local("The recorded rule group could not be restored.","未能恢复发现问题时使用的规则组。"));
            attempt.ruleGroup = applied.name || local("Unnamed rule group","未命名规则组");
            await onUpdate(report);
            ctx.guard();
        }
        const completed=await ctx.run(finding.plan,{key:"retest",phase:"retest",label:finding.title});
        outcome=classify(finding,completed,lang);
    },onUpdate:async run=>{
        if (run.pending?.runId && attempt.runId !== run.pending.runId) {
            attempt.runId=run.pending.runId;
            await onUpdate(report);
        }
    }});
    return append(attempt,outcome || {status:"inconclusive",reason:replay.reason});
}

module.exports = { canRecheck, recheckFinding };
