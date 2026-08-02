import pytest

from coworker.orchestration import OrchestrationStoreError, TaskStatus
from coworker.orchestrator import QhOrchestratorStore


def _orchestrator(tmp_path):
    return QhOrchestratorStore(tmp_path / "orchestration.db")


def test_profiles_use_one_store_and_workspace_main_is_switchable(tmp_path):
    service = _orchestrator(tmp_path)
    main = service.get("opencode-main")
    main = service.save_capabilities(main.id, {"agentInfo": {"name": "OpenCode"}})
    service.put({**main.to_dict(), "enabled": True})
    assert service.get_workspace_main(tmp_path).id == "opencode-main"
    custom = service.put(
        {
            "id": "custom-main",
            "role": "main",
            "transport": "acp_stdio",
            "command": "custom-acp",
        }
    )
    custom = service.save_capabilities(custom.id, {"agentInfo": {"name": "Custom"}})
    service.put({**custom.to_dict(), "enabled": True})
    service.set_workspace_main(tmp_path, custom.id)
    assert service.get_workspace_main(tmp_path).capabilities["agentInfo"]["name"] == "Custom"
    service.close()


def test_profile_enable_requires_current_probe_fingerprint(tmp_path):
    service = _orchestrator(tmp_path)
    profile = service.put(
        {
            "id": "custom-main",
            "role": "main",
            "transport": "acp_stdio",
            "command": "custom-acp",
            "enabled": False,
            "capabilities": {"session": {"resume": True}},
        }
    )

    with pytest.raises(ValueError, match="successful probe"):
        service.put({**profile.to_dict(), "enabled": True})

    probed = service.save_capabilities(profile.id, {"session": {"resume": True}})
    enabled = service.put({**probed.to_dict(), "enabled": True})
    assert enabled.enabled is True

    changed = service.put({**enabled.to_dict(), "command": "custom-acp-v2"})
    assert changed.enabled is False
    assert changed.capabilities == {}
    assert changed.capability_probe_fingerprint is None
    service.close()


def test_delegate_messages_results_and_delivery_are_durable_and_idempotent(tmp_path):
    service = _orchestrator(tmp_path)
    task = service.delegate(
        {"prompt": "implement it", "target_session_id": "main-session"},
        conversation_id="conversation-1",
    )
    assert task["state"] == "QUEUED"
    assert task["target_profile_id"] == "opencode-executor"

    with pytest.raises(OrchestrationStoreError, match="idempotency_key"):
        service.message(task["task_id"], "missing retry identity")
    queued = service.message(
        task["task_id"],
        "use the existing helper",
        idempotency_key="use-existing-helper-1",
    )
    assert service.pending_messages(task["task_id"])[0]["message"] == "use the existing helper"
    assert service.mark_message_delivered(task["task_id"], queued["message_id"])
    assert service.pending_messages(task["task_id"]) == []

    delivery = service.enqueue_main_delivery(
        conversation_id="conversation-1",
        target_session_id="main-session",
        source_task_id=task["task_id"],
        payload={"summary": "worker finished"},
        delivery_id="delivery-fixed",
    )
    duplicate = service.enqueue_main_delivery(
        conversation_id="conversation-1",
        target_session_id="main-session",
        source_task_id=task["task_id"],
        payload={"summary": "worker finished"},
        delivery_id="delivery-fixed",
    )
    assert delivery["newly_enqueued"] is True
    assert duplicate["newly_enqueued"] is False
    assert len(service.pending_deliveries("main-session")) == 1
    assert service.mark_delivered(delivery["delivery_id"])["newly_delivered"] is True
    assert service.mark_delivered(delivery["delivery_id"])["newly_delivered"] is False
    assert service.pending_deliveries("main-session") == []
    service.close()


def test_review_pass_cannot_override_failed_test_gate(tmp_path):
    service = _orchestrator(tmp_path)
    task_id = service.delegate({"prompt": "change code"})["task_id"]
    service.set_task_state(task_id, TaskStatus.IMPLEMENTING.value)
    attempt = service.start_attempt(
        task_id,
        profile_id="opencode-executor",
        role="executor",
        worktree_path=str(tmp_path / "worktree"),
    )
    service.set_task_state(task_id, TaskStatus.VERIFYING.value)
    artifact = service.add_artifact(
        task_id,
        kind="verification",
        attempt_id=attempt["attempt_id"],
        payload={"passed": False},
    )
    service.request_review(artifact["artifact_id"])
    result = service.record_review(
        task_id,
        artifact["artifact_id"],
        {"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"},
        tests_passed=False,
    )
    assert result["effective_verdict"] == "request_changes"
    assert result["state"] == "CHANGES_REQUESTED"
    assert result["review"]["verdict"] == "request_changes"
    assert result["tests_passed"] is False
    duplicate = service.record_review(
        task_id,
        artifact["artifact_id"],
        {"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"},
        tests_passed=False,
    )
    assert duplicate["review"]["id"] == result["review"]["id"]
    assert len(service.store.list_reviews(task_id)) == 1
    assert duplicate["state"] == "CHANGES_REQUESTED"
    service.close()


def test_committed_review_retry_finishes_state_transition_without_duplicate(
    tmp_path, monkeypatch
):
    service = _orchestrator(tmp_path)
    task_id = service.delegate({"prompt": "change code"})["task_id"]
    service.set_task_state(task_id, TaskStatus.IMPLEMENTING.value)
    attempt = service.start_attempt(
        task_id,
        profile_id="opencode-executor",
        role="executor",
        worktree_path=str(tmp_path / "worktree"),
    )
    service.set_task_state(task_id, TaskStatus.VERIFYING.value)
    artifact = service.add_artifact(
        task_id,
        kind="verification",
        attempt_id=attempt["attempt_id"],
        payload={"passed": True},
    )
    service.request_review(artifact["artifact_id"])

    original = service._apply_review_outcome
    monkeypatch.setattr(
        service,
        "_apply_review_outcome",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("crash after commit")),
    )
    with pytest.raises(RuntimeError, match="crash after commit"):
        service.record_review(
            task_id,
            artifact["artifact_id"],
            {"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"},
        )
    assert len(service.store.list_reviews(task_id)) == 1
    assert service.status(task_id)["state"] == "REVIEWING"

    monkeypatch.setattr(service, "_apply_review_outcome", original)
    recovered = service.record_review(
        task_id,
        artifact["artifact_id"],
        {"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"},
    )
    assert recovered["state"] == "DONE"
    assert len(service.store.list_reviews(task_id)) == 1
    service.close()
