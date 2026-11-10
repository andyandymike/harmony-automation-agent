# Harmony Agent fixture v2

Small deterministic ArkTS app for the native Harmony Agent alpha. No accounts,
network access or production data. Bundle and ability remain
`com.andyandymike.harmonyautomation.fixture` / `EntryAbility`.

This version uses a real TextInput and its normal keyboard behavior. The old
Button/onKeyEvent input was intentionally replaced. Installing v2 over the old
fixture changes that test contract; retain the old HAP separately if needed.

A second real TextInput, `fixture.input.native`, disables keyboard display on
focus for an explicitly separate native-injection test. It shares the same app
value with the standard input. Success on this field does not establish normal
IME or soft-keyboard support; `fixture.input` remains unchanged for that test.

Project scaffold and resources derive from the user's
[harmony-automation fixture](https://github.com/andyandymike/harmony-automation/tree/ddaecb946c59d76648bfbb5ffa6b2273de83272f/fixture-app).
Index.ets was rewritten for this project. Baseline is HarmonyOS 6.1.1 / API24.

The fixture code, scaffold and resources are covered by the repository's
[MIT License](../LICENSE). The project owner confirmed ownership and MIT
distribution authorization on 2026-11-10; the original source attribution is retained.

Build and signing details are in [docs/fixture.md](../docs/fixture.md).
