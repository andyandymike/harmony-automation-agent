"""Published command examples must match the installed, no-device contract."""
from pathlib import Path
import json
import re
import shlex
import unittest

from harmony_agent.cli import build_parser
from harmony_agent.plans import validate_plan
from harmony_agent.schema import validate_request


ROOT = Path(__file__).resolve().parents[1]
GUIDES = [ROOT / name for name in (
    "README.md", "README.zh-CN.md", "docs/agent-usage.md", "docs/agent-requests.md",
    "docs/execution.md", "docs/installation.md", "skills/harmony-agent/SKILL.md",
)] + sorted((ROOT / "skills/harmony-agent/references").glob("*.md"))


class DocumentedExampleTests(unittest.TestCase):
    def test_published_cli_options_parse_without_contacting_a_device(self):
        parser, _ = build_parser()
        checked = 0
        for path in GUIDES:
            body = path.read_text(encoding="utf-8")
            # Complete command lines and inline CLI fragments both matter: a
            # misspelled option in recovery prose can waste a real model turn.
            snippets = re.findall(r"(?<!`)`([^`\n]+)`(?!`)", body)
            for language, block in re.findall(r"```([^\n]*)\n(.*?)```", body, re.S):
                if language in {"sh", "bash", "powershell", "shell"}:
                    snippets.extend(block.splitlines())
            for snippet in snippets:
                text = snippet.strip()
                if text.startswith("harmony-agent "):
                    text = text[len("harmony-agent "):]
                elif not re.match(r"(?:report|inspect)\s+", text):
                    continue
                # Alternatives are explanatory fragments, not executable lines.
                if " / " in text or " | " in text:
                    continue
                with self.subTest(file=str(path.relative_to(ROOT)), example=snippet):
                    parser.parse_args(shlex.split(text))
                checked += 1
        self.assertGreater(checked, 10)

    def test_json_requests_and_plan_steps_validate_without_a_device(self):
        requests = 0
        for path in GUIDES:
            for block in re.findall(r"```json\s*\n(.*?)```", path.read_text(encoding="utf-8"), re.S):
                with self.subTest(file=str(path.relative_to(ROOT)), example=block):
                    value = json.loads(block)
                    if isinstance(value, dict) and "version" in value and "steps" in value:
                        validate_plan(value)
                    if isinstance(value, dict) and "command" in value:
                        if "refresh" in value or "before" in value:
                            validate_plan({"version": "1", "steps": [value]})
                        else:
                            validate_request(value)
                        requests += 1
        self.assertGreater(requests, 3)


if __name__ == "__main__":
    unittest.main()
