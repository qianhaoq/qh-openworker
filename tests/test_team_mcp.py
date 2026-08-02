from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from coworker.orchestrator import QhOrchestratorStore
from coworker.team_mcp import (
    CONVERSATION_ENV,
    DB_ENV,
    SESSION_ENV,
    build_team_mcp_server,
)


pytest.importorskip("mcp")


def _server_params(db_path: Path, *, conversation_id: str = "conv-1", session_id: str = "sess-1"):
    from mcp.client.stdio import StdioServerParameters

    env = os.environ.copy()
    env[DB_ENV] = str(db_path)
    env[CONVERSATION_ENV] = conversation_id
    env[SESSION_ENV] = session_id
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "coworker.team_mcp"],
        env=env,
        cwd=Path(__file__).resolve().parents[1],
    )


def test_build_team_mcp_server_uses_only_db_and_context_env(tmp_path):
    server = build_team_mcp_server(
        tmp_path / "team.db",
        conversation_id="conv-42",
        session_id="sess-42",
    )
    assert server is not None
    assert server.command == sys.executable
    assert list(server.args) == ["-m", "coworker.team_mcp"]
    assert server.env == {
        DB_ENV: str(tmp_path / "team.db"),
        CONVERSATION_ENV: "conv-42",
        SESSION_ENV: "sess-42",
    }

    assert (
        build_team_mcp_server(
            tmp_path / "team.db",
            role="reviewer",
        )
        is None
    )


@pytest.mark.asyncio
async def test_team_mcp_stdio_tools_delegate_and_persist(tmp_path):
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    db_path = tmp_path / "team.db"
    params = _server_params(db_path)

    async with stdio_client(params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            tools = await session.list_tools()
            tool_names = {tool.name for tool in tools.tools}
            assert tool_names == {
                "team.delegate",
                "team.status",
                "team.result",
                "team.message",
                "team.cancel",
                "review.request",
            }

            delegated = await session.call_tool(
                "team.delegate",
                {
                    "task_spec": {
                        "prompt": "implement the feature",
                        "title": "Implement feature",
                    },
                },
            )
            assert delegated.isError is False
            payload = delegated.structuredContent or json.loads(delegated.content[0].text)
            assert payload["ok"] is True
            assert payload["state"] == "QUEUED"
            task_id = payload["task_id"]
            assert payload["task_spec"]["_orchestration"]["target_session_id"] == "sess-1"

            status = await session.call_tool("team.status", {"task_id": task_id})
            status_payload = status.structuredContent or json.loads(status.content[0].text)
            assert status_payload["ok"] is True
            assert status_payload["state"] == "QUEUED"

            message = await session.call_tool(
                "team.message",
                {
                    "task_id": task_id,
                    "message": "please continue",
                    "idempotency_key": "continue-1",
                },
            )
            message_payload = message.structuredContent or json.loads(message.content[0].text)
            assert message_payload["ok"] is True
            assert "message_id" in message_payload

            cancelled = await session.call_tool("team.cancel", {"task_id": task_id})
            cancel_payload = cancelled.structuredContent or json.loads(cancelled.content[0].text)
            assert cancel_payload["ok"] is True
            assert cancel_payload["state"] == "CANCELLED"

    store = QhOrchestratorStore(db_path)
    task = store.store.get_task(task_id)
    assert task is not None
    assert task.status.value == "CANCELLED"
    assert task.task_spec["_orchestration"]["target_session_id"] == "sess-1"
    assert store.pending_messages(task_id)


@pytest.mark.asyncio
async def test_review_request_tool_moves_existing_task_into_review(tmp_path):
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    db_path = tmp_path / "team.db"
    store = QhOrchestratorStore(db_path)
    task = store.delegate({"prompt": "review me", "title": "Review me"})
    task_id = task["task_id"]
    store.start_attempt(task_id, profile_id="opencode-executor", role="executor")
    store.set_task_state(task_id, "IMPLEMENTING")
    artifact = store.add_artifact(
        task_id,
        kind="patch",
        path="artifact://patches/1",
        payload={"diff": "diff --git a/file b/file"},
    )
    store.set_task_state(task_id, "VERIFYING")

    params = _server_params(db_path)
    async with stdio_client(params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()
            result = await session.call_tool(
                "review.request",
                {
                    "artifact_id": artifact["artifact_id"],
                    "reviewer_profile_id": "opencode-reviewer",
                },
            )
            payload = result.structuredContent or json.loads(result.content[0].text)
            assert payload["ok"] is True
            assert payload["state"] == "REVIEWING"
            assert payload["artifact_id"] == artifact["artifact_id"]

    refreshed = QhOrchestratorStore(db_path)
    assert refreshed.status(task_id)["state"] == "REVIEWING"
