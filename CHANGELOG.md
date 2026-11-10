# Changelog

## 0.1.0a4 — local development candidate, 2026-11-10

- Recover native display strings stored in `originalText` when a non-editable node has empty/missing `text`. Preserve the original field and expose fallback provenance through `textSource`; recovered strings participate in facts, find, selectors, text conditions and diffs.
- Preserve native input text/readback behavior for editable controls and known input types. Retain existing nonempty `text` without trimming or replacing it.
- Reject actions through a selected child when an observed ancestor is explicitly hidden or disabled. Keep node structure and exact-target behavior; no label aggregation or automatic ancestor switching is introduced.
- Clarify in the portable Skill that a complete returned tree does not guarantee every visible string was exposed. Diagnose missing content by comparing native raw data before attributing it to the application.
- Validate with 201 offline tests and 14 isolated package checks.

## 0.1.0a3 — unreleased core fixes, 2026-11-10

- Reject frame-dependent `wait`/`expect` selectors before dispatch, including parent references and nested `within`. The request schema now describes stable condition selectors separately.
- Rebind current-frame target references against a fresh observation and recheck every selector predicate. Preserve valid parent/within reference targets; reject stale or changed conditions.
- Respect explicit `editable=false` before any input preparation. Retain the existing automatic-scroll actionability fix and its tests.
- Limit public diffs to displayed nodes and one shared change budget; expose filtering, omissions, completeness and both frame IDs. Ambiguous duplicate identities no longer imply confirmed additions/removals.
- Allow local `detach` recovery of damaged sessions while retaining artifacts. Distinguish read I/O failures from corrupt data, validate persisted frames, and reject Windows reserved session names.
- Preserve operation IDs and acknowledged action details if saving invalidated refs, collecting evidence or writing traces also fails.
- Keep package version separate from alpha2's published source and historical device results. Current offline/package checks and unavailable-device status are in [the alpha3 validation record](docs/validation-alpha3.md).

## Portable Skill delivery — 2026-11-10

- Added the complete `skills/harmony-agent/` package, including frontmatter, workflow, request/outcome references, Agent metadata and MIT license. Existing guide URLs forward to the maintained Skill resources.
- Added public installation instructions and links from both READMEs; updated the existing maintainer installation from the same source.
- Validated structure, reference closure, installed-file parity, JSON examples, an independent Agent's offline decisions and a new isolated wheel build/install. See [Skill delivery](docs/skill-delivery-2026-11-10.md).
- Corrected the six-package readiness record and added an executable external-user trial plan. External trials, fresh device testing and clean-host SDK validation remain incomplete.

## GitHub alpha source publication — 2026-11-10

- Fixed automatic scroll-container selection bypassing the existing actionability checks. A disabled or zero-area container now fails with `TARGET_NOT_ACTIONABLE` before dispatch, matching an explicitly selected target.
- Added regression coverage for rejected containers and single-dispatch scrolling in all four directions. The offline suite now passes 150 tests; no device execution was performed for this change.
- Added repository installation steps and package project links, expanded private/local-file ignore rules, and updated public-facing alpha documentation.
- Unified the fixture scaffold/resources and module metadata under MIT after the owner's explicit copyright and licensing confirmation; retained the original source attribution.
- Published source to `andyandymike/harmony-automation-agent`; all six Windows/Ubuntu hosted CI jobs passed. See the [publication review](docs/publication-review-2026-11-10.md) for the source revision, run and checks. The package version remains `0.1.0a2`; the earlier frozen wheel below is historical evidence for different source bytes. No GitHub Release or PyPI upload was performed.

## 0.1.0a2 — local development candidate

Prepared on 2026-11-03, when this candidate had not been published to GitHub or a package registry. These recorded candidate results are separate from subsequent publication checks and the historical alpha1 results below.

### Documentation and distribution preparation

- Added a compatibility matrix separating the recorded Windows/API24 emulator from untested physical devices, hosts and API versions.
- Added source provenance, the fixed fixture revision, package-content boundaries and an explicit reused-material licensing check.
- Added a six-package release-readiness record covering input, Skill, agent acceptance, installation, external trials and release preparation.
- Documented isolated installation, wheel installation without dependency downloads, upgrade/uninstall behavior and the distinction between a completed diagnostic command and a ready device.
- Checked the candidate GitHub repository and official PyPI JSON/Simple endpoints on 2026-11-03. They returned no candidate repository/project. This does not reserve the name or guarantee registration.

### Acceptance status

- On the dedicated API24 emulator, Xiaoyi basic mode and its 26-key layout were configured. Chinese fill, replacement and clearing then passed readback on both ordinary and native real TextInputs: six operations in total. This is native-injection coverage, not a Pinyin/keyboard-composition or general success-rate claim.
- Ordinary-field elapsed times for fill/replace/clear: 4174.26 / 6663.33 / 5595.02 ms. Native-field times: 4249.18 / 6580.03 / 5584.71 ms. Each figure is one functional operation sample.
- Offline regression: 147 tests passed in 2.717 seconds. Input-inclusive device smoke: 40 steps passed, 0 failed, 1 skipped, in 85.641 seconds. The skip is the independent ordinary-IME suite; the separate ordinary-field checks above are not relabeled as a smoke pass.
- The offline release checker completed 14 checks for 0.1.0a2 using a fresh virtual environment. The frozen artifact's final installation report and hashes are recorded through [the alpha2 validation report](docs/validation-alpha2.md); no final-run elapsed time or hash is inferred from an earlier build.
- Ordinary agent guides are available. Personal Skill installation did not complete in this environment; no installed Skill is claimed.
- Independent agent task batches, command/output metrics and unknown-receipt recovery are recorded in [the alpha2 validation report](docs/validation-alpha2.md). That report preserves observed errors and distinguishes test-recorder faults from CLI outcomes. Do not infer all planned tasks completed from this changelog. External human trial, hosted CI execution and public publication remain pending until actual results exist.

### Execution changes

- Increased the default `fill` input-phase budget from 5 to 15 seconds. Standalone `wait` keeps its 5-second default; nested `expect.timeoutMs` remains an independent 5-second default.
- Added a focus check after Ctrl+A and before Delete, in addition to the retained-focus check before insertion.
- Invalidated stored refs after failed/cancelled reads rather than allowing stale observations to authorize later operations.
- Record a boot identity when it first becomes available after attachment, enabling comparison on subsequent checks.

## 0.1.0a1 — unreleased development alpha

Initial native Python / HDC implementation is available as a local development alpha. It has not been published to a package registry.

The alpha provides device diagnostics and explicit sessions, normalized UI observations, element selection, basic actions, deterministic expectations, and local failure evidence. Input remains experimental and blocked in the tested first-run IME environment. See installed CLI help for the command surface.

### Input implementation notes

- Native `uiInput inputText` appends, and an empty string does not clear text. The experimental CLI replacement path uses tap, focus verification, Ctrl+A / Delete when necessary, empty-value and retained-focus verification, text injection, and final readback. Empty fields skip clearing keys; insertion stops if focus is lost; substeps share the operation budget.
- Input preparation and internal verification are included in `timings.actionMs`; this is not pure dispatch latency.
- Native Unicode or long-text injection may overwrite the device clipboard. Clipboard restoration is not guaranteed.
- The normal fixture input encountered Xiaoyi keyboard privacy onboarding in the emulator. The tool did not auto-accept it; the attempt failed with evidence. This is a negative-path observation, not a successful IME test.
- A second real TextInput, `fixture.input.native`, disables soft-keyboard display and shares the same value. It was also blocked by first-run IME onboarding: one attempt reached focus verification but clearing triggered the prompt, and a later clean launch was blocked during focus. Disabling soft-keyboard display does not bypass the IME. Chinese input, replacement, and clearing remain unaccepted and experimental.

### Validation record

Measured on 2026-11-02. Implementation and validation results are recorded separately; the device results below cover the stated scenarios, not the full release acceptance matrix.

- Offline suite: 112 tests passed on the development host.
- Windows + API24 emulator: five fresh observations and five press-plus-counter-expectation operations completed; all five counter expectations passed. Further device smoke coverage is recorded separately by the integrator.
- Native TextInput Chinese replacement/clear/readback (`fixture.input.native`): BLOCKED by first-run IME onboarding; no successful insertion, replacement, or clear acceptance claimed.
- Normal soft-keyboard TextInput (`fixture.input`): blocked by first-run privacy onboarding; no successful IME coverage claimed.
- Physical devices: NOT_RUN.
- Other Harmony/API combinations: NOT_RUN.
- Hosted CI: workflow defined; not claimed as executed.
- Wheel build and isolated virtual-environment installation: passed, including installed CLI help and version checks. The development wheel was approximately 33 KB; final rebuilt artifact size may differ.
- External user trial and package-registry release: NOT_RUN.

Earlier agent-device or Midscene experiments do not establish validation of this implementation.

### Device timing sample

Environment: Windows, Python 3.12.10, HDC 3.2.0d, UiTest 6.0.2.3, Harmony API24 emulator, 4 CPU cores, 4 GB RAM, 1256 × 2760 display.

| Operation | Five wall-clock samples (ms) | Median (ms) |
| --- | --- | --- |
| Fresh observation | 1117.04, 1107.56, 1034.83, 1058.40, 1100.41 | 1100.41 |
| Press + counter expectation | 2307.59, 2278.28, 2257.27, 2316.33, 2315.96 | 2307.59 |

These are five samples from one emulator configuration. Five passed counter assertions are not a general accuracy estimate, and these timings do not establish physical-device performance, Unicode input support, or a controlled advantage over another tool.
