# Harmony Agent for VS Code

[简体中文](README.zh-CN.md)

Operate a connected HarmonyOS phone, inspect the controls on its current screen, or replay a saved workflow from VS Code. Start a recording when you want to repeat a sequence.

## Install

Use desktop VS Code 1.101 or later in a trusted workspace. For a connected phone, run VS Code, Python 3.10+ and the official HDC tools on the same computer. This extension is version `0.20.33`. Workflows combining gestures and control steps require runtime `0.1.0a11` or later. Interactive workflow debugging requires at least `0.1.0a10`.

To build from source, clone the [project repository](https://github.com/andyandymike/harmony-automation-agent), install Node.js 22+, and run the following from its root on Windows.

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install .
Set-Location extensions/vscode
npm run package
code --install-extension ./harmony-agent-workbench-0.20.33.vsix
```

On macOS and Linux, use `.venv/bin/python` and `cd extensions/vscode`. If you already have the wheel and VSIX, use `python -m pip install --no-index --no-deps ./harmony_automation_agent-0.1.0a11-py3-none-any.whl` in your chosen environment and install the VSIX with **Extensions → Install from VSIX…**. Node.js is only needed to develop or build the extension.

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

Open the workbench in a trusted window and confirm the runtime. If more than one workspace folder supplies a file, pick the project first. The choice belongs to the current workspace. Use **Harmony Agent: Select Project Runtime** or the workbench settings menu to change it. A workspace without a project configuration uses the existing settings and PATH discovery. A selected file that becomes invalid or disappears reports an error. Use the same command to return to VS Code settings.

The selected runtime supplies the CLI, Copilot MCP, workflow debugger, device preview, network tools, pytest, and the copied Codex MCP configuration. Saving an updated configuration applies it after any active run or capture. Refresh devices after changing HDC. If you already pasted a Codex MCP configuration, copy it again to pick up changes.

## Open the workbench

Select **Harmony Agent** in the Activity Bar to open the editor workbench with Explorer showing the project tree. To keep another sidebar view in place, use **Harmony Agent** in the status bar or **Harmony Agent: Open Workbench** in the Command Palette. The Explorer toolbar phone icon also opens the workbench. The phone preview stays on the left as you switch between **Tests**, **Elements**, **Network**, and **AI exploration**. You can review a saved workflow or import a HAR offline. To use a phone, connect it by USB and allow HDC debugging. The workbench selects a single connected phone automatically. With several phones, choose one at the top.

| What you want to do | Where to go |
|---|---|
| Try something on the phone | Click, double-click, hold, swipe or use the wheel on the live preview. Hold before moving to drag. Use **Ctrl+wheel** or two touchscreen fingers to pinch. Above the preview, use **Back on phone**, **Home**, **Recent apps** or **Keyboard**. |
| Find and operate a control | Open **Elements**. Pick the control in the left screen or search by text or ID. Select a control to inspect its locator, tap it, or use text entry and scrolling where applicable. |
| Replay a saved workflow | In **Tests**, open a local workflow and review its steps. Return the phone to the starting screen, then choose **Replay on phone**. |
| See what happened last time | Open the run history, choose a run, then select a step for its evidence. Saved results are available with the phone disconnected. |

Checked workflows show the result of the check. Coordinate recordings show the phone's receipt for each gesture. A completed run with no final check records that its steps executed.

## Inspect elements, debug a workflow and inspect network activity

In **Elements**, use **Pick element** above the left screen to select a control in the snapshot. Its parents, properties and editable locator appear on the right. Refresh the snapshot to test the locator on a new frame. Pin a property to track changes, or add an action or assertion to a workflow draft. Switch to **Live phone** to send touches from the preview.

In Elements, **Open app** and **Screenshot** are in the top-right **Settings** menu. Use **Disconnect** above the phone screen to release the workbench session and clear the live preview and the current control tree. **Reconnect** resumes the phone screen or refreshes the Elements snapshot in the current mode.

Open a control-based workflow and expand **Run settings & debugging → Breakpoints & step debugging**. While paused you can probe a locator, step into the next operation, continue, or stop. The runner retains variables, branches and loop state. Choose **Export run evidence** from a step's evidence tools or **Export exploration evidence** from an exploration report to save offline HTML. The **Harmony Agent: Open Exported Evidence** command opens it in VS Code.

Open the **Network** tab. Use **Requests** to record native HTTP from a debug app, connect ArkWeb or import a HAR. Filter by method, host or status, search retained headers and bodies, compare exchanges, or edit and resend a request through the local test gateway. In **Mock & rewrite**, organize rewrite rules and response sequences into rule groups. Preview a rule against captured requests, then inspect its effect on new gateway traffic. [Network guide](NETWORK.md)

## Explore an app

Open the **AI exploration** tab or run **Harmony Agent: Explore App** from the Command Palette. Open the app on the selected phone and choose a mode.

- **Explore the current screen** accepts an optional focus such as “try Settings and Help first.” The assistant chooses among observed controls. The workbench records pages, states, attempted entries and return paths. The initial budget is 20 device inputs or three minutes and can be changed before starting.
- **Explore a case’s other paths**. In AI Exploration, choose a case and a starting point, either the start of the case or immediately after a step. You can also right-click a step in Tests. You can choose the case and position offline. Once started, the script runs through that position, then AI reads the controls on the resulting screen and tries up to two alternative routes. The position list explains any replay limits.

Pause to take over the phone. To continue, select the same device and restore the expected screen. Closing the workbench pauses an exploration. In **AI Exploration**, expand **Exploration history** to open saved reports offline. **Coverage** shows the entries tried or skipped in each observed state. **Findings** distinguishes failed checks, observations needing review and blocked tests. Open **Action trace** for recorded before/after controls. When a failing route has stable selectors and an explicit expectation, choose **Save regression workflow** and replay it from the same starting state. Reports and run evidence stay on the computer. Your model provider receives the controls and candidates used for the current decision.

The case exploration report shows whether the script reached the starting point and which alternatives were tried. Choose **Preview as a new case** on a recorded branch to review the retained steps and the action taken. Give it a name and save it as a separate case. The new case contains only the path that actually ran. You can add a note to an observation, ignore it, or reopen it. For eligible failed checks, return the original device to its starting page and run an independent recheck.

## Record by hand

Select **Start recording** above the phone preview. Touch the phone or click the preview to set this recording's input source. The recorder uses that source until you finish. If phone touch capture is unavailable, record in the preview. Recorded steps appear in **Tests**.

Taps that uniquely match a control are saved by locator. Other supported gestures are saved by screen position. UiTest can provide touch-time control information from API 20. A workflow with both kinds of steps requires runtime `0.1.0a11` or later.

To send text, first focus the input field in the phone preview, then type or paste into **Keyboard** and send it. **Recent apps** uses the phone's gesture navigation. Pinch requires a device with multi-finger touch injection.

Select **Finish recording** and review the steps. For screen coordinates, remove any unsupported gestures and replay with the same screen size, orientation and layout. Select **Save recording** to write a JSON file or **Save as test case** to review the BDD steps in execution order.

## Work with test cases

Open **Tests** to find cases saved from a recording or AI exploration. **Open file** accepts both saved cases and workflow JSON. Select a case name or an editable Given, When or Then row to edit it in place. When a run matches the current workflow, step statuses appear beside those same steps. Select a status to view its evidence. Expand **Case history** to inspect a past run.

Select **Save as test case** while reviewing a recording, or select a reproducible route or finding in an exploration report. Review the actions and expected result before saving. Share the entire new case directory to keep the steps and their origin together. A recording with no final assertion can be saved for replay. Coordinate gestures replay using the recorded device layout.

Select **New case** to start with an empty step list. Choose **Insert step → Insert a check** at the desired position. The same form works at the beginning, middle and end of the case. **Organize with AI** uses the case goal, existing checks, and any recorded page context to suggest names, groups, and BDD roles. Review the suggestions before saving.

In lists with batch actions, click **Select multiple** or hold the left mouse button on a row. Checking an item displays its details. Unchecking the item on display returns to the last one still checked. Ctrl-click (Cmd-click on macOS) toggles an item and Shift-click selects a range. **Select all** covers the current list or filter results. **Clear selection** keeps selection mode open. Switching tabs, changing filters or starting another task exits selection mode.

The selection toolbar and the context menu on a selected step offer **Save section**, **New case from selected steps**, and **Delete selected**. Selecting all in a case includes its starting conditions and final assertions. A section saves the selected steps from one sequence in workflow order. Deletions stay in the case draft and **Undo deletion** restores the whole selection.

Double-click a step or choose **Edit step** to change its name, BDD role, description and group. Expand **Execution settings** to change its action or checks. To choose a locator, open the relevant phone page and select **Pick on screen**. Click the highlighted control, or right-click to choose among overlapping controls. **Read current page** opens the searchable control list. Choose **Apply to draft** for the current step, then **Save case changes** when you finish editing. Right-click a row or choose **⋯** to see the step name and its editing, duplication and reuse commands. Right-click between two steps or at the end of the list to add steps at that position or start a new case there. Click the divider to open the insertion options.

When a new case has the same name as an existing folder, it is saved in a separate folder with a numeric suffix. Removing a case from the library keeps its files on disk.

Choose **Workbench** or **pytest** in the runner selector, then select **Run**. In the failure report, expand **Original failure evidence** to see the saved page and related requests. **Analyze failure with AI** can suggest a locator, a wait, or a navigation step. For a locator failure with insufficient evidence, bring the phone to the relevant screen and choose **Use current phone screen to analyze**. **Try repair** shows progress and **Trial details** in the original report. The trial starts at the beginning of the case and checks the step that failed. Once that step passes, select **Apply to case** to save the change. Use **Run current case** to check the whole case. For a missing test upstream, try the address in the report and select **Save test upstream** after the request reaches it. Expand **Repair change** to open the case editor when you want to adjust a proposed workflow change yourself.

### Reuse a case or extend it with exploration

Point between steps and click the insertion line. You can also right-click a step to choose its insertion side. At the beginning, between steps, or at the end, choose **Write a step description** or **Reference a case**. Descriptions can be saved as a draft alongside existing steps and references. Choose **Generate steps** on a pending row to open AI Exploration at that position. Replay the preceding executable steps or bring the phone to the starting page. Review the proposed actions and assertions, then apply them to the row. The original description remains visible and its executable steps can be expanded. Generate all pending steps before running the case or exporting it to pytest.

Find a reference source by name, step or tag. Expand **Preview steps** to inspect it before inserting the reference. To reuse a sequence, choose **Save a reusable section** on any step in that sequence. Select the **First step** and **Last step** and review the included steps before saving. When a coordinate recording gains control actions or checks, the combined workflow preserves the recorded coordinates and delays and runs in one device session.

For an AI-assisted change, right-click the step and choose **Revise with AI**. Enter your feedback and review the proposed actions and checks at that position before applying them.

Use **Case feedback** for changes that span the workflow. Add all step feedback and insertion descriptions to the draft, then choose **Explore the whole draft**. Exploration follows the updated order in one phone session. Review the combined changes and choose **Verify the full replay** from the case’s starting state. Save the verified plan with **Save as a replayable version**. For a pending change inside a branch or loop, first generate its steps from the phone page where it runs.

A reference runs its saved steps at the insertion point. **References** can filter updates and missing sources, and **Where used** lists saved callers. Case identity follows the source metadata when a case is renamed or moved. Use **Review update** to inspect differences, verify a copy, and adopt a new version. If a source is unavailable, its saved steps can still run. You can locate the same case, replace the reference, or convert it to local steps.

To extend the current case, choose **Add steps to this case with AI** at the insertion point. Describe what to do or verify, then choose **Replay and explore**. The workbench replays the script up to that point and follows your goal on the device. Review the new steps and insert them into the draft. Any original steps after that position follow the insertion. Run the case when you want to check that the rest still passes.

To start a separate draft, choose **New case from here → Copy the steps up to here**. You can rename the new case, edit the copied steps, and add its own actions and assertions. To copy individual steps, select the top-level rows you want, including any starting conditions and final checks, then choose **New case from selected steps**. They keep their original order. To include a condition, loop, description, or reference with its contents, select the whole row. Choose **Explore other paths** when you want the device to try alternative routes from a checkpoint.

Save both `workflow.json` and its `.harmony-case.json` metadata with the project. Workbench replays coordinate cases and runs control cases. Standalone pytest runs the expanded `workflow.json` for control cases with a generated test. Edit composed cases in Workbench to preserve their reference layout.

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

In **Tests**, insert **Enable rule group** and **Turn off rule group** steps at the positions where the gateway should switch during a workbench run. The enable step saves the selected snapshot in `workflow.json`. For pytest cases with a rule group configured for the entire run, configure the project's rule group fixture. Set `HARMONY_RULE_GROUP_FIXTURE` to a fixture **registered by your project**. The fixture returns a function accepting the keyword arguments `rule_group`, `device` and `state_dir`. That function returns a context manager that prepares the rules and device route on entry and cleans up on exit. Here, the consuming project supplies `project_gateway` and its `route` context manager.

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

Hiding the workbench suspends its screen preview. Returning to the workbench resumes capture if the preview was running. Closing the workbench ends an active recording, cancels the active AI request and stops an active coordinate replay. Reopen the workbench in the same VS Code window to review the recording draft. Use **Save recording** to keep it on disk before reloading or quitting VS Code.

## Using the AI assistant

In **AI exploration**, expand the AI assistant to enter a goal or ask it to read the current screen. You can follow progress and stop a task while it runs. If it produces reusable control-based steps, review and save them from its result. The assistant can also suggest a check after recording or explain a step in a run. Manual operation, inspection, recording and replay work without a model provider.

## AI provider

Open the workbench’s **Settings** menu and choose **AI provider settings**. The VS Code User setting `harmonyAgent.aiProvider` applies to exploration, phone tasks, recording check suggestions and step explanations.

- **GitHub Copilot** is the default provider for AI commands. Sign in with your Copilot account. If VS Code prompts for model access, allow Harmony Agent to use the model.
- **Codex** requires the local Codex CLI 0.146.0 or later. Run `codex login` if needed, select `codex` in the setting, and set `harmonyAgent.codexPath` if the executable is outside PATH.

The selected provider receives the goal and relevant page controls or run evidence when you request AI assistance.

## Optional external AI chat and MCP

For a separate conversation in Copilot Chat or the Codex desktop app, run **Harmony Agent: Continue in External AI Chat** from the Command Palette. Choose a provider and review the draft in that chat before sending it.

- **Copilot Chat.** Run **MCP: List Servers**, start **Harmony Agent**, and enable its tools in Chat agent mode. The optional `skills/harmony-agent` folder in the project repository can be copied to the app project's `.github/skills/harmony-agent` directory for device and workflow instructions. [MCP in VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- **Codex desktop.** In the external chat menu, choose **Copy Codex MCP configuration**. Add the generated `[mcp_servers.harmony]` entry to the trusted project's `.codex/config.toml`, then open a new chat there. To send future drafts to that project, set `harmonyAgent.codexProjectPath`. To share saved run evidence across windows, point `harmonyAgent.stateDir` to the same evidence directory. [Codex MCP](https://developers.openai.com/codex/mcp/)

## Develop

Open `extensions/vscode` in desktop VS Code and press F5 to launch the Extension Development Host. The **Harmony Agent: Open Workbench** command uses the CLI set in User Settings or on PATH. Run `npm test` with Node.js 22+ for the offline suite. Install `pytest` in the test interpreter to include the generated case and report tests. Set `HARMONY_TEST_PYTHON` if the interpreter is outside PATH.

Project code is distributed under [MIT](LICENSE). The bundled button and text-field styles retain their [upstream MIT notice](media/ui/vendor/elements-lite/LICENSE).

For new workbench views, use `actionButton` from `media/ui` for standard actions, `vscode-textfield` for single-line text fields, and `tabList` with `tabPanels` for tabs. The extension ships the base control styles and keeps theme overrides in `media/ui/components.css`. Network shows the distinction between segmented workspace navigation and the tabs for a single request. Check opening, acting and returning by keyboard in a narrow editor when changing either pattern.
