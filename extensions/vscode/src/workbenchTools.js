"use strict";

const workspaceTools = new Map([
    ["recordings", {label:"workbenchTests", command:"harmonyAgent.recordings"}],
    ["inspect", {label:"workbenchElements", command:"harmonyAgent.inspect"}],
    ["network", {label:"netTitle", command:"harmonyAgent.network"}],
    ["exploration", {label:"toolExplore", command:"harmonyAgent.exploration"}],
]);

function selectedWorkspaceTab(state) {
    return workspaceTools.has(state.tool) ? state.tool : "recordings";
}

function registerWorkbenchLauncher(vscode, workbench) {
    const launcher = vscode.window.createStatusBarItem("harmonyAgent.workbenchLauncher", vscode.StatusBarAlignment.Left);
    launcher.name = "Harmony Agent Workbench";
    launcher.text = "$(device-mobile) Harmony Agent";
    launcher.tooltip = workbench.text.openWorkbench;
    launcher.command = "harmonyAgent.openWorkbench";
    workbench.context.subscriptions.push(launcher);
    launcher.show();
    return launcher;
}

module.exports = { workspaceTools, selectedWorkspaceTab, registerWorkbenchLauncher };
