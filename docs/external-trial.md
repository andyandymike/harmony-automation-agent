# External human trial plan

Status: **NOT_RUN**. No participants are enrolled, no invitations have been sent,
and no trial results exist. This document defines a future trial; it is not
evidence that a new user has completed the workflow.

## Goal and acceptance

Run the same frozen candidate with at least **three independent human users**
who did not implement the project or participate in its internal agent trials.
Each participant uses their own fresh checkout and virtual environment, follows
the published instructions, and records their own attempts.

At least **two participants must complete installation and the entire core
device flow without maintainer repair**. Report the outcome for every enrolled
participant, including failures and missing prerequisites; do not remove failed
attempts from the count. Optional input results do not determine core acceptance.
A no-device installation result alone does not count as core completion.

A real independent participant may complete the workflow in `direct CLI` or
`Skill + Agent` mode using the public instructions. Either mode can count toward
the two completions without maintainer repair; there is no quota per mode.
Record the mode, agent use and human intervention, and report results by mode.
Internal subagents, prerecorded demonstrations and maintainer-run smoke scripts
cannot stand in for external human participants.

## Freeze the candidate and record the starting point

Before enrollment, the coordinator records one full source commit SHA, the
package version, the fixture source revision/contract, and the documentation
revision. Give each participant the repository URL, that SHA, this plan,
[README](../README.md), [compatibility guide](compatibility.md), and
[fixture instructions](fixture.md). Do not switch revisions during an attempt.

Record before starting:

- Participant code, prior Python/HarmonyOS experience, date and time zone.
- Host OS, Python and pip versions, shell, and chosen installation method.
- Trial mode; agent host/model and Skill revision when used.
- Whether this is a fresh checkout and venv; any preexisting project install.
- HDC/SDK/HarmonyOS/API versions, emulator or physical device, and fixture
  revision/HAP hash when available. Use a participant-local device alias in
  shared reports; keep the actual identifier private.
- Who prepared the SDK, authorized the device, signed/installed the fixture,
  and configured its input method, and whether these were already present.
- A time budget for each phase, agreed before the attempt. Exhausting a budget
  records an incomplete attempt; it must not silently reset the timer.

This plan starts the device phase with an **already authorized, unlocked device
and an installed, correctly signed fixture-v2**. Preparing those prerequisites
is a separate activity. An existing SDK, a maintainer-prepared emulator, or a
fresh Python venv does not demonstrate clean-host SDK setup or signing usability.
Participants without those prerequisites may complete phase A, but phase B
remains `NOT_RUN` with the reason recorded.

## Phase A: installation and CLI without a device

1. Clone the repository into a new directory, check out the supplied full SHA,
   and record `git rev-parse HEAD`. Follow the README to create a fresh venv and
   install from that checkout. Run its installed executable rather than using
   `PYTHONPATH=src` as a substitute for installation.
2. Run the commands below with that executable. On Windows it is
   `.venv\Scripts\harmony-agent.exe`; on POSIX hosts it is
   `.venv/bin/harmony-agent`. No HDC or device is needed for these checks.

   ```sh
   harmony-agent --version --json
   harmony-agent help --json
   harmony-agent schema --json
   ```

3. Confirm valid JSON, the expected package version and schema version, and
   usable command help. Preserve the command exit codes and any errors.
4. Choose a path verified not to exist, and use it explicitly for the following
   diagnostic. Replace the placeholder with that path; do not use a real HDC.

   ```sh
   harmony-agent doctor --hdc <nonexistent-hdc-path> --json
   ```

   Expected: the diagnostic command completes, but `data.ready` is `false` and
   the missing tool is identified. A successful envelope is not device readiness.

For `Skill + Agent` mode, follow [Skill setup](skill-setup.md) using the complete
Skill folder from the frozen checkout, or an installer URL pinned to the same
commit rather than moving `main`. After host discovery/refresh, ask the agent to
use the installed Skill and check the CLI version and schema without contacting
a device. Record which Skill was read, the CLI invoked, and the observed result.
This confirms the instruction/CLI entry point only. Direct CLI participants do
not need to install a Skill.

If a coordinator supplies a wheel instead, record its SHA256 and source SHA,
use the README's wheel installation path, and identify the attempt as a wheel
trial. Do not claim that it exercised source building. Network access for build
dependencies is allowed and must be recorded; runtime dependencies are separate.

## Phase B: core device flow

Use only the designated test device and fixture. The participant may consult the
README's command examples; this is a guided first-use trial, not a test of
discovering undocumented selectors. Use one new session and retain the same
working directory/state directory throughout. In `Skill + Agent` mode, the
participant supplies the selected device, fixture bundle and task goals, and
the agent may execute the flow. Record the participant's prompts, corrections
and manual interventions alongside the agent's commands and actual results.

| Task | Required evidence |
| --- | --- |
| Run `doctor --json` and `devices --json`; explicitly choose the designated device | `data.ready` is true; the selected device is unambiguous |
| Attach the session, open the fixture's `EntryAbility`, then observe | Commands succeed and a fresh observation shows the intended fixture with `READY` |
| Reset the counter and verify `Counter: 0`; increment once and verify `Counter: 1` | Both text conditions pass using `wait` or an action expectation, not only action acknowledgments |
| Capture a screenshot and open the returned local file | A readable image shows the fixture; record only a reviewed evidence reference |
| Detach the session | Detach succeeds; do not stop or reset someone else's device |

The [README action example](../README.md#act-and-verify) provides the
exact commands and bundle name. If visibility or another state prevents a step,
record the actual observation and the participant's recovery attempts. Do not
claim a pass solely because a command exited successfully.

After an unknown dispatch outcome or a failed output decode, observe the actual
state before deciding whether to retry. Never blindly repeat the increment.
Stop on an unexpected app, authorization dialog, or unresolved device selection;
record the prerequisite or documentation issue rather than bypassing it.

## Optional input phase

Only attempt input after the participant has configured the device's input
method and accepts the documented clipboard/partial-edit side effects. It is
experimental. Record standard and native-field results separately.

After phase B has detached, reattach a new session to the same designated device,
open the fixture, and observe before starting. Detach again when finished.

For each of `fixture.input` and `fixture.input.native`, use the documented `fill`
command to write `你好 Harmony 123`, replace it with `替换 XYZ 456`, then clear it.
After each operation, verify the exact TextInput value using a fresh observation
or explicit text assertion. After the first write, press `fixture.submit` and
verify `fixture.output` equals `Hello, 你好 Harmony 123`. Use UTF-8 JSON request
files, including `"text": ""` for clearing, when shell quoting is uncertain;
see [request examples](agent-requests.md).

The fields share app state, so record each field's starting value. Stop dependent
steps after a failure and mark them `NOT_RUN`; record onboarding separately.
Native-field success cannot replace standard-field failure. Native injection
does not test Pinyin composition, candidate selection, or general IME support.

## Assistance, timing and failure records

Keep an event log with time, participant question/error, helper, exact assistance,
files/configuration changed, and the next outcome. Record agent actions and the
participant's own interventions separately from these maintainer-help levels:

- `none`: no maintainer assistance; the participant may use the selected agent.
- `clarification`: a maintainer points to existing instructions without taking
  over, changing the environment, or supplying a missing corrective procedure.
- `repair`: a maintainer changes code/configuration, installs or fixes a missing
  prerequisite during the attempt, takes over commands, or supplies an
  undocumented workaround needed to finish. The attempt may finish, but it does
  not count toward the two completions without maintainer repair.

Record phase start/end times and elapsed wall time, pauses, command count,
failed commands, retries, and assistance time. Where captured, record CLI process
elapsed time and UTF-8 stdout/stderr byte counts separately. Use `not recorded`
for unavailable measurements. CLI time, human task time, bytes and model tokens
are different metrics; do not estimate one from another.

Classify each blocker using the evidence: `prerequisite`, `installation`,
`documentation`, `CLI defect`, `device/fixture`, `input method`, `user mistake`,
or `unknown`. Preserve the observed error before assigning a suspected cause.
If the candidate is fixed, retain the original result and run a separately
identified attempt against the new revision; do not overwrite the first failure.
Review logs/screenshots before sharing and keep private identifiers, signing
materials and unrelated application data out of reports.

## Copyable participant result template

```text
Participant code / experience:
Date / timezone:
Source SHA / docs SHA / package version:
Source install or wheel install / wheel SHA256 if applicable:
Host / Python / pip / shell:
Fresh checkout and venv / previous project use:
HDC / SDK / HarmonyOS/API / emulator or physical device:
Fixture source revision / HAP hash:
Prerequisites supplied by whom / preexisting SDK and IME setup:
Mode: direct CLI | Skill + Agent
Agent host/model / Skill revision and installed source, if used:
Agent actions / participant prompts, corrections and manual interventions:
Agreed phase budgets:

Phase A status: NOT_RUN | PASS | FAIL | INCOMPLETE
Phase B status: NOT_RUN | PASS | FAIL | INCOMPLETE
Core task results and evidence references:
Optional standard input: NOT_RUN | PASS | FAIL | INCOMPLETE
Optional native input: NOT_RUN | PASS | FAIL | INCOMPLETE
Skipped/not-run steps and reasons:
Unknown outcomes and recovery decisions:
Maintainer assistance events / highest assistance level:
Phase times / pauses / CLI time if captured:
Command count / failed commands / retries / output bytes if captured:
Observed blockers / suspected causes / evidence:
Qualifies as core completion without maintainer repair: YES | NO
Reason / reviewer:
```

Publish an aggregate only after reviewing the individual records: enrolled
humans, attempted installations, attempted core flows, core completions,
completions without maintainer repair, failures and `NOT_RUN` counts, plus
separate optional-input outcomes. Break down results by direct CLI versus
Skill + Agent mode and by maintainer-help level. Record mode changes and repeated
attempts, but count each person only once toward the participant and completion
thresholds. A small trial establishes only what these participants completed on
the recorded environments, not a general success rate.
