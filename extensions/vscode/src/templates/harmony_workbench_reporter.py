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
    python = os.environ.get("HARMONY_PYTEST_PROJECT_PYTHON")
    if not (candidate or python):
        return
    target = Path(os.environ["HARMONY_PYTEST_TARGET"]).resolve()
    matches = [item for item in items if isinstance(item, pytest.Function) and Path(item.path).resolve() == target
               and item.function.__name__ == "test_workflow"]
    valid = bool(matches) and (not candidate or (len(items) == 1 and matches[0].name == "test_workflow"))
    if valid:
        module = matches[0].module
        with target.open(encoding="utf-8-sig") as source:
            valid = source.readline().rstrip() == "# Harmony Agent Workbench pytest case v1"
        source_path = getattr(module, "WORKFLOW", None)
        valid = valid and isinstance(source_path, Path) and source_path.resolve() == target.with_name("workflow.json")
        if python:
            valid = valid and callable(getattr(module, "call_cli", None))
    if not valid:
        reason = ("Candidate verification requires exactly one generated Harmony workflow test." if candidate
                  else "The project runtime needs the generated Harmony workflow test's CLI function.")
        _record("collection", target.name, "failed", reason)
        raise pytest.UsageError(reason)
    if candidate:
        module.WORKFLOW = Path(candidate).resolve(strict=True)
        if os.environ.get("HARMONY_PYTEST_SKIP_RULE_GROUP") == "1":
            module.REQUIRES_RULE_GROUP = False
    if python:
        # Existing generated tests pass a single executable followed by the CLI flags.
        cli = os.environ["HARMONY_AGENT_CLI"]
        call_cli = module.call_cli

        def call_project_cli(options, command, *args):
            return call_cli([python, cli, *options[1:]], command, *args)

        module.call_cli = call_project_cli


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem):
    repair_plan = os.environ.get("HARMONY_PYTEST_REPAIR_PLAN")
    if not repair_plan:
        return
    # The generated test's fixture still prepares the same device, route and
    # artifacts. For a repair trial only, run the bounded plan in its place.
    module = pyfuncitem.module
    _, run_id, session, artifacts, options, device, input_file = pyfuncitem.funcargs["harmony_workflow_run"]
    plan = json.loads(Path(repair_plan).read_text(encoding="utf-8"))
    module.write_json(input_file, plan)
    response = module.call_cli(options, "attach", "--device", device, "--session", session)
    try:
        if response["success"]:
            response = module.call_cli(options, "run", "--session", session, "--run-id", run_id,
                                       "--plan-file", str(input_file))
        module.write_json(artifacts / "execution.json", response)
    finally:
        cleanup = module.call_cli(options, "detach", "--session", session)
        module.write_json(artifacts / "cleanup.json", cleanup)
    data = response.get("data") or {}
    if not cleanup["success"]:
        pytest.fail(f"Trial session cleanup failed: {cleanup.get('error')}", pytrace=False)
    if not response["success"] or data.get("status") != "completed":
        detail = response.get("error") or data.get("yieldReason") or ""
        pytest.fail(f"Repair trial: {data.get('status', 'unavailable')}; {detail}", pytrace=False)
    return True


def pytest_sessionfinish(session, exitstatus):
    _save(exitstatus)
