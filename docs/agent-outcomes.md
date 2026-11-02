# Agent outcome interpretation

Read both process exit status and the JSON envelope. A normal envelope has `schemaVersion`, `version`, `success`, and either `data` or `error`.

| Evidence | Meaning | Next action |
| --- | --- | --- |
| `success=true`, assertion `passed` | The stated condition was observed | Report that condition; use the fresh returned observation |
| Action `completed` / `acknowledged`, assertion `not_requested` | The device acknowledged an action | Verify the business result before declaring task success |
| `error.details.dispatched=no` | This failed command did not dispatch its mutation | Fix the cause; preserve any effects of earlier commands |
| `error.details.dispatched=unknown` | Some effect may already have occurred | Observe and inspect the outcome before considering another mutation |
| Assertion `failed` or `unknown` after an action | Required result was not established | Preserve evidence; do not assume rollback or blindly retry |
| Quality `truncated=true` or `complete=false` | Returned data is incomplete | Obtain context; do not infer absence |
| Attribute `null` | Native evidence did not establish the attribute | Do not convert to `false` |

Read any nested `action`, `assertion`, `inputVerification`, and `evidence` together. Preserve the earliest mutation's uncertainty even if a later operation failed before dispatch. Trees and screenshots have separate capture times; do not assume atomic capture.

Use `STALE_REF` to reobserve, `TARGET_AMBIGUOUS` to refine the selector, and device/boot errors to re-establish the same device context. Keep IME/setup issues distinct from successful input. Do not treat an expected rejection test as a completed UI action.

Report uncertainty when no independent observation can determine the result. This alpha has no durable operation receipt lookup, automatic rollback, or exactly-once mutation guarantee.
