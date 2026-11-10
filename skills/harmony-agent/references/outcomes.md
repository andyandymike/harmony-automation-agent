# Harmony Agent outcome interpretation

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

## Text and observation limits

From `0.1.0a4`, non-editable display nodes retain a nonempty native `text`. If it is empty, null or missing, a nonempty `originalText` supplies `text`, with `textSource="originalText"` recording the fallback. Nonempty `originalText` remains available for inspection and exact selectors. Editable controls and known input types retain native `text` for input readback; display-text fallback does not establish an entered value.

Recovered text participates in `find`, exact text selectors, facts and text conditions. Use those results and their parent/app/window context when sufficient; a screenshot is not needed merely because a string came from `originalText`. Button labels can belong to descendant Text nodes rather than the clickable container. The CLI preserves that structure and does not combine labels or automatically switch targets to an ancestor. Use a stable control id or `within` context to resolve ambiguity, then verify the action's effect. An explicitly hidden or disabled ancestor prevents dispatch even if the selected child itself appears enabled.

`quality.complete` describes the captured tree and returned projection, not completeness of all visible content or application semantics. For genuinely missing screen text, compare a screenshot with a sufficiently large observation. To assign the cause, a diagnostic comparison must also inspect the native raw dump before normalization; normalized output alone cannot show whether the app omitted a string or the parser dropped a field. Raw dumps are not retained by default. Keep diagnostic captures local and review them before sharing.
