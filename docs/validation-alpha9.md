# Alpha9 local workflow execution validation

Candidate: `0.1.0a9`, 2026-11-11. This candidate addresses work at the agent/runtime boundary: session setup, repeated transfer of live UI values through the model, and large successful-step responses. The runtime remains model-free and uses the standard library.

## Architecture and correctness

- `start` combines attach/resume, a current page and the supported plan contract. It preserves an existing session's identity and ownership and performs one capture.
- `execute` accepts a complete known workflow with required initial preconditions and final goals. It connects or resumes, obtains the initial evidence within the run, executes, verifies and closes a successful session in one task call. Failed, uncertain or yielded work retains the session. Cleanup does not stop the device or replay actions.
- CLI `run` and `execute` accept `--plan-file` for a reusable raw UTF-8 plan. Device/session context stays in command arguments; omitted run IDs are generated per attempt. Invalid files, malformed plans and conflicting inputs are rejected before Agent construction. This is a CLI convenience, not a filesystem-reading MCP parameter.
- Version 2 plans read uniquely selected full-frame properties and bind them to later fills or conditions through closed `var`/`concat` expressions. Dynamic commands, selectors and arbitrary code are not supported. Version 1 remains available.
- Binding reads use the existing same-run freshness and budget rules. Missing, ambiguous, incorrectly typed or unexpected values stop later actions. They do not authorize retry or roll back earlier actions.
- `run.output: "decision"` aggregates successful receipts and normal control-flow outcomes after full evidence is saved. Final observations, declared goals, errors, uncertainty and recovery evidence remain available. Persistence failure keeps all receipts in the response. The default full response remains compatible.
- Saved-report inspection recomputes bindings from frozen frames, including literal prefix removal; missing or mismatched sources make the evidence check incomplete. This adds no device calls to execution.
- A small atomic workflow receipt records session cleanup separately from the original run. Report recovery distinguishes verified business completion from cleanup failure or unknown cleanup. A missing receipt never authorizes replay. The original run is saved once.

The current source passed **492 offline tests with zero skips** on Windows / Python 3.12.10. New tests cover dynamic values across changing pages, type and control-flow failures, prefix selection, session identity, decision projection, bound-value evidence checks, task cleanup, lost-response recovery and repeated plan-file execution with fresh IDs. Existing version 1, cancellation, unknown-dispatch, locking, input and report tests remain included.

Independent review caught a `start` projection that returned only a frame reference and an evidence check that omitted bound values. Both were corrected and tested before the paired agent trials. A further review distinguished normal false loop/branch conditions from failed assertions so decision output does not retain every successful-loop checkpoint as an error.

## Controlled local execution

A synthetic three-page workflow completed 27 high-level actions in one version 2 run. It read changing page values, filled them, reached each page's required count and verified all four final receipt conditions. It performed 33 captures inside the run plus one initial capture, compared with 36 total captures for the earlier three-run workflow. The decision response was approximately 10 KB; all underlying receipts and source frames remained available. There were no artificial device delays.

This exercise proves the local continuation mechanism and verification behavior, not user-visible latency. Agent trials separately include contract loading, program construction, result interpretation and task cleanup. Both configurations receive the same known page contract and unknown runtime data; ordinary shell or Python orchestration through the supplied CLI is allowed in both. The baseline is not forced to return after each page.

## Intermediate agent trials

Four independent single-agent contexts each performed a cold task and a continuation, using frozen source and guidance. Every task required the same 27 actions, three pages, changing IDs and values, and four final receipt checks. All eight completed without invalid actions. The baseline used three version 1 runs and 36 captures. The intermediate candidate used `start` and one version 2 run, with 34 captures.

These times begin at the **first tool**, ending at independent business verification. They omit preparation before the first tool and do not include session closure. They are not complete request latency.

| Pair | Mode | Baseline a8 | Intermediate a9 |
| --- | --- | ---: | ---: |
| 1 | Cold | 91.18 s | 56.86 s |
| 2 | Cold | 104.35 s | 59.21 s |
| 1 | Continuation | 60.03 s | 21.96 s |
| 2 | Continuation | **15.11 s** | 28.12 s |

The fastest baseline is valid and must be retained. Its agent generated an inline Python controller that validated each page, constructed literal version 1 plans and continued locally. It absorbed large CLI receipts locally and returned a small summary. The candidate still returned to the agent between `start` and `run`; in the second continuation this boundary cost about 12.38 seconds outside the tool, almost the entire 13.01-second difference. Total tool API windows were similar, about 4.32 and 4.36 seconds. The gap is not measured model-only time.

This result motivated `execute`: make the fast local task controller a supported runtime capability. It also exposed a timing bias: construction of the baseline's inline program preceded its first tool and was excluded. The final comparison therefore starts a shared monotonic clock immediately before task dispatch and ends only after independent business verification and session closure. Late bookkeeping and response generation remain outside that metric.

## Existing-workflow migration, including preparation

The same four independent agent contexts then received changed live values and IDs. Existing sessions were attached before timing. Baseline agents could reuse their prior work or write local controllers; candidate agents could adapt their prior version 2 plans to `execute`. Tasks ran sequentially, in baseline/candidate/candidate/baseline order. Each endpoint independently checked the three receipts, absence of invalid actions and session closure. All four passed with 27 actions; saved evidence and device ownership were inspected separately.

| Pair | Baseline a8 | Candidate a9 | Baseline / candidate outer groups |
| --- | ---: | ---: | ---: |
| 1 | 86.36 s | 98.10 s | 2 / 7 |
| 2 | 90.15 s | 87.39 s | 2 / 5 |

**This comparison does not show a consistent agent-level speed improvement.** It includes the parent clock-to-dispatch interval, preparation before the first tool, document reads, request construction, execution and independent completion verification. It does not include final bookkeeping or response prose. The endpoint is deliberately different from the earlier first-tool measurement; the values must not be compared across those tables as speedups. Instrumented outer group counts are not provider model-round counts.

For the first baseline, the first tool began about 21.00 seconds after the parent timestamp; another 61.26 seconds elapsed between reading the task and invoking its locally constructed controller. The complete controller tool window was 3.65 seconds. The second baseline used compact CLI responses; the first's larger local output was an agent choice, not an inherent baseline cost.

The first candidate made four separate document reads and a schema lookup before executing its reused plan. Three of those document reads repeated already supplied facts; the actual uncertainty was the app-scoping selector field. Its `execute` process took 1.07 seconds, but those preparation boundaries outweighed the local execution gain. The second candidate also queried the new command schema. These are migrations to a newly introduced entry point, not proof of the steady-state cost of a prepared workflow.

All four runs preserved required business outcomes, but the agents did not choose identical optional initial assertions: the second candidate checked the app, first stage, zero count and required count without separately asserting the old input text. Both baselines and the first candidate also checked that old text. Input replacement still verified the new value. This limits a claim that every assertion was matched exactly; it does not invalidate the observed business completion. Reports verified all bound values, and all four sessions and ownership files were absent after completion.

The resulting follow-up is concrete: provide a direct plan-file entry with automatic run IDs, show the missing app-scoping example, and reuse validated workflow artifacts without rebuilding request envelopes or routinely reloading their schema. A cached-workflow measurement must compare equally prepared artifacts on both sides and must remain separate from agent task latency.

## Prepared workflow execution

Ten alternating pairs compared the valid compact baseline controller with the first candidate's validated plan, using the direct plan-file CLI entry. Both started with an attached session and reset synthetic business state. Artifact preparation and fixture reset/attachment were outside timing; program startup, local setup, CLI execution, exact UI checks, session closure and an independent checker were inside. Every pair used changed IDs and runtime values. One declared smoke pair preceded the ten measured pairs and was excluded from the aggregate.

All 20 measured tasks passed, each completing 27 actions without invalid actions. The candidate was faster in all ten pairs.

| Measurement | Prepared baseline a8 | Prepared candidate a9 |
| --- | ---: | ---: |
| Whole local program median | 3.819 s | 1.803 s |
| Observed range | 3.509–4.578 s | 1.649–2.027 s |
| CLI processes | 5 | 1 |
| Captures | 36 | 33 |
| CLI output median | 44,399 bytes | 8,383 bytes |
| Recorded run/execute core time, median | 0.648 s (3 of 5 CLI calls profiled) | 0.898 s (1 of 1 profiled) |

The median reduction calculated per matched pair was 51.41%. The whole prepared task benefited from fewer process and orchestration boundaries and smaller responses. The recorded core total was higher for the candidate, but baseline profiling omitted its initial observation and detach; the totals do not establish a complete core-only speedup or slowdown. This comparison changes the prepared strategy and core together; it does not isolate their individual contributions. These measurements include the same optional per-CLI recording wrapper on both sides, whose repeated process cost can enlarge the apparent gain. They are not direct-production latency, agent completion time, model time, token usage or real-device measurements.

### Direct CLI follow-up: primary prepared-execution result

Five additional alternating pairs removed the per-CLI recorder process from both configurations. Both prepared programs called the real CLI parser and frozen runtime directly, with an injected synthetic transport. Their plans, arguments, checks and warm attached starting condition remained the same. The outer clock still included program launch, local setup, output handling, exact UI validation, session closure and the independent checker. New case directories and changed page values/IDs kept the earlier measurements intact.

| Direct CLI measurement | Prepared baseline a8 | Prepared candidate a9 |
| --- | ---: | ---: |
| Whole local program median | **2.800 s** | **1.618 s** |
| Observed range | 2.740–3.077 s | 1.563–1.637 s |
| Actions per task | 27 | 27 |
| Captures per task | 36 | 33 |

All ten tasks passed the independent business and session-closure checks, with zero invalid actions. The candidate was faster in all five pairs; the median reduction per pair was **42.22%**. The improvement therefore persists without the recorder wrapper. This is an actual wall-time reduction for a prepared local workflow, including its verification and cleanup. It excludes artifact construction, agent/model/host scheduling, fixture reset and initial attachment, and real HDC/device latency. It does **not** establish an overall agent-task speedup. Both the strategy and runtime changed, so this is a complete prepared-path comparison, not a causal core-only benchmark.

## Package checks

The final candidate passed 14 offline build/install checks in a fresh isolated environment, including wheel/source byte parity, metadata, entry points and validation before unavailable-device access. The wheel contains no third-party runtime dependencies. Version `0.1.0a9`, wheel size 73,757 bytes; SHA-256 `d17aac795d937de0c2b828c3eb6aa3526b374fd6fae0d9446f0cde46aa5c899b`. The local installed CLI and personal Skill were updated from this candidate. This is not a PyPI or GitHub release.

## Validation boundaries

This is a local candidate, not a hosted-CI, physical-device or target-host acceptance claim. Native capture latency, unknown-page exploration, screenshots, user decisions, model-only latency and provider token usage require their own evidence. Full user-visible time also includes work before the first tool and after the last recorded milestone.

Raw trial programs, requests, traces, fixture state and outputs remain in ignored local directories. Public examples and tests contain synthetic data only.
