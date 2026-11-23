"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { getMcpLaunch } = require("./aiIntegration");

function taskContext(workbench, surface) {
    const { state, text } = workbench;
    const testing = surface !== "live" && (state.tool ?? "recordings") === "recordings";
    const run = testing && state.mode === "run" && !state.draft ? state.run : undefined;
    if (run?.entry) {
        const step = run.steps?.[run.selected];
        if (run.entry.source === "device") {
            const steps = run.steps || [];
            const start = Math.max(0, (run.selected || 0) - 3);
            const receipts = steps.slice(start, start + 7).map(s => ({ step: s.path, action: s.command, status: s.status }));
            return { task: text.aiReportTask, hint: text.aiGestureHint, evidence: {
                status: run.entry.status, totalSteps: steps.length, steps: receipts, selectedStep: step?.path,
            } };
        }
        return { task: text.aiReportTask, hint: text.aiReportHint, evidence: {
            run_id: run.entry.id, status: run.entry.status, step: step?.path, frame_id: step?.[run.phase],
        } };
    }
    if (testing && state.draft) {
        const steps = state.draft.steps;
        return { task: text.aiDraftTask, hint: state.recording ? text.aiRecordingHint : undefined, evidence: {
            location: state.draft.location, stepFormat: state.draft.stepFormat, totalSteps: steps.length,
            recentActions: steps.slice(-8).map(s => s.input?.kind || s.command),
        } };
    }
    if (testing && state.mode === "workflow" && !state.draft && state.plan) {
        return { task: text.aiPlanTask, evidence: { plan: state.plan.uri } };
    }
    return { task: state.device ? text.aiPageTask : text.aiDevicesTask,
        hint: state.recording ? text.aiRecordingHint : undefined,
        evidence: state.device ? { device: state.device } : undefined };
}

async function codexProject(vscode, workbench) {
    const configured = workbench.config.get("codexProjectPath");
    if (configured) {
        if (!path.isAbsolute(configured) || !(await fs.stat(configured).catch(() => undefined))?.isDirectory()) {
            throw new Error(workbench.text.aiBadProject);
        }
        return configured;
    }
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 1 && folders[0].uri.scheme === "file") return folders[0].uri.fsPath;
    const chosen = await vscode.window.showOpenDialog({ title: workbench.text.aiProject,
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
    return chosen?.[0]?.scheme === "file" ? chosen[0].fsPath : undefined;
}

async function askAI(vscode, workbench, surface) {
    const t = workbench.text;
    const host = await vscode.window.showQuickPick([
        { id: "codex", label: "Codex", description: t.aiCodex },
        { id: "copilot", label: "GitHub Copilot", description: t.aiCopilot },
        { id: "config", label: t.aiConfig, description: t.aiConfigHint },
    ], { title: t.aiButton, placeHolder: t.aiHost });
    if (!host) return;
    if (host.id === "config") {
        const { command, args } = await getMcpLaunch(workbench);
        const config = ["[mcp_servers.harmony]", "command = " + JSON.stringify(command),
            "args = " + JSON.stringify(args)].join("\n");
        await vscode.env.clipboard.writeText(config);
        void vscode.window.showInformationMessage(t.aiConfigCopied);
        return;
    }
    const context = taskContext(workbench, surface);
    const task = await vscode.window.showInputBox({ title: host.label, prompt: t.aiTask, value: context.task });
    if (!task?.trim()) return;
    const prompt = [task.trim(), t.aiTools, context.hint,
        context.evidence && JSON.stringify(context.evidence)].filter(Boolean).join("\n");
    const project = host.id === "codex" ? await codexProject(vscode, workbench) : undefined;
    if (host.id === "codex" && !project) return;
    try {
        if (host.id === "copilot") {
            await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt, isPartialQuery: true });
            return;
        }
        // Keep the encoded query intact through VS Code's external opener, including '&' in user text.
        const link = "codex://new?path=" + encodeURIComponent(project) + "&prompt=" + encodeURIComponent(prompt);
        if (await vscode.env.openExternal(link)) return;
    } catch {
        // The OS may have no Codex handler, or the editor may have disabled Chat.
    }
    if (await vscode.window.showWarningMessage(t.aiUnavailable, t.aiCopy) === t.aiCopy) {
        await vscode.env.clipboard.writeText(prompt);
    }
}

module.exports = { askAI, taskContext };
