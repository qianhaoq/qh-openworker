from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from coworker.orchestration import (
    AgentProfile,
    AgentRole,
    LedgerEvent,
    OrchestrationStore,
    OrchestrationStoreError,
    ReviewResult,
    TaskStatus,
)


def _store(tmp_path):
    return OrchestrationStore(tmp_path / "orchestration.db")


def _enable_after_probe(store: OrchestrationStore, profile: AgentProfile) -> AgentProfile:
    profile.capabilities = {"agentInfo": {"name": profile.id}}
    profile.capability_probe_fingerprint = profile.identity_fingerprint()
    profile.enabled = True
    return store.put_profile(profile)


def _profiles(store: OrchestrationStore):
    main = _enable_after_probe(store, store.put_profile(
        AgentProfile(
            id="opencode-main",
            role=AgentRole.MAIN,
            transport="acp_stdio",
            command="opencode",
            args=["acp"],
            model_profile="deepseek-coder",
            permission_policy="coding-default",
        )
    ))
    executor = _enable_after_probe(store, store.put_profile(
        AgentProfile(
            id="opencode-executor",
            role=AgentRole.EXECUTOR,
            transport="acp_stdio",
            command="opencode",
            args=["acp"],
            model_profile="deepseek-coder",
            permission_policy="coding-default",
        )
    ))
    reviewer = _enable_after_probe(store, store.put_profile(
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
    ))
    return main, executor, reviewer


def test_profile_roundtrip_workspace_main_and_session_capabilities(tmp_path):
    store = _store(tmp_path)
    main, _, _ = _profiles(store)

    store.set_workspace_main_profile(tmp_path / "repo", main.id)
    assert store.get_workspace_main_profile(tmp_path / "repo").id == "opencode-main"

    session = store.upsert_agent_session(
        agent_session_id="acp-session-1",
        conversation_id="conv-1",
        agent_profile_id=main.id,
        status="active",
        resume_token="resume-token",
        capabilities={"session": {"resume": True}, "tools": ["mcp"]},
    )
    assert session["capabilities"]["session"]["resume"] is True

    updated = store.upsert_agent_session(
        agent_session_id="acp-session-1",
        conversation_id="conv-1",
        agent_profile_id=main.id,
        status="idle",
        load_ref="checkpoint-1",
        capabilities={"session": {"load": True}},
    )
    assert updated["created_at"] == session["created_at"]
    assert store.get_agent_session("acp-session-1")["status"] == "idle"
    store.close()


def test_seed_default_profiles_preserves_user_configuration_and_capabilities(tmp_path):
    store = _store(tmp_path)
    store.seed_default_profiles()
    main = store.get_profile("opencode-main")
    assert main is not None
    main.command = "/opt/custom/opencode"
    main.args = ["acp", "--custom"]
    main.capabilities = {"session": {"resume": True}}
    main.capability_probe_fingerprint = main.identity_fingerprint()
    main.enabled = True
    store.put_profile(main)

    seeded = {profile.id: profile for profile in store.seed_default_profiles()}

    assert seeded["opencode-main"].command == "/opt/custom/opencode"
    assert seeded["opencode-main"].args == ["acp", "--custom"]
    assert seeded["opencode-main"].capabilities == {"session": {"resume": True}}
    assert seeded["opencode-main"].enabled is True
    store.close()


def test_reviewer_profile_and_attempt_are_forced_read_only(tmp_path):
    store = _store(tmp_path)
    _, _, reviewer = _profiles(store)
    task = store.create_task(conversation_id="conv-1", title="review me")

    with pytest.raises(ValueError, match="reviewer profiles"):
        AgentProfile(
            id="bad-reviewer",
            role=AgentRole.REVIEWER,
            transport="acp_stdio",
            command="opencode",
            permission_policy="coding-default",
        ).validate()

    with pytest.raises(OrchestrationStoreError, match="read-only"):
        store.create_attempt(
            task_id=task.id,
            agent_profile_id=reviewer.id,
            role=AgentRole.REVIEWER,
            worktree=str(tmp_path / "repo"),
        )

    attempt = store.create_attempt(
        task_id=task.id,
        agent_profile_id=reviewer.id,
        role=AgentRole.REVIEWER,
    )
    assert attempt.worktree is None
    store.close()


def test_task_state_machine_rework_limit_and_test_gate_metadata(tmp_path):
    store = _store(tmp_path)
    _, executor, reviewer = _profiles(store)
    task = store.create_task(conversation_id="conv-1", max_rework_rounds=2)
    exec_attempt = store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        worktree=str(tmp_path / "repo-a"),
    )
    review_attempt = store.create_attempt(
        task_id=task.id,
        agent_profile_id=reviewer.id,
        role=AgentRole.REVIEWER,
    )

    assert (
        store.transition_task(task.id, TaskStatus.IMPLEMENTING).status
        == TaskStatus.IMPLEMENTING
    )
    assert (
        store.transition_task(task.id, TaskStatus.VERIFYING).status
        == TaskStatus.VERIFYING
    )
    artifact = store.create_artifact(
        task_id=task.id,
        attempt_id=exec_attempt.id,
        kind="test",
        uri="artifact://tests/1",
        metadata={"passed": False, "command": "pytest tests/foo.py"},
    )
    assert (
        store.transition_task(task.id, TaskStatus.REVIEWING).status
        == TaskStatus.REVIEWING
    )
    review = store.record_review(
        ReviewResult(
            id="review-1",
            task_id=task.id,
            reviewer_attempt_id=review_attempt.id,
            artifact_id=artifact.id,
            verdict="pass",
            test_gaps=["pytest failed; reviewer pass cannot override test gate"],
            confidence="high",
        )
    )
    assert review.verdict == "pass"

    store.transition_task(task.id, TaskStatus.CHANGES_REQUESTED)
    store.transition_task(task.id, TaskStatus.REWORK, event_id="rework-1")
    store.transition_task(task.id, TaskStatus.VERIFYING)
    store.transition_task(task.id, TaskStatus.REVIEWING)
    store.transition_task(task.id, TaskStatus.CHANGES_REQUESTED)
    store.transition_task(task.id, TaskStatus.REWORK, event_id="rework-2")
    store.transition_task(task.id, TaskStatus.VERIFYING)
    store.transition_task(task.id, TaskStatus.REVIEWING)
    store.transition_task(task.id, TaskStatus.CHANGES_REQUESTED)

    with pytest.raises(OrchestrationStoreError, match="rework round limit"):
        store.transition_task(task.id, TaskStatus.REWORK, event_id="rework-3")
    store.close()


def test_terminal_states_cannot_use_generic_transition_api(tmp_path):
    store = _store(tmp_path)
    task = store.create_task(conversation_id="conv-reopen")
    for state in (
        TaskStatus.IMPLEMENTING,
        TaskStatus.VERIFYING,
        TaskStatus.REVIEWING,
        TaskStatus.APPROVED,
        TaskStatus.DONE,
    ):
        store.transition_task(task.id, state)

    with pytest.raises(OrchestrationStoreError, match="invalid transition"):
        store.transition_task(task.id, TaskStatus.IMPLEMENTING)

    cancelled = store.create_task(conversation_id="conv-cancelled")
    store.transition_task(cancelled.id, TaskStatus.CANCELLED)
    with pytest.raises(OrchestrationStoreError, match="invalid transition"):
        store.transition_task(cancelled.id, TaskStatus.IMPLEMENTING)
    store.close()


def test_ledger_replay_is_idempotent_and_can_guard_side_effects(tmp_path):
    store = _store(tmp_path)
    event = LedgerEvent(
        event_id="deliver-worker-result-1",
        event_type="main.prompt.enqueue",
        aggregate_type="task",
        aggregate_id="task-1",
        payload={"agent_session_id": "main-session", "artifact_id": "artifact-1"},
    )

    assert store.append_event(event) is True
    assert store.append_event(event) is False
    assert store.replay_events([event, event]) == 0
    assert len(store.list_events(aggregate_type="task", aggregate_id="task-1")) == 1

    assert (
        store.should_execute_once(
            "approval-1",
            event_type="approval.request",
            aggregate_type="attempt",
            aggregate_id="attempt-1",
        )
        is True
    )
    assert (
        store.should_execute_once(
            "approval-1",
            event_type="approval.request",
            aggregate_type="attempt",
            aggregate_id="attempt-1",
        )
        is False
    )
    store.close()


def test_executor_worktree_write_lease_is_unique(tmp_path):
    store = _store(tmp_path)
    _, executor, reviewer = _profiles(store)
    task = store.create_task(conversation_id="conv-1")
    first = store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        worktree=str(tmp_path / "repo-a"),
    )
    second = store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        worktree=str(tmp_path / "repo-a"),
    )
    reviewer_attempt = store.create_attempt(
        task_id=task.id,
        agent_profile_id=reviewer.id,
        role=AgentRole.REVIEWER,
    )

    assert store.acquire_worktree_lease(
        worktree=tmp_path / "repo-a", task_id=task.id, attempt_id=first.id
    )
    assert not store.acquire_worktree_lease(
        worktree=tmp_path / "repo-a", task_id=task.id, attempt_id=second.id
    )
    with pytest.raises(OrchestrationStoreError, match="executor"):
        store.acquire_worktree_lease(
            worktree=tmp_path / "repo-b",
            task_id=task.id,
            attempt_id=reviewer_attempt.id,
        )
    assert store.release_worktree_lease(
        worktree=tmp_path / "repo-a", attempt_id=first.id
    )
    assert store.acquire_worktree_lease(
        worktree=tmp_path / "repo-a", task_id=task.id, attempt_id=second.id
    )
    store.close()


def test_default_parallel_child_agent_limit_is_enforced(tmp_path):
    store = _store(tmp_path)
    _, executor, reviewer = _profiles(store)
    task = store.create_task(conversation_id="conv-1")

    store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        attempt_id="attempt-1",
        worktree=str(tmp_path / "repo-1"),
    )
    store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        attempt_id="attempt-2",
        worktree=str(tmp_path / "repo-2"),
    )
    store.create_attempt(
        task_id=task.id,
        agent_profile_id=reviewer.id,
        role=AgentRole.REVIEWER,
        attempt_id="attempt-3",
    )

    assert store.active_child_attempt_count(task.id) == 3
    with pytest.raises(OrchestrationStoreError, match="parallel child agent limit"):
        store.create_attempt(
            task_id=task.id,
            agent_profile_id=executor.id,
            role=AgentRole.EXECUTOR,
            attempt_id="attempt-4",
            worktree=str(tmp_path / "repo-4"),
        )
    store.close()


def test_parallel_child_limit_is_atomic_across_store_connections(tmp_path):
    db_path = tmp_path / "orchestration.db"
    setup = OrchestrationStore(db_path)
    _, executor, _ = _profiles(setup)
    task = setup.create_task(conversation_id="conv-1")
    stores = [OrchestrationStore(db_path) for _ in range(4)]
    barrier = Barrier(4)

    def create(index: int) -> str:
        barrier.wait()
        try:
            stores[index].create_attempt(
                task_id=task.id,
                agent_profile_id=executor.id,
                role=AgentRole.EXECUTOR,
                attempt_id=f"cross-process-attempt-{index}",
                worktree=str(tmp_path / f"repo-{index}"),
            )
            return "created"
        except OrchestrationStoreError as exc:
            assert "parallel child agent limit" in str(exc)
            return "rejected"

    with ThreadPoolExecutor(max_workers=4) as pool:
        outcomes = list(pool.map(create, range(4)))

    assert outcomes.count("created") == 3
    assert outcomes.count("rejected") == 1
    assert setup.active_child_attempt_count(task.id) == 3
    for store in stores:
        store.close()
    setup.close()


def test_store_is_thread_safe_and_attempt_completion_releases_child_slot(tmp_path):
    store = _store(tmp_path)
    _, executor, reviewer = _profiles(store)
    task = store.create_task(conversation_id="conv-1")

    store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        attempt_id="attempt-1",
        worktree=str(tmp_path / "repo-1"),
    )
    store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        attempt_id="attempt-2",
        worktree=str(tmp_path / "repo-2"),
    )
    store.create_attempt(
        task_id=task.id,
        agent_profile_id=reviewer.id,
        role=AgentRole.REVIEWER,
        attempt_id="attempt-3",
    )
    assert store.active_child_attempt_count(task.id) == 3

    with ThreadPoolExecutor(max_workers=2) as pool:
        updated = pool.submit(
            store.update_attempt_status,
            "attempt-1",
            "completed",
            agent_session_id="acp-session-1",
        ).result()
        inserted = list(
            pool.map(
                lambda i: store.should_execute_once(
                    f"thread-event-{i}",
                    event_type="worker.done",
                    aggregate_type="attempt",
                    aggregate_id="attempt-1",
                ),
                range(10),
            )
        )

    assert updated.status == "completed"
    assert updated.agent_session_id == "acp-session-1"
    assert all(inserted)
    assert store.active_child_attempt_count(task.id) == 2
    store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        attempt_id="attempt-4",
        worktree=str(tmp_path / "repo-4"),
    )
    assert store.active_child_attempt_count(task.id) == 3
    store.close()


def test_attempt_terminal_status_releases_worktree_lease(tmp_path):
    store = _store(tmp_path)
    _, executor, _ = _profiles(store)
    task = store.create_task(conversation_id="conv-1")
    attempt = store.create_attempt(
        task_id=task.id,
        agent_profile_id=executor.id,
        role=AgentRole.EXECUTOR,
        worktree=str(tmp_path / "repo-a"),
    )
    assert store.acquire_worktree_lease(
        worktree=tmp_path / "repo-a", task_id=task.id, attempt_id=attempt.id
    )

    store.update_attempt_status(attempt.id, "failed")

    assert store.active_worktree_leases() == []
    store.close()
