"""Bounded native HDC transport. No host shell and no mutation retries."""

from __future__ import annotations

import json
import math
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from .errors import AgentError


_FAILURE = re.compile(r"(?im)^\s*(?:\[fail\]|\[error\]|error:|hdc:\s*error)")
_DEVICE_FAILURE = re.compile(r"(?im)^\s*(?:missing parameter\.|invalid (?:parameter|argument)|"
                             r"failed to\b|start ability failed\b|error code\s*[:=]|"
                             r"set pasteboard data failed\.|"
                             r"capability not support, clipboard service is not supported)")
_PNG = b"\x89PNG\r\n\x1a\n"
_JPEG = b"\xff\xd8\xff"


def _find_hdc(explicit=None):
    """Explicit choices fail clearly instead of silently choosing another SDK."""
    selected = explicit or os.environ.get("HARMONY_HDC")
    if selected:
        candidate = Path(selected).expanduser()
        if candidate.is_file():
            return str(candidate.resolve())
        # A bare executable name is also a valid explicit choice.
        found = shutil.which(str(selected))
        if found:
            return found
        raise AgentError("HDC_NOT_FOUND", "The selected HDC executable was not found.",
                         details={"hint": "Set --hdc to an existing HDC executable."})
    hdc_home = os.environ.get("HDC_HOME")
    if hdc_home:
        base = Path(hdc_home).expanduser()
        choices = [base] if base.is_file() else [base / "hdc.exe", base / "hdc"]
        for candidate in choices:
            if candidate.is_file():
                return str(candidate.resolve())
        raise AgentError("HDC_NOT_FOUND", "HDC_HOME does not contain HDC.",
                         details={"hint": "Set HDC_HOME to the toolchains directory."})
    found = shutil.which("hdc") or shutil.which("hdc.exe")
    if found:
        return found
    root = os.environ.get("HARMONY_COMMAND_LINE_TOOLS")
    if root:
        base = Path(root).expanduser() / "sdk" / "default" / "openharmony" / "toolchains"
        for name in ("hdc.exe", "hdc"):
            candidate = base / name
            if candidate.is_file():
                return str(candidate.resolve())
    raise AgentError("HDC_NOT_FOUND", "HDC was not found.", details={
        "hint": "Install HarmonyOS Command Line Tools; use --hdc, HARMONY_HDC, HDC_HOME or PATH."})


def _timeout(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise AgentError("INVALID_ARGUMENT", "timeout_ms must be a positive finite number.", exit_code=2)
    return float(value) / 1000


def _argument(value):
    if not isinstance(value, str):
        value = str(value)
    if "\x00" in value:
        raise AgentError("INVALID_ARGUMENT", "Command arguments cannot contain NUL.", exit_code=2)
    return value


def _device(value):
    if not isinstance(value, str) or not value.strip() or value.startswith("-") or "\x00" in value:
        raise AgentError("INVALID_ARGUMENT", "An explicit valid device ID is required.", exit_code=2)
    return value


def _coordinate(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise AgentError("INVALID_ARGUMENT", "Coordinates must be finite nonnegative numbers.", exit_code=2)
    return str(round(value))


class HdcTransport:
    def __init__(self, hdc_path=None, timeout_ms=10000):
        _timeout(timeout_ms)
        self.path = _find_hdc(hdc_path)
        self.hdc_path = self.path
        self.timeout_ms = timeout_ms
        self.calls = 0
        self.elapsed_ms = 0.0

    def _run(self, args, *, timeout_ms=None, mutating=False, operation="HDC command"):
        timeout_seconds = _timeout(self.timeout_ms if timeout_ms is None else timeout_ms)
        argv = [self.path, *[_argument(arg) for arg in args]]
        started = time.monotonic()
        dispatched = "unknown" if mutating else "no"
        try:
            self.calls += 1
            completed = subprocess.run(argv, capture_output=True, timeout=timeout_seconds,
                                       shell=False, check=False)
        except FileNotFoundError as exc:
            raise AgentError("HDC_NOT_FOUND", "The selected HDC executable is unavailable.") from exc
        except PermissionError as exc:
            raise AgentError("HDC_START_FAILED", "Permission to start HDC was denied.") from exc
        except subprocess.TimeoutExpired as exc:
            raise AgentError("HDC_TIMEOUT", f"{operation} exceeded its time budget.",
                             details={"timeoutMs": round(timeout_seconds * 1000)},
                             dispatched=dispatched) from exc
        except OSError as exc:
            raise AgentError("HDC_START_FAILED", "HDC could not be started.",
                             details={"osError": exc.errno}) from exc
        finally:
            self.elapsed_ms += (time.monotonic() - started) * 1000
        try:
            stdout = completed.stdout if isinstance(completed.stdout, str) else completed.stdout.decode("utf-8")
            stderr = completed.stderr if isinstance(completed.stderr, str) else completed.stderr.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AgentError("HDC_ENCODING_ERROR", "HDC returned output that is not valid UTF-8.",
                             dispatched=dispatched) from exc
        if completed.returncode or _FAILURE.search(stdout) or _FAILURE.search(stderr):
            # Do not include argv or device text in errors: input may contain secrets.
            raise AgentError("HDC_COMMAND_FAILED", f"{operation} reported a failure.",
                             details={"exitCode": completed.returncode}, dispatched=dispatched)
        return stdout

    def version(self):
        return self._run(["version"], operation="HDC version query").strip()

    def devices(self):
        output = self._run(["list", "targets"], operation="Device enumeration")
        targets = []
        for line in output.splitlines():
            line = line.strip()
            if not line or line == "[Empty]":
                continue
            if line.startswith("["):
                raise AgentError("HDC_RESPONSE_INVALID", "Device enumeration returned an unexpected status.")
            target = line.split()[0]
            if target not in targets:
                targets.append(target)
        return targets

    def shell(self, device, args, *, timeout_ms=None, mutating=False):
        device = _device(device)
        if isinstance(args, (str, bytes)) or not args:
            raise AgentError("INVALID_ARGUMENT", "shell requires a nonempty argument sequence.", exit_code=2)
        command = shlex.join([_argument(arg) for arg in args])
        marker = "__HARMONY_EXIT_" + uuid.uuid4().hex + "__"
        # This is a POSIX command executed only by the target device's shell.
        # All caller-provided values have been shell quoted above.
        wrapped = f'{command}; __ha_rc=$?; printf "\\n{marker}%s\\n" "$__ha_rc"'
        output = self._run(["-t", device, "shell", wrapped], timeout_ms=timeout_ms,
                           mutating=mutating, operation="Device command")
        match = re.search(r"\r?\n" + re.escape(marker) + r"(\d+)\r?\n?\s*$", output)
        if not match:
            raise AgentError("REMOTE_RESULT_UNKNOWN", "The device command did not return an exit receipt.",
                             dispatched="unknown" if mutating else "no")
        body = output[:match.start()]
        code = int(match.group(1))
        if code or (mutating and _DEVICE_FAILURE.search(body)):
            raise AgentError("DEVICE_COMMAND_FAILED", "The device command reported a failure.",
                             details={"remoteExitCode": code}, dispatched="unknown" if mutating else "no")
        return body

    def _receive(self, device, remote, local, *, timeout_ms=None):
        self._run(["-t", _device(device), "file", "recv", remote, str(local)],
                  timeout_ms=timeout_ms, operation="Device file transfer")
        if not local.is_file():
            raise AgentError("TRANSFER_INCOMPLETE", "HDC did not create the requested local artifact.")

    def _cleanup(self, device, remote, *, timeout_ms=None):
        try:
            budget = min(self.timeout_ms, 3000) if timeout_ms is None else timeout_ms
            self.shell(device, ["rm", "-f", "--", remote], timeout_ms=budget)
        except AgentError:
            # Cleanup must not hide the actual operation result. Only our own
            # unique file is ever removed; the next command uses a new path.
            pass

    def capture_layout(self, device, *, timeout_ms=None):
        budget = self.timeout_ms if timeout_ms is None else timeout_ms
        deadline = time.monotonic() + _timeout(budget)

        def remaining():
            milliseconds = (deadline - time.monotonic()) * 1000
            if milliseconds <= 0:
                raise AgentError("HDC_TIMEOUT", "UI capture exceeded its time budget.",
                                 details={"timeoutMs": budget})
            return milliseconds

        remote = "/data/local/tmp/ha_" + uuid.uuid4().hex + ".json"
        with tempfile.TemporaryDirectory(prefix="harmony-layout-") as directory:
            local = Path(directory) / "layout.json"
            try:
                self.shell(device, ["uitest", "dumpLayout", "-p", remote], timeout_ms=remaining())
                self._receive(device, remote, local, timeout_ms=remaining())
                if local.stat().st_size > 32 * 1024 * 1024:
                    raise AgentError("LAYOUT_TOO_LARGE", "The UI layout exceeds the 32 MiB limit.")
                try:
                    raw = json.loads(local.read_text(encoding="utf-8-sig"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise AgentError("LAYOUT_INVALID", "The device UI layout is not valid UTF-8 JSON.") from exc
                if not isinstance(raw, (dict, list)):
                    raise AgentError("LAYOUT_INVALID", "The device UI layout has an unsupported root value.")
                return raw
            finally:
                # Cleanup gets at most 250 ms within the remaining read budget,
                # or a 1 ms best-effort allowance when that budget is exhausted.
                cleanup_ms = max(1, min(250, (deadline - time.monotonic()) * 1000))
                self._cleanup(device, remote, timeout_ms=cleanup_ms)

    def screenshot(self, device, destination):
        destination = Path(destination).expanduser().resolve()
        if destination.exists():
            raise AgentError("ARTIFACT_EXISTS", "Screenshot destination already exists.")
        remote = "/data/local/tmp/ha_" + uuid.uuid4().hex + ".png"
        with tempfile.TemporaryDirectory(prefix="harmony-screen-") as directory:
            local = Path(directory) / "screen.png"
            try:
                self.shell(device, ["uitest", "screenCap", "-p", remote])
                self._receive(device, remote, local)
                if local.stat().st_size > 64 * 1024 * 1024:
                    raise AgentError("SCREENSHOT_TOO_LARGE", "The screenshot exceeds the 64 MiB limit.")
                with local.open("rb") as handle:
                    prefix = handle.read(8)
                if not (prefix.startswith(_PNG) or prefix.startswith(_JPEG)):
                    raise AgentError("SCREENSHOT_INVALID", "The captured artifact is not PNG or JPEG.")
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    with destination.open("xb") as target, local.open("rb") as source:
                        shutil.copyfileobj(source, target)
                except FileExistsError as exc:
                    raise AgentError("ARTIFACT_EXISTS", "Screenshot destination already exists.") from exc
                return destination
            finally:
                self._cleanup(device, remote)

    def open_app(self, device, app, ability="EntryAbility"):
        if not isinstance(app, str) or not app or not isinstance(ability, str) or not ability:
            raise AgentError("INVALID_ARGUMENT", "Application and ability names are required.", exit_code=2)
        return self.shell(device, ["aa", "start", "-b", app, "-a", ability], mutating=True)

    def tap(self, device, x, y, *, timeout_ms=None):
        return self.shell(device, ["uitest", "uiInput", "click", _coordinate(x), _coordinate(y)],
                          timeout_ms=timeout_ms, mutating=True)

    def fill(self, device, x, y, text):
        if not isinstance(text, str):
            raise AgentError("INVALID_ARGUMENT", "Input text must be a string.", exit_code=2)
        return self.shell(device, ["uitest", "uiInput", "inputText", _coordinate(x), _coordinate(y), text],
                          mutating=True)

    def key(self, device, key, *, timeout_ms=None):
        keys = key if isinstance(key, (tuple, list)) else [key]
        if not keys or len(keys) > 3 or any(str(value) not in {"Back", "Home", "Power"} and not str(value).isdigit() for value in keys):
            raise AgentError("INVALID_ARGUMENT", "Key must be Back, Home, Power or a numeric key code.", exit_code=2)
        return self.shell(device, ["uitest", "uiInput", "keyEvent", *[str(value) for value in keys]],
                          timeout_ms=timeout_ms, mutating=True)

    def swipe(self, device, x1, y1, x2, y2, velocity=600):
        if isinstance(velocity, bool) or not isinstance(velocity, int) or not 200 <= velocity <= 40000:
            raise AgentError("INVALID_ARGUMENT", "Swipe velocity must be an integer from 200 to 40000.", exit_code=2)
        return self.shell(device, ["uitest", "uiInput", "swipe", *map(_coordinate, (x1, y1, x2, y2)), str(velocity)],
                          mutating=True)

    def boot_id(self, device):
        try:
            value = self.shell(device, ["cat", "/proc/sys/kernel/random/boot_id"]).strip()
        except AgentError:
            return None
        return value if re.fullmatch(r"[0-9a-fA-F-]{36}", value) else None

    def capabilities(self, device):
        result = {"uitestVersion": None, "apiVersion": None, "help": "", "features": {}, "warnings": []}
        for key, args in (("uitestVersion", ["uitest", "--version"]),
                          ("apiVersion", ["param", "get", "const.ohos.apiversion"]),
                          ("help", ["uitest", "help"])):
            try:
                result[key] = self.shell(device, args).strip()
            except AgentError as exc:
                result["warnings"].append({"probe": key, "code": exc.code})
        help_text = result["help"]
        result["features"] = {
            "layout": "dumpLayout" in help_text if help_text else None,
            "screenshot": "screenCap" in help_text if help_text else None,
            "inputText": "inputText" in help_text if help_text else None,
            "text": bool(re.search(r"\btext\s+<text>", help_text)) if help_text else None,
            "bundleScope": "bundleName" in help_text if help_text else None,
            "windowScope": "windowId" in help_text if help_text else None,
        }
        result["verification"] = "command-help-only"
        return result
