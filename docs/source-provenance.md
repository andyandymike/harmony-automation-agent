# Source provenance and distribution boundaries

Checked: 2026-11-03. This document records source facts and outstanding distribution checks; it does not infer a license from a repository being public.

| Material | Origin | Treatment |
| --- | --- | --- |
| `src/harmony_agent/`, associated CLI tests and new project documentation | Implemented for Harmony Automation Agent | Covered by this project's root MIT license |
| Fixture scaffold and resources | Project owner's `andyandymike/harmony-automation`, commit `ddaecb946c59d76648bfbb5ffa6b2273de83272f` | Keep the source attribution; confirm the owner's intended licensing of reused material before public redistribution |
| Fixture `Index.ets` | Rewritten for this project using the original fixture's business test contract | Preserve its derivation record; new controls do not erase the scaffold/resource source |
| Playwright CLI, agent-device, Midscene and OpenHarmony interface ideas | Design references and inspected public implementations | No required runtime dependency; importing source later requires the relevant notice and version record |
| Python standard library | User's Python installation | Runtime prerequisite, not bundled here |
| setuptools | Local build backend | Build prerequisite; not an installed runtime dependency |
| HDC, UiTest, SDK, system image and SDK test signing identity | Official locally installed tooling | Do not bundle these binaries, images, profiles or signing materials in this source distribution |
| Device trees, screenshots and input values | Local execution artifacts | Do not include real business artifacts, account data or private identifiers in public samples |

## Repository checks

The connected GitHub repository metadata identifies [andyandymike/harmony-automation](https://github.com/andyandymike/harmony-automation) as public, with default branch `main`. The authenticated account has repository administration permission. That confirms repository access; it does not itself establish the copyright status of every resource.

The [fixed fixture source](https://github.com/andyandymike/harmony-automation/tree/ddaecb946c59d76648bfbb5ffa6b2273de83272f/fixture-app) was readable. A request for root `LICENSE` at that same commit returned HTTP 404. This is a check of that exact path, not proof that no notice exists anywhere in the repository. The root MIT license in this new project records the intended license for its original implementation; do not claim it automatically supplies missing permission for all reused material.

The candidate repository `andyandymike/harmony-automation-agent` returned HTTP 404 at the check time. No repository was created or reserved by this check.

## Package-name checks

Both official PyPI endpoints returned HTTP 404 on 2026-11-03:

- [Project JSON](https://pypi.org/pypi/harmony-automation-agent/json)
- [Simple index](https://pypi.org/simple/harmony-automation-agent/)

This means no project was returned by those endpoints at the check time. It does **not** guarantee that the name is available for registration, unreserved, or acceptable under registry rules. Recheck immediately before a deliberate registry publication. No package was uploaded.

## Before a public release

1. Resolve and record the licensing of the reused fixture scaffold/resources with the project owner, or replace them with independently created materials.
2. Preserve any required copyright and license notices in the source package and wheel where applicable.
3. Record the exact source revision, build commands, tool versions and artifact hashes.
4. Inspect package contents: exclude state directories, caches, device identifiers, screenshots, HAP builds, signing profiles, private keys and SDK binaries.
5. Publish only the artifacts and destination explicitly chosen for that release. A local build or a name lookup is not a public release.
