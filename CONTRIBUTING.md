# Contributing

## Local setup

Use Python 3.10+. Runtime code uses only the standard library. From the repository root, install with `python -m pip install -e .`, or set `PYTHONPATH=src` for source-only development.

PowerShell:

```powershell
$env:PYTHONPATH = "src"
python -m unittest discover -s tests -v
```

POSIX shells:

```sh
PYTHONPATH=src python -m unittest discover -s tests -v
```

## Work without a device

You can contribute layout normalization, selectors, ref/diff handling, output contracts, mocked transport failures, and documentation without a HarmonyOS device or model API key.

Use synthetic or carefully redacted layout data in `tests/data`. Include the relevant source shape and the expected normalized result. Do not commit screenshots, real input values, identifiers, signing materials, or unrelated SDK files from your device.

Tests should verify meaningful behavior: ambiguity, unknown attributes, stale refs, inconsistent projections, shell quoting, failed dispatch, and timeout outcomes. Do not make default offline tests start an emulator, contact a device, or require credentials.

## Changes that require a device

Native input, gestures, app launch, screenshots, and HDC behavior changes also need a device smoke report. Include host OS, Python and HDC versions, Harmony/API, emulator or physical device, fixture version, exact commands, actual results, and known limits.

An offline mock passing is not a substitute for device validation. Mark unexecuted checks as NOT_RUN and explain the missing prerequisite. See [fixture setup](docs/fixture.md).

## Scope and interface changes

Keep v0.1 focused on one reliable native path. Discuss a new backend, model dependency, public protocol change, or large feature through a short issue or ADR before implementation. Describe the user task, maintenance cost, and validation method.

CLI help and parsing come from the command schema. Update tests and both quick starts when changing user-facing parameters. Separate command execution status from business assertions. Never turn an unknown action outcome into an automatic mutation retry.

## Pull requests

Explain the concrete problem, resulting behavior, and relevant validation. Record environment limitations and tests not run. Small fixes can be submitted directly; preserve existing files outside the change's scope.

The offline workflow runs on hosted Windows and Linux workers. Device jobs are maintained separately; external PR code must not automatically receive device access or signing credentials.

The workflow definition is not an execution result. Record the actual CI run or local command output for each candidate. Before release, build and install the exact candidate wheel in a new virtual environment, inspect its metadata and file list, and run installed help/version/schema checks. See [release readiness](docs/release-readiness.md) and the current `scripts/release-check.py --help`.

## Reports and licensing

Use the bug template with a minimal reproduction. Review evidence before sharing; automatic redaction cannot guarantee that every screenshot is safe to publish.

Contributions are provided under the project's [MIT License](LICENSE), including the fixture scaffold and resources. Preserve third-party copyright and permission notices when adding reused code, and record the source/version. Do not assume a public repository grants redistribution permission. The fixture's source and the owner's MIT authorization are recorded in [source provenance](docs/source-provenance.md). Official SDK binaries, emulator images, and personal signing assets are not project source.

Human external trials require independent users following the documented setup. Report how much maintainer help they needed and whether the task was completed. Agent subtask evaluations are useful but are not evidence that a new human user can install and use the project unaided.

This is an early alpha maintained on a best-effort basis. No response-time or device-support guarantee is implied.
