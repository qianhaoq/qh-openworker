import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
import pytest

from coworker.orchestration import AgentProfile, OrchestrationStoreError, TaskStatus
from coworker.orchestrator import QhOrchestratorStore
from coworker.server.app import create_app
from coworker.server.manager import SessionManager


def _service(tmp_path) -> QhOrchestratorStore:
    return QhOrchestratorStore(tmp_path / "missions.db")


def test_mission_plan_requires_confirmation_before_attempt(tmp_path):
    service = _service(tmp_path)
    mission = service.create_mission(
        {
            "goal": "Implement the Mission workspace",
            "conversation_id": "conversation-main",
        }
    )

    assert mission["mission_id"] == mission["task_id"]
    assert mission["state"] == TaskStatus.AWAITING_CONFIRMATION.value
    assert mission["plan"]["status"] == "proposed"
    assert mission["attempts"] == []
    assert {member["role"] for member in mission["members"]} >= {
        "main",
        "executor",
        "reviewer",
    }
    assert all(member["seat_id"] == member["id"] for member in mission["members"])
    assert all(
        member["dependencies"] == member["depends_on"]
        for member in mission["members"]
    )

    with pytest.raises(OrchestrationStoreError, match="before plan confirmation"):
        service.start_attempt(
            mission["mission_id"],
            profile_id="opencode-executor",
            role="executor",
        )

    updated = service.update_mission_plan(
        mission["mission_id"],
        {
            "goal": "Implement and document the Mission workspace",
            "idempotency_key": "plan-edit-1",
        },
    )
    assert updated["plan"]["version"] == 2
    assert updated["plan"]["goal"] == "Implement and document the Mission workspace"
    duplicate_update = service.update_mission_plan(
        mission["mission_id"],
        {"goal": "ignored retry", "idempotency_key": "plan-edit-1"},
    )
    assert duplicate_update["plan"]["version"] == 2

    confirmed = service.confirm_mission(
        mission["mission_id"], idempotency_key="confirm-1"
    )
    assert confirmed["state"] == TaskStatus.QUEUED.value
    assert confirmed["plan"]["status"] == "confirmed"
    assert confirmed["newly_confirmed"] is True
    assert service.confirm_mission(mission["mission_id"])["newly_confirmed"] is False
    service.close()


def test_mission_create_and_messages_are_idempotent_and_targeted(tmp_path):
    service = _service(tmp_path)
    first = service.create_mission(
        {
            "goal": "Route follow-up messages",
            "conversation_id": "main-session",
            "idempotency_key": "create-route-mission",
        }
    )
    duplicate = service.create_mission(
        {
            "goal": "This retry must not create a second task",
            "conversation_id": "main-session",
            "idempotency_key": "create-route-mission",
        }
    )
    assert duplicate["mission_id"] == first["mission_id"]
    assert len(service.list_missions()) == 1

    mission_id = first["mission_id"]
    main_message = service.message_mission(
        mission_id,
        "Please revise the team plan",
        target={"kind": "main"},
        idempotency_key="main-followup-1",
    )
    main_retry = service.message_mission(
        mission_id,
        "Please revise the team plan",
        target={"kind": "main"},
        idempotency_key="main-followup-1",
    )
    assert main_message["newly_enqueued"] is True
    assert main_retry["newly_enqueued"] is False
    assert main_message["target"] == {"kind": "main"}
    assert len(service.pending_deliveries("main-session")) == 1
    with pytest.raises(OrchestrationStoreError, match="different message"):
        service.message_mission(
            mission_id,
            "A conflicting retry",
            target={"kind": "main"},
            idempotency_key="main-followup-1",
        )

    service.confirm_mission(mission_id)
    attempt = service.start_attempt(
        mission_id,
        profile_id="opencode-executor",
        role="executor",
        agent_session_id="executor-session",
    )
    child_message = service.message_mission(
        mission_id,
        "Use the existing helper",
        target={"kind": "attempt", "attempt_id": attempt["attempt_id"]},
        idempotency_key="executor-followup-1",
    )
    assert child_message["target"] == {
        "kind": "attempt",
        "attempt_id": attempt["attempt_id"],
    }
    assert service.pending_messages(mission_id)[0]["target"] == child_message["target"]
    with pytest.raises(OrchestrationStoreError, match="different message"):
        service.message_mission(
            mission_id,
            "Conflicting child retry",
            target={"kind": "attempt", "attempt_id": attempt["attempt_id"]},
            idempotency_key="executor-followup-1",
        )

    with pytest.raises(OrchestrationStoreError, match="does not belong"):
        service.message_mission(
            mission_id,
            "wrong child",
            target={"kind": "attempt", "attempt_id": "attempt-missing"},
            idempotency_key="wrong-attempt",
        )
    service.close()


def test_mission_event_cursor_resumes_without_duplicates(tmp_path):
    service = _service(tmp_path)
    mission = service.create_mission({"goal": "Stream ledger events"})
    first_page = service.mission_events(mission["mission_id"])
    assert first_page["last_cursor"]
    assert any(event["type"] == "mission.plan_proposed" for event in first_page["events"])

    service.update_mission_plan(mission["mission_id"], {"goal": "Stream new events"})
    resumed = service.mission_events(
        mission["mission_id"], after_cursor=first_page["last_cursor"]
    )
    assert [event["type"] for event in resumed["events"]] == [
        "mission.plan_updated"
    ]
    assert resumed["last_cursor"] != first_page["last_cursor"]
    service.close()


@pytest.mark.asyncio
async def test_main_acp_proposes_structured_plan_before_confirmation(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = SessionManager(workspace=workspace, data_dir=tmp_path / "data")

    class FakePlanningAdapter:
        def __init__(self):
            self.opened = None
            self.closed = False

        async def open_session(self, profile, *, cwd, checkpoint, mcp_servers):
            self.opened = {
                "profile": profile,
                "cwd": str(cwd),
                "checkpoint": checkpoint,
                "mcp_servers": mcp_servers,
            }
            return SimpleNamespace(
                session_id="kimi-main-session",
                capabilities={"session": {"resume": True}},
            )

        async def prompt(self, handle, prompt):
            assert "Return exactly one JSON object" in prompt
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "goal": "Plan through Kimi",
                        "members": [
                            {
                                "id": "main:opencode-main",
                                "role": "main",
                                "profile_id": "opencode-main",
                                "objective": "Coordinate",
                            },
                            {
                                "id": "executor:opencode-executor",
                                "role": "executor",
                                "profile_id": "opencode-executor",
                                "objective": "Implement",
                                "depends_on": ["main:opencode-main"],
                            },
                            {
                                "id": "reviewer:opencode-reviewer",
                                "role": "reviewer",
                                "profile_id": "opencode-reviewer",
                                "objective": "Review read-only",
                                "depends_on": ["executor:opencode-executor"],
                            },
                        ],
                        "max_rework_rounds": 2,
                    }
                ),
            )

        async def close(self, handle):
            self.closed = True

    workspace_path = workspace.resolve()
    planning_adapter = FakePlanningAdapter()
    manager.acp_adapter = planning_adapter  # type: ignore[assignment]
    mission = await manager.create_mission_with_main_planning(
        {"goal": "Plan through Kimi", "workspace": str(workspace)}
    )

    assert mission["state"] == "AWAITING_CONFIRMATION"
    assert mission["attempts"] == []
    assert mission["plan_proposal"] == {
        "source": "main_agent",
        "agent_session_id": "kimi-main-session",
        "fallback_reason": None,
    }
    proposed = [
        event for event in mission["timeline"] if event["type"] == "mission.plan_proposed"
    ]
    assert proposed[-1]["payload"]["source"] == "main_agent"
    assert planning_adapter.opened is not None
    assert planning_adapter.opened["cwd"] == str(workspace_path)
    assert planning_adapter.opened["mcp_servers"] == ()
    assert planning_adapter.opened["profile"].permission_policy == "read-only"
    assert planning_adapter.opened["profile"].workspace_policy == "readonly"
    assert planning_adapter.closed is True
    with pytest.raises(OrchestrationStoreError, match="before plan confirmation"):
        manager.start_agent_attempt(
            mission["mission_id"],
            {"profile_id": "opencode-executor", "role": "executor"},
        )
    await manager.aclose()


def test_mission_rest_websocket_and_profile_delete_contract(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = SessionManager(data_dir=tmp_path / "data")
    manager.start_team_worker = lambda: None  # type: ignore[method-assign]
    app = create_app(manager)

    with TestClient(app) as client:
        missing = client.post(
            "/v1/missions",
            json={"goal": "Must not create without a workspace"},
        )
        assert missing.status_code == 422
        assert missing.json()["detail"]["code"] == "MISSION_WORKSPACE_REQUIRED"
        assert client.get("/v1/missions").json()["missions"] == []

        created = client.post(
            "/v1/missions",
            json={
                "goal": "Exercise the desktop Mission API",
                "workspace": str(workspace),
                "planning_mode": "control_plane",
            },
        )
        assert created.status_code == 200
        mission = created.json()
        mission_id = mission["mission_id"]
        assert mission["state"] == "AWAITING_CONFIRMATION"
        assert mission["plan_proposal"]["source"] == "control_plane_fallback"
        assert (
            mission["plan_proposal"]["fallback_reason"]
            == "explicit_control_plane"
        )
        assert mission["fallback_used"] is True
        assert mission["planning_error"] is None

        listed = client.get("/v1/missions").json()
        assert [item["mission_id"] for item in listed["missions"]] == [mission_id]
        filtered = client.get(
            "/v1/missions?state=AWAITING_CONFIRMATION&state=BLOCKED"
        ).json()
        assert [item["mission_id"] for item in filtered["missions"]] == [mission_id]

        events = client.get(f"/v1/missions/{mission_id}/events").json()
        cursor = events["events"][0]["cursor"]
        with client.websocket_connect(
            f"/v1/missions/{mission_id}/events?after={cursor}"
        ) as socket:
            frame = socket.receive_json()
            assert frame["type"] != "mission.events"
            assert frame.get("cursor") != cursor
            assert frame.get("event", {}).get("cursor") != cursor

        main_message = client.post(
            f"/v1/missions/{mission_id}/messages",
            json={
                "message": "Refine the plan",
                "target": {"kind": "main"},
                "idempotency_key": "api-main-message",
            },
        )
        assert main_message.status_code == 200
        assert main_message.json()["target"] == {"kind": "main"}

        confirmed = client.post(
            f"/v1/missions/{mission_id}/confirm",
            json={"idempotency_key": "api-confirm"},
        )
        assert confirmed.status_code == 200
        assert confirmed.json()["state"] == "QUEUED"

        cancelled = client.post(f"/v1/missions/{mission_id}/cancel")
        assert cancelled.status_code == 200
        assert cancelled.json()["mission_id"] == mission_id
        assert cancelled.json()["state"] == "CANCELLED"
        assert "timeline" in cancelled.json()

        profile = {
            "id": "temporary-explorer",
            "role": "explorer",
            "transport": "acp_stdio",
            "command": "opencode",
            "args": ["acp"],
            "permission_policy": "read-only",
        }
        assert client.post("/v1/agent-profiles", json=profile).status_code == 200
        deleted = client.delete("/v1/agent-profiles/temporary-explorer")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True
        assert client.delete("/v1/agent-profiles/temporary-explorer").status_code == 404


def test_mission_creation_websocket_streams_main_agent_output_before_final_projection(
    tmp_path,
):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = SessionManager(workspace=workspace, data_dir=tmp_path / "data")
    manager.start_team_worker = lambda: None  # type: ignore[method-assign]

    plan = {
        "goal": "Stream the planning output",
        "members": [
            {
                "id": "main:opencode-main",
                "role": "main",
                "profile_id": "opencode-main",
                "objective": "Coordinate",
            },
            {
                "id": "executor:opencode-executor",
                "role": "executor",
                "profile_id": "opencode-executor",
                "objective": "Implement",
                "depends_on": ["main:opencode-main"],
            },
            {
                "id": "reviewer:opencode-reviewer",
                "role": "reviewer",
                "profile_id": "opencode-reviewer",
                "objective": "Review read-only",
                "depends_on": ["executor:opencode-executor"],
            },
        ],
        "max_rework_rounds": 2,
    }
    serialized = json.dumps(plan)
    chunks = [serialized[:24], serialized[24:83], serialized[83:]]

    class StreamingPlanningAdapter:
        async def open_session(self, profile, *, cwd, checkpoint, mcp_servers):
            return SimpleNamespace(
                session_id="streaming-planner",
                capabilities={"streaming": True},
            )

        async def prompt(self, handle, prompt):
            for chunk in chunks:
                await manager._handle_acp_update(  # type: ignore[attr-defined]
                    {
                        "type": "acp.session_update",
                        "profile_id": "opencode-main",
                        "session_id": handle.session_id,
                        "text": chunk,
                    }
                )
            return SimpleNamespace(text=serialized)

        async def close(self, handle):
            return None

    manager.acp_adapter = StreamingPlanningAdapter()  # type: ignore[assignment]

    with TestClient(create_app(manager)) as client:
        with client.websocket_connect("/ws/missions/create") as socket:
            assert socket.receive_json()["type"] == "ready"
            socket.send_json(
                {
                    "type": "create",
                    "data": {
                        "goal": "Stream the planning output",
                        "workspace": str(workspace),
                    },
                }
            )
            frames = []
            while not frames or frames[-1]["type"] != "mission_complete":
                frames.append(socket.receive_json())

    types = [frame["type"] for frame in frames]
    assert types[0] == "mission_created"
    assert types[1:-1] == ["planning_delta"] * len(chunks)
    assert "".join(frame["data"]["text"] for frame in frames[1:-1]) == serialized
    final = frames[-1]["data"]["mission"]
    assert final["state"] == "AWAITING_CONFIRMATION"
    assert final["plan_proposal"]["source"] == "main_agent"


@pytest.mark.asyncio
async def test_mission_operational_planning_failure_persists_blocked_without_fallback(
    tmp_path,
):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = SessionManager(workspace=workspace, data_dir=tmp_path / "data")

    class AuthFailureAdapter:
        async def open_session(self, profile, *, cwd, checkpoint, mcp_servers):
            return SimpleNamespace(session_id="auth-failed", capabilities={})

        async def prompt(self, handle, prompt):
            raise RuntimeError("authentication token required")

        async def close(self, handle):
            return None

    manager.acp_adapter = AuthFailureAdapter()  # type: ignore[assignment]
    mission = await manager.create_mission_with_main_planning(
        {"goal": "Plan only after auth", "workspace": str(workspace)}
    )

    assert mission["state"] == "BLOCKED"
    assert mission["fallback_used"] is False
    assert mission["planning_error"] == {
        "code": "MAIN_ACP_AUTH_REQUIRED",
        "message": "The workspace main ACP Agent needs authentication.",
        "retryable": True,
    }
    assert mission["plan_proposal"]["source"] is None
    assert any(event["type"] == "mission.planning_blocked" for event in mission["timeline"])
    await manager.aclose()


@pytest.mark.asyncio
async def test_mission_invalid_main_output_uses_explicit_fallback(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    manager = SessionManager(workspace=workspace, data_dir=tmp_path / "data")

    class InvalidOutputAdapter:
        async def open_session(self, profile, *, cwd, checkpoint, mcp_servers):
            return SimpleNamespace(session_id="invalid-output", capabilities={})

        async def prompt(self, handle, prompt):
            return SimpleNamespace(text="this is not a plan")

        async def close(self, handle):
            return None

    manager.acp_adapter = InvalidOutputAdapter()  # type: ignore[assignment]
    mission = await manager.create_mission_with_main_planning(
        {"goal": "Use a safe fallback", "workspace": str(workspace)}
    )

    assert mission["state"] == "AWAITING_CONFIRMATION"
    assert mission["planning_error"] is None
    assert mission["fallback_used"] is True
    assert mission["plan_proposal"]["source"] == "control_plane_fallback"
    assert mission["plan_proposal"]["fallback_reason"] == "invalid_main_agent_output"
    await manager.aclose()


def test_manager_attempt_default_uses_executor_profile(tmp_path):
    manager = SessionManager(data_dir=tmp_path / "data")
    task = manager.delegate_agent_task({"task_spec": {"prompt": "execute"}})
    attempt = manager.start_agent_attempt(task["task_id"], {})
    assert attempt["agent_profile_id"] == "opencode-executor"
    assert attempt["role"] == "executor"
    manager.orchestrator.close()


def test_reviewer_profile_cannot_hold_secret_references():
    with pytest.raises(ValueError, match="cannot reference secrets"):
        AgentProfile(
            id="unsafe-reviewer",
            role="reviewer",
            transport="acp_stdio",
            command="opencode",
            permission_policy="read-only",
            secret_refs=["provider-token"],
        ).validate()
