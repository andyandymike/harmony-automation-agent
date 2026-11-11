# Agent integrations

Harmony Agent provides a CLI, a portable instruction Skill, and an optional local stdio MCP adapter. All use the same native execution core. Choose the interfaces your agent host can use; the core does not call a model or depend on a particular agent product.

## CLI

Install the package using the [installation guide](installation.md), then give the caller the installed executable path. Check the contract without contacting a device:

```sh
harmony-agent --version --json
harmony-agent schema run --json
```

The caller needs permission to start the process and read its JSON output. For a reusable plan, use CLI `--plan-file FILE` with `run` or `execute`; the file contains only the raw plan, while device/session context stays on the command line. Complete UTF-8 request envelopes remain available through `--request FILE` for nested input, Unicode or awkward shell values. See [request examples](agent-requests.md) and the [execution guide](execution.md). The checks above are for setup; retain the learned contract during tasks.

Use `execute` for a complete known workflow with explicit initial conditions and final goals; it normally detaches after verified completion. Use `start` and `run` when page exploration or another outer decision is needed. `execute` defaults to decision output, while `run` keeps its full-response default.

Python and HDC must run where the selected device is accessible. A remote workspace, container or WSL session does not automatically inherit another machine's USB access. Keep the selected session and state directory consistent across calls.

## Portable Skill

The [complete Skill](../skills/harmony-agent/SKILL.md) teaches an outer agent to use the CLI or configured MCP tools and interpret their results. It contains instructions and references, not a model, MCP implementation, SDK or device runtime.

Install the whole `skills/harmony-agent/` directory. The repository installer has discovery-path presets for Codex and GitHub Copilot, plus an explicit destination option. See [Skill setup](skill-setup.md). A matching directory layout does not prove that a host selected or followed the Skill; verify explicit use and automatic discovery separately.

## Optional local MCP

An MCP client with local stdio support can launch the installed package using its Python executable:

```sh
python -m harmony_agent.mcp --state-dir .harmony-agent
```

The host starts the process and exchanges UTF-8 JSON-RPC messages over stdin/stdout. No network listener is opened. Use an absolute state directory when host working directories vary, and supply `--hdc` when the executable cannot be discovered. Keep the process connected across calls to avoid repeated CLI startup.

Commands are exposed as `harmony_<command>` tools with the same validation as the CLI, including `harmony_execute` for complete known tasks. Use `harmony_schema` for unfamiliar contract details and retain the learned contract across calls. Results include the CLI-style envelope in text and `structuredContent`. Read command success, run status, goal verification and session cleanup separately. After response loss, query the business report and its independent `workflowReceipt` without replaying the task; see [execution outcomes](execution.md#interpret-outcomes-separately).

For frozen evidence access, launch a separate process with `--read-only`. Its enforced tool allowlist contains only `harmony_inspect`, `harmony_report` and `harmony_schema`; it cannot capture a new device observation. Point both processes at the same state directory to share evidence. This restricts that server's API, not other tools the host might grant to an agent.

The adapter supports MCP protocol `2025-06-18` and negotiates that version during initialization. It executes one tool at a time; an overlapping call receives a busy error. Cancellation is cooperative and cannot undo a dispatched device action. HTTP transport, sampling and arbitrary code execution are not implemented. Local protocol tests do not establish compatibility with every MCP client.

## Host configuration examples

Process paths, environment variables, Skill discovery and tool permissions belong to the host's configuration. A configuration file for one host is not automatically valid in another.

The repository currently supplies [GitHub Copilot in VS Code examples](copilot.md): two MCP configuration formats and optional specialist-agent templates. The [Skill setup guide](skill-setup.md) also documents the installer presets. For another host, start from CLI process invocation or its documented stdio MCP configuration and run the checks below. Compatibility must be verified in that host's environment.

A single agent can complete tasks without delegation. If independent page interpretation or evidence review is useful, see the [optional multi-agent pattern](multi-agent.md).

## Verify the integration

Record the package version, host version and execution environment. Check the interface actually in use:

1. Invoke version and schema offline; pass nested JSON, Unicode, empty values and paths with spaces.
2. If using a Skill, verify explicit use, then automatic discovery separately.
3. Select the exact device, establish HDC access and complete a small task with an observable outcome.
4. Check run-status handling, cancellation and response-loss recovery. Query the report before deciding whether another action is needed.
5. If using evidence tools or specialists, verify their effective tool access and frozen-frame inspection.

Keep raw trees, screenshots, requests and run records in the ignored local state directory. Tool results may enter the host model's context; local storage does not mean those inputs remain on the machine. Share reviewed summaries or synthetic examples.
