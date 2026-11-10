# Use Harmony Agent as a Skill

The project provides a Python CLI, an optional local MCP adapter, and an instruction-only [Skill](../skills/harmony-agent/SKILL.md). The Skill teaches an outer agent to use the installed CLI or configured MCP tools, inspect the UI, execute a task and interpret results. The MCP server belongs to the Python package; the Skill folder itself contains no model, MCP server, HDC, SDK or device runtime.

## Install the CLI first

Follow the [installation guide](installation.md). From a known checkout, the entry point is `.venv/Scripts/harmony-agent.exe` on Windows or `.venv/bin/harmony-agent` on POSIX. It need not be globally installed: give the agent the checkout or executable path.

Verify `--version --json` and `schema --json`. For device tasks, install HDC separately, authorize the device and select its exact ID. A Skill installation does not establish those prerequisites.

## Install the Skill folder

The complete, portable source is `skills/harmony-agent/`: copy or install that whole directory, including `references/`, `agents/` and `LICENSE`, rather than just `SKILL.md`.

From a `0.1.0a6` or newer source checkout, use the repository installer to place the complete package in a host's native discovery directory:

```powershell
python scripts/install-skill.py --host codex --scope project --project "C:/Work/example-project" --dry-run
python scripts/install-skill.py --host codex --scope project --project "C:/Work/example-project"
```

Use `--host copilot` for `.github/skills/harmony-agent/`, or `--scope user` for the selected host's user directory. Project scope is the default; the installer does not choose a user-wide installation without that option. Use `--destination` to update an exact existing Skill directory. It preserves unrelated files, upgrades unchanged package files and refuses conflicting local edits unless explicitly given `--force`. The installer copies instructions only; CLI/MCP installation remains a separate step. See [agent integrations](integrations.md) for integration choices and [GitHub Copilot setup](copilot.md#verify-the-integration) for the supplied adapter and template checks.

In Codex, ask the built-in installer:

```text
$skill-installer install the skill from https://github.com/andyandymike/harmony-automation-agent/tree/main/skills/harmony-agent
```

For a manual installation, current Codex documentation lists `~/.agents/skills/harmony-agent/` for user-wide discovery and `.agents/skills/harmony-agent/` in a working repository for project-local discovery. Use the skill root actually supported by your host. Some existing installations use `~/.codex/skills/`; update an existing copy in place instead of creating a duplicate name under another root. See [official Skill documentation](https://learn.chatgpt.com/docs/build-skills#where-to-save-skills).

Review local edits before updating an existing installation. Use the installer's conflict report or compare the new `SKILL.md`, metadata and referenced files with the installed copy before replacing intended files. Removing the installed `harmony-agent` Skill folder removes the instructions only; CLI/MCP installation, SDK and local device evidence are separate.

## Use and verify

Start a new turn after installation. If the host has not refreshed the Skill, reload its Skill list or restart it. An example request is:

```text
Use the Harmony Agent Skill. The CLI is in this checkout's .venv.
Check the CLI version and schema without contacting a device.
```

For a device task, also provide the exact selected device, application bundle and desired outcome. Let the agent inspect the UI to discover selectors; avoid providing unexplained coordinates or reusing old observation refs.

Check these outcomes separately:

1. **Source:** the Skill has a meaningful description/workflow and all linked references exist.
2. **Installed files:** the complete folder exists in the selected host's discovery root.
3. **Agent use:** an agent reads the installed Skill and can invoke the CLI and interpret its contract.
4. **Device acceptance:** tasks run against a real selected device and the requested final state is observed.

File copying or offline agent checks do not establish device acceptance. The project's [readiness record](release-readiness.md) keeps these evidence boundaries explicit.
