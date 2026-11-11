# Calling the CLI from an AI agent

This is a quick usage reference. The outer agent owns intent and planning; the CLI owns device operations, observations, deterministic checks, and evidence. The complete [Harmony Agent Skill](../skills/harmony-agent/SKILL.md) packages the operating workflow and request/outcome references; see [Skill setup](skill-setup.md) for installation. Direct CLI use does not require a Skill.

## Choose the task entry point

For a complete known workflow, prefer `execute`: provide the exact device and a plan with nonempty app-scoped initial `preconditions` and final `goals`. The command validates the plan before device access, attaches or resumes the named session, executes through its verified contract and detaches after verified completion. The initial check uses the runner's first frame; no preliminary `start` or model handoff is needed. Save the [complete workflow example](../skills/harmony-agent/references/workflows.md#complete-two-page-example) as a raw UTF-8 plan:

```sh
harmony-agent execute --device YOUR_DEVICE_ID --session task --plan-file .harmony-agent/workflow.json --json
```

Reuse a validated file for a new authorized task with the same page contract instead of rebuilding JSON. Run IDs are generated automatically; `--run-id` can preassign a unique recovery ID. Reusing a plan does not authorize replay after an uncertain result. `--plan-file` also accepts raw plans for `run`; it is CLI-only and mutually exclusive with `--plan` or `--request`.

For exploration or an unknown page, use `start` and then `run` for a chosen segment:

```sh
harmony-agent start --device YOUR_DEVICE_ID --session task --json
```

When the task supplies the exact device, `start` returns the installed version, named session, supported plan contract and current page together. Use `devices --json` only when device selection is needed. Reuse the attached session and established contract. Consult `help <command>` or `schema <command> --json` for unfamiliar fields; do not routinely reload the full schema. Use `doctor` for setup failures. If an older runtime explicitly rejects the chosen entry point, check its version once and use its supported attach/observe/run path. Core commands do not require a model key.

Record the installed package version and `schemaVersion` with a task report. Reject an output schema version the agent cannot interpret. Request fields are strict; do not pass guessed flags or unrecognized request keys. A successful diagnostic command still requires inspection of `data.ready` and its individual checks.

## Choose between exploration and a known sequence

Use the latest observation or a verified workflow contract to establish selectors and the next decision. Submit a complete known task through `execute`, or several known actions in one bounded `run` segment. Let the runner perform the checks without a model turn after each action. Do not split a known continuous segment into one-action plans.

Use direct commands for an isolated action or exploration. End a plan where unknown page structure, a user decision or necessary visual interpretation must guide the next action; do not guess selectors or remove required evidence to make a longer plan. The [portable Skill](../skills/harmony-agent/SKILL.md#choose-the-task-entry-point) is the canonical strategy, with [plan examples](../skills/harmony-agent/references/plans.md) and [measurement guidance](performance.md).

When page structure and workflow rules are already known, a new runtime value is not necessarily a new decision. Version 2 plans can `read` an exposed value and pass it through typed `var`/`concat` bindings to later fills or conditions. A known sequence can continue across pages in one run; missing, ambiguous or unexpected data stops execution. See the [workflow example](../skills/harmony-agent/references/workflows.md). `execute` defaults to `output: "decision"`; request it explicitly for `run`, whose default stays `full`. Both save full evidence and retain relevant exceptional receipts in their response.

## Resolve targets and check results

1. Use the latest successful command's returned observation, or run `observe --session <name> --compact --json` when none is available. Inspect the current app/window context, business facts, and observation quality.
2. Use an exact stable selector or a ref actually returned by this observation. Resolve ambiguity before acting; do not pick an arbitrary match.
3. Add an expectation when its result establishes a task outcome or determines the next action. Do not add a check to every mutation by habit. Text equality and supported boolean properties are preferable to a fixed sleep.
4. Check action and assertion results separately. A successful device command alone does not prove the task succeeded.
5. Reuse the action's fresh returned observation, including after `open` or `scroll`. When `expect` passes, another `wait` for the same condition adds no new verification. Expand the saved frame with `inspect` if only the returned detail is insufficient; capture again if current state is needed, the UI changes or the outcome is uncertain. Do not reuse refs from before the action, including after failure or timeout.

Example UTF-8 request file, assuming the fixture is open in session `demo` and the counter has been reset to zero:

```json
{
  "schemaVersion": "1",
  "command": "press",
  "input": {
    "session": "demo",
    "compact": true,
    "target": "id=fixture.increment",
    "expect": {
      "selector": {"id": "fixture.counter"},
      "property": "text",
      "equals": "Counter: 1",
      "timeoutMs": 5000
    }
  }
}
```

```sh
harmony-agent --request increment.json --json
```

Request files avoid shell quoting differences and allow structured selectors. Their keys and types are validated against the same command definition used by the CLI.

From `0.1.0a5`, individual commands that return observations accept `--compact`, `--max-nodes` and `--interactive`, including actions and `wait`. Top-level `run.interactive` requires alpha8; the tree filter does not apply to semantic output. Compact output omits optional null/empty node fields while preserving input text/value empty strings, root parents, booleans, zero and quality metadata. It is marked by `projection.compact=true`; a missing optional attribute must not be interpreted as false. See [compact output semantics](../skills/harmony-agent/references/outcomes.md#compact-output). `find` and projection options reduce returned content while still capturing the full UI tree. Full-frame conditions can establish only what the native tree exposes; a truncated view cannot establish absence.

## Handle incomplete or failed outcomes

- JSON stdout is the machine-readable result; stderr is diagnostic output. Read the process exit code too.
- Unknown boolean attributes are not false. Truncated observations are not complete absence checks.
- When dispatch is unknown, reobserve and inspect the expected outcome before deciding whether another action is appropriate. Do not automatically repeat non-idempotent submissions or increments.
- If an assertion fails after a dispatched action, retain the actual observation and evidence. Do not change the expected business result simply to make the step pass.
- A stale ref needs a new observation. Multiple selector matches need a more precise selector.
- Text entry has additional setup and partial-edit behavior; see [input limitations](#input-limitations).
- After `execute`, check `sessionCleanup` separately from business verification. Failed, unknown or yielded workflows retain their session, as does explicit `keep_session: true`. A cleanup failure preserves the actual business result and error; it never authorizes replay.
- After response loss, query `harmony-agent report RUN_ID --json`. Its `workflowReceipt.available` and cleanup status describe the recorded conclusion for that attempt. Missing or invalid lifecycle evidence means cleanup is unknown while the business report remains independently useful. Do not treat historical frame-validity fields as current session state.

## Input limitations

Text input is experimental. In alpha1, first-run IME onboarding blocked both fixture fields; in alpha2, six Chinese fill/replace/clear readbacks passed after Xiaoyi basic-mode setup on the dedicated emulator. These results do not establish Pinyin composition, candidate selection, every editor action or another device. Inspect current context rather than assuming input-method setup is complete. Disabling keyboard display on a control does not bypass initialization.

Native `uiInput inputText` appends text, and an empty string does not clear a field. CLI `fill` taps a supported editable target, verifies focus, selects all when needed, rechecks focus before deletion, verifies an empty value and retained focus, injects text, and verifies readback. An empty field skips the clearing keys. Losing focus before deletion or insertion stops the operation.

Input substeps share a default 15-second budget, overridable with `--timeout-ms`. Standalone `wait` and a nested expectation each default to their own 5-second budget. Consult the installed schema for supported overrides. `timings.actionMs` includes input preparation and internal verification; it is not pure dispatch time.

Filling can clear existing text before a later failure and does not promise rollback. Native Unicode or long-text injection may overwrite the device clipboard; restoring its previous contents is not guaranteed. Reobserve an unknown outcome before deciding what to do next, rather than automatically repeating input.

## Finish

Detach the session when done, unless `execute` already reports `sessionCleanup.status: "detached"` or the task deliberately retains it. Detaching does not stop the device or restore its application state. Keep relevant evidence local and review it before sharing. The CLI does not upload diagnostic data automatically.

For an agent-led task, record the user's goal, actual commands, independently observed final state, outcome, elapsed time and output volume. Complete task timing includes initial planning/request construction and cleanup; report smaller tool windows separately. Count skipped tasks separately. Measure tokens only when the tokenizer/model or usage counter is known; byte or character counts are not token counts. Prepared answers or hidden fixture IDs make a scripted demonstration, not independent discovery. Agent trials do not replace human first-install trials.
