import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("install_skill", Path(__file__).resolve().parents[1] / "scripts" / "install-skill.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallSkillTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.source, self.destination = self.root / "source", self.root / "project" / "installed"
        self.source.mkdir()
        (self.source / "SKILL.md").write_text("---\nname: demo\ndescription: Example\n---\n", encoding="utf-8")
        (self.source / "references").mkdir()
        (self.source / "references" / "requests.md").write_text("example", encoding="utf-8")

    def test_host_paths_are_native(self):
        self.assertEqual(installer.destination_for("copilot", "project", self.root),
                         self.root / ".github" / "skills" / "harmony-agent")
        self.assertEqual(installer.destination_for("codex", "user", home=self.root),
                         self.root / ".agents" / "skills" / "harmony-agent")

    def test_complete_install_and_idempotent_reinstall(self):
        result = installer.install(self.source, self.destination)
        self.assertEqual(result["files"], 2)
        self.assertEqual((self.destination / "references" / "requests.md").read_text(), "example")
        self.assertEqual(installer.install(self.source, self.destination)["updated"], [])

    def test_unchanged_local_files_can_be_upgraded(self):
        installer.install(self.source, self.destination)
        (self.source / "references" / "requests.md").write_text("new version")
        result = installer.install(self.source, self.destination)
        self.assertEqual(result["updated"], ["references/requests.md"])
        self.assertEqual((self.destination / "references" / "requests.md").read_text(), "new version")

    def test_local_change_requires_explicit_force(self):
        installer.install(self.source, self.destination)
        (self.destination / "SKILL.md").write_text("personal change")
        with self.assertRaisesRegex(ValueError, "Local changes"):
            installer.install(self.source, self.destination)
        self.assertEqual((self.destination / "SKILL.md").read_text(), "personal change")
        result = installer.install(self.source, self.destination, force=True)
        self.assertEqual(result["overwrittenLocalChanges"], ["SKILL.md"])

    def test_untracked_files_are_preserved_and_removed_package_files_are_removed(self):
        installer.install(self.source, self.destination)
        (self.destination / "notes.txt").write_text("personal")
        (self.source / "references" / "requests.md").unlink()
        result = installer.install(self.source, self.destination)
        self.assertEqual(result["removed"], ["references/requests.md"])
        self.assertFalse((self.destination / "references" / "requests.md").exists())
        self.assertEqual((self.destination / "notes.txt").read_text(), "personal")

    def test_dry_run_does_not_write(self):
        result = installer.install(self.source, self.destination, dry_run=True)
        self.assertTrue(result["dryRun"])
        self.assertFalse(self.destination.exists())

    def test_rejects_overlapping_paths(self):
        for path in (self.source, self.source / "nested", self.root):
            with self.assertRaisesRegex(ValueError, "separate"):
                installer.install(self.source, path)

    def test_manifest_cannot_escape_install_root(self):
        self.destination.mkdir(parents=True)
        (self.destination / installer.MANIFEST).write_text(json.dumps({"files": {"../victim": "hash"}}))
        with self.assertRaisesRegex(ValueError, "escapes"):
            installer.install(self.source, self.destination, force=True)

    def test_existing_unmanaged_file_is_not_overwritten(self):
        self.destination.mkdir(parents=True)
        (self.destination / "SKILL.md").write_text("user content")
        with self.assertRaisesRegex(ValueError, "Local changes"):
            installer.install(self.source, self.destination)
        self.assertFalse((self.destination / "references").exists())

    def test_parent_file_conflict_is_rejected_before_any_update(self):
        installer.install(self.source, self.destination)
        (self.source / "SKILL.md").write_text("updated package")
        (self.source / "additional").mkdir()
        (self.source / "additional" / "detail.md").write_text("new reference")
        (self.destination / "additional").write_text("personal content")
        before_skill = (self.destination / "SKILL.md").read_bytes()
        before_manifest = (self.destination / installer.MANIFEST).read_bytes()
        for dry_run in (True, False):
            with self.assertRaisesRegex(ValueError, "file conflicts"):
                installer.install(self.source, self.destination, dry_run=dry_run, force=True)
        self.assertEqual((self.destination / "SKILL.md").read_bytes(), before_skill)
        self.assertEqual((self.destination / installer.MANIFEST).read_bytes(), before_manifest)
        self.assertEqual((self.destination / "additional").read_text(), "personal content")


if __name__ == "__main__":
    unittest.main()
