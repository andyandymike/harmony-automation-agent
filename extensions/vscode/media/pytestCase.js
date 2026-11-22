const messages = {
    zh: {
        create: "生成 pytest 用例", open: "打开测试代码",
        gestures: "坐标手势可在工作台回放。要生成 pytest 用例，请按控件名称或 ID 录制。",
        both: "起始条件和最终断言", start: "起始条件", goal: "最终断言",
        edit: fields => "请编辑流程 JSON，补充" + fields + "后生成 pytest 用例。",
        fixture: "此用例包含网络规则组。运行时需要项目的 pytest fixture 准备网关和设备路由。",
        includeBinding: "生成时会将工作区绑定的规则组写入用例。运行时需要项目 fixture 准备网关和设备路由。",
        pendingBinding: "当前规则组仅绑定在工作区。生成新用例可将它写入流程文件。",
        missingGroup: "请在 workflow.json 中恢复此用例需要的规则组快照。",
        invalid: "请打开包含控件步骤的有效流程 JSON。",
        terminal: "在用例目录设置 HARMONY_DEVICE 后运行", binding: "为当前绑定重新生成用例",
        result: code => code === 0 ? "最近一次 pytest 运行通过。" : code === undefined ? "pytest 已结束，退出状态未知。请查看任务终端。" : "最近一次 pytest 未通过。请在任务终端查看失败原因和证据路径。",
    },
    en: {
        create: "Generate pytest case", open: "Open test code",
        gestures: "Replay coordinates in the workbench. Record by control name or ID to generate a pytest case.",
        both: "a starting precondition and a final assertion", start: "a starting precondition", goal: "a final assertion",
        edit: fields => "Edit the workflow JSON and add " + fields + " to generate a pytest case.",
        fixture: "This case includes a network rule group. Running it needs a project pytest fixture to prepare the gateway and device route.",
        includeBinding: "Generation includes the workspace-bound rule group. A project fixture must prepare the gateway and device route when running.",
        pendingBinding: "The current group is bound in this workspace. Generate a new case to include it in the workflow file.",
        missingGroup: "Restore this case’s required rule group snapshot in workflow.json.",
        invalid: "Open a valid workflow JSON file with control-based steps.",
        terminal: "Set HARMONY_DEVICE and run in the case folder", binding: "Generate case with current binding",
        result: code => code === 0 ? "Last pytest run passed." : code === undefined ? "Pytest ended without an exit status. See the task terminal." : "Last pytest run did not pass. See the task terminal for the failure and evidence path.",
    },
};

const words = language => /^zh/i.test(language) ? messages.zh : messages.en;

export function pytestWorkflow(model, language, button, escape) {
    const t = words(language);
    if (!model.planSummary || model.planSummary.error) return "";
    const availability = model.pytestReadiness;
    const issue = availability?.issue;
    const entry = model.pytestCase;
    const bound = availability?.workspaceBinding;
    let note = "";
    if (issue === "gestures" || issue === "invalid") note = t[issue];
    else if (issue) note = t.edit(t[issue]);
    const missingGroup = entry?.requiresRuleGroup && !availability?.ruleGroup;
    const groupNote = bound ? (entry ? t.pendingBinding : t.includeBinding) : missingGroup ? t.missingGroup : availability?.ruleGroup ? t.fixture : "";
    if (groupNote) note += (note ? " " : "") + groupNote;
    let actions;
    if (entry) {
        actions = button(t.open, "openPytest");
        if (bound) actions += button(t.binding, "createPytest", {off: Boolean(issue)});
    } else actions = button(t.create, "createPytest", {off: Boolean(issue)});
    const terminal = entry && !(issue || bound || missingGroup) ? '<p class="guide-copy">' + t.terminal + ' <code>python -m pytest -v ' + escape(entry.filename) + '</code></p>' : '';
    const outcome = entry && model.pytestOutcome?.uri === model.plan.uri ? '<p role="status">' + t.result(model.pytestOutcome.code) + '</p>' : '';
    return '<section class="plan-preview"><h2>pytest</h2><div class="toolbar">' + actions + '</div>' + outcome +
        (note ? '<p class="guide-copy">' + note + '</p>' : '') + terminal + '</section>';
}
