"""SQLite-backed orchestration store.

The store is deliberately explicit and small: state is normalized for current
queries, while `ledger_events` is append-only and idempotent by caller-supplied
`event_id`. Replaying the same ledger command can therefore prove that no
duplicate prompts, approvals, or writes are emitted.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from functools import wraps
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, TypeVar

from .models import (
    AgentProfile,
    AgentRole,
    Artifact,
    Attempt,
    DEFAULT_MAX_PARALLEL_AGENTS,
    DEFAULT_MAX_REWORK_ROUNDS,
    LedgerEvent,
    ReviewResult,
    TERMINAL_STATUSES,
    Task,
    TaskStatus,
    VALID_STATUS_TRANSITIONS,
    now_iso,
)


class OrchestrationStoreError(RuntimeError):
    pass


F = TypeVar("F", bound=Callable[..., Any])


def _locked_method(fn: F) -> F:
    @wraps(fn)
    def wrapper(self: "OrchestrationStore", *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return fn(self, *args, **kwargs)

    return wrapper  # type: ignore[return-value]


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _json_loads(value: str | bytes | None) -> Any:
    if not value:
        return {}
    return json.loads(value)


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class OrchestrationStore:
    """Durable control-plane store for qh-openworker agent orchestration."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA busy_timeout = 5000")
            self._db.execute("PRAGMA foreign_keys = ON")
            self._migrate()

    @_locked_method
    def close(self) -> None:
        self._db.close()

    def _migrate(self) -> None:
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS agent_profiles (
                id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                transport TEXT NOT NULL,
                command TEXT NOT NULL,
                args_json TEXT NOT NULL,
                model_profile TEXT,
                workspace_policy TEXT NOT NULL,
                permission_policy TEXT NOT NULL,
                secret_refs_json TEXT NOT NULL,
                limits_json TEXT NOT NULL,
                enabled INTEGER NOT NULL,
                capabilities_json TEXT NOT NULL,
                capability_probe_fingerprint TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workspace_agent_profiles (
                workspace TEXT PRIMARY KEY,
                main_profile_id TEXT NOT NULL REFERENCES agent_profiles(id)
            );

            CREATE TABLE IF NOT EXISTS agent_sessions (
                agent_session_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                task_id TEXT,
                attempt_id TEXT,
                agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
                status TEXT NOT NULL,
                resume_token TEXT,
                load_ref TEXT,
                capabilities_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                status TEXT NOT NULL,
                title TEXT NOT NULL,
                task_spec_json TEXT NOT NULL,
                parent_task_id TEXT,
                max_rework_rounds INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS attempts (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
                role TEXT NOT NULL,
                agent_session_id TEXT,
                worktree TEXT,
                status TEXT NOT NULL,
                rework_round INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                uri TEXT NOT NULL,
                metadata_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS review_results (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                reviewer_attempt_id TEXT NOT NULL REFERENCES attempts(id),
                artifact_id TEXT NOT NULL REFERENCES artifacts(id),
                verdict TEXT NOT NULL,
                findings_json TEXT NOT NULL,
                test_gaps_json TEXT NOT NULL,
                confidence TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS ledger_events (
                event_id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                aggregate_type TEXT NOT NULL,
                aggregate_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS worktree_leases (
                worktree TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
                holder_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts(task_id);
            CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
            CREATE INDEX IF NOT EXISTS idx_ledger_aggregate
                ON ledger_events(aggregate_type, aggregate_id, created_at);
            """
        )
        columns = {
            row["name"]
            for row in self._db.execute("PRAGMA table_info(agent_profiles)").fetchall()
        }
        if "capability_probe_fingerprint" not in columns:
            self._db.execute(
                "ALTER TABLE agent_profiles ADD COLUMN capability_probe_fingerprint TEXT"
            )
        self._db.commit()

    # -- agent profiles -----------------------------------------------------
    @_locked_method
    def put_profile(self, profile: AgentProfile | dict[str, Any]) -> AgentProfile:
        item = AgentProfile.validated(profile)
        existing = self.get_profile(item.id)
        if existing:
            item.created_at = existing.created_at
            if (
                existing.identity_fingerprint() != item.identity_fingerprint()
                and not item.has_current_capability_probe()
            ):
                item.capabilities = {}
                item.capability_probe_fingerprint = None
                item.enabled = False
        if item.enabled and not item.has_current_capability_probe():
            raise ValueError(
                "enabled agent profiles require a successful probe for the current runtime identity"
            )
        item.updated_at = now_iso()
        data = item.to_dict()
        self._db.execute(
            """
            INSERT INTO agent_profiles (
                id, role, transport, command, args_json, model_profile,
                workspace_policy, permission_policy, secret_refs_json, limits_json,
                enabled, capabilities_json, capability_probe_fingerprint,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                role=excluded.role,
                transport=excluded.transport,
                command=excluded.command,
                args_json=excluded.args_json,
                model_profile=excluded.model_profile,
                workspace_policy=excluded.workspace_policy,
                permission_policy=excluded.permission_policy,
                secret_refs_json=excluded.secret_refs_json,
                limits_json=excluded.limits_json,
                enabled=excluded.enabled,
                capabilities_json=excluded.capabilities_json,
                capability_probe_fingerprint=excluded.capability_probe_fingerprint,
                updated_at=excluded.updated_at
            """,
            (
                data["id"],
                data["role"],
                data["transport"],
                data["command"],
                _json_dumps(data["args"]),
                data["model_profile"],
                data["workspace_policy"],
                data["permission_policy"],
                _json_dumps(data["secret_refs"]),
                _json_dumps(data["limits"]),
                1 if data["enabled"] else 0,
                _json_dumps(data["capabilities"]),
                data["capability_probe_fingerprint"],
                data["created_at"],
                data["updated_at"],
            ),
        )
        self._db.commit()
        return item

    @_locked_method
    def get_profile(self, profile_id: str) -> Optional[AgentProfile]:
        row = self._db.execute(
            "SELECT * FROM agent_profiles WHERE id = ?", (profile_id,)
        ).fetchone()
        return self._profile_from_row(row) if row else None

    @_locked_method
    def list_profiles(self) -> list[AgentProfile]:
        rows = self._db.execute(
            "SELECT * FROM agent_profiles ORDER BY role, id"
        ).fetchall()
        return [self._profile_from_row(row) for row in rows]

    @_locked_method
    def delete_profile(self, profile_id: str) -> bool:
        references = [
            ("workspace_agent_profiles", "main_profile_id"),
            ("agent_sessions", "agent_profile_id"),
            ("attempts", "agent_profile_id"),
            ("worktree_leases", "holder_profile_id"),
        ]
        for table, column in references:
            row = self._db.execute(
                f"SELECT 1 FROM {table} WHERE {column} = ? LIMIT 1", (profile_id,)
            ).fetchone()
            if row is not None:
                raise OrchestrationStoreError(
                    f"agent profile {profile_id} is still referenced by {table}"
                )
        cur = self._db.execute("DELETE FROM agent_profiles WHERE id = ?", (profile_id,))
        self._db.commit()
        return cur.rowcount > 0

    def _profile_from_row(self, row: sqlite3.Row) -> AgentProfile:
        profile = AgentProfile.from_dict(
            {
                "id": row["id"],
                "role": row["role"],
                "transport": row["transport"],
                "command": row["command"],
                "args": _json_loads(row["args_json"]),
                "model_profile": row["model_profile"],
                "workspace_policy": row["workspace_policy"],
                "permission_policy": row["permission_policy"],
                "secret_refs": _json_loads(row["secret_refs_json"]),
                "limits": _json_loads(row["limits_json"]),
                "enabled": bool(row["enabled"]),
                "capabilities": _json_loads(row["capabilities_json"]),
                "capability_probe_fingerprint": (
                    row["capability_probe_fingerprint"]
                    if "capability_probe_fingerprint" in row.keys()
                    else None
                ),
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )
        if profile.enabled and not profile.has_current_capability_probe():
            profile.enabled = False
        return profile

    @_locked_method
    def set_workspace_main_profile(self, workspace: str | Path, profile_id: str) -> None:
        profile = self.get_profile(profile_id)
        if not profile:
            raise OrchestrationStoreError(f"unknown agent profile: {profile_id}")
        if (
            not profile.enabled
            or not profile.has_current_capability_probe()
            or profile.role != AgentRole.MAIN
        ):
            raise OrchestrationStoreError("main profile must be enabled and role=main")
        self._db.execute(
            """
            INSERT INTO workspace_agent_profiles(workspace, main_profile_id)
            VALUES (?, ?)
            ON CONFLICT(workspace) DO UPDATE SET main_profile_id=excluded.main_profile_id
            """,
            (str(Path(workspace).expanduser()), profile_id),
        )
        self._db.commit()

    @_locked_method
    def get_workspace_main_profile(self, workspace: str | Path) -> Optional[AgentProfile]:
        row = self._db.execute(
            "SELECT main_profile_id FROM workspace_agent_profiles WHERE workspace = ?",
            (str(Path(workspace).expanduser()),),
        ).fetchone()
        return self.get_profile(row["main_profile_id"]) if row else None

    # -- sessions -----------------------------------------------------------
    @_locked_method
    def upsert_agent_session(
        self,
        *,
        agent_session_id: str,
        conversation_id: str,
        agent_profile_id: str,
        task_id: Optional[str] = None,
        attempt_id: Optional[str] = None,
        status: str = "active",
        resume_token: Optional[str] = None,
        load_ref: Optional[str] = None,
        capabilities: Optional[dict[str, Any]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        if not self.get_profile(agent_profile_id):
            raise OrchestrationStoreError(f"unknown agent profile: {agent_profile_id}")
        now = now_iso()
        existing = self.get_agent_session(agent_session_id)
        created_at = existing["created_at"] if existing else now
        payload = {
            "agent_session_id": agent_session_id,
            "conversation_id": conversation_id,
            "task_id": task_id,
            "attempt_id": attempt_id,
            "agent_profile_id": agent_profile_id,
            "status": status,
            "resume_token": resume_token,
            "load_ref": load_ref,
            "capabilities": capabilities or {},
            "metadata": metadata or {},
            "created_at": created_at,
            "updated_at": now,
        }
        self._db.execute(
            """
            INSERT INTO agent_sessions (
                agent_session_id, conversation_id, task_id, attempt_id,
                agent_profile_id, status, resume_token, load_ref,
                capabilities_json, metadata_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(agent_session_id) DO UPDATE SET
                conversation_id=excluded.conversation_id,
                task_id=excluded.task_id,
                attempt_id=excluded.attempt_id,
                agent_profile_id=excluded.agent_profile_id,
                status=excluded.status,
                resume_token=excluded.resume_token,
                load_ref=excluded.load_ref,
                capabilities_json=excluded.capabilities_json,
                metadata_json=excluded.metadata_json,
                updated_at=excluded.updated_at
            """,
            (
                payload["agent_session_id"],
                payload["conversation_id"],
                payload["task_id"],
                payload["attempt_id"],
                payload["agent_profile_id"],
                payload["status"],
                payload["resume_token"],
                payload["load_ref"],
                _json_dumps(payload["capabilities"]),
                _json_dumps(payload["metadata"]),
                payload["created_at"],
                payload["updated_at"],
            ),
        )
        self._db.commit()
        return payload

    @_locked_method
    def get_agent_session(self, agent_session_id: str) -> Optional[dict[str, Any]]:
        row = self._db.execute(
            "SELECT * FROM agent_sessions WHERE agent_session_id = ?",
            (agent_session_id,),
        ).fetchone()
        if not row:
            return None
        return {
            "agent_session_id": row["agent_session_id"],
            "conversation_id": row["conversation_id"],
            "task_id": row["task_id"],
            "attempt_id": row["attempt_id"],
            "agent_profile_id": row["agent_profile_id"],
            "status": row["status"],
            "resume_token": row["resume_token"],
            "load_ref": row["load_ref"],
            "capabilities": _json_loads(row["capabilities_json"]),
            "metadata": _json_loads(row["metadata_json"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # -- tasks / attempts / artifacts --------------------------------------
    @_locked_method
    def create_task(
        self,
        *,
        conversation_id: str,
        title: str = "",
        task_spec: Optional[dict[str, Any]] = None,
        task_id: Optional[str] = None,
        parent_task_id: Optional[str] = None,
        max_rework_rounds: int = DEFAULT_MAX_REWORK_ROUNDS,
        initial_status: TaskStatus | str = TaskStatus.QUEUED,
    ) -> Task:
        if max_rework_rounds < 0 or max_rework_rounds > 5:
            raise OrchestrationStoreError("max_rework_rounds must be between 0 and 5")
        item = Task(
            id=task_id or _new_id("task"),
            conversation_id=conversation_id,
            status=initial_status,
            title=title,
            task_spec=task_spec or {},
            parent_task_id=parent_task_id,
            max_rework_rounds=max_rework_rounds,
        )
        self._db.execute(
            """
            INSERT INTO tasks (
                id, conversation_id, status, title, task_spec_json, parent_task_id,
                max_rework_rounds, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.id,
                item.conversation_id,
                item.status.value,
                item.title,
                _json_dumps(item.task_spec),
                item.parent_task_id,
                item.max_rework_rounds,
                item.created_at,
                item.updated_at,
            ),
        )
        self._db.commit()
        return item

    @_locked_method
    def update_task_spec(
        self,
        task_id: str,
        task_spec: dict[str, Any],
        *,
        max_rework_rounds: Optional[int] = None,
    ) -> Task:
        task = self.get_task(task_id)
        if not task:
            raise OrchestrationStoreError(f"unknown task: {task_id}")
        rounds = (
            task.max_rework_rounds
            if max_rework_rounds is None
            else int(max_rework_rounds)
        )
        if rounds < 0 or rounds > 5:
            raise OrchestrationStoreError("max_rework_rounds must be between 0 and 5")
        self._db.execute(
            """
            UPDATE tasks
            SET task_spec_json = ?, max_rework_rounds = ?, updated_at = ?
            WHERE id = ?
            """,
            (_json_dumps(dict(task_spec)), rounds, now_iso(), task_id),
        )
        self._db.commit()
        return self.get_task(task_id)  # type: ignore[return-value]

    @_locked_method
    def get_task(self, task_id: str) -> Optional[Task]:
        row = self._db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return self._task_from_row(row) if row else None

    @_locked_method
    def list_tasks(self, conversation_id: Optional[str] = None) -> list[Task]:
        if conversation_id is None:
            rows = self._db.execute(
                "SELECT * FROM tasks ORDER BY created_at, id"
            ).fetchall()
        else:
            rows = self._db.execute(
                "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at, id",
                (conversation_id,),
            ).fetchall()
        return [self._task_from_row(row) for row in rows]

    @_locked_method
    def transition_task(
        self,
        task_id: str,
        to_status: TaskStatus | str,
        *,
        event_id: Optional[str] = None,
        payload: Optional[dict[str, Any]] = None,
    ) -> Task:
        task = self.get_task(task_id)
        if not task:
            raise OrchestrationStoreError(f"unknown task: {task_id}")
        target = TaskStatus(to_status)
        if target not in VALID_STATUS_TRANSITIONS[task.status]:
            raise OrchestrationStoreError(
                f"invalid transition {task.status.value} -> {target.value}"
            )
        if task.status in TERMINAL_STATUSES:
            raise OrchestrationStoreError("terminal task cannot transition")
        if target == TaskStatus.REWORK:
            rounds = self.rework_round_count(task_id)
            if rounds >= task.max_rework_rounds:
                raise OrchestrationStoreError("rework round limit exceeded")
        now = now_iso()
        self._db.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
            (target.value, now, task_id),
        )
        if target == TaskStatus.REWORK:
            self._db.execute(
                "UPDATE attempts SET status = ? WHERE task_id = ? AND role = ?",
                ("needs_rework", task_id, AgentRole.EXECUTOR.value),
            )
        if event_id:
            self.append_event(
                LedgerEvent(
                    event_id=event_id,
                    event_type="task.transition",
                    aggregate_type="task",
                    aggregate_id=task_id,
                    payload={
                        "from": task.status.value,
                        "to": target.value,
                        **(payload or {}),
                    },
                )
            )
        self._db.commit()
        return self.get_task(task_id)  # type: ignore[return-value]

    def _task_from_row(self, row: sqlite3.Row) -> Task:
        return Task.from_dict(
            {
                "id": row["id"],
                "conversation_id": row["conversation_id"],
                "status": row["status"],
                "title": row["title"],
                "task_spec": _json_loads(row["task_spec_json"]),
                "parent_task_id": row["parent_task_id"],
                "max_rework_rounds": row["max_rework_rounds"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )

    @_locked_method
    def enqueue_task_message(
        self,
        *,
        task_id: str,
        message_id: str,
        message: str,
        reopen_payload: Optional[dict[str, Any]] = None,
        target: Optional[dict[str, Any]] = None,
        reopen_terminal: bool = True,
    ) -> tuple[bool, bool]:
        """Atomically enqueue a message and optionally reopen a terminal executor task."""

        if not message_id:
            raise OrchestrationStoreError("message_id is required")
        try:
            self._db.execute("BEGIN IMMEDIATE")
            row = self._db.execute(
                "SELECT status FROM tasks WHERE id = ?", (task_id,)
            ).fetchone()
            if row is None:
                raise OrchestrationStoreError(f"unknown task: {task_id}")
            existing = self._db.execute(
                "SELECT event_type, payload_json FROM ledger_events WHERE event_id = ?",
                (message_id,),
            ).fetchone()
            if existing is not None:
                stored = _json_loads(existing["payload_json"])
                if (
                    existing["event_type"] != "agent.message.enqueued"
                    or str(stored.get("message") or "") != message
                    or dict(stored.get("target") or {}) != dict(target or {})
                ):
                    raise OrchestrationStoreError(
                        "idempotency_key was already used for a different message"
                    )
                self._db.commit()
                return False, False
            status = TaskStatus(str(row["status"]))
            if status == TaskStatus.CANCELLED:
                raise OrchestrationStoreError("cancelled tasks cannot be reopened")
            reopened = reopen_terminal and status in {TaskStatus.DONE, TaskStatus.BLOCKED}
            if reopened and not reopen_payload:
                raise OrchestrationStoreError(
                    "follow-up requires a previous executor session and retained worktree"
                )
            created_at = now_iso()
            self._db.execute(
                """
                INSERT INTO ledger_events(
                    event_id, event_type, aggregate_type, aggregate_id, payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    "agent.message.enqueued",
                    "task",
                    task_id,
                    _json_dumps(
                        {
                            "message_id": message_id,
                            "message": message,
                            "followup_reopen": reopened,
                            "target": dict(target or {}),
                        }
                    ),
                    created_at,
                ),
            )
            if reopened:
                source = dict(reopen_payload or {})
                source["message_id"] = message_id
                self._db.execute(
                    """
                    INSERT INTO ledger_events(
                        event_id, event_type, aggregate_type, aggregate_id,
                        payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"{message_id}:followup_reopen",
                        "agent.message.followup_reopen",
                        "task",
                        task_id,
                        _json_dumps(source),
                        created_at,
                    ),
                )
                self._db.execute(
                    "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
                    (TaskStatus.IMPLEMENTING.value, created_at, task_id),
                )
                self._db.execute(
                    """
                    INSERT INTO ledger_events(
                        event_id, event_type, aggregate_type, aggregate_id,
                        payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"{message_id}:transition:followup_reopen",
                        "task.transition",
                        "task",
                        task_id,
                        _json_dumps(
                            {
                                "from": status.value,
                                "to": TaskStatus.IMPLEMENTING.value,
                                "message_id": message_id,
                                "from_terminal": status.value,
                            }
                        ),
                        created_at,
                    ),
                )
            self._db.commit()
            return True, reopened
        except Exception:
            self._db.rollback()
            raise

    @_locked_method
    def create_attempt(
        self,
        *,
        task_id: str,
        agent_profile_id: str,
        role: AgentRole | str,
        attempt_id: Optional[str] = None,
        agent_session_id: Optional[str] = None,
        worktree: Optional[str] = None,
        status: str = "running",
        rework_round: int = 0,
    ) -> Attempt:
        if not self.get_task(task_id):
            raise OrchestrationStoreError(f"unknown task: {task_id}")
        profile = self.get_profile(agent_profile_id)
        if not profile:
            raise OrchestrationStoreError(f"unknown agent profile: {agent_profile_id}")
        role = AgentRole(role)
        if profile.role != role:
            raise OrchestrationStoreError("attempt role must match agent profile role")
        if role == AgentRole.REVIEWER and (
            worktree is not None or profile.permission_policy != "read-only"
        ):
            raise OrchestrationStoreError("reviewer attempts are always read-only")
        item = Attempt(
            id=attempt_id or _new_id("attempt"),
            task_id=task_id,
            agent_profile_id=agent_profile_id,
            role=role,
            agent_session_id=agent_session_id,
            worktree=worktree,
            status=status,
            rework_round=rework_round,
        )
        try:
            # The Team MCP server and desktop manager use separate SQLite connections.
            # BEGIN IMMEDIATE makes capacity-check + insert one cross-process atomic command.
            self._db.execute("BEGIN IMMEDIATE")
            if role != AgentRole.MAIN:
                row = self._db.execute(
                    """
                    SELECT COUNT(*) AS c
                    FROM attempts
                    WHERE task_id = ?
                      AND role != ?
                      AND status NOT IN ('completed', 'failed', 'cancelled')
                    """,
                    (task_id, AgentRole.MAIN.value),
                ).fetchone()
                if int(row["c"] if row else 0) >= DEFAULT_MAX_PARALLEL_AGENTS:
                    raise OrchestrationStoreError("parallel child agent limit exceeded")
            self._db.execute(
                """
                INSERT INTO attempts (
                    id, task_id, agent_profile_id, role, agent_session_id, worktree,
                    status, rework_round, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    item.id,
                    item.task_id,
                    item.agent_profile_id,
                    item.role.value,
                    item.agent_session_id,
                    item.worktree,
                    item.status,
                    item.rework_round,
                    item.created_at,
                    item.updated_at,
                ),
            )
            self._db.commit()
        except Exception:
            self._db.rollback()
            raise
        return item

    @_locked_method
    def get_attempt(self, attempt_id: str) -> Optional[Attempt]:
        row = self._db.execute(
            "SELECT * FROM attempts WHERE id = ?", (attempt_id,)
        ).fetchone()
        return self._attempt_from_row(row) if row else None

    @_locked_method
    def list_attempts(self, task_id: str) -> list[Attempt]:
        rows = self._db.execute(
            "SELECT * FROM attempts WHERE task_id = ? ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
        return [self._attempt_from_row(row) for row in rows]

    @_locked_method
    def active_child_attempt_count(self, task_id: str) -> int:
        row = self._db.execute(
            """
            SELECT COUNT(*) AS c
            FROM attempts
            WHERE task_id = ?
              AND role != ?
              AND status NOT IN ('completed', 'failed', 'cancelled')
            """,
            (task_id, AgentRole.MAIN.value),
        ).fetchone()
        return int(row["c"] if row else 0)

    @_locked_method
    def ensure_child_capacity(
        self,
        task_id: str,
        *,
        limit: int = DEFAULT_MAX_PARALLEL_AGENTS,
    ) -> None:
        if self.active_child_attempt_count(task_id) >= limit:
            raise OrchestrationStoreError("parallel child agent limit exceeded")

    @_locked_method
    def update_attempt_status(
        self,
        attempt_id: str,
        status: str,
        *,
        agent_session_id: Optional[str] = None,
    ) -> Attempt:
        attempt = self.get_attempt(attempt_id)
        if not attempt:
            raise OrchestrationStoreError(f"unknown attempt: {attempt_id}")
        now = now_iso()
        if agent_session_id is None:
            self._db.execute(
                "UPDATE attempts SET status = ?, updated_at = ? WHERE id = ?",
                (status, now, attempt_id),
            )
        else:
            self._db.execute(
                """
                UPDATE attempts
                SET status = ?, agent_session_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (status, agent_session_id, now, attempt_id),
            )
        if status in {"completed", "failed", "cancelled"}:
            self._db.execute(
                "DELETE FROM worktree_leases WHERE attempt_id = ?",
                (attempt_id,),
            )
        self._db.commit()
        return self.get_attempt(attempt_id)  # type: ignore[return-value]

    @_locked_method
    def update_attempt_worktree(self, attempt_id: str, worktree: str | Path) -> Attempt:
        attempt = self.get_attempt(attempt_id)
        if not attempt:
            raise OrchestrationStoreError(f"unknown attempt: {attempt_id}")
        if attempt.role != AgentRole.EXECUTOR:
            raise OrchestrationStoreError("only executor attempts may own a worktree")
        self._db.execute(
            "UPDATE attempts SET worktree = ?, updated_at = ? WHERE id = ?",
            (str(Path(worktree).expanduser().resolve()), now_iso(), attempt_id),
        )
        self._db.commit()
        return self.get_attempt(attempt_id)  # type: ignore[return-value]

    def _attempt_from_row(self, row: sqlite3.Row) -> Attempt:
        return Attempt.from_dict(
            {
                "id": row["id"],
                "task_id": row["task_id"],
                "agent_profile_id": row["agent_profile_id"],
                "role": row["role"],
                "agent_session_id": row["agent_session_id"],
                "worktree": row["worktree"],
                "status": row["status"],
                "rework_round": row["rework_round"],
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
        )

    @_locked_method
    def create_artifact(
        self,
        *,
        task_id: str,
        kind: str,
        uri: str,
        artifact_id: Optional[str] = None,
        attempt_id: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Artifact:
        if not self.get_task(task_id):
            raise OrchestrationStoreError(f"unknown task: {task_id}")
        if attempt_id and not self.get_attempt(attempt_id):
            raise OrchestrationStoreError(f"unknown attempt: {attempt_id}")
        item = Artifact(
            id=artifact_id or _new_id("artifact"),
            task_id=task_id,
            attempt_id=attempt_id,
            kind=kind,
            uri=uri,
            metadata=metadata or {},
        )
        self._db.execute(
            """
            INSERT INTO artifacts(id, task_id, attempt_id, kind, uri, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.id,
                item.task_id,
                item.attempt_id,
                item.kind,
                item.uri,
                _json_dumps(item.metadata),
                item.created_at,
            ),
        )
        self._db.commit()
        return item

    @_locked_method
    def list_artifacts(self, task_id: str) -> list[Artifact]:
        rows = self._db.execute(
            "SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
        return [self._artifact_from_row(row) for row in rows]

    @_locked_method
    def get_artifact(self, artifact_id: str) -> Optional[Artifact]:
        row = self._db.execute(
            "SELECT * FROM artifacts WHERE id = ?", (artifact_id,)
        ).fetchone()
        return self._artifact_from_row(row) if row else None

    def _artifact_from_row(self, row: sqlite3.Row) -> Artifact:
        return Artifact.from_dict(
            {
                "id": row["id"],
                "task_id": row["task_id"],
                "attempt_id": row["attempt_id"],
                "kind": row["kind"],
                "uri": row["uri"],
                "metadata": _json_loads(row["metadata_json"]),
                "created_at": row["created_at"],
            }
        )

    # -- review -------------------------------------------------------------
    @_locked_method
    def record_review(self, review: ReviewResult | dict[str, Any]) -> ReviewResult:
        item, _ = self.record_review_once(review)
        return item

    @_locked_method
    def record_review_once(
        self, review: ReviewResult | dict[str, Any]
    ) -> tuple[ReviewResult, bool]:
        """Persist one deterministic review and return ``(stored, inserted)``.

        The review id is the idempotency boundary. ``INSERT OR IGNORE`` makes retries
        and concurrent API calls converge on the first committed result rather than
        appending duplicate findings before a task-state transition.
        """

        item = (
            review
            if isinstance(review, ReviewResult)
            else ReviewResult.from_dict(review)
        )
        reviewer = self.get_attempt(item.reviewer_attempt_id)
        if not reviewer or reviewer.role != AgentRole.REVIEWER:
            raise OrchestrationStoreError(
                "reviewer_attempt_id must point to reviewer attempt"
            )
        if reviewer.task_id != item.task_id:
            raise OrchestrationStoreError("reviewer attempt belongs to a different task")
        artifact = self.get_artifact(item.artifact_id)
        if not artifact:
            raise OrchestrationStoreError("review artifact does not exist")
        if artifact.task_id != item.task_id:
            raise OrchestrationStoreError("review artifact belongs to a different task")
        item.validate()
        cursor = self._db.execute(
            """
            INSERT OR IGNORE INTO review_results (
                id, task_id, reviewer_attempt_id, artifact_id, verdict,
                findings_json, test_gaps_json, confidence, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item.id,
                item.task_id,
                item.reviewer_attempt_id,
                item.artifact_id,
                item.verdict,
                _json_dumps([finding.to_dict() for finding in item.findings]),
                _json_dumps(item.test_gaps),
                item.confidence,
                item.created_at,
            ),
        )
        row = self._db.execute(
            "SELECT * FROM review_results WHERE id = ?", (item.id,)
        ).fetchone()
        self._db.commit()
        if row is None:
            raise OrchestrationStoreError("review persistence failed")
        return self._review_from_row(row), cursor.rowcount == 1

    @_locked_method
    def list_reviews(self, task_id: str) -> list[ReviewResult]:
        rows = self._db.execute(
            "SELECT * FROM review_results WHERE task_id = ? ORDER BY created_at, id",
            (task_id,),
        ).fetchall()
        return [self._review_from_row(row) for row in rows]

    def _review_from_row(self, row: sqlite3.Row) -> ReviewResult:
        return ReviewResult.from_dict(
            {
                "id": row["id"],
                "task_id": row["task_id"],
                "reviewer_attempt_id": row["reviewer_attempt_id"],
                "artifact_id": row["artifact_id"],
                "verdict": row["verdict"],
                "findings": _json_loads(row["findings_json"]),
                "test_gaps": _json_loads(row["test_gaps_json"]),
                "confidence": row["confidence"],
                "created_at": row["created_at"],
            }
        )

    # -- ledger and replay guards -----------------------------------------
    @_locked_method
    def append_event(self, event: LedgerEvent | dict[str, Any]) -> bool:
        item = event if isinstance(event, LedgerEvent) else LedgerEvent.from_dict(event)
        cur = self._db.execute(
            """
            INSERT OR IGNORE INTO ledger_events(
                event_id, event_type, aggregate_type, aggregate_id, payload_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                item.event_id,
                item.event_type,
                item.aggregate_type,
                item.aggregate_id,
                _json_dumps(item.payload),
                item.created_at,
            ),
        )
        self._db.commit()
        return cur.rowcount == 1

    @_locked_method
    def get_event(self, event_id: str) -> Optional[LedgerEvent]:
        row = self._db.execute(
            "SELECT * FROM ledger_events WHERE event_id = ?", (event_id,)
        ).fetchone()
        if row is None:
            return None
        return LedgerEvent.from_dict(
            {
                "event_id": row["event_id"],
                "event_type": row["event_type"],
                "aggregate_type": row["aggregate_type"],
                "aggregate_id": row["aggregate_id"],
                "payload": _json_loads(row["payload_json"]),
                "created_at": row["created_at"],
            }
        )

    @_locked_method
    def list_events(
        self,
        *,
        aggregate_type: Optional[str] = None,
        aggregate_id: Optional[str] = None,
        after_cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> list[LedgerEvent]:
        clauses: list[str] = []
        params: list[str] = []
        if aggregate_type is not None:
            clauses.append("aggregate_type = ?")
            params.append(aggregate_type)
        if aggregate_id is not None:
            clauses.append("aggregate_id = ?")
            params.append(aggregate_id)
        if after_cursor:
            cursor = self._db.execute(
                "SELECT created_at, event_id FROM ledger_events WHERE event_id = ?",
                (after_cursor,),
            ).fetchone()
            if cursor is not None:
                clauses.append("(created_at > ? OR (created_at = ? AND event_id > ?))")
                params.extend(
                    [cursor["created_at"], cursor["created_at"], cursor["event_id"]]
                )
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        limit_sql = ""
        if limit is not None:
            bounded_limit = max(1, min(int(limit), 1000))
            limit_sql = f" LIMIT {bounded_limit}"
        rows = self._db.execute(
            f"SELECT * FROM ledger_events {where} ORDER BY created_at, event_id{limit_sql}",
            params,
        ).fetchall()
        return [
            LedgerEvent.from_dict(
                {
                    "event_id": row["event_id"],
                    "event_type": row["event_type"],
                    "aggregate_type": row["aggregate_type"],
                    "aggregate_id": row["aggregate_id"],
                    "payload": _json_loads(row["payload_json"]),
                    "created_at": row["created_at"],
                }
            )
            for row in rows
        ]

    @_locked_method
    def should_execute_once(
        self,
        event_id: str,
        *,
        event_type: str,
        aggregate_type: str,
        aggregate_id: str,
        payload: Optional[dict[str, Any]] = None,
    ) -> bool:
        """Append a replay guard event and return True only for the first caller."""
        return self.append_event(
            LedgerEvent(
                event_id=event_id,
                event_type=event_type,
                aggregate_type=aggregate_type,
                aggregate_id=aggregate_id,
                payload=payload or {},
            )
        )

    # -- worktree writer leases -------------------------------------------
    @_locked_method
    def acquire_worktree_lease(
        self,
        *,
        worktree: str | Path,
        task_id: str,
        attempt_id: str,
    ) -> bool:
        attempt = self.get_attempt(attempt_id)
        if not attempt:
            raise OrchestrationStoreError(f"unknown attempt: {attempt_id}")
        if attempt.task_id != task_id:
            raise OrchestrationStoreError("attempt does not belong to task")
        if attempt.role != AgentRole.EXECUTOR:
            raise OrchestrationStoreError("only executor attempts may hold write leases")
        profile = self.get_profile(attempt.agent_profile_id)
        if not profile or profile.permission_policy == "read-only":
            raise OrchestrationStoreError("read-only profiles may not hold write leases")
        cur = self._db.execute(
            """
            INSERT OR IGNORE INTO worktree_leases(
                worktree, task_id, attempt_id, holder_profile_id, created_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                str(Path(worktree).expanduser()),
                task_id,
                attempt_id,
                attempt.agent_profile_id,
                now_iso(),
            ),
        )
        self._db.commit()
        return cur.rowcount == 1

    @_locked_method
    def release_worktree_lease(self, *, worktree: str | Path, attempt_id: str) -> bool:
        cur = self._db.execute(
            "DELETE FROM worktree_leases WHERE worktree = ? AND attempt_id = ?",
            (str(Path(worktree).expanduser()), attempt_id),
        )
        self._db.commit()
        return cur.rowcount > 0

    @_locked_method
    def active_worktree_leases(self) -> list[dict[str, str]]:
        rows = self._db.execute(
            "SELECT * FROM worktree_leases ORDER BY created_at, worktree"
        ).fetchall()
        return [dict(row) for row in rows]

    @_locked_method
    def rework_round_count(self, task_id: str) -> int:
        row = self._db.execute(
            "SELECT COUNT(*) AS c FROM ledger_events WHERE aggregate_id = ? AND event_type = ?",
            (task_id, "task.transition"),
        ).fetchone()
        # The durable count should reflect real REWORK transitions, not every transition.
        count = 0
        for event in self.list_events(
            aggregate_type="task",
            aggregate_id=task_id,
        ):
            if event.event_type == "task.transition" and event.payload.get("to") == "REWORK":
                count += 1
        return count if row else 0

    # -- convenience --------------------------------------------------------
    @_locked_method
    def seed_default_profiles(self) -> list[AgentProfile]:
        """Install the MVP profile set without overwriting custom capability snapshots."""
        profiles = [
            AgentProfile(
                id="opencode-main",
                role=AgentRole.MAIN,
                transport="acp_stdio",
                command="opencode",
                args=["acp"],
                model_profile="deepseek-coder",
                workspace_policy="worktree",
                permission_policy="coding-default",
                limits={"timeout_seconds": 1800, "max_cost": 5},
            ),
            AgentProfile(
                id="opencode-executor",
                role=AgentRole.EXECUTOR,
                transport="acp_stdio",
                command="opencode",
                args=["acp"],
                model_profile="deepseek-coder",
                workspace_policy="worktree",
                permission_policy="coding-default",
                limits={"timeout_seconds": 1800, "max_cost": 5},
            ),
            AgentProfile(
                id="opencode-reviewer",
                role=AgentRole.REVIEWER,
                transport="acp_stdio",
                command="opencode",
                args=["acp"],
                model_profile="reviewer",
                workspace_policy="readonly",
                permission_policy="read-only",
                limits={"timeout_seconds": 900, "max_cost": 2},
            ),
            AgentProfile(
                id="pi-experimental",
                role=AgentRole.EXECUTOR,
                transport="jsonl_rpc",
                command="pi",
                args=["--mode", "rpc"],
                model_profile="experimental",
                workspace_policy="worktree",
                permission_policy="coding-default",
                enabled=False,
                limits={"timeout_seconds": 1800, "max_cost": 5},
            ),
        ]
        for profile in profiles:
            if profile.id != "pi-experimental":
                profile.capabilities = {
                    "preset": {
                        "id": profile.id,
                        "source": "qh-openworker-default",
                    }
                }
                profile.capability_probe_fingerprint = profile.identity_fingerprint()
                profile.enabled = True
        seeded: list[AgentProfile] = []
        for profile in profiles:
            existing = self.get_profile(profile.id)
            seeded.append(existing if existing is not None else self.put_profile(profile))
        return seeded

    @_locked_method
    def replay_events(self, events: Iterable[LedgerEvent | dict[str, Any]]) -> int:
        """Replay append-only ledger events; duplicates are ignored by event_id."""
        inserted = 0
        for event in events:
            if self.append_event(event):
                inserted += 1
        return inserted
