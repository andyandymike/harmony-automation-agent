"""Report pytest's real collection, setup, call and teardown results to this workbench invocation."""
import json
import os
from pathlib import Path
import time

import pytest


_phases = []
_started = time.time()


def _save(code=None):
    if os.environ.get("PYTEST_XDIST_WORKER"):
        return
    target = Path(os.environ["HARMONY_PYTEST_RESULT"])
    temp = target.with_suffix(".tmp")
    payload = {"version": 1, "started": _started, "phases": _phases}
    if code is not None:
        payload["exitCode"] = int(code)
        payload["elapsedMs"] = round((time.time() - _started) * 1000)
    temp.write_text(json.dumps(payload, ensure_ascii=True), encoding="utf-8")
    temp.replace(target)


def pytest_sessionstart(session):
    _save()


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_load_initial_conftests():
    result = yield
    if result.excinfo:
        _record("collection", "conftest.py", "failed", result.excinfo[1])


def _record(phase, node, outcome, message="", duration=0, reason=""):
    _phases.append({"phase": phase, "node": str(node), "outcome": outcome,
                    "message": str(message)[-12000:], "reason": str(reason)[:500], "durationMs": round(duration * 1000)})
    _save()


def pytest_collectreport(report):
    if report.outcome != "passed":
        _record("collection", report.nodeid, report.outcome, report.longreprtext)


def pytest_runtest_logreport(report):
    crash = getattr(report.longrepr, "reprcrash", None)
    _record(report.when, report.nodeid, report.outcome, report.longreprtext if not report.passed else "",
            report.duration, getattr(crash, "message", ""))


def pytest_internalerror(excrepr, excinfo):
    _record("pytest", "", "failed", excrepr)


def pytest_keyboard_interrupt(excinfo):
    _record("interrupted", "", "failed", excinfo.value)


def pytest_collection_modifyitems(session, config, items):
    candidate = os.environ.get("HARMONY_PYTEST_WORKFLOW_OVERRIDE")
    if not candidate:
        return
    target = Path(os.environ["HARMONY_PYTEST_TARGET"]).resolve()
    matches = [item for item in items if Path(item.path).resolve() == target]
    valid = (len(matches) == 1 and len(items) == 1 and matches[0].name == "test_workflow"
             and isinstance(matches[0], pytest.Function) and matches[0].function.__name__ == "test_workflow")
    if valid:
        module = matches[0].module
        with target.open(encoding="utf-8-sig") as source:
            valid = source.readline().rstrip() == "# Harmony Agent Workbench pytest case v1"
        source_path = getattr(module, "WORKFLOW", None)
        valid = valid and isinstance(source_path, Path) and source_path.resolve() == target.with_name("workflow.json")
    if not valid:
        reason = "Candidate verification requires exactly one generated Harmony workflow test."
        _record("collection", target.name, "failed", reason)
        raise pytest.UsageError(reason)
    module.WORKFLOW = Path(candidate).resolve(strict=True)


def pytest_sessionfinish(session, exitstatus):
    _save(exitstatus)
