import { vscode } from "./bridge.js";

const el = id => document.getElementById(id);
const postLive = message => vscode.postMessage({ ...message, channel: "live" });
const goals = new Map();
let state;
let lastTaskStatus;
let lastTaskGoal;

function label(id, value) {
    el(id).querySelector("span").textContent = value;
}

function updateAssistant() {
    const { text: t, task } = state;
    const active = task?.status === "running" || task?.status === "stopping";
    const blocked = Boolean(!state.device || state.draftLocation || state.busy);
    const goal = el("task-goal");
    el("ai-assistant").hidden = !state.device;
    el("task-heading").textContent = t.stationTask;
    el("goal-label").textContent = t.stationGoal;
    goal.placeholder = t.taskExample;
    goal.readOnly = active;
    label("task-read", t.stationRead);
    label("task-run", t.startTask);
    label("task-stop", t.stopTask);
    label("task-save", t.taskReview);
    el("task-provider-settings").textContent = t.stationProviderSettings;
    el("task-read").disabled = blocked;
    el("task-run").disabled = blocked || !goal.value.trim();
    el("task-run").hidden = active;
    el("task-stop").hidden = !active;
    el("task-stop").disabled = task?.status === "stopping";
    el("task-output").hidden = !task;
    if (!task) {
        el("assistant-status").textContent = "";
        lastTaskStatus = lastTaskGoal = undefined;
        return;
    }
    const name = task.provider === "codex" ? "Codex" : "GitHub Copilot";
    const pending = task.waitingForModel === "retry" ? t.modelRetry : t.modelPlanning.replace("{provider}", name);
    const taskStatus = ({
        running: task.waitingForModel ? pending : t.taskRunning, stopping: t.taskStopping,
        done: t.taskDone, cancelled: t.taskCancelled, error: t.taskError, blocked: t.taskError,
    })[task.status];
    el("result-title").textContent = active ? t.stationTaskProgress : t.stationTaskResult;
    el("result-goal").textContent = task.goal === t.readPageGoal ? t.stationReadResult : task.goal || "";
    el("task-output").dataset.status = task.status;
    el("task-status").textContent = el("assistant-status").textContent = taskStatus;
    if (lastTaskStatus !== task.status || lastTaskGoal !== task.goal) el("ai-assistant").open = true;
    lastTaskStatus = task.status;
    lastTaskGoal = task.goal;
    const list = el("task-steps");
    if (task.steps.length !== list.children.length || task.steps.some((step, i) => list.children[i].textContent !== step)) {
        list.replaceChildren(...task.steps.map(step => {
            const item = document.createElement("li");
            item.textContent = step;
            return item;
        }));
    }
    el("task-answer").textContent = task.answer || "";
    const receipts = task.evidence || [];
    const evidence = el("task-evidence");
    evidence.hidden = !receipts.length;
    if (receipts.length) {
        evidence.querySelector("summary").textContent = t.aiEvidenceRead + " · " + receipts.length;
        evidence.querySelector("div").textContent = [...receipts.map(row=>row.text),t.aiEvidenceScope].join("\n\n");
        const rows = receipts.flatMap(receipt=>receipt.records || []);
        const links = evidence.querySelector("section");
        const key = JSON.stringify([state.language,state.busy,state.draftLocation,rows.map(row=>row.id)]);
        if (links.dataset.key !== key) {
            links.dataset.key = key;
            links.replaceChildren(...[...new Map(rows.map(row=>[row.id,row])).values()].map(row=>{
                const button = document.createElement("button");
                button.type = "button";
                button.className = "rail-link";
                button.disabled = Boolean(state.busy || state.draftLocation);
                button.textContent = t.aiOpenRecord+" · "+row.method+" "+row.route+" · "+row.status;
                button.addEventListener("click",()=>vscode.postMessage({type:"networkEvidenceRecord",id:row.id}));
                return button;
            }));
        }
    } else evidence.open = false;
    el("task-save-scope").hidden = !(receipts.length && task.canSave);
    el("task-save-scope").textContent = t.aiSaveControls;
    el("task-provider-settings").hidden = task.providerSetup !== true;
    el("task-save").hidden = !task.canSave || Boolean(state.draftLocation);
    el("task-save").disabled = Boolean(state.busy || state.caseEditing);
}

export function updateWorkspaceRail(next) {
    const switchedDevice = state?.device !== next.device;
    state = next;
    const connected = next.devices.includes(next.device);
    el("live-task-pane").hidden = next.tool !== "exploration" || !connected;
    if (switchedDevice) {
        el("task-goal").value = goals.get(next.device) || "";
        el("ai-assistant").open = false;
        lastTaskStatus = lastTaskGoal = undefined;
    }
    updateAssistant();
    if (next.focusTask && next.device && !next.draftLocation) {
        el("ai-assistant").open = true;
        el("task-goal").focus();
    }
}

el("task-form").addEventListener("submit", event => {
    event.preventDefault();
    const goal = el("task-goal").value.trim();
    if (goal && !el("task-run").disabled) postLive({ type: "phoneTask", goal });
});
el("task-goal").addEventListener("input", event => {
    if (!state) return;
    goals.set(state.device, event.target.value);
    updateAssistant();
});
el("task-goal").addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") el("task-form").requestSubmit();
});
el("task-read").addEventListener("click", () => postLive({ type: "phoneTask", readOnly: true }));
el("task-stop").addEventListener("click", () => postLive({ type: "cancelAI" }));
el("task-save").addEventListener("click", () => postLive({ type: "reviewTask" }));
el("task-provider-settings").addEventListener("click", () => vscode.postMessage({ type: "aiSettings" }));
