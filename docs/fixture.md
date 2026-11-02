# Fixture v2

Bundle: `com.andyandymike.harmonyautomation.fixture`.
Ability: `EntryAbility`. HarmonyOS 6.1.1 / API24 source baseline.

Current recorded validation is [alpha2](validation-alpha2.md): the dedicated emulator's input method was initialized in basic mode before testing. Both real input controls passed Chinese fill, replacement and clear checks; native submit also passed the full smoke. This does not establish arbitrary IME, composition or physical-device support.

The project scaffold and resources originate from the user's
`andyandymike/harmony-automation` commit
`ddaecb946c59d76648bfbb5ffa6b2273de83272f`. The page is rewritten for this project.

## Build an unsigned HAP on Windows

Install the official HarmonyOS Command Line Tools and a compatible Node runtime.
Then run from the repository root:

```powershell
.\scripts\build-fixture.ps1 -ToolRoot 'D:\Program Files\Huawei\command-line-tools'
```

The script discovers Hvigor and SDK beneath the explicitly supplied tool root;
it does not download an SDK or alter signing configurations. Hvigor rejects
Unicode project paths, so the script copies source into a fresh ASCII workspace
under TEMP (or `-BuildRoot`) and retains it for diagnostics. Output:
`fixture-app/build/outputs/harmony-agent-fixture-v2-unsigned.hap`.

An unsigned build is not proof of installation or device operation. Sign using
your authorized DevEco debug workflow before installing. The existing
`harmony-automation` fixture builder also supports SDK-bundled public test
credentials bound to an exact local emulator UDID; this is an emulator-only
test path, never a production signing procedure. Private signing credentials
must remain outside this repository and deliverable archives.

For the local emulator test path, supply a file outside the repository containing
only its 64-character signing UDID. The CLI does not obtain this value for you.
The emulator target must be explicitly named and restricted to the official
loopback port range. The script uses the SDK's public test identity in place:

```powershell
.\scripts\build-fixture.ps1 -ToolRoot '<official-command-line-tools>' `
  -SkipBuild -SigningUdidFile '<private-temp-udid-file>' `
  -EmulatorTarget '127.0.0.1:15555'
```

This writes `fixture-app/build/outputs/harmony-agent-fixture-v2-signed.hap` and
a SHA256 sidecar after profile and HAP verification. Profile files containing
the UDID stay in the private ASCII build workspace. The script does not install
or launch an app. Use a separate authorized device operation to install it.
The source archive must exclude build directories, signed HAPs and profiles.

Initial implementation validation: ArkTS compile and unsigned packaging passed
on Windows with the installed HarmonyOS 6.1.1/API24 SDK. Runtime behaviors are
verified separately by the device smoke procedure below.

## State and identifiers

| Identifier | Behavior |
| --- | --- |
| fixture.ready | READY once the page exists |
| fixture.input | Real TextInput; Chinese/English/digit input with normal IME behavior |
| fixture.input.native | Second real TextInput, labeled Native input (no soft keyboard); keyboard-on-focus disabled |
| fixture.input.value | Mirrors app state as Value: text or Value: <empty> |
| fixture.submit / fixture.output | Submit produces Hello, plus the current input |
| fixture.increment / fixture.counter | Increments and displays Counter: N |
| fixture.switch / fixture.switch.value | Toggle state and independent On/Off text |
| fixture.delayed.start / fixture.delayed.status | Loading then Ready after delay after 600 ms |
| fixture.reset | Cancels pending delayed work and resets all app state |
| fixture.row.a.choose / fixture.row.b.choose | Both display Choose; distinct parents and keys |
| fixture.selected | Records which row was chosen |
| fixture.scroll / fixture.scroll.item.N | Outer Scroll with 12 fixed items |
| fixture.scroll.end | END OF FIXTURE at the bottom |

The scroll is a simple container, not a virtual list. This fixture does not
prove nested/virtual scroll or transient toast handling. Readback from the
TextInput is the input oracle; the mirror text is an additional app-state signal.

The standard and native-only fields share one app value. Test and report them
as separate input paths. `fixture.input.native` uses
`.enableKeyboardOnFocus(false)` to isolate native text injection from keyboard
onboarding; it remains a genuine editable TextInput. A successful native-only
test does not establish ordinary IME, soft-keyboard display or editor-action
support. Do not replace standard-input failures with native-input successes in
the same reported test case.

Real TextInput can trigger system keyboard privacy/onboarding UI on a fresh
emulator. Surface that state and let the operator configure it; do not silently
accept privacy terms or replace the field with a fake input. A successful build
does not establish Unicode replacement, clearing or keyboard action support.

## Manual smoke sequence

1. Open EntryAbility and observe READY and Counter: 0.
2. Test `fixture.input` with Chinese + ASCII + digits, read it back, submit and verify output. If keyboard privacy/onboarding blocks it, report that limitation.
3. Independently test `fixture.input.native` with the same text and report it specifically as native injection without soft keyboard.
4. Replace the value with a different string, then clear and verify the field is empty, recording the field used.
5. Increment, verify Counter: 1, then Reset and verify Counter: 0.
6. Toggle and inspect both the control state and independent On/Off text.
7. Start delayed loading and wait for Ready after delay.
8. Verify text=Choose is ambiguous and stable keys select the intended row.
9. Scroll to END OF FIXTURE with bounded steps.

## Reproducible device smoke

After an operator installs fixture-v2 and authorizes the selected device, run:

```powershell
python scripts/device-smoke.py --device '<exact-device-id>' `
  --hdc '<path-to-hdc>' --state-dir '.harmony-agent/smoke-state' `
  --output '.harmony-agent/device-smoke.json'
```

The standard-library script imports the local `Agent`, explicitly opens the
fixture bundle and checks reset/increment, stale-ref and ambiguous-selector
rejection, switch state, delayed text, row selection, bounded scrolling,
screenshot capture and failure evidence. It restores the top position with at
most four upward scrolls, and makes at most four downward scrolls when seeking
the end. It detaches its own session without stopping the device. It does not
install apps, accept privacy dialogs or alter device authorization.

The printed and saved JSON records per-command elapsed time and pass/fail/skip,
without device identifiers, local paths or screen contents. Failure evidence
remains in the Agent state directory; treat that directory as private. Total
time includes device checks, UI observations and assertion polling, so this is
a functional smoke test rather than an isolated input-latency benchmark.

Input is explicitly skipped by default. Add `--include-input` to test Chinese
fill, submit, replacement and clearing through `fixture.input.native` only.
This may change the clipboard. The input checks run after the other cases and
are reported separately; a failed input step skips dependent input operations.
The ordinary IME path is always reported as a separate skipped case and requires
an operator-configured test. Native-input success must not be reported as IME
success.
