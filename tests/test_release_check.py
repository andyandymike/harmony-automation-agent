"""Release checks must catch poisoned wheels and source-environment leakage."""
from __future__ import annotations

import base64
import csv
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/release-check.py"
SPEC = importlib.util.spec_from_file_location("release_check", SCRIPT)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "src/harmony_agent"
        self.source.mkdir(parents=True)
        (self.source / "__init__.py").write_text('__version__ = "0.1.0a2"\n', encoding="utf-8")
        (self.root / "LICENSE").write_text("Test license\n", encoding="utf-8")
        self.project = {"name": "harmony-automation-agent", "version": "0.1.0a2",
                        "requires-python": ">=3.10", "dependencies": [],
                        "scripts": {"harmony-agent": "harmony_agent.cli:main"}}
        self.dist = "harmony_automation_agent-0.1.0a2.dist-info"
        self.files = {
            "harmony_agent/__init__.py": (self.source / "__init__.py").read_bytes(),
            self.dist + "/METADATA": b"Metadata-Version: 2.1\nName: harmony-automation-agent\nVersion: 0.1.0a2\nRequires-Python: >=3.10\n\n",
            self.dist + "/entry_points.txt": b"[console_scripts]\nharmony-agent = harmony_agent.cli:main\n",
            self.dist + "/licenses/LICENSE": (self.root / "LICENSE").read_bytes(),
        }

    def tearDown(self):
        self.temp.cleanup()

    def wheel(self, *, duplicate=None, bad_record=False):
        record = self.dist + "/RECORD"
        rows = []
        for name, payload in self.files.items():
            digest = base64.urlsafe_b64encode(hashlib.sha256(payload).digest()).decode("ascii").rstrip("=")
            rows.append([name, "sha256=" + digest, str(len(payload))])
        if bad_record:
            rows[0][1] = "sha256=wrong"
        rows.append([record, "", ""])
        stream = io.StringIO()
        csv.writer(stream).writerows(rows)
        target = self.root / "test.whl"
        with zipfile.ZipFile(target, "w") as archive:
            for name, payload in self.files.items():
                archive.writestr(name, payload)
            archive.writestr(record, stream.getvalue())
            if duplicate:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    archive.writestr(duplicate, self.files[duplicate])
        return target

    def assert_rejected(self, code, **kwargs):
        with self.assertRaises(release.ReleaseFailure) as caught:
            release.inspect_wheel(self.wheel(**kwargs), self.project, self.source)
        self.assertEqual(caught.exception.code, code)

    def test_valid_wheel_has_matching_source_and_no_runtime_dependencies(self):
        result = release.inspect_wheel(self.wheel(), self.project, self.source)
        self.assertEqual(result["version"], "0.1.0a2")
        self.assertEqual(result["runtimeDependencies"], [])
        self.assertEqual(result["runtimeFiles"], 1)

    def test_added_runtime_dependency_is_rejected(self):
        path = self.dist + "/METADATA"
        self.files[path] = self.files[path].replace(b"\n\n", b"\nRequires-Dist: surprise-library>=1\n\n")
        self.assert_rejected("WHEEL_DEPENDENCIES")

    def test_valid_record_does_not_hide_changed_runtime_source(self):
        self.files["harmony_agent/__init__.py"] += b"injected = True\n"
        self.assert_rejected("WHEEL_SOURCE")

    def test_old_build_module_is_rejected(self):
        self.files["harmony_agent/stale.py"] = b"obsolete = True\n"
        self.assert_rejected("WHEEL_SOURCE")

    def test_extra_top_level_code_and_install_hooks_are_rejected(self):
        for name in ("sitecustomize.py", "startup.pth", "other_package/__init__.py", self.dist + "/unexpected.py"):
            with self.subTest(name=name):
                self.files[name] = b"pass\n"
                self.assert_rejected("WHEEL_CONTENT")
                del self.files[name]

    def test_record_tampering_is_rejected(self):
        self.assert_rejected("WHEEL_RECORD", bad_record=True)

    def test_duplicate_archive_member_is_rejected(self):
        self.assert_rejected("WHEEL_DUPLICATE", duplicate="harmony_agent/__init__.py")

    def test_path_traversal_and_signing_material_are_rejected(self):
        for name, code in (("../escape.txt", "WHEEL_PATH"), ("secret.p12", "WHEEL_CONTENT"),
                           (".harmony-agent/state.json", "WHEEL_CONTENT")):
            with self.subTest(name=name):
                self.files[name] = b"payload"
                self.assert_rejected(code)
                del self.files[name]

    def test_private_key_marker_is_rejected_even_in_text_extension(self):
        self.files["notes.txt"] = b"-----BEGIN PRIVATE KEY-----\nexample\n"
        self.assert_rejected("WHEEL_CONTENT")

    def test_isolated_child_environment_drops_source_and_device_configuration(self):
        with patch.dict(os.environ, {"PYTHONPATH": "src", "PYTHONHOME": "old-python", "VIRTUAL_ENV": "old-venv",
                                     "HARMONY_HDC": "real-hdc", "HDC_HOME": "real-sdk", "PIP_INDEX_URL": "https://example.invalid"}):
            env = release.clean_environment()
        for key in ("PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "HARMONY_HDC", "HDC_HOME", "PIP_INDEX_URL"):
            self.assertNotIn(key, env)
        self.assertEqual(env["PIP_NO_INDEX"], "1")
        self.assertEqual(env["PIP_CONFIG_FILE"], os.devnull)

    def test_project_parser_fails_closed_for_dynamic_or_multiline_dependencies(self):
        path = self.root / "pyproject.toml"
        prefix = '[project]\nname="example"\nversion="1"\nrequires-python=">=3.10"\nreadme="README.md"\n'
        suffix = '\n[project.scripts]\nharmony-agent="harmony_agent.cli:main"\n'
        for middle in ('dependencies = [\n "something"\n]', 'dependencies=[]\ndynamic=["version"]'):
            with self.subTest(middle=middle):
                path.write_text(prefix + middle + suffix, encoding="utf-8")
                with self.assertRaises(release.ReleaseFailure) as caught:
                    release.read_project(path)
                self.assertEqual(caught.exception.code, "PROJECT_FORMAT")


if __name__ == "__main__":
    unittest.main()
