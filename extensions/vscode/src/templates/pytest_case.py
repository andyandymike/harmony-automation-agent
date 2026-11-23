# Harmony Agent Workbench pytest case v1
"""Run with python -m pytest after setting HARMONY_DEVICE to the exact device ID.

The adjacent workflow.json is the editable source for this test. Set
HARMONY_AGENT_CLI to an executable if harmony-agent is not on PATH.
Set HARMONY_ARTIFACT_DIR to retain execution and failure reports in CI.

If the workflow requires a rule group, set HARMONY_RULE_GROUP_FIXTURE to your
registered pytest fixture's name. That fixture must return a callable with
keyword arguments rule_group, device, state_dir. Its context manager prepares
the gateway and device route on entry and cleans up on exit.
"""

from contextlib import nullcontext
import json
import os
from pathlib import Path
import subprocess
import uuid

import pytest


WORKFLOW = Path(__file__).with_name("workflow.json")
REQUIRES_RULE_GROUP = __REQUIRES_RULE_GROUP__


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def call_cli(options, command, *args):
    try:
        result = subprocess.run(
            [*options, command, *args, "--json"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=720, check=False,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"success": False, "error": {"message": str(error)}}
    try:
        envelope = json.loads(result.stdout)
        if not isinstance(envelope, dict) or type(envelope.get("success")) is not bool:
            raise ValueError("missing Harmony Agent JSON envelope")
    except (ValueError, TypeError) as error:
        return {"success": False, "error": {"message": f"{command} exited {result.returncode}: {error}"}}
    if result.returncode and envelope["success"]:
        return {"success": False, "error": {"message": f"{command} exited {result.returncode}"}}
    return envelope


@pytest.fixture
def harmony_workflow_run(request, tmp_path):
    source = json.loads(WORKFLOW.read_text(encoding="utf-8-sig"))
    if not isinstance(source, dict):
        pytest.fail("workflow.json must contain a Harmony Agent plan")
    group = None
    plan = source
    if source.get("format") == "harmony-agent.workflow-scenario":
        group = source.get("scenario")
        plan = source.get("workflow")
        if not isinstance(group, dict) or group.get("version") != 1 or not isinstance(group.get("rules"), list):
            pytest.fail("workflow.json is missing its rule group snapshot")
    elif REQUIRES_RULE_GROUP:
        pytest.fail("Restore the required rule group snapshot in workflow.json")
    if not isinstance(plan, dict) or plan.get("version") not in ("1", "2") or plan.get("format"):
        pytest.fail("A control-based workflow is required; coordinate gestures use the workbench")
    if not all(isinstance(plan.get(key), list) and plan[key] for key in ("steps", "preconditions", "goals")):
        pytest.fail("Set steps, a starting precondition, and a final goal in workflow.json before running")
    device = os.environ.get("HARMONY_DEVICE")
    if not device:
        pytest.fail("Set HARMONY_DEVICE to the exact device ID before running")

    run_id = str(uuid.uuid4())
    session = "pytest-" + run_id
    artifacts = Path(os.environ.get("HARMONY_ARTIFACT_DIR") or tmp_path) / run_id
    artifacts.mkdir(parents=True)
    state_dir = Path(os.environ.get("HARMONY_STATE_DIR") or (artifacts / "state")).resolve()
    options = [os.environ.get("HARMONY_AGENT_CLI") or "harmony-agent", "--state-dir", str(state_dir)]
    if os.environ.get("HARMONY_HDC"):
        options += ["--hdc", os.environ["HARMONY_HDC"]]
    preparation = nullcontext()
    if group is not None:
        name = os.environ.get("HARMONY_RULE_GROUP_FIXTURE")
        if not name:
            pytest.fail("Set HARMONY_RULE_GROUP_FIXTURE to a fixture that prepares the gateway and device route")
        factory = request.getfixturevalue(name)
        if not callable(factory):
            pytest.fail(f"Fixture {name!r} must return a rule group context manager factory")
        preparation = factory(rule_group=group, device=device, state_dir=state_dir)

    input_file = artifacts / "plan.json"
    write_json(input_file, plan)
    write_json(artifacts / "workflow-source.json", source)
    print(f"Harmony run {run_id} | evidence: {artifacts}")
    with preparation:
        yield plan, run_id, session, artifacts, options, device, input_file


def test_workflow(harmony_workflow_run):
    plan, run_id, session, artifacts, options, device, input_file = harmony_workflow_run
    response = call_cli(options, "execute", "--device", device, "--session", session,
                        "--run-id", run_id, "--plan-file", str(input_file))
    write_json(artifacts / "execution.json", response)
    data = response.get("data") or {}
    status = data.get("status", "unavailable")
    goal = data.get("goalVerification") or {}
    assertions = goal.get("assertions") or []
    verified = (goal.get("status") == "passed" and len(assertions) == len(plan["goals"])
                and all(isinstance(a, dict) and a.get("status") == "passed" for a in assertions))
    if response["success"] and status == "completed" and verified:
        if data.get("sessionCleanup", {}).get("status") != "failed":
            return

    report = call_cli(options, "report", run_id, "--full")
    write_json(artifacts / "report.json", report)
    # The CLI retains an unverified session. Release only this test's own session.
    cleanup = call_cli(options, "detach", "--session", session)
    write_json(artifacts / "cleanup.json", cleanup)
    detail = response.get("error") or data.get("sessionCleanup", {}).get("error") or data.get("yieldReason") or ""
    failed = next((a for a in assertions if isinstance(a, dict) and a.get("status") != "passed"), {})
    if not verified and not failed:
        failed = f"{len(assertions)} recorded assertion(s) for {len(plan['goals'])} declared goal(s)"
    pytest.fail(f"Execution: {status}; final check: {goal.get('status', 'unavailable')}; {detail}\n"
                f"Assertion: {failed}\nRun ID: {run_id}\nEvidence: {artifacts}")
