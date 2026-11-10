# Alpha6 local validation

Historical candidate: alpha7 supersedes this version after investigation found redundant capture and host work in its default execution path. Use [alpha7 validation](validation-alpha7.md) for the current performance correction.

Date: 2026-11-10. Candidate: `0.1.0a6`. This record covers the local execution candidate, not a stable release or general host/device compatibility. Earlier alpha results retain their original version and scope.

## Local regression and package result

On Windows with Python 3.12.10, the recorded alpha6 source passed **333 tests with zero skips**. Git's POSIX shell was explicitly made available for the shell-script check. All **14 isolated offline build/install checks passed**, including source/wheel parity, archive and RECORD integrity, package metadata, fresh-venv installation, import isolation, CLI/schema/error contracts and missing-HDC diagnostics. No build dependencies were downloaded.

The frozen wheel checked for this record is `harmony_automation_agent-0.1.0a6-py3-none-any.whl`, 64,261 bytes, SHA-256 `04152a85fd6e064474984364ae5dff8b783e5979708cdb2ffdea1fe5094b69e5`. It has no third-party runtime dependencies. This hash identifies that build, not later rebuilds of the same version. A fresh virtual environment does not establish clean-host SDK setup or compatibility with every agent host.

The complete six-file Skill passed its official structural validator, installed into a temporary project path containing spaces with byte-for-byte parity, and updated the existing local personal installation. Portable MCP JSON, agent-template frontmatter and the example plan were parsed and checked locally. No new hosted CI or public release is claimed.

## Implemented scope

- Deterministic semantic pages, exact original values and frozen-frame detail.
- Bounded declarative plans, fresh per-action guards, postconditions, final goals and cooperative budgets/cancellation.
- Device ownership across plan segments, durable step records, offline reports and evidence rechecking.
- Local stdio MCP, a command-enforced read-only evidence server, portable Skill installation and optional Copilot role templates.

The native runtime remains model-free. Visual grounding, event watchers, semantic deltas, autonomous recovery and model routing are not implemented by this candidate.

## Independent Agent acceptance

A fresh Agent received the source Skill, a CLI entry point for a synthetic device, and an outcome. It discovered the current page and selectors, replaced a note with Chinese text, incremented a counter from its observed value to the requested value, then checked both values using frozen evidence and the saved report. It had no implementation context, did not read internal state, and did not create a device-control helper.

The task used one plan with four high-level mutations and explicit before/after conditions, eight counted steps and twelve captures. It completed through eleven CLI calls including version/schema/help discovery, attach, observe, run, inspect, report and detach. Two nonblocking Skill ambiguities found in this acceptance were corrected: view-specific field names and budget accounting. This is one synthetic usability trial, not a general success-rate or model benchmark.

## Failure and evidence coverage

Regression coverage includes malformed unselected branches, stale selectors, unknown dispatch, failed postconditions, cancellation after dispatch, capture/deadline limits, checkpoint failure before/after action, run-ID reuse, cross-state-directory ownership, owner identity across device restart, persisted ref invalidation, frozen inspection after detach, and missing or inconsistent evidence. MCP checks include a real stdio subprocess, nested schemas, read-only rejection, cancellation and sequential request races. Installer checks include paths with spaces, full-package parity, locally modified files, upgrade conflicts and parent-path conflicts.

A Windows transient file-replacement denial was reproduced with synthetic local records: five failures in one 1,000-write sample. The fix retries only publication of the same prepared file for Windows access/sharing errors, with at most 250 ms of retry delay. A subsequent 1,000-write sample completed without errors. Permanent failures remain errors; this never retries a UI action. Dedicated fault tests cover bounded retry and unrelated I/O errors.

## Projection measurement

A synthetic 91-node tree using native-style blank structural nodes and default false states produced 40 semantic items after structural-noise filtering, compared with 91 before that refinement. The complete semantic JSON decreased from 45,355 to 25,942 UTF-8 bytes; the default item budget omitted zero items instead of eleven. Meaningful empty values, false states, anonymous controls and ancestor context were retained. This is a fixture-specific byte measurement, not tokens or end-to-end task speed.

## Acceptance boundaries

Local selected-device checks and their raw observations remain private and are not distributed as repository fixtures or sample-app scripts. They do not establish broad app/device compatibility. Public tests and examples use synthetic data.

Each agent integration still needs verification of Skill discovery, available tools and permissions, HDC access on the execution host, nested Unicode requests, run-status handling, cancellation, optional delegation and effective read-only tool restrictions. See [agent integrations](integrations.md) for supported integration paths and verification guidance.

There is no measured claim of end-to-end model latency or token-cost improvement. Plans reduce host dispatch boundaries while adding explicit guards, evidence persistence and local checking; device time can increase when those checks add captures. Compare equivalent tasks and include the existing compact-output baseline. External human trials and new hosted CI are separate from this local record.
