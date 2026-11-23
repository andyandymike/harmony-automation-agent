# Harmony Agent for VS Code changelog

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
