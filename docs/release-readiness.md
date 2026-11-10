# Release readiness

The current `0.1.0a7` performance-correction candidate is unreleased. It removes repeated reads, serialization and output work from alpha6's execution layer. See [alpha7 validation](validation-alpha7.md) for recorded checks and remaining host/device validation. The [alpha6 record](validation-alpha6.md), alpha5's 224 offline tests and 14 local package checks, the [alpha3 core-fix record](validation-alpha3.md), and alpha2 publication/CI/device evidence remain historical and version-specific.

Updated: 2026-11-10. The alpha source is now public on GitHub; it is not a stable v0.1 release. The six work packages below consolidate implementation, validation and distribution work without counting the same check multiple times.

Status meanings: **done** has a recorded result; **partial** has useful work completed but a named acceptance gap; **pending** has no completed result. A previous-version result is historical evidence, not acceptance of new code.

| Work package | Status | Completed evidence | Remaining acceptance |
| --- | --- | --- | --- |
| Input loop | done for recorded emulator cases | Six Chinese fill/replacement/clear readbacks passed on standard/native TextInputs after IME setup; complete smoke includes native input and submit/readback, with 40 passed steps, 0 failures and 1 skip | Ordinary-IME independent suite, keyboard composition, physical devices and other combinations remain outside this accepted scope |
| Lightweight Skill | done for source, local installation and offline explicit use | Complete portable [Skill](../skills/harmony-agent/SKILL.md), [setup guide](skill-setup.md), local installation and independent offline Agent check; [delivery evidence](skill-delivery-2026-11-10.md) | Fresh-turn automatic selection and new device tasks through this installed Skill are not established by offline checks |
| Agent acceptance and benchmark | partial; two internal task batches completed | Two fresh agents completed ten specified tasks; final state and recorded fresh observations were checked independently; a simulated lost receipt led to observation rather than a repeated press | Single fixture/emulator on the earlier source; not a broad success-rate benchmark. Output token use was unavailable and one command timing was missing; the installed Skill has only separate offline checks |
| Installation and compatibility | partial; offline package checks completed | Local fresh-venv build/install checks and hosted Windows/Ubuntu package jobs passed; [compatibility matrix](compatibility.md) exists | A fresh venv is not a clean host/SDK. SDK setup, signing and physical-device validation remain separate checks |
| External human trial | pending; plan now written | [Executable plan and result template](external-trial.md) added on 2026-11-10; no participants or results | At least three independent human users, with at least two completing the core flow without maintainer repair; CLI and Skill + Agent modes are recorded separately; no invitations have been sent |
| Open-source release preparation | done for GitHub alpha source | Root and fixture licenses unified under MIT with owner authorization; source pushed to public `main`; all six hosted CI jobs passed; revision and build hash in the [publication review](publication-review-2026-11-10.md) | Stable-release trials remain separate; no GitHub Release or package-registry release has been made |

## Evidence map

| Evidence | Scope |
| --- | --- |
| [Alpha2 validation](validation-alpha2.md) | Historical 2026-11-03 regression, device, agent and installation results; includes actual failed attempts and remaining limits |
| [Alpha6 validation](validation-alpha6.md) | Historical local execution, Skill, protocol and package acceptance before performance correction |
| [Alpha7 validation](validation-alpha7.md) | Performance correction, regression coverage and package checks; local raw device evidence is excluded |
| [Alpha2 device summary](validation-device-smoke-alpha2.json) | 40 passed steps, 0 failures, 1 skipped independent ordinary-IME suite |
| [Alpha2 input record](validation-input-alpha2.json) | Six separate standard/native input checks passed |
| [Alpha2 agent record](validation-agent-alpha2.json) | Ten tasks, command/byte/timing metrics, reply-loss recovery and first-run issues |
| [Alpha2 frozen package](validation-release-alpha2.json) | Fourteen offline build/install checks and the exact wheel hash |
| [Alpha1 validation](validation-alpha.md) | Historical offline, package and emulator outcomes; includes input failures and limitations |
| [Alpha1 device summary](validation-device-smoke.json) | Historical per-step pass/fail/skip and elapsed times |
| [Compatibility](compatibility.md) | Tested versus untested host/device/API combinations and protocol boundaries |
| [Installation](installation.md) | CLI installation, environment setup and verification on a new host |
| [Agent integrations](integrations.md) | CLI, Skill and MCP integration options and host-specific verification |
| [Source provenance](source-provenance.md) | Original/reused code, exact upstream revision, repository and registry checks |
| [Agent usage](agent-usage.md) | Observation, action, assertion and recovery rules |
| [Agent operating guide](agent-operating-guide.md) | Stable link to the canonical, portable Skill workflow |
| [Skill delivery](skill-delivery-2026-11-10.md) | Source, installed-copy parity, explicit offline Agent use and package checks; not a new device test |
| [External trial plan](external-trial.md) | Procedure and empty report template; not evidence of executed trials |

The original alpha2 offline regression count was 147 passed tests. The [2026-11-10 publication review](publication-review-2026-11-10.md) records 150 after the scroll validation fix. The original device results and frozen wheel remain historical evidence and were not rerun or relabeled for the new source. Agent subtask trials can measure agent usability, but they do not replace independent human installation trials.

The repository includes a complete portable Skill package and recorded installation checks. Skill source, installed-file parity, host discovery and device execution remain separate validation steps. The six packages have different acceptance scopes; completed fixture samples or package checks do not make external trials, a clean SDK setup or broad device support complete.

## Local release checks

The candidate should be built with a pinned source revision and tested in a new virtual environment. Separate no-device contract checks from device execution. A successful wheel build does not prove SDK discovery, emulator startup, signing or device authorization on a new host. Recorded wheel hashes identify the exact checked artifacts; later builds of the same version, including builds after README or metadata edits, need their own artifact checks and hashes.

Alpha5 accepts valid older session files and migrates stored frames on save. The indexed format is not readable by alpha4; detach the session before downgrading, then attach and observe with the selected older version. See [protocol and version handling](compatibility.md#protocol-and-version-handling).

For a machine-readable check, use `python scripts/release-check.py --help` and the options supported by that revision. The release checker must use the selected local toolchain, avoid implicit registry dependency downloads in offline mode, and report skipped or unavailable checks explicitly.

For alpha source publication, record current offline tests, package/version metadata, JSON/error examples, package-content inspection, quick starts, known limitations and source attribution. Tie device claims to their recorded source and environment; source publication does not establish new device acceptance. External human trials remain a separate stable-release acceptance item. The [publication review](publication-review-2026-11-10.md) records the completed GitHub source push and hosted CI; package-registry publication remains unperformed.
