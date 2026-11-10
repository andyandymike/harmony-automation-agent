# Calling the CLI from an AI agent

This is a quick usage reference. The outer agent owns intent and planning; the CLI owns device operations, observations, deterministic checks, and evidence. The complete [Harmony Agent Skill](../skills/harmony-agent/SKILL.md) packages the operating workflow and request/outcome references; see [Skill setup](skill-setup.md) for installation. Direct CLI use does not require a Skill.

## Start with the installed contract

```sh
harmony-agent help
harmony-agent schema --json
harmony-agent doctor --json
harmony-agent devices --json
```

Select one exact device. Attach a named session and keep using that session for subsequent commands. Consult `help <command>` or `schema <command> --json` instead of guessing flags. The current alpha does not require a model key for its core commands.

Record the installed package version and `schemaVersion` with a task report. Reject an output schema version the agent cannot interpret. Request fields are strict; do not pass guessed flags or unrecognized request keys. A successful diagnostic command still requires inspection of `data.ready` and its individual checks.

## Read, act with an expectation, then use fresh refs

1. Run `observe --session <name> --json` and inspect the current app/window context, business facts, and observation quality.
2. Use an exact stable selector or a ref actually returned by this observation. Resolve ambiguity before acting; do not pick an arbitrary match.
3. Express the expected effect with the action whenever possible. Text equality and supported boolean properties are preferable to a fixed sleep.
4. Check action and assertion results separately. A successful device command alone does not prove the task succeeded.
5. After an action, obtain or use a fresh returned observation. Do not reuse refs from before the action, including after failure or timeout.

Example UTF-8 request file, assuming the fixture is open in session `demo` and the counter has been reset to zero:

```json
{
  "schemaVersion": "1",
  "command": "press",
  "input": {
    "session": "demo",
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

## Handle incomplete or failed outcomes

- JSON stdout is the machine-readable result; stderr is diagnostic output. Read the process exit code too.
- Unknown boolean attributes are not false. Truncated observations are not complete absence checks.
- When dispatch is unknown, reobserve and inspect the expected outcome before deciding whether another action is appropriate. Do not automatically repeat non-idempotent submissions or increments.
- If an assertion fails after a dispatched action, retain the actual observation and evidence. Do not change the expected business result simply to make the step pass.
- A stale ref needs a new observation. Multiple selector matches need a more precise selector.
- Input is experimental. In alpha1, first-run IME onboarding blocked both fields; in alpha2, six Chinese fill/replace/clear readbacks passed after Xiaoyi basic-mode setup on the dedicated emulator. This does not establish Pinyin composition, every editor action or another device. Inspect current context rather than assuming input-method setup is complete.
- Alpha2 `fill` defaults to a 15-second input-phase budget. Standalone `wait` and a nested expectation each default to their own 5-second budget. A slow device may require an explicit timeout supported by the installed schema; do not respond to an unknown outcome with automatic retries.
- Filling is multi-step and can clear existing text before a later failure. It may overwrite the device clipboard. Check the input-specific limitations in the README.

## Finish

Detach the session when done. Do not assume detaching stops the device or restores its application state. Keep relevant evidence local and review it before sharing. The CLI does not upload diagnostic data automatically.

For an agent-led task, record the user's goal, the commands actually run, independently observed final state, passed/failed/unknown outcome, elapsed time and output volume. Count skipped tasks separately. Measure tokens only when the tokenizer/model or usage counter is known; byte or character counts are not token counts. An agent using prepared answers or hidden fixture IDs is a scripted demonstration, not independent task discovery. Agent trials do not replace human first-install trials.
