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
    // The Activity Bar needs a view to contribute its icon. The editor owns the tool tabs.
    const view = vscode.window.createTreeView("harmonyAgent.launcher", {
        treeDataProvider: {getChildren: () => [], getTreeItem: item => item},
    });
    function launch() {
        if (!view.visible) return;
        workbench.open();
        void vscode.commands.executeCommand("workbench.action.closeSidebar").then(undefined, error => {
            console.warn("Harmony Agent sidebar cleanup", error);
        });
    }
    const reveal = view.onDidChangeVisibility(({visible}) => {
        if (visible) launch();
    });
    workbench.context.subscriptions.push(view, reveal);
    if (view.visible) launch();
}

module.exports = { workspaceTools, selectedWorkspaceTab, registerWorkbenchLauncher };
