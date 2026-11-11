# Alpha8 call strategy and measurement validation

Candidate: `0.1.0a8`, 2026-11-11. This candidate improves the portable calling instructions, fixes interface inconsistencies, and adds measurements for investigating agent overhead. It does not establish a general end-to-end performance improvement.

## Local checks

The current source passed **407 offline tests with zero skips** on Windows / Python 3.12.10. Git's POSIX shell was available for its shell-script check. Tests cover the existing execution contract plus top-level `run.interactive`, final-command overrides, semantic-view boundaries, target-versus-condition reuse counts, optional capture profiling, documented command examples, host/milestone interpretation and performance-record comparisons.

All **14 isolated offline build/install checks passed**. The checked wheel is `harmony_automation_agent-0.1.0a8-py3-none-any.whl`, 64,540 bytes, SHA-256 `054c53972a0059a83b00da43946035c86f5eb6a2d9f923e8868572759a58c4f6`. This checksum identifies this exact build; later README or source changes require a new package check. No third-party runtime dependencies were added.

The complete Skill passed structural validation. Maintained CLI examples are parsed by the actual command parser without a device, and JSON request/plan examples are validated against the command contract. These checks catch the earlier incorrect `report --run-id` example; the CLI uses `report RUN_ID`.

## Independent single-agent strategy pilot

Four fresh agents completed two paired synthetic tasks. Every attempt used the same frozen `be82e69` execution core and persistent synthetic transport, without artificial device delays. Only the supplied Skill differed: the baseline Skill at that revision or the revised Skill. Agents received the goal and exact synthetic device, discovered selectors through the CLI, and could write request JSON. They were not given implementation context, hidden state, selectors or future-page answers.

The host inherited the same model configuration for all four agents. Provider token usage, model-only latency and the exact model configuration identifier were unavailable. This was a local host trial, not validation of another agent product or a physical device. No specialist agents were delegated within a task.

The first task replaced a note and advanced a visible counter, requiring five high-level actions on one known page. The second required six actions across a form and an unfamiliar confirmation page; the agent needed to read the new page before completing it. Neither task required a screenshot. Order was baseline then revised for the first task, and revised then baseline for the second.

| Task | Skill | CLI calls | Runs | Actions | Captures | First-to-last CLI window |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Known page | Baseline | 7 | 1 | 5 | 10 | 39.407 s |
| Known page | Revised | 7 | 1 | 5 | 10 | 48.523 s |
| New-page boundary | Baseline | 8 | 2 | 6 | 13 | 72.489 s |
| New-page boundary | Revised | 8 | 2 | 6 | 13 | 62.062 s |

All four attempts completed the requested final state, passed independent inspection of the synthetic state and saved evidence, and detached. There were no failed commands or unexpected synthetic actions. Both Skills used one plan for the known-page task and two plans for the task with a new-page boundary. The revised Skill did not reduce CLI calls or captures in this pilot.

The windows above include recorded CLI processes and the gaps between them, but exclude initial instruction loading before the first CLI call and final response preparation after the last call. They are UTC observations from this pilot, not independently attributed model durations. The synthetic fixture has no device latency; profiled run core times were only about 0.14–0.17 seconds per task. The process total per attempt was about 2.2–2.5 seconds. These absolute times do not predict real-device task times.

There was only one sample per task and Skill. One revised attempt took longer and the other took less time, with identical call/action/capture counts. This is useful functional evidence for batching and stopping at an unfamiliar page, **not evidence of stable speed or token savings**. It also shows that the older Skill could already produce efficient batches for these simple tasks. A different host's one-action plans cannot be attributed to Skill wording from this pilot alone.

## Longer tasks and continuing in one session

A second exploratory pilot used three unfamiliar pages, 27 high-level actions and 120 informational background nodes per page. Two independent agents each received one frozen Skill version and the same frozen alpha7 core. Each first completed a cold task and then continued in its existing context and attached session after the evaluator reset the synthetic business state. The later pages used changed selectors and confirmation strings, so the continued task still required current UI evidence. Trial order was baseline cold, revised cold, revised warm, baseline warm. There was one attempt per condition, with no artificial device delays or required screenshots.

After these four attempts, the revised agent completed one additional organizational probe with an instruction to write each prepared request and execute it within the same shell invocation. Its attached session was restored before the probe; the later pages changed again. This additional probe reused a practiced agent and is not another independent sample. The instruction is now included in the portable Skill.

| Skill / condition | Outer tool calls | Nested shell calls | CLI processes | First tool entry to independent verification | First tool entry to task cleanup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline / cold | 7 | 8 | 9 | 91.191 s | 97.154 s |
| Revised / cold | 7 | 11 | 8 | 86.006 s | 93.207 s |
| Baseline / continuing | 6 | 6 | 5 | 48.103 s | 60.903 s |
| Revised / continuing | 6 | 9 | 5 | 57.256 s | 70.178 s |
| Revised + combined write/invoke / continuing probe | 6 | 6 | 5 | 51.208 s | 63.188 s |

Every attempt completed three plans, 27 high-level actions and 36 captures, with correct final receipts, one successful independent verification and zero invalid synthetic actions. Cold tasks intentionally retained their session for continuation; continued tasks detached during cleanup. All recorded CLI intervals mapped to a unique nested tool API interval. Outer-call counts came from the executing agents' review of their actual call groupings, not an automatic host trace or an inference from CLI counts.

The revised agent had already grouped its separate request write and CLI invocation inside one outer tool call, awaiting two nested shell calls. Combining those shell calls reduced their count from nine to six in the additional probe, but **outer calls stayed at six**. It did not remove three model round trips. The baseline agent already combined writing and execution. There is no evidence here that the revised Skill consistently outperforms the baseline.

The table uses explicitly recorded UTC annotations around local tool API calls and an independent checker. It excludes initial thinking before the first tool, final logging flush and final response preparation; it is not complete user-visible task latency. External annotations do not have a shared verified monotonic clock. Model-only time and usage remain unavailable. Run-core totals were approximately 0.53–0.57 seconds, and measured nested tool API occupancy was approximately 5.6–9.2 seconds per task. Remaining time is unattributed, not automatically model thinking.

Cold versus continuing is a combined context/setup/session condition, not a measurement of one cache. Both versions omitted repeated setup calls when continuing. The independent outcomes were identical, but agents chose different projection budgets and check placement; the additional probe also returned a smaller initial observation. One sample per condition, practice, output differences and unmeasured host behavior prevent a causal speedup or token-cost claim. The useful findings are the separate CLI/inner-tool/outer-tool counts, retained setup knowledge and verified page boundaries.

## Timing and transport boundaries

Capture profiling reuses the existing HDC subprocess and command. Tests verify identical call counts with profiling enabled or disabled, including failure/cleanup paths. The measured buckets are HDC process time, host decoding/validation, receipt validation and layout parsing/validation. Native export and transfer are still individually `null`; the single-call path does not measure them separately.

A local synthetic transport exercise processed the same 905-node layout through the previous and current transport implementations. Each performed 560 captures and 560 simulated HDC calls. Per-capture medians were approximately 3 ms in this environment. This confirms no extra capture/transport call was introduced; it does not establish a device performance improvement or a precise instrumentation overhead estimate.

`reusedFrames` remains compatible with earlier output. New target-request and condition-request counters separate their reuse; `beforeConditionChecks` records comparisons on an already acquired frame and is not an additional reuse or avoided-capture count.

## Recording and paired comparison

The [performance guide](performance.md) describes the source and installed-wheel recording paths. The recorder forwards the actual command response without replaying it. Summaries keep core coverage, process time and unattributed gaps separate, and do not add nested profile stages together.

Independent review found and corrected two measurement errors before delivery: UTC jumps between calls could create a false speedup, and guard-frame reuse for `open`/`back` could be mislabeled as target reuse. Regression tests now reject inconsistent wall/monotonic clock evidence for comparison and distinguish condition reuse from target reuse. Legacy duration-only records remain usable for totals without inventing a timeline.

The extended event review also caught failed verification events being treated as successful, inconsistent milestone ordering and missing legacy output byte counts being reported as zero. These cases now preserve failure/unknown status, block contradictory comparisons and report unavailable counts as null with coverage. The recorder uses a single high-resolution monotonic counter for process start/end and elapsed time. Existing lower-resolution recordings remain supported with an explicit compatibility tolerance.

The public summary tool processed all five longer-task recordings, preserving absent final-response timings and unmeasured model rounds as null. It correctly refused a matched speedup result without an exact model-configuration identity. A separate no-device smoke recorded 12 real CLI invocations, including four concurrent reads, and verified host association and interval accounting.

Matched comparisons require declared task/initial-state/outcome/verification identities, equal semantic action sequences and recorded action counts, matching required screenshots, independent final verification, and fixed environment/model configuration. The `strategy` mode holds the core fixed; the `core` mode holds the strategy fixed. Incomplete or inconsistent matches return `not_comparable` with no speedup percentage. Metadata and verification declarations still need honest independent review; the tool cannot prove them true.

## Remaining validation

No new native-device test, hosted CI run or target-host acceptance is claimed for this candidate. The recorder is ready to measure the actual host workflow with matched tasks; screenshots, request construction, analysis, scheduling and human waits need their own recorded intervals before attribution. Model latency and token use remain unknown when the host does not expose them. Multi-agent performance and any benefit from switching transport or agent configuration remain unproven.

Raw trial requests, output, helper scripts and state remain in ignored local directories. Public tests and examples use synthetic data only.
