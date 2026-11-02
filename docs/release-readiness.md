# 0.1.0a2 release readiness

Updated: 2026-11-03. This is a local development candidate, not a public v0.1 release. The six work packages below consolidate implementation, validation and distribution work without counting the same check multiple times.

Status meanings: **done** has a recorded result; **partial** has useful work completed but a named acceptance gap; **pending** has no completed result. A previous-version result is historical evidence, not acceptance of new code.

| Work package | Status | Completed evidence | Remaining acceptance |
| --- | --- | --- | --- |
| Input loop | done for recorded emulator cases | Six Chinese fill/replacement/clear readbacks passed on standard/native TextInputs after IME setup; complete smoke includes native input and submit/readback, with 40 passed steps, 0 failures and 1 skip | Ordinary-IME independent suite, keyboard composition, physical devices and other combinations remain outside this accepted scope |
| Lightweight Skill | partial; installation blocked | CLI schema, [agent usage](agent-usage.md) and [operating guide](agent-operating-guide.md) are available as ordinary project documents | Personal Skill installation did not complete in this environment; do not claim an installed Skill or equate agent-guide tests with installation |
| Agent acceptance and benchmark | done for the two recorded internal batches | Two fresh agents completed ten specified tasks; final state and recorded fresh observations were checked independently; a simulated lost receipt led to observation rather than a repeated press | Single fixture/emulator evidence; output token use was not available. First-run wrapper and PowerShell decoding issues are retained in the report |
| Installation and compatibility | done for recorded local check | The 0.1.0a2 offline release checker completed 14 checks using a new venv; [compatibility matrix](compatibility.md) exists | The frozen artifact's final report is authoritative; clean host/SDK and physical-device validation remain separate checks |
| External human trial | pending | Trial design is documented in the project plan | At least three independent users, with at least two completing the core flow without maintainer repair; no invitations have been sent |
| Open-source release preparation | partial | MIT file for original code, contribution guide, issue template, CI definition, source attribution and package-name lookup | Resolve fixture license boundary, execute hosted CI, choose remote destination and distribution channel, retain source revision/build hashes; no public release has been made |

## Evidence map

| Evidence | Scope |
| --- | --- |
| [Alpha2 validation](validation-alpha2.md) | Current regression, device, agent and installation results; includes actual failed attempts and remaining limits |
| [Alpha2 device summary](validation-device-smoke-alpha2.json) | 40 passed steps, 0 failures, 1 skipped independent ordinary-IME suite |
| [Alpha2 input record](validation-input-alpha2.json) | Six separate standard/native input checks passed |
| [Alpha2 agent record](validation-agent-alpha2.json) | Ten tasks, command/byte/timing metrics, reply-loss recovery and first-run issues |
| [Alpha2 frozen package](validation-release-alpha2.json) | Fourteen offline build/install checks and the exact wheel hash |
| [Alpha1 validation](validation-alpha.md) | Historical offline, package and emulator outcomes; includes input failures and limitations |
| [Alpha1 device summary](validation-device-smoke.json) | Historical per-step pass/fail/skip and elapsed times |
| [Compatibility](compatibility.md) | Tested versus untested host/device/API combinations and protocol boundaries |
| [Source provenance](source-provenance.md) | Original/reused code, exact upstream revision, repository and registry checks |
| [Agent usage](agent-usage.md) | Observation, action, assertion and recovery rules |
| [Agent operating guide](agent-operating-guide.md) | Ordinary project guide used for independent tasks; not an installed Skill |

The alpha2 offline regression count is 147 passed tests. Use the current validation report for completed task-batch counts and the frozen package report; never fill an alpha2 result from alpha1's count or timings. Agent subtask trials can measure agent usability, but they do not replace independent human installation trials.

## Local release checks

The candidate should be built with a pinned source revision and tested in a new virtual environment. Separate no-device contract checks from device execution. A successful wheel build does not prove SDK discovery, emulator startup, signing or device authorization on a new host.

For a machine-readable check, use `python scripts/release-check.py --help` and the options supported by that revision. The release checker must use the selected local toolchain, avoid implicit registry dependency downloads in offline mode, and report skipped or unavailable checks explicitly.

Before publishing, require current-version offline tests, exact package/version metadata, JSON/error examples, a device acceptance report for the claimed combination, package-content inspection, updated quick starts, known limitations, source attribution and external-trial records. Hosted CI and public distribution stay pending until they actually run.
