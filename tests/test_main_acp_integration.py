from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional, Sequence

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from coworker.acp import AcpMcpServer, AcpSessionHandle, AcpTurnResult
from coworker.server import SessionManager, create_app


class FakeMainAdapter:
    def __init__(self) -> None:
        self.open_calls: list[dict[str, Any]] = []
        self.prompts: list[str] = []
        self.closed: list[str] = []
        self.cancelled: list[str] = []
        self.aclose_count = 0
        self.block_next_prompt = False
        self.release_prompt: Optional[asyncio.Event] = None
        self.raise_next: Optional[Exception] = None
        self.update_sink = None

    async def open_session(
        self,
        profile,
        *,
        cwd,
        existing_session_id=None,
        checkpoint=None,
        mcp_servers: Sequence[AcpMcpServer] = (),
        **_,
    ) -> AcpSessionHandle:
        self.open_calls.append(
            {
                "profile_id": profile.id,
                "cwd": str(cwd),
                "existing_session_id": existing_session_id,
                "checkpoint": checkpoint,
                "mcp_servers": list(mcp_servers),
            }
        )
        return AcpSessionHandle(
            runtime_id=f"runtime-{len(self.open_calls)}",
            profile_id=profile.id,
            role=profile.role.value,
            session_id=existing_session_id or "fake-main-session",
            cwd=str(cwd),
            capabilities={"fake": True},
            recovery_mode="resume" if existing_session_id else "new",
            process_id=None,
        )

    async def prompt(self, handle: AcpSessionHandle, message: str) -> AcpTurnResult:
        self.prompts.append(message)
        if self.raise_next is not None:
            exc = self.raise_next
            self.raise_next = None
            raise exc
        if self.block_next_prompt:
            self.block_next_prompt = False
            self.release_prompt = asyncio.Event()
            await self.release_prompt.wait()
        events = (
            {
                "type": "acp.session_update",
                "profile_id": handle.profile_id,
                "session_id": handle.session_id,
                "text": "delta",
            },
            {
                "type": "acp.permission_requested",
                "profile_id": handle.profile_id,
                "session_id": handle.session_id,
                "role": "main",
                "tool_call": {"name": "edit"},
                "options": [{"id": "allow"}],
            },
        )
        if self.update_sink is not None:
            for event in events:
                await self.update_sink(event)
        return AcpTurnResult(
            session_id=handle.session_id,
            stop_reason="end_turn",
            text=f"answer-{len(self.prompts)}",
            events=events,
        )

    async def cancel(self, handle: AcpSessionHandle) -> None:
        self.cancelled.append(handle.session_id)
        if self.release_prompt is not None:
            self.release_prompt.set()

    async def close(self, handle: AcpSessionHandle) -> None:
        self.closed.append(handle.session_id)

    async def aclose(self) -> None:
        self.aclose_count += 1


def _register_profile(manager: SessionManager, payload: dict[str, Any]):
    profile = manager.orchestrator.put(payload)
    profile = manager.orchestrator.save_capabilities(profile.id, {"fake": True})
    profile.enabled = True
    return manager.orchestrator.put(profile)


def _manager(tmp_path: Path, adapter: FakeMainAdapter) -> SessionManager:
    manager = SessionManager(workspace=tmp_path)
    profile = _register_profile(
        manager,
        {
            "id": "fake-main",
            "role": "main",
            "transport": "acp_stdio",
            "command": "fake",
            "model_profile": "fake-model",
        }
    )
    manager.orchestrator.set_workspace_main(tmp_path, profile.id)
    manager.main_acp_host.acp_adapter = adapter  # type: ignore[assignment]
    adapter.update_sink = manager._handle_acp_update
    return manager


def test_session_manager_owns_one_main_acp_host_and_injects_team_mcp(tmp_path):
    adapter = FakeMainAdapter()
    manager = _manager(tmp_path, adapter)

    try:
        assert manager.main_acp_host is manager.main_acp_host
        asyncio.run(manager.main_acp_host.open("conv-main", tmp_path))
        servers = adapter.open_calls[0]["mcp_servers"]
        assert len(servers) == 1
        assert servers[0].name == "qh-team"
        assert servers[0].env["QH_TEAM_MCP_CONVERSATION_ID"] == "conv-main"
        assert servers[0].env["QH_TEAM_MCP_SESSION_ID"] == "conv-main"
        assert str(tmp_path / ".coworker" / "qh_orchestrator.db") == servers[0].env[
            "QH_TEAM_MCP_ORCHESTRATION_DB"
        ]
        assert manager._main_acp_mcp_servers(  # type: ignore[attr-defined]
            manager.orchestrator.get("fake-main"), "conv-review", str(tmp_path)
        )

        reviewer = manager.orchestrator.put(
            {
                "id": "reviewer",
                "role": "reviewer",
                "transport": "acp_stdio",
                "command": "fake",
                "permission_policy": "read-only",
            }
        )
        assert manager._main_acp_mcp_servers(reviewer, "conv-review", str(tmp_path)) == []  # type: ignore[attr-defined]
    finally:
        asyncio.run(manager.aclose())

    assert adapter.aclose_count == 1


def test_acp_websocket_turn_maps_events_and_rejects_concurrent_prompt(tmp_path):
    adapter = FakeMainAdapter()
    adapter.block_next_prompt = True
    manager = _manager(tmp_path, adapter)
    client = TestClient(create_app(manager))

    try:
        with client.websocket_connect(
            f"/ws/session/acp-ws?agent=code&runtime=acp&workspace={tmp_path}"
        ) as ws:
            ready = ws.receive_json()
            assert ready["type"] == "ready"
            assert ready["data"]["runtime"] == "acp"

            ws.send_json({"type": "user_message", "text": "first"})
            ws.send_json({"type": "user_message", "text": "second"})

            seen = []
            while "input_rejected" not in seen:
                seen.append(ws.receive_json()["type"])
            assert "turn_start" in seen
            assert adapter.release_prompt is not None
            adapter.release_prompt.set()

            while "turn_done" not in seen:
                seen.append(ws.receive_json()["type"])

        assert seen.count("assistant_delta") == 1
        assert seen.count("permission_required") == 1
        assert "assistant_message" in seen
        assert adapter.prompts == ["first"]
    finally:
        asyncio.run(manager.aclose())


def test_deliver_to_session_routes_existing_code_acp_conversation_to_host(tmp_path, monkeypatch):
    adapter = FakeMainAdapter()
    manager = _manager(tmp_path, adapter)
    delivered: list[tuple[str, str, str]] = []

    async def fake_deliver(conversation_id: str, message: str, **kwargs):
        delivered.append((conversation_id, message, kwargs.get("source_task_id")))
        return {"ok": True}

    try:
        asyncio.run(manager.main_acp_host.open("conv-deliver", tmp_path))
        monkeypatch.setattr(manager.main_acp_host, "deliver", fake_deliver)
        asyncio.run(
            manager.deliver_to_session(
                "conv-deliver", "worker says hi", source={"connector": "slack"}
            )
        )
    finally:
        asyncio.run(manager.aclose())

    assert delivered == [("conv-deliver", "worker says hi", "slack")]


def test_team_delivery_remains_pending_on_failure_and_reuses_delivery_id(
    tmp_path, monkeypatch
):
    adapter = FakeMainAdapter()
    manager = _manager(tmp_path, adapter)
    asyncio.run(manager.main_acp_host.open("conv-team", tmp_path))
    queued = manager.enqueue_agent_delivery(
        {
            "conversation_id": "conv-team",
            "target_session_id": "conv-team",
            "source_task_id": "task-1",
            "payload": {"summary": "worker finished"},
            "delivery_id": "delivery-stable",
        }
    )
    seen: list[str | None] = []

    async def fail_delivery(*_args, **kwargs):
        seen.append(kwargs.get("delivery_id"))
        raise RuntimeError("temporary failure")

    monkeypatch.setattr(manager.main_acp_host, "deliver", fail_delivery)
    assert asyncio.run(manager._drain_team_deliveries()) == 0
    assert queued["delivery_id"] == "delivery-stable"
    assert manager.orchestrator.pending_deliveries("conv-team")

    async def accept_delivery(*_args, **kwargs):
        seen.append(kwargs.get("delivery_id"))
        return {"ok": True, "state": "delivered", "delivered": True}

    monkeypatch.setattr(manager.main_acp_host, "deliver", accept_delivery)
    assert asyncio.run(manager._drain_team_deliveries()) == 1
    assert seen == [
        "main_session:delivery-stable",
        "main_session:delivery-stable",
    ]
    assert manager.orchestrator.pending_deliveries("conv-team") == []
    asyncio.run(manager.aclose())


def test_team_delivery_unknown_after_prompt_failure_is_never_acknowledged_or_replayed(
    tmp_path,
):
    adapter = FakeMainAdapter()
    manager = _manager(tmp_path, adapter)
    asyncio.run(manager.main_acp_host.open("conv-unknown", tmp_path))
    manager.enqueue_agent_delivery(
        {
            "conversation_id": "conv-unknown",
            "target_session_id": "conv-unknown",
            "source_task_id": "task-unknown",
            "payload": {"summary": "unknown outcome"},
            "delivery_id": "delivery-unknown",
        }
    )
    adapter.raise_next = RuntimeError("failed after ACP prompt started")

    assert asyncio.run(manager._drain_team_deliveries()) == 0
    assert len(adapter.prompts) == 1
    assert manager.orchestrator.pending_deliveries("conv-unknown")

    assert asyncio.run(manager._drain_team_deliveries()) == 0
    assert len(adapter.prompts) == 1
    assert manager.orchestrator.pending_deliveries("conv-unknown")
    asyncio.run(manager.aclose())


def test_team_delivery_reaches_main_host_once_with_shared_ledger(tmp_path):
    adapter = FakeMainAdapter()
    manager = _manager(tmp_path, adapter)
    asyncio.run(manager.main_acp_host.open("conv-shared-ledger", tmp_path))
    payload = {
        "conversation_id": "conv-shared-ledger",
        "target_session_id": "conv-shared-ledger",
        "source_task_id": "task-shared",
        "payload": {"summary": "shared ledger result"},
        "delivery_id": "delivery-shared",
    }
    manager.enqueue_agent_delivery(payload)

    assert asyncio.run(manager._drain_team_deliveries()) == 1
    assert len(adapter.prompts) == 1
    assert "shared ledger result" in adapter.prompts[0]
    assert manager.orchestrator.pending_deliveries("conv-shared-ledger") == []

    duplicate = manager.enqueue_agent_delivery(payload)
    assert duplicate["newly_enqueued"] is False
    assert asyncio.run(manager._drain_team_deliveries()) == 0
    assert len(adapter.prompts) == 1
    asyncio.run(manager.aclose())


def test_audio_transcript_memory_endpoint_accepts_text_and_rejects_audio_payload(tmp_path):
    manager = SessionManager(workspace=tmp_path)
    client = TestClient(create_app(manager))

    try:
        saved = client.post(
            "/v1/memory/audio-transcripts",
            json={"text": "transcribed words", "scope": "session", "session_id": "s1"},
        )
        assert saved.status_code == 200
        body = saved.json()
        assert body["ok"] is True
        assert body["key"].startswith("audio-transcript:")
        assert body["content"] == "transcribed words"
        assert manager.memory_store.list(scope="session", session_id="s1")[0].content == (
            "transcribed words"
        )

        rejected = client.post(
            "/v1/memory/audio-transcripts",
            json={
                "text": "data:audio/wav;base64,AAAA",
                "audio": "AAAA",
                "scope": "global",
            },
        )
        assert rejected.status_code == 400
        assert "audio transcript memory accepts text only" in rejected.text
    finally:
        asyncio.run(manager.aclose())


def test_acp_websocket_passes_profile_id_to_main_host(tmp_path, monkeypatch):
    adapter = FakeMainAdapter()
    manager = _manager(tmp_path, adapter)
    client = TestClient(create_app(manager))
    opened: list[dict[str, Any]] = []

    async def fake_open(conversation_id, workspace, profile_id=None):
        opened.append(
            {
                "conversation_id": conversation_id,
                "workspace": workspace,
                "profile_id": profile_id,
            }
        )
        return SimpleNamespace(
            session_id="agent-session-1", profile_id=profile_id or "fake-main"
        )

    monkeypatch.setattr(manager.main_acp_host, "open", fake_open)
    try:
        with client.websocket_connect(
            f"/ws/session/acp-profile?agent=code&runtime=acp&workspace={tmp_path}"
            "&profile_id=exec-chat"
        ) as ws:
            ready = ws.receive_json()
            assert ready["type"] == "ready"
            assert ready["data"]["runtime"] == "acp"
            assert ready["data"]["agent_session_id"] == "agent-session-1"
    finally:
        asyncio.run(manager.aclose())

    assert len(opened) == 1
    assert opened[0]["conversation_id"] == "acp-profile"
    assert opened[0]["profile_id"] == "exec-chat"


def test_acp_websocket_without_profile_id_passes_none(tmp_path, monkeypatch):
    adapter = FakeMainAdapter()
    manager = _manager(tmp_path, adapter)
    client = TestClient(create_app(manager))
    opened: list[dict[str, Any]] = []

    async def fake_open(conversation_id, workspace, profile_id=None):
        opened.append({"profile_id": profile_id})
        return SimpleNamespace(session_id="agent-session-1", profile_id="fake-main")

    monkeypatch.setattr(manager.main_acp_host, "open", fake_open)
    try:
        with client.websocket_connect(
            f"/ws/session/acp-default?agent=code&runtime=acp&workspace={tmp_path}"
        ) as ws:
            assert ws.receive_json()["type"] == "ready"
    finally:
        asyncio.run(manager.aclose())

    assert opened == [{"profile_id": None}]


def test_acp_websocket_invalid_profile_id_sends_error_event_and_closes(
    tmp_path, monkeypatch
):
    adapter = FakeMainAdapter()
    manager = _manager(tmp_path, adapter)
    client = TestClient(create_app(manager))

    async def fake_open(conversation_id, workspace, profile_id=None):
        raise ValueError(f"未找到 Agent 配置：{profile_id}")

    monkeypatch.setattr(manager.main_acp_host, "open", fake_open)
    try:
        with client.websocket_connect(
            f"/ws/session/acp-bad?agent=code&runtime=acp&workspace={tmp_path}"
            "&profile_id=nope"
        ) as ws:
            event = ws.receive_json()
            assert event["type"] == "error"
            assert event["data"]["error"] == "未找到 Agent 配置：nope"
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()
    finally:
        asyncio.run(manager.aclose())
