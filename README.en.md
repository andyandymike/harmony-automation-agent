# Harmony Automation Agent

[中文](README.md)

Observe, operate, and verify HarmonyOS applications from AI coding agents using native HDC / UiTest.

**0.1.0a2 is a local development alpha.** Python 3.10+ is required. The runtime uses the standard library and does not require Appium, a visual model, or a model API key. This package has not been published to PyPI. See [the current validation report](docs/validation-alpha2.md), [CHANGELOG](CHANGELOG.md), [compatibility](docs/compatibility.md), and [release readiness](docs/release-readiness.md) for version-specific evidence.

On 2026-11-03, after configuring Xiaoyi basic mode and its 26-key layout on the dedicated API24 test emulator, Chinese fill, replacement and clearing passed readback on both real TextInputs: six operations in total, about 4.17–6.66 seconds each. These are functional samples for particular controls, not a general success-rate estimate. Input remains experimental; complete agent-task and candidate checks are reported separately.

The current offline suite passed **147 tests**. Device smoke including native input recorded **40 passed steps, 0 failures and 1 skip** in 85.641 seconds. The separately recorded standard-field input checks do not replace the skipped independent IME suite. Consult [the current validation report](docs/validation-alpha2.md) for completed independent-agent task counts, recovery behavior, installation checks and final package metadata.

Historical alpha1 results, including 112 offline tests, 27 device steps and the first-run input block, remain in [the alpha1 validation report](docs/validation-alpha.md). They are not counted as new alpha2 results.

## Requirements and installation

- Install HDC through the official DevEco / HarmonyOS Command Line Tools.
- Start and authorize a HarmonyOS device or emulator before using the CLI.
- Install the application you intend to operate. Application building, signing, and device authorization remain separate steps.

Use a separate environment from the repository root:

```sh
python -m venv .venv
.venv/bin/python -m pip install .
.venv/bin/harmony-agent help
```

On Windows use `.venv\Scripts\python.exe` and `.venv\Scripts\harmony-agent.exe`. Subsequent examples use `harmony-agent` as shorthand for the executable in that environment. The build may need setuptools; the installed runtime has no third-party Python dependencies. If the current candidate wheel already exists, install it offline with:

```sh
.venv/bin/python -m pip install --no-index --no-deps dist/harmony_automation_agent-0.1.0a2-py3-none-any.whl
```

Use the wheel built from the candidate source; do not substitute a previous version when checking acceptance. For source-only use, set `PYTHONPATH=src` and run `python -m harmony_agent` instead of `harmony-agent`.

Configure `HARMONY_HDC` with the full HDC executable path, `HDC_HOME` with its containing directory, or use `--hdc <path>`. HDC on PATH is also supported.

```sh
harmony-agent doctor --json
harmony-agent devices --json
```

Windows and Linux offline CI does not establish support for every host/device/API combination. Only explicitly recorded device validation should be treated as compatibility evidence.

A successfully executed `doctor` command is not necessarily a ready device: inspect `data.ready`. See [compatibility and troubleshooting](docs/compatibility.md) for environment and protocol checks.

### Upgrade and uninstall

Install an explicitly selected replacement wheel into the same environment, then check `--version --json` and `schema --json`. To uninstall:

```sh
.venv/bin/python -m pip uninstall harmony-automation-agent
```

Uninstalling this Python package does not remove HDC, the SDK, apps, or existing `.harmony-agent` state/evidence. Retain useful reports before changing versions, establish a new session and observation, and do not reuse old frame refs.

## First operation

Build and install the [fixture application](docs/fixture.md) first. Replace `YOUR_DEVICE_ID` with an explicitly selected ID returned by the devices command.

```sh
harmony-agent attach --device YOUR_DEVICE_ID --session demo --json
harmony-agent open com.andyandymike.harmonyautomation.fixture --ability EntryAbility --session demo --json
harmony-agent observe --session demo --json
harmony-agent press id=fixture.reset --session demo --json
harmony-agent wait id=fixture.counter --property text --equals "Counter: 0" --timeout-ms 5000 --session demo --json
harmony-agent press id=fixture.increment --session demo --json
harmony-agent wait id=fixture.counter --property text --equals "Counter: 1" --timeout-ms 5000 --session demo --json
harmony-agent screenshot --session demo --json
harmony-agent detach --session demo --json
```

The quick start uses the counter to demonstrate actions and verification. Input checks require the device's input-method setup to be completed first. See [CHANGELOG](CHANGELOG.md) and the [fixture documentation](docs/fixture.md) for the exact input coverage and limits.

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

## Execution contract

See [Agent usage](docs/agent-usage.md) for a compact calling workflow and the [Agent operating guide](docs/agent-operating-guide.md) for the task entry point. These are ordinary project guides. Personal Skill installation did not complete in this environment, so they must not be described as an installed callable Skill.

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

The original implementation uses the [MIT License](LICENSE). Preserve the reused fixture scaffold/resource attribution and confirm the project owner's licensing intent before public redistribution. A public source repository does not automatically grant MIT permission for every asset. See [source provenance](docs/source-provenance.md).
