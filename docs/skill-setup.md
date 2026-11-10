# Use Harmony Agent as a Skill

The project provides a Python CLI and an optional instruction-only [Skill](../skills/harmony-agent/SKILL.md). The Skill teaches an outer agent to find the CLI, inspect the UI, execute a task and interpret results. It does not contain a model, an MCP server, HDC, the SDK or a device runtime.

## Install the CLI first

Follow the [README installation steps](../README.md#requirements-and-installation). From a known checkout, the entry point is `.venv/Scripts/harmony-agent.exe` on Windows or `.venv/bin/harmony-agent` on POSIX. It need not be globally installed: give the agent the checkout or executable path.

Verify `--version --json` and `schema --json`. For device tasks, install HDC separately, authorize the device and select its exact ID. A Skill installation does not establish those prerequisites.

## Install the Skill folder

The complete, portable source is `skills/harmony-agent/`: copy or install that whole directory, including `references/`, `agents/` and `LICENSE`, rather than just `SKILL.md`.

In Codex, ask the built-in installer:

```text
$skill-installer install the skill from https://github.com/andyandymike/harmony-automation-agent/tree/main/skills/harmony-agent
```

For a manual installation, current Codex documentation lists `~/.agents/skills/harmony-agent/` for user-wide discovery and `.agents/skills/harmony-agent/` in a working repository for project-local discovery. Use the skill root actually supported by your host. Some installations, including the maintainer's existing environment, use `~/.codex/skills/`; an existing copy should be updated in place instead of creating a duplicate name under another root. See [official Skill documentation](https://learn.chatgpt.com/docs/build-skills#where-to-save-skills).

Keep local edits before updating an existing installation. Compare the new `SKILL.md`, metadata and referenced files with the installed copy, then replace the intended files. Removing the installed `harmony-agent` Skill folder removes the instructions only; CLI installation, SDK and local device evidence are separate.

## Use and verify

Start a new turn after installation. If the host has not refreshed the Skill, reload its Skill list or restart it. An example request is:

```text
Use $harmony-agent. The CLI is in this checkout's .venv.
Check the CLI version and schema without contacting a device.
```

For a device task, also provide the exact selected device, application bundle and desired outcome. Let the agent inspect the UI to discover selectors; avoid providing unexplained coordinates or reusing old observation refs.

Check these outcomes separately:

1. **Source:** the Skill has a meaningful description/workflow and all linked references exist.
2. **Installed files:** the complete folder exists in the selected host's discovery root.
3. **Agent use:** an agent reads the installed Skill and can invoke the CLI and interpret its contract.
4. **Device acceptance:** tasks run against a real selected device and the requested final state is observed.

File copying or offline agent checks do not establish device acceptance. The project's [readiness record](release-readiness.md) keeps these evidence boundaries explicit.
