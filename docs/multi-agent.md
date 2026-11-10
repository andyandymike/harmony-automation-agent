# Optional multi-agent operation

The execution core is model-free. Start with one agent and a short local plan through the [CLI or optional MCP interface](integrations.md). Add specialist agents when independent interpretation or review is useful; they consume frozen observations and execution records rather than controlling the device.

## Roles and ownership

| Role | Responsibility | Tool access |
| --- | --- | --- |
| Coordinator | Interpret the goal, create short plans, combine findings, choose recovery | Device execution and saved evidence |
| Page analyst | Resolve layout, label, scope, or text-source ambiguity | Saved evidence only |
| Evidence reviewer | Check whether the final claim is supported by the goal and observations | Saved evidence only |
| Native runner | Resolve targets, execute once, read back, apply requested checks, and record | One serialized device execution path |

These roles describe a delegation pattern, not required processes or model calls. The host chooses models, starts workers and supplies their tools; the core protocol does not depend on a particular delegation API. The project does not automatically start models or spend model credits. The [Copilot role templates](../integrations/copilot/agents/) are one optional host-specific example; other hosts need their own configuration.

For the evidence-only path, configure a separate `python -m harmony_agent.mcp --read-only` process. The server rejects device calls even if requested directly. This is an API boundary for that server, not an operating-system sandbox: a host that also gives a worker arbitrary shell execution or another device server can bypass the intended role boundary. Verify actual tools rather than relying on role prose or `readOnlyHint` annotations.

## Delegation contract

Give each worker a self-contained request:

```json
{
  "taskId": "review-stage-1",
  "goal": "Determine whether the requested setting was saved",
  "runId": "example-run",
  "frameId": "frame-from-the-execution-result",
  "allowedEvidence": ["the named run and frame"],
  "allowedActions": ["inspect", "report"],
  "constraints": ["Keep displayed values exact", "Do not contact the device"],
  "budget": {"maxToolCalls": 3},
  "expectedResult": "Findings with evidence references and remaining uncertainty"
}
```

These fields describe the host's delegation contract, not a new CLI command. `allowedEvidence` and the worker budget must be enforced by the host if they are needed as access or usage restrictions. The evidence server currently enforces its command allowlist, not per-worker row-level authorization.

Require a structured response containing `taskId`, `frameId` or `runId`, `findings`, `evidenceRefs`, `uncertainties`, and `needsFreshObservation`. Supply the relevant instructions and evidence explicitly; a worker should not assume it inherited the main conversation, the Skill or a current screen.

An analysis refers to its recorded frame. If the screen has advanced, the result is a recommendation that must be revalidated before action. Frame inspection reads local saved content and must not be described as a live observation. The runner's reuse of a published frame for up to 1000 ms applies only inside one uninterrupted run, never across model turns or specialist work. Use step-level `refresh: true` when an asynchronous page change matters. A request ID or completed report does not provide device-level exactly-once guarantees.

Use the default compact report first. Evidence verification still covers the full saved record; receipts, goals and unique errors remain available. Use its `result.observationRef` with `inspect` for page detail, or `full: true` when the complete saved representation is necessary. Do not send every worker duplicate step and page copies by default.

## When to delegate

Use a page analyst for a genuinely ambiguous frozen page, or an evidence reviewer for a stage with meaningful semantic uncertainty. Independent analysis of already-recorded evidence can overlap unrelated work. Pause operations that depend on a pending finding.

Do not turn every click into planner, observer, actor, and reviewer model calls. Exact comparisons, receipt completeness, counters, and known branches belong in the runner. Use task-relevant checks and final goals; `before` and `expect` are optional, and a passed expectation needs no duplicate wait. Start with the compact tree and choose semantic output only when its added context helps. Two Agents must not operate one device in parallel. Separate devices can have separate tasks when their application state and external effects are independent.

If delegation is unavailable, the coordinator performs the analysis itself. If MCP is unavailable, the CLI remains an option when the host permits process execution. A fallback does not change the host's tool permissions.

## Validation and performance

Compare single-Agent execution, exception-triggered page analysis, and stage-level independent review on the same unfamiliar task set. Retain the existing compact/summarized baseline. Record end-to-end time, success, wrong actions, missed conditions, recoveries, model calls, and actual token or credit usage where available. A smaller main context is not proof of lower total cost.

Local adapter checks do not establish that a particular host delegates correctly or enforces the intended tools. Verify those behaviors in the chosen integration using the [integration checklist](integrations.md#verify-the-integration). The optional [Copilot guide](copilot.md#verify-the-integration) adds checks for that host.
