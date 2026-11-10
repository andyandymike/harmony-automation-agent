# Compatibility and validation boundaries

Updated: 2026-11-10. Package version, request `schemaVersion`, fixture contract, and environment version are separate identifiers. Check the installed CLI with `harmony-agent --version --json` and `harmony-agent schema --json`.

## Tested combinations

| Combination | Recorded evidence | Current boundary |
| --- | --- | --- |
| Windows / Python 3.12.10 / HDC 3.2.0d / UiTest 6.0.2.3 / HarmonyOS 6.1.1 API24 emulator | 0.1.0a1: 112 offline tests; 27 device-smoke steps passed, 0 failed, 2 input checks skipped | Local alpha coverage for the recorded fixture scenarios; input and alpha2 changes need their own results |
| Same dedicated API24 test emulator after Xiaoyi basic-mode and 26-key setup | 0.1.0a2: 147 offline tests; device smoke 40 passed, 0 failed, 1 skipped; six separate standard/native input readbacks passed | Native injection on these controls; the skipped ordinary-IME suite is not counted as passed |
| Windows clean virtual environment | 0.1.0a2 release checker: 14 offline checks passed; frozen artifact metadata is linked from the current validation report | A clean venv on the same host is not a clean operating-system or SDK installation |
| GitHub-hosted Windows / Ubuntu, Python 3.10 and 3.12 | 2026-11-10: all four 150-test matrix jobs passed; both Python 3.12 package-check jobs passed, [run and revision](publication-review-2026-11-10.md) | Offline execution only; no connected device, SDK discovery or signing acceptance |
| Physical HarmonyOS devices | NOT_RUN | No physical-device support claim |
| macOS / Linux hosts | NOT_RUN on a device | A Python/HDC port or CI definition does not establish device compatibility |
| Other Python, HDC, UiTest or Harmony/API combinations | NOT_RUN unless a later report records the exact combination | Do not infer compatibility from a nearby version |

The current device, agent and package results are in [validation-alpha2.md](validation-alpha2.md), with input-inclusive smoke in [validation-device-smoke-alpha2.json](validation-device-smoke-alpha2.json) and separate input checks in [validation-input-alpha2.json](validation-input-alpha2.json). The historical device record remains [validation-alpha.md](validation-alpha.md), with [alpha1 JSON](validation-device-smoke.json). Results are version-specific and are not inherited from a previous release.

## Capability status

| Capability | Status | Evidence or restriction |
| --- | --- | --- |
| Explicit device selection, sessions, local locking, JSON requests | Implemented; alpha | Offline behavior and the recorded emulator flow |
| Layout observations, exact selectors, scoped selection, stale-ref rejection | Implemented; alpha | Recorded fixture and synthetic layouts; UI-tree completeness remains explicit |
| Press, basic container scroll, deterministic wait, screenshot | Emulator-validated scenarios | Not a guarantee for virtual lists, nested scrolling or arbitrary apps |
| `fill` / Unicode replacement / clearing | Experimental; recorded API24 cases passed | Alpha1 was blocked before IME setup; alpha2 passed six standard/native-field readbacks after setup |
| Window metadata / boot identity | Experimental / device-dependent | Metadata can be unknown; the tested device did not expose a readable boot identity |
| Visual grounding, model planning, event watch, automatic recovery, MCP | Not implemented in alpha2 | Keep optional roadmap work separate from the native CLI contract |

`doctor` and `capabilities` inspect tools and device help. A command listed in help is not proof that every control supports its semantics. The currently configured device and its actual UI remain the source for operation-time checks.

## Protocol and version handling

- The current request/output schema version is the string `"1"`. Use the installed schema, not a copied command list from a different package version.
- Request validation rejects unknown request fields. When reading results, preserve useful unknown fields and reject a schema version the client cannot interpret.
- The CLI exits `0` for a successful command, uses nonzero statuses for errors, and reports structured error codes in JSON mode. Check `data.ready` for `doctor`; a successful diagnostic command does not imply a ready device.
- Acknowledged actions and passed business assertions are separate. `assertion.status = not_requested` does not prove task success.
- Ref identity is bound to an observation frame. After mutation, timeout, cancellation or disconnect, reobserve before further action.
- The input preparation/insertion/readback budget defaults to 15 seconds in alpha2. Standalone waits and a nested expectation each retain their separate 5-second default. These are phase budgets, not a promise that the whole command including prechecks and evidence finishes within 15 seconds.
- Pre-1.0 changes may alter the interface. Record the exact package version and retain its schema with a reproducible report. Changes to fields, defaults or exit behavior belong in the changelog.
- The fixture's v2 contract uses real TextInputs. Its older Button/onKeyEvent input contract is not interchangeable with this version.

## Environment troubleshooting

| Symptom | Next check |
| --- | --- |
| HDC not found | Set `--hdc` or `HARMONY_HDC` to the installed executable; `HDC_HOME` is its containing directory |
| Empty device list | Start/unlock the intended device, complete its existing debug authorization, then enumerate again |
| Multiple devices | Choose and pass the full device identifier; no implicit first-device selection |
| Session or device busy | Finish the existing owner operation; do not remove a lock file to bypass a live writer |
| IME onboarding or permission UI | Inspect the returned screenshot and current app/window; complete operator-required setup before retrying the intended task |
| Stale ref or ambiguous target | Capture a new observation, then choose a unique stable selector or add container context |
| Unknown dispatch or cancelled operation | Observe the actual state and expected outcome before deciding whether another action is appropriate |
| Missing tree data or truncated output | Inspect `quality`, increase the output budget if appropriate, and avoid absence claims based on omitted nodes |

The local lock coordinates this tool's commands. It does not prevent a person or a different automation tool from operating the device at the same time.
