"""Durable orchestration models for ACP-first multi-agent runs."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

DEFAULT_MAX_PARALLEL_AGENTS = 3
DEFAULT_MAX_REWORK_ROUNDS = 2


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class AgentRole(str, Enum):
    MAIN = "main"
    EXPLORER = "explorer"
    EXECUTOR = "executor"
    REVIEWER = "reviewer"
    GUI = "gui"


class Transport(str, Enum):
    ACP_STDIO = "acp_stdio"
    JSONL_RPC = "jsonl_rpc"
    EMBEDDED = "embedded"


class TaskStatus(str, Enum):
    PLANNING = "PLANNING"
    AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION"
    QUEUED = "QUEUED"
    IMPLEMENTING = "IMPLEMENTING"
    VERIFYING = "VERIFYING"
    REVIEWING = "REVIEWING"
    APPROVED = "APPROVED"
    DONE = "DONE"
    CHANGES_REQUESTED = "CHANGES_REQUESTED"
    REWORK = "REWORK"
    BLOCKED = "BLOCKED"
    CANCELLED = "CANCELLED"


TERMINAL_STATUSES = {
    TaskStatus.DONE,
    TaskStatus.BLOCKED,
    TaskStatus.CANCELLED,
}

VALID_STATUS_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.PLANNING: {
        TaskStatus.AWAITING_CONFIRMATION,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.AWAITING_CONFIRMATION: {
        TaskStatus.PLANNING,
        TaskStatus.QUEUED,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.QUEUED: {
        TaskStatus.IMPLEMENTING,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.IMPLEMENTING: {
        TaskStatus.VERIFYING,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.VERIFYING: {
        TaskStatus.REVIEWING,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.REVIEWING: {
        TaskStatus.APPROVED,
        TaskStatus.CHANGES_REQUESTED,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.APPROVED: {TaskStatus.DONE, TaskStatus.BLOCKED, TaskStatus.CANCELLED},
    TaskStatus.CHANGES_REQUESTED: {
        TaskStatus.REWORK,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.REWORK: {
        TaskStatus.VERIFYING,
        TaskStatus.BLOCKED,
        TaskStatus.CANCELLED,
    },
    TaskStatus.DONE: set(),
    TaskStatus.BLOCKED: set(),
    TaskStatus.CANCELLED: set(),
}


MISSION_PLAN_STATUSES = {"draft", "proposed", "confirmed", "rejected"}


def _enum_value(enum_cls: type[Enum], value: Any) -> str:
    if isinstance(value, enum_cls):
        return str(value.value)
    return str(enum_cls(value).value)


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


AGENT_PROFILE_IDENTITY_FIELDS = (
    "role",
    "transport",
    "command",
    "args",
    "model_profile",
    "workspace_policy",
    "permission_policy",
    "secret_refs",
)


def agent_profile_identity_fingerprint(data: dict[str, Any]) -> str:
    """Stable fingerprint for the runtime identity a capability probe verified."""

    payload = {
        "role": _enum_value(AgentRole, data.get("role", AgentRole.EXECUTOR.value)),
        "transport": _enum_value(Transport, data.get("transport", Transport.ACP_STDIO.value)),
        "command": str(data.get("command") or "").strip(),
        "args": [str(item) for item in _list(data.get("args"))],
        "model_profile": data.get("model_profile") or None,
        "workspace_policy": str(data.get("workspace_policy") or "worktree"),
        "permission_policy": str(data.get("permission_policy") or "coding-default"),
        "secret_refs": [str(ref) for ref in _list(data.get("secret_refs"))],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass(slots=True)
class AgentProfile:
    id: str
    role: AgentRole | str
    transport: Transport | str
    command: str
    args: list[str] = field(default_factory=list)
    model_profile: Optional[str] = None
    workspace_policy: str = "worktree"
    permission_policy: str = "coding-default"
    secret_refs: list[str] = field(default_factory=list)
    limits: dict[str, Any] = field(default_factory=dict)
    enabled: bool = False
    capabilities: dict[str, Any] = field(default_factory=dict)
    capability_probe_fingerprint: Optional[str] = None
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def __post_init__(self) -> None:
        self.role = AgentRole(self.role)
        self.transport = Transport(self.transport)
        self.args = [str(a) for a in self.args]
        self.secret_refs = [str(ref) for ref in self.secret_refs]
        self.limits = _dict(self.limits)
        self.capabilities = _dict(self.capabilities)
        self.capability_probe_fingerprint = (
            str(self.capability_probe_fingerprint)
            if self.capability_probe_fingerprint
            else None
        )

    @classmethod
    def validated(cls, data: "AgentProfile | dict[str, Any]") -> "AgentProfile":
        return data if isinstance(data, cls) else cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AgentProfile":
        return cls(
            id=str(data["id"]).strip(),
            role=data.get("role", AgentRole.EXECUTOR.value),
            transport=data.get("transport", Transport.ACP_STDIO.value),
            command=str(data.get("command") or "").strip(),
            args=[str(a) for a in _list(data.get("args"))],
            model_profile=data.get("model_profile"),
            workspace_policy=str(data.get("workspace_policy") or "worktree"),
            permission_policy=str(data.get("permission_policy") or "coding-default"),
            secret_refs=[str(ref) for ref in _list(data.get("secret_refs"))],
            limits=_dict(data.get("limits")),
            enabled=bool(data.get("enabled", False)),
            capabilities=_dict(data.get("capabilities")),
            capability_probe_fingerprint=(
                data.get("capability_probe_fingerprint")
                or data.get("probe_fingerprint")
            ),
            created_at=str(data.get("created_at") or now_iso()),
            updated_at=str(data.get("updated_at") or now_iso()),
        ).validate()

    def validate(self) -> "AgentProfile":
        if not self.id:
            raise ValueError("agent profile id is required")
        if not self.command:
            raise ValueError("agent profile command is required")
        if self.role == AgentRole.REVIEWER and self.permission_policy != "read-only":
            raise ValueError("reviewer profiles must use permission_policy='read-only'")
        if self.role == AgentRole.REVIEWER and self.secret_refs:
            raise ValueError("reviewer profiles cannot reference secrets")
        return self

    def identity_fingerprint(self) -> str:
        return agent_profile_identity_fingerprint(self.to_dict())

    def has_current_capability_probe(self) -> bool:
        return (
            bool(self.capabilities)
            and self.capability_probe_fingerprint == self.identity_fingerprint()
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "role": _enum_value(AgentRole, self.role),
            "transport": _enum_value(Transport, self.transport),
            "command": self.command,
            "args": list(self.args),
            "model_profile": self.model_profile,
            "workspace_policy": self.workspace_policy,
            "permission_policy": self.permission_policy,
            "secret_refs": list(self.secret_refs),
            "limits": dict(self.limits),
            "enabled": self.enabled,
            "capabilities": dict(self.capabilities),
            "capability_probe_fingerprint": self.capability_probe_fingerprint,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(slots=True)
class MissionMember:
    """One planned seat in a Mission team.

    Runtime identifiers are optional because the plan must be reviewable before
    any Agent process or write-capable attempt is started.
    """

    role: AgentRole | str
    profile_id: str
    id: str = ""
    objective: str = ""
    depends_on: list[str] = field(default_factory=list)
    attempt_id: Optional[str] = None
    agent_session_id: Optional[str] = None
    status: str = "planned"

    def __post_init__(self) -> None:
        self.role = AgentRole(self.role)
        self.profile_id = str(self.profile_id).strip()
        self.id = str(self.id).strip() or f"{self.role.value}:{self.profile_id}"
        self.objective = str(self.objective).strip()
        self.depends_on = [str(item) for item in self.depends_on]
        self.status = str(self.status or "planned")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MissionMember":
        role = data.get("role", AgentRole.EXECUTOR.value)
        profile_id = str(data.get("profile_id") or data.get("agent_profile_id") or "")
        return cls(
            id=str(
                data.get("id")
                or data.get("seat_id")
                or data.get("member_id")
                or ""
            ),
            role=role,
            profile_id=profile_id,
            objective=str(data.get("objective") or data.get("responsibility") or ""),
            depends_on=[
                str(item)
                for item in _list(data.get("depends_on") or data.get("dependencies"))
            ],
            attempt_id=data.get("attempt_id"),
            agent_session_id=data.get("agent_session_id"),
            status=str(data.get("status") or "planned"),
        ).validate()

    def validate(self) -> "MissionMember":
        if not self.profile_id:
            raise ValueError("mission member profile_id is required")
        if not self.id:
            raise ValueError("mission member id is required")
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "seat_id": self.id,
            "role": _enum_value(AgentRole, self.role),
            "profile_id": self.profile_id,
            "objective": self.objective,
            "depends_on": list(self.depends_on),
            "dependencies": list(self.depends_on),
            "attempt_id": self.attempt_id,
            "agent_session_id": self.agent_session_id,
            "status": self.status,
        }


@dataclass(slots=True)
class MissionPlan:
    """Structured, versioned plan shown for confirmation before execution."""

    goal: str
    members: list[MissionMember] = field(default_factory=list)
    version: int = 1
    status: str = "proposed"
    max_rework_rounds: int = DEFAULT_MAX_REWORK_ROUNDS
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def __post_init__(self) -> None:
        self.goal = str(self.goal).strip()
        self.members = [
            item if isinstance(item, MissionMember) else MissionMember.from_dict(item)
            for item in self.members
        ]
        self.version = int(self.version)
        self.status = str(self.status or "proposed")
        self.max_rework_rounds = int(self.max_rework_rounds)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "MissionPlan":
        return cls(
            goal=str(data.get("goal") or data.get("objective") or data.get("prompt") or ""),
            members=[
                MissionMember.from_dict(item)
                for item in _list(data.get("members") or data.get("team"))
                if isinstance(item, dict)
            ],
            version=int(data.get("version", 1)),
            status=str(data.get("status") or "proposed"),
            max_rework_rounds=int(
                data.get("max_rework_rounds", DEFAULT_MAX_REWORK_ROUNDS)
            ),
            created_at=str(data.get("created_at") or now_iso()),
            updated_at=str(data.get("updated_at") or now_iso()),
        ).validate()

    def validate(self) -> "MissionPlan":
        if not self.goal:
            raise ValueError("mission plan goal is required")
        if self.version < 1:
            raise ValueError("mission plan version must be at least 1")
        if self.status not in MISSION_PLAN_STATUSES:
            raise ValueError(
                "mission plan status must be draft, proposed, confirmed, or rejected"
            )
        if self.max_rework_rounds < 0 or self.max_rework_rounds > 5:
            raise ValueError("max_rework_rounds must be between 0 and 5")
        member_ids = [item.id for item in self.members]
        if len(member_ids) != len(set(member_ids)):
            raise ValueError("mission member ids must be unique")
        known = set(member_ids)
        for member in self.members:
            missing = set(member.depends_on) - known
            if missing:
                raise ValueError(
                    f"mission member {member.id} depends on unknown members: "
                    + ", ".join(sorted(missing))
                )
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "status": self.status,
            "goal": self.goal,
            "members": [member.to_dict() for member in self.members],
            "max_rework_rounds": self.max_rework_rounds,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(slots=True)
class Task:
    id: str
    conversation_id: str
    status: TaskStatus | str = TaskStatus.QUEUED
    title: str = ""
    task_spec: dict[str, Any] = field(default_factory=dict)
    parent_task_id: Optional[str] = None
    max_rework_rounds: int = DEFAULT_MAX_REWORK_ROUNDS
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def __post_init__(self) -> None:
        self.status = TaskStatus(self.status)
        self.task_spec = _dict(self.task_spec)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Task":
        return cls(
            id=str(data["id"]),
            conversation_id=str(data.get("conversation_id") or ""),
            status=data.get("status", TaskStatus.QUEUED.value),
            title=str(data.get("title") or ""),
            task_spec=_dict(data.get("task_spec")),
            parent_task_id=data.get("parent_task_id"),
            max_rework_rounds=int(
                data.get("max_rework_rounds", DEFAULT_MAX_REWORK_ROUNDS)
            ),
            created_at=str(data.get("created_at") or now_iso()),
            updated_at=str(data.get("updated_at") or now_iso()),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "status": _enum_value(TaskStatus, self.status),
            "title": self.title,
            "task_spec": dict(self.task_spec),
            "parent_task_id": self.parent_task_id,
            "max_rework_rounds": self.max_rework_rounds,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(slots=True)
class Attempt:
    id: str
    task_id: str
    agent_profile_id: str
    role: AgentRole | str
    agent_session_id: Optional[str] = None
    worktree: Optional[str] = None
    status: str = "running"
    rework_round: int = 0
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def __post_init__(self) -> None:
        self.role = AgentRole(self.role)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Attempt":
        return cls(
            id=str(data["id"]),
            task_id=str(data["task_id"]),
            agent_profile_id=str(data["agent_profile_id"]),
            role=data.get("role", AgentRole.EXECUTOR.value),
            agent_session_id=data.get("agent_session_id"),
            worktree=data.get("worktree"),
            status=str(data.get("status") or "running"),
            rework_round=int(data.get("rework_round", 0)),
            created_at=str(data.get("created_at") or now_iso()),
            updated_at=str(data.get("updated_at") or now_iso()),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "agent_profile_id": self.agent_profile_id,
            "role": _enum_value(AgentRole, self.role),
            "agent_session_id": self.agent_session_id,
            "worktree": self.worktree,
            "status": self.status,
            "rework_round": self.rework_round,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


@dataclass(slots=True)
class Artifact:
    id: str
    task_id: str
    attempt_id: Optional[str]
    kind: str
    uri: str
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=now_iso)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Artifact":
        return cls(
            id=str(data["id"]),
            task_id=str(data["task_id"]),
            attempt_id=data.get("attempt_id"),
            kind=str(data.get("kind") or ""),
            uri=str(data.get("uri") or ""),
            metadata=_dict(data.get("metadata")),
            created_at=str(data.get("created_at") or now_iso()),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "attempt_id": self.attempt_id,
            "kind": self.kind,
            "uri": self.uri,
            "metadata": dict(self.metadata),
            "created_at": self.created_at,
        }


@dataclass(slots=True)
class ReviewFinding:
    id: str
    severity: str
    path: str
    line: Optional[int]
    title: str
    evidence: str
    suggested_fix: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ReviewFinding":
        line = data.get("line")
        return cls(
            id=str(data["id"]),
            severity=str(data.get("severity") or "medium"),
            path=str(data.get("path") or ""),
            line=int(line) if line is not None else None,
            title=str(data.get("title") or ""),
            evidence=str(data.get("evidence") or ""),
            suggested_fix=str(data.get("suggested_fix") or ""),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "severity": self.severity,
            "path": self.path,
            "line": self.line,
            "title": self.title,
            "evidence": self.evidence,
            "suggested_fix": self.suggested_fix,
        }


@dataclass(slots=True)
class ReviewResult:
    id: str
    task_id: str
    reviewer_attempt_id: str
    artifact_id: str
    verdict: str
    findings: list[ReviewFinding] = field(default_factory=list)
    test_gaps: list[str] = field(default_factory=list)
    confidence: str = "medium"
    created_at: str = field(default_factory=now_iso)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ReviewResult":
        return cls(
            id=str(data["id"]),
            task_id=str(data["task_id"]),
            reviewer_attempt_id=str(data["reviewer_attempt_id"]),
            artifact_id=str(data["artifact_id"]),
            verdict=str(data.get("verdict") or "request_changes"),
            findings=[
                ReviewFinding.from_dict(item)
                for item in _list(data.get("findings"))
                if isinstance(item, dict)
            ],
            test_gaps=[str(gap) for gap in _list(data.get("test_gaps"))],
            confidence=str(data.get("confidence") or "medium"),
            created_at=str(data.get("created_at") or now_iso()),
        ).validate()

    def validate(self) -> "ReviewResult":
        if self.verdict not in {"pass", "request_changes", "block"}:
            raise ValueError("review verdict must be pass, request_changes, or block")
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "reviewer_attempt_id": self.reviewer_attempt_id,
            "artifact_id": self.artifact_id,
            "verdict": self.verdict,
            "findings": [finding.to_dict() for finding in self.findings],
            "test_gaps": list(self.test_gaps),
            "confidence": self.confidence,
            "created_at": self.created_at,
        }


@dataclass(slots=True)
class LedgerEvent:
    event_id: str
    event_type: str
    aggregate_type: str
    aggregate_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=now_iso)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "LedgerEvent":
        return cls(
            event_id=str(data["event_id"]),
            event_type=str(data["event_type"]),
            aggregate_type=str(data["aggregate_type"]),
            aggregate_id=str(data["aggregate_id"]),
            payload=_dict(data.get("payload")),
            created_at=str(data.get("created_at") or now_iso()),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "aggregate_type": self.aggregate_type,
            "aggregate_id": self.aggregate_id,
            "payload": dict(self.payload),
            "created_at": self.created_at,
        }
