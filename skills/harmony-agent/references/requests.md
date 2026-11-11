# Harmony Agent request examples

Retain the installed contract while continuing a task. For unfamiliar press syntax, consult `harmony-agent schema press --json`; no routine full-schema reload is needed. Replace sample ids, values, and sessions using the task and actual observations. These examples do not establish that a target exists.

Save UTF-8 JSON. Run `harmony-agent --request request.json --session task --state-dir <directory> --json`; add `--hdc <path>` if required. Explicit CLI context overrides request session/device; keep it consistent.

## Press a unique button and verify a text result

```json
{
  "schemaVersion": "1",
  "command": "press",
  "input": {
    "session": "task",
    "compact": true,
    "target": {"text": "Choose", "within": {"id": "order-a"}},
    "expect": {
      "selector": {"id": "selected-order"},
      "property": "text",
      "equals": "Order A",
      "timeoutMs": 5000
    }
  }
}
```

On `0.1.0a5` or newer, `compact`, `max_nodes` and `interactive` control the tree observation returned by individual commands, including action and `wait` results. Top-level `run.interactive` requires alpha8. Inspect the assertion and reuse that observation for the next decision; a passed condition does not need a separate `wait`. These output options do not weaken internal target checks or assertions. For a known continuous sequence, use the [plan format](plans.md#request-shape) instead of issuing one request per action.

## Replace text and verify a related value

```json
{
  "schemaVersion": "1",
  "command": "fill",
  "input": {
    "session": "task",
    "target": "id=customer-name",
    "text": "测试客户 ABC 123",
    "timeout_ms": 7000,
    "expect": {
      "selector": "id=name-preview",
      "property": "text",
      "equals": "测试客户 ABC 123",
      "timeoutMs": 5000
    }
  }
}
```

Use `"text": ""` to clear. Native input may change the device clipboard. Inspect input verification and extra assertions separately; a failure may have already cleared the old value.

## Wait for a deterministic boolean state

```json
{
  "schemaVersion": "1",
  "command": "wait",
  "input": {
    "session": "task",
    "target": {"id": "notifications-toggle"},
    "property": "checked",
    "equals": true,
    "timeout_ms": 5000
  }
}
```

Command fields use `timeout_ms`; nested `expect` uses `timeoutMs`. Text conditions require strings and boolean properties require JSON booleans. Do not put refs in expectations. If a tree state is unknown, use another observable business condition or report that the property cannot be verified.

## Read a saved run

For a recorded run named `example-save-1`, the CLI run ID is positional:

```sh
harmony-agent report example-save-1 --state-dir .harmony-agent --json
harmony-agent report example-save-1 --state-dir .harmony-agent --full --json
```

The equivalent compact-report request file uses the `run_id` field:

```json
{
  "schemaVersion": "1",
  "command": "report",
  "input": {"run_id": "example-save-1"}
}
```

Run that file with `harmony-agent --request report.json --state-dir .harmony-agent --json`. For MCP, call `harmony_report` with arguments `{"run_id":"example-save-1"}`; add `"full":true` only when the complete saved representation is needed. MCP arguments are the request's `input` object, not the command envelope.

To expand a frame from the report, substitute its actual frame ID:

```sh
harmony-agent inspect --frame-id FRAME_ID --run-id example-save-1 --state-dir .harmony-agent --max-nodes 40 --json
```

The matching MCP call is `harmony_inspect` with arguments `{"frame_id":"FRAME_ID","run_id":"example-save-1","max_nodes":40}`. Unlike `report`, CLI `inspect` takes the run ID as `--run-id`. Both commands read frozen local evidence without contacting the device.
