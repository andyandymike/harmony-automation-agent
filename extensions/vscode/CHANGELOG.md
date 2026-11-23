# Harmony Agent for VS Code changelog

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
