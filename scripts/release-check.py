#!/usr/bin/env python3
"""Build and check a wheel offline in a fresh, isolated install environment.

The host needs pip (with --python support) and setuptools >=68 already installed.
This script never installs build dependencies, downloads packages, or uses HDC.
Detailed process logs stay in the chosen output directory; report.json contains
relative artifact names and check results, not machine-specific absolute paths.
"""
from __future__ import annotations

import argparse
import ast
import base64
import configparser
import csv
from datetime import datetime, timezone
from email.parser import BytesParser
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import time
import uuid
import zipfile


class ReleaseFailure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise ReleaseFailure(code, message)


def read_project(path):
    """Read the supported project subset without requiring tomllib on 3.10.

    Fail closed for multiline/dynamic dependency values or unsupported syntax.
    Values needed for this project's release are strings and a string list.
    """
    fields = {}
    section = None
    scripts = {}
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("["):
            section = line
            continue
        if section not in {"[project]", "[project.scripts]"}:
            continue
        key, separator, value = line.partition("=")
        key = key.strip()
        if section == "[project]" and key not in {"name", "version", "requires-python", "dependencies", "readme", "dynamic"}:
            continue
        require(bool(separator), "PROJECT_FORMAT", "Unsupported project metadata syntax.")
        target = fields if section == "[project]" else scripts
        require(key not in target, "PROJECT_FORMAT", "Duplicate project metadata field.")
        try:
            target[key] = ast.literal_eval(value.strip())
        except (ValueError, SyntaxError) as exc:
            raise ReleaseFailure("PROJECT_FORMAT", "Release metadata must use simple string or string-list literals.") from exc
    for key in ("name", "version", "requires-python", "readme"):
        require(isinstance(fields.get(key), str) and bool(fields[key]), "PROJECT_FORMAT", "Required static project metadata is missing.")
    require(not fields.get("dynamic"), "PROJECT_FORMAT", "Dynamic project metadata is not supported by this release check.")
    deps = fields.get("dependencies")
    require(isinstance(deps, list) and all(isinstance(item, str) for item in deps), "PROJECT_FORMAT", "Explicit static dependencies are required.")
    require(bool(scripts) and all(isinstance(value, str) for value in scripts.values()), "PROJECT_FORMAT", "Static console scripts are required.")
    fields["scripts"] = scripts
    return fields


def source_version(source):
    tree = ast.parse(Path(source).read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "__version__" for target in node.targets):
            value = ast.literal_eval(node.value)
            require(isinstance(value, str), "SOURCE_VERSION", "The source version must be a string.")
            return value
    raise ReleaseFailure("SOURCE_VERSION", "No static source version was found.")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def normalized_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def clean_environment():
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(("HARMONY_", "PIP_")) or key in {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "HDC_HOME"}:
            env.pop(key, None)
    env.update(PYTHONUTF8="1", PYTHONNOUSERSITE="1", PIP_NO_INDEX="1",
               PIP_DISABLE_PIP_VERSION_CHECK="1", PIP_CONFIG_FILE=os.devnull)
    return env


def inspect_wheel(wheel, project, source):
    """Check metadata, known unwanted files, source parity, and every RECORD row."""
    forbidden_parts = {".git", ".venv", "venv", "__pycache__", ".harmony-agent", "node_modules", ".hvigor", ".ohpm", "tests", "fixture-app"}
    forbidden_suffixes = {".p12", ".p7b", ".pem", ".key", ".hap", ".pyc", ".pyo", ".log"}
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "WHEEL_DUPLICATE", "Wheel contains duplicate archive members.")
        require(archive.testzip() is None, "WHEEL_CORRUPT", "Wheel archive checksum failed.")
        for name in names:
            path = PurePosixPath(name)
            require(not path.is_absolute() and ".." not in path.parts and "\\" not in name and ":" not in name,
                    "WHEEL_PATH", "Wheel contains an unsafe archive path.")
            require(not any(part.lower() in forbidden_parts for part in path.parts)
                    and path.suffix.lower() not in forbidden_suffixes,
                    "WHEEL_CONTENT", "Wheel contains a known private, signing, fixture, or cache file type.")
            payload = archive.read(name)
            require(b"-----BEGIN PRIVATE KEY-----" not in payload and b"-----BEGIN RSA PRIVATE KEY-----" not in payload
                    and b"-----BEGIN EC PRIVATE KEY-----" not in payload,
                    "WHEEL_CONTENT", "Wheel contains a private key marker.")
            require(not re.search(rb"(?i)(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|/Users/|/home/)[^\s\"<>]+", payload),
                    "WHEEL_CONTENT", "Wheel contains a known personal home-directory path pattern.")
        metadata_paths = [name for name in names if name.endswith(".dist-info/METADATA")]
        require(len(metadata_paths) == 1, "WHEEL_METADATA", "Wheel must have exactly one metadata directory.")
        metadata_path = metadata_paths[0]
        metadata_dir = metadata_path.rsplit("/", 1)[0]
        metadata = BytesParser().parsebytes(archive.read(metadata_path))
        require(normalized_name(metadata.get("Name", "")) == normalized_name(project["name"])
                and metadata.get("Version") == project["version"]
                and metadata.get("Requires-Python") == project["requires-python"],
                "WHEEL_METADATA", "Wheel name, version, or Python requirement differs from the source project.")
        dependencies = metadata.get_all("Requires-Dist", [])
        normalize_dep = lambda value: re.sub(r"\s+", "", value).lower()
        require(sorted(map(normalize_dep, dependencies)) == sorted(map(normalize_dep, project["dependencies"])),
                "WHEEL_DEPENDENCIES", "Wheel runtime dependencies differ from the source project.")
        entries = configparser.ConfigParser(interpolation=None)
        entries.optionxform = str
        entries.read_string(archive.read(metadata_dir + "/entry_points.txt").decode("utf-8"))
        require(dict(entries["console_scripts"]) == project["scripts"], "WHEEL_ENTRYPOINT", "Wheel console scripts differ from the source project.")
        expected = {"harmony_agent/" + path.relative_to(source).as_posix(): path.read_bytes()
                    for path in Path(source).rglob("*.py") if "__pycache__" not in path.parts}
        actual_names = {name for name in names if name.startswith("harmony_agent/")}
        require(actual_names == set(expected), "WHEEL_SOURCE", "Wheel runtime file set differs from the source package.")
        require(all(archive.read(name) == data for name, data in expected.items()), "WHEEL_SOURCE", "Wheel runtime bytes differ from source.")
        allowed_metadata = {metadata_dir + "/" + name for name in
                            ("METADATA", "WHEEL", "entry_points.txt", "top_level.txt", "RECORD", "LICENSE", "licenses/LICENSE")}
        require(set(names) <= set(expected) | allowed_metadata, "WHEEL_CONTENT",
                "Wheel contains an unexpected top-level module, install hook, or metadata member.")
        license_paths = [name for name in names if name.startswith(metadata_dir + "/") and PurePosixPath(name).name == "LICENSE"]
        require(len(license_paths) == 1 and archive.read(license_paths[0]) == (Path(source).parents[1] / "LICENSE").read_bytes(),
                "WHEEL_LICENSE", "Wheel license is missing or differs from the source license.")
        record_path = metadata_dir + "/RECORD"
        rows = list(csv.reader(io.StringIO(archive.read(record_path).decode("utf-8"))))
        require(all(len(row) == 3 for row in rows) and len(rows) == len(names)
                and len({row[0] for row in rows}) == len(rows) and {row[0] for row in rows} == set(names),
                "WHEEL_RECORD", "Wheel RECORD file list is inconsistent.")
        for name, digest, size in rows:
            if name == record_path:
                require(digest == size == "", "WHEEL_RECORD", "RECORD's own row must omit checksum and size.")
                continue
            data = archive.read(name)
            expected_digest = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode("ascii").rstrip("=")
            require(digest == expected_digest and size == str(len(data)), "WHEEL_RECORD", "Wheel member checksum or size is invalid.")
        return {"name": project["name"], "version": project["version"], "runtimeDependencies": dependencies,
                "runtimeFiles": len(expected), "archiveFiles": len(names), "bytes": Path(wheel).stat().st_size,
                "sha256": sha256(Path(wheel).read_bytes()), "contentScan": "known_patterns_only"}


class ReleaseCheck:
    def __init__(self, project_dir, output_dir, timeout=180):
        self.project_dir = Path(project_dir).resolve()
        self.output_dir = Path(output_dir).resolve()
        self.run_dir = self.output_dir / ("run-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
        self.run_dir.mkdir(parents=True)
        self.timeout = timeout
        self.env = clean_environment()
        self.steps = []
        self.report = {"schemaVersion": 1, "at": datetime.now(timezone.utc).isoformat(),
                       "host": {"os": platform.system(), "python": platform.python_version()},
                       "networkMode": "pip_no_index_no_build_isolation", "steps": self.steps}

    def process(self, name, args, *, cwd=None, expected=0):
        started = time.monotonic()
        row = {"name": name, "status": "fail"}
        self.steps.append(row)
        try:
            completed = subprocess.run([str(arg) for arg in args], cwd=cwd or self.run_dir, env=self.env,
                                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=self.timeout)
            (self.run_dir / (name + ".stdout.txt")).write_text(completed.stdout, encoding="utf-8")
            (self.run_dir / (name + ".stderr.txt")).write_text(completed.stderr, encoding="utf-8")
            row["exitCode"] = completed.returncode
            require(completed.returncode == expected, "COMMAND_FAILED", "A release check command returned an unexpected exit code; inspect local process logs.")
            row["status"] = "pass"
            return completed
        except subprocess.TimeoutExpired as exc:
            raise ReleaseFailure("COMMAND_TIMEOUT", "A release check command exceeded its time budget.") from exc
        finally:
            row["elapsedMs"] = round((time.monotonic() - started) * 1000, 2)

    def cli(self, name, executable, args, *, expected=0, success=True):
        result = self.process(name, [executable, *args, "--json"], expected=expected)
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            self.steps[-1]["status"] = "fail"
            raise ReleaseFailure("CLI_JSON", "Installed CLI did not emit exactly one JSON object.") from exc
        valid = isinstance(data, dict) and data.get("success") is success and data.get("version") == self.report["version"] and not result.stderr.strip()
        if not valid:
            self.steps[-1]["status"] = "fail"
        require(valid, "CLI_CONTRACT", "Installed CLI output envelope or stderr differs from its contract.")
        return data

    def run(self):
        started = time.monotonic()
        try:
            project = read_project(self.project_dir / "pyproject.toml")
            self.report.update(project=project["name"], version=project["version"])
            require(source_version(self.project_dir / "src/harmony_agent/__init__.py") == project["version"],
                    "SOURCE_VERSION", "Package source and project versions differ.")
            snapshot = self.run_dir / "source"
            snapshot.mkdir()
            readme = PurePosixPath(project["readme"])
            require(not readme.is_absolute() and ".." not in readme.parts and "\\" not in project["readme"]
                    and ":" not in project["readme"], "PROJECT_FORMAT", "Readme must be a relative POSIX path within the source project.")
            for relative in ("pyproject.toml", "LICENSE", project["readme"]):
                destination = snapshot / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(self.project_dir / relative, destination)
            shutil.copytree(self.project_dir / "src/harmony_agent", snapshot / "src/harmony_agent",
                            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"))
            self.steps.append({"name": "source_identity", "status": "pass"})
            wheel_dir = self.run_dir / "wheel"
            wheel_dir.mkdir()
            self.process("build", [sys.executable, "-m", "pip", "wheel", "--no-index", "--no-cache-dir", "--no-deps",
                                   "--no-build-isolation", "--wheel-dir", wheel_dir, snapshot])
            wheels = list(wheel_dir.glob("*.whl"))
            require(len(wheels) == 1, "WHEEL_COUNT", "Build must produce exactly one wheel in its fresh output directory.")
            self.report["wheel"] = {"file": "wheel/" + wheels[0].name, **inspect_wheel(wheels[0], project, snapshot / "src/harmony_agent")}
            self.steps.append({"name": "wheel_integrity_metadata_content", "status": "pass"})
            env_dir = self.run_dir / "venv"
            self.process("create_fresh_venv", [sys.executable, "-m", "venv", "--without-pip", env_dir])
            bin_dir = env_dir / ("Scripts" if os.name == "nt" else "bin")
            python = bin_dir / ("python.exe" if os.name == "nt" else "python")
            executable = bin_dir / ("harmony-agent.exe" if os.name == "nt" else "harmony-agent")
            self.process("install", [sys.executable, "-m", "pip", "--python", python, "install", "--no-index", "--no-deps",
                                     "--no-cache-dir", wheels[0]])
            probe = ("import json,sys; from pathlib import Path; import harmony_agent; "
                     "p=Path(harmony_agent.__file__).resolve(); prefix=Path(sys.prefix).resolve(); "
                     "print(json.dumps({'insideVenv':prefix in p.parents,'isolated':sys.flags.isolated,"
                     "'baseDiffers':sys.base_prefix!=sys.prefix,'version':harmony_agent.__version__}))")
            installed = json.loads(self.process("import_isolation", [python, "-I", "-c", probe]).stdout)
            require(installed == {"insideVenv": True, "isolated": 1, "baseDiffers": True, "version": project["version"]},
                    "INSTALL_ISOLATION", "Imported package did not come from the fresh isolated venv.")
            help_data = self.cli("cli_help", executable, ["help"])
            require("observe" in help_data.get("data", {}).get("help", ""), "CLI_HELP", "Installed help lacks its commands.")
            version = self.cli("cli_version", executable, ["--version"])
            require(version.get("data", {}).get("version") == project["version"], "CLI_VERSION", "Installed CLI version differs.")
            schema = self.cli("cli_schema", executable, ["schema"])
            require(isinstance(schema.get("data"), dict) and bool(schema["data"]), "CLI_SCHEMA", "Installed schema is empty.")
            missing_hdc = self.run_dir / "intentionally-missing-hdc"
            require(not missing_hdc.exists(), "ISOLATION", "The explicit unavailable HDC path unexpectedly exists.")
            missing = self.cli("cli_no_hdc", executable, ["devices", "--hdc", missing_hdc], expected=1, success=False)
            require(missing.get("error", {}).get("code") == "HDC_NOT_FOUND" and missing["error"].get("details", {}).get("dispatched") == "no",
                    "CLI_NO_HDC", "Missing HDC was not classified as an undispatched environment failure.")
            doctor = self.cli("cli_doctor_no_hdc", executable, ["doctor", "--hdc", missing_hdc])
            require(doctor.get("data", {}).get("ready") is False, "CLI_DOCTOR", "Doctor reported ready with an explicitly missing HDC.")
            for name, args in (("cli_invalid_attach", ["attach"]),
                               ("cli_invalid_timeout", ["fill", "id=example", "hello", "--timeout-ms", "0"]),
                               ("cli_invalid_boolean", ["wait", "id=example", "--property", "visible", "--equals", "maybe"])):
                error = self.cli(name, executable, [*args, "--hdc", missing_hdc], expected=2, success=False)
                require(error.get("error", {}).get("code") == "INVALID_ARGUMENT", "CLI_VALIDATION", "Parameter validation did not happen before HDC access.")
            self.report["status"] = "pass"
        except (ReleaseFailure, OSError, zipfile.BadZipFile, ValueError, KeyError, configparser.Error) as exc:
            self.report["status"] = "fail"
            self.report["error"] = {"code": exc.code if isinstance(exc, ReleaseFailure) else "CHECK_ERROR",
                                    "message": str(exc) if isinstance(exc, ReleaseFailure) else "Release check could not complete; inspect local logs and prerequisites."}
        finally:
            self.report["elapsedMs"] = round((time.monotonic() - started) * 1000, 2)
            self.report["runDirectory"] = self.run_dir.name
            (self.run_dir / "report.json").write_text(json.dumps(self.report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return self.report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-dir", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--output-dir", default=".harmony-agent/release-check")
    parser.add_argument("--timeout", type=int, default=180, help="Seconds allowed for each child process (1..900)")
    args = parser.parse_args(argv)
    if not 1 <= args.timeout <= 900:
        parser.error("--timeout must be between 1 and 900 seconds")
    try:
        report = ReleaseCheck(args.project_dir, args.output_dir, args.timeout).run()
    except OSError:
        report = {"schemaVersion": 1, "status": "fail", "error": {"code": "OUTPUT_UNAVAILABLE", "message": "Cannot create release-check output files."}}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
