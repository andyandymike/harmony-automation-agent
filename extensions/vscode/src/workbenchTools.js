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
    const view = vscode.window.createTreeView("harmonyAgent.launcher", {
        treeDataProvider: {getChildren: () => [], getTreeItem: item => item},
    });
    let opening = false;
    async function revealWorkbench({visible}) {
        if (!visible || opening) return;
        opening = true;
        try {
            // VS Code selects the launcher view first. Return to the project tree before focusing the editor.
            await vscode.commands.executeCommand("workbench.view.explorer");
        } catch (error) {
            console.warn("Harmony Agent could not restore Explorer", error);
        } finally {
            opening = false;
        }
        workbench.open();
    }
    const launcher = vscode.window.createStatusBarItem("harmonyAgent.workbenchLauncher", vscode.StatusBarAlignment.Left);
    launcher.name = "Harmony Agent Workbench";
    launcher.text = "$(device-mobile) Harmony Agent";
    launcher.tooltip = workbench.text.openWorkbench;
    launcher.command = "harmonyAgent.openWorkbench";
    workbench.context.subscriptions.push(view, view.onDidChangeVisibility(revealWorkbench), launcher);
    launcher.show();
    if (view.visible) void revealWorkbench({visible:true});
    return launcher;
}

module.exports = { workspaceTools, selectedWorkspaceTab, registerWorkbenchLauncher };
