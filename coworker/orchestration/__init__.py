"""ACP-first orchestration domain primitives for qh-openworker.

This package intentionally contains no FastAPI, ACP process, or MCP server
plumbing. It owns the durable control-plane records and invariants that those
edges use: agent profiles, run ledger, tasks/attempts/artifacts, review results,
state transitions, and writer worktree leases.
"""

from .models import (
    AgentProfile,
    AgentRole,
    Artifact,
    Attempt,
    DEFAULT_MAX_PARALLEL_AGENTS,
    DEFAULT_MAX_REWORK_ROUNDS,
    LedgerEvent,
    MissionMember,
    MissionPlan,
    ReviewFinding,
    ReviewResult,
    Task,
    TaskStatus,
    Transport,
)
from .worktrees import WorktreeManager, WorktreeManagerError, WorktreePlan
from .store import OrchestrationStore, OrchestrationStoreError

__all__ = [
    "AgentProfile",
    "AgentRole",
    "Artifact",
    "Attempt",
    "DEFAULT_MAX_PARALLEL_AGENTS",
    "DEFAULT_MAX_REWORK_ROUNDS",
    "LedgerEvent",
    "MissionMember",
    "MissionPlan",
    "OrchestrationStore",
    "OrchestrationStoreError",
    "ReviewFinding",
    "ReviewResult",
    "WorktreeManager",
    "WorktreeManagerError",
    "WorktreePlan",
    "Task",
    "TaskStatus",
    "Transport",
]
