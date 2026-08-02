from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import pytest

if "tomllib" not in sys.modules:
    import tomli

    sys.modules["tomllib"] = tomli

if "aisuite" not in sys.modules:
    aisuite = types.ModuleType("aisuite")

    class ToolMetadata:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)
            self.name = kwargs.get("name")
            self.requires_approval = kwargs.get("requires_approval", False)

    def tool(fn=None, *, metadata=None, **_kwargs):
        def wrap(func):
            func.__aisuite_tool_metadata__ = metadata
            return func

        return wrap(fn) if fn is not None else wrap

    class _Tools:
        def __init__(self, funcs):
            self._funcs = funcs

        def tools(self, format="openai"):
            return [
                {
                    "type": "function",
                    "function": {
                        "name": getattr(func, "__name__", "tool"),
                        "description": getattr(func, "__doc__", "") or "",
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
                for func in self._funcs
            ]

    aisuite.ToolMetadata = ToolMetadata
    aisuite.tool = tool
    aisuite.toolkits = SimpleNamespace(files=lambda **_: [], git=lambda **_: [])
    agents = types.ModuleType("aisuite.agents")
    agents.ToolMetadata = ToolMetadata
    agents.tool = tool
    utils = types.ModuleType("aisuite.utils")
    utils_tools = types.ModuleType("aisuite.utils.tools")
    utils_tools.Tools = _Tools
    sys.modules["aisuite"] = aisuite
    sys.modules["aisuite.agents"] = agents
    sys.modules["aisuite.utils"] = utils
    sys.modules["aisuite.utils.tools"] = utils_tools

from coworker.orchestration import ReviewResult, WorktreeManager
from coworker.server.manager import SessionManager


def _git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True,
        text=True,
        check=True,
    )


def _repo(root: Path) -> Path:
    root.mkdir(parents=True)
    _git(root, "init")
    _git(root, "config", "user.email", "tests@example.com")
    _git(root, "config", "user.name", "Test User")
    (root / "README.md").write_text("base\n", encoding="utf-8")
    (root / "pyproject.toml").write_text("[project]\nname='fixture'\n", encoding="utf-8")
    (root / "tests").mkdir()
    (root / "tests" / "test_fixture.py").write_text("def test_fixture():\n    assert True\n", encoding="utf-8")
    _git(root, "add", ".")
    _git(root, "commit", "-m", "init")
    return root


class FakeAgentAdapter:
    def __init__(self, *, review_verdicts: list[dict] | None = None) -> None:
        self.review_verdicts = list(review_verdicts or [{"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"}])
        self.opened: list[dict] = []
        self.prompts: list[dict] = []
        self.closed: list[str] = []
        self.cancelled: list[str] = []
        self._seq = 0

    async def open_session(self, profile, *, cwd, existing_session_id=None, checkpoint=None, **kwargs):
        self._seq += 1
        role = str(getattr(getattr(profile, "role", ""), "value", getattr(profile, "role", "")))
        session_id = existing_session_id or f"fake-{role}-{self._seq}"
        handle = SimpleNamespace(
            runtime_id=f"runtime-{self._seq}",
            profile_id=profile.id,
            role=role,
            session_id=session_id,
            cwd=str(cwd),
            capabilities={"fake": True},
            recovery_mode="resume" if existing_session_id else "new",
            process_id=None,
        )
        self.opened.append(
            {
                "profile_id": profile.id,
                "role": role,
                "cwd": str(cwd),
                "existing_session_id": existing_session_id,
                "checkpoint": checkpoint,
                "mcp_servers": kwargs.get("mcp_servers"),
            }
        )
        return handle

    async def prompt(self, handle, message: str):
        self.prompts.append({"session_id": handle.session_id, "role": handle.role, "message": message})
        if handle.role == "reviewer":
            payload = self.review_verdicts.pop(0)
            text = json.dumps(payload)
        else:
            text = "executor summary"
        return SimpleNamespace(
            session_id=handle.session_id,
            stop_reason="end_turn",
            text=text,
            events=({"type": "text", "text": text},),
        )

    async def cancel(self, handle) -> None:
        self.cancelled.append(handle.session_id)

    async def close(self, handle) -> None:
        self.closed.append(handle.session_id)


def _manager(tmp_path: Path, repo: Path, adapter: FakeAgentAdapter) -> SessionManager:
    mgr = SessionManager(workspace=repo, data_dir=tmp_path / "data")
    mgr.acp_adapter = adapter
    mgr.worktrees = WorktreeManager(mgr.orchestrator.store, worktree_root=tmp_path / "worktrees")
    _put_probed_profile(
        mgr,
        {
            "id": "opencode-main",
            "role": "main",
            "transport": "acp_stdio",
            "command": "opencode",
            "args": ["acp"],
        },
    )
    _put_probed_profile(
        mgr,
        {
            "id": "opencode-executor",
            "role": "executor",
            "transport": "acp_stdio",
            "command": "opencode",
            "args": ["acp"],
        },
    )
    _put_probed_profile(
        mgr,
        {
            "id": "opencode-reviewer",
            "role": "reviewer",
            "transport": "acp_stdio",
            "command": "opencode",
            "args": ["acp"],
            "workspace_policy": "readonly",
            "permission_policy": "read-only",
        },
    )
    mgr.orchestrator.set_workspace_main(repo, "opencode-main")
    return mgr


def _put_probed_profile(mgr: SessionManager, payload: dict) -> None:
    profile = mgr.agent_profiles.put({**payload, "enabled": False})
    profile = mgr.agent_profiles.save_capabilities(profile.id, {"fake": True})
    mgr.agent_profiles.put({**profile.to_dict(), "enabled": True})


def _delegate(mgr: SessionManager, repo: Path, *, max_rework_rounds: int = 2) -> str:
    task = mgr.delegate_agent_task(
        {
            "conversation_id": "main-session",
            "max_rework_rounds": max_rework_rounds,
            "task_spec": {
                "prompt": "implement fixture",
                "workspace": str(repo),
                "target_session_id": "main-session",
            },
        }
    )
    return str(task["task_id"])


def _executor_attempts(mgr: SessionManager, task_id: str) -> list[dict]:
    return [
        attempt
        for attempt in mgr.agent_task_result(task_id)["attempts"]
        if attempt["role"] == "executor"
    ]


@pytest.mark.asyncio
async def test_team_worker_runs_executor_tests_reviewer_and_done(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)

    task_id = _delegate(mgr, repo)
    await mgr._team_process_task(task_id)

    result = mgr.agent_task_result(task_id)
    assert result["state"] == "DONE"
    kinds = [artifact["kind"] for artifact in result["artifacts"]]
    assert {"worktree.plan", "execution", "verification"} <= set(kinds)
    assert "worktree.retained" in kinds
    assert result["reviews"][0]["verdict"] == "pass"
    executor_open = next(item for item in adapter.opened if item["role"] == "executor")
    assert Path(executor_open["cwd"]).is_dir()
    assert Path(executor_open["cwd"]).resolve() != repo.resolve()
    verification = next(item for item in result["artifacts"] if item["kind"] == "verification")
    assert verification["metadata"]["passed"] is True

    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_mission_worker_runs_readonly_explorer_before_executor(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)
    _put_probed_profile(
        mgr,
        {
            "id": "opencode-explorer",
            "role": "explorer",
            "transport": "acp_stdio",
            "command": "opencode",
            "args": ["acp"],
            "workspace_policy": "readonly",
            "permission_policy": "read-only",
        },
    )
    mission = mgr.create_mission(
        {
            "goal": "Implement with exploration",
            "workspace": str(repo),
            "conversation_id": "main-session",
            "plan": {
                "goal": "Implement with exploration",
                "members": [
                    {
                        "id": "main:opencode-main",
                        "role": "main",
                        "profile_id": "opencode-main",
                        "objective": "Coordinate",
                    },
                    {
                        "id": "explorer:opencode-explorer",
                        "role": "explorer",
                        "profile_id": "opencode-explorer",
                        "objective": "Map context",
                        "depends_on": ["main:opencode-main"],
                    },
                    {
                        "id": "executor:opencode-executor",
                        "role": "executor",
                        "profile_id": "opencode-executor",
                        "objective": "Implement",
                        "depends_on": ["explorer:opencode-explorer"],
                    },
                    {
                        "id": "reviewer:opencode-reviewer",
                        "role": "reviewer",
                        "profile_id": "opencode-reviewer",
                        "objective": "Review",
                        "depends_on": ["executor:opencode-executor"],
                    },
                ],
            },
        }
    )
    assert mission["attempts"] == []
    task_id = str(mission["mission_id"])
    mgr.confirm_mission(task_id, {"idempotency_key": "confirm-explorer"})

    await mgr._team_process_task(task_id)

    result = mgr.get_mission(task_id)
    assert result["state"] == "DONE"
    roles = [item["role"] for item in adapter.prompts]
    assert roles.index("explorer") < roles.index("executor")
    members = {item["id"]: item for item in result["members"]}
    assert members["explorer:opencode-explorer"]["status"] == "completed"
    assert members["explorer:opencode-explorer"]["attempt_id"]
    assert any(item["kind"] == "explorer.preflight" for item in result["artifacts"])

    explorer_attempt_id = str(members["explorer:opencode-explorer"]["attempt_id"])
    explorer_attempt = next(
        item for item in result["attempts"] if item["id"] == explorer_attempt_id
    )
    followup = await mgr.message_mission_with_delivery(
        task_id,
        {
            "message": "Re-check the repository map",
            "target": {"kind": "attempt", "attempt_id": explorer_attempt_id},
            "idempotency_key": "explorer-followup",
        },
    )

    assert followup["delivered"] is True
    assert mgr.get_mission(task_id)["state"] == "DONE"
    assert any(
        item["role"] == "explorer" and "[user-followup]" in item["message"]
        for item in adapter.prompts
    )
    assert any(
        item["role"] == "explorer"
        and item["existing_session_id"] == explorer_attempt["agent_session_id"]
        for item in adapter.opened
    )
    assert any(
        item["kind"] == "explorer.followup"
        for item in mgr.get_mission(task_id)["artifacts"]
    )

    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_mission_worker_skips_unsafe_gui_without_writer_collision(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)
    _put_probed_profile(
        mgr,
        {
            "id": "opencode-gui",
            "role": "gui",
            "transport": "acp_stdio",
            "command": "opencode",
            "args": ["acp"],
            "workspace_policy": "worktree",
            "permission_policy": "coding-default",
        },
    )
    mission = mgr.create_mission(
        {
            "goal": "Implement with GUI specialist",
            "workspace": str(repo),
            "conversation_id": "main-session",
            "plan": {
                "goal": "Implement with GUI specialist",
                "members": [
                    {
                        "id": "main:opencode-main",
                        "role": "main",
                        "profile_id": "opencode-main",
                        "objective": "Coordinate",
                    },
                    {
                        "id": "gui:opencode-gui",
                        "role": "gui",
                        "profile_id": "opencode-gui",
                        "objective": "GUI guidance",
                        "depends_on": ["main:opencode-main"],
                    },
                    {
                        "id": "executor:opencode-executor",
                        "role": "executor",
                        "profile_id": "opencode-executor",
                        "objective": "Implement",
                        "depends_on": ["main:opencode-main"],
                    },
                    {
                        "id": "reviewer:opencode-reviewer",
                        "role": "reviewer",
                        "profile_id": "opencode-reviewer",
                        "objective": "Review",
                        "depends_on": ["executor:opencode-executor"],
                    },
                ],
            },
        }
    )
    task_id = str(mission["mission_id"])
    mgr.confirm_mission(task_id, {"idempotency_key": "confirm-gui"})

    await mgr._team_process_task(task_id)

    result = mgr.get_mission(task_id)
    assert result["state"] == "DONE"
    assert "gui" not in [item["role"] for item in adapter.prompts]
    assert not [attempt for attempt in result["attempts"] if attempt["role"] == "gui"]
    members = {item["id"]: item for item in result["members"]}
    assert members["gui:opencode-gui"]["status"] == "skipped"
    assert any(item["kind"] == "gui.deferred" for item in result["artifacts"])
    assert mgr.orchestrator.store.active_worktree_leases() == []
    deferred_count = len(
        [item for item in result["artifacts"] if item["kind"] == "gui.deferred"]
    )

    await mgr._run_mission_preflight_members(result)

    replayed = mgr.get_mission(task_id)
    assert len(
        [item for item in replayed["artifacts"] if item["kind"] == "gui.deferred"]
    ) == deferred_count

    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_done_followup_reopens_same_executor_session_and_worktree(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter(
        review_verdicts=[
            {"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"},
            {"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"},
        ]
    )
    mgr = _manager(tmp_path, repo, adapter)
    task_id = _delegate(mgr, repo)
    await mgr._team_process_task(task_id)
    first_attempt = _executor_attempts(mgr, task_id)[-1]
    first_session = first_attempt["agent_session_id"]
    first_worktree = first_attempt["worktree"]

    queued = mgr.message_agent_task(
        task_id,
        "continue with a small follow-up",
        idempotency_key="followup-1",
    )
    duplicate = mgr.message_agent_task(
        task_id,
        "continue with a small follow-up",
        idempotency_key="followup-1",
    )
    assert queued["newly_enqueued"] is True
    assert duplicate["newly_enqueued"] is False
    assert mgr.agent_task_status(task_id)["state"] == "IMPLEMENTING"
    pending = mgr.orchestrator.pending_messages(task_id)
    assert len(pending) == 1
    assert pending[0]["message_id"] == queued["message_id"]

    await mgr._team_process_task(task_id)

    result = mgr.agent_task_result(task_id)
    assert result["state"] == "DONE"
    attempts = _executor_attempts(mgr, task_id)
    assert len(attempts) == 2
    assert attempts[-1]["agent_session_id"] == first_session
    assert attempts[-1]["worktree"] == first_worktree
    followup_prompts = [
        item for item in adapter.prompts if item["role"] == "executor" and "[user-followup]" in item["message"]
    ]
    assert len(followup_prompts) == 1
    assert "task_spec" not in followup_prompts[0]["message"]
    assert mgr.orchestrator.pending_messages(task_id) == []
    retained = [artifact for artifact in result["artifacts"] if artifact["kind"] == "worktree.retained"]
    assert len(retained) == 2

    deliveries_before = len(mgr.orchestrator.pending_deliveries())
    await mgr._team_process_task(task_id)
    assert len(mgr.orchestrator.pending_deliveries()) == deliveries_before
    assert [
        item for item in adapter.prompts if item["role"] == "executor" and "[user-followup]" in item["message"]
    ] == followup_prompts

    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_blocked_followup_reopens_and_can_finish(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter(
        review_verdicts=[
            {"verdict": "block", "findings": [], "test_gaps": ["blocked"], "confidence": "high"},
            {"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"},
        ]
    )
    mgr = _manager(tmp_path, repo, adapter)
    task_id = _delegate(mgr, repo)
    await mgr._team_process_task(task_id)
    assert mgr.agent_task_status(task_id)["state"] == "BLOCKED"
    source = _executor_attempts(mgr, task_id)[-1]

    mgr.message_agent_task(
        task_id,
        "address the blocker",
        idempotency_key="address-blocker-1",
    )
    await mgr._team_process_task(task_id)

    result = mgr.agent_task_result(task_id)
    assert result["state"] == "DONE"
    latest = _executor_attempts(mgr, task_id)[-1]
    assert latest["agent_session_id"] == source["agent_session_id"]
    assert latest["worktree"] == source["worktree"]

    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_cancelled_task_rejects_followup_reopen(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)
    task_id = _delegate(mgr, repo)
    mgr.cancel_agent_task(task_id)

    with pytest.raises(Exception, match="cancelled tasks cannot be reopened"):
        mgr.message_agent_task(task_id, "resume")

    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_team_worker_reuses_executor_session_for_rework(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter(
        review_verdicts=[
            {
                "verdict": "request_changes",
                "findings": [
                    {
                        "id": "F1",
                        "severity": "medium",
                        "path": "README.md",
                        "line": 1,
                        "title": "Need change",
                        "evidence": "base",
                        "suggested_fix": "adjust it",
                    }
                ],
                "test_gaps": [],
                "confidence": "high",
            },
            {"verdict": "pass", "findings": [], "test_gaps": [], "confidence": "high"},
        ]
    )
    mgr = _manager(tmp_path, repo, adapter)

    task_id = _delegate(mgr, repo)
    await mgr._team_process_task(task_id)

    result = mgr.agent_task_result(task_id)
    assert result["state"] == "DONE"
    executor_prompts = [item for item in adapter.prompts if item["role"] == "executor"]
    assert len(executor_prompts) == 2
    assert {item["session_id"] for item in executor_prompts} == {executor_prompts[0]["session_id"]}
    assert "Rework request" in executor_prompts[1]["message"]
    assert [review["verdict"] for review in result["reviews"]] == ["request_changes", "pass"]

    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_team_worker_blocks_on_failed_verification_without_review(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)
    task = mgr.delegate_agent_task(
        {
            "conversation_id": "main-session",
            "task_spec": {
                "prompt": "implement fixture",
                "workspace": str(repo),
                "test_commands": [
                    [sys.executable, "-m", "pytest", "-q", "tests/does_not_exist.py"]
                ],
            },
        }
    )

    await mgr._team_process_task(task["task_id"])

    result = mgr.agent_task_result(task["task_id"])
    assert result["state"] == "BLOCKED"
    assert result["reviews"] == []
    verification = next(item for item in result["artifacts"] if item["kind"] == "verification")
    assert verification["metadata"]["passed"] is False

    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_team_worker_rejects_arbitrary_verification_command(tmp_path: Path) -> None:
    repo = _repo(tmp_path / "repo")
    marker = tmp_path / "must-not-exist"
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)
    task = mgr.delegate_agent_task(
        {
            "conversation_id": "main-session",
            "task_spec": {
                "prompt": "implement fixture",
                "workspace": str(repo),
                "test_commands": [
                    [
                        sys.executable,
                        "-c",
                        f"from pathlib import Path; Path({str(marker)!r}).write_text('bad')",
                    ]
                ],
            },
        }
    )

    await mgr._team_process_task(task["task_id"])

    result = mgr.agent_task_result(task["task_id"])
    verification = next(
        item for item in result["artifacts"] if item["kind"] == "verification"
    )
    assert result["state"] == "BLOCKED"
    assert marker.exists() is False
    assert "allowlist" in verification["metadata"]["results"][0]["error"]
    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_worker_recovers_missing_terminal_finalization_after_restart(
    tmp_path: Path,
) -> None:
    repo = _repo(tmp_path / "repo")
    mgr = _manager(tmp_path, repo, FakeAgentAdapter())
    task_id = _delegate(mgr, repo)
    mgr.orchestrator.set_task_state(task_id, "IMPLEMENTING")
    attempt = mgr.start_agent_attempt(
        task_id,
        {
            "profile_id": "opencode-executor",
            "role": "executor",
            "agent_session_id": "executor-before-restart",
            "worktree_path": str(repo),
        },
    )
    for state in ("VERIFYING", "REVIEWING", "APPROVED", "DONE"):
        mgr.orchestrator.set_task_state(task_id, state)

    await mgr._team_worker_iteration()
    await asyncio.gather(*list(mgr._team_jobs.values()))

    result = mgr.agent_task_result(task_id)
    refreshed_attempt = next(
        item for item in result["attempts"] if item["attempt_id"] == attempt["attempt_id"]
    )
    assert refreshed_attempt["state"] == "completed"
    assert any(item["kind"] == "worktree.retained" for item in result["artifacts"])
    assert mgr._terminal_finalized(result, state="DONE") is True
    assert any(
        item["delivery_id"].startswith("delivery_terminal:")
        for item in mgr.orchestrator.pending_deliveries()
    )
    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_worker_reuses_review_committed_before_state_transition(
    tmp_path: Path,
) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)
    task_id = _delegate(mgr, repo)
    mgr.orchestrator.set_task_state(task_id, "IMPLEMENTING")
    executor = mgr.start_agent_attempt(
        task_id,
        {
            "profile_id": "opencode-executor",
            "role": "executor",
            "agent_session_id": "executor-session",
            "worktree_path": str(repo),
        },
    )
    execution = mgr.add_agent_artifact(
        task_id,
        {
            "kind": "execution",
            "attempt_id": executor["attempt_id"],
            "payload": {"text": "done"},
        },
    )
    mgr.add_agent_artifact(
        task_id,
        {
            "kind": "verification",
            "attempt_id": executor["attempt_id"],
            "payload": {"passed": True},
        },
    )
    mgr.orchestrator.set_task_state(task_id, "VERIFYING")
    mgr.orchestrator.set_task_state(task_id, "REVIEWING")
    reviewer = mgr.start_agent_attempt(
        task_id,
        {"profile_id": "opencode-reviewer", "role": "reviewer"},
    )
    mgr.orchestrator.store.record_review(
        ReviewResult(
            id="review-before-crash",
            task_id=task_id,
            reviewer_attempt_id=reviewer["attempt_id"],
            artifact_id=execution["artifact_id"],
            verdict="pass",
            findings=[],
            test_gaps=[],
            confidence="high",
        )
    )

    await mgr._team_process_task(task_id)

    result = mgr.agent_task_result(task_id)
    assert result["state"] == "DONE"
    assert len(result["reviews"]) == 1
    assert [item for item in adapter.prompts if item["role"] == "reviewer"] == []
    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_executor_prompt_unknown_outcome_is_not_replayed_after_restart(
    tmp_path: Path, monkeypatch
) -> None:
    repo = _repo(tmp_path / "repo")
    first_adapter = FakeAgentAdapter()
    first = _manager(tmp_path, repo, first_adapter)
    task_id = _delegate(first, repo)
    first.orchestrator.set_task_state(task_id, "IMPLEMENTING")
    original_add_artifact = first.add_agent_artifact

    def crash_before_execution_artifact(task_id_arg: str, payload: dict):
        if payload.get("kind") == "execution":
            raise RuntimeError("simulated process loss after prompt")
        return original_add_artifact(task_id_arg, payload)

    monkeypatch.setattr(first, "add_agent_artifact", crash_before_execution_artifact)
    with pytest.raises(RuntimeError, match="simulated process loss"):
        await first._run_executor_prompt(first.agent_task_result(task_id))
    assert len([p for p in first_adapter.prompts if p["role"] == "executor"]) == 1
    await first._close_team_runtime(task_id)
    first.orchestrator.close()

    second_adapter = FakeAgentAdapter()
    second = _manager(tmp_path, repo, second_adapter)
    with pytest.raises(RuntimeError, match="refusing automatic replay"):
        await second._run_executor_prompt(second.agent_task_result(task_id))
    assert [p for p in second_adapter.prompts if p["role"] == "executor"] == []
    await second._close_team_runtime(
        task_id, cancel=True, final_attempt_status="failed"
    )
    second.orchestrator.close()


@pytest.mark.asyncio
async def test_child_message_unknown_outcome_is_not_prompted_twice(
    tmp_path: Path, monkeypatch
) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)
    task_id = _delegate(mgr, repo)
    mgr.orchestrator.set_task_state(task_id, "IMPLEMENTING")
    task = mgr.agent_task_result(task_id)
    await mgr._ensure_executor_runtime(task)
    queued = mgr.message_agent_task(
        task_id,
        "inspect one more edge case",
        idempotency_key="message-once",
    )
    original_append = mgr.orchestrator.store.append_event

    def crash_before_completion(event):
        event_type = getattr(event, "event_type", None)
        if event_type is None and isinstance(event, dict):
            event_type = event.get("event_type")
        if event_type == "agent.message.prompt.completed":
            raise RuntimeError("simulated crash before delivery mark")
        return original_append(event)

    monkeypatch.setattr(mgr.orchestrator.store, "append_event", crash_before_completion)
    with pytest.raises(RuntimeError, match="simulated crash"):
        await mgr._deliver_pending_task_messages(task)
    followups = [
        p for p in adapter.prompts if p["role"] == "executor" and "[user-followup]" in p["message"]
    ]
    assert len(followups) == 1
    assert mgr.orchestrator.pending_messages(task_id)[0]["message_id"] == queued["message_id"]

    monkeypatch.setattr(mgr.orchestrator.store, "append_event", original_append)
    with pytest.raises(RuntimeError, match="refusing replay"):
        await mgr._deliver_pending_task_messages(task)
    assert [
        p for p in adapter.prompts if p["role"] == "executor" and "[user-followup]" in p["message"]
    ] == followups
    await mgr._close_team_runtime(
        task_id, cancel=True, final_attempt_status="failed"
    )
    mgr.orchestrator.close()


@pytest.mark.asyncio
async def test_team_worker_iteration_schedules_independent_jobs(tmp_path: Path, monkeypatch) -> None:
    repo = _repo(tmp_path / "repo")
    adapter = FakeAgentAdapter()
    mgr = _manager(tmp_path, repo, adapter)
    first = _delegate(mgr, repo)
    second = _delegate(mgr, repo)
    seen: list[str] = []

    async def fake_process(task_id: str) -> None:
        seen.append(task_id)
        await asyncio.sleep(10)

    monkeypatch.setattr(mgr, "_team_process_task", fake_process)

    await mgr._team_worker_iteration()
    await asyncio.sleep(0)

    assert set(seen) == {first, second}
    assert set(mgr._team_jobs) == {first, second}
    await mgr.stop_team_worker()
    mgr.orchestrator.close()
