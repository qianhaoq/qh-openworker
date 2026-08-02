"""Safe v2 migration from the legacy coworker state directory."""

from __future__ import annotations

import copy
import json
import os
import shutil
import sqlite3
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - Python 3.10 compatibility
    import tomli as tomllib

from .secrets import state_dir, write_private_text

VERSION = 2
MANIFEST_NAME = "state-migration-v2.json"
LEDGER_NAME = "state-migration-ledger-v2.json"
LOCK_NAME = "state-migration-v2.lock"
BACKUP_DIR = "state-migration-backups"

STATUSES = {"not_needed", "running", "complete", "complete_with_conflicts", "failed"}
JSON_ASSETS = (
    "secrets.json",
    "prefs.json",
    "personas.json",
    "persona_connections.json",
    "session_connections.json",
    "connections.json",
    "mcp.json",
)


@dataclass
class MigrationStatus:
    version: int = VERSION
    status: str = "not_needed"
    assets: dict[str, dict[str, Any]] = field(default_factory=dict)
    retryable: bool = False
    report_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "status": self.status,
            "assets": self.assets,
            "retryable": self.retryable,
        }


class StateMigrationError(RuntimeError):
    def __init__(self, message: str, status: MigrationStatus, report_path: Path) -> None:
        super().__init__(message)
        self.status = status
        self.report_path = report_path


def bootstrap_state(*, force_retry: bool = False) -> MigrationStatus:
    target = state_dir()
    target.mkdir(parents=True, exist_ok=True)
    manifest_path = target / MANIFEST_NAME
    ledger_path = target / LEDGER_NAME
    explicit = _explicit_state_dir()
    legacy = _legacy_state_dir()

    with _FileLock(target / LOCK_NAME):
        if explicit is not None:
            ledger = _load_ledger(ledger_path)
            _save_ledger(ledger_path, ledger)
            assets = {
                "state_dir": {
                    "count": 1,
                    "conflicts": 0,
                    "error": None,
                    "explicit_legacy": _same_path(explicit, legacy),
                }
            }
            _bootstrap_target_integrity(target, manifest_path, assets)
            status = MigrationStatus(
                status="not_needed",
                assets=assets,
                retryable=False,
                report_path=str(manifest_path),
            )
            _write_manifest(manifest_path, status)
            return status

        previous = _read_status(manifest_path)
        if (
            previous
            and previous.status in {"not_needed", "complete", "complete_with_conflicts"}
            and not force_retry
        ):
            _bootstrap_target_integrity(target, manifest_path, dict(previous.assets))
            return previous

        if not legacy.is_dir() or _same_path(legacy, target):
            assets: dict[str, dict[str, Any]] = {}
            _bootstrap_target_integrity(target, manifest_path, assets)
            status = MigrationStatus(
                status="not_needed", assets=assets, report_path=str(manifest_path)
            )
            _write_manifest(manifest_path, status)
            _save_ledger(ledger_path, _load_ledger(ledger_path))
            return status

        assets: dict[str, dict[str, Any]] = {}
        running = MigrationStatus(
            status="running",
            assets=assets,
            retryable=True,
            report_path=str(manifest_path),
        )
        _write_manifest(manifest_path, running)
        ledger = _load_ledger(ledger_path)
        backup_root = target / BACKUP_DIR / str(int(time.time() * 1000))

        try:
            _migrate_json_assets(legacy, target, backup_root, assets)
            _migrate_config_toml(legacy, target, backup_root, assets)
            _migrate_dotenv(legacy, target, backup_root, assets)
            _migrate_db(
                legacy / "coworker.db",
                target / "coworker.db",
                backup_root,
                "coworker.db",
                assets,
                ledger,
            )
            _migrate_db(
                legacy / "automation.db",
                target / "automation.db",
                backup_root,
                "automation.db",
                assets,
                ledger,
            )
            _migrate_conversations(
                legacy / "conversations", target / "conversations", assets, ledger
            )
            final = "complete_with_conflicts" if _has_conflicts(assets) else "complete"
            status = MigrationStatus(
                status=final,
                assets=assets,
                retryable=False,
                report_path=str(manifest_path),
            )
            _save_ledger(ledger_path, ledger)
            _write_manifest(manifest_path, status)
            return status
        except Exception as exc:
            assets.setdefault(
                "migration", {"count": 0, "conflicts": 0, "error": _error_code(exc)}
            )
            status = MigrationStatus(
                status="failed",
                assets=assets,
                retryable=True,
                report_path=str(manifest_path),
            )
            _save_ledger(ledger_path, ledger)
            _write_manifest(manifest_path, status)
            raise StateMigrationError("state migration failed", status, manifest_path) from exc


def migration_status() -> MigrationStatus:
    target = state_dir()
    return _read_status(target / MANIFEST_NAME) or MigrationStatus(
        status="not_needed", report_path=str(target / MANIFEST_NAME)
    )


def migration_report() -> dict[str, Any]:
    return migration_status().to_dict()


def _bootstrap_target_integrity(
    target: Path,
    manifest_path: Path,
    assets: dict[str, dict[str, Any]],
) -> None:
    for name in ("coworker.db", "automation.db"):
        path = target / name
        if not path.is_file():
            continue
        try:
            _ensure_integrity(path)
            _asset(assets, name)["count"] = 1
        except Exception as exc:
            _asset(assets, name)["error"] = _error_code(exc)
            status = MigrationStatus(
                status="failed",
                assets=assets,
                retryable=True,
                report_path=str(manifest_path),
            )
            _write_manifest(manifest_path, status)
            raise StateMigrationError(
                "state integrity bootstrap failed", status, manifest_path
            ) from exc


def _home_dir() -> Path:
    return Path(os.environ.get("HOME", str(Path.home()))).expanduser()


def _legacy_state_dir() -> Path:
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "coworker"
    return _home_dir() / ".config" / "coworker"


def _explicit_state_dir() -> Path | None:
    qh = os.environ.get("QH_OPENWORKER_STATE_DIR")
    if qh:
        return Path(qh).expanduser()
    legacy = os.environ.get("COWORKER_STATE_DIR")
    if legacy:
        return Path(legacy).expanduser()
    return None


def _same_path(left: Path, right: Path) -> bool:
    try:
        return left.expanduser().resolve() == right.expanduser().resolve()
    except OSError:
        return left.expanduser() == right.expanduser()


class _FileLock:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._fh: Any = None

    def __enter__(self) -> "_FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.path.open("a+b")
        if sys.platform == "win32":
            import msvcrt

            msvcrt.locking(self._fh.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX)
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._fh is None:
            return
        if sys.platform == "win32":
            import msvcrt

            self._fh.seek(0)
            msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        self._fh.close()


def _read_status(path: Path) -> MigrationStatus | None:
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    status = raw.get("status")
    if status not in STATUSES:
        return None
    return MigrationStatus(
        version=int(raw.get("version") or VERSION),
        status=status,
        assets=raw.get("assets") if isinstance(raw.get("assets"), dict) else {},
        retryable=bool(raw.get("retryable")),
        report_path=str(path),
    )


def _write_manifest(path: Path, status: MigrationStatus) -> None:
    _atomic_json(path, _scrub_status(status), private=False)


def _scrub_status(status: MigrationStatus) -> dict[str, Any]:
    assets: dict[str, dict[str, Any]] = {}
    for name, info in status.assets.items():
        assets[name] = {
            "count": int(info.get("count") or 0),
            "conflicts": int(info.get("conflicts") or 0),
            "error": info.get("error"),
        }
        if "explicit_legacy" in info:
            assets[name]["explicit_legacy"] = bool(info.get("explicit_legacy"))
    return {
        "version": VERSION,
        "status": status.status if status.status in STATUSES else "failed",
        "assets": assets,
        "retryable": bool(status.retryable),
    }


def _load_ledger(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return _empty_ledger()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _empty_ledger()
    raw.setdefault("version", VERSION)
    raw.setdefault("sqlite", {})
    raw.setdefault("conversations", {"copied": [], "conflicts": []})
    return raw


def _empty_ledger() -> dict[str, Any]:
    return {
        "version": VERSION,
        "sqlite": {},
        "conversations": {"copied": [], "conflicts": []},
    }


def _save_ledger(path: Path, ledger: dict[str, Any]) -> None:
    _atomic_json(path, ledger, private=False)


def _atomic_json(path: Path, value: Any, *, private: bool) -> None:
    text = json.dumps(value, indent=2, sort_keys=True)
    if private:
        write_private_text(path, text + "\n")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _asset(assets: dict[str, dict[str, Any]], name: str) -> dict[str, Any]:
    return assets.setdefault(name, {"count": 0, "conflicts": 0, "error": None})


def _has_conflicts(assets: dict[str, dict[str, Any]]) -> bool:
    return any(int(item.get("conflicts") or 0) > 0 for item in assets.values())


def _error_code(exc: Exception) -> str:
    if isinstance(exc, sqlite3.DatabaseError):
        return "sqlite_error"
    if isinstance(exc, json.JSONDecodeError):
        return "json_error"
    if isinstance(exc, OSError):
        return "io_error"
    return exc.__class__.__name__


def _backup_existing(path: Path, backup_root: Path, asset_name: str) -> Path | None:
    if not path.exists():
        return None
    backup = backup_root / asset_name
    backup.parent.mkdir(parents=True, exist_ok=True)
    if path.is_dir():
        shutil.copytree(path, backup, dirs_exist_ok=True)
        return backup
    shutil.copy2(path, backup)
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists():
            shutil.copy2(sidecar, Path(str(backup) + suffix))
    return backup


def _restore_backup(backup: Path, target: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        current = Path(str(target) + suffix)
        saved = Path(str(backup) + suffix)
        if saved.exists():
            shutil.copy2(saved, current)
        elif suffix:
            current.unlink(missing_ok=True)


def _migrate_json_assets(
    source_root: Path,
    target_root: Path,
    backup_root: Path,
    assets: dict[str, dict[str, Any]],
) -> None:
    for name in JSON_ASSETS:
        src = source_root / name
        if not src.is_file():
            continue
        info = _asset(assets, name)
        legacy_data = json.loads(src.read_text(encoding="utf-8"))
        dst = target_root / name
        if dst.exists():
            _backup_existing(dst, backup_root, name)
            target_data = json.loads(dst.read_text(encoding="utf-8"))
            merged = _merge_json(target_data, legacy_data)
        else:
            merged = legacy_data
        _atomic_json(dst, merged, private=name == "secrets.json")
        info["count"] += 1


def _merge_json(target: Any, legacy: Any) -> Any:
    if target is None:
        return copy.deepcopy(legacy)
    if isinstance(target, dict) and isinstance(legacy, dict):
        merged = copy.deepcopy(target)
        for key, legacy_value in legacy.items():
            if key not in merged or merged[key] is None:
                merged[key] = copy.deepcopy(legacy_value)
            else:
                merged[key] = _merge_json(merged[key], legacy_value)
        return merged
    if isinstance(target, list):
        return copy.deepcopy(target)
    return copy.deepcopy(target)


def _migrate_config_toml(
    source_root: Path,
    target_root: Path,
    backup_root: Path,
    assets: dict[str, dict[str, Any]],
) -> None:
    """Migrate the real global config while preserving target text and precedence."""

    src = source_root / "config.toml"
    if not src.is_file():
        return
    info = _asset(assets, "config.toml")
    dst = target_root / "config.toml"
    if not dst.exists():
        write_private_text(dst, src.read_text(encoding="utf-8"))
        info["count"] = 1
        return

    _backup_existing(dst, backup_root, "config.toml")
    with src.open("rb") as fh:
        legacy = tomllib.load(fh)
    with dst.open("rb") as fh:
        target = tomllib.load(fh)
    additions: list[str] = []
    for key, value in legacy.items():
        if key in target:
            continue
        rendered = _toml_scalar(value)
        if rendered is None:
            info["conflicts"] += 1
            continue
        additions.append(f"{key} = {rendered}")
    if additions:
        existing = dst.read_text(encoding="utf-8").rstrip()
        write_private_text(dst, existing + "\n" + "\n".join(additions) + "\n")
    info["count"] = len(additions)


def _toml_scalar(value: Any) -> str | None:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, list):
        rendered = [_toml_scalar(item) for item in value]
        if any(item is None for item in rendered):
            return None
        return "[" + ", ".join(str(item) for item in rendered) + "]"
    return None


def _migrate_dotenv(
    source_root: Path,
    target_root: Path,
    backup_root: Path,
    assets: dict[str, dict[str, Any]],
) -> None:
    src = source_root / ".env"
    if not src.is_file():
        return
    info = _asset(assets, ".env")
    dst = target_root / ".env"
    legacy = _parse_dotenv(src)
    target = _parse_dotenv(dst)
    merged = {**legacy, **target}
    if dst.exists():
        _backup_existing(dst, backup_root, ".env")
    lines = [f"{key}={value}" for key, value in merged.items()]
    write_private_text(dst, "\n".join(lines) + ("\n" if lines else ""))
    info["count"] = len(legacy)


def _parse_dotenv(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    if not path.is_file():
        return env
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def _migrate_conversations(
    source: Path,
    target: Path,
    assets: dict[str, dict[str, Any]],
    ledger: dict[str, Any],
) -> None:
    if not source.is_dir():
        return
    info = _asset(assets, "conversations")
    conv_ledger = ledger.setdefault("conversations", {"copied": [], "conflicts": []})
    copied = set(conv_ledger.setdefault("copied", []))
    conflicts = set(conv_ledger.setdefault("conflicts", []))
    target.mkdir(parents=True, exist_ok=True)
    for src in sorted(source.glob("*.jsonl")):
        dst = target / src.name
        if src.name in copied:
            continue
        if dst.exists():
            info["conflicts"] += 1
            conflicts.add(src.name)
            continue
        if not _atomic_copy_if_absent(src, dst):
            info["conflicts"] += 1
            conflicts.add(src.name)
            continue
        copied.add(src.name)
        info["count"] += 1
    conv_ledger["copied"] = sorted(copied)
    conv_ledger["conflicts"] = sorted(conflicts)


def _atomic_copy_if_absent(source: Path, target: Path) -> bool:
    """Copy through a same-directory temp file without replacing a concurrent target."""

    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".migration-v2.tmp")
    temporary.unlink(missing_ok=True)
    try:
        shutil.copy2(source, temporary)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        try:
            os.link(temporary, target)
        except FileExistsError:
            return False
        return True
    finally:
        temporary.unlink(missing_ok=True)


def _migrate_db(
    source: Path,
    target: Path,
    backup_root: Path,
    asset_name: str,
    assets: dict[str, dict[str, Any]],
    ledger: dict[str, Any],
) -> None:
    if not source.is_file():
        return
    info = _asset(assets, asset_name)
    target.parent.mkdir(parents=True, exist_ok=True)
    _ensure_integrity(source)
    if not target.exists():
        temporary = target.with_name(target.name + ".migration.tmp")
        temporary.unlink(missing_ok=True)
        src_conn = sqlite3.connect(source)
        dst_conn = sqlite3.connect(temporary)
        try:
            src_conn.backup(dst_conn)
            dst_conn.commit()
        finally:
            src_conn.close()
            dst_conn.close()
        try:
            _ensure_integrity(temporary)
            os.replace(temporary, target)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        if asset_name == "coworker.db":
            copied = sqlite3.connect(target)
            try:
                db_ledger = ledger.setdefault("sqlite", {}).setdefault(asset_name, {})
                _record_copied_rowid_ledger(copied, db_ledger, "memories")
                _record_copied_rowid_ledger(copied, db_ledger, "audit_events")
            finally:
                copied.close()
        info["count"] += 1
        return

    backup = _backup_existing(target, backup_root, asset_name)
    _ensure_integrity(target)
    db_ledger = ledger.setdefault("sqlite", {}).setdefault(asset_name, {})
    working_ledger = copy.deepcopy(db_ledger)
    src = sqlite3.connect(source)
    dst = sqlite3.connect(target)
    src.row_factory = sqlite3.Row
    dst.row_factory = sqlite3.Row
    failure: Exception | None = None
    migrated = 0
    try:
        dst.execute("BEGIN")
        if asset_name == "coworker.db":
            migrated += _merge_pk_table(src, dst, "sessions", "session_id")
            migrated += _merge_workspaces(src, dst)
            migrated += _append_rowid_table(src, dst, working_ledger, "memories")
            migrated += _append_rowid_table(src, dst, working_ledger, "audit_events")
        elif asset_name == "automation.db":
            migrated += _merge_pk_table(src, dst, "scheduled_tasks", "id")
            migrated += _merge_pk_table(src, dst, "task_runs", "run_id")
        dst.commit()
    except Exception as exc:
        dst.rollback()
        failure = exc
    finally:
        src.close()
        dst.close()
    if failure is not None:
        if backup is not None:
            _restore_backup(backup, target)
        raise failure
    try:
        _ensure_integrity(target)
    except Exception:
        if backup is not None:
            _restore_backup(backup, target)
        raise
    db_ledger.clear()
    db_ledger.update(working_ledger)
    info["count"] += migrated


def _ensure_integrity(path: Path) -> None:
    conn = sqlite3.connect(path)
    try:
        row = conn.execute("PRAGMA integrity_check").fetchone()
        if not row or row[0] != "ok":
            raise sqlite3.DatabaseError("integrity_check_failed")
    finally:
        conn.close()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
    )


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    if not _table_exists(conn, table):
        return []
    return [
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({_quote_ident(table)})").fetchall()
    ]


def _common_columns(
    src: sqlite3.Connection, dst: sqlite3.Connection, table: str
) -> list[str]:
    target_cols = set(_columns(dst, table))
    return [col for col in _columns(src, table) if col in target_cols]


def _quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _merge_pk_table(
    src: sqlite3.Connection, dst: sqlite3.Connection, table: str, pk: str
) -> int:
    common = _common_columns(src, dst, table)
    if not common or pk not in common:
        return 0
    quoted_table = _quote_ident(table)
    pk_q = _quote_ident(pk)
    cols = ", ".join(_quote_ident(c) for c in common)
    placeholders = ", ".join("?" for _ in common)
    inserted = 0
    for row in src.execute(f"SELECT {cols} FROM {quoted_table}").fetchall():
        if dst.execute(
            f"SELECT 1 FROM {quoted_table} WHERE {pk_q}=?", (row[pk],)
        ).fetchone():
            continue
        dst.execute(
            f"INSERT INTO {quoted_table} ({cols}) VALUES ({placeholders})",
            tuple(row[c] for c in common),
        )
        inserted += 1
    return inserted


def _merge_workspaces(src: sqlite3.Connection, dst: sqlite3.Connection) -> int:
    common = _common_columns(src, dst, "workspaces")
    if not common or "path" not in common:
        return 0
    table = _quote_ident("workspaces")
    cols = ", ".join(_quote_ident(c) for c in common)
    placeholders = ", ".join("?" for _ in common)
    updated = 0
    for row in src.execute(f"SELECT {cols} FROM {table}").fetchall():
        existing = dst.execute(
            f"SELECT {cols} FROM {table} WHERE path=?", (row["path"],)
        ).fetchone()
        if existing is None:
            dst.execute(
                f"INSERT INTO {table} ({cols}) VALUES ({placeholders})",
                tuple(row[c] for c in common),
            )
            updated += 1
        elif "last_used" in common and (row["last_used"] or "") > (existing["last_used"] or ""):
            dst.execute(
                f"UPDATE {table} SET last_used=? WHERE path=?",
                (row["last_used"], row["path"]),
            )
            updated += 1
    return updated


def _append_rowid_table(
    src: sqlite3.Connection,
    dst: sqlite3.Connection,
    ledger: dict[str, Any],
    table: str,
) -> int:
    common = [c for c in _common_columns(src, dst, table) if c != "id"]
    if (
        not common
        or "id" not in _columns(src, table)
        or "id" not in _columns(dst, table)
    ):
        return 0
    table_ledger = ledger.setdefault(table, {})
    quoted_table = _quote_ident(table)
    cols = ", ".join(_quote_ident(c) for c in common)
    placeholders = ", ".join("?" for _ in common)
    inserted = 0
    for row in src.execute(f"SELECT id, {cols} FROM {quoted_table}").fetchall():
        old_id = str(row["id"])
        if old_id in table_ledger:
            continue
        cursor = dst.execute(
            f"INSERT INTO {quoted_table} ({cols}) VALUES ({placeholders})",
            tuple(row[c] for c in common),
        )
        table_ledger[old_id] = cursor.lastrowid
        inserted += 1
    return inserted


def _record_copied_rowid_ledger(
    conn: sqlite3.Connection, ledger: dict[str, Any], table: str
) -> None:
    if "id" not in _columns(conn, table):
        return
    table_ledger = ledger.setdefault(table, {})
    for row in conn.execute(f"SELECT id FROM {_quote_ident(table)}").fetchall():
        table_ledger[str(row[0])] = row[0]
