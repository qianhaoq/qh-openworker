from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from coworker.server import SessionManager, create_app


def _make_executable(directory: Path, name: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / name
    path.write_text("#!/bin/sh\nexit 0\n")
    path.chmod(0o755)


def _detect(client: TestClient, commands: str | None) -> dict:
    params = {} if commands is None else {"commands": commands}
    response = client.get("/v1/agent-profiles/detect", params=params)
    assert response.status_code == 200
    return response.json()


def test_detect_reports_installed_and_missing_commands(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    _make_executable(bin_dir, "qh-fake-agent")
    monkeypatch.setenv("PATH", str(bin_dir))
    manager = SessionManager(workspace=tmp_path)
    client = TestClient(create_app(manager))

    try:
        body = _detect(client, "qh-fake-agent,qh-missing-agent")
        assert body == {
            "results": {"qh-fake-agent": True, "qh-missing-agent": False}
        }
    finally:
        asyncio.run(manager.aclose())


def test_detect_strips_paths_and_args_and_skips_unsafe_tokens(tmp_path, monkeypatch):
    bin_dir = tmp_path / "bin"
    _make_executable(bin_dir, "kimi")
    monkeypatch.setenv("PATH", str(bin_dir))
    manager = SessionManager(workspace=tmp_path)
    client = TestClient(create_app(manager))

    try:
        body = _detect(
            client,
            "kimi --version,/usr/local/bin/kimi,foo;rm -rf /,$(whoami),, ,bar baz",
        )
        assert body == {"results": {"kimi": True, "bar": False}}
    finally:
        asyncio.run(manager.aclose())


def test_detect_caps_command_list_at_twenty(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "empty-bin"))
    manager = SessionManager(workspace=tmp_path)
    client = TestClient(create_app(manager))

    try:
        commands = ",".join(f"qh-cmd-{index}" for index in range(25))
        results = _detect(client, commands)["results"]
        assert len(results) == 20
        assert "qh-cmd-19" in results
        assert "qh-cmd-20" not in results
        assert not any(results.values())
    finally:
        asyncio.run(manager.aclose())


def test_detect_missing_or_empty_commands_returns_empty_results(tmp_path):
    manager = SessionManager(workspace=tmp_path)
    client = TestClient(create_app(manager))

    try:
        assert _detect(client, None) == {"results": {}}
        assert _detect(client, "") == {"results": {}}
        assert _detect(client, " , ,") == {"results": {}}
    finally:
        asyncio.run(manager.aclose())


def test_detect_requires_sidecar_token_when_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("COWORKER_API_TOKEN", "a" * 64)
    manager = SessionManager(workspace=tmp_path)
    client = TestClient(create_app(manager))

    try:
        assert client.get("/v1/agent-profiles/detect").status_code == 401
        authed = client.get(
            "/v1/agent-profiles/detect",
            params={"commands": "kimi"},
            headers={"X-OpenWorker-Token": "a" * 64},
        )
        assert authed.status_code == 200
        assert set(authed.json()["results"]) == {"kimi"}
    finally:
        asyncio.run(manager.aclose())
