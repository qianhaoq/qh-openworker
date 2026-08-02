"""Tests for the SecretStore (C0)."""

from __future__ import annotations

import os
import stat
import subprocess
import sys
import time
import json
from pathlib import Path

from coworker.secrets import SecretStore, state_dir


def test_state_dir_prefers_qh_override_then_legacy(monkeypatch, tmp_path):
    qh = tmp_path / "qh"
    legacy = tmp_path / "legacy"
    monkeypatch.setenv("QH_OPENWORKER_STATE_DIR", str(qh))
    monkeypatch.setenv("COWORKER_STATE_DIR", str(legacy))
    assert state_dir() == qh

    monkeypatch.delenv("QH_OPENWORKER_STATE_DIR")
    assert state_dir() == legacy


def test_state_dir_default_is_qh_openworker_on_posix(monkeypatch, tmp_path):
    if sys.platform == "win32":
        return
    monkeypatch.delenv("QH_OPENWORKER_STATE_DIR", raising=False)
    monkeypatch.delenv("COWORKER_STATE_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    assert state_dir() == tmp_path / ".config" / "qh-openworker"


def test_put_get_round_trip(tmp_path):
    store = SecretStore(tmp_path / "secrets.json")
    store.put("slack:default", {"type": "token", "bot_token": "xoxb-123"})
    assert store.get("slack:default") == {"type": "token", "bot_token": "xoxb-123"}
    assert store.get("missing") is None


def test_env_ref_resolution(tmp_path, monkeypatch):
    monkeypatch.setenv("MY_TOK", "from-env")
    store = SecretStore(tmp_path / "secrets.json")
    store.put("slack:default", {"type": "token", "bot_token": "${MY_TOK}"})
    assert store.get("slack:default")["bot_token"] == "from-env"


def test_dotenv_ref_resolution(tmp_path):
    (tmp_path / ".env").write_text('DOCS_TOKEN = "shhh"\n', encoding="utf-8")
    store = SecretStore(tmp_path / "secrets.json")
    store.put("docs:default", {"headers": {"Authorization": "Bearer ${DOCS_TOKEN}"}})
    assert store.get("docs:default")["headers"]["Authorization"] == "Bearer shhh"


def test_unresolved_ref_left_intact(tmp_path):
    store = SecretStore(tmp_path / "secrets.json")
    store.put("x", {"v": "${NOPE_NOT_SET}"})
    assert store.get("x")["v"] == "${NOPE_NOT_SET}"


def test_state_dir_migrates_legacy_state(tmp_path, monkeypatch):
    old_home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(old_home))
    monkeypatch.delenv("COWORKER_STATE_DIR", raising=False)
    old_state = old_home / ".config" / "coworker"
    old_state.mkdir(parents=True)
    (old_state / "secrets.json").write_text(
        json.dumps({"legacy:default": {"api_key": "token-from-legacy"}}),
        encoding="utf-8",
    )
    (old_state / ".env").write_text('LEGACY_API_KEY="legacy_env"\n', encoding="utf-8")

    new_store = SecretStore()
    assert new_store.get("legacy:default") == {"api_key": "token-from-legacy"}
    assert new_store.resolve("${LEGACY_API_KEY}") == "legacy_env"
    assert (new_store.path.parent / ".env").is_file()
    assert state_dir() == old_home / ".config" / "qh-openworker"
    assert (state_dir() / "secrets.json").is_file()


def test_status_hides_values(tmp_path):
    store = SecretStore(tmp_path / "secrets.json")
    store.put(
        "gmail:default",
        {
            "type": "oauth",
            "access": "secret",
            "account_id": "me@x.com",
            "expires": time.time() - 10,
        },
    )
    store.put("slack:default", {"type": "token", "bot_token": "xoxb"})
    status = {row["profile"]: row for row in store.status()}
    assert status["gmail:default"]["type"] == "oauth"
    assert status["gmail:default"]["account"] == "me@x.com"
    assert status["gmail:default"]["expired"] is True
    assert status["slack:default"]["expired"] is False
    # No secret material anywhere in the status payload.
    blob = str(store.status())
    assert "secret" not in blob and "xoxb" not in blob


def test_secrets_file_is_restricted(tmp_path):
    """The secrets file must be restricted to the current user. POSIX expresses this as mode
    0600; Windows has no such bits, so we assert the ACL instead (inheritance stripped, only
    the current user granted)."""
    path = tmp_path / "secrets.json"
    SecretStore(path).put("x", {"a": 1})
    if sys.platform == "win32":
        out = subprocess.run(
            ["icacls", str(path)], capture_output=True, text=True
        ).stdout
        user = os.environ.get("USERNAME", "")
        assert user and user in out  # current user is granted
        # Inherited broad principals must be gone after /inheritance:r.
        assert "NT AUTHORITY\\SYSTEM" not in out
        assert "BUILTIN\\Administrators" not in out
    else:
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_delete(tmp_path):
    store = SecretStore(tmp_path / "secrets.json")
    store.put("x", {"a": 1})
    assert store.delete("x") is True
    assert store.delete("x") is False
    assert store.get("x") is None
