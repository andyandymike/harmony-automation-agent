# Harmony Agent request examples

Read the installed schema first: `harmony-agent schema press --json`. Replace sample ids, values, and sessions using the task and actual observations. These examples do not establish that a target exists.

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

On `0.1.0a5` or newer, `compact`, `max_nodes` and `interactive` control the returned observation, including action and `wait` results. Inspect the assertion and reuse that observation for the next decision; a passed condition does not need a separate `wait`. These output options do not weaken internal target checks or assertions.

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
