from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from coworker.acp import AcpAgentAdapter, AcpEmptyTurnError, AcpSessionHandle


FIXTURE = Path(__file__).parent / "fixtures" / "fake_acp_agent.py"


def _profile(*, role: str = "main", permission_policy: str = "coding-default", env=None):
    return {
        "id": f"fake-{role}",
        "role": role,
        "transport": "acp_stdio",
        "command": sys.executable,
        "args": [str(FIXTURE)],
        "permission_policy": permission_policy,
        "env": env or {},
        "limits": {"timeout_seconds": 5},
    }


@pytest.mark.asyncio
async def test_acp_session_supports_multiple_prompt_turns(tmp_path):
    events = []
    adapter = AcpAgentAdapter(update_sink=events.append)
    handle = await adapter.open_session(_profile(), cwd=tmp_path)
    try:
        first = await adapter.prompt(handle, "first")
        second = await adapter.prompt(handle, "second")
    finally:
        await adapter.close(handle)

    assert handle.capabilities["agentCapabilities"]["loadSession"] is True
    assert first.stop_reason == "end_turn"
    assert "turn=1;text=first" in first.text
    assert "turn=2;text=second" in second.text
    assert [event["type"] for event in events].count("acp.turn_finished") == 2


@pytest.mark.asyncio
async def test_acp_recovery_prefers_resume_then_load_then_checkpoint(tmp_path):
    adapter = AcpAgentAdapter()
    resumed = await adapter.open_session(
        _profile(), cwd=tmp_path, existing_session_id="durable-session"
    )
    assert resumed.recovery_mode == "resume"
    await adapter.close(resumed)

    loaded = await adapter.open_session(
        _profile(env={"FAKE_ACP_DISABLE_RESUME": "1"}),
        cwd=tmp_path,
        existing_session_id="durable-session",
    )
    assert loaded.recovery_mode == "load"
    await adapter.close(loaded)

    checkpoint = await adapter.open_session(
        _profile(
            env={
                "FAKE_ACP_DISABLE_RESUME": "1",
                "FAKE_ACP_DISABLE_LOAD": "1",
            }
        ),
        cwd=tmp_path,
        existing_session_id="durable-session",
        checkpoint={"summary": "continue safely"},
    )
    try:
        assert checkpoint.recovery_mode == "checkpoint"
        follow_up = await adapter.prompt(checkpoint, "after restart")
        assert "after restart" in follow_up.text
    finally:
        await adapter.close(checkpoint)


@pytest.mark.asyncio
async def test_reviewer_permission_is_always_rejected(tmp_path):
    async def unsafe_allow(_request):
        return "allow-once"

    adapter = AcpAgentAdapter(permission_resolver=unsafe_allow)
    handle = await adapter.open_session(
        _profile(role="reviewer", permission_policy="read-only"), cwd=tmp_path
    )
    try:
        result = await adapter.prompt(handle, "permission")
    finally:
        await adapter.close(handle)
    assert "permission=reject-once" in result.text


@pytest.mark.asyncio
async def test_cancel_stops_inflight_prompt(tmp_path):
    adapter = AcpAgentAdapter()
    handle = await adapter.open_session(_profile(), cwd=tmp_path)
    task = asyncio.create_task(adapter.prompt(handle, "slow"))
    await asyncio.sleep(0.05)
    await adapter.cancel(handle)
    result = await task
    assert result.stop_reason == "cancelled"
    await adapter.close(handle)


@pytest.mark.asyncio
async def test_end_turn_without_agent_message_chunk_is_failed():
    events = []
    adapter = AcpAgentAdapter(update_sink=events.append)
    session_id = "empty-session"
    handle = AcpSessionHandle(
        runtime_id="runtime-empty-turn",
        profile_id="fake-main",
        role="main",
        session_id=session_id,
        cwd="/tmp",
        capabilities={},
        recovery_mode="new",
        process_id=None,
    )

    class EmptyConnection:
        async def prompt(self, *, session_id: str, prompt: list[object]):
            runtime.client.updates.setdefault(session_id, []).append(
                {
                    "type": "acp.session_update",
                    "session_id": session_id,
                    "update_type": "AvailableCommandsUpdate",
                    "update": {"commands": []},
                }
            )
            return SimpleNamespace(stop_reason="end_turn")

    runtime = SimpleNamespace(
        runtime_id=handle.runtime_id,
        profile={"id": handle.profile_id},
        role=handle.role,
        cwd=handle.cwd,
        client=SimpleNamespace(updates={session_id: []}),
        connection=EmptyConnection(),
        process=SimpleNamespace(returncode=None),
        capabilities={},
        timeout_seconds=5,
        session_id=session_id,
        prompt_lock=asyncio.Lock(),
        busy=False,
    )
    adapter._runtimes[handle.runtime_id] = runtime

    with pytest.raises(AcpEmptyTurnError):
        await adapter.prompt(handle, "hello")

    assert "acp.turn_failed" in [event["type"] for event in events]
    assert "acp.turn_finished" not in [event["type"] for event in events]


@pytest.mark.asyncio
async def test_end_turn_with_empty_agent_message_chunk_is_valid():
    events = []
    adapter = AcpAgentAdapter(update_sink=events.append)
    session_id = "empty-message-session"
    handle = AcpSessionHandle(
        runtime_id="runtime-empty-message",
        profile_id="fake-main",
        role="main",
        session_id=session_id,
        cwd="/tmp",
        capabilities={},
        recovery_mode="new",
        process_id=None,
    )

    class EmptyMessageConnection:
        async def prompt(self, *, session_id: str, prompt: list[object]):
            runtime.client.updates.setdefault(session_id, []).append(
                {
                    "type": "acp.session_update",
                    "session_id": session_id,
                    "update_type": "AgentMessageChunk",
                    "update": {"content": {"type": "text", "text": ""}},
                    "text": "",
                }
            )
            return SimpleNamespace(stop_reason="end_turn")

    runtime = SimpleNamespace(
        runtime_id=handle.runtime_id,
        profile={"id": handle.profile_id},
        role=handle.role,
        cwd=handle.cwd,
        client=SimpleNamespace(updates={session_id: []}),
        connection=EmptyMessageConnection(),
        process=SimpleNamespace(returncode=None),
        capabilities={},
        timeout_seconds=5,
        session_id=session_id,
        prompt_lock=asyncio.Lock(),
        busy=False,
    )
    adapter._runtimes[handle.runtime_id] = runtime

    result = await adapter.prompt(handle, "hello")

    assert result.stop_reason == "end_turn"
    assert result.text == ""
    assert "acp.turn_finished" in [event["type"] for event in events]
    assert "acp.turn_failed" not in [event["type"] for event in events]


@pytest.mark.asyncio
async def test_end_turn_with_tool_update_is_valid():
    events = []
    adapter = AcpAgentAdapter(update_sink=events.append)
    session_id = "tool-only-session"
    handle = AcpSessionHandle(
        runtime_id="runtime-tool-only",
        profile_id="fake-executor",
        role="executor",
        session_id=session_id,
        cwd="/tmp",
        capabilities={},
        recovery_mode="new",
        process_id=None,
    )

    class ToolOnlyConnection:
        async def prompt(self, *, session_id: str, prompt: list[object]):
            runtime.client.updates.setdefault(session_id, []).append(
                {
                    "type": "acp.session_update",
                    "session_id": session_id,
                    "update_type": "ToolCallUpdate",
                    "update": {"tool_call_id": "call-1", "status": "completed"},
                }
            )
            return SimpleNamespace(stop_reason="end_turn")

    runtime = SimpleNamespace(
        runtime_id=handle.runtime_id,
        profile={"id": handle.profile_id},
        role=handle.role,
        cwd=handle.cwd,
        client=SimpleNamespace(updates={session_id: []}),
        connection=ToolOnlyConnection(),
        process=SimpleNamespace(returncode=None),
        capabilities={},
        timeout_seconds=5,
        session_id=session_id,
        prompt_lock=asyncio.Lock(),
        busy=False,
    )
    adapter._runtimes[handle.runtime_id] = runtime

    result = await adapter.prompt(handle, "run the tool")

    assert result.stop_reason == "end_turn"
    assert result.text == ""
    assert "acp.turn_finished" in [event["type"] for event in events]
    assert "acp.turn_failed" not in [event["type"] for event in events]
