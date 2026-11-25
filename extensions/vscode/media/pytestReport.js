import {escapeHtml as html} from "./ui/controls.js";

export function pytestPhases(run, language) {
    const report = run?.pytest;
    if (!report) return "";
    const w = (en, zh) => /^zh/i.test(language) ? zh : en;
    const titles = {collection:w("Collection","收集用例"), setup:w("Setup","测试准备"), call:w("Test","执行测试"),
        teardown:w("Teardown","测试清理"), interrupted:w("Interrupted","运行中断"), pytest:"pytest"};
    const states = {passed:w("Passed","通过"), failed:w("Failed","失败"), skipped:w("Skipped","跳过")};
    const problems = report.phases.filter(p => p.outcome !== "passed");
    const severalTests = new Set(report.phases.filter(p => p.phase === "setup").map(p => p.node)).size > 1;
    const phases = report.phases.map((p,i) => {
        const label = (titles[p.phase] || p.phase) + " · " + (states[p.outcome] || p.outcome);
        const node = severalTests && p.node ? `<small>${html(p.node)} · </small>` : "";
        return p.message ? `<li><details id="pytest-phase-${i}"><summary>${node}${html(label)}</summary><pre class="ai-answer">${html(p.message)}</pre></details></li>` :
            `<li>${node}${html(label)}${p.durationMs ? " · " + html(p.durationMs) + " ms" : ""}</li>`;
    }).join("");
    let note = report.launchError;
    if (!note && report.code === 5) note = w("pytest collected no tests.", "pytest 没有收集到测试用例。");
    if (!note && report.code === 4 && !report.phases.some(p => p.message)) note = w("pytest rejected the invocation or project configuration. See the task terminal.",
        "pytest 启动参数或项目配置有误，请查看任务终端。");
    if (!note && !report.recorded) note = w("pytest did not produce a phase report. See the task terminal for startup output.",
        "pytest 未返回阶段报告，请在任务终端查看启动输出。");
    if (!note && report.code === 0 && run.status === "unknown") note = w("pytest exited without executing a test body.", "pytest 已退出，未记录执行测试主体。");
    if (!note && report.executionCount > 1) note = w("This file produced several device runs. Consult the per-run artifacts for each timeline.",
        "该文件产生了多次设备运行，可在各自的证据目录查看步骤。");
    if (!note && report.executionCount === 1 && !report.fullEvidence) note = w("Full step evidence is unavailable for this run.", "这次运行的完整步骤证据不可用。");
    const code = Number.isInteger(report.code) ? w("Exit code ", "退出码 ") + report.code : "";
    const first = problems.find(p => p.outcome === "failed") || problems[0];
    const reason = first?.reason?.split("\n")[0] || first?.message?.trim().split("\n").at(-1);
    const failure = first ? `<p class="ai-answer"><strong>${html(titles[first.phase] || first.phase)} · ${html(states[first.outcome] || first.outcome)}</strong>${reason ? "  "+html(reason.slice(0,240)) : ""}</p>` : "";
    return `<section class="plan-preview pytest-phases"><h2>${w("pytest result","pytest 结果")}</h2>
        ${failure}${note ? `<p>${html(note)}</p>` : ""}${phases ? `<details id="pytest-test-phases"><summary>${w("Test phases","查看测试阶段")}${code ? " · "+html(code):""}</summary><ul>${phases}</ul></details>` : html(code)}</section>`;
}
