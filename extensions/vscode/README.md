# Harmony Agent for VS Code

[简体中文](README.zh-CN.md)

Operate a connected HarmonyOS phone, inspect the controls on its current screen, or replay a saved workflow from VS Code. Start a recording when you want to repeat a sequence.

## Install

Use desktop VS Code 1.101 or later in a trusted workspace. For a connected phone, run VS Code, Python 3.10+ and the official HDC tools on the same computer. This extension is version `0.20.18` and uses the Python runtime from this repository. Interactive workflow debugging requires runtime `0.1.0a10` or later.

To build from source, clone the [project repository](https://github.com/andyandymike/harmony-automation-agent), install Node.js 22+, and run the following from its root on Windows.

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install .
Set-Location extensions/vscode
npm run package
code --install-extension ./harmony-agent-workbench-0.20.18.vsix
```

On macOS and Linux, use `.venv/bin/python` and `cd extensions/vscode`. If you already have the wheel and VSIX, use `python -m pip install --no-index --no-deps ./harmony_automation_agent-0.1.0a10-py3-none-any.whl` in your chosen environment and install the VSIX with **Extensions → Install from VSIX…**. Node.js is only needed to develop or build the extension.

In VS Code User Settings, set `harmonyAgent.cliPath` to the absolute path of the repository's `.venv/Scripts/harmony-agent.exe` on Windows or `.venv/bin/harmony-agent` on macOS and Linux. Set `harmonyAgent.hdcPath` if HDC is outside PATH. The workbench follows the VS Code display language. Set `harmonyAgent.language` to `en` or `zh-CN` to override it.

### Project runtime

A local project can provide `.harmony-agent/runtime.json` at its workspace root. Its initialization script can populate the four paths for the current machine. Relative paths resolve from the workspace folder that contains `.harmony-agent`. Set `cli` to a script that runs with `python <cli>`.

```json
{
  "version": 1,
  "python": ".venv/Scripts/python.exe",
  "cli": ".harmony-agent/launch.py",
  "src": "src",
  "hdc": "tools/hdc.exe"
}
```

The launch script can call `main()` from `harmony_agent.cli`. Use `.venv/bin/python` and the local HDC path on macOS or Linux. The chosen `src` goes first on the child process's `PYTHONPATH`.

Open the workbench in a trusted window and confirm the runtime. If more than one workspace folder supplies a file, pick the project first. The choice belongs to the current workspace. Use **Harmony Agent: Select Project Runtime…** or the workbench settings menu to change it. A workspace without a project configuration uses the existing settings and PATH discovery. A selected file that becomes invalid or disappears reports an error. Use the same command to return to VS Code settings.

The selected runtime supplies the CLI, Copilot MCP, workflow debugger, device preview, network tools, pytest, and the copied Codex MCP configuration. Saving an updated configuration applies it after any active run or capture. Refresh devices after changing HDC. If you already pasted a Codex MCP configuration, copy it again to pick up changes.

## Open the workbench

Choose **Harmony Agent** in the bottom-left status bar to open the workbench in an editor tab. The current sidebar stays in place. The Command Palette also offers **Harmony Agent: Open Workbench**. The phone preview stays on the left as you switch between **Tests**, **Elements**, **Network**, and **AI exploration**. You can review a saved workflow or import a HAR offline. To use a phone, connect it by USB and allow HDC debugging. The workbench selects a single connected phone automatically. With several phones, choose one at the top.

| What you want to do | Where to go |
|---|---|
| Try something on the phone | Click, double-click, hold, swipe or use the wheel on the live preview. Hold before moving to drag. Use **Ctrl+wheel** or two touchscreen fingers to pinch. Above the preview, use **Back on phone**, **Home**, **Recent apps** or **Keyboard**. |
| Find and operate a control | Open **Elements**. Pick the control in the left screen or search by text or ID. Select a control to inspect its locator, tap it, or use text entry and scrolling where applicable. |
| Replay a saved workflow | In **Tests**, open a local workflow and review its steps. Return the phone to the starting screen, then choose **Replay on phone**. |
| See what happened last time | Open the run history, choose a run, then select a step for its evidence. Saved results are available with the phone disconnected. |

Checked workflows show the result of the check. Coordinate recordings show the phone's receipt for each gesture. A completed run with no final check records that its steps executed.

## Inspect elements, debug a workflow and inspect network activity

In **Elements**, use **Pick element** above the left screen to select a control in the snapshot. Its parents, properties and editable locator appear on the right. Refresh the snapshot to test the locator on a new frame. Pin a property to track changes, or add an action or assertion to a workflow draft. Switch to **Live phone** to send touches from the preview.

Open a control-based workflow and expand **Run settings & debugging → Breakpoints & step debugging**. While paused you can probe a locator, step into the next operation, continue, or stop. The runner retains variables, branches and loop state. Choose **Export run evidence…** from a step's evidence tools or **Export exploration evidence…** from an exploration report to save offline HTML. The **Harmony Agent: Open Exported Evidence…** command opens it in VS Code.

Open the **Network** tab. Use **Requests** to record native HTTP from a debug app, connect ArkWeb or import a HAR. Filter by method, host or status, search retained headers and bodies, compare exchanges, or edit and resend a request through the local test gateway. In **Mock & rewrite**, organize rewrite rules and response sequences into rule groups. Preview a rule against captured requests, then inspect its effect on new gateway traffic. [Network guide](NETWORK.md)

## Explore an app

Open the **AI exploration** tab or run **Harmony Agent: Explore App** from the Command Palette. Open the app on the selected phone and choose a mode.

- **Explore from here** accepts an optional focus such as “try Settings and Help first.” The assistant chooses among observed controls. The workbench records pages, states, attempted entries and return paths. The initial budget is 20 device inputs or three minutes and can be changed before starting.
- **Explore a flow** accepts the current workflow, a control-based JSON file, or a description of the route and expected result. Review the plan, choose the steps after which to explore, then start. The original flow runs first. Variations reuse its checks and verify the return to the route. For plans with branches, loops or version 2 bindings, exploration starts at the verified endpoint. If your recording uses screen coordinates, choose **Record by control name or ID** to record the route again, or describe it in words.

Pause to take over the phone. To continue, select the same device and restore the expected screen. Closing the workbench pauses an exploration. In **AI Exploration**, expand **Exploration history** to open saved reports offline. **Coverage** shows the entries tried or skipped in each observed state. **Findings** distinguishes failed checks, observations needing review and blocked tests. Open **Action trace** for recorded before/after controls. When a failing route has stable selectors and an explicit expectation, choose **Save regression workflow…** and replay it from the same starting state. Reports and run evidence stay on the computer. Your model provider receives the controls and candidates used for the current decision.

Add a note to an observation needing review, ignore it, or reopen it. For eligible failed checks, return the original device to its starting page and run an independent recheck. The finding records whether the same discrepancy reproduced, the check passed, or the attempt was inconclusive. The original exploration remains available for comparison.

## Record by hand

Above the phone preview, choose **Input location** and **Save as**, then select **Start recording**. The recorded steps appear in **Tests**.

| Where you operate | What you save | What gets recorded |
|---|---|---|
| **Workbench preview** | **Control locators** | Tap and scroll in the preview, use **Keyboard** to fill the focused field, or press **Back on phone**. A control ID or text identifies the target during replay. In review, **Add checks (optional)** can verify a control's visibility or text. |
| **Workbench preview** | **Screen coordinates** | The phone's acknowledged taps, gestures, navigation and **Keyboard** input become replay steps with their timings. |
| **On the phone** | **Screen coordinates** | UiTest captures touches such as taps, long presses and swipes. Recognized back gestures replay as system Back. Use the preview to record text input. |

To send text, first focus the input field in the phone preview, then type or paste into **Keyboard** and send it. **Recent apps** uses the phone's gesture navigation. Pinch requires a device with multi-finger touch injection.

Select **Finish recording** and review the steps. For screen coordinates, remove any unsupported gestures and replay with the same screen size, orientation and layout. Select **Save recording…** to write a JSON file or **Save as test case** to review the BDD steps in execution order.

## Work with test cases

Open **Tests** to find cases saved from a recording or AI exploration. **Open file…** accepts both saved cases and workflow JSON. Select a case name or an editable Given, When or Then row to edit it in place. When a run matches the current workflow, step statuses appear beside those same steps. Select a status to view its evidence. Expand **Case history** to inspect a past run.

Select **Save as test case** while reviewing a recording, or select a reproducible route or finding in an exploration report. Review the actions and expected result before saving. Share the entire new case directory to keep the steps and their origin together. A recording with no final assertion can be saved for replay. Coordinate gestures replay using the recorded device layout.

Each supported BDD role appears beside the step it describes. An assertion can follow a prerequisite directly, and another prerequisite can appear later in the case. Right-click a step and choose **Insert a check after…** to add a check at that point. Select **Organize with AI** to suggest names, groups, and roles, then review before saving. The case metadata travels with `workflow.json`.

Right-click a step to duplicate, delete, reorder, or replace its locator. For a replacement, open the relevant phone page, select **Read current page**, and search for the control.

Choose **Workbench** or **pytest** in the runner selector, then select **Run**. The report shows recorded step status, expected and actual values, and saved frames. **Failure review** identifies the first problem or the failed pytest phase. **Diagnose failure with AI** uses saved evidence to suggest whether to keep the case, verify a locator on a copy, or review the steps and expected result. For a confirmed locator change, open **View failing step** and choose **Find a replacement locator with AI**. Run the suggested change on a copy. When the copy passes the original final assertions, **Apply verified change** updates the case. Both runs remain in the history.

## Add a recording to pytest

After recording by control, choose **Save as test case** and review the steps in execution order. The generated pytest runner requires a starting condition and a final assertion. You can also choose **Generate pytest case** from an existing workflow. Choose a project folder and a new case name. Commit the editable `workflow.json` alongside its `test_*.py`. Coordinate gesture cases replay in the workbench.

Run the following PowerShell commands from the case folder. Collection works offline. Execution needs pytest in your chosen Python environment, a Harmony Agent CLI executable, and the named device connected and at the expected starting screen.

```powershell
python -m pytest --collect-only -q .
$env:HARMONY_DEVICE = "your-device-id"
$env:HARMONY_ARTIFACT_DIR = "$PWD/artifacts"
python -m pytest -v . --junitxml=results.xml
```

Choose **Run test case** on a pytest case to run it against the selected device. With a project runtime selected, install `pytest` into that interpreter. In VS Code settings mode, the workbench uses the active VS Code Python interpreter or `python`. Set `HARMONY_PYTEST_PYTHON` to select an interpreter explicitly in that mode. `HARMONY_AGENT_CLI` and `HARMONY_HDC` accept executable paths. Each run gets its own evidence folder. CLI state is stored there by default. Set `HARMONY_STATE_DIR` to use another location.

The report opens in the workbench and can be reopened from the run history. **Test phases** shows collection errors, setup, test execution and teardown, with failure details. The step timeline shows executed controls and assertions with the available saved pages for both passing and failing runs. A teardown failure marks the case failed even when all device assertions passed. Existing cases generated by 0.16.0 are supported.

An embedded or workspace-bound rule group travels in `workflow.json`. Set `HARMONY_RULE_GROUP_FIXTURE` to a fixture **registered by your project**. The fixture returns a function accepting the keyword arguments `rule_group`, `device` and `state_dir`. That function returns a context manager that prepares the rules and device route on entry and cleans up on exit. Here, the consuming project supplies `project_gateway` and its `route` context manager.

```python
# conftest.py
import pytest

@pytest.fixture
def harmony_route(project_gateway):
    def prepare(*, rule_group, device, state_dir):
        return project_gateway.route(device=device, rules=rule_group, state_dir=state_dir)
    return prepare
```

Use `$env:HARMONY_RULE_GROUP_FIXTURE = "harmony_route"` in the terminal, or enter the fixture name when the workbench asks. A missing fixture fails before device operations.

## Offline work and drafts

In **Tests**, open a local workflow or select a case to view its saved evidence. **Case history** opens earlier reports, and **All runs** lists runs across different cases. Reconnect the intended phone to replay.

Hiding the workbench suspends its screen preview. Returning to the workbench resumes capture if the preview was running. Closing the workbench ends an active recording, cancels the active AI request and stops an active coordinate replay. Reopen the workbench in the same VS Code window to review the recording draft. Use **Save recording…** to keep it on disk before reloading or quitting VS Code.

## Using the AI assistant

In **AI exploration**, expand the AI assistant to enter a goal or ask it to read the current screen. You can follow progress and stop a task while it runs. If it produces reusable control-based steps, review and save them from its result. The assistant can also suggest a check after recording or explain a step in a run. Manual operation, inspection, recording and replay work without a model provider.

## AI provider

Open the workbench’s **Settings** menu and choose **AI provider settings**. The VS Code User setting `harmonyAgent.aiProvider` applies to exploration, phone tasks, recording check suggestions and step explanations.

- **GitHub Copilot** is the default provider for AI commands. Sign in with your Copilot account. If VS Code prompts for model access, allow Harmony Agent to use the model.
- **Codex** requires the local Codex CLI 0.146.0 or later. Run `codex login` if needed, select `codex` in the setting, and set `harmonyAgent.codexPath` if the executable is outside PATH.

The selected provider receives the goal and relevant page controls or run evidence when you request AI assistance.

## Optional external AI chat and MCP

For a separate conversation in Copilot Chat or the Codex desktop app, run **Harmony Agent: Continue in External AI Chat…** from the Command Palette. Choose a provider and review the draft in that chat before sending it.

- **Copilot Chat.** Run **MCP: List Servers**, start **Harmony Agent**, and enable its tools in Chat agent mode. The optional `skills/harmony-agent` folder in the project repository can be copied to the app project's `.github/skills/harmony-agent` directory for device and workflow instructions. [MCP in VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- **Codex desktop.** In the external chat menu, choose **Copy Codex MCP configuration**. Add the generated `[mcp_servers.harmony]` entry to the trusted project's `.codex/config.toml`, then open a new chat there. To send future drafts to that project, set `harmonyAgent.codexProjectPath`. To share saved run evidence across windows, point `harmonyAgent.stateDir` to the same evidence directory. [Codex MCP](https://developers.openai.com/codex/mcp/)

## Develop

Open `extensions/vscode` in desktop VS Code and press F5 to launch the Extension Development Host. The **Harmony Agent: Open Workbench** command uses the CLI set in User Settings or on PATH. Run `npm test` with Node.js 22+ for the offline suite. Install `pytest` in the test interpreter to include the generated case and report tests. Set `HARMONY_TEST_PYTHON` if the interpreter is outside PATH.

Project code is distributed under [MIT](LICENSE). The bundled button and text-field styles retain their [upstream MIT notice](media/ui/vendor/elements-lite/LICENSE).

For new workbench views, use `actionButton` from `media/ui` for standard actions, `vscode-textfield` for single-line text fields, and `tabList` with `tabPanels` for tabs. The extension ships the base control styles and keeps theme overrides in `media/ui/components.css`. Network shows the distinction between segmented workspace navigation and the tabs for a single request. Check opening, acting and returning by keyboard in a narrow editor when changing either pattern.
