# Installation

Install the CLI first, verify device access, then add an [agent integration](integrations.md) if needed. Manual CLI and scripted use do not require an AI assistant.

## Prerequisites

| Requirement | Setup |
| --- | --- |
| Python 3.10+ | Create a virtual environment for the package. |
| Official HDC tools | Install through DevEco or HarmonyOS Command Line Tools. |
| HarmonyOS device or emulator | Unlock it, enable debugging and authorize the execution host. Device-side UiTest must be available. |
| Target app | Install it separately; opening an app requires its bundle and launch Ability. |
| Input method, for text entry | Complete first-run setup. Verified `fill` needs a supported editable control with a stable ID unique within its app window. |

Put HDC on PATH, set `HARMONY_HDC` to its executable path, set `HDC_HOME` to its containing directory, or pass `--hdc PATH`. Python and HDC must run where the device is accessible. A remote workspace or container does not automatically inherit another host's USB connection.

The installed runtime has no third-party Python dependencies. Node, Hvigor, the app SDK and signing tools are needed only when building/signing an app, such as the optional [fixture](fixture.md). They are not needed to operate an already installed app. See [compatibility](compatibility.md) for tested environments and troubleshooting.

## Install from source

```sh
git clone https://github.com/andyandymike/harmony-automation-agent.git
cd harmony-automation-agent
python -m venv .venv
```

Windows:

```powershell
.venv/Scripts/python.exe -m pip install .
.venv/Scripts/harmony-agent.exe --version --json
```

POSIX hosts:

```sh
.venv/bin/python -m pip install .
.venv/bin/harmony-agent --version --json
```

Building from source may need setuptools. The examples below use `harmony-agent` for the installed executable. For source-only use, set `PYTHONPATH=src` and invoke `python -m harmony_agent` instead.

## Install an offline wheel

This development alpha has not been published to PyPI. If you have a wheel built from the selected source version, install that exact artifact. For example, on Windows:

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install --no-index --no-deps ./harmony_automation_agent-0.1.0a7-py3-none-any.whl
.venv/Scripts/harmony-agent.exe --version --json
```

On POSIX hosts, substitute `.venv/bin/python` and `.venv/bin/harmony-agent`. Check the filename, reported version and matching documentation; do not substitute an older wheel when evaluating current source.

The wheel includes the Python CLI and MCP adapter. The Skill and device tools are installed separately. An optional local distribution bundle can include the wheel, complete Skill, installer, documentation and integration examples. Such a bundle is a convenience artifact, not a registry release or a full source checkout. Use its included manifest when checking the supplied files.

## Verify the installation

Check version and schema without a device:

```sh
harmony-agent --version --json
harmony-agent schema run --json
```

Then inspect device readiness and select an exact device ID:

```sh
harmony-agent doctor --json
harmony-agent doctor --device YOUR_DEVICE_ID --json
harmony-agent attach --device YOUR_DEVICE_ID --session demo --json
harmony-agent observe --session demo --compact --json
harmony-agent detach --session demo --json
```

Inspect `data.ready`, not just command success. An empty device list means device operation is not ready. The observation should identify the expected app and provide usable controls. For a repeatable action with readback, follow the [README example](../README.md#act-and-verify) after installing the fixture.

Attaching and detaching do not start, stop or reset the device. SDK authorization and input-method initialization remain separate setup steps; there is no all-in-one environment installer.

## Optional agent setup

Choose CLI, Skill or local stdio MCP using [agent integrations](integrations.md). Install the entire Skill directory, including its references and license, using [Skill setup](skill-setup.md).

First check offline version/schema invocation from the host. Then perform a small reversible task with an observable result. Verify Skill discovery, MCP tool access and any optional delegation in the actual host; successful package installation alone does not test these integrations.

## Upgrade and uninstall

Retain needed reports and detach active sessions before switching versions. Install the selected replacement wheel into the environment, check version/schema, and establish a new session and observation. Do not reuse old frame refs. Older versions may not read newer state formats; see [version handling](compatibility.md#protocol-and-version-handling).

To uninstall on Windows:

```powershell
.venv/Scripts/python.exe -m pip uninstall harmony-automation-agent
```

On POSIX hosts:

```sh
.venv/bin/python -m pip uninstall harmony-automation-agent
```

Uninstalling the Python package leaves HDC, the SDK, apps, separately installed Skills and existing `.harmony-agent/` state in place.

## Local evidence

Keep raw trees, screenshots, request files and execution records in `.harmony-agent/` or another explicitly excluded local directory. Review summaries before sharing them. Use synthetic reproductions in public issues and tests; see [CONTRIBUTING](../CONTRIBUTING.md).
