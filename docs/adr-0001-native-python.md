# ADR 0001: Python standard library and native HDC for the initial CLI

- Date: 2026-11-02
- Status: implementation decision for the development alpha; device coverage remains subject to validation

## Context

The project needs a small, usable first version for AI coding assistants. The existing Harmony automation reference project is Python-based, and the current development host already has Python and the official HarmonyOS command-line tools.

The first scope is explicit device selection, observations, basic actions, deterministic checks, and evidence. A second model runtime, three backend lanes, and a public SDK are not required to validate that scope.

## Decision

Implement the CLI and core in Python 3.10+ with standard-library runtime dependencies. Use the official HDC executable to invoke UiTest and related device commands. Keep process execution and native protocol handling behind a transport adapter.

Use one command schema to drive CLI help, argument validation, and structured requests. Keep the core callable internally so later SDK or MCP adapters can reuse the same behavior.

The default execution path is model-free. Midscene visual functions and Appium integration remain optional future adapters, to be added only when they solve demonstrated gaps.

## Consequences

- Source execution needs Python and the existing SDK tools, without a runtime dependency download.
- Packaging may still need setuptools at build time.
- A native CLI is sensitive to HDC / UiTest output and device-version differences; probe capabilities and report unsupported or unknown results.
- Commands execute subprocesses, so startup, capture, transfer, and waiting costs must be measured rather than assumed fast.
- This decision does not claim that Python is universally faster than Node, nor that the native backend supports every control or input method.
- Keep host process execution separate from remote shell quoting. Never automatically retry a mutating command whose outcome is unknown.
- Do not copy private upstream implementations or require Appium types in the observation protocol.

## Input semantics discovered during integration

The tested device's native `uiInput inputText` command appends text and cannot clear a field with an empty argument. The core implements experimental replacement as tap, focus verification, Ctrl+A / Delete when necessary, verification of an empty value and retained focus, native text injection, and final readback. Already-empty fields skip clearing keys; a lost focus stops insertion. Substeps share one operation budget. Each phase can fail after earlier phases have already changed the field; no rollback is promised.

Unicode or long-text native injection may use and overwrite the device clipboard. This local side effect is documented, and the initial implementation does not promise clipboard restoration. Action timing is reported as `actionMs` and includes input preparation and internal checks.

The regular fixture TextInput triggered first-run Xiaoyi keyboard privacy onboarding in the emulator. The tool did not automatically accept the prompt. The additional real TextInput with soft-keyboard display disabled was also blocked: clearing keys triggered onboarding in one attempt, and focus was blocked after a later clean launch. Therefore `enableKeyboardOnFocus(false)` does not reliably isolate input from the IME. Chinese insertion, replacement, and clearing have not passed device acceptance. Input remains experimental until a valid environment and a complete readback test establish the supported behavior.

The paragraph above records the alpha1 integration stage. On 2026-11-03, alpha2 passed six standard/native Chinese fill, replacement and clear readbacks after the dedicated emulator's IME setup; see [the alpha2 validation](validation-alpha2.md). This does not establish general IME support. The alpha3 core fixes have their own [validation record](validation-alpha3.md).

## Revisit when

Revisit the decision if native input or required observation semantics cannot satisfy the supported fixture, measured overhead blocks actual tasks, or an integration has a concrete requirement for another runtime. Record the evidence and migration impact before adding a second mandatory execution stack.
