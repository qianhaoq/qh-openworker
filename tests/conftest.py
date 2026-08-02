"""Shared pytest fixtures.

`fake_slack` boots the in-process FakeSlack harness on an ephemeral port and points the Slack
adapter at it via `SLACK_API_URL`, so the real `SlackAdapter` / `slack_bolt` stack runs
end-to-end with no network, tokens, or the Slack app console. See
`coworker.testing.fake_slack` and `platform/docs/FAKE-SLACK-SPEC.md`.
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from coworker.server.manager import SessionManager
from coworker.testing.fake_slack import FakeSlack


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path, monkeypatch):
    """EVERY test gets an isolated SecretStore/state dir. Without this, any test that builds
    a SessionManager reads the developer's real machine-global state — including their cloud
    sign-in, which made test session creation emit REAL telemetry to prod (found 2026-07-03
    as burst noise in the ocw-connect-telemetry-events table)."""
    monkeypatch.setenv("COWORKER_STATE_DIR", str(tmp_path / "coworker-state"))
    monkeypatch.delenv("COWORKER_API_TOKEN", raising=False)


@pytest.fixture(autouse=True)
def _close_session_managers(monkeypatch):
    """Close every manager a test constructs, including clients used without a lifespan."""
    managers: list[SessionManager] = []
    original_init = SessionManager.__init__

    def tracking_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        managers.append(self)

    monkeypatch.setattr(SessionManager, "__init__", tracking_init)
    yield
    if managers:
        async def close_all() -> None:
            for manager in reversed(managers):
                if manager.gateway is not None and not callable(
                    getattr(manager.gateway, "stop", None)
                ):
                    manager.gateway = None
                await manager.aclose()

        asyncio.run(close_all())


@pytest_asyncio.fixture
async def fake_slack(monkeypatch):
    """A running FakeSlack control object; `SLACK_API_URL` is set to it for the test's duration."""
    fake = FakeSlack()
    await fake.start()
    monkeypatch.setenv("SLACK_API_URL", fake.api_url)
    try:
        yield fake
    finally:
        await fake.stop()
