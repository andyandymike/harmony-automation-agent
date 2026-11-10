# Alpha7 performance correction

Candidate: `0.1.0a7`, 2026-11-10. Alpha6 added useful execution features but increased native work in an equivalent short task. Fewer host calls alone did not establish a performance improvement. This candidate changes the execution defaults and removes measured redundant work.

The recorded alpha7 source passed **359 tests with zero skips** on Windows / Python 3.12.10, including the new performance-path and compatibility regressions. Git's POSIX shell was available for the shell-script check. Local source checks do not substitute for new hosted CI or validation in other host/device environments.

All **14 isolated offline build/install checks passed**. The frozen wheel checked for this record is `harmony_automation_agent-0.1.0a7-py3-none-any.whl`, 66,558 bytes, SHA-256 `f214ddd39458f2273f48c0180b9e3403c8cf10a2138c4423be1dbbaddc093827`. It has no third-party runtime dependencies. The local CLI and complete user-level Skill were updated to this version; installation does not establish SDK compatibility or tool availability in other agent hosts. This checksum identifies the recorded artifact. Later builds, including builds after README or metadata changes, require a new checksum and package check.

## Documentation refresh

After reorganizing the public README and installation/integration guides, the package was rebuilt on 2026-11-10 UTC. All 14 isolated offline build/install checks passed again. The refreshed wheel has the same filename and version, is 63,568 bytes, and has SHA-256 `8e2b41ae7ae41d450bf053af916e90070f375c5a119cc67fc5a93374d4e9f4a7`. Its 14 Python runtime modules are byte-identical to the earlier wheel above; the README embedded in package metadata changed. The current source also passed all 359 offline tests again with no skips. This refresh does not represent a new device or agent-host validation.

## What was unnecessary

| Work in alpha6 | Alpha7 behavior |
| --- | --- |
| Capture a top-level precondition, then immediately recapture for the first target | Reuse the published frame within the same run for at most 1,000 ms |
| Capture a successful postcondition, then immediately recapture for the next target or before condition | Reuse that result; capture again after invalidation/expiry or explicit step `refresh` |
| Enumerate devices and query boot identity before every local step | Check once at run entry, plus explicit refresh steps; keep exact HDC target arguments |
| Generate a public page projection after each step, then discard it in the plan summary | Project the final page once |
| Rewrite complete session frames around every action | Keep on-disk refs invalid during the run, publish final state at exit |
| Stream JSON token by token and store the same node objects in several indexes | Serialize once per write and store node references in frozen indexes |
| Return a full saved page and duplicate step copies in every report | Return receipts and frame references, with `--full` available |
| Include every shared schema definition in every MCP tool | Include only the referenced definition closure |

Conditions themselves are inexpensive local comparisons. Add `before` when a business context condition matters, not as a ritual before every navigation action. Explicit `expect` conditions still stop the plan on failure, and `fill` still verifies input. Omitted expectations are marked `not_requested`; final goals remain distinct from execution completion.

Recent-frame reuse is a freshness tradeoff, not proof that an asynchronous app is static. It is limited to a successfully published frame in one uninterrupted run; no earlier CLI/model-turn frame qualifies. A mutation's `refresh: true` requests a new capture and device check. See [execution](execution.md) for the exact contract.

## Synthetic measurements

These tests used local temporary files and fake transport, not a connected app or model service. They isolate host costs rather than estimating end-to-end task performance.

- On the same six-step, 905-node task, retaining seven captures and all goals/evidence checks, old serialization/full-frame storage took a median 903.64 ms. One-shot JSON with indexed frozen storage took 299.51 ms over three samples. Frozen evidence decreased from 6,329,225 to 4,195,709 bytes without dropping nodes or frames.
- The same saved task report decreased from 47,624 to 9,100 bytes by omitting presentation copies. Seven receipts, seven frames and evidence-check results remained. Report reading stayed approximately 72–73 ms; the change reduces output, not the measured verification time.
- A 901-node page produced about 22 KB as a compact tree and 51 KB as a semantic view at the same nominal item budget. Semantic context is useful when needed, but is not a general compression strategy; run output now defaults to the compact tree.
- Removing unused definitions reduced one measured full MCP tool catalog from about 93 KB to 49 KB, and its read-only catalog from about 12 KB to 4 KB. Input contracts and referenced definitions were retained. Exact sizes can change with added fields.
- Offline schema calls measured approximately 135 ms per new CLI process versus 0.53 ms per request after a persistent MCP process initialized. This does not estimate model latency, device command time or agent-host scheduling.

Local device comparisons retained declared conditions and final outcome checks, varied execution order and recorded capture counts separately from wall time. Raw runs and app-specific request files stay in the ignored local directory and are not distributed. No general app success rate, token savings or end-to-end agent latency is inferred from these local samples.

## Retained behavior and remaining checks

Regression coverage includes recent-frame expiry, no reuse across calls, explicit refresh, optional versus requested assertions, input readback, durable invalid refs throughout a run, final session-write failures, uncertain dispatch, cancellation, missing evidence, compact/full report parity, old/new frozen-frame compatibility and MCP schema closure.

New indexed frozen frames require alpha7 or later to read; older records remain readable. Session storage remains compatible with alpha5/6. Use the matching package and Skill. Follow the [installation guide](installation.md) for environment setup and [agent integrations](integrations.md) for host-specific verification. Actual tool permissions, automatic Skill discovery and end-to-end model costs require results from the selected integration.
