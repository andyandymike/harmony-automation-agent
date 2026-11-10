# Source provenance and distribution boundaries

Updated: 2026-11-10. This document records source attribution, the owner's licensing authorization and distribution boundaries.

| Material | Origin | Treatment |
| --- | --- | --- |
| `src/harmony_agent/`, associated CLI tests and new project documentation | Implemented for Harmony Automation Agent | Covered by this project's root MIT license |
| Fixture scaffold and resources | Project owner's `andyandymike/harmony-automation`, commit `ddaecb946c59d76648bfbb5ffa6b2273de83272f` | Owner confirmed copyright ownership and authorized MIT distribution on 2026-11-10; covered by the root MIT license with attribution retained |
| Fixture `Index.ets` | Rewritten for this project using the original fixture's business test contract | Covered by the root MIT license; preserve its derivation record |
| Playwright CLI, agent-device, Midscene and OpenHarmony interface ideas | Design references and inspected public implementations | No required runtime dependency; importing source later requires the relevant notice and version record |
| Python standard library | User's Python installation | Runtime prerequisite, not bundled here |
| setuptools | Local build backend | Build prerequisite; not an installed runtime dependency |
| HDC, UiTest, SDK, system image and SDK test signing identity | Official locally installed tooling | Do not bundle these binaries, images, profiles or signing materials in this source distribution |
| Device trees, screenshots and input values | Local execution artifacts | Do not include real business artifacts, account data or private identifiers in public samples |

## Repository checks

The connected GitHub repository metadata identifies [andyandymike/harmony-automation](https://github.com/andyandymike/harmony-automation) as public, with default branch `main`. The authenticated account has repository administration permission. That confirms repository access; it does not itself establish the copyright status of every resource.

The [fixed fixture source](https://github.com/andyandymike/harmony-automation/tree/ddaecb946c59d76648bfbb5ffa6b2273de83272f/fixture-app) was readable. A request for root `LICENSE` at that same commit returned HTTP 404. On 2026-11-10, the project owner explicitly confirmed ownership of the reused scaffold/resources and authorized their distribution under this project's MIT license. The fixture module's previous Apache-2.0 metadata was updated to MIT to match that authorization. This records permission for the material included here; it does not modify the historical source repository.

The candidate repository `andyandymike/harmony-automation-agent` returned HTTP 404 on 2026-11-03. On 2026-11-10, the selected [publication repository](https://github.com/andyandymike/harmony-automation-agent) was confirmed public and empty, with administration and push access. It is the destination for this project's source publication; package-registry publication is separate.

## Package-name checks

Both official PyPI endpoints returned HTTP 404 on 2026-11-03:

- [Project JSON](https://pypi.org/pypi/harmony-automation-agent/json)
- [Simple index](https://pypi.org/simple/harmony-automation-agent/)

This means no project was returned by those endpoints at the check time. It does **not** guarantee that the name is available for registration, unreserved, or acceptable under registry rules. Recheck immediately before a deliberate registry publication. No package was uploaded.

## Before a public release

1. Keep the fixture attribution and the owner's 2026-11-10 MIT authorization recorded above. Review the source and license of any additional reused materials separately.
2. Preserve any required copyright and license notices in the source package and wheel where applicable.
3. Record the exact source revision, build commands, tool versions and artifact hashes.
4. Inspect package contents: exclude state directories, caches, device identifiers, screenshots, HAP builds, signing profiles, private keys and SDK binaries.
5. Publish only the artifacts and destination explicitly chosen for that release. A local build or a name lookup is not a public release.
