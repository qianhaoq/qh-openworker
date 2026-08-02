from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

import pytest

from coworker.acp import AcpAgentAdapter, AcpMcpServer, AcpSessionHandle, AcpTurnResult
from coworker.conversations import ConversationStore
from coworker.main_acp import MainAcpHost
from coworker.sessions import SessionRecord
from coworker.orchestration import AgentProfile
from coworker.orchestrator import QhOrchestratorStore


FIXTURE = Path(__file__).parent / "fixtures" / "fake_acp_agent.py"


class FakeMainAdapter:
    def __init__(self) -> None:
        self.open_calls: list[dict[str, Any]] = []
        self.prompts: list[str] = []
        self.closed: list[str] = []
        self.cancelled: list[str] = []
        self.next_session_id = "fake-main-session"
        self.prompt_started = asyncio.Event()
        self.release_prompt = asyncio.Event()
        self.block_next_prompt = False
        self.raise_next: Optional[Exception] = None

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
        session_id = existing_session_id or self.next_session_id
        return AcpSessionHandle(
            runtime_id=f"runtime-{len(self.open_calls)}",
            profile_id=profile.id,
            role=profile.role.value,
            session_id=session_id,
            cwd=str(cwd),
            capabilities={"fake": True},
            recovery_mode="resume" if existing_session_id else "new",
            process_id=None,
        )

    async def prompt(self, handle: AcpSessionHandle, message: str) -> AcpTurnResult:
        self.prompts.append(message)
        self.prompt_started.set()
        if self.raise_next is not None:
            exc = self.raise_next
            self.raise_next = None
            raise exc
        if self.block_next_prompt:
            self.block_next_prompt = False
            await self.release_prompt.wait()
        text = f"answer-{len(self.prompts)}"
        return AcpTurnResult(
            session_id=handle.session_id,
            stop_reason="end_turn",
            text=text,
            events=({"type": "fake.event", "text": text},),
        )

    async def cancel(self, handle: AcpSessionHandle) -> None:
        self.cancelled.append(handle.session_id)

    async def close(self, handle: AcpSessionHandle) -> None:
        self.closed.append(handle.session_id)

    async def aclose(self) -> None:
        return None


class MemoryItem:
    def __init__(
        self,
        item_id: int,
        content: str,
        *,
        scope: str,
        key: str | None = None,
        workspace: str | None = None,
        session_id: str | None = None,
    ) -> None:
        self.id = item_id
        self.content = content
        self.scope = scope
        self.key = key
        self.workspace = workspace
        self.session_id = session_id


class FakeMemoryStore:
    def __init__(self) -> None:
        self.items: list[MemoryItem] = []

    def add(
        self,
        content: str,
        *,
        scope: str = "workspace",
        key: str | None = None,
        workspace: str | None = None,
        session_id: str | None = None,
    ) -> MemoryItem:
        item = MemoryItem(
            len(self.items) + 1,
            content,
            scope=scope,
            key=key,
            workspace=workspace,
            session_id=session_id,
        )
        self.items.append(item)
        return item

    def list(
        self,
        *,
        scope: str | None = None,
        workspace: str | None = None,
        session_id: str | None = None,
    ) -> list[MemoryItem]:
        return [
            item
            for item in self.items
            if (scope is None or item.scope == scope)
            and (workspace is None or item.workspace == workspace)
            and (session_id is None or item.session_id == session_id)
        ]

    def close(self) -> None:
        return None


def _stores(tmp_path):
    orchestrator = QhOrchestratorStore(tmp_path / "orchestration.db")
    profile = _register_profile(
        orchestrator,
        {
            "id": "test-main",
            "role": "main",
            "transport": "acp_stdio",
            "command": sys.executable,
            "args": [str(FIXTURE)],
            "model_profile": "fake-model",
            "limits": {"timeout_seconds": 5},
        },
    )
    orchestrator.set_workspace_main(tmp_path, profile.id)
    conversations = ConversationStore(tmp_path / "conversations")
    memory = FakeMemoryStore()
    return orchestrator, conversations, memory


def _register_profile(orchestrator: QhOrchestratorStore, payload: dict[str, Any]):
    profile = orchestrator.put(payload)
    profile = orchestrator.save_capabilities(profile.id, {"fake": True})
    profile.enabled = True
    return orchestrator.put(profile)


@pytest.mark.asyncio
async def test_main_host_works_with_real_fake_acp_and_multiple_turns(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    profile = _register_profile(
        orchestrator,
        {
            "id": "fake-main",
            "role": "main",
            "transport": "acp_stdio",
            "command": sys.executable,
            "args": [str(FIXTURE)],
            "model_profile": "fake-model",
            "limits": {"timeout_seconds": 5},
        }
    )
    orchestrator.set_workspace_main(tmp_path, profile.id)
    updates = []
    adapter = AcpAgentAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,
        update_sink=updates.append,
    )
    adapter.update_sink = host.handle_update

    try:
        first = await host.prompt("conv-real", "first", workspace=tmp_path)
        second = await host.prompt("conv-real", "second")
        record = conversations.load("conv-real")
    finally:
        await host.aclose()
        orchestrator.close()
        conversations.close()
        memory.close()

    assert "turn=1;text=first" in first.text
    assert "turn=2;text=second" in second.text
    assert first.agent_session_id == second.agent_session_id == "fake-session"
    assert record is not None
    assert record.agent == "code"
    assert record.model == "fake-model"
    assert record.mode == "interactive"
    assert [message["role"] for message in record.messages] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert any(update["type"] == "assistant_delta" for update in updates)


@pytest.mark.asyncio
async def test_open_reuses_main_session_binding_after_restart(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )
    await host.prompt("conv-restart", "hello", workspace=tmp_path)
    await host.close("conv-restart")

    restarted = FakeMainAdapter()
    host2 = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=restarted,  # type: ignore[arg-type]
    )
    await host2.open("conv-restart", tmp_path)

    assert restarted.open_calls[0]["existing_session_id"] == "fake-main-session"
    checkpoint = restarted.open_calls[0]["checkpoint"]
    assert checkpoint["conversation_id"] == "conv-restart"
    assert checkpoint["recent_transcript"]
    await host2.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_open_reuses_live_runtime_and_reopens_on_workspace_or_profile_change(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )
    first = await host.open("conv-open", tmp_path)
    second = await host.open("conv-open", tmp_path)
    assert first == second
    assert len(adapter.open_calls) == 1
    assert adapter.closed == []

    other_workspace = tmp_path / "other-workspace"
    other_workspace.mkdir()
    main_profile = orchestrator.get_workspace_main(tmp_path)
    orchestrator.set_workspace_main(other_workspace, main_profile.id)
    await host.open("conv-open", other_workspace)
    assert len(adapter.open_calls) == 2
    assert adapter.closed == ["fake-main-session"]

    profile = _register_profile(
        orchestrator,
        {
            "id": "other-main",
            "role": "main",
            "transport": "acp_stdio",
            "command": "fake",
        }
    )
    orchestrator.set_workspace_main(other_workspace, profile.id)
    await host.open("conv-open", other_workspace)
    assert len(adapter.open_calls) == 3
    assert len(adapter.closed) == 2
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_scoped_context_filters_global_workspace_and_session_only(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    other_workspace = tmp_path / "other"
    other_workspace.mkdir()
    memory.add("alpha global fact", scope="global")
    memory.add("beta global fact", scope="global")
    memory.add("alpha workspace fact", scope="workspace", workspace=str(tmp_path.resolve()))
    memory.add("alpha other workspace", scope="workspace", workspace=str(other_workspace.resolve()))
    memory.add("alpha session fact", scope="session", session_id="conv-scope")
    memory.add("alpha other session", scope="session", session_id="conv-other")
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )

    await host.prompt("conv-scope", "question", workspace=tmp_path, query="alpha")
    outbound = adapter.prompts[0]

    assert "<host-context>" in outbound
    assert "alpha global fact" in outbound
    assert "alpha workspace fact" in outbound
    assert "alpha session fact" in outbound
    assert "beta global fact" not in outbound
    assert "alpha other workspace" not in outbound
    assert "alpha other session" not in outbound
    assert "<user-prompt>\nquestion\n</user-prompt>" in outbound
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_busy_delivery_is_fifo_durable_and_idempotent(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    adapter = FakeMainAdapter()
    adapter.block_next_prompt = True
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )

    task = asyncio.create_task(host.prompt("conv-delivery", "main", workspace=tmp_path))
    await asyncio.wait_for(adapter.prompt_started.wait(), timeout=1)
    first = await host.deliver(
        "conv-delivery",
        "worker result",
        source_task_id="task-1",
        delivery_id="delivery-1",
    )
    duplicate = await host.deliver(
        "conv-delivery",
        "worker result",
        source_task_id="task-1",
        delivery_id="delivery-1",
    )
    assert first["newly_enqueued"] is True
    assert duplicate["newly_enqueued"] is False
    assert len(adapter.prompts) == 1

    adapter.release_prompt.set()
    result = await asyncio.wait_for(task, timeout=2)

    assert result.delivery_ids == ("delivery-1",)
    assert len(adapter.prompts) == 2
    assert adapter.prompts[0].endswith("<user-prompt>\nmain\n</user-prompt>") or adapter.prompts[0] == "main"
    assert "worker result" in adapter.prompts[1]
    await host.drain_deliveries("conv-delivery")
    assert len(adapter.prompts) == 2
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_idle_delivery_reopens_bound_main_session_after_host_restart(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    first_adapter = FakeMainAdapter()
    first_host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=first_adapter,  # type: ignore[arg-type]
    )
    await first_host.open("conv-background", tmp_path)
    await first_host.close("conv-background")

    restarted_adapter = FakeMainAdapter()
    restarted_host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=restarted_adapter,  # type: ignore[arg-type]
    )
    result = await restarted_host.deliver(
        "conv-background",
        "background worker result",
        source_task_id="task-background",
        delivery_id="delivery-background",
    )

    assert result["newly_enqueued"] is True
    assert restarted_adapter.open_calls[0]["existing_session_id"] == "fake-main-session"
    assert len(restarted_adapter.prompts) == 1
    assert "background worker result" in restarted_adapter.prompts[0]
    events = orchestrator.store.list_events(
        aggregate_type="main_session", aggregate_id="conv-background"
    )
    assert any(event.event_id == "delivery-background:delivered" for event in events)
    await restarted_host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_delivery_prompting_guard_prevents_replay_duplicate_after_failure(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )
    await host.open("conv-replay", tmp_path)
    await host.deliver(
        "conv-replay",
        "worker result",
        source_task_id="task-1",
        delivery_id="delivery-replay",
        drain_if_idle=False,
    )
    adapter.raise_next = RuntimeError("delivery failed after prompting")
    with pytest.raises(RuntimeError, match="delivery failed"):
        await host.drain_deliveries("conv-replay")
    assert len(adapter.prompts) == 1

    restarted = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )
    await restarted.open("conv-replay", tmp_path)
    await restarted.drain_deliveries("conv-replay")
    outcome = await restarted.deliver(
        "conv-replay",
        "worker result",
        source_task_id="task-1",
        delivery_id="delivery-replay",
    )
    assert outcome["state"] == "unknown"
    assert outcome["delivered"] is False
    assert len(adapter.prompts) == 1
    events = orchestrator.store.list_events(
        aggregate_type="main_session", aggregate_id="conv-replay"
    )
    assert any(event.event_id == "delivery-replay:prompting" for event in events)
    assert not any(event.event_id == "delivery-replay:delivered" for event in events)
    await restarted.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_transcript_append_preserves_existing_session_metadata(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    conversations.save(
        SessionRecord(
            session_id="conv-meta",
            workspace=str(tmp_path.resolve()),
            model="old-model",
            mode="interactive",
            agent="code",
            title="Existing",
            messages=[{"role": "user", "content": "existing"}],
            extra_roots=[{"path": "/tmp/extra", "writable": False, "label": "extra"}],
            grants={"tools": ["safe"]},
            compaction={"summary": "compact"},
        )
    )
    conversations.set_flags("conv-meta", pinned=True, archived=True)
    conversations.set_origin("conv-meta", "test", "Test Origin")
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )

    await host.prompt("conv-meta", "new turn", workspace=tmp_path)
    record = conversations.load("conv-meta")

    assert record is not None
    assert record.title == "Existing"
    assert record.extra_roots == [{"path": "/tmp/extra", "writable": False, "label": "extra"}]
    assert record.grants == {"tools": ["safe"]}
    assert record.compaction == {"summary": "compact"}
    assert record.pinned is True
    assert record.archived is True
    assert record.origin == "test"
    assert record.origin_label == "Test Origin"
    assert [message["content"] for message in record.messages] == [
        "existing",
        "new turn",
        "answer-1",
    ]
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_update_mapping_and_prompt_exception_transcript(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    adapter = FakeMainAdapter()
    updates = []
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
        update_sink=updates.append,
    )

    mapped = await host.handle_update(
        {
            "type": "acp.session_update",
            "profile_id": "p",
            "session_id": "s",
            "text": "delta",
        }
    )
    permission = await host.handle_update(
        {
            "type": "acp.permission_requested",
            "profile_id": "p",
            "session_id": "s",
            "role": "main",
            "tool_call": {"kind": "edit"},
            "options": [{"kind": "allow_once"}],
        }
    )
    assert mapped and mapped["type"] == "assistant_delta"
    assert permission and permission["type"] == "permission_required"
    assert [item["type"] for item in updates] == ["assistant_delta", "permission_required"]

    adapter.raise_next = RuntimeError("boom")
    with pytest.raises(RuntimeError, match="boom"):
        await host.prompt("conv-error", "fail", workspace=tmp_path)
    record = conversations.load("conv-error")
    assert record is not None
    assert record.messages[-1]["role"] == "assistant"
    assert "Agent error: RuntimeError: boom" in record.messages[-1]["content"]
    events = orchestrator.store.list_events(
        aggregate_type="main_session", aggregate_id="conv-error"
    )
    assert any(event.event_type == "main_session.error" for event in events)
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_open_with_unknown_profile_id_raises(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )

    with pytest.raises(ValueError, match="未找到 Agent 配置：no-such-profile"):
        await host.open("conv-unknown", tmp_path, profile_id="no-such-profile")

    assert adapter.open_calls == []
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_open_with_disabled_profile_raises(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    orchestrator.put(
        {
            "id": "disabled-chat",
            "role": "executor",
            "transport": "acp_stdio",
            "command": "fake",
        }
    )
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )

    with pytest.raises(ValueError, match="Agent 配置未启用：disabled-chat"):
        await host.open("conv-disabled", tmp_path, profile_id="disabled-chat")

    assert adapter.open_calls == []
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_open_with_unprobed_profile_raises(tmp_path, monkeypatch):
    orchestrator, conversations, memory = _stores(tmp_path)
    # The store auto-disables stale profiles on read, so an enabled-but-unprobed
    # profile can only surface through the facade — stub it to cover the check.
    unprobed = AgentProfile(
        id="unprobed-chat",
        role="executor",
        transport="acp_stdio",
        command="fake",
        enabled=True,
        capabilities={},
        capability_probe_fingerprint=None,
    )
    monkeypatch.setattr(orchestrator, "get", lambda profile_id: unprobed)
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )

    with pytest.raises(ValueError, match="能力探测"):
        await host.open("conv-unprobed", tmp_path, profile_id="unprobed-chat")

    assert adapter.open_calls == []
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_open_with_explicit_non_main_profile_chats_without_team_tools(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    _register_profile(
        orchestrator,
        {
            "id": "exec-chat",
            "role": "executor",
            "transport": "acp_stdio",
            "command": "fake",
        },
    )
    team_server = AcpMcpServer(name="qh-team", command="fake-team-mcp")
    factory_calls: list[str] = []

    def factory(profile, conversation_id, workspace):
        factory_calls.append(profile.id)
        return [team_server]

    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
        mcp_servers_factory=factory,
    )

    handle = await host.open("conv-exec", tmp_path, profile_id="exec-chat")

    assert handle.profile_id == "exec-chat"
    assert handle.role == "executor"
    assert factory_calls == []  # non-main profiles never get delegation tools
    assert adapter.open_calls[0]["mcp_servers"] == []
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_open_with_explicit_main_profile_keeps_team_tools(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    _register_profile(
        orchestrator,
        {
            "id": "alt-main",
            "role": "main",
            "transport": "acp_stdio",
            "command": "fake",
        },
    )
    team_server = AcpMcpServer(name="qh-team", command="fake-team-mcp")
    factory_calls: list[str] = []

    def factory(profile, conversation_id, workspace):
        factory_calls.append(profile.id)
        return [team_server]

    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
        mcp_servers_factory=factory,
    )

    handle = await host.open("conv-alt-main", tmp_path, profile_id="alt-main")

    assert handle.profile_id == "alt-main"
    assert factory_calls == ["alt-main"]
    assert adapter.open_calls[0]["mcp_servers"] == [team_server]
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()


@pytest.mark.asyncio
async def test_open_switching_profiles_rebinds_runtime(tmp_path):
    orchestrator, conversations, memory = _stores(tmp_path)
    for profile_id in ("chat-a", "chat-b"):
        _register_profile(
            orchestrator,
            {
                "id": profile_id,
                "role": "executor",
                "transport": "acp_stdio",
                "command": "fake",
            },
        )
    adapter = FakeMainAdapter()
    host = MainAcpHost(
        orchestrator=orchestrator,
        conversations=conversations,
        memory=memory,
        acp_adapter=adapter,  # type: ignore[arg-type]
    )

    first = await host.open("conv-switch", tmp_path, profile_id="chat-a")
    again = await host.open("conv-switch", tmp_path, profile_id="chat-a")
    assert again is first  # same profile + workspace reuses the live runtime
    assert len(adapter.open_calls) == 1
    assert adapter.closed == []

    adapter.next_session_id = "fake-session-b"
    second = await host.open("conv-switch", tmp_path, profile_id="chat-b")

    assert second.profile_id == "chat-b"
    assert second.session_id == "fake-session-b"
    assert adapter.closed == ["fake-main-session"]  # old runtime closed on switch
    assert len(adapter.open_calls) == 2
    assert adapter.open_calls[1]["profile_id"] == "chat-b"
    assert adapter.open_calls[1]["existing_session_id"] is None
    assert host._runtimes["conv-switch"].profile.id == "chat-b"
    await host.aclose()
    orchestrator.close()
    conversations.close()
    memory.close()
