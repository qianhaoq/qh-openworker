"""qh Team MCP stdio server.

This module exposes the small, host-controlled MCP surface used by the multi-agent
orchestrator. It intentionally keeps the server thin: all durable state lives in
``QhOrchestratorStore`` and tools are only the JSON-shaped control plane for that store.
"""

import os
import sys
from pathlib import Path
from typing import Any, Mapping

from mcp.server.fastmcp import FastMCP  # noqa: E402

from .acp.adapter import AcpMcpServer  # noqa: E402
from .orchestrator import QhOrchestratorStore  # noqa: E402
from .secrets import state_dir  # noqa: E402


DB_ENV = "QH_TEAM_MCP_ORCHESTRATION_DB"
CONVERSATION_ENV = "QH_TEAM_MCP_CONVERSATION_ID"
SESSION_ENV = "QH_TEAM_MCP_SESSION_ID"
DEFAULT_SERVER_NAME = "qh-team"
DEFAULT_TOOL_DESCRIPTIONS = {
    "team.delegate": "Create a durable task record and return immediately.",
    "team.status": "Read the current status of a delegated task.",
    "team.result": "Read the task summary plus attempts, artifacts, reviews, and messages.",
    "team.message": "Queue a follow-up message for the task owner using a stable idempotency key.",
    "team.cancel": "Cancel the task and mark active attempts cancelled.",
    "review.request": "Move a task into review and create a review request record.",
}


def orchestration_db_path() -> Path:
    """Resolve the orchestration DB path from the environment or the default state dir."""

    for key in (DB_ENV, "QH_OPENWORKER_ORCHESTRATION_DB", "COWORKER_ORCHESTRATION_DB"):
        value = os.environ.get(key)
        if value:
            return Path(value).expanduser()
    return state_dir() / "qh_orchestrator.db"


def build_team_mcp_server(
    db_path: str | Path | None = None,
    *,
    conversation_id: str | None = None,
    session_id: str | None = None,
    role: str = "main",
    allow_reviewer: bool = False,
) -> AcpMcpServer | None:
    """Build the stdio adapter config used by ACP-hosted agents.

    Reviewer profiles are excluded by default so the read-only reviewer session cannot
    accidentally gain mutation tools. Pass ``allow_reviewer=True`` only for explicit
    experiments.
    """

    if role == "reviewer" and not allow_reviewer:
        return None
    env: dict[str, str] = {DB_ENV: str(Path(db_path).expanduser()) if db_path else str(orchestration_db_path())}
    if conversation_id:
        env[CONVERSATION_ENV] = str(conversation_id)
    if session_id:
        env[SESSION_ENV] = str(session_id)
    return AcpMcpServer(
        name="qh-team",
        command=sys.executable,
        args=("-m", "coworker.team_mcp"),
        env=env,
    )


def _store() -> QhOrchestratorStore:
    return QhOrchestratorStore(orchestration_db_path())


def _success(payload: Mapping[str, Any]) -> dict[str, Any]:
    result = {"ok": True}
    result.update(dict(payload))
    return result


def _failure(error: Exception | str, *, tool: str | None = None) -> dict[str, Any]:
    if isinstance(error, Exception):
        message = f"{type(error).__name__}: {error}"
    else:
        message = str(error)
    result = {"ok": False, "error": message}
    if tool:
        result["tool"] = tool
    return result


def create_server() -> FastMCP[Any]:
    store = _store()
    app = FastMCP(DEFAULT_SERVER_NAME, instructions="qh-openworker team control plane")

    @app.tool(
        name="team.delegate",
        title="Delegate task",
        description=DEFAULT_TOOL_DESCRIPTIONS["team.delegate"],
        structured_output=True,
    )
    def delegate(
        task_spec: dict[str, Any] | str,
        conversation_id: str | None = None,
        target_profile_id: str | None = None,
        max_rework_rounds: int = QhOrchestratorStore.DEFAULT_MAX_REWORK_ROUNDS,
    ) -> dict[str, Any]:
        try:
            convo = (
                conversation_id
                or os.environ.get(CONVERSATION_ENV)
                or os.environ.get("QH_OPENWORKER_CONVERSATION_ID")
            )
            payload = dict(task_spec) if isinstance(task_spec, Mapping) else {"prompt": str(task_spec)}
            session_id = os.environ.get(SESSION_ENV) or os.environ.get("QH_OPENWORKER_SESSION_ID")
            if convo:
                payload.setdefault("conversation_id", convo)
            if session_id:
                payload.setdefault("target_session_id", session_id)
            result = store.delegate(
                payload,
                conversation_id=convo,
                target_profile_id=target_profile_id,
                max_rework_rounds=max_rework_rounds,
            )
            return _success(result)
        except Exception as exc:
            return _failure(exc, tool="team.delegate")

    @app.tool(
        name="team.status",
        title="Task status",
        description=DEFAULT_TOOL_DESCRIPTIONS["team.status"],
        structured_output=True,
    )
    def status(task_id: str) -> dict[str, Any]:
        try:
            return _success(store.status(task_id))
        except Exception as exc:
            return _failure(exc, tool="team.status")

    @app.tool(
        name="team.result",
        title="Task result",
        description=DEFAULT_TOOL_DESCRIPTIONS["team.result"],
        structured_output=True,
    )
    def result(task_id: str) -> dict[str, Any]:
        try:
            return _success(store.result(task_id))
        except Exception as exc:
            return _failure(exc, tool="team.result")

    @app.tool(
        name="team.message",
        title="Task message",
        description=DEFAULT_TOOL_DESCRIPTIONS["team.message"],
        structured_output=True,
    )
    def message(
        task_id: str,
        message: str,
        idempotency_key: str,
    ) -> dict[str, Any]:
        try:
            return _success(
                store.message(
                    task_id,
                    message,
                    idempotency_key=idempotency_key,
                )
            )
        except Exception as exc:
            return _failure(exc, tool="team.message")

    @app.tool(
        name="team.cancel",
        title="Task cancel",
        description=DEFAULT_TOOL_DESCRIPTIONS["team.cancel"],
        structured_output=True,
    )
    def cancel(task_id: str) -> dict[str, Any]:
        try:
            return _success(store.cancel(task_id))
        except Exception as exc:
            return _failure(exc, tool="team.cancel")

    @app.tool(
        name="review.request",
        title="Review request",
        description=DEFAULT_TOOL_DESCRIPTIONS["review.request"],
        structured_output=True,
    )
    def review_request(artifact_id: str, reviewer_profile_id: str | None = None) -> dict[str, Any]:
        try:
            return _success(
                store.request_review(
                    artifact_id,
                    reviewer_profile_id=reviewer_profile_id,
                )
            )
        except Exception as exc:
            return _failure(exc, tool="review.request")

    return app


def main() -> None:
    create_server().run(transport="stdio")


if __name__ == "__main__":
    main()
