"""Safe git worktree management for executor attempts.

The manager keeps the surface deliberately narrow:

* executor attempts only
* explicit repo root + explicit worktree root
* argv-based subprocess calls only
* cleanup only for worktrees this manager recorded

The intent is to provide a small, persistent description that higher layers can
store or replay, while the manager itself owns the git side effects and the
lease handshake with :class:`coworker.orchestration.store.OrchestrationStore`.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .models import AgentRole, now_iso
from .store import OrchestrationStore, OrchestrationStoreError


class WorktreeManagerError(RuntimeError):
    pass


_BANNED_ROOTS = {Path("/"), Path.home()}


def _slugify(value: str, *, fallback: str = "worktree") -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    slug = re.sub(r"-{2,}", "-", slug).strip(".-_")
    return slug or fallback


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _as_existing_dir(path: str | Path, *, label: str) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.exists():
        raise WorktreeManagerError(f"{label} does not exist: {candidate}")
    resolved = candidate.resolve()
    if not resolved.is_dir():
        raise WorktreeManagerError(f"{label} is not a directory: {candidate}")
    if resolved in _BANNED_ROOTS:
        raise WorktreeManagerError(f"{label} is too broad: {resolved}")
    return resolved


def _as_root_dir(path: str | Path, *, label: str, create: bool = False) -> Path:
    candidate = Path(path).expanduser()
    resolved = candidate.resolve()
    if resolved in _BANNED_ROOTS:
        raise WorktreeManagerError(f"{label} is too broad: {resolved}")
    if create:
        resolved.mkdir(parents=True, exist_ok=True)
    if not resolved.exists():
        raise WorktreeManagerError(f"{label} does not exist: {resolved}")
    if not resolved.is_dir():
        raise WorktreeManagerError(f"{label} is not a directory: {resolved}")
    return resolved


def _run_git(repo_root: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or proc.stdout or "git command failed").strip()
        raise WorktreeManagerError(f"git {' '.join(args)} failed: {stderr}")
    return proc.stdout


def _repo_toplevel(repo_root: Path) -> Path:
    out = _run_git(repo_root, "rev-parse", "--show-toplevel").strip()
    top = Path(out).expanduser().resolve()
    if top in _BANNED_ROOTS:
        raise WorktreeManagerError(f"repo root is too broad: {top}")
    if top != repo_root:
        raise WorktreeManagerError(
            f"repo root must be the git top-level: {repo_root} != {top}"
        )
    return top


@dataclass(slots=True)
class WorktreePlan:
    """Persistent description of a planned executor worktree."""

    task_id: str
    attempt_id: str
    repo_root: str
    repo_toplevel: str
    worktree_root: str
    worktree_path: str
    branch: str
    base_ref: str
    base_commit: str
    created_at: str = field(default_factory=now_iso)
    lease_acquired: bool = False
    created: bool = False
    cleanup_done: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "attempt_id": self.attempt_id,
            "repo_root": self.repo_root,
            "repo_toplevel": self.repo_toplevel,
            "worktree_root": self.worktree_root,
            "worktree_path": self.worktree_path,
            "branch": self.branch,
            "base_ref": self.base_ref,
            "base_commit": self.base_commit,
            "created_at": self.created_at,
            "lease_acquired": self.lease_acquired,
            "created": self.created,
            "cleanup_done": self.cleanup_done,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "WorktreePlan":
        return cls(
            task_id=str(data["task_id"]),
            attempt_id=str(data["attempt_id"]),
            repo_root=str(data["repo_root"]),
            repo_toplevel=str(data.get("repo_toplevel") or data["repo_root"]),
            worktree_root=str(data["worktree_root"]),
            worktree_path=str(data["worktree_path"]),
            branch=str(data["branch"]),
            base_ref=str(data.get("base_ref") or "HEAD"),
            base_commit=str(data["base_commit"]),
            created_at=str(data.get("created_at") or now_iso()),
            lease_acquired=bool(data.get("lease_acquired", False)),
            created=bool(data.get("created", False)),
            cleanup_done=bool(data.get("cleanup_done", False)),
        )


class WorktreeManager:
    """Create and clean up git worktrees for executor attempts only."""

    def __init__(
        self,
        store: OrchestrationStore,
        *,
        worktree_root: str | Path,
        branch_prefix: str = "qh-agent/",
    ) -> None:
        self.store = store
        self.worktree_root = _as_root_dir(worktree_root, label="worktree root", create=True)
        self.branch_prefix = branch_prefix if branch_prefix.endswith("/") else f"{branch_prefix}/"
        self._records: dict[str, WorktreePlan] = {}

    def plan_executor_worktree(
        self,
        *,
        repo_root: str | Path,
        task_id: str,
        attempt_id: str,
        base_ref: str = "HEAD",
    ) -> WorktreePlan:
        repo = _as_existing_dir(repo_root, label="repo root")
        repo_toplevel = _repo_toplevel(repo)
        if _is_within(repo_toplevel, self.worktree_root) or _is_within(
            self.worktree_root, repo_toplevel
        ):
            raise WorktreeManagerError(
                "repo root and worktree root must be separate directories"
            )

        attempt = self.store.get_attempt(attempt_id)
        if not attempt:
            raise WorktreeManagerError(f"unknown attempt: {attempt_id}")
        if attempt.task_id != task_id:
            raise WorktreeManagerError("attempt does not belong to task")
        if attempt.role != AgentRole.EXECUTOR:
            raise WorktreeManagerError("only executor attempts may create worktrees")
        profile = self.store.get_profile(attempt.agent_profile_id)
        if not profile:
            raise WorktreeManagerError(
                f"unknown agent profile: {attempt.agent_profile_id}"
            )
        if profile.permission_policy == "read-only":
            raise WorktreeManagerError("read-only profiles may not create worktrees")
        if profile.workspace_policy != "worktree":
            raise WorktreeManagerError("profile must use workspace_policy=worktree")

        repo_slug = _slugify(repo_toplevel.name)
        task_slug = _slugify(task_id)[:32]
        attempt_slug = _slugify(attempt_id)[:16]
        branch = f"{self.branch_prefix}{task_slug}-{attempt_slug}"
        worktree_path = (self.worktree_root / repo_slug / task_slug / attempt_slug).resolve()
        if not _is_within(worktree_path, self.worktree_root):
            raise WorktreeManagerError("planned worktree path escapes worktree root")
        if worktree_path in _BANNED_ROOTS:
            raise WorktreeManagerError(f"planned worktree path is too broad: {worktree_path}")

        base_commit = _run_git(repo_toplevel, "rev-parse", base_ref).strip()
        return WorktreePlan(
            task_id=task_id,
            attempt_id=attempt_id,
            repo_root=str(repo_toplevel),
            repo_toplevel=str(repo_toplevel),
            worktree_root=str(self.worktree_root),
            worktree_path=str(worktree_path),
            branch=branch,
            base_ref=base_ref,
            base_commit=base_commit,
        )

    def create_executor_worktree(
        self,
        *,
        repo_root: str | Path,
        task_id: str,
        attempt_id: str,
        base_ref: str = "HEAD",
    ) -> WorktreePlan:
        if attempt_id in self._records:
            return self._records[attempt_id]

        plan = self.plan_executor_worktree(
            repo_root=repo_root,
            task_id=task_id,
            attempt_id=attempt_id,
            base_ref=base_ref,
        )
        worktree_path = Path(plan.worktree_path)
        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        if worktree_path.exists():
            raise WorktreeManagerError(f"worktree path already exists: {worktree_path}")

        lease_acquired = self.store.acquire_worktree_lease(
            worktree=worktree_path,
            task_id=task_id,
            attempt_id=attempt_id,
        )
        if not lease_acquired:
            raise WorktreeManagerError(f"worktree lease already held: {worktree_path}")

        try:
            _run_git(
                Path(plan.repo_root),
                "worktree",
                "add",
                "-b",
                plan.branch,
                str(worktree_path),
                plan.base_commit,
            )
        except Exception:
            self.store.release_worktree_lease(worktree=worktree_path, attempt_id=attempt_id)
            raise

        record = WorktreePlan(
            task_id=plan.task_id,
            attempt_id=plan.attempt_id,
            repo_root=plan.repo_root,
            repo_toplevel=plan.repo_toplevel,
            worktree_root=plan.worktree_root,
            worktree_path=plan.worktree_path,
            branch=plan.branch,
            base_ref=plan.base_ref,
            base_commit=plan.base_commit,
            created_at=plan.created_at,
            lease_acquired=True,
            created=True,
        )
        self._records[attempt_id] = record
        return record

    def cleanup_worktree(self, worktree: WorktreePlan | dict[str, Any]) -> WorktreePlan:
        plan = (
            worktree
            if isinstance(worktree, WorktreePlan)
            else WorktreePlan.from_dict(worktree)
        )
        recorded = self._records.get(plan.attempt_id)
        if not recorded or recorded.worktree_path != plan.worktree_path:
            raise WorktreeManagerError("cleanup is only allowed for recorded worktrees")

        worktree_path = Path(recorded.worktree_path)
        repo_root = Path(recorded.repo_root)

        lease_released = self.store.release_worktree_lease(
            worktree=worktree_path,
            attempt_id=recorded.attempt_id,
        )
        if not lease_released:
            recorded.lease_acquired = False

        if worktree_path.exists():
            _run_git(repo_root, "worktree", "remove", "--force", str(worktree_path))

        branch_exists = _run_git(
            repo_root, "branch", "--list", recorded.branch
        ).strip()
        if branch_exists:
            _run_git(repo_root, "branch", "-D", recorded.branch)

        cleaned = WorktreePlan(
            task_id=recorded.task_id,
            attempt_id=recorded.attempt_id,
            repo_root=recorded.repo_root,
            repo_toplevel=recorded.repo_toplevel,
            worktree_root=recorded.worktree_root,
            worktree_path=recorded.worktree_path,
            branch=recorded.branch,
            base_ref=recorded.base_ref,
            base_commit=recorded.base_commit,
            created_at=recorded.created_at,
            lease_acquired=False,
            created=recorded.created,
            cleanup_done=True,
        )
        self._records[recorded.attempt_id] = cleaned
        return cleaned

