from __future__ import annotations

import json
import os
import sqlite3
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from coworker.state_migration import (
    LEDGER_NAME,
    MANIFEST_NAME,
    StateMigrationError,
    bootstrap_state,
    migration_report,
    migration_status,
)


def _home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path, Path]:
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("QH_OPENWORKER_STATE_DIR", raising=False)
    monkeypatch.delenv("COWORKER_STATE_DIR", raising=False)
    legacy = home / ".config" / "coworker"
    target = home / ".config" / "qh-openworker"
    legacy.mkdir(parents=True)
    return home, legacy, target


def _read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_default_bootstrap_merges_json_env_and_conversation_conflicts(tmp_path, monkeypatch):
    _, legacy, target = _home(tmp_path, monkeypatch)
    (legacy / "migrated-from-legacy").write_text("old marker ignored", encoding="utf-8")
    (legacy / "secrets.json").write_text(
        json.dumps(
            {
                "provider:openai": {"api_key": "legacy-token", "org": "legacy-org"},
                "slack:default": {"bot_token": "xoxb-legacy"},
            }
        ),
        encoding="utf-8",
    )
    (legacy / "prefs.json").write_text(
        json.dumps({"theme": None, "recent": ["legacy"], "nested": {"a": 1}}),
        encoding="utf-8",
    )
    (legacy / ".env").write_text("OPENAI_API_KEY=legacy-secret\nLEGACY_ONLY=1\n", encoding="utf-8")
    (legacy / "conversations").mkdir()
    (legacy / "conversations" / "same.jsonl").write_text('{"legacy": true}\n', encoding="utf-8")
    (legacy / "conversations" / "only-old.jsonl").write_text('{"old": true}\n', encoding="utf-8")

    target.mkdir(parents=True)
    (target / "secrets.json").write_text(
        json.dumps({"provider:openai": {"api_key": "target-token", "org": None}}),
        encoding="utf-8",
    )
    (target / "prefs.json").write_text(
        json.dumps({"theme": "dark", "recent": ["target"], "nested": {"b": 2}}),
        encoding="utf-8",
    )
    (target / ".env").write_text("OPENAI_API_KEY=target-secret\n", encoding="utf-8")
    (target / "conversations").mkdir()
    (target / "conversations" / "same.jsonl").write_text('{"target": true}\n', encoding="utf-8")

    status = bootstrap_state()

    assert status.status == "complete_with_conflicts"
    secrets = _read_json(target / "secrets.json")
    assert secrets["provider:openai"] == {"api_key": "target-token", "org": "legacy-org"}
    assert secrets["slack:default"] == {"bot_token": "xoxb-legacy"}
    prefs = _read_json(target / "prefs.json")
    assert prefs == {"theme": "dark", "recent": ["target"], "nested": {"a": 1, "b": 2}}
    dotenv = (target / ".env").read_text(encoding="utf-8")
    assert "OPENAI_API_KEY=target-secret" in dotenv
    assert "LEGACY_ONLY=1" in dotenv
    assert (target / "conversations" / "same.jsonl").read_text(encoding="utf-8") == '{"target": true}\n'
    assert (target / "conversations" / "only-old.jsonl").is_file()
    assert status.assets["conversations"]["conflicts"] == 1
    if sys.platform != "win32":
        assert stat.S_IMODE(os.stat(target / ".env").st_mode) == 0o600


def test_env_override_never_cross_migrates(tmp_path, monkeypatch):
    home = tmp_path / "home"
    legacy = home / ".config" / "coworker"
    legacy.mkdir(parents=True)
    (legacy / "secrets.json").write_text(json.dumps({"x": {"api_key": "legacy"}}), encoding="utf-8")
    explicit = tmp_path / "explicit"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("QH_OPENWORKER_STATE_DIR", str(explicit))
    monkeypatch.delenv("COWORKER_STATE_DIR", raising=False)

    status = bootstrap_state()

    assert status.status == "not_needed"
    assert (explicit / MANIFEST_NAME).is_file()
    assert not (explicit / "secrets.json").exists()


def test_explicit_legacy_is_marked_without_copy(tmp_path, monkeypatch):
    home = tmp_path / "home"
    legacy = home / ".config" / "coworker"
    legacy.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("COWORKER_STATE_DIR", str(legacy))
    monkeypatch.delenv("QH_OPENWORKER_STATE_DIR", raising=False)

    status = bootstrap_state()

    assert status.assets["state_dir"]["explicit_legacy"] is True
    assert (legacy / MANIFEST_NAME).is_file()


def test_explicit_state_dir_runs_integrity_bootstrap_without_cross_directory_copy(
    tmp_path, monkeypatch
):
    explicit = tmp_path / "explicit"
    explicit.mkdir()
    (explicit / "coworker.db").write_bytes(b"broken sqlite")
    monkeypatch.setenv("QH_OPENWORKER_STATE_DIR", str(explicit))
    monkeypatch.delenv("COWORKER_STATE_DIR", raising=False)

    with pytest.raises(StateMigrationError) as raised:
        bootstrap_state()

    assert raised.value.status.status == "failed"
    assert raised.value.status.assets["coworker.db"]["error"] == "sqlite_error"
    assert not (explicit / "secrets.json").exists()


def test_repeated_bootstrap_uses_manifest_and_does_not_duplicate(tmp_path, monkeypatch):
    _, legacy, target = _home(tmp_path, monkeypatch)
    (legacy / "conversations").mkdir()
    (legacy / "conversations" / "a.jsonl").write_text("{}\n", encoding="utf-8")

    first = bootstrap_state()
    second = bootstrap_state()

    assert first.status == "complete"
    assert second.to_dict() == migration_status().to_dict()
    assert len(list((target / "conversations").glob("*.jsonl"))) == 1


def test_conversation_retry_replaces_stale_temp_with_atomic_copy(tmp_path, monkeypatch):
    _, legacy, target = _home(tmp_path, monkeypatch)
    source = legacy / "conversations" / "one.jsonl"
    source.parent.mkdir()
    source.write_text('{"complete": true}\n', encoding="utf-8")
    destination = target / "conversations" / "one.jsonl"
    destination.parent.mkdir(parents=True)
    stale = destination.with_name(destination.name + ".migration-v2.tmp")
    stale.write_text('{"partial":', encoding="utf-8")

    status = bootstrap_state(force_retry=True)

    assert status.status == "complete"
    assert destination.read_text(encoding="utf-8") == '{"complete": true}\n'
    assert not stale.exists()


def test_config_toml_target_values_win_and_legacy_fills_missing(tmp_path, monkeypatch):
    _, legacy, target = _home(tmp_path, monkeypatch)
    (legacy / "config.toml").write_text(
        'model = "legacy-model"\nmode = "plan"\nallowed_commands = ["git status"]\n',
        encoding="utf-8",
    )
    target.mkdir(parents=True)
    (target / "config.toml").write_text('model = "target-model"\n', encoding="utf-8")

    status = bootstrap_state()

    assert status.status == "complete"
    text = (target / "config.toml").read_text(encoding="utf-8")
    assert 'model = "target-model"' in text
    assert 'model = "legacy-model"' not in text
    assert 'mode = "plan"' in text
    assert 'allowed_commands = ["git status"]' in text


def test_interrupted_migration_can_retry_without_duplicate_assets(tmp_path, monkeypatch):
    import coworker.state_migration as migration

    _, legacy, target = _home(tmp_path, monkeypatch)
    (legacy / "prefs.json").write_text('{"theme":"legacy"}', encoding="utf-8")
    (legacy / ".env").write_text("LEGACY_ONLY=1\n", encoding="utf-8")
    original = migration._migrate_dotenv

    def interrupt(*_args, **_kwargs):
        raise OSError("simulated interruption")

    monkeypatch.setattr(migration, "_migrate_dotenv", interrupt)
    with pytest.raises(StateMigrationError):
        bootstrap_state()
    assert _read_json(target / MANIFEST_NAME)["status"] == "failed"

    monkeypatch.setattr(migration, "_migrate_dotenv", original)
    status = bootstrap_state(force_retry=True)
    assert status.status == "complete"
    assert _read_json(target / "prefs.json") == {"theme": "legacy"}
    assert (target / ".env").read_text(encoding="utf-8") == "LEGACY_ONLY=1\n"


def test_cross_process_bootstrap_is_serialized_and_idempotent(tmp_path, monkeypatch):
    home, legacy, target = _home(tmp_path, monkeypatch)
    (legacy / "conversations").mkdir()
    (legacy / "conversations" / "one.jsonl").write_text("{}\n", encoding="utf-8")
    env = os.environ.copy()
    env["HOME"] = str(home)
    env.pop("QH_OPENWORKER_STATE_DIR", None)
    env.pop("COWORKER_STATE_DIR", None)
    command = [
        sys.executable,
        "-c",
        "from coworker.state_migration import bootstrap_state; print(bootstrap_state().status)",
    ]
    cwd = str(Path(__file__).resolve().parents[1])

    first = subprocess.Popen(command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE)
    second = subprocess.Popen(command, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE)
    first_out, _ = first.communicate(timeout=15)
    second_out, _ = second.communicate(timeout=15)

    assert first.returncode == second.returncode == 0
    assert first_out.strip() == second_out.strip() == "complete"
    assert len(list((target / "conversations").glob("*.jsonl"))) == 1


def _init_coworker_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY,
            workspace TEXT,
            model TEXT,
            title TEXT,
            target_only TEXT
        );
        CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_used TEXT);
        CREATE TABLE memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scope TEXT,
            content TEXT,
            workspace TEXT,
            legacy_only TEXT
        );
        CREATE TABLE audit_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            tool TEXT,
            args TEXT,
            legacy_only TEXT
        );
        """
    )
    conn.commit()
    conn.close()


def _init_automation_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, enabled INTEGER, data TEXT, target_only TEXT);
        CREATE TABLE task_runs (run_id TEXT PRIMARY KEY, task_id TEXT, started_at REAL, data TEXT, legacy_only TEXT);
        """
    )
    conn.commit()
    conn.close()


def test_sqlite_merge_target_priority_schema_diff_rowid_ledger(tmp_path, monkeypatch):
    _, legacy, target = _home(tmp_path, monkeypatch)
    target.mkdir(parents=True)
    _init_coworker_db(legacy / "coworker.db")
    _init_coworker_db(target / "coworker.db")
    _init_automation_db(legacy / "automation.db")
    _init_automation_db(target / "automation.db")

    src = sqlite3.connect(legacy / "coworker.db")
    src.execute("INSERT INTO sessions (session_id, workspace, model, title) VALUES ('same', '/old', 'm1', 'legacy')")
    src.execute("INSERT INTO sessions (session_id, workspace, model, title) VALUES ('old-only', '/old', 'm1', 'legacy only')")
    src.execute("INSERT INTO workspaces (path, last_used) VALUES ('/w', '2026-08-02T10:00:00')")
    src.execute("INSERT INTO memories (scope, content, workspace, legacy_only) VALUES ('workspace', 'legacy memory', '/w', 'x')")
    src.execute("INSERT INTO audit_events (session_id, tool, args, legacy_only) VALUES ('s', 'tool', '{\"api_key\":\"secret\"}', 'x')")
    src.commit()
    src.close()

    dst = sqlite3.connect(target / "coworker.db")
    dst.execute("INSERT INTO sessions (session_id, workspace, model, title, target_only) VALUES ('same', '/new', 'm2', 'target', 'keep')")
    dst.execute("INSERT INTO workspaces (path, last_used) VALUES ('/w', '2026-08-01T10:00:00')")
    dst.commit()
    dst.close()

    src_auto = sqlite3.connect(legacy / "automation.db")
    src_auto.execute("INSERT INTO scheduled_tasks (id, enabled, data) VALUES ('same-task', 1, '{}')")
    src_auto.execute("INSERT INTO scheduled_tasks (id, enabled, data) VALUES ('old-task', 1, '{}')")
    src_auto.execute("INSERT INTO task_runs (run_id, task_id, started_at, data, legacy_only) VALUES ('run-1', 'old-task', 1, '{}', 'x')")
    src_auto.commit()
    src_auto.close()
    dst_auto = sqlite3.connect(target / "automation.db")
    dst_auto.execute("INSERT INTO scheduled_tasks (id, enabled, data, target_only) VALUES ('same-task', 0, '{\"target\":true}', 'keep')")
    dst_auto.commit()
    dst_auto.close()

    status = bootstrap_state()

    assert status.status == "complete"
    db = sqlite3.connect(target / "coworker.db")
    db.row_factory = sqlite3.Row
    assert db.execute("SELECT title, workspace FROM sessions WHERE session_id='same'").fetchone()[:] == ("target", "/new")
    assert db.execute("SELECT title FROM sessions WHERE session_id='old-only'").fetchone()[0] == "legacy only"
    assert db.execute("SELECT last_used FROM workspaces WHERE path='/w'").fetchone()[0] == "2026-08-02T10:00:00"
    assert db.execute("SELECT content FROM memories").fetchone()[0] == "legacy memory"
    assert db.execute("SELECT tool FROM audit_events").fetchone()[0] == "tool"
    db.close()
    ledger = _read_json(target / LEDGER_NAME)
    assert ledger["sqlite"]["coworker.db"]["memories"]["1"] == 1
    assert ledger["sqlite"]["coworker.db"]["audit_events"]["1"] == 1
    auto = sqlite3.connect(target / "automation.db")
    assert auto.execute("SELECT enabled FROM scheduled_tasks WHERE id='same-task'").fetchone()[0] == 0
    assert auto.execute("SELECT id FROM scheduled_tasks WHERE id='old-task'").fetchone()[0] == "old-task"
    assert auto.execute("SELECT run_id FROM task_runs WHERE run_id='run-1'").fetchone()[0] == "run-1"
    auto.close()


def test_sqlite_integrity_failure_rolls_back_and_reports_failed(tmp_path, monkeypatch):
    _, legacy, target = _home(tmp_path, monkeypatch)
    target.mkdir(parents=True)
    _init_coworker_db(target / "coworker.db")
    (legacy / "coworker.db").write_bytes(b"not sqlite")

    with pytest.raises(StateMigrationError) as raised:
        bootstrap_state()

    assert raised.value.status.status == "failed"
    assert raised.value.status.retryable is True
    assert _read_json(target / MANIFEST_NAME)["status"] == "failed"
    db = sqlite3.connect(target / "coworker.db")
    assert db.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0
    db.close()


def test_sqlite_wal_rows_are_included_when_copying_new_database(tmp_path, monkeypatch):
    _, legacy, target = _home(tmp_path, monkeypatch)
    source = legacy / "coworker.db"
    _init_coworker_db(source)
    connection = sqlite3.connect(source)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        "INSERT INTO sessions (session_id, workspace, model, title) VALUES ('wal-row', '/w', 'm', 'from wal')"
    )
    connection.commit()

    try:
        assert bootstrap_state().status == "complete"
    finally:
        connection.close()

    migrated = sqlite3.connect(target / "coworker.db")
    assert migrated.execute(
        "SELECT title FROM sessions WHERE session_id='wal-row'"
    ).fetchone()[0] == "from wal"
    migrated.close()


def test_sqlite_transaction_failure_restores_target_and_discards_ledger(
    tmp_path, monkeypatch
):
    _, legacy, target = _home(tmp_path, monkeypatch)
    target.mkdir(parents=True)
    source = sqlite3.connect(legacy / "coworker.db")
    source.executescript(
        """
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY, target_only TEXT);
        CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_used TEXT);
        CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
        CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT);
        INSERT INTO sessions VALUES ('first', 'valid');
        INSERT INTO sessions VALUES ('second', NULL);
        """
    )
    source.commit()
    source.close()
    destination = sqlite3.connect(target / "coworker.db")
    destination.executescript(
        """
        CREATE TABLE sessions (session_id TEXT PRIMARY KEY, target_only TEXT NOT NULL);
        CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_used TEXT);
        CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
        CREATE TABLE audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT);
        INSERT INTO sessions VALUES ('target', 'keep');
        """
    )
    destination.commit()
    destination.close()

    with pytest.raises(StateMigrationError):
        bootstrap_state()

    restored = sqlite3.connect(target / "coworker.db")
    assert restored.execute("SELECT session_id FROM sessions ORDER BY session_id").fetchall() == [
        ("target",)
    ]
    restored.close()
    ledger = _read_json(target / LEDGER_NAME)
    assert ledger.get("sqlite", {}).get("coworker.db", {}) == {}


def test_report_and_manifest_do_not_contain_secret_material(tmp_path, monkeypatch):
    _, legacy, target = _home(tmp_path, monkeypatch)
    (legacy / "secrets.json").write_text(
        json.dumps({"provider:openai": {"api_key": "sk-live-secret-value"}}),
        encoding="utf-8",
    )
    (legacy / ".env").write_text("OPENAI_API_KEY=env-secret-value\n", encoding="utf-8")

    bootstrap_state()

    blob = json.dumps(migration_report(), sort_keys=True) + (target / MANIFEST_NAME).read_text(encoding="utf-8")
    assert "sk-live-secret-value" not in blob
    assert "env-secret-value" not in blob
    assert "provider:openai" not in blob
    assert "OPENAI_API_KEY" not in blob
