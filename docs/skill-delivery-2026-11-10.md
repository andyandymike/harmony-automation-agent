# Skill delivery — 2026-11-10

The public project now includes a portable instruction-only Skill in [skills/harmony-agent](../skills/harmony-agent/SKILL.md). The CLI remains the execution layer. The Skill is distributed from the repository separately from the Python wheel; see [setup](skill-setup.md).

## Gap corrected

The 2026-11-03 work produced CLI calling guides and recorded a blocked personal installation. The local Skill directory existed, but `SKILL.md` was an initialization template: its description was a YAML list and its body contained unfinished placeholders. The current validator rejected that scaffold. Therefore, describing the remaining work as only installation understated the missing Skill implementation.

The maintained operating workflow and request/outcome references now live inside the Skill folder, with valid frontmatter, Agent metadata and an MIT license. The old documentation URLs remain forwarding guides. English and Chinese READMEs link to installation instructions. The local existing Skill location was updated from this same source; no separate private-only implementation is maintained.

## Completed checks

See [machine-readable evidence](validation-skill-2026-11-10.json) for file hashes, proposed requests and the new wheel hash.

- Repository and installed Skill both passed the creator's structure/placeholder validator.
- All five Skill files matched byte-for-byte between repository and installed copy. Referenced resources resolve within the Skill, so the installed folder does not depend on a nearby checkout for its instructions.
- Three bundled JSON request examples passed the runtime request validator. Local Markdown links resolve.
- All nine installed Python runtime files matched repository source. The independent check below used the installed executable, not an unverified global command.
- One fresh Agent read only the installed Skill/references and CLI help/schema. It actually ran five no-device CLI commands, including a diagnostic with an explicitly nonexistent HDC path.
- It prepared schema-valid requests to clear a field with an empty-text assertion and select the correct one of two identically labeled buttons. For an uncertain Increment timeout, it proposed only a fresh observation and did not reuse the stale ref or repeat the press. These requests were checked with the runtime parser but were not executed on a device.
- It correctly interpreted `doctor` returning `success=true` with `data.ready=false` and `HDC_NOT_FOUND` as not ready. One local PowerShell JSON-readback syntax error was corrected and retained in the local record.
- The updated README/package passed all 14 offline release checks in a fresh venv; no Python runtime behavior changed in this Skill delivery.

## Remaining evidence

Fresh-turn automatic Skill selection in the desktop UI has not been observed. Explicit reading/use of the installed Skill was checked; the next turn can load the updated Skill metadata.

No device tasks were run in this check. Prior device/Agent results retain their original revision and scope. External human trials and clean-host SDK setup remain incomplete. An [external trial plan](external-trial.md) now exists, with no enrolled participants or fabricated results.

The built-in `skill-installer` successfully downloaded `skills/harmony-agent` from public source revision [`d021831`](https://github.com/andyandymike/harmony-automation-agent/commit/d0218318f46a296e77f34602cd60a85cbbfee082) into an empty isolated destination. All five downloaded files matched the repository source and the downloaded Skill passed validation. This verifies the public installation path independently of the maintainer's existing local copy.
