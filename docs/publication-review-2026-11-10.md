# Source publication review — 2026-11-10

Destination: [andyandymike/harmony-automation-agent](https://github.com/andyandymike/harmony-automation-agent). Version: `0.1.0a2`, development alpha. This check concerns GitHub source publication, not a stable release or a PyPI upload.

## Reviewed source and changes

The review started from commit `5611e3d`, the repository's sole existing commit, with a clean working tree. All 67 tracked text files and the reachable history were checked for common credential, private-path, device-identifier and generated-artifact patterns. No actual private credentials, signing files, device UDIDs, SDK binaries or application screenshots were found. Pattern checks cannot establish that arbitrary sensitive content is absent. Existing commit author metadata is retained.

Automatic scrolling could dispatch a swipe to a disabled or zero-area container, while an explicit target correctly failed. Both paths now share the existing actionability checks and reject such targets before dispatch. Regression tests cover disabled and zero-area targets, automatic and explicit selection, and a single swipe in each valid direction.

Publication preparation also adds clone instructions and package project links, excludes additional local configuration/signing/dependency files, and removes stale internal-work wording from the public quick starts. Historical validation reports remain unchanged.

## Validation

- Windows, Python 3.12.10: `PYTHONPATH=src python -m unittest discover -s tests -q` passed **150 tests** in 2.750 seconds.
- `python -m compileall -q src` and `git diff --check` passed.
- Private/local-file ignore patterns were checked, including `.env`, keys, local SDK configuration, dependency folders and build/state output. `.env.example` remains eligible for tracking.
- The initial source passed all **14** offline package checks using system Python and setuptools 80.9.0. The existing development `.venv` lacks pip, so it cannot run the build checker itself; the checker's fresh install environment is created separately.
- The final source passed all **14** offline package checks in 7.078 seconds; see the [machine-readable report](validation-publication-2026-11-10.json). It verifies wheel contents, source-byte parity, license inclusion, metadata, isolated installation and installed CLI contracts without contacting a device. The wheel contains 9 runtime files, has no third-party runtime dependencies, is 35,701 bytes, and has SHA256 `5dae54dcd04d4732e07e00bf746b18f64ff10d881f9f28f5a68093da29cff901`.
- **Not run:** device smoke after the scroll fix, physical-device testing, external human trials or package-registry publication. The 2026-11-03 device/agent results apply to the earlier source, as recorded in [alpha2 validation](validation-alpha2.md).

## Publication state

The destination was confirmed public and empty, and configured as local `origin`. On 2026-11-10, the owner confirmed copyright ownership of the reused fixture material and authorized MIT distribution. The fixture metadata, README and contribution/source records now consistently state MIT while preserving attribution. See [source provenance](source-provenance.md). Source push and hosted CI results will be recorded after completion.
