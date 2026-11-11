# Known workflows with runtime values

Alpha9 plan version `"2"` keeps deterministic data transfer inside the local runner. Use it when the task or verified prior evidence establishes the page structure, selectors, flow and final criteria, but a code, label or requested amount appears only during execution. A genuinely unknown page structure still requires an outer decision. Bindings do not interpret arbitrary page instructions or discover a workflow automatically.

For a complete known workflow, use `execute` once with an explicit device, initial `preconditions` and final `goals`. It validates the entire plan before attaching, attaches or resumes the same device/session identity, and checks the initial page using the runner's ordinary first capture. It does not first return that page to the model. After verified completion it releases ownership and detaches by default; `keep_session: true` deliberately retains the session. Failed, unknown or yielded workflows retain their session and evidence.

Use `harmony-agent start --device DEVICE --session TASK --json` when the current structure or task still requires exploration; then use `run` for the chosen segment. In the same environment, retain the learned command contract. A required new runtime value can be read inside a known workflow without another model turn.

## Small binding contract

| Form | Meaning |
| --- | --- |
| `{"read":{"name":"code","selector":{"textPrefix":"Code: "},"stripPrefix":"Code: "}}` | Read one uniquely matched text value and remove that exact leading prefix |
| `{"var":"code"}` | Use the value already bound to `code` on this run's executed path |
| `{"concat":["Receipt: ",{"var":"code"}]}` | Join literal strings and string variables; no nested expressions or implicit boolean conversion |

`read.property` defaults to `text`; it can also read `visible`, `enabled`, `checked`, `selected` or `focused` as booleans. `stripPrefix` is text-only and must match exactly, including case and whitespace. A source selector uses the full normalized frame, requires one match, and cannot use frame refs. `textPrefix` is a nonempty case-sensitive literal prefix; add type/app/window/`within` context when needed for uniqueness.

Variables are local to one run. Names match `[A-Za-z_][A-Za-z0-9_]{0,63}`. A later read may update the same variable with the same type. Every referenced variable must be declared somewhere in the plan and must actually have been read before use on the selected path. Reads happen in `steps`; a variable read later cannot supply an earlier precondition. Unknown sources, missing properties, type conflicts, prefix mismatches and unassigned variables stop the path without guessing a replacement value.

Expressions are allowed only in `fill` input `text`, `wait` input `equals`, and condition `equals` (including `expect`, `before`, `assert`, `if`, `repeat.until` and final goals). Command names, selectors, app names and other fields remain literal. Text variables cannot supply boolean fields or vice versa. A bound text value is limited to 20,000 characters; `concat` accepts 1–32 literal strings or `var` references. Literal strings are never evaluated as code or templates.

Each read counts one step, not an action. It shares the ordinary within-run frame policy and capture budget. The journal records the source selector/property/frame, declared prefix and bound value. Read/binding failures return control with evidence; subsequent actions do not execute. Use `report RUN_ID --full --json` and frozen `inspect` only when the evidence needs review.

## Complete two-page example

This synthetic example assumes an already verified contract in `org.example.fixture`: the draft page has heading `Draft`, one `Task note` input and a `Continue` button; the review page has heading `Review`, one confirmation phrase, required count, confirmation input, counter and increment button. `Finish` produces a receipt with the note, confirmation value and final count. The requested count is within ten increments of the initial count. These labels and rules are known; the confirmation value and required count are not. Adapt only after establishing the equivalent contract in the target app.

Save this raw plan as UTF-8 `.harmony-agent/plans/two-page.json`. Initial conditions check the expected app and page using one shared frame. The first transition waits for the known review page. The runner then reads its new values, fills and increments locally, and checks every required receipt field. No future element ID or confirmation value is invented.

```json
{
  "version": "2",
  "goal": "Complete the known draft and review workflow with its displayed values",
  "limits": {
    "maxSteps": 40,
    "maxActions": 14,
    "timeoutMs": 90000,
    "maxCaptures": 40
  },
  "preconditions": [
    {"selector":{"bundleName":"org.example.fixture","text":"Draft"},"property":"visible","equals":true},
    {"selector":{"bundleName":"org.example.fixture","hint":"Task note"},"property":"visible","equals":true}
  ],
  "steps": [
    {"command":"fill","input":{"target":{"hint":"Task note"},"text":"Example"}},
    {"command":"press","input":{"target":{"text":"Continue","type":"Button"},"expect":{"selector":{"text":"Review"},"property":"visible","equals":true}}},
    {"read":{"name":"code","selector":{"type":"Text","textPrefix":"Confirmation phrase: "},"stripPrefix":"Confirmation phrase: "}},
    {"read":{"name":"required_count","selector":{"type":"Text","textPrefix":"Required count: "},"stripPrefix":"Required count: "}},
    {"command":"fill","input":{"target":{"hint":"Confirmation text"},"text":{"var":"code"}}},
    {"repeat":{
      "limit":10,
      "until":{"selector":{"type":"Text","textPrefix":"Count: "},"equals":{"concat":["Count: ",{"var":"required_count"}]}},
      "steps":[{"command":"press","input":{"target":{"text":"Increase count","type":"Button"}}}]
    }},
    {"command":"press","input":{"target":{"text":"Finish","type":"Button"},"expect":{"selector":{"text":"Completed"},"property":"visible","equals":true}}}
  ],
  "goals": [
    {"selector":{"text":"Completed"},"property":"visible","equals":true},
    {"selector":{"type":"Text","textPrefix":"Note: "},"equals":"Note: Example"},
    {"selector":{"type":"Text","textPrefix":"Confirmation: "},"equals":{"concat":["Confirmation: ",{"var":"code"}]}},
    {"selector":{"type":"Text","textPrefix":"Count: "},"equals":{"concat":["Count: ",{"var":"required_count"}]}}
  ]
}
```

Execute the plan directly; the output defaults to `decision`:

```sh
harmony-agent execute --device DEVICE --session TASK --plan-file .harmony-agent/plans/two-page.json --max-nodes 20 --json
```

Reuse this validated file for a new authorized task with the same contract; do not reconstruct the JSON or reload the full schema. The CLI automatically assigns a fresh `runId` unless `--run-id` is provided. An explicit unique ID can be chosen beforehand when recovery must work even if the entire response is lost. Reused IDs never replay. `--plan-file` also works with `run`; it accepts a raw plan, not a request envelope, and cannot be combined with `--plan` or `--request`. MCP continues to accept the plan object directly.

Do not replay after response loss; inspect the saved run. `status: "completed"` with `goalVerification.status: "passed"` verifies the declared receipt criteria. Also read `sessionCleanup.status`: `detached` completes automatic cleanup; `retained` leaves the session available; `failed` preserves the actual cleanup error while leaving the business result unchanged. The device is not stopped. No additional detach is needed after `detached`.

The decision output preserves goals, the final page and actionable errors; the full stored run retains intermediate reads and actions. That business run is persisted before cleanup and is not rewritten afterward. One small separate lifecycle receipt records the cleanup conclusion; `workflowReceiptAvailable` reports whether writing it succeeded. A write failure adds a warning without undoing completed actions or their verification.

After response loss, `report` returns this independent record as `workflowReceipt`. Check `available` and `sessionCleanup.status`. Missing, damaged or mismatched lifecycle evidence yields `available: false` with unknown cleanup, while the business report remains available. Do not infer detachment from a completed business run or treat its historical frame-validity field as current state. Resolve any remaining session-state question without re-executing the workflow.

If the structure or required choice changes, yield or stop and obtain the missing evidence instead of widening selectors until something matches. Initial/final conditions establish task boundaries; they are not a requirement to add checks to every action.
