import {escapeHtml as html} from "./ui/controls.js";

export function recordingWorkspace(model, t) {
    const connected=!model.deviceDisconnected && model.devices.includes(model.device);
    return `<section class="record-workspace">
        <h1>${html(t.noWorkflow)}</h1>
        <p class="guide-copy">${html(connected ? t.recordFromPreview : t.connectToRecord)}</p>
    </section>`;
}
