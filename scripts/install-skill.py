"""Install the portable Skill into a host's discovery directory, without deps."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile


MANIFEST = ".harmony-skill-install.json"
HOST_DIRS = {"copilot": (".github", ".copilot"), "codex": (".agents", ".agents")}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def destination_for(host, scope, project=None, home=None):
    project = Path(project or Path.cwd())
    home = Path(home or Path.home())
    return (project / HOST_DIRS[host][0] if scope == "project" else home / HOST_DIRS[host][1]) / "skills" / "harmony-agent"


def safe_child(root, relative):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError("Invalid path in install manifest.")
    child = root / relative
    if ".." in Path(relative).parts or not child.resolve().is_relative_to(root.resolve()):
        raise ValueError("Install path escapes the destination.")
    path = child
    while path != root:
        if path.is_symlink():
            raise ValueError("Skill installation does not follow destination symlinks.")
        if path != child and path.exists() and not path.is_dir():
            raise ValueError("A file conflicts with a Skill directory: " + str(path.relative_to(root)))
        path = path.parent
    if root.exists() and not root.is_dir():
        raise ValueError("The Skill destination must be a directory.")
    return child


def install(source, destination, *, force=False, dry_run=False):
    source, destination = Path(source).absolute(), Path(destination).absolute()
    if source.is_symlink() or destination.is_symlink():
        raise ValueError("Source and destination must not be symlinks.")
    source, destination = source.resolve(), destination.resolve()
    if (source == destination or destination.is_relative_to(source) or source.is_relative_to(destination)):
        raise ValueError("Source and destination must be separate directory trees.")
    if not (source / "SKILL.md").is_file():
        raise ValueError("Source must contain SKILL.md.")
    source_files = {}
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError("Skill source must not contain symlinks.")
        if path.is_file() and path.name != MANIFEST:
            source_files[path.relative_to(source).as_posix()] = digest(path)
    manifest_path = safe_child(destination, MANIFEST)
    previous = {}
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            previous = manifest["files"]
            if not isinstance(previous, dict) or any(not isinstance(x, str) for x in previous.values()):
                raise ValueError()
        except (ValueError, KeyError, TypeError) as exc:
            raise ValueError("Existing install manifest is invalid; inspect it before updating.") from exc
    conflicts, changed, removed = [], [], []
    for relative, new_hash in source_files.items():
        target = safe_child(destination, relative)
        if target.exists() and not target.is_file():
            raise ValueError("A directory conflicts with a Skill file: " + relative)
        if target.exists():
            current = digest(target)
            if current == new_hash:
                continue
            if current != previous.get(relative):
                conflicts.append(relative)
        changed.append(relative)
    for relative, old_hash in previous.items():
        target = safe_child(destination, relative)
        if relative not in source_files and target.exists():
            if not target.is_file():
                raise ValueError("A directory conflicts with a previously installed file: " + relative)
            if digest(target) != old_hash:
                conflicts.append(relative)
            removed.append(relative)
    if conflicts and not force:
        raise ValueError("Local changes would be overwritten; review them and use --force if intended: " + ", ".join(conflicts))
    result = {"destination": str(destination), "files": len(source_files), "updated": changed,
              "removed": removed, "overwrittenLocalChanges": conflicts, "dryRun": dry_run}
    if dry_run:
        return result
    destination.mkdir(parents=True, exist_ok=True)

    def atomic_write(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".harmony-install-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
            os.replace(temporary, path)
        finally:
            if Path(temporary).exists():
                Path(temporary).unlink()

    for relative in changed:
        atomic_write(safe_child(destination, relative), (source / relative).read_bytes())
    for relative in removed:
        safe_child(destination, relative).unlink()
    atomic_write(manifest_path, json.dumps({"format": "harmony-skill-install/1", "files": source_files},
                                          indent=2).encode("utf-8") + b"\n")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", choices=HOST_DIRS, required=True)
    parser.add_argument("--scope", choices=("project", "user"), default="project")
    parser.add_argument("--project", help="Project root for a project installation (default: current directory).")
    parser.add_argument("--destination", help="Exact installed Skill directory; overrides host/scope location.")
    parser.add_argument("--source", default=str(Path(__file__).resolve().parents[1] / "skills" / "harmony-agent"))
    parser.add_argument("--force", action="store_true", help="Overwrite locally changed package files after review.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    destination = Path(args.destination) if args.destination else destination_for(args.host, args.scope, args.project)
    try:
        result = install(args.source, destination, force=args.force, dry_run=args.dry_run)
    except (ValueError, OSError) as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps({"success": True, **result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
