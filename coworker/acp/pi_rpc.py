"""Pi LF-delimited JSON RPC adapter.

The Pi RPC transport is intentionally separate from the ACP SDK adapter.  It speaks the
experimental line-oriented JSON protocol directly: every outbound request is one JSON object
terminated by LF, responses are correlated by ``id``, and prompt text is streamed through
``message_update`` events until ``agent_settled``.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping, Optional

from .adapter import AcpProcessExited, AcpSessionHandle, AcpTurnResult
from .process_env import build_agent_env

NormalizedEvent = dict[str, Any]
UpdateSink = Callable[[NormalizedEvent], Awaitable[None] | None]


class PiRpcProtocolError(RuntimeError):
    """Raised when the Pi JSONL process returns an invalid RPC frame."""


class PiRpcTimeoutError(TimeoutError):
    """Raised when a Pi RPC request or turn does not complete before the profile timeout."""


@dataclass
class _PromptTurn:
    session_id: str
    events: list[NormalizedEvent] = field(default_factory=list)
    text_parts: list[str] = field(default_factory=list)
    settled: asyncio.Future[dict[str, Any]] | None = None


@dataclass
class _PiRuntime:
    runtime_id: str
    profile: Any
    role: str
    cwd: str
    process: asyncio.subprocess.Process
    timeout_seconds: float
    session_id: str
    capabilities: dict[str, Any]
    request_seq: int = 0
    pending: dict[int, tuple[str, asyncio.Future[Any]]] = field(default_factory=dict)
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    prompt_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    busy: bool = False
    active_turn: _PromptTurn | None = None
    reader_task: asyncio.Task[None] | None = None
    stderr_task: asyncio.Task[None] | None = None


class PiJsonlRpcAdapter:
    """Manage a Pi JSONL RPC subprocess.

    Recovery support deliberately uses the stable launch-time ``--session`` path by default.
    ``switch_session`` is exposed, but ``open_session(..., existing_session_id=...)`` only uses
    it when the profile capabilities opt in with ``{"session_recovery": "switch_session"}``
    or ``{"switch_session": true}``.
    """

    def __init__(
        self,
        *,
        update_sink: Optional[UpdateSink] = None,
        request_timeout_seconds: float = 30.0,
    ) -> None:
        self.update_sink = update_sink
        self.request_timeout_seconds = request_timeout_seconds
        self._runtimes: dict[str, _PiRuntime] = {}

    async def open_session(
        self,
        profile: Any,
        *,
        cwd: str | Path,
        existing_session_id: Optional[str] = None,
        resolved_secrets: Optional[Mapping[str, str]] = None,
    ) -> AcpSessionHandle:
        recovery_mode = "new"
        use_switch = bool(existing_session_id and _use_switch_session(profile))
        runtime = await self._spawn(
            profile,
            cwd=cwd,
            existing_session_id=None if use_switch else existing_session_id,
            resolved_secrets=resolved_secrets,
        )
        try:
            if existing_session_id and use_switch:
                await self._request(runtime, "switch_session", {"sessionPath": existing_session_id})
                recovery_mode = "switch_session"
            elif existing_session_id:
                recovery_mode = "resume"

            state = await self._request(runtime, "get_state", {}, timeout=self.request_timeout_seconds)
            if not isinstance(state, Mapping):
                raise PiRpcProtocolError(f"Pi get_state returned non-object result: {state!r}")
            session_file = str(state.get("sessionFile") or existing_session_id or "").strip()
            if session_file:
                runtime.session_id = session_file
            self._runtimes[runtime.runtime_id] = runtime
            handle = self._handle(runtime, recovery_mode)
            await _emit(
                self.update_sink,
                {
                    "type": "pi_rpc.session_opened",
                    "runtime_id": runtime.runtime_id,
                    "profile_id": handle.profile_id,
                    "session_id": handle.session_id,
                    "recovery_mode": recovery_mode,
                    "capabilities": runtime.capabilities,
                    "state": state,
                },
            )
            return handle
        except Exception:
            await self._shutdown_runtime(runtime)
            raise

    async def prompt(self, handle: AcpSessionHandle, message: str) -> AcpTurnResult:
        if not message or not message.strip():
            raise ValueError("Pi RPC prompt cannot be empty")
        runtime = self._runtime(handle)
        async with runtime.prompt_lock:
            self._ensure_alive(runtime)
            loop = asyncio.get_running_loop()
            turn = _PromptTurn(session_id=runtime.session_id, settled=loop.create_future())
            runtime.active_turn = turn
            runtime.busy = True
            await _emit(
                self.update_sink,
                {
                    "type": "pi_rpc.turn_started",
                    "runtime_id": runtime.runtime_id,
                    "profile_id": handle.profile_id,
                    "session_id": runtime.session_id,
                },
            )
            try:
                accepted = await self._request(
                    runtime,
                    "prompt",
                    {"message": message},
                    timeout=runtime.timeout_seconds,
                )
                if not _is_accepted(accepted):
                    raise PiRpcProtocolError(f"Pi prompt was not accepted: {accepted!r}")
                settled = await asyncio.wait_for(turn.settled, timeout=runtime.timeout_seconds)
            except asyncio.TimeoutError as exc:
                with contextlib.suppress(Exception):
                    await self._request(runtime, "abort", timeout=self.request_timeout_seconds)
                await _emit(
                    self.update_sink,
                    {
                        "type": "pi_rpc.turn_timed_out",
                        "runtime_id": runtime.runtime_id,
                        "session_id": runtime.session_id,
                        "timeout_seconds": runtime.timeout_seconds,
                    },
                )
                raise PiRpcTimeoutError("Pi RPC prompt timed out") from exc
            finally:
                runtime.busy = False
                runtime.active_turn = None

            stop_reason = str(settled.get("stop_reason") or settled.get("reason") or "agent_settled")
            result = AcpTurnResult(
                session_id=runtime.session_id,
                stop_reason=stop_reason,
                text="".join(turn.text_parts),
                events=tuple(turn.events),
            )
            await _emit(
                self.update_sink,
                {
                    "type": "pi_rpc.turn_finished",
                    "runtime_id": runtime.runtime_id,
                    "profile_id": handle.profile_id,
                    "session_id": runtime.session_id,
                    "stop_reason": stop_reason,
                },
            )
            return result

    async def cancel(self, handle: AcpSessionHandle) -> None:
        runtime = self._runtime(handle)
        self._ensure_alive(runtime)
        await self._request(runtime, "abort", timeout=self.request_timeout_seconds)
        await _emit(
            self.update_sink,
            {
                "type": "pi_rpc.session_cancelled",
                "runtime_id": runtime.runtime_id,
                "session_id": runtime.session_id,
            },
        )

    async def get_state(self, handle: AcpSessionHandle) -> dict[str, Any]:
        runtime = self._runtime(handle)
        state = await self._request(runtime, "get_state", timeout=self.request_timeout_seconds)
        if not isinstance(state, Mapping):
            raise PiRpcProtocolError(f"Pi get_state returned non-object result: {state!r}")
        return dict(state)

    async def switch_session(self, handle: AcpSessionHandle, session_file: str) -> AcpSessionHandle:
        runtime = self._runtime(handle)
        if runtime.busy:
            raise RuntimeError("cannot switch Pi session while a prompt is active")
        await self._request(runtime, "switch_session", {"sessionPath": session_file})
        runtime.session_id = session_file
        return self._handle(runtime, "switch_session")

    async def close(self, handle: AcpSessionHandle) -> None:
        runtime = self._runtimes.pop(handle.runtime_id, None)
        if runtime is not None:
            await self._shutdown_runtime(runtime)

    async def aclose(self) -> None:
        runtimes = list(self._runtimes.values())
        self._runtimes.clear()
        await asyncio.gather(
            *(self._shutdown_runtime(runtime) for runtime in runtimes),
            return_exceptions=True,
        )

    def is_busy(self, handle: AcpSessionHandle) -> bool:
        return self._runtime(handle).busy

    async def _spawn(
        self,
        profile: Any,
        *,
        cwd: str | Path,
        existing_session_id: Optional[str],
        resolved_secrets: Optional[Mapping[str, str]],
    ) -> _PiRuntime:
        transport = _enum_value(_profile_value(profile, "transport", "jsonl_rpc"))
        if transport != "jsonl_rpc":
            raise ValueError(f"PiJsonlRpcAdapter cannot run transport {transport!r}")
        profile_id = str(_profile_value(profile, "id", "")).strip()
        if not profile_id:
            raise ValueError("agent profile id is required")
        command = _resolve_executable(str(_profile_value(profile, "command", "")))
        args = [str(item) for item in (_profile_value(profile, "args", []) or [])]
        if existing_session_id and not _has_session_arg(args):
            args.extend(["--session", existing_session_id])
        if any("\x00" in item for item in [command, *args]):
            raise ValueError("Pi command contains a NUL byte")
        workdir = str(Path(cwd).expanduser().resolve())
        if not Path(workdir).is_dir():
            raise ValueError(f"Pi cwd does not exist: {workdir}")

        env = build_agent_env(profile, resolved_secrets=resolved_secrets)

        process = await asyncio.create_subprocess_exec(
            command,
            *args,
            cwd=workdir,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        if process.stdin is None or process.stdout is None:
            await _terminate(process)
            raise RuntimeError("Pi RPC process did not expose stdio pipes")
        runtime = _PiRuntime(
            runtime_id="pi-rpc-" + uuid.uuid4().hex,
            profile=profile,
            role=_enum_value(_profile_value(profile, "role", "executor")),
            cwd=workdir,
            process=process,
            timeout_seconds=_profile_timeout(profile),
            session_id=existing_session_id or "",
            capabilities=dict(_profile_value(profile, "capabilities", {}) or {}),
        )
        runtime.reader_task = asyncio.create_task(self._read_stdout(runtime))
        if process.stderr is not None:
            runtime.stderr_task = asyncio.create_task(self._drain_stderr(runtime))
        return runtime

    async def _request(
        self,
        runtime: _PiRuntime,
        command: str,
        fields: Optional[Mapping[str, Any]] = None,
        *,
        timeout: Optional[float] = None,
    ) -> Any:
        self._ensure_alive(runtime)
        runtime.request_seq += 1
        request_id = runtime.request_seq
        loop = asyncio.get_running_loop()
        future: asyncio.Future[Any] = loop.create_future()
        runtime.pending[request_id] = (command, future)
        frame = {"id": request_id, "type": command}
        if fields:
            frame.update(dict(fields))
        line = json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n"
        try:
            assert runtime.process.stdin is not None
            async with runtime.write_lock:
                runtime.process.stdin.write(line.encode("utf-8"))
                await runtime.process.stdin.drain()
            return await asyncio.wait_for(
                future,
                timeout=timeout if timeout is not None else self.request_timeout_seconds,
            )
        except asyncio.TimeoutError:
            runtime.pending.pop(request_id, None)
            raise

    async def _read_stdout(self, runtime: _PiRuntime) -> None:
        assert runtime.process.stdout is not None
        try:
            while True:
                try:
                    line = await runtime.process.stdout.readuntil(b"\n")
                except asyncio.IncompleteReadError as exc:
                    if exc.partial:
                        raise PiRpcProtocolError("Pi RPC stream ended with a partial frame") from exc
                    break
                await self._handle_frame(runtime, line)
        except Exception as exc:
            self._fail_runtime(runtime, exc)
            return
        code = await runtime.process.wait()
        self._fail_runtime(runtime, AcpProcessExited(f"Pi RPC process exited with code {code}"))

    async def _handle_frame(self, runtime: _PiRuntime, raw_line: bytes) -> None:
        if not raw_line.endswith(b"\n"):
            raise PiRpcProtocolError("Pi RPC frame was not LF terminated")
        text = raw_line[:-1].decode("utf-8", errors="strict")
        if text.endswith("\r"):
            text = text[:-1]
        frame = json.loads(text)
        if not isinstance(frame, Mapping):
            raise PiRpcProtocolError(f"Pi RPC frame was not an object: {frame!r}")

        frame_type = str(frame.get("type") or "")
        if frame_type == "response":
            request_id = int(frame["id"])
            pending = runtime.pending.pop(request_id, None)
            if pending is None:
                raise PiRpcProtocolError(f"response for unknown Pi request id: {request_id}")
            expected_command, future = pending
            command = str(frame.get("command") or "")
            if command != expected_command:
                future.set_exception(
                    PiRpcProtocolError(
                        f"Pi response command mismatch: expected {expected_command!r}, got {command!r}"
                    )
                )
            elif not frame.get("success", False):
                future.set_exception(PiRpcProtocolError(str(frame.get("error") or "Pi command failed")))
            else:
                future.set_result(frame.get("data"))
            return

        await self._handle_notification(runtime, frame_type, dict(frame))

    async def _handle_notification(
        self, runtime: _PiRuntime, event_type: str, frame: dict[str, Any]
    ) -> None:
        event: NormalizedEvent = {
            "type": f"pi_rpc.{event_type or 'notification'}",
            "runtime_id": runtime.runtime_id,
            "profile_id": str(_profile_value(runtime.profile, "id", "")),
            "session_id": runtime.session_id,
            "event_type": event_type,
            "frame": frame,
        }
        if event_type == "message_update":
            assistant_event = frame.get("assistantMessageEvent")
            delta = (
                assistant_event.get("delta")
                if isinstance(assistant_event, Mapping)
                and assistant_event.get("type") == "text_delta"
                else None
            )
            if delta is not None:
                event["text"] = str(delta)
                if runtime.active_turn is not None:
                    runtime.active_turn.text_parts.append(str(delta))
                    runtime.active_turn.events.append(event)
        elif event_type == "agent_settled":
            if runtime.active_turn is not None and runtime.active_turn.settled is not None:
                if not runtime.active_turn.settled.done():
                    runtime.active_turn.settled.set_result(frame)
                runtime.active_turn.events.append(event)
        await _emit(self.update_sink, event)

    async def _drain_stderr(self, runtime: _PiRuntime) -> None:
        assert runtime.process.stderr is not None
        while True:
            line = await runtime.process.stderr.readline()
            if not line:
                return
            await _emit(
                self.update_sink,
                {
                    "type": "pi_rpc.agent_stderr",
                    "runtime_id": runtime.runtime_id,
                    "profile_id": str(_profile_value(runtime.profile, "id", "")),
                    "message": line.decode("utf-8", errors="replace").rstrip(),
                },
            )

    async def _shutdown_runtime(self, runtime: _PiRuntime) -> None:
        if runtime.process.stdin is not None:
            with contextlib.suppress(Exception):
                runtime.process.stdin.close()
                await asyncio.wait_for(runtime.process.stdin.wait_closed(), timeout=2)
        await _terminate(runtime.process)
        for task in (runtime.reader_task, runtime.stderr_task):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        self._fail_runtime(runtime, AcpProcessExited("Pi RPC runtime closed"))

    def _runtime(self, handle: AcpSessionHandle) -> _PiRuntime:
        runtime = self._runtimes.get(handle.runtime_id)
        if runtime is None or runtime.session_id != handle.session_id:
            raise KeyError(f"unknown Pi RPC runtime: {handle.runtime_id}")
        return runtime

    @staticmethod
    def _ensure_alive(runtime: _PiRuntime) -> None:
        if runtime.process.returncode is not None:
            raise AcpProcessExited(f"Pi RPC process exited with code {runtime.process.returncode}")

    @staticmethod
    def _handle(runtime: _PiRuntime, recovery_mode: str) -> AcpSessionHandle:
        return AcpSessionHandle(
            runtime_id=runtime.runtime_id,
            profile_id=str(_profile_value(runtime.profile, "id", "")),
            role=runtime.role,
            session_id=runtime.session_id,
            cwd=runtime.cwd,
            capabilities=runtime.capabilities,
            recovery_mode=recovery_mode,
            process_id=runtime.process.pid,
        )

    @staticmethod
    def _fail_runtime(runtime: _PiRuntime, exc: Exception) -> None:
        for _, future in list(runtime.pending.values()):
            if not future.done():
                future.set_exception(exc)
        runtime.pending.clear()
        turn = runtime.active_turn
        if turn is not None and turn.settled is not None and not turn.settled.done():
            turn.settled.set_exception(exc)


def _is_accepted(result: Any) -> bool:
    if result is None or result is True:
        return True
    if isinstance(result, Mapping):
        status = result.get("status")
        return status in {None, "accepted"} or result.get("accepted") is True
    return False


async def _emit(sink: Optional[UpdateSink], event: NormalizedEvent) -> None:
    if sink is None:
        return
    result = sink(event)
    if inspect.isawaitable(result):
        await result


async def _terminate(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        process.terminate()
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(process.wait(), timeout=5)


def _resolve_executable(command: str) -> str:
    command = command.strip()
    if not command:
        raise ValueError("Pi command is required")
    path = Path(command).expanduser()
    if path.is_absolute():
        if not path.exists():
            raise FileNotFoundError(command)
        return str(path)
    resolved = shutil.which(command)
    if not resolved:
        raise FileNotFoundError(f"Pi command not found on PATH: {command}")
    return resolved


def _profile_value(profile: Any, key: str, default: Any) -> Any:
    if isinstance(profile, Mapping):
        return profile.get(key, default)
    return getattr(profile, key, default)


def _enum_value(value: Any) -> str:
    return str(getattr(value, "value", value))


def _profile_timeout(profile: Any) -> float:
    limits = _profile_value(profile, "limits", {}) or {}
    value = (
        limits.get("timeout_seconds", 1800)
        if isinstance(limits, Mapping)
        else getattr(limits, "timeout_seconds", 1800)
    )
    try:
        return max(1.0, float(value))
    except (TypeError, ValueError):
        return 1800.0


def _has_session_arg(args: list[str]) -> bool:
    return "--session" in args or any(item.startswith("--session=") for item in args)


def _use_switch_session(profile: Any) -> bool:
    capabilities = _profile_value(profile, "capabilities", {}) or {}
    if not isinstance(capabilities, Mapping):
        return False
    return capabilities.get("session_recovery") == "switch_session" or capabilities.get(
        "switch_session"
    ) is True
