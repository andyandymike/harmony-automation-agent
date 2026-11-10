# 0.1.0a3 core-fix validation

Date: 2026-11-10 (Asia/Tokyo). Base revision: `72405a4`. This is a local, unreleased candidate; alpha2's device and hosted CI evidence does not validate these source changes.

## Scope

The reviewed failures are covered by source fixes and reproducible offline regression cases:

- Frame-dependent parent/ref/within conditions cannot turn stale selectors into successful absence assertions; validation happens before a mutation.
- Fresh ref resolution preserves additional selector predicates and supports valid current-frame parent/within targets.
- Explicitly non-editable inputs fail before focus/clear/insertion. Automatic-scroll actionability checks from the base revision remain covered.
- Filtered observations and changes share documented node/change budgets. Duplicate identities become unknown rather than false additions/removals.
- Damaged local sessions can detach and reattach; storage access failures preserve the state file. Persisted frame validation and Windows reserved session names have regressions.
- Secondary state/evidence/trace failures preserve known action status, operation ID and uncertainty. No automatic mutation retry was introduced.

Regression coverage is in `tests/test_review_regressions.py`, `test_observation.py`, `test_state.py`, `test_cli.py` and the existing `test_core.py`.

## Verification

- **187 offline tests passed**, with zero failures, errors or skips. Windows / Python 3.12.10; the runner measurement was 4.016 seconds. The [machine-readable record](validation-core-alpha3.json) includes source/test SHA-256 hashes.
- **14 isolated build/install checks passed**, in 7.469 seconds, with package downloads disabled. Checks cover wheel content/RECORD, metadata, source parity, clean-venv installation, import isolation, CLI help/version/schema, missing HDC and invalid request handling. The exact [package report](validation-release-alpha3.json) is retained.
- Wheel: `harmony_automation_agent-0.1.0a3-py3-none-any.whl`, 37,410 bytes, no third-party runtime dependencies. SHA-256: `a25d6080df76234f8d4fee45e42fcd04f9cbdd1d78c1549ef6482eeee3cf7b27`. The verified artifact is also available under local `dist/` and installed into this checkout's `.venv`.
- The first packaging attempt used the checkout venv, which has no pip, and failed before building. The successful check used the already installed host Python 3.12 and its build tools; no package download or system installation was needed. After the README was finalized, the exact deliverable was rebuilt and all fourteen checks passed again; the report above identifies that final artifact. All raw runs remain under the ignored local `.harmony-agent/release-alpha3/` directory.
- An independent offline review exercised eleven selector/rebinding/diff cases. Stable targets and valid current-frame parent/within references remained usable; changed predicates and frame-dependent expectations rejected before dispatch. A 300-change filtered query returned one relevant diff instead of 300, with 299 filtered changes reported explicitly. This is synthetic output evidence, not a model-token or device-performance benchmark.

The environment check found HDC `3.2.0d`, with `doctor.data.ready=false` and zero connected targets. Device smoke, ordinary/native input, real applications and physical-device validation are **NOT_RUN** for alpha3. No emulator was installed, no authorization/IME settings were changed, and no previous device pass was relabeled as a current pass.

The existing Windows/Ubuntu CI definition is retained, but it has not run for this local candidate. No commit, remote push, GitHub release or PyPI publication was performed as part of this repair.

## Protocol and remaining limits

Package version is `0.1.0a3`; request/output `schemaVersion` remains `"1"`. Existing valid stable-selector requests retain their shape. Frame-dependent conditions now fail explicitly, and diff responses add quality/frame metadata. Clients should continue checking action and assertion separately, and must inspect diff completeness before making absence claims.

Diff budgets count entries, not bytes or tokens; long individual text values may still be large. UI observation and device input are not atomic. Real-device compatibility, multi-window/virtual-list behavior, external human trials, and publishing this candidate require separate evidence.
