# GitHub Copilot in VS Code

This optional guide configures Harmony Agent for GitHub Copilot in VS Code. Start with the [agent integration overview](integrations.md) for the shared CLI, Skill and MCP interfaces. Copilot is one host example; it is not a dependency of the execution core.

## Install the CLI and Skill

Install the matching package using the [installation guide](installation.md). In a remote VS Code workspace, confirm where tools execute and whether that environment can access the selected device.

From this source checkout, install the complete Skill into the desired working project:

```powershell
python scripts/install-skill.py --host copilot --scope project --project "C:/Work/example-project" --dry-run
python scripts/install-skill.py --host copilot --scope project --project "C:/Work/example-project"
```

This places the package in `.github/skills/harmony-agent/`. Use `--scope user` for `~/.copilot/skills/harmony-agent/`, or `--destination` for an exact existing Skill directory. The installer preserves unrelated files and refuses conflicting local edits unless given `--force`. It copies instructions only; see [Skill setup](skill-setup.md) for upgrade behavior.

In the selected Copilot harness, explicitly request the Harmony Agent Skill and give it the CLI path. Begin with an offline request:

> Use the Harmony Agent Skill. Check the CLI version and the run schema, without contacting a device. Explain the difference between completed execution and a verified task goal.

Then test natural-language Skill selection separately. Availability does not guarantee automatic selection. See the [official Skill locations and verification guide](https://code.visualstudio.com/docs/agent-customization/agent-skills).

## Optional local MCP

Use the [local MCP adapter](integrations.md#optional-local-mcp) through one of the supplied configuration examples:

- [VS Code format](../integrations/copilot/mcp.vscode.example.json): merge the `servers` entries into `.vscode/mcp.json`. The example assumes a Windows project-local venv; adjust the executable for the actual installation.
- [Copilot portable format](../integrations/copilot/mcp.portable.example.json): merge `mcpServers` into workspace-root `.mcp.json` or Copilot's user configuration. Set `HARMONY_AGENT_PYTHON` to the installed Python executable and `HARMONY_AGENT_STATE_DIR` to an absolute local state directory in the execution host's environment.

Use one configuration format for a server and preserve unrelated entries. Adjust executable paths and tool permissions for the selected harness. [Official MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

The examples name the execution server `harmonyDevice` and the read-only evidence server `harmonyEvidence`. Keep those names when using the supplied agent templates, and point both servers at the same state directory. Verify `harmony_schema` first. Shared output, cancellation and evidence behavior are documented in the [integration overview](integrations.md#optional-local-mcp) and [execution guide](execution.md).

## Optional specialist agents

Copy the supplied [agent templates](../integrations/copilot/agents/) into the working project's `.github/agents/` after configuring the matching MCP server names and installing the Skill. See [multi-agent operation](multi-agent.md) for delegation and permission boundaries. A single Agent plus the runner remains a complete execution path.

Current VS Code Copilot and Local harnesses have different delegation tools and supported frontmatter. These templates target `github-copilot`, use no fixed model ID, and do not depend on Local `handoffs` or `runSubagent`. Confirm the effective tool list in the intended host. [Official custom-agent compatibility reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference).

## Verify the integration

Run the [shared integration checks](integrations.md#verify-the-integration), recording the VS Code/Copilot version and selected harness. Check these Copilot-specific details:

1. The selected Skill location supports explicit use and automatic discovery as intended.
2. The chosen MCP configuration starts the intended Python executable, uses the expected state directory and exposes the named servers without duplicate copies.
3. If specialist templates are enabled, their effective tools match the configured evidence access, and unavailable delegation falls back to the main agent.

Local protocol tests do not establish these host behaviors; verify them in the configured VS Code environment.
