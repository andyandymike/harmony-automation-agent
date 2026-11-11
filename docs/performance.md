# Measure task performance

Measure the complete interaction as well as the local execution core. A faster `run`, fewer output bytes or more reused frames does not establish a faster agent task. Keep private recordings under `.harmony-agent/`; public tests and examples use synthetic data.

## Record each CLI invocation

The evaluation wrapper runs exactly one CLI process, forwards its output and records timing without retrying the command:

```sh
python scripts/agent-eval-cli.py --record-dir .harmony-agent/eval/baseline -- schema run --json
```

For a device task, use the same wrapper around the actual commands or UTF-8 request files. Paths with spaces and Unicode are supported:

```sh
python scripts/agent-eval-cli.py --record-dir .harmony-agent/eval/baseline -- --request ".harmony-agent/requests/step 1.json" --json
```

Add `profile: true` to a request's `input`, or `--profile` to an individual observation/action command, to collect core timings. `run` and `execute` include their core profiles automatically. Do not add `observe`, `wait`, assertions or screenshots just to populate a measurement: record the workflow being evaluated. Keep the same required checks and screenshots in both variants.

The wrapper uses this checkout's source by default. To compare a separately installed wheel, select its Python environment explicitly:

```sh
python scripts/agent-eval-cli.py --record-dir .harmony-agent/eval/candidate --python ".venv/Scripts/python.exe" --installed -- --version --json
```

On POSIX hosts use the corresponding `bin/python` path. This form also works from a distribution bundle containing the scripts and an installed wheel without a `src/` directory. The wrapper itself uses only the standard library. `--installed` removes the inherited `PYTHONPATH` for the measured child process. Record the exact source revision or wheel hash once in the trial manifest; package versions alone do not distinguish rebuilds.

`calls.ndjson` contains UTC start/end timestamps, a monotonic duration, byte counts, command success, run status, goal-verification status, action counts and measured profile values. New recordings derive both nanosecond timestamps and `elapsedMs` from the same high-resolution `perf_counter_ns` clock and declare `clockSource`. The older `startedMonotonicNs`/`endedMonotonicNs` field names remain compatible. The summary excludes selectors, entered text, UI nodes, command arguments and error messages. Core profile stages and target-versus-condition reuse counters remain separate. A saved `report` does not count its historical actions as new device actions. Task-entry records also include the declared `sessionCleanupStatus`; an explicit cleanup failure prevents a successful matched comparison. Older records without that field do not establish cleanup success.

Summary byte totals include a corresponding `*MeasuredCalls` coverage count. Missing legacy byte fields remain null when there are no measurements; partial totals are not a complete attempt's output volume.

The wrapper preserves the older `at`, `elapsedMs`, exit-code and byte-count fields. `at` now identifies process completion. Old records without explicit start/end timestamps still support duration totals; the summary will not invent a precise timeline from them. Model time and tokens remain `null` unless separately measured.

Use one execution host and recording directory for an attempt. The summary cross-checks UTC timestamps against monotonic timestamps across all calls, with a resolution allowance for legacy clock sources. Missing monotonic evidence, mixed clock sources, clock resets or offset changes prevent a matched comparison; a wall-clock jump between calls must not appear as agent time saved.

Raw `.stdout`, `.stderr` and `.emitted` files stay beside the recording. The optional `--drop-press-ack-once` fault test still records the actual reply, emits one unknown result, and never repeats the press. Use fault injection in a controlled recovery trial, not silently in a normal performance comparison.

## Record host calls and declared plan boundaries

CLI process count is not host tool-call count. One host tool call may start several CLI processes, sequentially or concurrently. If the harness or an actual host trace exposes that boundary, pass its opaque ID to each child CLI recording:

```sh
python scripts/agent-eval-cli.py --record-dir .harmony-agent/eval/candidate --host-call-id tool-7 --execution-mode warm_continue --plan-boundary unknown_page -- --request .harmony-agent/requests/segment.json --json
```

All three new flags are optional metadata. They do not add a model call, device command or observation. `--plan-boundary` applies to `run` and `execute` and declares why the caller ended that segment: `known_sequence`, `unknown_page`, `human_decision`, `required_screenshot`, `goal_reached`, `budget_limit`, `recovery` or `other`. The summary retains this declaration separately from actual run status; declaring `goal_reached` does not establish success. Unspecified boundaries stay unknown.

An ID alone establishes a correlation label, not a measured host interval or complete host-call count. Add explicit events to measure the observed boundary, using actual timestamps:

```json
[
  {
    "kind": "host_call",
    "hostCallId": "tool-7",
    "startedAt": "2026-01-01T10:00:10Z",
    "endedAt": "2026-01-01T10:00:12Z",
    "source": "harness",
    "boundaryKind": "nested_tool_api"
  }
]
```

`source` is `host_trace`, `harness` or `manual`. `boundaryKind` can identify `host_tool_call` or `nested_tool_api`; it remains null when unknown. `outerToolCallCount` and `nestedToolApiCount` count only explicitly recorded intervals of their respective kinds. Missing observations stay null. An optional `outerCallId` may preserve an explicitly observed parent-call ID, but labels on nested calls alone do not establish the total outer-call count. Do not assign a shared ID to separate invocations just to reduce a count.

For example, timestamps inside a wrapper around an awaited tool API describe that nested API window. They do not include the enclosing tool call's complete duration, model queuing or other host work. Several nested calls can belong to one outer call. **Nested API counts and CLI counts cannot establish outer tool calls or model rounds.** `modelToolRounds` stays null. This script does not automatically instrument Copilot or another agent host.

`hostCalls` reports recorded intervals, observed IDs, their sources and boundary kinds, CLI linkage coverage, duration sums and interval union. Its span can extend beyond the first/last CLI because tool calls can include reading instructions, building requests or verification. Do not add host duration to CLI duration: their intervals can contain each other. Events without a CLI child are retained. Missing host observations yield null counts rather than an estimate from process count.

Overlapping read-only CLI processes can be measured when their recorded host intervals identify them. Ambiguous overlaps and overlapping mutation attempts still prevent a matched sequential-work comparison, since process overlap does not prove the order of device effects.

## Summarize the timeline

```sh
python scripts/performance.py summarize .harmony-agent/eval/baseline --output .harmony-agent/eval/baseline-summary.json
```

The summary reads `calls.ndjson`, not raw output. Its timing fields have different scopes:

| Field | Scope |
| --- | --- |
| `windowMs` | First recorded CLI start through final completion, or an explicitly supplied task interval |
| `cliWallSumMs` | Sum of recorded child-process wall times |
| `cliBusyMs` | Union of CLI intervals; overlapping processes are not counted twice |
| `coreWallSumMs` | Sum for calls with a measured core profile; `coreProfiledCalls` states coverage |
| `processOutsideCoreSumMs` | Process wall time minus measured core time for those calls |
| `gapMs` | Time in the measured window outside CLI intervals |
| `unattributedGapMs` | Gap time without an explicit phase annotation |

Process time outside the core includes startup, argument/request handling, output serialization and other work. It is not an isolated startup measurement. Gaps can include request construction, model activity, tool scheduling, screenshots from another tool, user input and recorder overhead. They are not automatically model thinking time. A recorded-call window also omits preparation before the first call and analysis after the last call.

Profile stages can nest; do not sum them as disjoint portions of wall time. `captureStagesMs.hdcProcess` includes process startup/waiting, native export, transfer and cleanup. `decodeAndValidation`, `shellReceiptValidation` and `layoutParseAndValidation` measure host-side work. `instrumentedCaptures` states coverage. `nativeExportMs` and `transferMs` remain `null` because the current single-call transport does not measure them separately.

`reusedFrames` includes condition evaluation as well as target resolution. Use `targetFrameRequests`/`reusedTargetFrames` to assess action-target reuse, and `conditionFrameRequests`/`reusedConditionFrames` for condition reads. `beforeConditionChecks` counts comparisons on the action's target frame; it is not another capture or a separate action reuse.

## Attribute phases only with evidence

An optional events file supplies intervals from host logs or evaluator annotations. This is a synthetic format example; replace all timestamps with the actual attempt:

```json
[
  {"kind":"task","startedAt":"2026-01-01T10:00:00Z","endedAt":"2026-01-01T10:01:00Z"},
  {"kind":"manual_wait","startedAt":"2026-01-01T10:00:20Z","endedAt":"2026-01-01T10:00:30Z"}
]
```

```sh
python scripts/performance.py summarize .harmony-agent/eval/baseline --events .harmony-agent/eval/events.json --output .harmony-agent/eval/baseline-summary.json
```

The optional `task` interval must contain every recorded call. Supported phase kinds are `screenshot`, `manual_wait`, `request_build`, `analysis`, `scheduling`, `model` and `other`. Phase intervals must not overlap each other. `gapAttributionMs` attributes only their intersection with gaps; time overlapping a CLI call remains in the CLI interval. `annotatedPhaseMs` retains the full annotated durations separately and must not be added to CLI/gap totals. A screenshot event overlapping a recorded screenshot command is not counted as another screenshot. An annotated manual wait blocks a normal timing comparison even when it occurs during a CLI call.

Use `model` only for an independently identified model interval, not an unexplained gap. `modelMs` then describes the explicitly annotated gap time and records its source. Actual token counts may be supplied in the manifest's `modelUsage` object with `source` set to `provider_usage` or `host_usage_counter`, plus `inputTokens` and `outputTokens`. Otherwise they remain `null`; byte counts are never converted to tokens.

## Keep task milestones distinct

An evaluator can record four point events independently. Each uses `kind: "milestone"`, a `name`, an ISO `at` timestamp and an explicit `source`:

| Milestone name | Observed boundary |
| --- | --- |
| `task_start` | The task is made available at the chosen evaluation boundary |
| `goal_verified` | Independent readback or evidence review has verified the requested outcome |
| `cleanup_complete` | Required cleanup has finished |
| `response_complete` | The final response has actually finished at the observed host boundary |

```json
[
  {"kind":"milestone","name":"task_start","at":"2026-01-01T10:00:00Z","source":"harness"},
  {"kind":"milestone","name":"goal_verified","at":"2026-01-01T10:00:40Z","source":"harness","verificationMethod":"independent_readback","passed":true},
  {"kind":"milestone","name":"cleanup_complete","at":"2026-01-01T10:00:45Z","source":"harness"}
]
```

`goal_verified` requires `verificationMethod` to be `independent_readback` or `independent_evidence_review`, plus explicit `passed: true` or `status: "passed"`; the agent's own completion claim is insufficient. Failed, unknown, missing or conflicting verification status cannot establish time to a verified goal. The declared status is retained, and a contradiction with the manifest's successful result blocks comparison. Supplied milestones must follow the order in the table; inconsistent timestamps are retained as issues and prevent a matched claim.

The summary reports time from `task_start` to each observed milestone. Missing endpoints stay null. A cleanup receipt is not the final response boundary, and a parent's later receipt is only an upper bound unless that exact response boundary was observed.

With both `task_start` and `response_complete`, the summary can use their interval as the task window. Otherwise it keeps the recorded CLI window unless a legacy explicit `task` interval was supplied. It never uses the last CLI as a substitute for the final response. An explicit `task` interval and complete task milestones must agree.

External UTC-only timestamps remain annotations. To verify a shared clock, supply the same `clockSource` and compatible monotonic measurements: `monotonicNs` for a point, or `startedMonotonicNs`/`endedMonotonicNs` for an interval. `milestoneDurationClockVerified` and each host interval's `clockVerified` state the result. Do not copy numbers from an unrelated clock domain. A full task window based on unverified external clocks remains visible but does not support the comparison tool's matched improvement claim.

## Match two attempts before comparing

Separate these experiments:

1. **Same core, different calling strategy:** compare individual calls with an appropriately bounded plan, keeping the same task, actions, required checks, screenshots, environment and model configuration.
2. **Same strategy, different core:** keep the task and calling strategy fixed while comparing two pinned source revisions or wheel hashes.

Use a fresh record directory for each attempt. Reset to the same initial state and use the same final outcome criteria. For an agent trial, keep model, reasoning settings, starting context and task instructions comparable. Use opaque identifiers or hashes for those configurations; do not put private UI values into metadata. Repeat pairs with balanced execution order. Report failures and wrong actions as well as successful durations.

Declare `executionMode` as `cold_setup` or `warm_continue` in the manifest. A cold attempt includes the selected setup/discovery conditions; a warm continuation begins with the documented existing context/session. Describe the exact setup outside private recordings, and match this condition between compared attempts. It is a combined trial condition, not proof that caching caused a difference. Older recordings remain readable, but a missing mode is not silently treated as cold or warm. Optional wrapper `--execution-mode` values must agree with the manifest.

Each attempt has a manifest. The following is a template for a synthetic two-increment task, not a completed test result:

```json
{
  "taskId": "counter-two",
  "taskRevision": "1",
  "initialStateId": "counter-zero",
  "expectedOutcomeId": "counter-two-verified",
  "verificationSpecId": "exact-counter-readback",
  "actionSequence": ["increment", "increment"],
  "requiredScreenshots": [],
  "completedScreenshots": [],
  "environmentId": "fixture-device-config-a",
  "modelConfigId": "none",
  "executionMode": "cold_setup",
  "coreId": "source-revision-or-wheel-sha256",
  "strategyId": "individual-calls",
  "result": {
    "status": "not_run",
    "verifiedOutcomeId": null,
    "verificationMethod": null
  }
}
```

`actionSequence` identifies the intended semantic actions, not just command names; use the same identifiers in both attempts. `verificationSpecId` identifies the unchanged required checks and success criteria. The tool also checks the recorded action-command sequence and count. Keep required screenshot IDs identical, record their completion, and record each actual capture through the CLI wrapper or a screenshot event. Do not silently omit checks or screenshots to make a candidate faster.

After independent readback or evidence review, set `result.status` to `passed`, `verifiedOutcomeId` to the observed outcome ID, and `verificationMethod` to `independent_readback` or `independent_evidence_review`. A successful command or completed plan alone does not justify those fields. Matching IDs and review results are evaluator declarations; the comparison tool cannot establish that they are truthful.

Generate each summary with its own manifest, then compare:

```sh
python scripts/performance.py summarize .harmony-agent/eval/baseline --manifest .harmony-agent/eval/baseline-manifest.json --output .harmony-agent/eval/baseline-summary.json
python scripts/performance.py summarize .harmony-agent/eval/candidate --manifest .harmony-agent/eval/candidate-manifest.json --output .harmony-agent/eval/candidate-summary.json
python scripts/performance.py compare .harmony-agent/eval/baseline-summary.json .harmony-agent/eval/candidate-summary.json --mode strategy
```

Use `--mode core` for the second experiment. Missing or mismatched task/configuration data (including cold/warm mode), different actions or screenshots, unverified outcomes, failed calls/runs, unattributed concurrent calls or mutations, incompatible clocks, unverified task-window timestamps or annotated manual waiting produce `not_comparable`, a null improvement value and exit code 2. Neither failed attempts nor human delays are silently subtracted. Keep recovery/failure trials and controlled timing comparisons separate.

A matched result reports an observed change in the named task/call window. It does not establish general agent performance, model-cost savings or multi-agent benefit. Review small differences against variation across repeated pairs. Keep raw recordings local; review matching metadata and aggregate summaries before sharing them.
