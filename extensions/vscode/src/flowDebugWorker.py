"""Interactive gates for the native plan runner. One process owns one run."""
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
    breakpoints = set(request.get("breakpoints", []))
    step_next = not breakpoints
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

    def checkpoint(event):
        nonlocal step_next
        if event["event"] == "step_finished":
            send("step", path=event["path"], status=event["status"], stepId=event["stepId"])
            return
        if agent.cancel_event.is_set():
            raise KeyboardInterrupt
        where = event["path"]
        top = re.fullmatch(r"steps\[(\d+)\](?:\.repeat\.check\[0\])?", where)
        if not step_next and (not top or int(top.group(1)) not in breakpoints):
            return
        token = event["stepId"]
        frame_id = event.get("basisFrameId")
        send("paused", path=where, operation=event.get("command", event["kind"]), token=token,
             frameId=frame_id)
        while True:
            control = controls.get()
            action = control["action"]
            if action == "stop":
                raise KeyboardInterrupt
            if control.get("token") != token:
                continue
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
                return True

    try:
        agent = agent_factory(request["stateDir"], request.get("hdcPath"), on_plan_step=checkpoint)
    except TypeError as exc:
        raise AgentError("DEBUG_CORE_REQUIRED", "Interactive debugging requires harmony-automation-agent 0.1.0a10 or later.") from exc
    threading.Thread(target=receive, daemon=True).start()
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
