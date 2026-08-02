"""ACP-first main-agent session host.

This module is intentionally independent from the FastAPI/desktop manager.  It owns the
interactive "main agent" lifecycle for one UI conversation, persists the ACP binding in the
orchestration ledger, injects scoped host context, and drains async worker deliveries without
allowing concurrent prompts into the same agent session.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from enum import Enum
from typing import Any, Awaitable, Callable, Mapping, Optional, Protocol, Sequence

from .acp import (
    AcpAgentAdapter,
    AcpMcpServer,
    AcpProcessExited,
    AcpSessionHandle,
    AcpTurnResult,
    PiJsonlRpcAdapter,
)
from .conversations import ConversationStore
from .orchestration import AgentProfile, AgentRole, LedgerEvent, Transport
from .orchestrator import QhOrchestratorStore
from .sessions import SessionRecord

NormalizedEvent = dict[str, Any]
UpdateSink = Callable[[NormalizedEvent], Awaitable[None] | None]
McpServersFactory = Callable[
    [AgentProfile, str, str], Sequence[AcpMcpServer]
]


class MemoryStoreLike(Protocol):
    def list(
        self,
        *,
        scope: Any = None,
        workspace: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> list[Any]: ...


class MainAgentAdapter(Protocol):
    async def open_session(
        self,
        profile: AgentProfile,
        *,
        cwd: str | Path,
        existing_session_id: Optional[str] = None,
        checkpoint: Optional[str | Mapping[str, Any]] = None,
        mcp_servers: Sequence[AcpMcpServer] = (),
    ) -> AcpSessionHandle: ...

    async def prompt(self, handle: AcpSessionHandle, message: str) -> AcpTurnResult: ...

    async def cancel(self, handle: AcpSessionHandle) -> None: ...

    async def close(self, handle: AcpSessionHandle) -> None: ...

    async def aclose(self) -> None: ...


@dataclass(slots=True)
class MainTurnResult:
    conversation_id: str
    agent_session_id: str
    profile_id: str
    text: str
    stop_reason: str
    events: tuple[NormalizedEvent, ...] = ()
    delivery_ids: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "agent_session_id": self.agent_session_id,
            "profile_id": self.profile_id,
            "text": self.text,
            "stop_reason": self.stop_reason,
            "events": list(self.events),
            "delivery_ids": list(self.delivery_ids),
        }


@dataclass(slots=True)
class _MainRuntime:
    conversation_id: str
    workspace: str
    profile: AgentProfile
    adapter: Any
    handle: AcpSessionHandle
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    draining: bool = False
    closed: bool = False


class MainAcpHost:
    """Durable, serial main-agent host for qh-openworker conversations."""

    def __init__(
        self,
        *,
        orchestrator: QhOrchestratorStore,
        conversations: ConversationStore,
        memory: Optional[MemoryStoreLike] = None,
        acp_adapter: Optional[AcpAgentAdapter] = None,
        pi_adapter: Optional[PiJsonlRpcAdapter] = None,
        mcp_servers_factory: Optional[McpServersFactory] = None,
        update_sink: Optional[UpdateSink] = None,
        max_context_items: int = 20,
        max_context_chars: int = 8000,
    ) -> None:
        self.orchestrator = orchestrator
        self.conversations = conversations
        self.memory = memory
        self.acp_adapter = acp_adapter or AcpAgentAdapter(update_sink=self.handle_update)
        self.pi_adapter = pi_adapter or PiJsonlRpcAdapter(update_sink=self.handle_update)
        self.mcp_servers_factory = mcp_servers_factory
        self.update_sink = update_sink
        self.max_context_items = max_context_items
        self.max_context_chars = max_context_chars
        self._runtimes: dict[str, _MainRuntime] = {}
        self.mapped_updates: list[NormalizedEvent] = []

    async def open(
        self,
        conversation_id: str,
        workspace: str | Path,
        profile_id: str | None = None,
    ) -> AcpSessionHandle:
        conversation_id = _clean_id(conversation_id, "conversation_id")
        workspace_path = _workspace(workspace)
        profile = self._resolve_chat_profile(workspace_path, profile_id)
        current = self._runtimes.get(conversation_id)
        if current is not None:
            if current.workspace == workspace_path and current.profile.id == profile.id:
                return current.handle
            await self.close(conversation_id)

        existing = self._latest_binding(conversation_id, workspace_path)
        existing_session_id = (
            existing.get("agent_session_id")
            if existing
            and existing.get("profile_id") == profile.id
            and existing.get("workspace") == workspace_path
            else None
        )
        adapter = self._adapter_for(profile)
        checkpoint = self._checkpoint(conversation_id, workspace_path, profile)
        if profile.transport == Transport.ACP_STDIO:
            # Team MCP (delegation) tools are main-role only: an explicitly selected
            # non-main profile chats without them. The workspace-main path is always
            # role=main, so behavior there is unchanged.
            mcp_servers = (
                list(self.mcp_servers_factory(profile, conversation_id, workspace_path))
                if self.mcp_servers_factory and profile.role == AgentRole.MAIN
                else []
            )
            handle = await adapter.open_session(
                profile,
                cwd=workspace_path,
                existing_session_id=existing_session_id,
                checkpoint=checkpoint,
                mcp_servers=mcp_servers,
            )
        elif profile.transport == Transport.JSONL_RPC:
            handle = await adapter.open_session(
                profile,
                cwd=workspace_path,
                existing_session_id=existing_session_id,
            )
        else:
            raise ValueError(f"unsupported main agent transport: {profile.transport.value}")

        self.orchestrator.save_agent_session(
            session_id=handle.session_id,
            conversation_id=conversation_id,
            profile_id=profile.id,
            status="active",
            capabilities=handle.capabilities,
            metadata={
                "workspace": workspace_path,
                "role": profile.role.value,
                "transport": profile.transport.value,
                "recovery_mode": handle.recovery_mode,
            },
        )
        self._append_binding(conversation_id, workspace_path, profile, handle)
        runtime = _MainRuntime(
            conversation_id=conversation_id,
            workspace=workspace_path,
            profile=profile,
            adapter=adapter,
            handle=handle,
        )
        self._runtimes[conversation_id] = runtime
        return handle

    async def prompt(
        self,
        conversation_id: str,
        text: str,
        *,
        workspace: Optional[str | Path] = None,
        query: Optional[str] = None,
        _from_delivery: bool = False,
    ) -> MainTurnResult:
        conversation_id = _clean_id(conversation_id, "conversation_id")
        clean_text = str(text or "").strip()
        if not clean_text:
            raise ValueError("prompt text is required")
        runtime = await self._runtime(conversation_id, workspace)
        delivery_ids: list[str] = []
        async with runtime.lock:
            user_record = self._append_transcript(
                conversation_id,
                runtime,
                {"role": "user", "content": clean_text},
            )
            outbound = self._compose_prompt(
                conversation_id,
                runtime.workspace,
                clean_text,
                query=query,
            )
            try:
                result = await runtime.adapter.prompt(runtime.handle, outbound)
            except Exception as exc:
                notice = _error_notice(exc)
                self._append_transcript(
                    conversation_id,
                    runtime,
                    {"role": "assistant", "content": notice, "notice": True},
                    existing=user_record.messages,
                )
                self._append_event(
                    event_id=f"main_session:{conversation_id}:error:{uuid.uuid4().hex}",
                    event_type="main_session.error",
                    aggregate_id=conversation_id,
                    payload={
                        "profile_id": runtime.profile.id,
                        "agent_session_id": runtime.handle.session_id,
                        "error": notice,
                    },
                )
                raise
            assistant_text = result.text or ""
            self._append_transcript(
                conversation_id,
                runtime,
                {
                    "role": "assistant",
                    "content": assistant_text,
                    "stop_reason": result.stop_reason,
                },
            )
            turn = MainTurnResult(
                conversation_id=conversation_id,
                agent_session_id=runtime.handle.session_id,
                profile_id=runtime.profile.id,
                text=assistant_text,
                stop_reason=result.stop_reason,
                events=tuple(result.events),
            )
        if not _from_delivery:
            delivery_ids = await self.drain_deliveries(conversation_id)
            if delivery_ids:
                turn = MainTurnResult(
                    conversation_id=turn.conversation_id,
                    agent_session_id=turn.agent_session_id,
                    profile_id=turn.profile_id,
                    text=turn.text,
                    stop_reason=turn.stop_reason,
                    events=turn.events,
                    delivery_ids=tuple(delivery_ids),
                )
        return turn

    async def deliver(
        self,
        conversation_id: str,
        message: str,
        *,
        source_task_id: str = "host",
        delivery_id: Optional[str] = None,
        drain_if_idle: bool = True,
    ) -> dict[str, Any]:
        conversation_id = _clean_id(conversation_id, "conversation_id")
        text = str(message or "").strip()
        if not text:
            raise ValueError("delivery message is required")
        delivery_id = delivery_id or f"delivery_{uuid.uuid4().hex}"
        inserted = self._append_event(
            event_id=delivery_id,
            event_type="main_session.delivery.enqueued",
            aggregate_id=conversation_id,
            payload={
                "delivery_id": delivery_id,
                "conversation_id": conversation_id,
                "source_task_id": source_task_id,
                "message": text,
            },
        )
        if drain_if_idle:
            runtime = self._runtimes.get(conversation_id)
            if runtime is None:
                binding = self._latest_binding(conversation_id, None)
                workspace = str((binding or {}).get("workspace") or "").strip()
                if workspace:
                    await self.open(conversation_id, workspace)
                    runtime = self._runtimes.get(conversation_id)
            if runtime is not None and not runtime.lock.locked():
                await self.drain_deliveries(conversation_id)
        state = self._delivery_state(conversation_id, delivery_id)
        return {
            "ok": True,
            "conversation_id": conversation_id,
            "delivery_id": delivery_id,
            "newly_enqueued": inserted,
            "state": state,
            "delivered": state == "delivered",
        }

    async def drain_deliveries(self, conversation_id: str) -> list[str]:
        conversation_id = _clean_id(conversation_id, "conversation_id")
        runtime = self._runtimes.get(conversation_id)
        if runtime is None or runtime.draining:
            return []
        runtime.draining = True
        delivered: list[str] = []
        try:
            for item in self._pending_deliveries(conversation_id):
                delivery_id = str(item["delivery_id"])
                if not self._append_event(
                    event_id=f"{delivery_id}:prompting",
                    event_type="main_session.delivery.prompting",
                    aggregate_id=conversation_id,
                    payload={"delivery_id": delivery_id},
                ):
                    continue
                await self.prompt(
                    conversation_id,
                    str(item["message"]),
                    _from_delivery=True,
                )
                self._append_event(
                    event_id=f"{delivery_id}:delivered",
                    event_type="main_session.delivery.delivered",
                    aggregate_id=conversation_id,
                    payload={"delivery_id": delivery_id},
                )
                delivered.append(delivery_id)
        finally:
            runtime.draining = False
        return delivered

    async def cancel(self, conversation_id: str) -> None:
        runtime = self._runtimes.get(conversation_id)
        if runtime is not None:
            await runtime.adapter.cancel(runtime.handle)
            self._append_event(
                event_id=f"main_session:{conversation_id}:cancelled:{uuid.uuid4().hex}",
                event_type="main_session.cancelled",
                aggregate_id=conversation_id,
                payload={"agent_session_id": runtime.handle.session_id},
            )

    async def close(self, conversation_id: str) -> None:
        runtime = self._runtimes.pop(conversation_id, None)
        if runtime is None or runtime.closed:
            return
        runtime.closed = True
        await runtime.adapter.close(runtime.handle)
        self.orchestrator.save_agent_session(
            session_id=runtime.handle.session_id,
            conversation_id=conversation_id,
            profile_id=runtime.profile.id,
            status="closed",
            capabilities=runtime.handle.capabilities,
            metadata={"workspace": runtime.workspace},
        )

    async def aclose(self) -> None:
        conversations = list(self._runtimes)
        await asyncio.gather(
            *(self.close(conversation_id) for conversation_id in conversations),
            return_exceptions=True,
        )
        with contextlib.suppress(Exception):
            await self.acp_adapter.aclose()
        with contextlib.suppress(Exception):
            await self.pi_adapter.aclose()

    async def handle_update(self, event: NormalizedEvent) -> Optional[NormalizedEvent]:
        mapped: Optional[NormalizedEvent] = None
        event_type = str(event.get("type") or "")
        text = event.get("text")
        if text is not None and event_type in {
            "acp.session_update",
            "pi_rpc.message_update",
        }:
            mapped = {
                "type": "assistant_delta",
                "profile_id": event.get("profile_id"),
                "agent_session_id": event.get("session_id"),
                "text": str(text),
                "source": event_type,
            }
        elif event_type == "acp.permission_requested":
            mapped = {
                "type": "permission_required",
                "profile_id": event.get("profile_id"),
                "agent_session_id": event.get("session_id"),
                "role": event.get("role"),
                "tool_call": event.get("tool_call"),
                "options": event.get("options") or [],
                "source": event_type,
            }
        if mapped is not None:
            self.mapped_updates.append(mapped)
            await _emit(self.update_sink, mapped)
        return mapped

    async def _runtime(
        self, conversation_id: str, workspace: Optional[str | Path]
    ) -> _MainRuntime:
        runtime = self._runtimes.get(conversation_id)
        if runtime is not None:
            return runtime
        if workspace is None:
            binding = self._latest_binding(conversation_id, None)
            if not binding or not binding.get("workspace"):
                raise KeyError(
                    f"conversation has no open main agent session: {conversation_id}"
                )
            workspace = str(binding["workspace"])
        await self.open(conversation_id, workspace)
        return self._runtimes[conversation_id]

    def _resolve_chat_profile(
        self, workspace_path: str, profile_id: str | None
    ) -> AgentProfile:
        """Resolve the profile that will serve as the chat agent for this session.

        ``profile_id=None`` keeps the original behavior: the workspace main profile,
        which must be role=main.  An explicit ``profile_id`` selects any profile as
        the chat agent (the role=main constraint is relaxed), but it must exist, be
        enabled, and carry a capability probe for the current runtime identity.
        """

        clean_profile_id = str(profile_id or "").strip()
        if not clean_profile_id:
            profile = self.orchestrator.get_workspace_main(workspace_path)
            if profile.role != AgentRole.MAIN:
                raise ValueError(
                    f"workspace main profile must have role=main: {profile.id}"
                )
            return profile
        profile = self.orchestrator.get(clean_profile_id)
        if profile is None:
            raise ValueError(f"未找到 Agent 配置：{clean_profile_id}")
        if not profile.enabled:
            raise ValueError(f"Agent 配置未启用：{clean_profile_id}")
        if not profile.has_current_capability_probe():
            raise ValueError(
                f"Agent 配置缺少当前版本的能力探测，请重新探测后再试：{clean_profile_id}"
            )
        return profile

    def _adapter_for(self, profile: AgentProfile) -> Any:
        if profile.transport == Transport.ACP_STDIO:
            return self.acp_adapter
        if profile.transport == Transport.JSONL_RPC:
            return self.pi_adapter
        raise ValueError(f"unsupported main agent transport: {profile.transport.value}")

    def _latest_binding(
        self, conversation_id: str, workspace: Optional[str]
    ) -> Optional[dict[str, Any]]:
        events = self.orchestrator.store.list_events(
            aggregate_type="main_session", aggregate_id=conversation_id
        )
        for event in reversed(events):
            if event.event_type != "main_session.bound":
                continue
            payload = dict(event.payload)
            if workspace is None or payload.get("workspace") == workspace:
                return payload
        return None

    def _append_binding(
        self,
        conversation_id: str,
        workspace: str,
        profile: AgentProfile,
        handle: AcpSessionHandle,
    ) -> None:
        self._append_event(
            event_id=(
                f"main_session:{conversation_id}:bound:{profile.id}:"
                f"{handle.session_id}:{workspace}"
            ),
            event_type="main_session.bound",
            aggregate_id=conversation_id,
            payload={
                "conversation_id": conversation_id,
                "workspace": workspace,
                "profile_id": profile.id,
                "agent_session_id": handle.session_id,
                "recovery_mode": handle.recovery_mode,
            },
        )

    def _append_event(
        self,
        *,
        event_id: str,
        event_type: str,
        aggregate_id: str,
        payload: Optional[dict[str, Any]] = None,
    ) -> bool:
        return self.orchestrator.store.append_event(
            LedgerEvent(
                event_id=event_id,
                event_type=event_type,
                aggregate_type="main_session",
                aggregate_id=aggregate_id,
                payload=payload or {},
            )
        )

    def _append_transcript(
        self,
        conversation_id: str,
        runtime: _MainRuntime,
        message: dict[str, Any],
        *,
        existing: Optional[list[dict[str, Any]]] = None,
    ) -> SessionRecord:
        record = self.conversations.load(conversation_id)
        messages = list(existing if existing is not None else (record.messages if record else []))
        messages.append(dict(message))
        saved = SessionRecord(
            session_id=conversation_id,
            workspace=runtime.workspace,
            model=runtime.profile.model_profile or runtime.profile.id,
            mode="interactive",
            agent="code",
            messages=messages,
            title=record.title if record else None,
            extra_roots=record.extra_roots if record else [],
            grants=record.grants if record else {},
            pinned=record.pinned if record else False,
            archived=record.archived if record else False,
            origin=record.origin if record else None,
            origin_label=record.origin_label if record else None,
            compaction=record.compaction if record else {},
        )
        self.conversations.save(saved)
        return saved

    def _compose_prompt(
        self,
        conversation_id: str,
        workspace: str,
        user_text: str,
        *,
        query: Optional[str],
    ) -> str:
        context = self._scoped_context(conversation_id, workspace, query=query or user_text)
        if not context:
            return user_text
        return f"{context}\n\n<user-prompt>\n{user_text}\n</user-prompt>"

    def _scoped_context(
        self, conversation_id: str, workspace: str, *, query: Optional[str]
    ) -> str:
        if self.memory is None:
            return ""
        items: list[Any] = []
        items.extend(self.memory.list(scope="global"))
        items.extend(self.memory.list(scope="workspace", workspace=workspace))
        items.extend(self.memory.list(scope="session", session_id=conversation_id))
        filtered = _filter_memories(items, query=query)
        if not filtered:
            return ""
        lines = [
            "<host-context>",
            "Allowed memory scopes: global, current workspace, current conversation session.",
        ]
        total = 0
        for item in filtered[: self.max_context_items]:
            line = (
                f"- scope={_scope_value(getattr(item, 'scope', ''))}"
                f"{' workspace=' + str(getattr(item, 'workspace', '')) if getattr(item, 'workspace', None) else ''}"
                f"{' session=' + str(getattr(item, 'session_id', '')) if getattr(item, 'session_id', None) else ''}"
                f" id={getattr(item, 'id', '')}: {getattr(item, 'content', '')}"
            )
            if total + len(line) > self.max_context_chars:
                break
            lines.append(line)
            total += len(line)
        lines.append("</host-context>")
        return "\n".join(lines) if len(lines) > 3 else ""

    def _checkpoint(
        self, conversation_id: str, workspace: str, profile: AgentProfile
    ) -> dict[str, Any]:
        record = self.conversations.load(conversation_id)
        recent = (record.messages if record else [])[-12:]
        bindings = [
            event.payload
            for event in self.orchestrator.store.list_events(
                aggregate_type="main_session", aggregate_id=conversation_id
            )
            if event.event_type == "main_session.bound"
        ][-5:]
        context = self._scoped_context(conversation_id, workspace, query=None)
        return {
            "conversation_id": conversation_id,
            "workspace": workspace,
            "profile_id": profile.id,
            "recent_transcript": recent,
            "main_session_bindings": bindings,
            "authorized_context": context,
        }

    def _pending_deliveries(self, conversation_id: str) -> list[dict[str, Any]]:
        events = self.orchestrator.store.list_events(
            aggregate_type="main_session", aggregate_id=conversation_id
        )
        suppressed = {
            str(event.payload.get("delivery_id"))
            for event in events
            if event.event_type
            in {
                "main_session.delivery.prompting",
                "main_session.delivery.delivered",
            }
        }
        return [
            dict(event.payload)
            for event in events
            if event.event_type == "main_session.delivery.enqueued"
            and str(event.payload.get("delivery_id")) not in suppressed
        ]

    def _delivery_state(self, conversation_id: str, delivery_id: str) -> str:
        """Return the durable outcome for one host delivery.

        ``prompting`` is intentionally an unknown outcome rather than success: the ACP
        prompt may have reached the Agent even when the host crashed before recording
        ``delivered``.  Callers must keep their upstream queue item pending instead of
        acknowledging it or automatically replaying a possibly duplicated prompt.
        """

        event_types = {
            event.event_type
            for event in self.orchestrator.store.list_events(
                aggregate_type="main_session", aggregate_id=conversation_id
            )
            if str(event.payload.get("delivery_id")) == delivery_id
        }
        if "main_session.delivery.delivered" in event_types:
            return "delivered"
        if "main_session.delivery.prompting" in event_types:
            return "unknown"
        if "main_session.delivery.enqueued" in event_types:
            return "pending"
        return "missing"


def _filter_memories(items: list[Any], *, query: Optional[str]) -> list[Any]:
    if not query:
        return items
    terms = [term.lower() for term in str(query).split() if len(term) >= 2]
    if not terms:
        return items
    return [
        item
        for item in items
        if any(
            term in str(getattr(item, "content", "")).lower()
            or term in str(getattr(item, "key", "") or "").lower()
            for term in terms
        )
    ]


def _scope_value(scope: Any) -> str:
    if isinstance(scope, Enum):
        return str(scope.value)
    return str(scope)


def _workspace(workspace: str | Path) -> str:
    return str(Path(workspace).expanduser().resolve())


def _clean_id(value: str, name: str) -> str:
    clean = str(value or "").strip()
    if not clean:
        raise ValueError(f"{name} is required")
    return clean


def _error_notice(exc: Exception) -> str:
    if isinstance(exc, AcpProcessExited):
        return f"Agent process exited: {exc}"
    return f"Agent error: {type(exc).__name__}: {exc}"


async def _emit(sink: Optional[UpdateSink], event: NormalizedEvent) -> None:
    if sink is None:
        return
    result = sink(event)
    if inspect.isawaitable(result):
        await result


def dumps_for_debug(value: Any) -> str:
    """Small helper used by tests and diagnostics without leaking binary/audio payloads."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


__all__ = ["MainAcpHost", "MainTurnResult", "dumps_for_debug"]
