# Harmony Automation Agent

[简体中文](README.zh-CN.md)

An open-source toolkit for observing, operating, and verifying HarmonyOS apps through native HDC / UiTest. Use it from a terminal, automation scripts, or an AI agent.

The project provides a Python CLI, a portable Agent Skill, and an optional local stdio MCP adapter. They share a model-free runtime built on the Python standard library; no Appium server, visual model, or model API key is required.

**0.1.0a9 is an unreleased development alpha and has not been published to PyPI.** See [compatibility](docs/compatibility.md) for tested environments, [alpha9 validation](docs/validation-alpha9.md) for recorded results, and the [changelog](CHANGELOG.md) for version history.

## What it does

- Inspect native UI trees, locate controls, and return compact or semantic page views.
- Open apps, press controls, scroll, enter text, and verify observable results.
- Execute bounded plans with conditions, loops and explicit completion goals.
- Finish a known workflow with one `execute` call, including initial checks, final verification and session cleanup.
- Bind live page values inside known workflows, without a model turn for every value read or page transition.
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

## Choose a task entry point

When the page structure and complete workflow are already known, use `execute` with an exact device and a plan containing nonempty app-scoped initial `preconditions` and final `goals`. It attaches or resumes the session, runs and verifies the task, and detaches after verified success. Its default decision response retains the outcome and relevant evidence; `--keep-session` deliberately retains the session. Adapt the [complete workflow example](skills/harmony-agent/references/workflows.md#complete-two-page-example) to the verified contract and save the raw plan as UTF-8:

```sh
harmony-agent execute --device YOUR_DEVICE_ID --session task --plan-file .harmony-agent/workflow.json --json
```

Reuse the validated plan file for a new authorized task with the same contract; each invocation gets a fresh run ID. Do not automatically retry an uncertain outcome. For exploration or an unknown current page, begin with `start` and use `run` for the resulting task segment.

Use the exact device ID supplied by your task, or discover it with `devices`. `start` attaches or resumes the named session and returns the current page and supported plan contract in one call. Use `doctor` to investigate setup problems.

```sh
harmony-agent devices --json
harmony-agent start --device YOUR_DEVICE_ID --session demo --json
harmony-agent detach --session demo --json
```

Read `start`'s `observation` for app context, UI nodes and observation quality. Use `observe` for a later fresh page. Attaching and detaching do not start or reset the device. To try the supplied sample controls, build and install the optional [fixture app](docs/fixture.md). See [local workflows](skills/harmony-agent/references/workflows.md) for bounded plans with runtime data and compact decision results.

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
harmony-agent detach --session demo --json
```

Inspect the assertion result before declaring the counter verified. The action also returns an observation; reuse it for the next decision. A passed `expect` needs no duplicate `wait` for the same condition. Reobserve an uncertain action outcome before deciding whether to retry.

Use `execute` for a complete known task, or `run` for a bounded segment in an established session. `execute` defaults to decision output; `run` retains its full-response default and accepts `output: "decision"`. Both preserve full run evidence. `report` and `inspect` read it without a device capture. Within an uninterrupted run, target resolution can reuse a frame for up to 1000 ms; a mutation step's `refresh: true` requests a new capture. See [execution](docs/execution.md) for outcomes and performance tradeoffs, and [request examples](docs/agent-requests.md) for individual commands.

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

An action acknowledgment is separate from a passed assertion. A successful command is separate from the plan's task status and verified goal. After `execute`, also check `sessionCleanup`: failed, unknown or yielded tasks retain their session; a cleanup failure does not undo completed actions. After response loss, query `report RUN_ID` without replaying the workflow. Its independent `workflowReceipt` records the cleanup conclusion for that attempt; missing or invalid lifecycle evidence means cleanup is unknown, not that the task should run again. Truncated output or unknown attributes cannot establish that a control is absent. See [execution outcomes](docs/execution.md#interpret-outcomes-separately).

State and evidence default to `.harmony-agent/`; use `--state-dir` to choose another location. Review trees, screenshots and input data before sharing them. The runtime does not upload diagnostics automatically; an agent host may send tool results to its model.

## Documentation

| Guide | Contents |
| --- | --- |
| [Installation](docs/installation.md) | Prerequisites, source/wheel setup, upgrades and removal |
| [Agent integrations](docs/integrations.md) | CLI, Skill, MCP and optional host examples |
| [Execution](docs/execution.md) | Bounded plans, saved evidence, outcomes and efficiency |
| [Performance](docs/performance.md) | Timelines, measured boundaries and matched comparisons |
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
