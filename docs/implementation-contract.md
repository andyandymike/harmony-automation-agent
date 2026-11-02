# Implementation contract (internal)

Python >=3.10, stdlib runtime, src/harmony_agent package. All new code original.

- errors.AgentError(code, message, details=None, dispatched='no', exit_code=1), to_dict().
- observation.normalize_layout(raw, frame_id, *, scope=None): normalized observation dict with nodes (full), controls, facts, projection, quality. Each node includes ref, id, text, type, bounds, boolean properties, parent, app/window context. Prefer key as id if raw id empty. Missing booleans None.
- observation.select_nodes(observation, selector): selector str id=.../text=.../type=.../ref @... or dict with properties. Exact matching. Return list. Parent/container context preserved.
- observation.resolve_target(observation, selector): exactly one or AgentError TARGET_NOT_FOUND/TARGET_AMBIGUOUS/STALE_REF. No old ref acceptance.
- observation.diff_observations(previous,current): reject incompatible projection as comparable false; compare stable key/identity, avoid false removal due output filtering. Root node identity and missing attributes not falsely invented.
- observation.project_observation(observation, *, max_nodes=80, interactive=False, query=None): public trimmed copy with business facts preserved and quality.truncated marker. Public controls/facts are refs into nodes; the internal full frame stores complete nodes. Do not mutate full observation.
- core.Agent(state_dir=None, hdc_path=None): execute(command, params) -> data dict. Commands doctor/devices/attach/detach/open/observe/find/press/fill/scroll/back/wait/screenshot/capabilities. Core owns session and transport. Input params use snake_case: session, device, app, ability, target, text, expect, timeout_ms, max_nodes, interactive, direction. expect dict selector/property/equals/timeoutMs. wait uses target/property/equals/timeout_ms. action result contains operationId/action/observation/assertion/timings.
- CLI invokes Agent.execute and serializes success/data or success false/error, plus schemaVersion/version. stdout JSON only with --json; errors exit nonzero. Global --state-dir/--hdc/--session/--device usable before or after command. --request FILE reads structured {command,...params} or {command,input:{...params}}; command schema generates help. Request example expect selector dict.
- HDC native adapter: device actions serialized through OS file locks, no automatic mutation retry, refs invalidated before dispatch.

Native fill is experimental. It validates a unique stable id, focuses and reads back focus, clears nonempty values and reads back emptiness plus focus, inserts once and checks the resulting text. All input subcommands share a deadline. A partial failure stays unknown; no automatic rollback or retry. Input may change the device clipboard. Public timings.actionMs includes preparation and intermediate input validation; timings.totalMs includes the complete action and verification path.
