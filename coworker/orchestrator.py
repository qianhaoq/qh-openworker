"""Application-facing facade over the durable multi-agent control-plane store.

The domain package owns persistence and invariants.  This facade keeps FastAPI, MCP and
the desktop manager on one small JSON-shaped API without creating a second profile or task
database.  Agent processes remain outside this module.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Iterable, Optional

from .orchestration import (
    AgentProfile,
    AgentRole,
    DEFAULT_MAX_REWORK_ROUNDS,
    LedgerEvent,
    MissionMember,
    MissionPlan,
    OrchestrationStore,
    OrchestrationStoreError,
    ReviewFinding,
    ReviewResult,
    TaskStatus,
)
from .orchestration.models import now_iso


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


class QhOrchestratorStore:
    """Stable control-plane API consumed by REST and the Team MCP server."""

    DEFAULT_MAX_REWORK_ROUNDS = DEFAULT_MAX_REWORK_ROUNDS

    def __init__(self, path: str | Path) -> None:
        self.store = OrchestrationStore(path)
        self.store.seed_default_profiles()

    def close(self) -> None:
        self.store.close()

    # Profiles -------------------------------------------------------------
    def list(self) -> list[AgentProfile]:
        return self.store.list_profiles()

    def get(self, profile_id: str) -> Optional[AgentProfile]:
        return self.store.get_profile(profile_id)

    def put(self, profile: AgentProfile | dict[str, Any]) -> AgentProfile:
        return self.store.put_profile(profile)

    def delete(self, profile_id: str) -> bool:
        return self.store.delete_profile(profile_id)

    def save_capabilities(self, profile_id: str, capabilities: dict[str, Any]) -> AgentProfile:
        profile = self.store.get_profile(profile_id)
        if not profile:
            raise KeyError(profile_id)
        profile.capabilities = dict(capabilities)
        profile.capability_probe_fingerprint = profile.identity_fingerprint()
        return self.store.put_profile(profile)

    def get_workspace_main(self, workspace: str | Path) -> AgentProfile:
        profile = self.store.get_workspace_main_profile(workspace)
        if profile:
            return profile
        profile = self.store.get_profile("opencode-main")
        if not profile:
            raise OrchestrationStoreError("default main profile is missing")
        self.store.set_workspace_main_profile(workspace, profile.id)
        return profile

    def set_workspace_main(self, workspace: str | Path, profile_id: str) -> dict[str, str]:
        self.store.set_workspace_main_profile(workspace, profile_id)
        return {
            "workspace": str(Path(workspace).expanduser().resolve()),
            "main_profile_id": profile_id,
        }

    # Mission API ----------------------------------------------------------
    def create_mission(
        self,
        payload: dict[str, Any],
        *,
        main_profile_id: Optional[str] = None,
        defer_plan_proposal: bool = False,
    ) -> dict[str, Any]:
        """Create a reviewable Mission without starting any Agent process.

        Mission is a projection over the existing Task aggregate.  The structured
        plan is stored inside ``task_spec.plan`` so legacy Team workers and the new
        desktop shell share one durable state machine.
        """

        body = dict(payload or {})
        idempotency_key = str(body.get("idempotency_key") or "").strip()
        create_event_id = self._mission_request_event_id("create", idempotency_key)
        if create_event_id:
            existing = self.store.get_event(create_event_id)
            if existing is not None and existing.payload.get("mission_id"):
                return self.get_mission(str(existing.payload["mission_id"]))

        raw_spec = body.get("task_spec")
        spec = dict(raw_spec) if isinstance(raw_spec, dict) else {}
        goal = str(
            body.get("goal")
            or spec.get("goal")
            or spec.get("prompt")
            or body.get("title")
            or ""
        ).strip()
        if not goal:
            raise ValueError("mission goal is required")
        conversation_id = str(
            body.get("conversation_id")
            or spec.get("conversation_id")
            or _id("conversation")
        )
        max_rework_rounds = int(
            body.get(
                "max_rework_rounds",
                spec.get("max_rework_rounds", DEFAULT_MAX_REWORK_ROUNDS),
            )
        )
        raw_plan = body.get("plan") or spec.get("plan") or {}
        plan_data = dict(raw_plan) if isinstance(raw_plan, dict) else {}
        plan_data["goal"] = str(plan_data.get("goal") or goal)
        plan_data["status"] = "draft" if defer_plan_proposal else "proposed"
        plan_data["max_rework_rounds"] = max_rework_rounds
        if not plan_data.get("members") and not plan_data.get("team"):
            plan_data["members"] = [
                member.to_dict()
                for member in self._default_mission_members(main_profile_id)
            ]
        plan = MissionPlan.from_dict(plan_data)
        self._validate_mission_plan(plan, require_executor=True)

        requested_target = str(
            body.get("target_profile_id")
            or spec.get("target_profile_id")
            or ""
        ).strip()
        target_profile_id = self._mission_target_profile(plan, requested_target)
        control = dict(spec.get("_orchestration") or {})
        control.update(
            {
                "target_profile_id": target_profile_id,
                "target_session_id": body.get("target_session_id")
                or spec.get("target_session_id")
                or conversation_id,
                "mission": True,
            }
        )
        spec.update(
            {
                "goal": goal,
                "prompt": str(spec.get("prompt") or goal),
                "plan": plan.to_dict(),
                "_orchestration": control,
            }
        )
        if body.get("workspace") and not spec.get("workspace"):
            spec["workspace"] = str(body["workspace"])
        task = self.store.create_task(
            conversation_id=conversation_id,
            title=str(body.get("title") or spec.get("title") or goal)[:160],
            task_spec=spec,
            max_rework_rounds=max_rework_rounds,
            initial_status=TaskStatus.PLANNING,
        )
        if create_event_id:
            self.store.append_event(
                LedgerEvent(
                    event_id=create_event_id,
                    event_type="mission.created",
                    aggregate_type="task",
                    aggregate_id=task.id,
                    payload={"mission_id": task.id},
                )
            )
        else:
            self.store.append_event(
                LedgerEvent(
                    event_id=f"{task.id}:mission_created",
                    event_type="mission.created",
                    aggregate_type="task",
                    aggregate_id=task.id,
                    payload={"mission_id": task.id},
                )
            )
        if not defer_plan_proposal:
            self.store.append_event(
                LedgerEvent(
                    event_id=f"{task.id}:plan_proposed:{plan.version}",
                    event_type="mission.plan_proposed",
                    aggregate_type="task",
                    aggregate_id=task.id,
                    payload={"plan": plan.to_dict(), "source": "control_plane"},
                )
            )
            self.store.transition_task(
                task.id,
                TaskStatus.AWAITING_CONFIRMATION,
                event_id=f"{task.id}:transition:planning:awaiting_confirmation",
            )
        return self.get_mission(task.id)

    def propose_mission_plan(
        self,
        mission_id: str,
        plan_payload: dict[str, Any],
        *,
        source: str,
        agent_session_id: Optional[str] = None,
        fallback_reason: Optional[str] = None,
    ) -> dict[str, Any]:
        """Persist the first reviewable plan for a PLANNING Mission.

        ``source`` is deliberately explicit so a control-plane fallback can never be
        presented as a main-Agent result.  This method only proposes a plan; execution
        remains impossible until :meth:`confirm_mission` transitions it to ``QUEUED``.
        """

        task = self.store.get_task(mission_id)
        if not task:
            raise KeyError(mission_id)
        if task.status != TaskStatus.PLANNING:
            raise OrchestrationStoreError("mission is no longer awaiting its first plan")
        old_raw = task.task_spec.get("plan")
        old_plan = (
            MissionPlan.from_dict(old_raw)
            if isinstance(old_raw, dict) and old_raw.get("goal")
            else MissionPlan(goal=str(task.task_spec.get("goal") or task.title), status="draft")
        )
        merged = old_plan.to_dict()
        merged.update(dict(plan_payload or {}))
        merged.update(
            {
                "version": old_plan.version,
                "status": "proposed",
                "created_at": old_plan.created_at,
                "updated_at": now_iso(),
            }
        )
        plan = MissionPlan.from_dict(merged)
        self._validate_mission_plan(plan, require_executor=True)
        target_profile_id = self._mission_target_profile(plan, "")
        spec = dict(task.task_spec)
        spec["plan"] = plan.to_dict()
        control = dict(spec.get("_orchestration") or {})
        control.update(
            {
                "target_profile_id": target_profile_id,
                "plan_proposal_source": str(source),
                "plan_proposal_agent_session_id": agent_session_id,
                "plan_proposal_fallback_reason": fallback_reason,
            }
        )
        spec["_orchestration"] = control
        self.store.update_task_spec(
            mission_id,
            spec,
            max_rework_rounds=plan.max_rework_rounds,
        )
        payload: dict[str, Any] = {"plan": plan.to_dict(), "source": str(source)}
        if agent_session_id:
            payload["agent_session_id"] = agent_session_id
        if fallback_reason:
            payload["fallback_reason"] = fallback_reason
        self.store.append_event(
            LedgerEvent(
                event_id=f"{mission_id}:plan_proposed:{plan.version}",
                event_type="mission.plan_proposed",
                aggregate_type="task",
                aggregate_id=mission_id,
                payload=payload,
            )
        )
        self.store.transition_task(
            mission_id,
            TaskStatus.AWAITING_CONFIRMATION,
            event_id=f"{mission_id}:transition:planning:awaiting_confirmation",
        )
        return self.get_mission(mission_id)

    def list_missions(
        self, states: Optional[Iterable[str]] = None
    ) -> list[dict[str, Any]]:
        wanted = {TaskStatus(state) for state in states} if states else None
        return [
            self.get_mission(task.id)
            for task in self.store.list_tasks()
            if wanted is None or task.status in wanted
        ]

    def get_mission(self, mission_id: str) -> dict[str, Any]:
        task = self.store.get_task(mission_id)
        if not task:
            raise KeyError(mission_id)
        attempts = self.store.list_attempts(mission_id)
        artifacts = self.store.list_artifacts(mission_id)
        reviews = self.store.list_reviews(mission_id)
        events = self.store.list_events(
            aggregate_type="task", aggregate_id=mission_id
        )
        raw_plan = task.task_spec.get("plan")
        plan: Optional[MissionPlan] = None
        if isinstance(raw_plan, dict) and raw_plan.get("goal"):
            plan = MissionPlan.from_dict(raw_plan)
        members = self._mission_members_with_runtime(plan, attempts)
        timeline = [self._mission_event_view(event) for event in events]
        permissions_by_id: dict[str, dict[str, Any]] = {}
        for event in events:
            if event.event_type not in {"permission.required", "permission.resolved"}:
                continue
            permission_id = str(event.payload.get("permission_id") or "")
            if not permission_id:
                continue
            permissions_by_id.setdefault(permission_id, {}).update(event.payload)
        last_cursor = events[-1].event_id if events else None
        control = task.task_spec.get("_orchestration") or {}
        return {
            "mission_id": task.id,
            "task_id": task.id,
            "conversation_id": task.conversation_id,
            "title": task.title,
            "goal": plan.goal if plan else str(task.task_spec.get("goal") or task.title),
            "status": task.status.value,
            "state": task.status.value,
            "plan": plan.to_dict() if plan else None,
            "members": members,
            "timeline": timeline,
            "last_cursor": last_cursor,
            "task_spec": dict(task.task_spec),
            "target_profile_id": control.get("target_profile_id"),
            "target_session_id": control.get("target_session_id"),
            "plan_proposal": {
                "source": control.get("plan_proposal_source") or "control_plane",
                "agent_session_id": control.get("plan_proposal_agent_session_id"),
                "fallback_reason": control.get("plan_proposal_fallback_reason"),
            },
            "attempts": [attempt.to_dict() for attempt in attempts],
            "artifacts": [artifact.to_dict() for artifact in artifacts],
            "reviews": [review.to_dict() for review in reviews],
            "permissions": list(permissions_by_id.values()),
            "messages": [
                self._mission_event_view(event)
                for event in events
                if event.event_type.startswith("agent.message.")
                or event.event_type == "mission.message_enqueued"
            ],
            "needs_user_action": task.status
            in {
                TaskStatus.AWAITING_CONFIRMATION,
                TaskStatus.CHANGES_REQUESTED,
                TaskStatus.BLOCKED,
            },
            "max_rework_rounds": task.max_rework_rounds,
            "created_at": task.created_at,
            "updated_at": task.updated_at,
        }

    def update_mission_plan(
        self, mission_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        task = self.store.get_task(mission_id)
        if not task:
            raise KeyError(mission_id)
        if task.status not in {
            TaskStatus.PLANNING,
            TaskStatus.AWAITING_CONFIRMATION,
        }:
            raise OrchestrationStoreError(
                "mission plan can only change before confirmation"
            )
        body = dict(payload or {})
        idempotency_key = str(body.get("idempotency_key") or "").strip()
        event_id = self._mission_request_event_id(
            f"{mission_id}:update_plan", idempotency_key
        )
        if event_id and self.store.get_event(event_id) is not None:
            return self.get_mission(mission_id)
        old_raw = task.task_spec.get("plan")
        old_plan = (
            MissionPlan.from_dict(old_raw)
            if isinstance(old_raw, dict) and old_raw.get("goal")
            else MissionPlan(goal=str(task.task_spec.get("goal") or task.title))
        )
        update = body.get("plan") if isinstance(body.get("plan"), dict) else body
        merged = old_plan.to_dict()
        merged.update(
            {key: value for key, value in dict(update).items() if key != "idempotency_key"}
        )
        merged.update(
            {
                "version": old_plan.version + 1,
                "status": "proposed",
                "created_at": old_plan.created_at,
                "updated_at": now_iso(),
            }
        )
        plan = MissionPlan.from_dict(merged)
        self._validate_mission_plan(plan)
        target_profile_id = self._mission_target_profile(plan, "")
        spec = dict(task.task_spec)
        spec["plan"] = plan.to_dict()
        control = dict(spec.get("_orchestration") or {})
        control["target_profile_id"] = target_profile_id
        spec["_orchestration"] = control
        self.store.update_task_spec(
            mission_id,
            spec,
            max_rework_rounds=plan.max_rework_rounds,
        )
        self.store.append_event(
            LedgerEvent(
                event_id=event_id or f"{mission_id}:plan_updated:{plan.version}",
                event_type="mission.plan_updated",
                aggregate_type="task",
                aggregate_id=mission_id,
                payload={"plan": plan.to_dict()},
            )
        )
        if task.status == TaskStatus.PLANNING:
            self.store.transition_task(
                mission_id,
                TaskStatus.AWAITING_CONFIRMATION,
                event_id=f"{mission_id}:transition:planning:awaiting:{plan.version}",
            )
        return self.get_mission(mission_id)

    def confirm_mission(
        self, mission_id: str, *, idempotency_key: Optional[str] = None
    ) -> dict[str, Any]:
        task = self.store.get_task(mission_id)
        if not task:
            raise KeyError(mission_id)
        raw_plan = task.task_spec.get("plan")
        if not isinstance(raw_plan, dict):
            raise OrchestrationStoreError("mission has no structured plan")
        plan = MissionPlan.from_dict(raw_plan)
        self._validate_mission_plan(plan, require_executor=True)
        if task.status != TaskStatus.AWAITING_CONFIRMATION:
            if plan.status == "confirmed" and task.status not in {
                TaskStatus.PLANNING,
                TaskStatus.AWAITING_CONFIRMATION,
            }:
                result = self.get_mission(mission_id)
                result["newly_confirmed"] = False
                return result
            raise OrchestrationStoreError(
                "mission must be awaiting confirmation before execution"
            )
        plan.status = "confirmed"
        plan.updated_at = now_iso()
        spec = dict(task.task_spec)
        spec["plan"] = plan.to_dict()
        self.store.update_task_spec(mission_id, spec)
        event_id = self._mission_request_event_id(
            f"{mission_id}:confirm", str(idempotency_key or "").strip()
        ) or f"{mission_id}:plan_confirmed:{plan.version}"
        self.store.append_event(
            LedgerEvent(
                event_id=event_id,
                event_type="mission.plan_confirmed",
                aggregate_type="task",
                aggregate_id=mission_id,
                payload={"plan": plan.to_dict()},
            )
        )
        self.store.transition_task(
            mission_id,
            TaskStatus.QUEUED,
            event_id=f"{mission_id}:transition:confirmed:queued:{plan.version}",
        )
        result = self.get_mission(mission_id)
        result["newly_confirmed"] = True
        return result

    def message_mission(
        self,
        mission_id: str,
        message: str,
        *,
        target: dict[str, Any],
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        return self.message(
            mission_id,
            message,
            idempotency_key=idempotency_key,
            target=target,
        )

    def mission_events(
        self,
        mission_id: str,
        *,
        after_cursor: Optional[str] = None,
        limit: int = 200,
    ) -> dict[str, Any]:
        if not self.store.get_task(mission_id):
            raise KeyError(mission_id)
        events = self.store.list_events(
            aggregate_type="task",
            aggregate_id=mission_id,
            after_cursor=after_cursor,
            limit=limit,
        )
        return {
            "mission_id": mission_id,
            "events": [self._mission_event_view(event) for event in events],
            "last_cursor": events[-1].event_id if events else after_cursor,
        }

    @staticmethod
    def _mission_request_event_id(action: str, idempotency_key: str) -> Optional[str]:
        if not idempotency_key:
            return None
        value = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"qh-openworker:mission:{action}:{idempotency_key}",
        )
        return f"mission_request_{value.hex}"

    def _default_mission_members(
        self, main_profile_id: Optional[str]
    ) -> list[MissionMember]:
        profiles = [profile for profile in self.store.list_profiles() if profile.enabled]
        by_role: dict[AgentRole, AgentProfile] = {}
        for profile in profiles:
            by_role.setdefault(profile.role, profile)
        if main_profile_id:
            selected_main = self.store.get_profile(main_profile_id)
            if (
                not selected_main
                or not selected_main.enabled
                or selected_main.role != AgentRole.MAIN
            ):
                raise OrchestrationStoreError(
                    "mission main profile must be enabled and role=main"
                )
            by_role[AgentRole.MAIN] = selected_main
        members: list[MissionMember] = []
        objectives = {
            AgentRole.MAIN: "Coordinate the Mission and synthesize results",
            AgentRole.EXPLORER: "Explore the workspace and provide implementation context",
            AgentRole.EXECUTOR: "Implement and verify the requested change",
            AgentRole.GUI: "Handle GUI-specific implementation and visual evidence",
            AgentRole.REVIEWER: "Review fixed artifacts without write access",
        }
        ordered_roles = [
            AgentRole.MAIN,
            AgentRole.EXPLORER,
            AgentRole.EXECUTOR,
            AgentRole.GUI,
            AgentRole.REVIEWER,
        ]
        for role in ordered_roles:
            profile = by_role.get(role)
            if not profile:
                continue
            depends_on: list[str] = []
            if (
                role in {AgentRole.EXPLORER, AgentRole.EXECUTOR, AgentRole.GUI}
                and members
            ):
                depends_on = [members[0].id]
            if role == AgentRole.REVIEWER:
                writer = next(
                    (item for item in members if item.role == AgentRole.EXECUTOR),
                    None,
                )
                depends_on = [writer.id] if writer else ([members[0].id] if members else [])
            members.append(
                MissionMember(
                    id=f"{role.value}:{profile.id}",
                    role=role,
                    profile_id=profile.id,
                    objective=objectives[role],
                    depends_on=depends_on,
                )
            )
        return members

    def _validate_mission_plan(
        self, plan: MissionPlan, *, require_executor: bool = False
    ) -> None:
        plan.validate()
        for member in plan.members:
            profile = self.store.get_profile(member.profile_id)
            if not profile or not profile.enabled:
                raise OrchestrationStoreError(
                    f"unknown or disabled mission profile: {member.profile_id}"
                )
            if profile.role != member.role:
                raise OrchestrationStoreError(
                    f"mission member role does not match profile: {member.profile_id}"
                )
        if require_executor and not any(
            member.role == AgentRole.EXECUTOR for member in plan.members
        ):
            raise OrchestrationStoreError(
                "confirmed coding missions require an executor profile"
            )

    @staticmethod
    def _mission_target_profile(plan: MissionPlan, requested: str) -> str:
        specialists = [
            member
            for member in plan.members
            if member.role in {AgentRole.EXECUTOR, AgentRole.EXPLORER, AgentRole.GUI}
        ]
        if requested:
            if not any(member.profile_id == requested for member in specialists):
                raise OrchestrationStoreError(
                    "target_profile_id must be a specialist in the mission plan"
                )
            return requested
        executor = next(
            (member for member in specialists if member.role == AgentRole.EXECUTOR),
            None,
        )
        if executor:
            return executor.profile_id
        if specialists:
            return specialists[0].profile_id
        raise OrchestrationStoreError("mission plan requires a specialist profile")

    @staticmethod
    def _mission_members_with_runtime(
        plan: Optional[MissionPlan], attempts: list[Any]
    ) -> list[dict[str, Any]]:
        latest: dict[tuple[str, str], Any] = {}
        for attempt in attempts:
            latest[(attempt.agent_profile_id, attempt.role.value)] = attempt
        members = list(plan.members) if plan else []
        output: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for member in members:
            key = (member.profile_id, member.role.value)
            attempt = latest.get(key)
            data = member.to_dict()
            if attempt is not None:
                data.update(
                    {
                        "attempt_id": attempt.id,
                        "agent_session_id": attempt.agent_session_id,
                        "status": attempt.status,
                    }
                )
            output.append(data)
            seen.add(key)
        for key, attempt in latest.items():
            if key in seen:
                continue
            output.append(
                MissionMember(
                    id=f"{attempt.role.value}:{attempt.agent_profile_id}",
                    role=attempt.role,
                    profile_id=attempt.agent_profile_id,
                    objective="",
                    attempt_id=attempt.id,
                    agent_session_id=attempt.agent_session_id,
                    status=attempt.status,
                ).to_dict()
            )
        return output

    @staticmethod
    def _mission_event_view(event: LedgerEvent) -> dict[str, Any]:
        return {
            "cursor": event.event_id,
            "event_id": event.event_id,
            "type": event.event_type,
            "event_type": event.event_type,
            "aggregate_type": event.aggregate_type,
            "aggregate_id": event.aggregate_id,
            "payload": dict(event.payload),
            "created_at": event.created_at,
        }

    # Task API -------------------------------------------------------------
    def delegate(
        self,
        task_spec: dict[str, Any] | str,
        *,
        conversation_id: Optional[str] = None,
        target_profile_id: Optional[str] = None,
        max_rework_rounds: int = DEFAULT_MAX_REWORK_ROUNDS,
    ) -> dict[str, Any]:
        spec = dict(task_spec) if isinstance(task_spec, dict) else {"prompt": str(task_spec)}
        conversation = str(
            conversation_id or spec.pop("conversation_id", "") or _id("conversation")
        )
        target = str(
            target_profile_id
            or spec.pop("target_profile_id", "")
            or "opencode-executor"
        )
        profile = self.store.get_profile(target)
        if not profile or not profile.enabled:
            raise OrchestrationStoreError(f"unknown or disabled target profile: {target}")
        if profile.role not in {AgentRole.EXECUTOR, AgentRole.EXPLORER, AgentRole.GUI}:
            raise OrchestrationStoreError("delegated target must be a specialist profile")
        control = dict(spec.get("_orchestration") or {})
        control.update(
            {
                "target_profile_id": target,
                "target_session_id": spec.pop("target_session_id", None) or conversation_id,
            }
        )
        spec["_orchestration"] = control
        task = self.store.create_task(
            conversation_id=conversation,
            title=str(spec.get("title") or spec.get("prompt") or "Delegated task")[:160],
            task_spec=spec,
            max_rework_rounds=int(max_rework_rounds),
        )
        self.store.append_event(
            LedgerEvent(
                event_id=f"{task.id}:delegated",
                event_type="task.delegated",
                aggregate_type="task",
                aggregate_id=task.id,
                payload={"target_profile_id": target},
            )
        )
        return self.status(task.id)

    def status(self, task_id: str) -> dict[str, Any]:
        task = self.store.get_task(task_id)
        if not task:
            raise KeyError(task_id)
        result = task.to_dict()
        result.update(
            {
                "task_id": task.id,
                "state": task.status.value,
                "target_profile_id": (task.task_spec.get("_orchestration") or {}).get(
                    "target_profile_id"
                ),
                "target_session_id": (task.task_spec.get("_orchestration") or {}).get(
                    "target_session_id"
                ),
            }
        )
        return result

    def result(self, task_id: str) -> dict[str, Any]:
        result = self.status(task_id)
        result["attempts"] = self.attempts(task_id)
        result["artifacts"] = [
            artifact.to_dict() for artifact in self.store.list_artifacts(task_id)
        ]
        result["reviews"] = [review.to_dict() for review in self.store.list_reviews(task_id)]
        result["messages"] = [
            event.to_dict()
            for event in self.store.list_events(aggregate_type="task", aggregate_id=task_id)
            if event.event_type.startswith("agent.message.")
        ]
        return result

    def list_tasks(self, states: Optional[Iterable[str]] = None) -> list[dict[str, Any]]:
        wanted = {TaskStatus(state) for state in states} if states else None
        return [
            self.status(task.id)
            for task in self.store.list_tasks()
            if wanted is None or task.status in wanted
        ]

    def set_task_state(self, task_id: str, state: str) -> dict[str, Any]:
        current = self.store.get_task(task_id)
        if not current:
            raise KeyError(task_id)
        target = TaskStatus(state)
        if current.status == target:
            return self.status(task_id)
        self.store.transition_task(
            task_id,
            target,
            event_id=(
                f"{task_id}:transition:{current.status.value}:"
                f"{target.value}:{uuid.uuid4().hex}"
            ),
        )
        if target == TaskStatus.DONE:
            self.store.append_event(
                LedgerEvent(
                    event_id=f"{task_id}:mission_completed",
                    event_type="mission.completed",
                    aggregate_type="task",
                    aggregate_id=task_id,
                    payload={"state": target.value},
                )
            )
        return self.status(task_id)

    def message(
        self,
        task_id: str,
        message: str,
        *,
        idempotency_key: Optional[str] = None,
        target: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        task = self.store.get_task(task_id)
        if not task:
            raise KeyError(task_id)
        if task.status == TaskStatus.CANCELLED:
            raise OrchestrationStoreError("cancelled tasks cannot be reopened")
        text = str(message).strip()
        if not text:
            raise ValueError("message is required")
        stable_key = str(idempotency_key or "").strip()
        if not stable_key:
            raise OrchestrationStoreError(
                "idempotency_key is required for team messages"
            )
        message_uuid = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"qh-openworker:{task_id}:{stable_key}",
        )
        message_id = f"message_{message_uuid.hex}"
        message_target = dict(target or {})
        target_kind = str(message_target.get("kind") or "").strip()
        if target_kind == "main":
            existing_message = self.store.get_event(message_id)
            if existing_message is not None and (
                existing_message.event_type != "mission.message_enqueued"
                or str(existing_message.payload.get("message") or "") != text
                or dict(existing_message.payload.get("target") or {})
                != {"kind": "main"}
            ):
                raise OrchestrationStoreError(
                    "idempotency_key was already used for a different message"
                )
            inserted = self.store.append_event(
                LedgerEvent(
                    event_id=message_id,
                    event_type="mission.message_enqueued",
                    aggregate_type="task",
                    aggregate_id=task_id,
                    payload={
                        "message_id": message_id,
                        "message": text,
                        "target": {"kind": "main"},
                    },
                )
            )
            control = dict(task.task_spec.get("_orchestration") or {})
            target_session_id = str(
                control.get("target_session_id") or task.conversation_id or ""
            ).strip()
            if not target_session_id:
                raise OrchestrationStoreError(
                    "mission main message requires a target session"
                )
            self.enqueue_main_delivery(
                conversation_id=task.conversation_id,
                target_session_id=target_session_id,
                source_task_id=task_id,
                payload={
                    "summary": text,
                    "message_id": message_id,
                    "target": {"kind": "main"},
                },
                delivery_id=f"{message_id}:main",
            )
            return {
                "ok": True,
                "mission_id": task_id,
                "task_id": task_id,
                "message_id": message_id,
                "target": {"kind": "main"},
                "newly_enqueued": inserted,
                "reopened": False,
            }
        target_attempt = None
        if target_kind == "attempt":
            attempt_id = str(message_target.get("attempt_id") or "").strip()
            if not attempt_id:
                raise ValueError("attempt target requires attempt_id")
            target_attempt = self.store.get_attempt(attempt_id)
            if target_attempt is None or target_attempt.task_id != task_id:
                raise OrchestrationStoreError(
                    "message target attempt does not belong to mission"
                )
            message_target = {"kind": "attempt", "attempt_id": attempt_id}
        elif target_kind:
            raise ValueError("message target kind must be main or attempt")
        reopen = task.status in {TaskStatus.DONE, TaskStatus.BLOCKED}
        reopen_payload: Optional[dict[str, Any]] = None
        reopen_terminal = True
        if target_attempt is not None and target_attempt.role != AgentRole.EXECUTOR:
            if not target_attempt.agent_session_id:
                raise OrchestrationStoreError(
                    "attempt follow-up requires a recoverable agent session"
                )
            reopen_terminal = False
        if reopen and reopen_terminal:
            executor_attempts = [
                attempt
                for attempt in self.store.list_attempts(task_id)
                if attempt.role == AgentRole.EXECUTOR
                and attempt.agent_session_id
                and attempt.worktree
            ]
            if target_attempt is not None:
                executor_attempts = [
                    attempt
                    for attempt in executor_attempts
                    if attempt.id == target_attempt.id
                ]
            if not executor_attempts:
                raise OrchestrationStoreError(
                    "follow-up requires a previous executor session and retained worktree"
                )
            source = executor_attempts[-1]
            reopen_payload = {
                "source_attempt_id": source.id,
                "agent_session_id": source.agent_session_id,
                "worktree": source.worktree,
            }
        inserted, reopened = self.store.enqueue_task_message(
            task_id=task_id,
            message_id=message_id,
            message=text,
            reopen_payload=reopen_payload,
            target=message_target,
            reopen_terminal=reopen_terminal,
        )
        return {
            "ok": True,
            "task_id": task_id,
            "message_id": message_id,
            "target": message_target or None,
            "newly_enqueued": inserted,
            "reopened": reopened,
        }

    def pending_messages(self, task_id: str) -> list[dict[str, Any]]:
        events = self.store.list_events(aggregate_type="task", aggregate_id=task_id)
        delivered = {
            str(event.payload.get("message_id"))
            for event in events
            if event.event_type == "agent.message.delivered"
        }
        return [
            dict(event.payload)
            for event in events
            if event.event_type == "agent.message.enqueued"
            and str(event.payload.get("message_id")) not in delivered
        ]

    def mark_message_delivered(self, task_id: str, message_id: str) -> bool:
        return self.store.append_event(
            LedgerEvent(
                event_id=f"{message_id}:delivered",
                event_type="agent.message.delivered",
                aggregate_type="task",
                aggregate_id=task_id,
                payload={"message_id": message_id},
            )
        )

    def cancel(self, task_id: str) -> dict[str, Any]:
        task = self.store.get_task(task_id)
        if not task:
            raise KeyError(task_id)
        if task.status not in {TaskStatus.DONE, TaskStatus.BLOCKED, TaskStatus.CANCELLED}:
            self.set_task_state(task_id, TaskStatus.CANCELLED.value)
        for attempt in self.store.list_attempts(task_id):
            if attempt.status not in {"completed", "failed", "cancelled"}:
                self.store.update_attempt_status(attempt.id, "cancelled")
        return self.status(task_id)

    # Attempts / artifacts / review ---------------------------------------
    def start_attempt(
        self,
        task_id: str,
        *,
        profile_id: str,
        role: str,
        agent_session_id: Optional[str] = None,
        worktree_path: Optional[str] = None,
        rework_round: int = 0,
    ) -> dict[str, Any]:
        task = self.store.get_task(task_id)
        if not task:
            raise KeyError(task_id)
        if task.status in {
            TaskStatus.PLANNING,
            TaskStatus.AWAITING_CONFIRMATION,
        }:
            raise OrchestrationStoreError(
                "mission attempts cannot start before plan confirmation"
            )
        attempt = self.store.create_attempt(
            task_id=task_id,
            agent_profile_id=profile_id,
            role=role,
            agent_session_id=agent_session_id,
            worktree=worktree_path,
            rework_round=rework_round,
        )
        self.store.append_event(
            LedgerEvent(
                event_id=f"{attempt.id}:mission_member_started",
                event_type="mission.member_updated",
                aggregate_type="task",
                aggregate_id=task_id,
                payload={"member": attempt.to_dict()},
            )
        )
        self._update_mission_member_runtime(
            task_id,
            profile_id=profile_id,
            role=role,
            status=attempt.status,
            attempt_id=attempt.id,
            agent_session_id=attempt.agent_session_id,
        )
        return {"attempt_id": attempt.id, **attempt.to_dict()}

    def attempts(self, task_id: str) -> list[dict[str, Any]]:
        return [
            {"attempt_id": attempt.id, "state": attempt.status, **attempt.to_dict()}
            for attempt in self.store.list_attempts(task_id)
        ]

    def update_attempt(
        self, attempt_id: str, status: str, *, agent_session_id: Optional[str] = None
    ) -> dict[str, Any]:
        attempt = self.store.update_attempt_status(
            attempt_id, status, agent_session_id=agent_session_id
        )
        self._update_mission_member_runtime(
            attempt.task_id,
            profile_id=attempt.agent_profile_id,
            role=attempt.role.value,
            status=attempt.status,
            attempt_id=attempt.id,
            agent_session_id=attempt.agent_session_id,
        )
        self.store.append_event(
            LedgerEvent(
                event_id=f"{attempt.id}:mission_member:{attempt.updated_at}",
                event_type="mission.member_updated",
                aggregate_type="task",
                aggregate_id=attempt.task_id,
                payload={"member": attempt.to_dict()},
            )
        )
        return {"attempt_id": attempt.id, **attempt.to_dict()}

    def update_mission_member_status(
        self,
        task_id: str,
        *,
        member_id: Optional[str] = None,
        profile_id: Optional[str] = None,
        role: Optional[str] = None,
        status: str,
        attempt_id: Optional[str] = None,
        agent_session_id: Optional[str] = None,
        event_id: Optional[str] = None,
        details: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        member = self._update_mission_member_runtime(
            task_id,
            member_id=member_id,
            profile_id=profile_id,
            role=role,
            status=status,
            attempt_id=attempt_id,
            agent_session_id=agent_session_id,
        )
        payload = {"member": member}
        if details:
            payload["details"] = dict(details)
        self.store.append_event(
            LedgerEvent(
                event_id=event_id
                or f"{task_id}:mission_member:{member['id']}:{status}:{uuid.uuid4().hex}",
                event_type="mission.member_updated",
                aggregate_type="task",
                aggregate_id=task_id,
                payload=payload,
            )
        )
        return member

    def _update_mission_member_runtime(
        self,
        task_id: str,
        *,
        member_id: Optional[str] = None,
        profile_id: Optional[str] = None,
        role: Optional[str] = None,
        status: Optional[str] = None,
        attempt_id: Optional[str] = None,
        agent_session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        task = self.store.get_task(task_id)
        if not task:
            raise KeyError(task_id)
        raw_plan = task.task_spec.get("plan")
        if not isinstance(raw_plan, dict) or not raw_plan.get("goal"):
            return {}
        plan = MissionPlan.from_dict(raw_plan)
        selected: Optional[MissionMember] = None
        for member in plan.members:
            role_match = role is None or member.role.value == str(role)
            profile_match = profile_id is None or member.profile_id == str(profile_id)
            id_match = member_id is None or member.id == str(member_id)
            if role_match and profile_match and id_match:
                selected = member
                break
        if selected is None:
            return {}
        if status is not None:
            selected.status = str(status)
        if attempt_id is not None:
            selected.attempt_id = str(attempt_id)
        if agent_session_id is not None:
            selected.agent_session_id = str(agent_session_id)
        plan.updated_at = now_iso()
        spec = dict(task.task_spec)
        spec["plan"] = plan.to_dict()
        self.store.update_task_spec(
            task_id,
            spec,
            max_rework_rounds=plan.max_rework_rounds,
        )
        return selected.to_dict()

    def save_agent_session(
        self,
        *,
        session_id: str,
        conversation_id: str,
        profile_id: str,
        task_id: Optional[str] = None,
        attempt_id: Optional[str] = None,
        status: str = "active",
        capabilities: Optional[dict[str, Any]] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        return self.store.upsert_agent_session(
            agent_session_id=session_id,
            conversation_id=conversation_id,
            task_id=task_id,
            attempt_id=attempt_id,
            agent_profile_id=profile_id,
            status=status,
            capabilities=capabilities,
            metadata=metadata,
        )

    def add_artifact(
        self,
        task_id: str,
        *,
        kind: str,
        attempt_id: Optional[str] = None,
        path: Optional[str] = None,
        payload: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        artifact_id = _id("artifact")
        artifact = self.store.create_artifact(
            task_id=task_id,
            attempt_id=attempt_id,
            artifact_id=artifact_id,
            kind=kind,
            uri=str(path or f"artifact://{task_id}/{artifact_id}"),
            metadata=payload or {},
        )
        self.store.append_event(
            LedgerEvent(
                event_id=f"{artifact.id}:mission_artifact_added",
                event_type="mission.artifact_added",
                aggregate_type="task",
                aggregate_id=task_id,
                payload={"artifact": artifact.to_dict()},
            )
        )
        return {"artifact_id": artifact.id, **artifact.to_dict()}

    def request_review(
        self, artifact_id: str, *, reviewer_profile_id: Optional[str] = None
    ) -> dict[str, Any]:
        artifact = self.store.get_artifact(artifact_id)
        if not artifact:
            raise KeyError(artifact_id)
        task = self.store.get_task(artifact.task_id)
        if not task:
            raise KeyError(artifact.task_id)
        if task.status == TaskStatus.VERIFYING:
            self.set_task_state(task.id, TaskStatus.REVIEWING.value)
        elif task.status != TaskStatus.REVIEWING:
            raise OrchestrationStoreError("review requires task state VERIFYING or REVIEWING")
        review_task_id = _id("review_task")
        self.store.append_event(
            LedgerEvent(
                event_id=review_task_id,
                event_type="review.requested",
                aggregate_type="task",
                aggregate_id=task.id,
                payload={
                    "review_task_id": review_task_id,
                    "artifact_id": artifact_id,
                    "reviewer_profile_id": reviewer_profile_id or "opencode-reviewer",
                },
            )
        )
        return {
            "review_task_id": review_task_id,
            "task_id": task.id,
            "artifact_id": artifact_id,
            "state": TaskStatus.REVIEWING.value,
        }

    def record_review(
        self,
        task_id: str,
        artifact_id: str,
        result: ReviewResult | dict[str, Any],
        *,
        reviewer_profile_id: Optional[str] = None,
        reviewer_attempt_id: Optional[str] = None,
        tests_passed: bool = True,
    ) -> dict[str, Any]:
        raw = result.to_dict() if isinstance(result, ReviewResult) else dict(result)
        if reviewer_attempt_id is None:
            reviewer_attempts = [
                attempt
                for attempt in self.store.list_attempts(task_id)
                if attempt.role == AgentRole.REVIEWER
            ]
            if reviewer_attempts:
                reviewer_attempt_id = reviewer_attempts[-1].id
            else:
                profile_id = reviewer_profile_id or "opencode-reviewer"
                stable_attempt_id = (
                    "attempt_"
                    + uuid.uuid5(
                        uuid.NAMESPACE_URL,
                        f"qh-openworker:review-attempt:{task_id}:{artifact_id}:{profile_id}",
                    ).hex
                )
                try:
                    reviewer_attempt_id = self.store.create_attempt(
                        task_id=task_id,
                        agent_profile_id=profile_id,
                        role=AgentRole.REVIEWER,
                        attempt_id=stable_attempt_id,
                    ).id
                except Exception:
                    existing = self.store.get_attempt(stable_attempt_id)
                    if existing is None:
                        raise
                    reviewer_attempt_id = existing.id
        review_uuid = uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"qh-openworker:review:{task_id}:{artifact_id}:{reviewer_attempt_id}",
        )
        review_id = f"review_{review_uuid.hex}"
        reported_verdict = str(raw.get("verdict") or "request_changes")
        test_gaps = [str(item) for item in (raw.get("test_gaps") or [])]
        if not tests_passed and reported_verdict == "pass":
            effective_verdict = "request_changes"
            gate_gap = "verification gate failed; reviewer pass cannot approve the task"
            if gate_gap not in test_gaps:
                test_gaps.append(gate_gap)
        else:
            effective_verdict = reported_verdict
        review = ReviewResult(
            id=review_id,
            task_id=task_id,
            reviewer_attempt_id=reviewer_attempt_id,
            artifact_id=artifact_id,
            verdict=effective_verdict,
            findings=[
                item if isinstance(item, ReviewFinding) else ReviewFinding.from_dict(item)
                for item in (raw.get("findings") or [])
            ],
            test_gaps=test_gaps,
            confidence=str(raw.get("confidence") or "medium"),
        ).validate()
        review, _ = self.store.record_review_once(review)
        self.store.append_event(
            LedgerEvent(
                event_id=f"{review.id}:mission_review_updated",
                event_type="mission.review_updated",
                aggregate_type="task",
                aggregate_id=task_id,
                payload={"review": review.to_dict()},
            )
        )
        self.store.update_attempt_status(reviewer_attempt_id, "completed")

        effective_verdict = review.verdict
        self._apply_review_outcome(task_id, effective_verdict)
        response = self.status(task_id)
        response.update(
            {
                "review": review.to_dict(),
                "effective_verdict": effective_verdict,
                "tests_passed": not any(
                    gap.startswith("verification gate failed")
                    for gap in review.test_gaps
                ),
            }
        )
        return response

    def _apply_review_outcome(self, task_id: str, verdict: str) -> None:
        """Idempotently finish the state transition for a committed review."""

        current = self.store.get_task(task_id)
        if current is None:
            raise KeyError(task_id)
        if verdict == "pass":
            if current.status == TaskStatus.REVIEWING:
                self.set_task_state(task_id, TaskStatus.APPROVED.value)
                current = self.store.get_task(task_id)
            if current is not None and current.status == TaskStatus.APPROVED:
                self.set_task_state(task_id, TaskStatus.DONE.value)
            return
        if verdict == "block":
            if current.status == TaskStatus.REVIEWING:
                self.set_task_state(task_id, TaskStatus.BLOCKED.value)
            return
        if current.status == TaskStatus.REVIEWING:
            self.set_task_state(task_id, TaskStatus.CHANGES_REQUESTED.value)

    # Durable main-session delivery queue ---------------------------------
    def enqueue_main_delivery(
        self,
        *,
        conversation_id: Optional[str],
        target_session_id: Optional[str],
        source_task_id: str,
        payload: dict[str, Any],
        delivery_id: Optional[str] = None,
    ) -> dict[str, Any]:
        resolved_delivery_id = delivery_id or _id("delivery")
        inserted = self.store.append_event(
            LedgerEvent(
                event_id=resolved_delivery_id,
                event_type="main.delivery.enqueued",
                aggregate_type="delivery",
                aggregate_id=resolved_delivery_id,
                payload={
                    "delivery_id": resolved_delivery_id,
                    "conversation_id": conversation_id,
                    "target_session_id": target_session_id,
                    "source_task_id": source_task_id,
                    "payload": dict(payload),
                },
            )
        )
        return {
            "ok": True,
            "delivery_id": resolved_delivery_id,
            "newly_enqueued": inserted,
        }

    def pending_deliveries(
        self, target_session_id: Optional[str] = None
    ) -> list[dict[str, Any]]:
        events = self.store.list_events()
        delivered = {
            event.aggregate_id
            for event in events
            if event.event_type == "main.delivery.delivered"
        }
        pending = [
            dict(event.payload)
            for event in events
            if event.event_type == "main.delivery.enqueued"
            and event.aggregate_id not in delivered
        ]
        if target_session_id is not None:
            pending = [
                item for item in pending if item.get("target_session_id") == target_session_id
            ]
        return pending

    def mark_delivered(self, delivery_id: str) -> dict[str, Any]:
        known = any(
            event.event_type == "main.delivery.enqueued"
            for event in self.store.list_events(
                aggregate_type="delivery", aggregate_id=delivery_id
            )
        )
        if not known:
            raise KeyError(delivery_id)
        inserted = self.store.append_event(
            LedgerEvent(
                event_id=f"{delivery_id}:delivered",
                event_type="main.delivery.delivered",
                aggregate_type="delivery",
                aggregate_id=delivery_id,
            )
        )
        return {"ok": True, "delivery_id": delivery_id, "newly_delivered": inserted}


__all__ = ["QhOrchestratorStore", "ReviewResult"]
