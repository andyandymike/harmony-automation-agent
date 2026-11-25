"use strict";

const os = require("node:os");

function suggestedName(value) {
    let stem = String(value || "report").replace(/\.html?$/i, "")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").trim().slice(0, 130).replace(/[. ]+$/, "");
    if (!stem) stem = "report";
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(stem)) stem = "_" + stem;
    return stem + ".html";
}

async function saveReportHtml(vscode, {title, filename, language, build}) {
    const zh = /^zh/i.test(language);
    try {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri || vscode.Uri.file(os.homedir());
        const uri = await vscode.window.showSaveDialog({
            title,
            defaultUri: vscode.Uri.joinPath(folder, suggestedName(filename)),
            filters: {HTML: ["html"]},
            saveLabel: zh ? "导出 HTML" : "Export HTML",
        });
        if (!uri) return;
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: zh ? "正在导出报告…" : "Exporting report…",
        }, async () => {
            const html = await build();
            await vscode.workspace.fs.writeFile(uri, Buffer.from(html, "utf8"));
        });
        const name = uri.path.split("/").pop();
        const message = zh ? "已导出 " + name : "Exported " + name;
        const open = zh ? "打开报告" : "Open report";
        if (uri.scheme === "file") {
            void vscode.window.showInformationMessage(message, open).then(async chosen => {
                if (chosen !== open) return;
                const opened = await vscode.env.openExternal(uri).then(Boolean, () => false);
                if (!opened) void vscode.window.showWarningMessage(zh ? "请在浏览器中打开已导出的文件。" : "Open the exported file in your browser.");
            });
        } else {
            void vscode.window.showInformationMessage(message);
        }
        return uri;
    } catch (error) {
        void vscode.window.showErrorMessage((zh ? "导出报告失败：" : "Report export failed: ") + (error?.message || String(error)));
    }
}

module.exports = {saveReportHtml};
