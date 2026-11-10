# Bounded plans and execution records

This reference describes `0.1.0a7`. Alpha6 introduced plans but requires every mutation expectation and does not support recent-frame reuse or `refresh`. Read the installed `schema run --json` or MCP `harmony_schema` when the version differs. Plans are declarative input to the local runner; they do not execute arbitrary Python or JavaScript.

## Request shape

Use a UTF-8 JSON request file with `harmony-agent --request <file> --session <name> --state-dir <local-directory> --json`, or pass the `input` object to MCP `harmony_run`. The example uses synthetic IDs; discover real selectors from observations before adapting it.

```json
{
  "schemaVersion": "1",
  "command": "run",
  "input": {
    "run_id": "example-save-1",
    "plan": {
      "version": "1",
      "goal": "Save the requested message",
      "limits": {
        "maxSteps": 8,
        "maxActions": 2,
        "timeoutMs": 30000,
        "maxCaptures": 12
      },
      "steps": [
        {
          "command": "fill",
          "input": {
            "target": {"id": "message"},
            "text": "Example"
          }
        },
        {
          "command": "press",
          "input": {
            "target": {"id": "save"},
            "expect": {"selector": {"id": "status"}, "equals": "Saved"}
          }
        }
      ],
      "goals": [
        {"selector": {"id": "status"}, "equals": "Saved"}
      ]
    }
  }
}
```

Mutation `expect` is optional. Use it to wait for or verify an outcome that matters to the task. In this example, `fill` verifies the requested text internally; the save action waits for its result, and the final goal records task completion. A passed expectation needs no duplicate `wait`.

The optional `before` list checks declared page or business conditions on the target-resolution frame. Add it only when that context matters; do not manufacture checks for each mutation. The runner does not infer undeclared page semantics. Plan steps cannot attach/detach, switch sessions/devices, invoke arbitrary commands, or use frame refs as future selectors. All branches are validated before execution. The outer session selects the device.

## Reuse within a run

`run` returns a compact tree by default. Select `view: "semantic"` when the grouping helps analysis; semantic output can be larger. The runner skips intermediate public projections and full session-file rewrites, while keeping the journal and captured frames.

Within one uninterrupted run, targets and `before` checks can reuse the last successfully published frame for up to 1000 ms after its capture completes. Expired or invalid frames are captured again. Cached evidence is never reused across CLI calls or model turns. Device readiness is checked once per run by default.

On a mutation step, `refresh: true` forces a new capture and device check. Use it when an asynchronous page change matters to that action. For example, the following step deliberately refreshes before selecting its target:

```json
{"command":"press","refresh":true,"input":{"target":{"id":"save"}}}
```

The default avoids redundant reads but permits reuse for up to one second after capture completes. The app may change during that interval. Refresh obtains a new frame; it cannot prevent later app changes.

## Control flow

Each step has exactly one operation form:

| Form | Meaning |
| --- | --- |
| `{"command":"observe","input":{}}` | Execute a supported core command |
| `{"assert":condition}` | Check a deterministic condition |
| `{"if":condition,"then":[steps],"else":[steps]}` | Select a known branch; unknown returns control |
| `{"repeat":{"limit":3,"until":condition,"steps":[steps]}}` | Check before each iteration; finite bounded repetition |
| `{"yield":"Need a decision about the new page"}` | Return control with a reason |
| `{"stop":"This segment is complete"}` | End this segment; declared goals still determine task verification |

`condition` has `selector`, optional `property` (default `text`), `equals`, and optional `timeoutMs`, matching the installed expectation schema. Control-flow checks evaluate the latest verified frame; they do not poll for `timeoutMs`. Use a `wait` command or an action's `expect` when waiting for a change is intended. Preserve actual booleans, empty strings and original display values. A timed-out command stops the plan rather than selecting an alternate branch. Absence and ambiguity must follow the core's explicit condition semantics.

Select finite step, action, capture and time budgets. `maxSteps` includes precondition checks, goal checks and control-flow checks, not only command entries; leave room for final goal verification. `maxActions` counts high-level mutation commands (`press`, `fill`, `scroll`, `back`, `open`), not native transport operations: one `fill` can focus, clear and insert through several native actions. `maxCaptures` bounds native observations across the run. Budget exhaustion returns a partial result; it does not undo earlier steps. Native commands already dispatched may complete before cancellation is observed. Finishing the declared steps alone is not proof of the business outcome.

## Results and recovery

Read the outer envelope and the run status separately. A tool can return a valid run record whose status is `failed`, `unknown`, `cancelled`, `budget_exhausted` or `yielded`. Only `completed` means the segment completed, and `goalVerification.status=passed` verifies only the declared goals. Missing goals are reported as not requested rather than silently passed.

Keep `run_id` and inspect its report after response loss. Never resubmit a run solely because a tool timed out. The same run ID identifies one recorded attempt; a later decision uses a new run ID after inspecting the previous outcome and fresh state. Request deduplication does not imply exactly-once device actions across a crash.

`run` claims the device for its named session. Ownership remains across yielded or completed segments until `release` or `detach`, so other sessions cannot insert actions between segments. A crashed owner is not automatically replaced. Resume the same intended session, inspect the run, observe current state and decide whether to continue or release. Do not remove lock/state files to bypass ownership.

Record persistence and device execution can fail independently. A missing receipt does not prove that an action was never sent. If persistence is incomplete after dispatch, preserve that uncertainty and stop the mutation path until state is inspected.

## Expand saved evidence

Reports are compact by default. The complete stored evidence is checked before output projection. Receipts, goals and unique errors are retained; duplicated `result.steps` entries are omitted, and `result.observation` is replaced with `result.observationRef`. Expand that frame with `inspect`, or use `report --full` / MCP `full: true` for the complete saved representation. This changes returned context, not the saved journal or evidence checks.

`inspect` requires `frame_id`. Use `run_id` for a recorded run frame, or the current named session's cached frame when no run ID is supplied. Optionally give a target selector and node limit. It reads saved data without HDC and does not make old refs fresh. Use `report` with `run_id` to retrieve execution and verification results.

For independent review, pass frozen frame and run IDs, the user's goal and the exact question. Do not ask a reviewer to operate the device to make incomplete evidence pass. Report unsupported and inconclusive conclusions separately from verified outcomes.
