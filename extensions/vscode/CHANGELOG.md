# Harmony Agent for VS Code changelog

## 0.20.33

- Start a recording from one button. The first phone touch or preview action selects the input source. Save stable control matches as locators and other supported gestures by screen position.
- Select multiple case steps using the selection button or a mouse hold. Save the selected steps as a section or delete them as one undoable edit.
- Use the same mouse hold, right-click and select-all controls across batch-action lists. Switching views, changing filters or using another control exits selection mode.
- Open apps and take screenshots from Settings in Elements. Disconnect and reconnect the workbench device session from the phone preview.
- Choose a rule group in the case's Given. Run once with it off from run settings, or turn off manual mocking from the test gateway. New workspaces start with an empty rule-group library.

## 0.20.32

- Enter step feedback, then review the proposed actions and assertions in AI Exploration. Manual operation and locator editing is available from the same step.
- Explore case feedback, step revisions and pending insertions together in workflow order. Each description can produce multiple executable steps.
- Review the combined draft and replay the exact candidate from the case’s starting state before saving it as a runnable version.

## 0.20.31

- Write a step description or insert a saved case reference at any position. Start a new case in Tests or extend an existing recording.
- Save descriptions as a case draft. Generate and review executable actions and checks in AI Exploration, then apply them to the original row.
- Replay the available preceding steps or start from the current phone screen. Finish pending descriptions before running the whole case or exporting it to pytest.

## 0.20.30

- Insert Given, When, or Then at any step boundary. A Given can check a condition, prepare the device state, or reuse a saved case.
- Combine recorded gestures and control steps in one workflow and report using runtime 0.1.0a11. Legacy coordinate-only recordings retain their native replay.
- Keep the workflow's explicit starting and final assertions in run settings.

## 0.20.29

- Choose an action, a check, or a reusable case from the same insertion point. Coordinate recordings can add gestures at any step boundary.
- Search for a reusable case first, then choose between a reference and independent steps. Preview the selected case on demand.

## 0.20.28

- Insert saved coordinate recordings into another coordinate replay case. References keep their saved gestures and delays.
- Choose **Insert reference** or **Copy as local steps** directly from inline search results.

## 0.20.27

- Search for a reusable case at the selected step boundary. Accept the highlighted reference with Enter, open a preview when needed, or undo the insertion from the draft.

## 0.20.26

- Choose the insertion point from a step’s context menu or from the case-step header. Browse the case library and preview the chosen source in the main Tests area.
- Open step-specific exploration in the AI Exploration tab, with separate views for an AI task, a control check, and past results. Return to the same case to review and save edits.

## 0.20.25

- Insert a saved case or a reusable section at a step boundary, including inside a branch or loop. A reference uses the version saved in the calling case.
- Find references and affected cases, review source updates, and keep, replace, or copy the saved steps when a source is unavailable.
- Explore from a case position or the current phone screen, verify selected controls, and add reviewed steps or checks to the case draft.

## 0.20.24

- Generate executable step repairs from recorded controls, including an extra tap when a new screen interrupts the flow.
- Open a proposed change as an editable draft, including for cases awaiting starting conditions or final assertions.
- Supplement a locator diagnosis with the current phone screen and preserve the original final checks during verification.

## 0.20.23

- Save same-name cases in separate directories, including when an earlier case has been removed from the library.
- Edit a step’s action and parameters from its row or context menu, and choose overlapping controls on the device preview.
- Release the workbench’s device sessions after unsuccessful runs while keeping their recorded evidence.

## 0.20.22

- Restore the Harmony Agent Activity Bar icon. It opens the editor workbench and shows the project tree.

## 0.20.21

- Diagnose failures with the saved failing page, preceding step, a prior passing run, and relevant local HTTP errors.
- Review, verify, and apply grounded locator replacements or page readiness checks from the failure report.

## 0.20.20

- Use case intent, recorded page context, and existing checks when suggesting BDD step names, groups, and roles.
- Pick a replacement locator directly from the phone preview while editing a step.

## 0.20.19

- Open the workbench from the phone icon in the Explorer's project toolbar.

## 0.20.18

- Open the workbench from the status bar and keep the selected VS Code sidebar in place.

## 0.20.17

- Show BDD roles in execution order, including prerequisites and assertions within a workflow.
- Insert a check after a step and choose its BDD role. AI can suggest roles along with step names and groups.

## 0.20.16

- Organize BDD step names and groups with AI. Review the suggestions before saving the case.
- Rename, duplicate, delete, and reorder steps from their context menu. Pick a replacement locator from the current phone page.
- Align the exploration mode, checkpoint, and rule-group controls with their labels.

## 0.20.15

- Review the first failure and decide whether to keep the case, investigate the page, or verify a replacement locator.
- Find the optional HTML export under run or exploration evidence.

## 0.20.14

- Open local workflows while device discovery and case indexing run in the background.
- Clear the network request history with Undo. Favorites stay available.
- Keep manual capture active while the profiler is still running and identify captures ended by the device.

## 0.20.13

- Share a trusted workspace's Python, CLI, source directory and HDC across the workbench, pytest and MCP using `.harmony-agent/runtime.json`.
- Revalidate saved configuration changes and keep the current runtime until active work finishes.

## 0.20.12

- Duplicate a test case from the library or remove its entry with Undo. Eligible case folders can also be moved to Trash after confirmation.
- Improve drag ordering for editable lists and add copy actions to retained network content.
- Refine the live device controls and network detail layout.

## 0.20.11

- Inspect and operate a connected HarmonyOS device from the live preview.
- Record workflows, replay them from the workbench or pytest, and inspect saved step evidence. Interactive workflow debugging uses the `0.1.0a10` runtime.
- Inspect network activity from test apps or imported HAR files. Preview and apply mock rules through the local test gateway.
- Keep manual testing available without a model provider. Enable Copilot or Codex separately for AI assistance.
