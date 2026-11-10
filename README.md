# Harmony Automation Agent

[简体中文](README.zh-CN.md)

Observe, operate, and verify HarmonyOS applications from AI coding agents using native HDC / UiTest.

**0.1.0a5 is an unreleased development alpha.** Python 3.10+ is required. The runtime uses the standard library and does not require Appium, a visual model, or a model API key. This package has not been published to PyPI. See [CHANGELOG](CHANGELOG.md), [compatibility](docs/compatibility.md), and [release readiness](docs/release-readiness.md) for the implementation and evidence boundaries. Earlier source publication and device results are recorded separately.

The current source adds compact output, observation projection options for actions, and optimizations to capture, tree processing and session storage. Historical alpha3 passed 187 offline tests and 14 isolated build/install checks; its device smoke was NOT_RUN. Those results are recorded in [the alpha3 validation](docs/validation-alpha3.md) and are not acceptance results for the current source. The counts and device results below describe the earlier alpha2 source.

On 2026-11-03, after configuring Xiaoyi basic mode and its 26-key layout on the dedicated API24 test emulator, Chinese fill, replacement and clearing passed readback on both real TextInputs: six operations in total, about 4.17–6.66 seconds each. These are functional samples for particular controls, not a general success-rate estimate. Input remains experimental; complete agent-task and candidate checks are reported separately.

The 2026-11-10 publication check passed **150 offline tests**, including new scroll-target validation regressions. Device smoke recorded on 2026-11-03 passed **40 steps, with 0 failures and 1 skip**, in 85.641 seconds; it has not been rerun after the current code change. The separately recorded standard-field input checks do not replace the skipped independent IME suite. See [the alpha2 validation report](docs/validation-alpha2.md) for historical device, agent and package results, and [the publication review](docs/publication-review-2026-11-10.md) for the new offline checks and package information.

Historical alpha1 results, including 112 offline tests, 27 device steps and the first-run input block, remain in [the alpha1 validation report](docs/validation-alpha.md). They are not counted as new alpha2 results.

## Requirements and installation

| Requirement | What each colleague needs to prepare |
| --- | --- |
| Python 3.10+ | A local Python environment for installing and running the CLI. |
| Official HDC tools | Install through DevEco / HarmonyOS Command Line Tools; put HDC on PATH or configure its executable path. |
| HarmonyOS device or emulator | Start and unlock it, enable debugging and authorize the computer. HDC must list the selected device, and device-side UiTest commands must be available. |
| Installed target app | Install the app and identify its bundle and launch Ability. Building, signing and installation are separate from CLI operation. |
| Input-method setup, when entering text | Complete first-run keyboard setup. Verified `fill` needs a real editable control with a stable ID unique within its app window. |
| AI assistant, for natural-language tasks | Use an assistant that can execute commands on the computer running HDC. Its account/model setup is separate; manual CLI use does not require an AI assistant. |

The CLI runtime has no third-party Python dependencies and needs no Appium, GPU, server or model API key. Installing the optional Skill supplies instructions for an outer AI assistant; it does not install the CLI, HDC, SDK, emulator or target app. Node, Hvigor and app-signing tools are needed only when your workflow builds/signs an app, not for operating an already installed app with this CLI.

The target UI must expose enough information through UiTest for selection and verification. There is no visual-localization fallback for inaccessible or custom-drawn controls. The recorded device tests use a HarmonyOS 6.1.1 / API24 emulator; see [compatibility](docs/compatibility.md) before relying on another device/version combination.

### Handing the project to a colleague

Provide the version-matched wheel, this README (or a repository documentation link), and the target application's bundle, Ability and intended task. For AI-assisted use, also provide the complete `skills/harmony-agent/` folder, including `references/`, `agents/` and `LICENSE`, and follow [Skill setup](docs/skill-setup.md). The Python wheel does not include that Skill folder or the external device tools.

If you send this README as a standalone file, include its referenced `docs/` guides or provide links to the documentation for the matching source version.

A colleague receiving the wheel can install it without cloning or building this repository. For example, on Windows, put the wheel in a working folder and run there:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --no-index --no-deps .\harmony_automation_agent-0.1.0a5-py3-none-any.whl
.\.venv\Scripts\harmony-agent.exe --version --json
.\.venv\Scripts\harmony-agent.exe doctor --json
```

The filename must match the wheel actually supplied. On POSIX hosts, use `.venv/bin/python` and `.venv/bin/harmony-agent`; device compatibility still needs separate validation. `doctor` includes the connected device list; `devices --json` is available when only enumeration is needed. Configure HDC as described below, then select an exact device ID and use `doctor --device <ID> --json` to inspect that device. An empty device list means device operation is not ready. SDK/device authorization and input-method initialization remain separate setup steps; there is no all-in-one environment installer.

### Install from source

Clone the source, then create a separate environment from the repository root:

```sh
git clone https://github.com/andyandymike/harmony-automation-agent.git
cd harmony-automation-agent
python -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/harmony-agent help
```

On Windows use `.venv\Scripts\python.exe` and `.venv\Scripts\harmony-agent.exe`. Subsequent examples use `harmony-agent` as shorthand for the executable in that environment. The build may need setuptools; the installed runtime has no third-party Python dependencies. If the current candidate wheel already exists, install it offline with:

```sh
.venv/bin/python -m pip install --no-index --no-deps dist/harmony_automation_agent-0.1.0a5-py3-none-any.whl
```

Use the wheel built from the candidate source; do not substitute a previous version when checking acceptance. For source-only use, set `PYTHONPATH=src` and run `python -m harmony_agent` instead of `harmony-agent`.

Configure `HARMONY_HDC` with the full HDC executable path, `HDC_HOME` with its containing directory, or use `--hdc <path>`. HDC on PATH is also supported.

```sh
harmony-agent doctor --json
```

Windows and Linux offline CI does not establish support for every host/device/API combination. Only explicitly recorded device validation should be treated as compatibility evidence.

A successfully executed `doctor` command is not necessarily a ready device: inspect `data.ready`. See [compatibility and troubleshooting](docs/compatibility.md) for environment and protocol checks.

### Upgrade and uninstall

Install an explicitly selected replacement wheel into the same environment, then check `--version --json` and `schema --json`. To uninstall:

```sh
.venv/bin/python -m pip uninstall harmony-automation-agent
```

Uninstalling this Python package does not remove HDC, the SDK, apps, or existing `.harmony-agent` state/evidence. Retain useful reports before changing versions, establish a new session and observation, and do not reuse old frame refs.

Alpha5 can read valid older sessions and migrates stored frames when saving. Alpha4 cannot read the new indexed format. Before downgrading, detach the affected session using its original state directory; after installation, attach and observe again. See [version handling](docs/compatibility.md#protocol-and-version-handling).

## First operation

The fixture is needed only for the sample below. Operating your own installed app does not require installing the fixture.

Build and install the [fixture application](docs/fixture.md) first. Replace `YOUR_DEVICE_ID` with an explicitly selected ID returned by `doctor` or `devices`.

```sh
harmony-agent attach --device YOUR_DEVICE_ID --session demo --json
harmony-agent open com.andyandymike.harmonyautomation.fixture --ability EntryAbility --session demo --compact --json
harmony-agent press id=fixture.reset --session demo --compact --json
harmony-agent detach --session demo --json
```

`open` and `press` each return a fresh `data.observation`. Inspect the app context and counter value there; a separate `observe` is only needed when that view lacks the required context or the UI has changed. The structured request below combines an action with an exact counter assertion. Input checks require the device's input-method setup to be completed first. See [CHANGELOG](CHANGELOG.md) and the [fixture documentation](docs/fixture.md) for the exact input coverage and limits.

### Experimental input and local side effects

Both fixture inputs are real TextInputs. `fixture.input` uses normal soft-keyboard behavior; `fixture.input.native` sets `enableKeyboardOnFocus(false)`. Alpha1 was blocked before first-run setup. During alpha2 validation, configuring Xiaoyi basic mode and the 26-key layout allowed Chinese fill, replacement and clearing to pass on both fields. Disabling keyboard display itself does not bypass initialization. These checks use native text injection and do not establish Pinyin composition, candidate-selection, every editor action or other-device support.

After configuring the input method, attaching the session and opening the fixture:

```sh
harmony-agent fill id=fixture.input.native "你好 Harmony 123" --session demo --json
```

On the device, native `uiInput inputText` appends text; an empty string does not clear the field. CLI `fill` taps the target, verifies focus, selects all when needed, rechecks focus before Delete, verifies an empty value and retained focus, injects text, and verifies the final readback. Empty fields skip clearing keys. Losing focus before deletion or insertion stops the operation. Input substeps share a default 15-second budget, overridable with `--timeout-ms`. Standalone `wait` still defaults to 5 seconds; an action's `expect.timeoutMs` is a separate assertion budget, also 5 seconds by default.

This is a multi-step operation. If filling fails, the original text may already have been cleared, and the operation does not promise rollback. Reobserve unknown outcomes before deciding what to do next. Native Unicode or long-text injection may overwrite the **device clipboard**; restoring its previous content is not currently guaranteed.

The result's `timings.actionMs` includes action-stage input preparation and internal verification. It is not a measurement of pure command dispatch time.

Keep using the same session name. Attaching and detaching do not start, stop, or reset the emulator.

## Structured requests

Save this as UTF-8 `increment.json` after preparing the active demo session and opening the fixture:

```json
{
  "command": "press",
  "input": {
    "session": "demo",
    "compact": true,
    "target": "id=fixture.increment",
    "expect": {
      "selector": {"id": "fixture.counter"},
      "property": "text",
      "equals": "Counter: 1",
      "timeoutMs": 5000
    }
  }
}
```

```sh
harmony-agent press id=fixture.reset --session demo --json
harmony-agent --request increment.json --json
harmony-agent help press
harmony-agent schema --json
```

Action commands also accept `--expect <JSON>`. Request files avoid shell quoting differences. Consult the installed version's help and schema for exact fields.

A passed `expect` already verifies that condition. Reuse the returned observation for the next decision instead of issuing another `wait` or `observe` for the same result. An uncertain dispatch or insufficient context still requires a fresh read before deciding what to do.

## Observation size

From `0.1.0a5`, all commands returning an observation accept `--compact`, `--max-nodes` and `--interactive`. These options also apply to the observation returned by an action or `wait`. `find TEXT` narrows output to matching text and its context. The CLI continues to capture and validate the full tree internally.

Compact output is opt-in and marked by `projection.compact=true`. It omits optional null/empty node fields, preserving empty text/value strings, root parents, false, zero and nonempty whitespace. Refs, quality, assertions and diff before/after values retain their meaning. A missing optional field must not be interpreted as false; use standard output if distinguishing null from an empty string matters. See [output interpretation](skills/harmony-agent/references/outcomes.md#compact-output).

## Execution contract

The project provides the CLI and an optional [Harmony Agent Skill](skills/harmony-agent/SKILL.md). See [Skill setup](docs/skill-setup.md) to install the complete instruction/reference folder, or [Agent usage](docs/agent-usage.md) for direct CLI use. The Skill guides the outer agent; device operations still run through the CLI.

- JSON mode writes only JSON to stdout; diagnostic logs use stderr. Errors exit nonzero.
- Inspect the separate assertion result before declaring a business outcome verified. An action acknowledgment is not a passed assertion.
- Selectors such as `id=...`, `text=...`, and `type=...` match exactly. Ambiguous matches are errors.
- Element refs belong to a particular observation frame. Mutating operations invalidate old refs, including after a timeout.
- Respect observation truncation and unknown fields. Missing output does not prove a state is absent.
- Reobserve an unknown dispatch outcome before deciding whether to retry a non-idempotent action.
- Explicit device selection is required. Coordination inside this tool cannot exclude a user or another automation tool operating the same device.

State and evidence default to `.harmony-agent` in the current directory. Use `--state-dir` to choose another location. Review screenshots, trees, and input-related data before sharing; the tool does not upload diagnostics automatically.

## Development

With `PYTHONPATH=src`:

```sh
python -m unittest discover -s tests -v
```

Offline tests require no device or model key. Device smoke tests and Unicode input verification require an actual device and must be reported separately. See [CONTRIBUTING](CONTRIBUTING.md) and [ADR 0001](docs/adr-0001-native-python.md).

The initial scope is a native CLI. MCP, visual assertions, workflow recording, automatic recovery, and durable operation receipts are later milestones.

## License and attribution

New CLI and runtime code is implemented for this project with design references to Playwright CLI, agent-device, Midscene, and OpenHarmony public interfaces. The fixture extends the project owner's [harmony-automation fixture](https://github.com/andyandymike/harmony-automation/tree/ddaecb946c59d76648bfbb5ffa6b2273de83272f/fixture-app). SDK binaries, emulator images, and signing materials are not included.

The project code, documentation, fixture scaffold and resources use the [MIT License](LICENSE). The project owner has confirmed ownership of the reused materials and authorized their distribution under MIT. Their original attribution is retained in [source provenance](docs/source-provenance.md).
