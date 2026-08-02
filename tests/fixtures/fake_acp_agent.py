"""Small ACP agent used by the adapter contract tests.

It deliberately exercises the published SDK on both sides of the stdio connection so
the tests catch wire-model and method-signature drift, rather than mocking our adapter's
connection object.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from acp import PROTOCOL_VERSION, run_agent, update_agent_message_text
from acp.schema import (
    AgentCapabilities,
    AllowedOutcome,
    ClientCapabilities,
    DeniedOutcome,
    Implementation,
    InitializeResponse,
    LoadSessionResponse,
    NewSessionResponse,
    PermissionOption,
    PromptResponse,
    ResumeSessionResponse,
    SessionCapabilities,
    SessionCloseCapabilities,
    SessionResumeCapabilities,
    ToolCallUpdate,
)


class FakeAgent:
    def __init__(self) -> None:
        self.client: Any = None
        self.turns: dict[str, int] = {}
        self.cancelled: dict[str, asyncio.Event] = {}

    def on_connect(self, client: Any) -> None:
        self.client = client

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: ClientCapabilities | None = None,
        client_info: Implementation | None = None,
        **_: Any,
    ) -> InitializeResponse:
        return InitializeResponse(
            protocolVersion=PROTOCOL_VERSION,
            agentCapabilities=AgentCapabilities(
                loadSession=True,
                sessionCapabilities=SessionCapabilities(
                    resume=SessionResumeCapabilities(),
                    close=SessionCloseCapabilities(),
                ),
            ),
            agentInfo=Implementation(name="fake-acp", version="1.0.0"),
        )

    async def new_session(
        self,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[Any] | None = None,
        **_: Any,
    ) -> NewSessionResponse:
        session_id = "fake-session"
        self.turns.setdefault(session_id, 0)
        self.cancelled.setdefault(session_id, asyncio.Event())
        return NewSessionResponse(sessionId=session_id)

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[Any] | None = None,
        **_: Any,
    ) -> ResumeSessionResponse:
        if os.environ.get("FAKE_ACP_DISABLE_RESUME") == "1":
            raise RuntimeError("resume disabled by fixture")
        self.turns.setdefault(session_id, 0)
        self.cancelled.setdefault(session_id, asyncio.Event())
        return ResumeSessionResponse()

    async def load_session(
        self,
        cwd: str,
        session_id: str,
        mcp_servers: list[Any] | None = None,
        additional_directories: list[str] | None = None,
        **_: Any,
    ) -> LoadSessionResponse:
        if os.environ.get("FAKE_ACP_DISABLE_LOAD") == "1":
            raise RuntimeError("load disabled by fixture")
        self.turns.setdefault(session_id, 0)
        self.cancelled.setdefault(session_id, asyncio.Event())
        return LoadSessionResponse()

    async def prompt(self, session_id: str, prompt: list[Any], **_: Any) -> PromptResponse:
        text = "".join(getattr(block, "text", "") for block in prompt)
        if text == "slow":
            await self.cancelled.setdefault(session_id, asyncio.Event()).wait()
            return PromptResponse(stopReason="cancelled")

        permission = "none"
        if text == "permission":
            response = await self.client.request_permission(
                session_id=session_id,
                tool_call=ToolCallUpdate(
                    toolCallId="edit-1",
                    title="Edit a file",
                    kind="edit",
                    rawInput={"path": "example.py", "content": "changed"},
                ),
                options=[
                    PermissionOption(
                        optionId="allow-once", name="Allow once", kind="allow_once"
                    ),
                    PermissionOption(
                        optionId="reject-once", name="Reject", kind="reject_once"
                    ),
                ],
            )
            outcome = response.outcome
            if isinstance(outcome, AllowedOutcome):
                permission = outcome.option_id
            elif isinstance(outcome, DeniedOutcome):
                permission = "cancelled"

        self.turns[session_id] = self.turns.get(session_id, 0) + 1
        answer = f"turn={self.turns[session_id]};text={text};permission={permission}"
        await self.client.session_update(
            session_id=session_id,
            update=update_agent_message_text(answer),
        )
        return PromptResponse(stopReason="end_turn")

    async def cancel(self, session_id: str, **_: Any) -> None:
        self.cancelled.setdefault(session_id, asyncio.Event()).set()

    async def close_session(self, session_id: str, **_: Any) -> None:
        return None

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {}

    async def ext_notification(self, method: str, params: dict[str, Any]) -> None:
        return None


if __name__ == "__main__":
    asyncio.run(run_agent(FakeAgent(), use_unstable_protocol=True))
