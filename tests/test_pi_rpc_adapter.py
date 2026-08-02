from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

from coworker.acp import AcpProcessExited, PiJsonlRpcAdapter, PiRpcTimeoutError


def _profile(fake: Path, log: Path, **overrides):
    data = {
        "id": "pi-test",
        "role": "executor",
        "transport": "jsonl_rpc",
        "command": sys.executable,
        "args": [str(fake), "--mode", "rpc"],
        "env": {"PI_FAKE_LOG": str(log)},
        "limits": {"timeout_seconds": 2},
        "capabilities": {},
    }
    data.update(overrides)
    return data


def _log(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


async def _wait_for_log(path: Path, predicate):
    for _ in range(80):
        entries = _log(path)
        if predicate(entries):
            return entries
        await asyncio.sleep(0.01)
    raise AssertionError("expected fake Pi log entry was not written")


@pytest.mark.asyncio
async def test_pi_rpc_prompt_streams_multiple_turns_and_writes_strict_jsonl(tmp_path):
    fake = Path(__file__).parent / "fixtures" / "fake_pi_rpc.py"
    log = tmp_path / "pi.log"
    events: list[dict] = []
    adapter = PiJsonlRpcAdapter(update_sink=events.append)
    profile = _profile(fake, log)
    profile["env"]["PI_FAKE_CRLF"] = "1"

    handle = await adapter.open_session(profile, cwd=tmp_path)
    first = await adapter.prompt(handle, "hello")
    second = await adapter.prompt(handle, "again")
    await adapter.close(handle)

    assert first.text == "hello:ok"
    assert second.text == "again:ok"
    assert first.stop_reason == second.stop_reason == "end_turn"
    assert [event["text"] for event in first.events if "text" in event] == ["hello:", "ok"]
    raw_lines = [entry["line"] for entry in _log(log) if entry["kind"] == "raw"]
    assert raw_lines
    assert all(line.endswith("\n") and not line.endswith("\n\n") for line in raw_lines)
    frames = [json.loads(line) for line in raw_lines]
    assert frames == [
        {"id": 1, "type": "get_state"},
        {"id": 2, "type": "prompt", "message": "hello"},
        {"id": 3, "type": "prompt", "message": "again"},
    ]
    assert [e["type"] for e in events if e["type"].endswith("turn_finished")]


@pytest.mark.asyncio
async def test_pi_rpc_prompt_is_serial_even_when_called_concurrently(tmp_path):
    fake = Path(__file__).parent / "fixtures" / "fake_pi_rpc.py"
    log = tmp_path / "pi.log"
    adapter = PiJsonlRpcAdapter()

    handle = await adapter.open_session(_profile(fake, log), cwd=tmp_path)
    one, two = await asyncio.gather(adapter.prompt(handle, "one"), adapter.prompt(handle, "two"))
    await adapter.close(handle)

    assert one.text == "one:ok"
    assert two.text == "two:ok"
    raw_frames = [json.loads(entry["line"]) for entry in _log(log) if entry["kind"] == "raw"]
    prompt_frames = [frame for frame in raw_frames if frame["type"] == "prompt"]
    assert prompt_frames == [
        {"id": 2, "type": "prompt", "message": "one"},
        {"id": 3, "type": "prompt", "message": "two"},
    ]


@pytest.mark.asyncio
async def test_pi_rpc_cancel_sends_abort_and_settles_active_turn(tmp_path):
    fake = Path(__file__).parent / "fixtures" / "fake_pi_rpc.py"
    log = tmp_path / "pi.log"
    adapter = PiJsonlRpcAdapter()

    handle = await adapter.open_session(_profile(fake, log), cwd=tmp_path)
    prompt_task = asyncio.create_task(adapter.prompt(handle, "slow"))
    await _wait_for_log(
        log,
        lambda entries: any(
            entry.get("kind") == "raw" and json.loads(entry["line"])["type"] == "prompt"
            for entry in entries
        ),
    )
    await adapter.cancel(handle)
    result = await prompt_task
    await adapter.close(handle)

    assert result.stop_reason == "aborted"
    frames = [json.loads(entry["line"]) for entry in _log(log) if entry["kind"] == "raw"]
    assert {"id": 3, "type": "abort"} in frames


@pytest.mark.asyncio
async def test_pi_rpc_resume_uses_launch_session_and_get_state(tmp_path):
    fake = Path(__file__).parent / "fixtures" / "fake_pi_rpc.py"
    log = tmp_path / "pi.log"
    adapter = PiJsonlRpcAdapter()

    handle = await adapter.open_session(
        _profile(fake, log),
        cwd=tmp_path,
        existing_session_id="saved-session.json",
    )
    state = await adapter.get_state(handle)
    await adapter.close(handle)

    assert handle.session_id == "saved-session.json"
    assert handle.recovery_mode == "resume"
    assert state["sessionFile"] == "saved-session.json"
    argv = next(entry["argv"] for entry in _log(log) if entry["kind"] == "argv")
    assert argv[-2:] == ["--session", "saved-session.json"]


@pytest.mark.asyncio
async def test_pi_rpc_switch_session_is_explicit_capability_fallback(tmp_path):
    fake = Path(__file__).parent / "fixtures" / "fake_pi_rpc.py"
    log = tmp_path / "pi.log"
    adapter = PiJsonlRpcAdapter()

    handle = await adapter.open_session(
        _profile(fake, log, capabilities={"session_recovery": "switch_session"}),
        cwd=tmp_path,
        existing_session_id="switched-session.json",
    )
    await adapter.close(handle)

    assert handle.session_id == "switched-session.json"
    assert handle.recovery_mode == "switch_session"
    raw_frames = [json.loads(entry["line"]) for entry in _log(log) if entry["kind"] == "raw"]
    assert raw_frames[:2] == [
        {"id": 1, "type": "switch_session", "sessionPath": "switched-session.json"},
        {"id": 2, "type": "get_state"},
    ]
    argv = next(entry["argv"] for entry in _log(log) if entry["kind"] == "argv")
    assert "--session" not in argv


@pytest.mark.asyncio
async def test_pi_rpc_process_crash_rejects_active_prompt(tmp_path):
    fake = Path(__file__).parent / "fixtures" / "fake_pi_rpc.py"
    log = tmp_path / "pi.log"
    adapter = PiJsonlRpcAdapter()

    handle = await adapter.open_session(_profile(fake, log), cwd=tmp_path)
    with pytest.raises(AcpProcessExited):
        await adapter.prompt(handle, "crash")


@pytest.mark.asyncio
async def test_pi_rpc_prompt_timeout_aborts_active_turn(tmp_path):
    fake = Path(__file__).parent / "fixtures" / "fake_pi_rpc.py"
    log = tmp_path / "pi.log"
    adapter = PiJsonlRpcAdapter()

    handle = await adapter.open_session(
        _profile(fake, log, limits={"timeout_seconds": 1}),
        cwd=tmp_path,
    )
    with pytest.raises(PiRpcTimeoutError):
        await adapter.prompt(handle, "slow")
    await adapter.close(handle)

    frames = [json.loads(entry["line"]) for entry in _log(log) if entry["kind"] == "raw"]
    assert frames[-1] == {"id": 3, "type": "abort"}
