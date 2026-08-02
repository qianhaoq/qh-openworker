from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from coworker.orchestration import (
    AgentProfile,
    AgentRole,
    OrchestrationStore,
    WorktreeManager,
    WorktreeManagerError,
    WorktreePlan,
)


def _store(tmp_path: Path) -> OrchestrationStore:
    return OrchestrationStore(tmp_path / "orchestration.db")


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
    )


def _init_repo(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init")
    _git(root, "config", "user.email", "tests@example.com")
    _git(root, "config", "user.name", "Test User")
    (root / "README.md").write_text("base\n", encoding="utf-8")
    _git(root, "add", "README.md")
    _git(root, "commit", "-m", "init")
    return root


def _profiles(store: OrchestrationStore):
    main = store.put_profile(
        AgentProfile(
            id="opencode-main",
            role=AgentRole.MAIN,
            transport="acp_stdio",
            command="opencode",
            args=["acp"],
            model_profile="deepseek-coder",
            permission_policy="coding-default",
        )
    )
    executor = store.put_profile(
        AgentProfile(
            id="opencode-executor",
            role=AgentRole.EXECUTOR,
            transport="acp_stdio",
            command="opencode",
            args=["acp"],
            model_profile="deepseek-coder",
            permission_policy="coding-default",
        )
    )
    reviewer = store.put_profile(
        AgentProfile(
            id="opencode-reviewer",
            role=AgentRole.REVIEWER,
            transport="acp_stdio",
            command="opencode",
            args=["acp"],
            model_profile="reviewer",
            workspace_policy="readonly",
            permission_policy="read-only",
        )
    )
    return main, executor, reviewer


def test_executor_worktrees_are_isolated_and_cleanup_releases_lease(tmp_path: Path):
    store = _store(tmp_path)
    repo = _init_repo(tmp_path / "repo")
    worktree_root = tmp_path / "worktrees"
    _, executor, _ = _profiles(store)
    task = store.create_task(conversation_id="conv-1", title="task")
    first = store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
    )
    second = store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
    )
    manager = WorktreeManager(store, worktree_root=worktree_root)

    plan_first = manager.create_executor_worktree(
        repo_root=repo, task_id=task.id, attempt_id=first.id
    )
    plan_second = manager.create_executor_worktree(
        repo_root=repo, task_id=task.id, attempt_id=second.id
    )

    assert WorktreePlan.from_dict(plan_first.to_dict()).branch == plan_first.branch
    assert plan_first.branch.startswith("qh-agent/")
    assert plan_first.worktree_path != plan_second.worktree_path
    assert plan_first.branch != plan_second.branch

    path_first = Path(plan_first.worktree_path)
    path_second = Path(plan_second.worktree_path)
    assert path_first.is_dir()
    assert path_second.is_dir()

    (path_first / "only-first.txt").write_text("first\n", encoding="utf-8")
    assert not (path_second / "only-first.txt").exists()

    assert (
        store.acquire_worktree_lease(
            worktree=path_first, task_id=task.id, attempt_id=second.id
        )
        is False
    )

    cleaned_first = manager.cleanup_worktree(plan_first)
    cleaned_second = manager.cleanup_worktree(plan_second)

    assert cleaned_first.cleanup_done is True
    assert cleaned_second.cleanup_done is True
    assert not path_first.exists()
    assert not path_second.exists()
    assert store.active_worktree_leases() == []
    store.close()


def test_worktree_manager_rejects_broad_roots_nested_roots_and_reviewer(tmp_path: Path):
    store = _store(tmp_path)
    repo = _init_repo(tmp_path / "repo")
    _, executor, reviewer = _profiles(store)
    task = store.create_task(conversation_id="conv-1", title="task")
    executor_attempt = store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
    )
    reviewer_attempt = store.create_attempt(
        task_id=task.id,
        agent_profile_id=reviewer.id,
        role=AgentRole.REVIEWER,
    )

    with pytest.raises(WorktreeManagerError, match="too broad"):
        WorktreeManager(store, worktree_root=Path("/"))

    manager = WorktreeManager(store, worktree_root=tmp_path / "worktrees")
    with pytest.raises(WorktreeManagerError, match="executor attempts"):
        manager.plan_executor_worktree(
            repo_root=repo, task_id=task.id, attempt_id=reviewer_attempt.id
        )

    nested_repo = _init_repo(tmp_path / "worktrees" / "nested-repo")
    nested_attempt = store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
    )
    with pytest.raises(WorktreeManagerError, match="separate directories"):
        manager.plan_executor_worktree(
            repo_root=nested_repo,
            task_id=task.id,
            attempt_id=nested_attempt.id,
        )

    # Make sure the happy-path executor attempt is still planable after the checks.
    plan = manager.plan_executor_worktree(
        repo_root=repo, task_id=task.id, attempt_id=executor_attempt.id
    )
    assert plan.repo_root == str(repo.resolve())
    store.close()
