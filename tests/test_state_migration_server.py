from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from coworker.server import SessionManager, create_app
from coworker.server.run import build_app
from coworker.state_migration import MANIFEST_NAME


def test_diagnostics_only_blocks_all_http_and_websocket_writes_then_recovers(
    tmp_path, monkeypatch
):
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("QH_OPENWORKER_STATE_DIR", str(state))
    monkeypatch.delenv("COWORKER_STATE_DIR", raising=False)
    (state / MANIFEST_NAME).write_text(
        json.dumps(
            {
                "version": 2,
                "status": "failed",
                "assets": {
                    "coworker.db": {
                        "count": 0,
                        "conflicts": 0,
                        "error": "sqlite_error",
                    }
                },
                "retryable": True,
            }
        ),
        encoding="utf-8",
    )

    built: list[SessionManager] = []

    def factory() -> SessionManager:
        manager = SessionManager(data_dir=state)
        manager.start_team_worker = lambda: None  # type: ignore[method-assign]
        built.append(manager)
        return manager

    app = create_app(None, manager_factory=factory)
    with TestClient(app) as client:
        assert client.get("/v1/health").json()["status"] == "diagnostics"
        assert client.get("/v1/settings").json()["diagnostics_only"] is True
        assert client.get("/v1/providers").status_code == 200
        assert client.get("/v1/state-migration").json()["status"] == "failed"
        report = client.get("/v1/state-migration/report").json()
        assert report["assets"]["coworker.db"]["error"] == "sqlite_error"

        for method, path in (
            ("POST", "/v1/missions"),
            ("POST", "/v1/providers"),
            ("DELETE", "/v1/providers/openai"),
            ("PATCH", "/v1/automations/one"),
        ):
            response = client.request(method, path, json={})
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "STATE_MIGRATION_REQUIRED"

        with client.websocket_connect("/ws/session/blocked") as socket:
            event = socket.receive_json()
            assert event["data"]["code"] == "STATE_MIGRATION_REQUIRED"
            assert event["data"]["status"] == 503
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()

        recovered = client.post("/v1/state-migration/retry")
        assert recovered.status_code == 200
        assert recovered.json()["status"] == "not_needed"
        assert app.state.manager is built[0]
        # The barrier is gone: route-level validation now decides the response.
        assert client.post("/v1/missions", json={}).status_code == 422


def test_diagnostics_retry_loads_migrated_runtime_config(tmp_path, monkeypatch):
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("QH_OPENWORKER_STATE_DIR", str(state))
    monkeypatch.delenv("COWORKER_STATE_DIR", raising=False)
    (state / "config.toml").write_text(
        'model = "ollama:local-model"\nmode = "plan"\n', encoding="utf-8"
    )
    (state / MANIFEST_NAME).write_text(
        json.dumps(
            {
                "version": 2,
                "status": "failed",
                "assets": {"migration": {"count": 0, "conflicts": 0, "error": "io_error"}},
                "retryable": True,
            }
        ),
        encoding="utf-8",
    )

    async def no_gateway(_manager):
        return []

    monkeypatch.setattr(SessionManager, "start_gateway", no_gateway)
    monkeypatch.setattr(SessionManager, "start_team_worker", lambda _manager: None)
    app = build_app(
        None,
        "gpt-5.6-sol",
        "interactive",
        diagnostics_only=True,
        model_explicit=False,
        mode_explicit=False,
    )

    with TestClient(app) as client:
        recovered = client.post("/v1/state-migration/retry")
        assert recovered.status_code == 200
        assert app.state.manager.model == "ollama:local-model"
        assert app.state.manager.mode.value == "plan"


def test_diagnostics_manifest_and_responses_never_expose_secret_material(
    tmp_path, monkeypatch
):
    state = tmp_path / "state"
    state.mkdir()
    monkeypatch.setenv("QH_OPENWORKER_STATE_DIR", str(state))
    monkeypatch.setenv("OPENAI_API_KEY", "sk-never-render-this")
    (state / MANIFEST_NAME).write_text(
        json.dumps(
            {
                "version": 2,
                "status": "failed",
                "assets": {"secrets.json": {"count": 0, "conflicts": 0, "error": "io_error"}},
                "retryable": True,
            }
        ),
        encoding="utf-8",
    )

    client = TestClient(create_app(None))
    blob = json.dumps(client.get("/v1/providers").json()) + json.dumps(
        client.get("/v1/state-migration/report").json()
    )
    assert "sk-never-render-this" not in blob
    assert "OPENAI_API_KEY" not in blob
