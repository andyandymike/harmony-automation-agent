"""Run a native plan with debugger pauses and case rule group steps."""
import json
import os
import queue
import re
import sys
import threading

from harmony_agent.core import Agent
from harmony_agent.errors import AgentError
from harmony_agent.observation import select_nodes
from harmony_agent.plans import validate_plan


def send(kind, **data):
    print(json.dumps({"type": kind, **data}, ensure_ascii=True), flush=True)


def serve(stream, agent_factory=Agent):
    request = json.loads(stream.readline())
    plan = validate_plan(request["plan"])
    session, run_id = request["session"], request["runId"]
    debug = request.get("debug", "breakpoints" in request)
    breakpoints = set(request.get("breakpoints", []))
    step_next = debug and not breakpoints
    rule_steps = request.get("ruleSteps", {})
    controls = queue.Queue()
    first = None

    def receive():
        try:
            for line in stream:
                msg = json.loads(line)
                if msg.get("action") == "stop":
                    break
                controls.put(msg)
        finally:
            agent.request_cancel()
            controls.put({"action": "stop"})

    def matching_controls(token):
        while True:
            control = controls.get()
            if control["action"] == "stop":
                raise KeyboardInterrupt
            if control.get("token") == token:
                yield control

    def pause(event, operation):
        nonlocal step_next
        token = event["stepId"]
        frame_id = event.get("basisFrameId")
        send("paused", path=event["path"], operation=operation, token=token, frameId=frame_id)
        for control in matching_controls(token):
            action = control["action"]
            if action == "probe":
                selector = control["selector"]
                try:
                    if frame_id == first.get("frameId"):
                        frame = first
                    elif frame_id:
                        from harmony_agent.execution import RunStore
                        frame = RunStore(request["stateDir"], run_id).frame(frame_id)
                    else:
                        send("probe", token=token, matches=[], count=None)
                        continue
                    matches = select_nodes(frame, selector)
                    send("probe", token=token, count=len(matches),
                         complete=frame.get("quality", {}).get("complete", False),
                         matches=[{k: n[k] for k in ("id", "type", "text", "description", "bounds") if k in n}
                                  for n in matches[:10]])
                except (AgentError, ValueError, TypeError) as exc:
                    send("probe", token=token, error=str(exc))
            elif action in ("continue", "step"):
                step_next = action == "step"
                return

    def checkpoint(event):
        if event["event"] == "step_finished":
            if debug:
                send("step", path=event["path"], status=event["status"], stepId=event["stepId"])
            return
        if agent.cancel_event.is_set():
            raise KeyboardInterrupt
        where = event["path"]
        canonical = re.sub(r"\.repeat\.iteration\[\d+\]", ".repeat.steps", where)
        rule_operation = rule_steps.get(canonical)
        top = re.fullmatch(r"steps\[(\d+)\](?:\.repeat\.check\[0\])?", where)
        paused = debug and (step_next or (top and int(top.group(1)) in breakpoints))
        if paused:
            pause(event, rule_operation or event.get("command", event["kind"]))
        if rule_operation:
            token = event["stepId"]
            send("ruleGroup", path=where, token=token)
            for control in matching_controls(token):
                if control["action"] == "ruleGroupResult":
                    if control.get("error"):
                        raise AgentError("RULE_GROUP_SWITCH_FAILED", control["error"])
                    break
        return paused

    try:
        agent = agent_factory(request["stateDir"], request.get("hdcPath"), on_plan_step=checkpoint)
    except TypeError as exc:
        if debug:
            raise AgentError("DEBUG_CORE_REQUIRED", "Interactive debugging requires harmony-automation-agent 0.1.0a10 or later.") from exc
        raise AgentError("RULE_STEP_CORE_REQUIRED", "Rule group steps require harmony-automation-agent 0.1.0a10 or later.") from exc
    threading.Thread(target=receive, daemon=True).start()
    if not debug:
        result = agent.execute(request["method"], {**request.get("options", {}),
                               "session": session, "run_id": run_id, "plan": plan})
        send("complete", status=result.get("status"), result=result)
        return
    attached = False
    try:
        result = agent.execute("start", {"session": session, "device": request["device"], "max_nodes": 5000})
        attached = True
        # Use the complete saved frame to verify a locator while paused at the first input.
        first = agent.store.load(session).get("frame") or result["observation"]
        result = agent.execute("run", {"session": session, "run_id": run_id, "plan": plan,
                                       "output": "full", "compact": True, "max_nodes": 240})
    finally:
        if attached:
            agent.clear_cancel()
            agent.execute("detach", {"session": session})
    send("complete", status=result.get("status"))


if __name__ == "__main__":
    try:
        # Closing a pipe while another thread is reading blocks on Windows.
        # The parent closes stdin after receiving the terminal event.
        incoming = os.fdopen(os.dup(sys.stdin.fileno()), "rb", buffering=0)
        serve(incoming)
    except Exception as error:
        send("error", code=getattr(error, "code", None), message=str(error))
