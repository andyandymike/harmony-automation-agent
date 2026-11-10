# Harmony Automation Agent

[简体中文](README.zh-CN.md)

An open-source toolkit for observing, operating, and verifying HarmonyOS apps through native HDC / UiTest. Use it from a terminal, automation scripts, or an AI agent.

The project provides a Python CLI, a portable Agent Skill, and an optional local stdio MCP adapter. They share a model-free runtime built on the Python standard library; no Appium server, visual model, or model API key is required.

**0.1.0a7 is an unreleased development alpha and has not been published to PyPI.** See [compatibility](docs/compatibility.md) for tested environments, [alpha7 validation](docs/validation-alpha7.md) for recorded results, and the [changelog](CHANGELOG.md) for version history.

## What it does

- Inspect native UI trees, locate controls, and return compact or semantic page views.
- Open apps, press controls, scroll, enter text, and verify observable results.
- Execute bounded plans with conditions, loops and explicit completion goals.
- Save local execution records and inspect frozen evidence without contacting the device.
- Coordinate one device writer while optional readers inspect saved evidence.

## Requirements and installation

You need Python 3.10+, official HDC tools, and an unlocked HarmonyOS device or emulator with debugging authorized and UiTest available. Install the target app separately. Text input also requires a configured input method and a supported editable control.

Clone the repository and create an environment:

```sh
git clone https://github.com/andyandymike/harmony-automation-agent.git
cd harmony-automation-agent
python -m venv .venv
```

On Windows:

```powershell
.venv/Scripts/python.exe -m pip install .
.venv/Scripts/harmony-agent.exe --version --json
```

On POSIX hosts:

```sh
.venv/bin/python -m pip install .
.venv/bin/harmony-agent --version --json
```

Subsequent examples use `harmony-agent` as shorthand for that environment's executable. Put HDC on PATH, set `HARMONY_HDC` to its full path, set `HDC_HOME` to its containing directory, or pass `--hdc PATH`. Host-side installation alone does not establish device compatibility.

See [installation](docs/installation.md) for offline wheels, setup, upgrades and removal, and [compatibility](docs/compatibility.md) for troubleshooting. Building the optional fixture app requires separate SDK and signing tools.

## First observation

Select an exact device ID from `doctor` or `devices`. A successful `doctor` invocation does not necessarily mean the device is ready: inspect `data.ready`.

```sh
harmony-agent doctor --json
harmony-agent attach --device YOUR_DEVICE_ID --session demo --json
harmony-agent observe --session demo --compact --json
harmony-agent detach --session demo --json
```

`observe` returns the current app context, UI nodes and observation quality. Attaching and detaching do not start or reset the device. To try the supplied sample controls, build and install the optional [fixture app](docs/fixture.md).

## Act and verify

For the following example, attach the `demo` session, open the fixture, and reset its counter:

```sh
harmony-agent attach --device YOUR_DEVICE_ID --session demo --json
harmony-agent open com.andyandymike.harmonyautomation.fixture --ability EntryAbility --session demo --compact --json
harmony-agent press id=fixture.reset --session demo --compact --json
```

Save this as UTF-8 `.harmony-agent/increment.json`:

```json
{
  "schemaVersion": "1",
  "command": "press",
  "input": {
    "session": "demo",
    "compact": true,
    "target": "id=fixture.increment",
    "expect": {
      "selector": {"id": "fixture.counter"},
      "equals": "Counter: 1"
    }
  }
}
```

```sh
harmony-agent --request .harmony-agent/increment.json --json
harmony-agent help press
harmony-agent schema --json
harmony-agent detach --session demo --json
```

Inspect the assertion result before declaring the counter verified. The action also returns an observation; reuse it for the next decision. A passed `expect` needs no duplicate `wait` for the same condition. Reobserve an uncertain action outcome before deciding whether to retry.

For longer tasks, `run` executes a bounded plan and records its result. `report` and `inspect` read saved evidence without a device capture. Within one uninterrupted run, target resolution can reuse a frame for up to 1000 ms; a mutation step's `refresh: true` requests a new capture. See [execution](docs/execution.md) for plans, result meanings and performance tradeoffs, and [request examples](docs/agent-requests.md) for individual commands.

## Use with an AI agent

| Interface | Purpose |
| --- | --- |
| CLI | Invoke commands directly from a terminal, script or agent with process access. |
| Agent Skill | Teach an agent the command contract, selectors, efficient observation use and failure handling. |
| Local stdio MCP | Keep a tool process connected and expose the same runtime through MCP. |

Start with [agent integrations](docs/integrations.md) to choose an interface. The repository includes the [complete Skill](skills/harmony-agent/SKILL.md), an installer and optional host configuration examples. The wheel contains the Python runtime and MCP adapter; install the Skill separately when using it.

One agent can operate the device. [Multiple agent roles](docs/multi-agent.md) are optional: readers can interpret saved pages or review outcomes while a single executor owns device actions.

## Limits and local data

Controls must expose enough information through the native UI tree for selection and verification. Visual localization, event watching, autonomous recovery and model routing are not implemented.

Text input is experimental. A failed multi-step `fill` may leave earlier edits in place, and native text injection may overwrite the device clipboard. See [input behavior](docs/agent-usage.md#input-limitations) before using it.

An action acknowledgment is separate from a passed assertion. A successful `run` command is separate from the plan's task status and verified goal. Truncated output or unknown attributes cannot establish that a control is absent. See [outcome interpretation](skills/harmony-agent/references/outcomes.md).

State and evidence default to `.harmony-agent/`; use `--state-dir` to choose another location. Review trees, screenshots and input data before sharing them. The runtime does not upload diagnostics automatically; an agent host may send tool results to its model.

## Documentation

| Guide | Contents |
| --- | --- |
| [Installation](docs/installation.md) | Prerequisites, source/wheel setup, upgrades and removal |
| [Agent integrations](docs/integrations.md) | CLI, Skill, MCP and optional host examples |
| [Execution](docs/execution.md) | Bounded plans, saved evidence, outcomes and efficiency |
| [Agent usage](docs/agent-usage.md) | Selectors, input, errors and verification |
| [Fixture app](docs/fixture.md) | Reproducible controls for testing |
| [Compatibility](docs/compatibility.md) | Tested environments and troubleshooting |
| [Release readiness](docs/release-readiness.md) | Validation records and remaining release work |

## Development and contributions

Bug reports, documentation improvements, synthetic reproductions and code contributions are welcome. See [CONTRIBUTING](CONTRIBUTING.md) for setup, checks and what to include in a report.

With `PYTHONPATH=src`, run the offline suite:

```sh
python -m unittest discover -s tests -v
```

These tests require no device or model key. Device checks must be run and reported separately. The native Python approach is described in [ADR 0001](docs/adr-0001-native-python.md).

## License and attribution

Project code, documentation, the fixture scaffold and resources use the [MIT License](LICENSE). The owner has authorized the reused materials under MIT; their attribution and design references are recorded in [source provenance](docs/source-provenance.md). SDK binaries, emulator images and signing materials are not included.
