"""Session manager — owns engines (one per session), stores, and the provider.

Each session is bound to a workspace folder (Code requires one). Storage is a single DB
under a data dir (global for the real server, per-workspace for tests), so recents and
sessions span folders.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

from ..agent import build_engine
from ..acp import (
    AcpAgentAdapter,
    AcpMcpServer,
    PermissionRequest,
    PiJsonlRpcAdapter,
)
from ..acp.process_env import build_minimal_env
from ..agents import get_agent
from ..connections import (
    PersonaConnectionStore,
    SessionConnectionStore,
    effective as effective_connections,
)
from ..inbox import InboxStore, args_preview
from ..inbox_routing import InboxRouting
from ..personas import PersonaRegistry
from ..personas.registry import set_registry as set_persona_registry
from ..selfwake import WakeStore
from ..mentions import MentionSessionStore
from ..subscriptions import ChannelBuffer, SubscriptionStore
from ..unrouted import UnroutedStore
from ..unattended import UnattendedRegistry
from ..audit import AuditStore
from ..config import load_config, workspace_allowed_commands
from ..conversations import ConversationStore, title_from
from ..engine import ApprovalOutcome, Approver, TurnEngine
from ..roots import RootDir
from ..workspace_trust import WorkspaceTrustStore
from ..automation import Schedule, ScheduledTask, Scheduler, TaskRun, TaskStore
from ..connectors import (
    Gateway,
    MessageSource,
    connect_connector,
    connector_list,
    disconnect_connector,
    experimental_enabled,
    load_settings,
    make_adapter,
    set_experimental_enabled,
    slack_split,
    update_connector_tools,
)
from ..connectors.browser_automation import (
    browser_close_session,
    browser_state,
    browser_take_screenshot,
)
from ..connectors.parked import ParkedStore
from ..mcp import (
    MCPManager,
    build_callables,
    delete_global_server,
    load_mcp_servers,
    patch_global_server,
    put_global_server,
    read_global,
)
from ..main_acp import MainAcpHost
from ..memory import MemoryStore, Scope, SQLiteMemoryStore
from ..orchestration import (
    AgentProfile,
    AgentRole,
    OrchestrationStoreError,
    Transport,
    WorktreeManager,
)
from ..permissions import Mode
from ..orchestrator import QhOrchestratorStore
from ..agents import list_agents as _list_agents
from ..providers import (
    ProviderClient,
    ProviderRouter,
    descriptor_configured,
    get_descriptor,
    provider_credential_source,
    provider_descriptors,
    resolve_provider_fields,
    verify_provider_key,
)
from ..secrets import SecretStore, state_dir
from ..sessions import SessionRecord
from ..skills import SkillLoader

_SCOPES = {s.value for s in Scope}

logger = logging.getLogger("coworker.manager")


def _grants_of(engine) -> dict[str, Any]:
    """The engine's session-scoped "Always allow" approvals, in persistable shape."""
    tools = sorted(getattr(engine.permissions, "session_allow_tools", None) or ())
    commands = sorted(getattr(engine.permissions, "session_allow_commands", None) or ())
    return {"tools": tools, "commands": commands} if (tools or commands) else {}


def _approval_body(request) -> str:
    """Approval card body: the tool's reason (if any) plus a compact preview of its args, so a
    mirrored 'Run `write_file`?' shows the path/content rather than just the tool name.
    """
    reason = (getattr(request, "reason", "") or "").strip()
    preview = args_preview(getattr(request, "arguments", None))
    return "\n".join(p for p in (reason, preview) if p)


class SessionManager:
    def __init__(
        self,
        *,
        workspace: Optional[str | Path] = None,  # default/seed workspace (e.g. --cwd)
        data_dir: Optional[str | Path] = None,
        model: str = "gpt-5.6-sol",
        mode: Mode = Mode.INTERACTIVE,
        provider: Optional[ProviderClient] = None,
    ) -> None:
        self.default_workspace = (
            str(Path(workspace).expanduser().resolve()) if workspace else None
        )
        self.model = model
        self.mode = mode
        self._provider_injected = provider is not None
        self.provider = provider

        if data_dir is not None:
            base = Path(data_dir).expanduser()
        elif self.default_workspace is not None:
            base = Path(self.default_workspace) / ".coworker"
        else:
            base = state_dir()
        base.mkdir(parents=True, exist_ok=True)

        self.memory_store: MemoryStore = SQLiteMemoryStore(base / "coworker.db")
        self.audit_store = AuditStore(base / "coworker.db")
        self.session_store = ConversationStore(base)
        self.orchestrator = QhOrchestratorStore(base / "qh_orchestrator.db")
        # Profiles and task state intentionally share one SQLite/ledger store.
        self.agent_profiles = self.orchestrator
        self.acp_adapter = AcpAgentAdapter(
            update_sink=self._handle_acp_update,
            permission_resolver=self._resolve_agent_permission,
        )
        self.pi_adapter = PiJsonlRpcAdapter(update_sink=self._handle_acp_update)
        self.main_acp_host = MainAcpHost(
            orchestrator=self.orchestrator,
            conversations=self.session_store,
            memory=self.memory_store,
            acp_adapter=self.acp_adapter,
            pi_adapter=self.pi_adapter,
            mcp_servers_factory=self._main_acp_mcp_servers,
            update_sink=self._handle_main_acp_update,
        )
        self.worktrees = WorktreeManager(
            self.orchestrator.store,
            worktree_root=state_dir() / "worktrees",
        )
        self._team_active: dict[str, dict[str, Any]] = {}
        self._team_jobs: dict[str, asyncio.Task[None]] = {}
        self._agent_permission_waiters: dict[str, asyncio.Future[Optional[str]]] = {}
        self._agent_permission_requests: dict[str, dict[str, Any]] = {}
        self._team_worker_task: Optional[asyncio.Task[None]] = None
        self._team_worker_interval = 1.0
        self.session_store.canonicalize_workspaces()  # collapse /tmp vs /private/tmp etc.
        if self.default_workspace:
            self.session_store.touch_workspace(self.default_workspace)
        self._engines: dict[str, TurnEngine] = {}
        self._running_sessions: set[str] = (
            set()
        )  # sessions with an in-flight turn (busy)
        # Sessions with an auto-title LLM call in flight (FB-010) — one call at a time.
        self._autotitle_inflight: set[str] = set()
        self._autotitle_tasks: set[asyncio.Task] = set()
        self._autotitle_attempts: dict[str, int] = {}
        self.workspace_trust = WorkspaceTrustStore()
        self.secrets = SecretStore()
        # No explicit provider injected → route by the model's `provider:` prefix (OpenAI default,
        # Ollama, …). Tests inject a provider directly and bypass the router. The same router is
        # shared by every engine and the `/v1/chat/completions` proxy.
        if self.provider is None:
            self.provider = ProviderRouter(
                self.secrets, default_provider="openai", on_use=self._note_provider_use
            )
        self.mcp = MCPManager(secrets=self.secrets)
        # OAuth MCP servers with a sign-in in flight / their last connect error —
        # feeds list_mcp's status so the GUI can show "authorizing…" and failures.
        self._mcp_authorizing: set[str] = set()
        self._mcp_errors: dict[str, str] = {}
        self.gateway: Optional[Gateway] = None
        self._data_base = base
        # Desktop/UI prefs (default model, onboarding state) — not secrets; a plain JSON file.
        self._prefs = self._load_prefs()
        if self._prefs.get("default_model"):
            self.model = self._prefs["default_model"]
        # Seed the PDF-fallback module global from prefs so engines see the user's
        # choice from the first turn (set_pdf_settings keeps it in sync after).
        from ..pdf_support import set_fallback_mode

        set_fallback_mode(self.pdf_settings()["pdf_fallback"])
        # Per-session live-view registry: every socket open on a session id gets the turn's events,
        # whoever drives the turn (foreground user_message, channel delivery, self-wake, resume).
        # Delivery itself is socket-independent — this only governs *live visibility*.
        self._session_clients: dict[str, set[Any]] = {}
        # App-wide event sockets (/ws/events): session-independent pushes — today the
        # automation-run-started toast (UX-026); badges could ride it later.
        self._event_clients: set[Any] = set()
        # Automation: scheduled tasks store + the tick scheduler (started in the lifespan).
        # The scheduler also resumes self-wake'd sessions each tick (extra_tick).
        self.task_store = TaskStore(base / "automation.db")
        self.scheduler = Scheduler(
            self.task_store, self._run_scheduled_task, extra_tick=self.resume_due_wakes
        )
        # Personas: registry + lifecycle state under this manager's data dir. Installed as the
        # process singleton so agents.get_agent resolves persona ids (incl. third-party) here.
        self.personas = PersonaRegistry(state_path=base / "personas.json")
        set_persona_registry(self.personas)
        # Inbox (cross-session human-attention queue), routing (named inboxes + Slack/Telegram
        # bindings), the Unattended toggle, and self-wake records.
        self.inbox = InboxStore(base / "inbox.json")
        self.inbox_routing = InboxRouting(base / "inbox_routing.json")
        self.unattended = UnattendedRegistry(base / "unattended.json")
        self.wakes = WakeStore(base / "wakes.json")
        # Channel subscriptions (inbound): persisted (session_id, channel) records + a ring buffer
        # of recently-seen channel messages for get_channel_messages.
        self.subscriptions = SubscriptionStore(base / "subscriptions.json")
        self.channel_buffer = ChannelBuffer(state_path=base / "channels.json")
        # Mention router (§31): thread target → the session that owns that Slack thread.
        # Also the durable source of the thread's standing send_message grant (re-seeded
        # onto the engine in get_engine).
        self.mention_sessions = MentionSessionStore(base / "mention_threads.json")
        # Unauthorized inbound messages, parked instead of dropped (one-step allow-and-deliver).
        self.parked = ParkedStore(base / "parked.json")
        # People directory: "platform:user_id" → display name, noted from every inbound
        # (authorized or parked) so allow-list chips read "Rohit Prsad", not "U07JK…".
        self._people_path = base / "people.json"
        try:
            self._people: dict[str, str] = json.loads(self._people_path.read_text())
        except (OSError, ValueError):
            self._people = {}
        # Seed from already-parked messages (they carry resolved names) so an allow made from
        # an old parked item still gets a named chip.
        for it in self.parked.list():
            if it.get("user_name"):
                self._people.setdefault(
                    f"{it['platform']}:{it['user_id']}", it["user_name"]
                )
        # Connection hierarchy (UI-REFRESH §4): per-persona default connector on/off (seeded from the
        # manifest, then user-editable) + per-session overrides. Resolved into the session's effective
        # connector set, which gates inbound delivery and the engine's connector tools.
        self.persona_connections = PersonaConnectionStore(
            base / "persona_connections.json"
        )
        self.session_connections = SessionConnectionStore(
            base / "session_connections.json"
        )
        # Dead-letter: inbound messages with no destination + background-turn failures, so neither
        # vanishes silently (a debugging/visibility surface, not a redelivery queue).
        self.unrouted = UnroutedStore(base / "unrouted.json")

    # -- workspaces -------------------------------------------------------------
    def open_workspace(self, path: str, *, create: bool = False) -> dict[str, Any]:
        resolved = Path(path).expanduser()
        if resolved.exists() and not resolved.is_dir():
            return {"path": str(resolved), "ok": False, "error": "not a directory"}
        if not resolved.exists():
            if not create:
                return {
                    "path": str(resolved),
                    "ok": False,
                    "error": "folder does not exist",
                }
            try:
                resolved.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                return {"path": str(resolved), "ok": False, "error": str(exc)}
        resolved = resolved.resolve()
        self.session_store.touch_workspace(str(resolved))
        return {
            "path": str(resolved),
            "ok": True,
            "git_branch": _git_branch(resolved),
            "command_trust": self.workspace_command_trust(resolved),
        }

    def workspace_command_trust(self, path: str | Path) -> dict[str, Any]:
        if not str(path).strip():
            return {
                "workspace": "",
                "requested_commands": [],
                "trusted": False,
                "required": False,
            }
        canonical = WorkspaceTrustStore.canonical(path)
        commands = (
            workspace_allowed_commands(canonical)
            if Path(canonical).is_dir()
            else []
        )
        trusted = self.workspace_trust.is_trusted(canonical)
        return {
            "workspace": canonical,
            "requested_commands": commands,
            "trusted": trusted,
            "required": bool(commands and not trusted),
        }

    def _mcp_workspace_trusted(self, workspace: Optional[str | Path]) -> bool:
        """Whether workspace `.coworker/mcp.json` may be loaded (#213).

        Same consent boundary as repository ``allowed_commands``: an untrusted
        clone must not define stdio processes that spawn at session open.
        """
        return bool(workspace and self.workspace_trust.is_trusted(workspace))

    def set_workspace_trust(
        self, path: str | Path, *, trusted: bool
    ) -> dict[str, Any]:
        if not str(path).strip():
            return {"ok": False, "error": "workspace path is required"}
        candidate = Path(path).expanduser()
        if trusted and not candidate.is_dir():
            return {"ok": False, "error": "workspace is not a directory"}
        canonical = self.workspace_trust.set_trusted(candidate, trusted)
        effective = load_config(
            canonical, workspace_trusted=trusted
        ).allowed_commands
        # Apply trust/revocation immediately to live sessions rooted at this exact path.
        for engine in self._engines.values():
            engine_workspace = str(
                (getattr(engine, "audit_context", {}) or {}).get("workspace", "")
            )
            if engine_workspace and WorkspaceTrustStore.canonical(
                engine_workspace
            ) == canonical:
                engine.permissions.allowed_commands = list(effective)
        return {
            "ok": True,
            **self.workspace_command_trust(canonical),
        }

    def trusted_workspaces(self) -> list[dict[str, Any]]:
        return [
            {
                **self.workspace_command_trust(path),
                "exists": Path(path).is_dir(),
            }
            for path in self.workspace_trust.list()
        ]

    def recent_workspaces(self) -> list[dict[str, Any]]:
        """Recent real projects for the folder gate. Per-conversation scratch dirs are
        excluded — they're workspaces to the session store, but never something a user
        should re-open as a 'project'."""
        scratch = self.scratch_base().resolve()
        out = []
        for path in self.session_store.recent_workspaces():
            p = Path(path)
            try:
                if p.resolve().is_relative_to(scratch):
                    continue
            except OSError:
                pass
            out.append({"path": path, "name": p.name, "exists": p.is_dir()})
        return out

    DEFAULT_SCRATCH_BASE = "~/OpenWorker"

    def scratch_base(self) -> Path:
        """Common area for per-conversation scratch directories. Configurable via prefs."""
        base = self._prefs.get("scratch_base") or self.DEFAULT_SCRATCH_BASE
        return Path(base).expanduser()

    def _provision_scratch(self, session_id: str) -> str:
        """Create (idempotently) and return this conversation's scratch directory."""
        d = self.scratch_base() / session_id
        d.mkdir(parents=True, exist_ok=True)
        return str(d.resolve())

    def resolve_workspace(self, requested: Optional[str]) -> Optional[str]:
        if requested:
            p = Path(requested).expanduser()
            if p.is_dir():
                return str(p.resolve())
            return None
        return self.default_workspace

    def validate_session_runtime(
        self,
        session_id: str,
        *,
        runtime: str,
        agent: str,
        workspace: Optional[str],
        profile_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Apply the new-session runtime gate without rewriting existing sessions."""

        record = self.session_store.load(session_id)
        if record is not None:
            return {
                "ok": True,
                "runtime": runtime,
                "model": record.model,
                "workspace": record.workspace,
            }
        if runtime == "acp":
            resolved = self.resolve_workspace(workspace)
            if not resolved:
                return {
                    "ok": False,
                    "code": "ACP_WORKSPACE_REQUIRED",
                    "error": "ACP sessions require an existing workspace directory.",
                    "runtime": "acp",
                    "model": profile_id or "workspace-main",
                }
            try:
                profile = self._usable_chat_profile(resolved, profile_id)
            except Exception as exc:
                return {
                    "ok": False,
                    "code": "ACP_PROFILE_UNUSABLE",
                    "error": str(exc),
                    "runtime": "acp",
                    "model": profile_id or "workspace-main",
                }
            return {
                "ok": True,
                "runtime": "acp",
                "model": profile.id,
                "workspace": resolved,
            }
        # The desktop/server never injects a ProviderClient, so production Coding
        # sessions always take the ACP path.  A directly injected provider is the
        # explicit in-process host/test seam used by engine-level callers.
        if agent == "code" and not self._provider_injected:
            return {
                "ok": False,
                "code": "ACP_RUNTIME_REQUIRED",
                "error": "Coding sessions require a workspace and a usable ACP Agent.",
                "runtime": "embedded",
                "model": self.model,
            }
        if not self._model_ready(self.model):
            return {
                "ok": False,
                "code": "MODEL_NOT_READY",
                "error": "Configure the current model before starting an embedded session.",
                "runtime": "embedded",
                "model": self.model,
            }
        return {
            "ok": True,
            "runtime": "embedded",
            "model": self.model,
            "workspace": workspace,
        }

    def _usable_chat_profile(
        self, workspace: str | Path, profile_id: Optional[str]
    ) -> AgentProfile:
        if not profile_id:
            return self._usable_main_profile(workspace)
        profile = self.agent_profiles.get(str(profile_id).strip())
        if profile is None:
            raise ValueError(f"Agent profile not found: {profile_id}")
        if not profile.enabled:
            raise PermissionError(f"Agent profile is disabled: {profile_id}")
        if profile.transport == Transport.EMBEDDED:
            raise ValueError(f"Agent profile is not an ACP runtime: {profile_id}")
        if not profile.has_current_capability_probe():
            raise RuntimeError(f"Agent profile needs a current capability probe: {profile_id}")
        return profile

    def _model_ready(self, model: Optional[str] = None) -> bool:
        if self._provider_injected:
            return True
        return self._provider_configured(self._model_provider(model or self.model))

    # -- engines ----------------------------------------------------------------
    def engine_workspace(
        self, session_id: str, *, workspace: Optional[str] = None, agent: str = "code"
    ) -> Optional[str]:
        """The workspace `get_engine` would bind — for prepping MCP tools beforehand."""
        record = self.session_store.load(session_id)
        if record:
            return record.workspace or None
        ag = get_agent(agent or "code")
        return self.resolve_workspace(workspace) if ag.needs_workspace else None

    def get_engine(
        self,
        session_id: str,
        *,
        workspace: Optional[str] = None,
        agent: str = "code",
        approver: Optional[Approver] = None,
        extra_tools: Optional[list[Any]] = None,
        directory_requester: Optional[Any] = None,
        plan_approver: Optional[Any] = None,
        question_asker: Optional[Any] = None,
    ) -> Optional[TurnEngine]:
        engine = self._engines.get(session_id)
        if engine is not None:
            if approver is not None:
                engine.approver = approver
            if directory_requester is not None:
                engine.directory_requester = directory_requester
            if plan_approver is not None:
                engine.plan_approver = plan_approver
            if question_asker is not None:
                engine.question_asker = question_asker
            return engine

        record = self.session_store.load(session_id)
        is_new_session = record is None
        agent_name = (record.agent if record else agent) or "code"
        ag = get_agent(agent_name)

        if record:
            ws = record.workspace or None
            model, mode, messages = record.model, Mode(record.mode), record.messages
        else:
            ws = self.resolve_workspace(workspace) if ag.needs_workspace else None
            model, mode, messages = self.model, self.mode, None

        if ag.needs_workspace and (not ws or not Path(ws).is_dir()):
            # Knowledge surfaces (Cowork, Ops, …) start "orphan": no folder picked →
            # auto-provision a per-conversation scratch directory (generalizes MyHelper's
            # auto-workspace). Code-family surfaces still require a real repo; Chat needs none.
            if ag.family == "knowledge":
                ws = self._provision_scratch(session_id)
            else:
                return None

        if ws:
            self.session_store.touch_workspace(ws)
        # Orphan surfaces are multi-root: the scratch (ws) is the primary writable root, plus any
        # folders the user added (persisted per session). Code/Chat stay single-root (roots=None).
        roots = None
        if ag.family == "knowledge" and ws:
            extra = [
                r
                for r in ((record.extra_roots if record else []) or [])
                if Path(str(r.get("path", ""))).is_dir()
            ]
            roots = [{"path": ws, "writable": True, "label": "scratch"}, *extra]
        engine = build_engine(
            agent=ag,
            workspace=ws,
            model=model,
            mode=mode,
            provider=self.provider,
            memory_store=self.memory_store,
            messages=messages,
            extra_tools=extra_tools,
            secrets=self.secrets,
            task_store=self.task_store,
            wake_store=self.wakes,
            session_id=session_id,
            audit_sink=self.audit_store.append,
            roots=roots,
            # WS sessions pass mode-aware callbacks (attended → live prompt, unattended → Inbox).
            # Background / self-wake / durable-resume runs have no live socket → default to the
            # Inbox-based callbacks so a rebuilt engine can still get approvals/answers (and, on
            # resume, the already-resolved item returns immediately).
            approver=approver or self.inbox_approver(session_id, agent),
            directory_requester=directory_requester
            or self.inbox_directory_requester(session_id, agent),
            plan_approver=plan_approver or self.inbox_plan_approver(session_id, agent),
            question_asker=question_asker
            or self.inbox_question_asker(session_id, agent),
            subscription_store=self.subscriptions,
            channel_buffer=self.channel_buffer,
            routing_targets=self._routing_targets(session_id, agent),
            # Per-session connection hierarchy: expose only effective-enabled connectors' tools.
            connector_filter=self.effective_connectors(session_id, agent_name),
        )
        # An automation run rebuilt here (manual "Run now" over WS, durable resume) still
        # carries its task's standing allowances — the rules live on the task record.
        owning_task = self.task_store.task_for_run_session(session_id)
        if owning_task is not None:
            self._seed_task_permissions(engine, owning_task)
        # A mention-spawned session (§31) keeps its in-thread reply pre-approved across
        # rebuilds/restarts — the grant is re-derived from the durable thread map.
        for thread_target in self.mention_sessions.targets_for(session_id):
            engine.permissions.task_rules.setdefault("send_message", set()).add(
                thread_target
            )
        if record is not None and record.grants:
            self._apply_grants(engine, record.grants)
        # Auto-compaction (OPE-27): restore the persisted view boundary and wire the live
        # Settings getter — post-construction, so build_engine's signature stays put.
        if record is not None and record.compaction:
            from ..compaction import CompactionState

            engine.compaction_state = CompactionState.from_dict(record.compaction)
        engine.compaction_settings = self.compaction_settings
        self._engines[session_id] = engine
        if is_new_session:
            self._emit_session_created(session_id, agent_name)
        return engine

    def _emit_session_created(self, session_id: str, persona_id: str) -> None:
        """Phase 5 telemetry, fired once per brand-new session on a background thread
        (never blocks session start). cloud.emit_session_created is a hard no-op when
        signed out or opted out, and sends only content-free facts."""
        import threading

        from .. import cloud
        from ..config import load_config

        entry = self.personas.get(persona_id)
        family = entry.family if entry else ""
        workspace_kind = entry.workspace if entry else ""

        def _send() -> None:
            try:
                cloud.emit_session_created(
                    self.secrets,
                    load_config(),
                    session_id=session_id,
                    persona_id=persona_id,
                    persona_family=family,
                    workspace_kind=workspace_kind,
                )
            except Exception:
                pass  # telemetry must never surface as a session error

        threading.Thread(target=_send, daemon=True).start()

    def _routing_targets(self, session_id: str, agent: str) -> list[str]:
        """The channel address(es) this session's Inbox routes OUT to — used to warn when a
        subscription (inbound) collides with Inbox routing (outbound) on the same channel.
        """
        binding = self.inbox_routing.binding_for(
            self.inbox_routing.route_for(session_id, agent)
        )
        return [f"{binding.channel}:{binding.target}"] if binding.channel else []

    # -- connection hierarchy (UI-REFRESH §4) -----------------------------------
    def _persona_of(self, session_id: str, persona_id: Optional[str] = None) -> str:
        if persona_id:
            return persona_id
        record = self.session_store.load(session_id)
        return (record.agent if record else None) or self.personas.default_id()

    def effective_connectors(
        self, session_id: str, persona_id: Optional[str] = None
    ) -> set[str]:
        """The connectors effectively enabled for this session (§4.1): connected AND not muted by
        the session override / persona default. Drives the engine's connector-tool gating; seeds the
        persona defaults from the manifest on first read using the full connected set.
        """
        persona = self._persona_of(session_id, persona_id)
        connected = {c["name"] for c in connector_list(self.secrets) if c["connected"]}
        entry = self.personas.get(persona)
        manifest = entry.manifest if entry else None
        persona_defaults = self.persona_connections.defaults_for(
            persona, manifest, connected=connected
        )
        session_overrides = self.session_connections.get(session_id)
        return set(
            effective_connections(
                connected=connected,
                persona_defaults=persona_defaults,
                session_overrides=session_overrides,
            )
        )

    def _inbound_connector_allowed(self, session_id: str, connector: str) -> bool:
        """Whether an inbound message on `connector` should be DELIVERED to `session_id` (§4.3).

        Uses the SAME effective set as the engine's connector-tool gating so the inbound gate and the
        tool gate can never disagree (a muted connector is muted both ways, from the first message).
        """
        return connector in self.effective_connectors(session_id)

    # -- persona + session connection surfaces (UI-REFRESH §5/§6) ----------------
    @staticmethod
    def _workspace_kind(entry) -> str:
        """The persona's workspace requirement as a stable string for the GUI. Manifest-backed
        personas carry it verbatim (git|deliverable|none); builtins (which have no manifest) map
        family/needs_workspace into the SAME vocabulary so the frontend reads one enum:
        code-family → git, knowledge-family with a workspace → deliverable, none → none.
        """
        if entry.manifest is not None:
            return entry.manifest.workspace
        if not entry.needs_workspace:
            return "none"
        return "git" if entry.family == "code" else "deliverable"

    def _connected_connectors(self) -> set[str]:
        """The account-connected connector names (the first layer of the §4 hierarchy)."""
        return {c["name"] for c in connector_list(self.secrets) if c["connected"]}

    def _persona_default_connections(
        self, persona_id: str, manifest, connected: set[str]
    ) -> list[dict[str, Any]]:
        """The persona's default connector map (seeded from the manifest's connector recommends on
        first read, then user-editable) as a list, each annotated with account-connectedness.
        """
        defaults = self.persona_connections.defaults_for(
            persona_id, manifest, connected=connected
        )
        return [
            {"connector": c, "enabled": bool(enabled), "connected": c in connected}
            for c, enabled in defaults.items()
        ]

    def persona_detail(self, persona_id: str) -> Optional[dict[str, Any]]:
        """Identity + capabilities + recommends(+connected) + default connections for one persona
        (UI-REFRESH §5). Returns None for an unknown id (the route maps that to an error).
        """
        entry = self.personas.get(persona_id)
        if entry is None:
            return None
        manifest = entry.manifest
        connected = self._connected_connectors()
        recommends = [
            {
                "kind": rec.kind,
                "ref": rec.ref,
                "reason": rec.reason,
                "tier": rec.tier,
                "connected": rec.ref in connected,
            }
            for rec in (manifest.recommends if manifest else [])
        ]
        return {
            "id": entry.id,
            "name": entry.name,
            "icon": entry.icon,
            "tagline": entry.tagline,
            "description": manifest.description if manifest else "",
            "enabled": self.personas.is_enabled(entry.id),
            "tools": list(entry.tools),
            "recommended_models": list(manifest.recommended_models) if manifest else [],
            "default_permission_mode": (
                manifest.default_permission_mode if manifest else "interactive"
            ),
            "workspace": self._workspace_kind(entry),
            "recommends": recommends,
            "default_connections": self._persona_default_connections(
                persona_id, manifest, connected
            ),
        }

    def set_persona_connection(
        self, persona_id: str, connector: str, enabled: bool
    ) -> dict[str, Any]:
        """Set a persona-default connector on/off (UI-REFRESH §5). Seeds the manifest defaults
        first so the stored row stays complete (the edit overlays the full seed rather than
        collapsing the row to this one connector), then returns the refreshed default_connections
        so the client can re-render without a second GET."""
        entry = self.personas.get(persona_id)
        if entry is None:
            return {"ok": False, "error": f"unknown persona: {persona_id}"}
        manifest = entry.manifest
        connected = self._connected_connectors()
        self.persona_connections.defaults_for(persona_id, manifest, connected=connected)
        self.persona_connections.set(persona_id, connector, bool(enabled))
        return {
            "ok": True,
            "default_connections": self._persona_default_connections(
                persona_id, manifest, connected
            ),
        }

    def set_persona_enabled(self, persona_id: str, enabled: bool) -> dict[str, Any]:
        """Flip a persona's enabled flag. Disabling also archives its real (unarchived,
        non-internal) sessions — disable means "put this coworker and its history away", so
        the persona's sidebar section disappears with it (owner call, 2026-07-04). Re-enabling
        never unarchives: that would overwrite the user's archive state; history returns one
        click at a time via the Show-archived disclosure. Raises KeyError for unknown ids.
        """
        self.personas.set_enabled(persona_id, enabled)
        archived = 0
        if not enabled:
            for r in self.session_store.list():
                if (
                    r.agent == persona_id
                    and not r.archived
                    and not r.session_id.startswith("__")
                ):
                    self.session_store.set_flags(r.session_id, archived=True)
                    archived += 1
        return {"ok": True, "archived_sessions": archived}

    def _connection_detail(
        self, session_id: str, connector: str, info: Optional[dict[str, Any]]
    ) -> str:
        """A short human description of WHY a connector is live for a session: the chat ids it's
        subscribed to on that platform, plus "DMs" if this is the designated DM session. Channel
        *names* would need the live adapter's resolve cache (not cheap here), so we show the chat
        ids; with no subscription/DM tie we fall back to the connector's title."""
        prefix = f"{connector}:"
        parts = [
            s.channel.split(":", 1)[1]
            for s in self.subscriptions.for_session(session_id)
            if s.channel.startswith(prefix)
        ]
        if self.dm_session() == session_id:
            parts.append("DMs")
        if parts:
            return " · ".join(parts)
        return (info or {}).get("title") or connector

    def session_connections_view(
        self, session_id: str, persona_id: Optional[str] = None
    ) -> dict[str, Any]:
        """The per-session connections drawer payload (UI-REFRESH §6): every account-connected
        connector with its effective on/off state (muted ones stay VISIBLE as off — a §4.2 toggle
        must never make a row vanish), the persona's connector recommends that aren't yet
        account-connected, and the attention count (= those unconnected recommends).

        ``persona_id`` is the caller's hint (the GUI knows the active persona). It matters for a
        brand-new session: no SessionRecord exists until the first turn persists, so without the
        hint the view would resolve to the DEFAULT persona and show its defaults/recommends —
        the owner's 2026-07-03 finding (a fresh Project Manager session rendered cowork's view).
        """
        persona = self._persona_of(session_id, persona_id)
        entry = self.personas.get(persona)
        manifest = entry.manifest if entry else None
        connectors = connector_list(self.secrets)
        by_name = {c["name"]: c for c in connectors}
        connected_names = {c["name"] for c in connectors if c["connected"]}
        effective = self.effective_connectors(session_id, persona)
        connected = [
            {
                "connector": name,
                "enabled": name in effective,
                "detail": self._connection_detail(session_id, name, by_name.get(name)),
            }
            for name in sorted(connected_names)
        ]
        recommended = [
            {
                "connector": rec.ref,
                "reason": rec.reason,
                "tier": rec.tier,
                "connected": False,
            }
            for rec in (manifest.recommends if manifest else [])
            if rec.kind == "connector" and rec.ref not in connected_names
        ]
        return {
            "connected": connected,
            "recommended": recommended,
            "attention": sum(1 for r in recommended if not r["connected"]),
        }

    def inbox_question_asker(self, session_id: str, agent: str):
        """The Unattended `ask_user` handler: turn the agent's question into an Inbox item and
        suspend until a human answers it (from the Inbox, or inline when they open the session).
        Also the default for background/self-wake runs (no live socket). Mirrors to a bound channel
        like the approver does."""

        async def ask(
            args: dict[str, Any], tool_call_id: Optional[str] = None
        ) -> dict[str, Any]:
            question = str(args.get("question", "")).strip()
            if not question:
                return {"answer": "", "error": "no question"}
            inbox_name = self.inbox_routing.route_for(session_id, agent)
            item = self.inbox.add_question(
                session_id,
                title=question,
                inbox=inbox_name,
                options=list(args.get("options") or []),
                allow_text=bool(args.get("allow_text", True)),
                multi=bool(args.get("multi", False)),
                tool_call_id=tool_call_id,
            )
            if (
                item.state != "pending"
            ):  # durable resume re-raised an already-answered prompt
                return {"answer": item.resolution or ""}
            self.persist_session(session_id)  # the pending tool call is now on disk
            await self.mirror_inbox_item(item)
            answer = await self.inbox.wait(item.id)
            return {"answer": answer}

        return ask

    def inbox_approver(self, session_id: str, agent: str):
        """Inbox-based approver — the default for no-socket runs (background, self-wake, durable
        resume). On resume the item already exists + is resolved, so wait returns at once.
        """

        async def approve(request):
            item = self.inbox.add_approval(
                session_id,
                f"Run `{request.tool_name}`?",
                body=_approval_body(request),
                inbox=self.inbox_routing.route_for(session_id, agent),
                tool_call_id=getattr(request, "tool_call_id", None),
                data=self.approval_prompt_data(session_id, request),
            )
            if item.state == "pending":
                self.persist_session(session_id)
                await self.mirror_inbox_item(item)
            resolution = await self.inbox.wait(item.id)
            return self.approval_outcome(resolution, request, session_id)

        return approve

    def inbox_directory_requester(self, session_id: str, agent: str):
        async def request(args, tool_call_id=None):
            item = self.inbox.add_directory(
                session_id,
                "Grant access to a folder?",
                body=str(args.get("reason", "")),
                inbox=self.inbox_routing.route_for(session_id, agent),
                data={
                    "path": str(args.get("path", "")),
                    "writable": bool(args.get("writable", False)),
                },
                tool_call_id=tool_call_id,
            )
            if item.state == "pending":
                self.persist_session(session_id)
                await self.mirror_inbox_item(item)
            resp = _parse_inbox_json(await self.inbox.wait(item.id))
            if not resp.get("granted"):
                return {"granted": False, "reason": "the user declined the request"}
            path = (resp.get("path") or args.get("path") or "").strip()
            if not path:
                return {"granted": False, "error": "no directory was provided"}
            writable = bool(resp.get("writable", args.get("writable", False)))
            res = self.add_root(session_id, path, writable)
            if not res.get("ok"):
                return {
                    "granted": False,
                    "error": res.get("error", "could not grant access"),
                }
            return {"granted": True, "path": path, "writable": writable}

        return request

    def inbox_plan_approver(self, session_id: str, agent: str):
        async def approve(args, tool_call_id=None):
            item = self.inbox.add_plan(
                session_id,
                "Approve the plan?",
                body=str(args.get("plan", "")),
                inbox=self.inbox_routing.route_for(session_id, agent),
                tool_call_id=tool_call_id,
            )
            if item.state == "pending":
                self.persist_session(session_id)
                await self.mirror_inbox_item(item)
            resp = _parse_inbox_json(await self.inbox.wait(item.id))
            if not resp.get("approved"):
                return {
                    "approved": False,
                    "feedback": resp.get("feedback") or "the user rejected the plan",
                }
            return {"approved": True, "mode": resp.get("mode") or "interactive"}

        return approve

    def persist_session(self, session_id: str) -> None:
        """Save the cached engine's thread (so a prompt's pending tool call survives a crash)."""
        engine = self._engines.get(session_id)
        if engine is not None:
            self.save(session_id, engine)

    async def resolve_inbox(self, item_id: str, resolution: str) -> bool:
        """Resolve an Inbox item from any surface (REST / Slack button / channel reply). If the
        asking agent is still suspended live, that await handles it. Otherwise the process restarted
        (or the engine was evicted) while blocked → durably resume: rebuild the engine from the
        saved thread and continue the turn."""
        item = self.inbox.get(item_id)
        ok = self.inbox.resolve(item_id, resolution)
        if not ok or item is None:
            return ok
        if not self.is_running(item.session_id):
            await self._durable_resume(item)
        return ok

    async def _durable_resume(self, item) -> None:
        if not getattr(item, "tool_call_id", None):
            return  # nothing to reconstruct (legacy item) — best-effort: leave it
        engine = self.get_engine(item.session_id)
        if engine is None or not hasattr(engine, "resume"):
            return
        self.mark_running(item.session_id)
        try:
            async for _event in engine.resume():
                pass
            self.save(item.session_id, engine)
        finally:
            self.mark_idle(item.session_id)

    # -- MCP --------------------------------------------------------------------
    async def prepare_mcp_tools(
        self, session_id: str, *, workspace: Optional[str] = None, agent: str = "code"
    ) -> list[Any]:
        """Connect enabled MCP servers (global + workspace) and return their tool callables.

        Called from the async WS handler before `get_engine`; no-op if the engine is already
        built (its MCP tools are attached). Servers that fail to connect are skipped.
        """
        if session_id in self._engines:
            return []
        from ..connectors.descriptors import get_descriptor
        from ..connectors.tool_defs import (
            approval_for_tool,
            mcp_tool_defs,
            tool_enabled,
        )

        from ..mcp import oauth as mcp_oauth

        ws = self.engine_workspace(session_id, workspace=workspace, agent=agent)
        loop = asyncio.get_running_loop()
        effective: Optional[set[str]] = None  # computed lazily, once
        out: list[Any] = []
        for server in load_mcp_servers(
            ws,
            secrets=self.secrets,
            workspace_trusted=self._mcp_workspace_trusted(ws),
        ):
            if not server.enabled:
                continue
            if server.auth == "oauth" and not mcp_oauth.has_tokens(
                server.name, self.secrets
            ):
                # NEVER start an interactive OAuth flow from a turn: a token-less
                # server here would open a browser and block every session for the
                # full flow timeout (owner-hit 2026-07-20 — a failed one-click's
                # leftover config froze all new sessions). Flows start only from an
                # explicit connect in Settings/Connectors.
                continue
            descriptor = get_descriptor(server.name)
            backed = descriptor is not None and bool(descriptor.mcp_url)
            if backed:
                # Connector-backed server: obey the same gates as connector tools —
                # the session's effective connector set and the per-tool toggles.
                # The descriptor's PIN is authoritative over whatever the config
                # file says (drift can only ever shrink the surface).
                if effective is None:
                    effective = self.effective_connectors(session_id, agent)
                if server.name not in effective:
                    continue
                prefix = f"mcp__{server.name}__"
                server.include_tools = [
                    t.name.removeprefix(prefix)
                    for t in mcp_tool_defs(server.name)
                    if tool_enabled(self.secrets, server.name, t.name)
                ]
            try:
                conn = await self.mcp.ensure(server)
            except Exception as exc:
                if mcp_oauth.is_auth_required(exc):
                    # Stored tokens no longer refresh (vendor rotated/expired
                    # them) — the non-interactive connect refused to open a
                    # browser. Record it so the MCP page shows WHY the server is
                    # dark; the session just runs without its tools.
                    self._mcp_errors[server.name] = (
                        "sign-in required — reconnect this server from its page"
                    )
                    logger.info(
                        "mcp %s needs re-auth; skipped for this session", server.name
                    )
                # else: bad command / unreachable url — skip, don't break the session
                continue
            callables = build_callables(
                server,
                conn.tools,
                lambda tool, args, name=server.name: self.mcp.call(name, tool, args),
                loop,
            )
            if backed:
                # Per-tool approval from the pinned read/write classification
                # (server-level requires_approval is off for backed servers);
                # anything unclassified stays approval-gated — fail closed.
                for fn in callables:
                    fn.__aisuite_tool_metadata__.requires_approval = approval_for_tool(
                        fn.__aisuite_tool_metadata__.name, default=True
                    )
            out.extend(callables)

        return out

    def list_mcp(self) -> list[dict[str, Any]]:
        """Servers from the global config + connection status (does not connect)."""
        from ..mcp import oauth as mcp_oauth

        from ..connectors.descriptors import get_descriptor

        out = []
        for name, raw in read_global().items():
            d = get_descriptor(name)
            if d is not None and d.mcp_url:
                # Connector-backed server: surfaced on the Connectors page (its
                # connect/disconnect lifecycle lives there), not in the MCP tab.
                continue
            connected = name in self.mcp._conns
            is_oauth = str(raw.get("auth", "")).lower() == "oauth"
            if connected:
                status = "connected"
            elif not raw.get("enabled", True):
                status = "disabled"
            elif name in self._mcp_authorizing:
                status = "authorizing"
            elif is_oauth and not mcp_oauth.has_tokens(name, self.secrets):
                status = "needs_auth"
            else:
                status = "configured"
            out.append(
                {
                    "name": name,
                    "enabled": bool(raw.get("enabled", True)),
                    "transport": (
                        "http"
                        if (
                            raw.get("url")
                            or str(raw.get("type", "")).lower()
                            in {"http", "sse", "streamable-http"}
                        )
                        else "stdio"
                    ),
                    "requires_approval": bool(raw.get("requires_approval", True)),
                    "auth": "oauth" if is_oauth else None,
                    "status": status,
                    "last_error": self._mcp_errors.get(name),
                    "tool_count": (
                        len(self.mcp._conns[name].tools) if connected else None
                    ),
                    "config": _redact(raw),
                }
            )
        return out

    async def connect_mcp(self, name: str) -> dict[str, Any]:
        """Connect one server NOW — for OAuth servers this may open the browser and wait
        for the loopback callback, so callers run it as a background task and watch
        list_mcp for the status flip."""
        for server in load_mcp_servers(
            self.default_workspace,
            secrets=self.secrets,
            workspace_trusted=self._mcp_workspace_trusted(self.default_workspace),
        ):
            if server.name != name:
                continue
            self._mcp_authorizing.add(name)
            self._mcp_errors.pop(name, None)
            try:
                # The ONE place a browser sign-in may start: an explicit connect.
                conn = await self.mcp.ensure(server, interactive=True)
                return {"ok": True, "tools": len(conn.tools)}
            except Exception as exc:
                self._mcp_errors[name] = str(exc) or exc.__class__.__name__
                return {"ok": False, "error": self._mcp_errors[name]}
            finally:
                self._mcp_authorizing.discard(name)
        return {"ok": False, "error": f"unknown MCP server: {name}"}

    async def mcp_connect_connector(self, name: str) -> dict[str, Any]:
        """One-click connect for an MCP-BACKED connector (descriptor.mcp_url): seed
        the global server entry pinned to the curated allowlist, run the browser
        OAuth flow, and mark the connector profile `mode: "mcp"` on success."""
        from ..connectors.descriptors import get_descriptor
        from ..connectors.tool_defs import mcp_pinned_tools

        d = get_descriptor(name)
        if d is None or not d.mcp_url:
            return {"ok": False, "error": f"{name} has no MCP connect path"}
        put_global_server(
            name,
            {
                "url": d.mcp_url,
                "auth": "oauth",
                # Server-level approval off: writes gate per-tool via the pinned
                # read/write classification (prepare_mcp_tools); unknown vendor
                # tools never load at all (include_tools).
                "requires_approval": False,
                "include_tools": mcp_pinned_tools(name),
                "enabled": True,
            },
        )
        result = await self.connect_mcp(name)
        if result.get("ok"):
            profile = self.secrets.get(f"{name}:default") or {}
            self.secrets.put(
                f"{name}:default", {**profile, "mode": "mcp", "enabled": True}
            )
        else:
            # A failed connect must take its seeded config with it: an enabled
            # oauth entry with no tokens lingers forever (nothing owns it once
            # the descriptor's mcp_url is gone) and re-arms at every session
            # start — the owner-hit asana leftover, 2026-07-20.
            delete_global_server(name)
        return result

    async def signout_mcp(self, name: str) -> dict[str, Any]:
        """Drop the live connection (if any) and forget the stored OAuth tokens."""
        from ..mcp import oauth as mcp_oauth

        conn = self.mcp._conns.get(name)
        if conn is not None:
            conn.shutdown.set()
        self._mcp_errors.pop(name, None)
        removed = mcp_oauth.sign_out(name, self.secrets)
        return {"ok": True, "had_tokens": removed}

    def add_mcp(self, name: str, config: dict[str, Any]) -> dict[str, Any]:
        put_global_server(name, config)
        return {"ok": True, "name": name}

    def patch_mcp(self, name: str, changes: dict[str, Any]) -> dict[str, Any]:
        ok = patch_global_server(name, changes)
        return {"ok": ok, "name": name}

    def delete_mcp(self, name: str) -> dict[str, Any]:
        ok = delete_global_server(name)
        return {"ok": ok, "name": name}

    async def mcp_tools(self, name: str) -> dict[str, Any]:
        """Connect one server and list its tools (name + description)."""
        for server in load_mcp_servers(
            self.default_workspace,
            secrets=self.secrets,
            workspace_trusted=self._mcp_workspace_trusted(self.default_workspace),
        ):
            if server.name == name:
                try:
                    conn = await self.mcp.ensure(server)
                except (FileNotFoundError, PermissionError) as exc:
                    # Spawning the stdio command failed before any MCP traffic — say
                    # WHICH command and why instead of leaking a raw errno.
                    reason = (
                        "not found"
                        if isinstance(exc, FileNotFoundError)
                        else "not executable"
                    )
                    target = (
                        f"MCP server command {reason}: {server.command}"
                        if server.command
                        else f"MCP server command {reason}"
                    )
                    return {"name": name, "ok": False, "error": target, "tools": []}
                except Exception as exc:
                    return {"name": name, "ok": False, "error": str(exc), "tools": []}
                return {
                    "name": name,
                    "ok": True,
                    "tools": [
                        {"name": t.name, "description": getattr(t, "description", "")}
                        for t in conn.tools
                    ],
                }
        return {"name": name, "ok": False, "error": "unknown server", "tools": []}

    async def reload_mcp(self) -> dict[str, Any]:
        """Drop live MCP connections so new sessions reconnect with fresh config."""
        await self.mcp.aclose()
        return {"ok": True}

    # -- connectors -------------------------------------------------------------
    def list_connectors(self) -> list[dict[str, Any]]:
        # Enrich two-way connectors with the live gateway's recently-seen senders, so the Connectors
        # tab can manage the allow-list inline (each recent sender flagged authorized or not).
        connectors = connector_list(self.secrets)
        for c in connectors:
            if not (c.get("two_way") and c.get("connected")):
                continue
            allowed = set(c.get("allowed_users") or [])
            # Per-workspace allow-lists (managed relay) — a sender is judged against
            # ITS workspace's list; the flat list only governs team-less (socket) events.
            team_allowed = {
                w["team_id"]: set(w.get("allowed_users") or [])
                for w in (c.get("workspaces") or [])
            }
            recent = self.gateway.recent_senders(c["name"]) if self.gateway else []
            for r in recent:
                team = r.get("team_id")
                pool = team_allowed.get(team, set()) if team else allowed
                r["authorized"] = r.get("user_id") in pool
                # Backfill from the people directory (an event may predate name scopes).
                r["user_name"] = r.get("user_name") or self._people.get(
                    f"{c['name']}:{r.get('user_id')}"
                )
            c["recent"] = recent
            # Parked unauthorized messages (§19) — the connector page resolves them inline.
            c["unauthorized"] = self.parked.list(c["name"])
            # Allow-list display names from the people directory (ids stay the source of truth).
            c["allowed_user_names"] = {
                u: self._people.get(f"{c['name']}:{u}")
                for u in (c.get("allowed_users") or [])
            }
            c["approval_owner_names"] = {
                u: self._people.get(f"{c['name']}:{u}")
                for u in (c.get("approval_owner_ids") or [])
            }
            for w in c.get("workspaces") or []:
                w["allowed_user_names"] = {
                    u: self._people.get(f"{c['name']}:{u}")
                    for u in (w.get("allowed_users") or [])
                }
                w["approval_owner_names"] = {
                    u: self._people.get(f"{c['name']}:{u}")
                    for u in (w.get("approval_owner_ids") or [])
                }
        return connectors

    def connect_connector(
        self, name: str, fields: dict[str, Any], *, acknowledged: bool = False
    ) -> dict[str, Any]:
        # validates the token by a live API call (sync httpx) — run off the event loop
        return connect_connector(self.secrets, name, fields, acknowledged=acknowledged)

    def set_experimental_connectors(self, value: bool) -> dict[str, Any]:
        return set_experimental_enabled(self.secrets, value)

    def disconnect_connector(self, name: str) -> dict[str, Any]:
        # MCP-backed profile: drop the live server connection before the tokens go.
        conn = self.mcp._conns.get(name)
        if conn is not None:
            conn.shutdown.set()
        return disconnect_connector(self.secrets, name)

    def update_connector_tools(
        self, name: str, enabled: dict[str, Any]
    ) -> dict[str, Any]:
        return update_connector_tools(self.secrets, name, enabled)

    def list_audit(
        self,
        *,
        limit: int = 100,
        session_id: Optional[str] = None,
        connector: Optional[str] = None,
        tool: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        return self.audit_store.list(
            limit=limit, session_id=session_id, connector=connector, tool=tool
        )

    def browser_state(self) -> dict[str, Any]:
        return browser_state()

    def browser_screenshot(self) -> dict[str, Any]:
        return browser_take_screenshot()

    def browser_close(self) -> dict[str, Any]:
        return browser_close_session()

    def list_artifacts(self, session_id: str) -> list[dict[str, Any]]:
        record = self.session_store.load(session_id)
        workspace = record.workspace if record else self.default_workspace
        if not workspace:
            return []
        root = Path(workspace).expanduser().resolve()
        if not root.is_dir():
            return []
        out: list[dict[str, Any]] = []
        suffixes = {
            ".md",
            ".markdown",
            ".html",
            ".htm",
            ".txt",
            ".json",
            ".csv",
            ".tsv",
            ".py",
            ".js",
            ".ts",
            ".tsx",
            ".css",
            ".png",
            ".jpg",
            ".jpeg",
            ".webp",
            ".gif",
            ".pdf",
            ".xlsx",
            ".xls",
            ".pptx",
            ".ppt",
            ".pptm",
            ".docx",
            ".doc",
            ".docm",
        }
        # os.walk with in-place pruning, NOT rglob: rglob descends first and filters after,
        # so a home-directory workspace walked into ~/Library and tripped the macOS App Data
        # TCC prompt ("OpenWorker would like to access data from other apps") on every turn.
        # Pruning here means those directories are never entered at all.
        from ..tools.search import OS_DATA_DIRS

        skip = {"node_modules", "target", "dist", "__pycache__"} | OS_DATA_DIRS
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in skip]
            for name in files:
                if name.startswith("."):
                    continue
                path = Path(dirpath) / name
                if path.suffix.lower() not in suffixes:
                    continue
                try:
                    st = path.stat()
                    if not path.is_file():
                        continue
                    out.append(
                        {
                            "path": str(path.relative_to(root)),
                            # Absolute path for "Copy path" — the relative one is useless
                            # outside the app (tester catch 2026-07-12: it copied just the
                            # filename).
                            "abs_path": str(path),
                            "name": path.name,
                            "kind": _artifact_kind(path),
                            "size": st.st_size,
                            "modified_at": st.st_mtime,
                        }
                    )
                except OSError:
                    continue
        out.sort(key=lambda a: a["modified_at"], reverse=True)
        return out[:80]

    MAX_BINARY_PREVIEW = 25 * 1024 * 1024  # base64-over-JSON gets heavy past this

    def _artifact_target(
        self, session_id: str, path: str
    ) -> tuple[Optional[Path], Optional[str]]:
        """Resolve an artifact path under the session's workspace, or (None, error)."""
        record = self.session_store.load(session_id)
        workspace = record.workspace if record else self.default_workspace
        if not workspace:
            return None, "no workspace"
        root = Path(workspace).expanduser().resolve()
        target = (root / path).expanduser().resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return None, "path escapes workspace"
        if not target.is_file():
            return None, "not found"
        return target, None

    def read_artifact(self, session_id: str, path: str) -> dict[str, Any]:
        target, err = self._artifact_target(session_id, path)
        if target is None:
            return {"ok": False, "error": err}
        kind = _artifact_kind(target)
        if kind == "office":
            # PowerPoint/Word binaries can't be previewed inline; the UI offers
            # "Open in default app" instead of trying to render them.
            return {"ok": True, "path": path, "kind": "office"}
        if kind in ("image", "pdf", "sheet"):
            import base64

            if target.stat().st_size > self.MAX_BINARY_PREVIEW:
                return {
                    "ok": False,
                    "error": "file too large to preview — use Reveal to open it",
                }
            mime = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
                ".gif": "image/gif",
                ".pdf": "application/pdf",
                ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                ".xls": "application/vnd.ms-excel",
            }.get(target.suffix.lower(), "application/octet-stream")
            data = base64.b64encode(target.read_bytes()).decode("ascii")
            return {
                "ok": True,
                "path": path,
                "kind": kind,
                "data_url": f"data:{mime};base64,{data}",
            }
        try:
            text = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            return {"ok": False, "error": "binary file cannot be previewed"}
        return {
            "ok": True,
            "path": path,
            "kind": kind,
            "content": text[:500000],
            "truncated": len(text) > 500000,
        }

    def reveal_artifact(
        self, session_id: str, path: str, mode: str = "reveal"
    ) -> dict[str, Any]:
        """Show the file in the OS file manager (`reveal`) or open it with its default app
        (`open`). The server runs on the user's machine in both desktop and browser builds, so
        this is local. Cross-platform: macOS `open`, Windows Explorer/ShellExecute, Linux
        `xdg-open`."""
        import os
        import subprocess
        import sys

        target, err = self._artifact_target(session_id, path)
        if target is None:
            return {"ok": False, "error": err}
        try:
            if sys.platform == "darwin":
                args = (
                    ["open", "-R", str(target)]
                    if mode == "reveal"
                    else ["open", str(target)]
                )
                subprocess.Popen(
                    args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
            elif sys.platform == "win32":
                if mode == "reveal":
                    # Explorer wants the path glued to the switch: /select,<path>
                    subprocess.Popen(["explorer", f"/select,{target}"])
                else:
                    os.startfile(str(target))  # type: ignore[attr-defined]  # open in default app
            else:  # Linux/BSD
                tgt = str(target.parent) if mode == "reveal" else str(target)
                subprocess.Popen(
                    ["xdg-open", tgt],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        except OSError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True}

    # -- web search -------------------------------------------------------------
    def get_web_search(self) -> dict[str, Any]:
        from ..config import load_config
        from ..web import provider_names

        profile = self.secrets.get("web_search:default") or {}
        provider = (
            profile.get("provider") or load_config().web_search_provider or "duckduckgo"
        )
        return {
            "provider": provider,
            "has_key": bool(profile.get("api_key")),
            "providers": provider_names(),
        }

    def set_web_search(
        self, provider: str, api_key: Optional[str] = None
    ) -> dict[str, Any]:
        from ..web import provider_names

        if provider not in provider_names():
            return {"ok": False, "error": f"unknown provider: {provider}"}
        profile: dict[str, Any] = {"provider": provider}
        if api_key:
            profile["api_key"] = api_key
        self.secrets.put("web_search:default", profile)
        return {"ok": True, "provider": provider}

    # -- model providers (OpenAI, Ollama, …) ------------------------------------
    def get_providers(self) -> list[dict[str, Any]]:
        """Descriptor + per-provider status for the Settings UI. Never returns secret values;
        non-secret field values (e.g. the Ollama base URL) ARE returned so the form can prefill.
        """
        out: list[dict[str, Any]] = []
        for d in provider_descriptors():
            raw_profile = self.secrets.get_raw(f"provider:{d.name}") or {}
            profile = self.secrets.resolve(raw_profile)
            configured = descriptor_configured(d, profile)
            values = {
                f.key: profile.get(f.key)
                for f in d.fields
                if not f.secret and profile.get(f.key)
            }
            out.append(
                {
                    **d.to_dict(),
                    "configured": configured,
                    "credential_source": provider_credential_source(
                        d, raw_profile, profile
                    ),
                    "values": values,
                    "suggested_models": self._suggested_models(d.name),
                    # Key hygiene for the Settings pane: when the key was saved (date, stamped
                    # by set_provider) and when the provider last served a completion (epoch,
                    # stamped by the router's on_use hook). Absent for env-only config.
                    "key_set_at": profile.get("key_set_at"),
                    "last_used_at": (self._prefs.get("provider_last_used") or {}).get(
                        d.name
                    ),
                }
            )
        return out

    def pick_native_folder(self) -> dict[str, Any]:
        """Open the OS folder picker FROM THE SIDECAR — the browser GUI can't obtain absolute
        paths from web file dialogs, but the sidecar is local and can (the desktop shell uses
        Tauri's own picker instead). Blocking until pick/cancel; callers run it off-thread.
        """
        import subprocess
        import sys

        if sys.platform == "darwin":
            cmd = [
                "osascript",
                "-e",
                'tell application "System Events" to activate',
                "-e",
                'POSIX path of (choose folder with prompt "Give the coworker access to a folder")',
            ]
        elif sys.platform == "win32":
            # WinForms folder dialog via PowerShell — no extra deps. -STA is required
            # (the dialog silently fails in the default MTA apartment).
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms; "
                "$f = New-Object System.Windows.Forms.FolderBrowserDialog; "
                "$f.Description = 'Give the coworker access to a folder'; "
                "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) "
                "{ [Console]::Out.Write($f.SelectedPath) }"
            )
            cmd = ["powershell.exe", "-NoProfile", "-STA", "-Command", ps]
        else:
            # Linux: zenity when present; otherwise the GUI's paste-a-path input remains.
            cmd = ["zenity", "--file-selection", "--directory"]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.TimeoutExpired):
            return {"ok": False, "error": "no native folder picker available"}
        path = (out.stdout or "").strip()
        if out.returncode != 0 or not path:
            return {"ok": False, "canceled": True}
        return {"ok": True, "path": path}

    def _note_provider_use(self, name: str) -> None:
        """Router on_use hook: remember when a provider last served a completion. Persisted
        THROTTLED (once per provider per minute) — this fires on every model call, from engine
        threads, and prefs.json isn't a place for a write-per-token-of-work."""
        import time

        now = time.time()
        used = self._prefs.setdefault("provider_last_used", {})
        if now - float(used.get(name) or 0) < 60:
            return
        used[name] = now
        try:
            self._save_prefs()
        except OSError:
            pass

    # Suggestions for the OpenAI-compatible vendor providers (checked against vendor docs
    # 2026-07-04; refresh alongside `recommended_model` in providers/registry.py).
    COMPAT_MODELS = {
        "zai": ["glm-5.2", "glm-4.6"],
        "deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"],
        "kimi": ["kimi-k2.6", "kimi-k2.5"],
        "minimax": ["MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M3"],
        "qwen": ["qwen3-max", "qwen3-coder-plus", "qwen-plus"],
        "xai": ["grok-4.3", "grok-4"],
        "mistral": ["mistral-large-latest", "mistral-small-latest"],
    }

    def _suggested_models(self, name: str) -> list[str]:
        """Bare model-name suggestions for the 'add model' form (datalist), per provider.
        Ollama → live `/api/tags` (best-effort); everyone else → the curated matrix,
        topped up with the compat-vendor extras the matrix doesn't vouch for."""
        if name == "ollama":
            return [m.split(":", 1)[-1] for m in self._ollama_models()]
        from ..providers.matrix import models_for_provider

        return list(
            dict.fromkeys(
                [*models_for_provider(name), *self.COMPAT_MODELS.get(name, [])]
            )
        )

    def set_provider(
        self, name: str, fields: Optional[dict[str, Any]]
    ) -> dict[str, Any]:
        """Store a provider's config in its `provider:<name>` SecretStore profile and rebuild
        its cached client. Merges provided fields into any existing profile."""
        d = get_descriptor(name)
        if d is None:
            return {"ok": False, "error": f"unknown provider: {name}"}
        fields = fields or {}
        profile = dict(self.secrets.get_raw(f"provider:{name}") or {})
        for f in d.fields:
            if f.key not in fields:
                continue
            val = fields.get(f.key)
            if isinstance(val, str):
                val = val.strip()
            if val:
                profile[f.key] = val
            elif not f.required:
                profile.pop(f.key, None)
        _, missing = resolve_provider_fields(d, self.secrets.resolve(profile))
        if missing:
            return {"ok": False, "error": "missing: " + ", ".join(missing)}
        # A (re)pasted key stamps its save date — Settings shows "key added <date>" so stale
        # keys are visible. Endpoint-only saves keep the original stamp.
        if isinstance(fields.get("api_key"), str) and fields["api_key"].strip():
            from datetime import date

            profile["key_set_at"] = date.today().isoformat()
        self.secrets.put(f"provider:{name}", profile)
        self._refresh_provider(name)
        # Convenience: if the provider recommends a model and it's actually available, add it to
        # the curated list so it shows up in the composer right after configuring the provider.
        rec = d.recommended_model
        added: Optional[str] = None
        if rec and rec in self._suggested_models(name):
            # OpenAI models stay bare (the router's default); others carry their prefix.
            added = rec if name == "openai" else f"{name}:{rec}"
            self.add_model(added)
        # First working provider wins the default: if the current default model belongs to a
        # provider with no usable config (the fresh-install gpt-5.6-sol case), switch the default to
        # this provider's model. A default that already works is never stolen.
        if added and not self._provider_configured(self._model_provider(self.model)):
            self.set_default_model(added)
        return {"ok": True, "provider": name, "recommended_model": rec}

    def remove_provider(self, name: str) -> dict[str, Any]:
        """Forget a provider's stored config (Settings ▸ Models "Remove key"). The whole
        `provider:<name>` profile goes — key, endpoint, key_set_at — so the provider reads
        as never configured. Curated models stay; they just gray out until a new key."""
        d = get_descriptor(name)
        if d is None:
            return {"ok": False, "error": f"unknown provider: {name}"}
        self.secrets.delete(f"provider:{name}")
        self._refresh_provider(name)
        return {"ok": True, "provider": name}

    def verify_provider(
        self, name: str, fields: Optional[dict[str, Any]]
    ) -> dict[str, Any]:
        """Test a provider's credentials with a live read-only call, WITHOUT persisting them, so
        onboarding can offer a "Test" button. Falls back to stored/env values when the form left
        a field blank (e.g. testing an already-configured provider)."""
        import os

        d = get_descriptor(name)
        if d is None:
            return {"ok": False, "error": f"unknown provider: {name}"}
        fields = fields or {}
        profile = self.secrets.get(f"provider:{name}") or {}
        merged, missing = resolve_provider_fields(d, profile, fields)
        if missing:
            return {"ok": False, "error": "missing: " + ", ".join(missing)}
        api_key = merged.get("api_key", "")
        if not api_key and d.env_key:
            api_key = os.environ.get(d.env_key, "").strip()
        has_key_field = any(f.key == "api_key" for f in d.fields)
        if d.needs_key and has_key_field and not api_key:
            return {"ok": False, "error": "Enter an API key to test."}
        # Multi-field cloud providers (Bedrock) may use ambient credentials.  The shared
        # resolver validates their descriptor fields; the provider-specific probe below
        # validates the selected ambient authentication method.
        return verify_provider_key(
            name, api_key=api_key, base_url=merged.get("base_url", ""), fields=merged
        )

    def _model_provider(self, model: str) -> str:
        """The provider a model string routes to (known `prefix:` or the OpenAI default)."""
        if ":" in (model or ""):
            prefix = model.split(":", 1)[0]
            if get_descriptor(prefix) is not None:
                return prefix
        return "openai"

    def _provider_configured(self, name: str) -> bool:
        d = get_descriptor(name)
        if d is None:
            return False
        return descriptor_configured(d, self.secrets.get(f"provider:{name}") or {})

    # -- settings / prefs (model API key, default model, onboarding) -------------
    def _prefs_path(self) -> Path:
        return self._data_base / "prefs.json"

    def _load_prefs(self) -> dict[str, Any]:
        try:
            return json.loads(self._prefs_path().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_prefs(self) -> None:
        self._prefs_path().write_text(
            json.dumps(self._prefs, indent=2), encoding="utf-8"
        )

    # -- QH ACP / multi-agent control plane ------------------------------------
    def list_agent_profiles(self) -> dict[str, Any]:
        return {"profiles": [p.to_dict() for p in self.agent_profiles.list()]}

    def upsert_agent_profile(self, payload: dict[str, Any]) -> dict[str, Any]:
        profile = AgentProfile.from_dict(payload or {})
        saved = self.agent_profiles.put(profile)
        return {"ok": True, "profile": saved.to_dict()}

    def delete_agent_profile(self, profile_id: str) -> dict[str, Any]:
        deleted = self.agent_profiles.delete(profile_id)
        if not deleted:
            raise KeyError(profile_id)
        return {"ok": True, "profile_id": profile_id, "deleted": True}

    def get_workspace_main_agent(self, workspace: str | Path | None = None) -> dict[str, Any]:
        ws = workspace or self.default_workspace or os.getcwd()
        profile = self.agent_profiles.get_workspace_main(ws)
        return {
            "workspace": str(Path(ws).expanduser().resolve()),
            "main_profile_id": profile.id,
            "profile": profile.to_dict(),
        }

    def set_workspace_main_agent(
        self, workspace: str | Path | None, profile_id: str
    ) -> dict[str, Any]:
        ws = workspace or self.default_workspace or os.getcwd()
        return {"ok": True, **self.agent_profiles.set_workspace_main(ws, profile_id)}

    def _agent_adapter(self, profile: AgentProfile) -> Any:
        if profile.transport == Transport.ACP_STDIO:
            return self.acp_adapter
        if profile.transport == Transport.JSONL_RPC:
            return self.pi_adapter
        raise ValueError(f"unsupported agent transport: {profile.transport.value}")

    async def probe_agent_profile(
        self, profile_id: str, workspace: str | Path | None = None
    ) -> dict[str, Any]:
        profile = self.agent_profiles.get(profile_id)
        if profile is None:
            raise KeyError(profile_id)
        cwd = str(
            Path(workspace or self.default_workspace or os.getcwd())
            .expanduser()
            .resolve()
        )
        adapter = self._agent_adapter(profile)
        if profile.transport == Transport.ACP_STDIO:
            capabilities = await adapter.probe(profile, cwd=cwd)
        else:
            handle = await adapter.open_session(profile, cwd=cwd)
            try:
                capabilities = {
                    "transport": "jsonl_rpc",
                    "state": await adapter.get_state(handle),
                }
            finally:
                await adapter.close(handle)
        saved = self.agent_profiles.save_capabilities(profile.id, capabilities)
        return {"ok": True, "profile": saved.to_dict(), "capabilities": capabilities}

    async def _resolve_agent_permission(
        self, request: PermissionRequest
    ) -> Optional[str]:
        permission_id = "agent_permission_" + uuid.uuid4().hex
        item = {
            "permission_id": permission_id,
            "profile_id": request.profile_id,
            "role": request.role,
            "session_id": request.session_id,
            "tool_call": request.tool_call,
            "options": list(request.options),
            "status": "pending",
            "created_at": time.time(),
        }
        loop = asyncio.get_running_loop()
        waiter: asyncio.Future[Optional[str]] = loop.create_future()
        self._agent_permission_requests[permission_id] = item
        self._agent_permission_waiters[permission_id] = waiter
        self.orchestrator.store.append_event(
            {
                "event_id": permission_id,
                "event_type": "agent.permission.requested",
                "aggregate_type": "agent_session",
                "aggregate_id": request.session_id,
                "payload": item,
            }
        )
        session = self.orchestrator.store.get_agent_session(request.session_id)
        if session and session.get("task_id"):
            self.orchestrator.store.append_event(
                {
                    "event_id": f"{permission_id}:mission",
                    "event_type": "permission.required",
                    "aggregate_type": "task",
                    "aggregate_id": str(session["task_id"]),
                    "payload": item,
                }
            )
        await self.broadcast_event({"type": "agent_permission", "data": item})
        try:
            selected = await asyncio.wait_for(waiter, timeout=900)
            item["status"] = "resolved" if selected else "denied"
            item["selected_option_id"] = selected
            return selected
        except asyncio.TimeoutError:
            item["status"] = "expired"
            return None
        finally:
            self._agent_permission_waiters.pop(permission_id, None)
            self.orchestrator.store.append_event(
                {
                    "event_id": f"{permission_id}:resolved",
                    "event_type": "agent.permission.resolved",
                    "aggregate_type": "agent_session",
                    "aggregate_id": request.session_id,
                    "payload": {
                        "permission_id": permission_id,
                        "status": item["status"],
                        "selected_option_id": item.get("selected_option_id"),
                    },
                }
            )
            session = self.orchestrator.store.get_agent_session(request.session_id)
            if session and session.get("task_id"):
                self.orchestrator.store.append_event(
                    {
                        "event_id": f"{permission_id}:mission:resolved",
                        "event_type": "permission.resolved",
                        "aggregate_type": "task",
                        "aggregate_id": str(session["task_id"]),
                        "payload": {
                            "permission_id": permission_id,
                            "status": item["status"],
                            "selected_option_id": item.get("selected_option_id"),
                        },
                    }
                )

    def list_agent_permissions(self, *, pending_only: bool = True) -> dict[str, Any]:
        requests = list(self._agent_permission_requests.values())
        if pending_only:
            requests = [item for item in requests if item.get("status") == "pending"]
        return {"permissions": sorted(requests, key=lambda item: item["created_at"])}

    async def resolve_agent_permission(
        self, permission_id: str, option_id: Optional[str]
    ) -> dict[str, Any]:
        item = self._agent_permission_requests.get(permission_id)
        if item is None:
            raise KeyError(permission_id)
        if item.get("status") != "pending":
            return {"ok": True, "permission": item}
        selected = str(option_id or "").strip() or None
        valid_ids = {
            str(option.get("optionId") or option.get("option_id") or "")
            for option in item.get("options") or []
        }
        if selected is not None and selected not in valid_ids:
            raise ValueError("unknown permission option")
        waiter = self._agent_permission_waiters.get(permission_id)
        if waiter is None or waiter.done():
            item["status"] = "expired"
        else:
            waiter.set_result(selected)
        return {"ok": True, "permission": item}

    def delegate_agent_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = payload or {}
        task_spec = body.get("task_spec") or body
        return self.orchestrator.delegate(
            task_spec,
            conversation_id=body.get("conversation_id"),
            target_profile_id=body.get("target_profile_id"),
            max_rework_rounds=body.get(
                "max_rework_rounds", QhOrchestratorStore.DEFAULT_MAX_REWORK_ROUNDS
            ),
        )

    def create_mission(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = dict(payload or {})
        spec = body.get("task_spec") if isinstance(body.get("task_spec"), dict) else {}
        workspace = body.get("workspace") or spec.get("workspace")
        if not workspace:
            raise ValueError("mission workspace is required")
        main_profile_id: Optional[str] = None
        main_profile_id = self._usable_main_profile(workspace).id
        return self.orchestrator.create_mission(
            body,
            main_profile_id=main_profile_id,
        )

    async def create_mission_with_main_planning(
        self, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Create a Mission and obtain its first structured plan from the main ACP Agent.

        Operational profile/auth/launch/runtime failures persist a ``BLOCKED`` Mission.
        Only an explicit control-plane request or invalid main-Agent output may use the
        deterministic fallback proposal.  Neither branch starts an attempt.
        """

        body = dict(payload or {})
        spec = body.get("task_spec") if isinstance(body.get("task_spec"), dict) else {}
        workspace_value = body.get("workspace") or spec.get("workspace")
        if not workspace_value:
            raise ValueError("mission workspace is required")
        workspace = str(Path(workspace_value).expanduser().resolve())
        planning_mode = str(body.get("planning_mode") or "main_agent").strip()
        if planning_mode not in {"main_agent", "control_plane"}:
            raise ValueError("planning_mode must be main_agent or control_plane")
        profile_error: Optional[Exception] = None
        main_profile: Optional[AgentProfile] = None
        try:
            main_profile = self._usable_main_profile(workspace)
        except Exception as exc:
            profile_error = exc
        main_profile_id = main_profile.id if main_profile is not None else None
        draft = self.orchestrator.create_mission(
            {**body, "workspace": workspace},
            main_profile_id=main_profile_id,
            defer_plan_proposal=True,
        )
        if str(draft.get("state")) != "PLANNING":
            return draft
        mission_id = str(draft["mission_id"])
        draft_plan = dict(draft.get("plan") or {})
        if profile_error is not None:
            return self.orchestrator.block_mission_planning(
                mission_id, self._mission_planning_error(profile_error)
            )
        assert main_profile is not None
        if planning_mode == "control_plane":
            return self.orchestrator.propose_mission_plan(
                mission_id,
                draft_plan,
                source="control_plane_fallback",
                fallback_reason="explicit_control_plane",
            )

        profiles = [
            {
                "id": profile.id,
                "role": profile.role.value,
                "transport": profile.transport.value,
                "permission_policy": profile.permission_policy,
            }
            for profile in self.agent_profiles.list()
            if profile.enabled
        ]
        planning_prompt = self._mission_planning_prompt(
            mission_id=mission_id,
            goal=str(draft.get("goal") or ""),
            profiles=profiles,
            fallback_plan=draft_plan,
        )
        try:
            turn, planning_session_id = await self._run_main_mission_planning_turn(
                profile=main_profile,
                workspace=workspace,
                conversation_id=str(draft["conversation_id"]),
                mission_id=mission_id,
                prompt=planning_prompt,
            )
        except Exception as exc:
            planning_error = self._mission_planning_error(exc)
            logger.warning(
                "main ACP planning blocked mission %s (%s)",
                mission_id,
                planning_error["code"],
            )
            return self.orchestrator.block_mission_planning(
                mission_id, planning_error
            )

        try:
            proposed = self._parse_main_mission_plan(turn.text)
        except ValueError as exc:
            logger.warning(
                "main ACP returned an invalid plan for mission %s; using fallback (%s)",
                mission_id,
                type(exc).__name__,
            )
            return self.orchestrator.propose_mission_plan(
                mission_id,
                draft_plan,
                source="control_plane_fallback",
                fallback_reason="invalid_main_agent_output",
            )
        return self.orchestrator.propose_mission_plan(
            mission_id,
            proposed,
            source="main_agent",
            agent_session_id=planning_session_id,
        )

    def _usable_main_profile(self, workspace: str | Path) -> AgentProfile:
        path = Path(workspace).expanduser().resolve()
        if not path.is_dir():
            raise FileNotFoundError("workspace directory does not exist")
        profile = self.agent_profiles.get_workspace_main(path)
        if profile.role != AgentRole.MAIN:
            raise ValueError("workspace main profile must have role=main")
        if not profile.enabled:
            raise PermissionError("workspace main ACP profile is disabled")
        if profile.transport == Transport.EMBEDDED:
            raise ValueError("workspace main profile must use ACP or JSONL-RPC")
        if not profile.has_current_capability_probe():
            raise RuntimeError("workspace main ACP profile requires a current capability probe")
        return profile

    @staticmethod
    def _mission_planning_error(exc: Exception) -> dict[str, Any]:
        name = type(exc).__name__.lower()
        message = str(exc).lower()
        if isinstance(exc, TimeoutError) or "timeout" in name:
            return {
                "code": "MAIN_ACP_TIMEOUT",
                "message": "The workspace main ACP Agent timed out while planning.",
                "retryable": True,
            }
        if any(token in message for token in ("auth", "login", "credential", "token")):
            return {
                "code": "MAIN_ACP_AUTH_REQUIRED",
                "message": "The workspace main ACP Agent needs authentication.",
                "retryable": True,
            }
        if isinstance(exc, (FileNotFoundError, PermissionError, KeyError, ValueError)) or any(
            token in message for token in ("profile", "capability probe")
        ):
            return {
                "code": "MAIN_ACP_PROFILE_UNUSABLE",
                "message": "The workspace needs an enabled, probed main ACP Agent profile.",
                "retryable": False,
            }
        if isinstance(exc, OSError) or "process" in name or "launch" in message:
            return {
                "code": "MAIN_ACP_LAUNCH_FAILED",
                "message": "The workspace main ACP Agent could not be launched.",
                "retryable": True,
            }
        return {
            "code": "MAIN_ACP_RUNTIME_ERROR",
            "message": "The workspace main ACP Agent failed while planning.",
            "retryable": True,
        }

    async def _run_main_mission_planning_turn(
        self,
        *,
        profile: AgentProfile,
        workspace: str,
        conversation_id: str,
        mission_id: str,
        prompt: str,
    ) -> tuple[Any, str]:
        """Run one isolated, read-only main-Agent planning session.

        This deliberately bypasses ``MainAcpHost`` because normal main sessions receive
        the qh-team MCP server, whose delegate tool can create durable work before the
        user confirms a plan.  The planning clone has no MCP servers and its permission
        policy is forced to read-only.
        """

        planning_profile_data = profile.to_dict()
        planning_profile_data.update(
            {
                "workspace_policy": "readonly",
                "permission_policy": "read-only",
                "enabled": True,
                "capabilities": {},
                "capability_probe_fingerprint": None,
            }
        )
        planning_profile = AgentProfile.from_dict(planning_profile_data)
        adapter: Any
        if planning_profile.transport == Transport.ACP_STDIO:
            adapter = self.acp_adapter
            handle = await adapter.open_session(
                planning_profile,
                cwd=workspace,
                checkpoint={
                    "mission_id": mission_id,
                    "mode": "plan-only",
                    "read_only": True,
                },
                mcp_servers=(),
            )
        elif planning_profile.transport == Transport.JSONL_RPC:
            adapter = self.pi_adapter
            handle = await adapter.open_session(planning_profile, cwd=workspace)
        else:
            raise ValueError(
                f"unsupported main planning transport: {planning_profile.transport.value}"
            )
        try:
            self.orchestrator.save_agent_session(
                session_id=handle.session_id,
                conversation_id=conversation_id,
                profile_id=profile.id,
                task_id=mission_id,
                status="planning",
                capabilities=handle.capabilities,
                metadata={
                    "workspace": workspace,
                    "role": "main",
                    "mode": "plan-only",
                    "read_only": True,
                    "mcp_servers": [],
                },
            )
            result = await adapter.prompt(handle, prompt)
            return result, handle.session_id
        finally:
            with contextlib.suppress(Exception):
                await adapter.close(handle)
            with contextlib.suppress(Exception):
                self.orchestrator.save_agent_session(
                    session_id=handle.session_id,
                    conversation_id=conversation_id,
                    profile_id=profile.id,
                    task_id=mission_id,
                    status="closed",
                    capabilities=handle.capabilities,
                    metadata={
                        "workspace": workspace,
                        "role": "main",
                        "mode": "plan-only",
                        "read_only": True,
                        "mcp_servers": [],
                    },
                )

    @staticmethod
    def _mission_planning_prompt(
        *,
        mission_id: str,
        goal: str,
        profiles: list[dict[str, Any]],
        fallback_plan: dict[str, Any],
    ) -> str:
        schema = {
            "goal": "string",
            "members": [
                {
                    "id": "role:profile-id",
                    "role": "main|explorer|executor|reviewer|gui",
                    "profile_id": "one enabled profile id from roster",
                    "objective": "specific responsibility",
                    "depends_on": ["member id"],
                }
            ],
            "max_rework_rounds": 2,
        }
        return "\n\n".join(
            [
                "You are the main Agent planning a QH Assistant Mission. Return exactly one JSON object and no Markdown.",
                "Use only enabled profile ids from the roster. Include main, executor, and read-only reviewer; add explorer and GUI when useful. Dependencies must reference member ids. Do not execute tools or modify files in this planning turn.",
                json.dumps(
                    {
                        "mission_id": mission_id,
                        "goal": goal,
                        "schema": schema,
                        "enabled_profiles": profiles,
                        "safe_fallback": fallback_plan,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
            ]
        )

    @staticmethod
    def _parse_main_mission_plan(text: str) -> dict[str, Any]:
        raw = str(text or "").strip()
        if not raw:
            raise ValueError("main Agent returned an empty Mission plan")
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw, count=1, flags=re.IGNORECASE)
            raw = re.sub(r"\s*```$", "", raw, count=1)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            start = raw.find("{")
            end = raw.rfind("}")
            if start < 0 or end <= start:
                raise ValueError("main Agent Mission plan is not a JSON object")
            payload = json.loads(raw[start : end + 1])
        if isinstance(payload, dict) and isinstance(payload.get("plan"), dict):
            payload = payload["plan"]
        if not isinstance(payload, dict):
            raise ValueError("main Agent Mission plan must be a JSON object")
        allowed = {"goal", "members", "team", "max_rework_rounds"}
        return {key: value for key, value in payload.items() if key in allowed}

    def list_missions(self, states: Optional[list[str]] = None) -> dict[str, Any]:
        return {"missions": self.orchestrator.list_missions(states)}

    def get_mission(self, mission_id: str) -> dict[str, Any]:
        return self.orchestrator.get_mission(mission_id)

    def update_mission_plan(
        self, mission_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        return self.orchestrator.update_mission_plan(mission_id, payload or {})

    def confirm_mission(
        self, mission_id: str, payload: Optional[dict[str, Any]] = None
    ) -> dict[str, Any]:
        body = payload or {}
        return self.orchestrator.confirm_mission(
            mission_id,
            idempotency_key=body.get("idempotency_key"),
        )

    def message_mission(self, mission_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = payload or {}
        target = body.get("target")
        if not isinstance(target, dict):
            raise ValueError("mission message target is required")
        return self.orchestrator.message_mission(
            mission_id,
            str(body.get("message") or ""),
            target=target,
            idempotency_key=body.get("idempotency_key"),
        )

    async def message_mission_with_delivery(
        self, mission_id: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Queue a Mission message and deliver attempt targets to a real ACP session."""

        body = payload or {}
        target = body.get("target") if isinstance(body.get("target"), dict) else {}
        if str(target.get("kind") or "") == "attempt":
            attempt_id = str(target.get("attempt_id") or "").strip()
            attempt = self.orchestrator.store.get_attempt(attempt_id)
            if attempt is None or attempt.task_id != mission_id:
                raise OrchestrationStoreError(
                    "message target attempt does not belong to mission"
                )
            task = self.orchestrator.store.get_task(mission_id)
            if task is None:
                raise KeyError(mission_id)
            if attempt.role == AgentRole.EXECUTOR and task.status.value not in {
                "IMPLEMENTING",
                "REWORK",
                "DONE",
                "BLOCKED",
            }:
                raise OrchestrationStoreError(
                    f"executor follow-up is unavailable while mission is {task.status.value}"
                )

        result = self.message_mission(mission_id, body)
        if str(target.get("kind") or "") != "attempt" or not result.get("newly_enqueued"):
            return result
        attempt_id = str(target.get("attempt_id") or "")
        attempt = self.orchestrator.store.get_attempt(attempt_id)
        if attempt is None:
            raise OrchestrationStoreError("message target attempt disappeared")
        if attempt.role == AgentRole.EXECUTOR:
            active = self._team_active.get(mission_id)
            if active and str((active.get("attempt") or {}).get("attempt_id") or "") == attempt_id:
                await self._deliver_pending_task_messages(self.agent_task_result(mission_id))
                result["delivered"] = not any(
                    item.get("message_id") == result.get("message_id")
                    for item in self.orchestrator.pending_messages(mission_id)
                )
            else:
                result["delivery_state"] = "queued_for_executor"
            return result

        delivered = await self._deliver_attempt_target_messages(mission_id, attempt_id)
        result["delivered"] = str(result.get("message_id") or "") in delivered
        return result

    def mission_events(
        self,
        mission_id: str,
        *,
        after_cursor: Optional[str] = None,
        limit: int = 200,
    ) -> dict[str, Any]:
        return self.orchestrator.mission_events(
            mission_id,
            after_cursor=after_cursor,
            limit=limit,
        )

    def cancel_mission(self, mission_id: str) -> dict[str, Any]:
        self.cancel_agent_task(mission_id)
        return self.orchestrator.get_mission(mission_id)

    def agent_task_status(self, task_id: str) -> dict[str, Any]:
        return self.orchestrator.status(task_id)

    def agent_task_result(self, task_id: str) -> dict[str, Any]:
        return self.orchestrator.result(task_id)

    def message_agent_task(
        self,
        task_id: str,
        message: str,
        *,
        idempotency_key: Optional[str] = None,
    ) -> dict[str, Any]:
        return self.orchestrator.message(
            task_id,
            message,
            idempotency_key=idempotency_key,
        )

    def cancel_agent_task(self, task_id: str) -> dict[str, Any]:
        result = self.orchestrator.cancel(task_id)
        job = self._team_jobs.get(task_id)
        if job is not None and not job.done():
            job.cancel()
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(
                self._close_team_runtime(
                    task_id,
                    cancel=True,
                    final_attempt_status="cancelled",
                )
            )
        except RuntimeError:
            pass
        return result

    def start_agent_attempt(self, task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = payload or {}
        return self.orchestrator.start_attempt(
            task_id,
            profile_id=str(body.get("profile_id") or "opencode-executor"),
            role=str(body.get("role") or "executor"),
            agent_session_id=body.get("agent_session_id"),
            worktree_path=body.get("worktree_path"),
            rework_round=int(body.get("rework_round", 0)),
        )

    def add_agent_artifact(self, task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = payload or {}
        return self.orchestrator.add_artifact(
            task_id,
            kind=str(body.get("kind") or "artifact"),
            attempt_id=body.get("attempt_id"),
            path=body.get("path"),
            payload=body.get("payload") or {},
        )

    def request_agent_review(self, artifact_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self.orchestrator.request_review(
            artifact_id,
            reviewer_profile_id=(payload or {}).get("reviewer_profile_id"),
        )

    def record_agent_review(self, task_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = payload or {}
        return self.orchestrator.record_review(
            task_id,
            str(body.get("artifact_id") or ""),
            body.get("result") or body,
            reviewer_profile_id=body.get("reviewer_profile_id"),
            reviewer_attempt_id=body.get("reviewer_attempt_id"),
            tests_passed=bool(body.get("tests_passed", True)),
        )

    def _team_tools(self, session_id: str) -> list[Any]:
        # Kept as a compatibility hook for older personas. New coding agents receive
        # these operations through the qh Team MCP server at ACP session setup.
        return []

    def enqueue_agent_delivery(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = payload or {}
        return self.orchestrator.enqueue_main_delivery(
            conversation_id=body.get("conversation_id"),
            target_session_id=body.get("target_session_id"),
            source_task_id=str(body.get("source_task_id") or body.get("task_id") or ""),
            payload=body.get("payload") or {},
            delivery_id=body.get("delivery_id"),
        )

    def pending_agent_deliveries(self, target_session_id: str) -> dict[str, Any]:
        return {
            "deliveries": self.orchestrator.pending_deliveries(target_session_id)
        }

    def mark_agent_delivery_delivered(self, delivery_id: str) -> dict[str, Any]:
        return self.orchestrator.mark_delivered(delivery_id)

    async def _drain_team_deliveries(self, max_items: int = 20) -> int:
        pending = self.orchestrator.pending_deliveries()[:max_items]
        delivered = 0
        for item in pending:
            target_session_id = item.get("target_session_id")
            if not target_session_id:
                self.orchestrator.mark_delivered(item["delivery_id"])
                continue
            payload = item.get("payload")
            if isinstance(payload, dict):
                task_id = item.get("source_task_id")
                header = f"[team-task:{task_id}]" if task_id else "[team-task]"
                body = payload.get("summary") or json.dumps(payload, ensure_ascii=False)
                message = f"{header} {body}".strip()
            else:
                message = str(payload)
            if message:
                try:
                    delivery_result = await self.deliver_to_session(
                        target_session_id,
                        message,
                        source={"kind": "team", "task_id": item.get("source_task_id")},
                        # The host and control-plane share one ledger table, so keep their
                        # idempotency keys stable but in separate namespaces.
                        delivery_id=f"main_session:{item['delivery_id']}",
                        raise_on_error=True,
                    )
                    if not delivery_result or not delivery_result.get("delivered"):
                        logger.warning(
                            "team delivery %s remains pending: main ACP outcome is %s",
                            item.get("delivery_id"),
                            (delivery_result or {}).get("state", "unconfirmed"),
                        )
                        continue
                except Exception as exc:
                    logger.warning(
                        "team delivery %s remains pending: %s",
                        item.get("delivery_id"),
                        exc,
                    )
                    continue
            self.orchestrator.mark_delivered(item["delivery_id"])
            delivered += 1
        return delivered

    def _team_mcp_servers(
        self,
        *,
        role: str,
        conversation_id: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> list[AcpMcpServer]:
        """Return the host-controlled Team MCP server for the main Agent only.

        Specialists receive an explicit task/context package from the orchestrator and must
        not recursively delegate or form a peer mesh.  Reviewers therefore remain read-only,
        and executors/explorers do not receive Team MCP mutation tools.
        """
        if role != "main":
            return []
        try:
            from .. import team_mcp as module  # type: ignore[attr-defined]
        except Exception:
            return []
        factory = getattr(module, "build_team_mcp_server", None)
        servers = (
            factory(
                db_path=self._data_base / "qh_orchestrator.db",
                conversation_id=conversation_id,
                session_id=session_id,
                role=role,
            )
            if callable(factory)
            else getattr(module, "TEAM_MCP_SERVER", [])
        )
        if servers is None:
            return []
        if isinstance(servers, AcpMcpServer):
            return [servers]
        return [server for server in list(servers) if isinstance(server, AcpMcpServer)]

    def _main_acp_mcp_servers(
        self, profile: AgentProfile, conversation_id: str, _workspace: str
    ) -> list[AcpMcpServer]:
        return self._team_mcp_servers(
            role=self._profile_role(profile),
            conversation_id=conversation_id,
            session_id=conversation_id,
        )

    def _task_workspace(self, spec: dict[str, Any]) -> str:
        raw = spec.get("workspace") or spec.get("repo_root") or self.default_workspace
        if not raw:
            raise ValueError("team task requires task_spec.workspace or manager default workspace")
        return str(Path(raw).expanduser().resolve())

    def _team_checkpoint(self, task_id: str, attempt_id: str, spec: dict[str, Any]) -> dict[str, Any]:
        return {
            "task_id": task_id,
            "attempt_id": attempt_id,
            "task_spec": spec,
            "instruction": "Resume this delegated coding task from persisted context.",
        }

    def _team_context_package(
        self,
        *,
        task: dict[str, Any],
        workspace: str,
        session_id: Optional[str],
    ) -> str:
        spec = task.get("task_spec") or {}
        query = str(spec.get("memory_query") or "").strip().lower()
        scopes = [
            self.memory_store.list(scope=Scope.GLOBAL),
            self.memory_store.list(scope=Scope.WORKSPACE, workspace=workspace),
        ]
        if session_id:
            scopes.append(self.memory_store.list(scope=Scope.SESSION, session_id=session_id))
        seen: set[int] = set()
        selected = []
        for items in scopes:
            for item in items:
                if item.id in seen:
                    continue
                text = item.content
                if query and query not in text.lower():
                    continue
                seen.add(item.id)
                selected.append(item)
                if len(selected) >= 20:
                    break
            if len(selected) >= 20:
                break
        lines: list[str] = []
        budget = 8000
        for item in selected:
            line = f"- [#{item.id} {item.scope.value}] {item.content}"
            if len("\n".join(lines)) + len(line) + 1 > budget:
                break
            lines.append(line)
        if not lines:
            return ""
        return (
            "Scoped knowledge package. These are text memories only; do not request or "
            "use raw audio files.\n" + "\n".join(lines)
        )

    def _followup_reopen_messages(self, task_id: str) -> list[dict[str, Any]]:
        reopen_ids = {
            str(event.payload.get("message_id"))
            for event in self.orchestrator.store.list_events(
                aggregate_type="task",
                aggregate_id=task_id,
            )
            if event.event_type == "agent.message.followup_reopen"
        }
        if not reopen_ids:
            return []
        return [
            item
            for item in self.orchestrator.pending_messages(task_id)
            if str(item.get("message_id")) in reopen_ids
        ]

    def _followup_reopen_source(self, task_id: str) -> Optional[dict[str, Any]]:
        events = [
            event
            for event in self.orchestrator.store.list_events(
                aggregate_type="task",
                aggregate_id=task_id,
            )
            if event.event_type == "agent.message.followup_reopen"
        ]
        return dict(events[-1].payload) if events else None

    def _team_executor_prompt(
        self,
        *,
        task: dict[str, Any],
        attempt_id: str,
        workspace: str,
        rework_message: Optional[str] = None,
    ) -> str:
        spec = task.get("task_spec") or {}
        context = self._team_context_package(
            task=task,
            workspace=workspace,
            session_id=task.get("conversation_id"),
        )
        payload = {
            "task_id": task.get("task_id"),
            "attempt_id": attempt_id,
            "workspace": workspace,
            "task_spec": spec,
        }
        parts = [
            "You are the executor Agent in qh-openworker. Work only in the provided "
            "workspace/worktree, keep changes minimal, and finish with a concise structured summary.",
            json.dumps(payload, ensure_ascii=False, indent=2),
        ]
        if context:
            parts.append(context)
        if rework_message:
            parts.append("Rework request from reviewer/tests:\n" + rework_message)
        return "\n\n".join(parts)

    @staticmethod
    def _latest_attempt(task: dict[str, Any], *, role: str) -> Optional[dict[str, Any]]:
        attempts = [
            item for item in task.get("attempts") or [] if item.get("role") == role
        ]
        return attempts[-1] if attempts else None

    @staticmethod
    def _latest_artifact(task: dict[str, Any], *, kind: str) -> Optional[dict[str, Any]]:
        artifacts = [item for item in task.get("artifacts") or [] if item.get("kind") == kind]
        if not artifacts:
            return None
        artifact = dict(artifacts[-1])
        artifact.setdefault("artifact_id", artifact.get("id"))
        return artifact

    @staticmethod
    def _profile_role(profile: AgentProfile) -> str:
        return str(getattr(profile.role, "value", profile.role))

    async def _open_team_session(
        self,
        *,
        profile: AgentProfile,
        cwd: str,
        existing_session_id: Optional[str],
        checkpoint: dict[str, Any],
    ) -> tuple[Any, Any]:
        adapter = self._agent_adapter(profile)
        if profile.transport == Transport.ACP_STDIO:
            handle = await adapter.open_session(
                profile,
                cwd=cwd,
                existing_session_id=existing_session_id,
                checkpoint=checkpoint,
                mcp_servers=self._team_mcp_servers(role=self._profile_role(profile)),
            )
        else:
            handle = await adapter.open_session(
                profile,
                cwd=cwd,
                existing_session_id=existing_session_id,
            )
        return adapter, handle

    @staticmethod
    def _mission_plan_members(task: dict[str, Any]) -> list[dict[str, Any]]:
        plan = (task.get("task_spec") or {}).get("plan") or {}
        members = plan.get("members") if isinstance(plan, dict) else None
        return [dict(member) for member in members or [] if isinstance(member, dict)]

    @staticmethod
    def _latest_attempt_for_member(
        task: dict[str, Any], *, role: str, profile_id: str
    ) -> Optional[dict[str, Any]]:
        attempts = [
            item
            for item in task.get("attempts") or []
            if item.get("role") == role and item.get("agent_profile_id") == profile_id
        ]
        return attempts[-1] if attempts else None

    @staticmethod
    def _preflight_artifact_for_guard(
        task: dict[str, Any], prompt_guard_id: str
    ) -> Optional[dict[str, Any]]:
        for item in reversed(task.get("artifacts") or []):
            if (item.get("metadata") or {}).get("prompt_guard_id") != prompt_guard_id:
                continue
            artifact = dict(item)
            artifact.setdefault("artifact_id", artifact.get("id"))
            return artifact
        return None

    def _mission_specialist_prompt(
        self,
        *,
        task: dict[str, Any],
        member: dict[str, Any],
        attempt_id: str,
        workspace: str,
    ) -> str:
        role = str(member.get("role") or "")
        context = self._team_context_package(
            task=task,
            workspace=workspace,
            session_id=task.get("conversation_id"),
        )
        payload = {
            "task_id": task.get("task_id"),
            "attempt_id": attempt_id,
            "role": role,
            "workspace": workspace,
            "goal": (task.get("task_spec") or {}).get("goal") or task.get("title"),
            "member": member,
        }
        if role == AgentRole.EXPLORER.value:
            instruction = (
                "You are the read-only explorer Agent. Inspect the workspace, identify the "
                "minimal implementation context, likely files, risks, and test strategy. "
                "Do not modify files or run write commands. Return a concise structured summary."
            )
        else:
            instruction = (
                "You are the read-only GUI specialist Agent. Inspect only the UI surface and "
                "return visual/interaction guidance, impacted files, and evidence needed. "
                "Do not modify files or run write commands."
            )
        parts = [instruction, json.dumps(payload, ensure_ascii=False, indent=2)]
        if context:
            parts.append(context)
        return "\n\n".join(parts)

    async def _run_mission_preflight_members(self, task: dict[str, Any]) -> None:
        """Run safe Mission specialists before the single writer starts.

        Main remains a synthetic/orchestrator seat in this MVP. Explorer and
        read-only GUI seats can produce context before executor owns a worktree.
        Unsafe GUI profiles are explicitly skipped instead of sharing the
        executor worktree or pretending to have run.
        """

        task_id = str(task["task_id"])
        spec = task.get("task_spec") or {}
        workspace = str(self._task_workspace(spec))
        for member in self._mission_plan_members(task):
            role = str(member.get("role") or "")
            if role not in {AgentRole.EXPLORER.value, AgentRole.GUI.value}:
                continue
            member_id = str(member.get("id") or member.get("seat_id") or "")
            profile_id = str(member.get("profile_id") or "")
            if not member_id or not profile_id:
                continue
            task = self.agent_task_result(task_id)
            prompt_guard_id = f"{task_id}:member_preflight:{member_id}"
            if self._preflight_artifact_for_guard(task, prompt_guard_id) is not None:
                continue
            profile = self.agent_profiles.get(profile_id)
            if profile is None or not profile.enabled:
                self.orchestrator.update_mission_member_status(
                    task_id,
                    member_id=member_id,
                    profile_id=profile_id,
                    role=role,
                    status="blocked",
                    event_id=f"{prompt_guard_id}:blocked:profile",
                    details={"reason": "profile is missing or disabled"},
                )
                raise ValueError(f"invalid {role} profile: {profile_id}")
            if self._profile_role(profile) != role:
                self.orchestrator.update_mission_member_status(
                    task_id,
                    member_id=member_id,
                    profile_id=profile_id,
                    role=role,
                    status="blocked",
                    event_id=f"{prompt_guard_id}:blocked:role",
                    details={"reason": "profile role does not match member role"},
                )
                raise ValueError(f"{role} member profile role mismatch: {profile_id}")
            if role == AgentRole.EXPLORER.value and profile.permission_policy != "read-only":
                self.orchestrator.update_mission_member_status(
                    task_id,
                    member_id=member_id,
                    profile_id=profile_id,
                    role=role,
                    status="blocked",
                    event_id=f"{prompt_guard_id}:blocked:permission",
                    details={"reason": "explorer profiles must be read-only"},
                )
                raise ValueError("explorer profiles must be read-only")
            if role == AgentRole.GUI.value and profile.permission_policy != "read-only":
                skip_event_id = f"{prompt_guard_id}:skipped:unsafe_gui"
                if self.orchestrator.store.get_event(skip_event_id) is not None:
                    continue
                self.orchestrator.update_mission_member_status(
                    task_id,
                    member_id=member_id,
                    profile_id=profile_id,
                    role=role,
                    status="skipped",
                    event_id=skip_event_id,
                    details={
                        "reason": (
                            "gui profile is not read-only; deferred until isolated "
                            "GUI worktree scheduling is available"
                        )
                    },
                )
                self.add_agent_artifact(
                    task_id,
                    {
                        "kind": "gui.deferred",
                        "payload": {
                            "member_id": member_id,
                            "profile_id": profile_id,
                            "reason": "unsafe gui profile deferred",
                        },
                    },
                )
                await self._enqueue_team_delivery(
                    task,
                    {
                        "summary": "gui specialist skipped",
                        "member_id": member_id,
                        "reason": "unsafe gui profile deferred",
                    },
                    delivery_id=f"{prompt_guard_id}:delivery",
                )
                continue

            latest = self._latest_attempt_for_member(
                task, role=role, profile_id=profile_id
            )
            if latest is None or latest.get("state") in {"completed", "failed", "cancelled"}:
                latest = self.start_agent_attempt(
                    task_id,
                    {
                        "profile_id": profile_id,
                        "role": role,
                        "rework_round": self.orchestrator.store.rework_round_count(task_id),
                    },
                )
            attempt_id = str(latest["attempt_id"])
            first_execution = self.orchestrator.store.should_execute_once(
                prompt_guard_id,
                event_type="agent.prompt.started",
                aggregate_type="task",
                aggregate_id=task_id,
                payload={
                    "attempt_id": attempt_id,
                    "role": role,
                    "member_id": member_id,
                },
            )
            if not first_execution:
                raise RuntimeError(
                    f"{role} preflight outcome is unknown; refusing automatic replay"
                )
            adapter = None
            handle = None
            try:
                adapter, handle = await self._open_team_session(
                    profile=profile,
                    cwd=workspace,
                    existing_session_id=latest.get("agent_session_id"),
                    checkpoint={
                        "task_id": task_id,
                        "attempt_id": attempt_id,
                        "member_id": member_id,
                        "role": role,
                    },
                )
                self.orchestrator.save_agent_session(
                    session_id=handle.session_id,
                    conversation_id=str(task.get("conversation_id") or task_id),
                    profile_id=profile.id,
                    task_id=task_id,
                    attempt_id=attempt_id,
                    capabilities=handle.capabilities,
                    metadata={"role": role, "cwd": workspace, "read_only": True},
                )
                self.orchestrator.update_attempt(
                    attempt_id,
                    "running",
                    agent_session_id=handle.session_id,
                )
                prompt = self._mission_specialist_prompt(
                    task=task,
                    member=member,
                    attempt_id=attempt_id,
                    workspace=workspace,
                )
                result = await adapter.prompt(handle, prompt)
                artifact = self.add_agent_artifact(
                    task_id,
                    {
                        "kind": f"{role}.preflight",
                        "attempt_id": attempt_id,
                        "payload": {
                            "member_id": member_id,
                            "session_id": handle.session_id,
                            "stop_reason": str(result.stop_reason),
                            "text": result.text,
                            "prompt_guard_id": prompt_guard_id,
                            "events": [
                                event
                                for event in result.events
                                if isinstance(event, dict)
                                and event.get("type") != "acp.permission_requested"
                            ],
                        },
                    },
                )
                self.orchestrator.store.append_event(
                    {
                        "event_id": f"{prompt_guard_id}:completed",
                        "event_type": "agent.prompt.completed",
                        "aggregate_type": "task",
                        "aggregate_id": task_id,
                        "payload": {
                            "attempt_id": attempt_id,
                            "role": role,
                            "member_id": member_id,
                            "artifact_id": artifact.get("artifact_id"),
                        },
                    }
                )
                self.orchestrator.update_attempt(attempt_id, "completed")
                await self._enqueue_team_delivery(
                    task,
                    {
                        "summary": f"{role} specialist finished",
                        "member_id": member_id,
                        "artifact_id": artifact.get("artifact_id"),
                    },
                    delivery_id=f"{prompt_guard_id}:delivery",
                )
            except Exception:
                with contextlib.suppress(Exception):
                    self.orchestrator.update_attempt(attempt_id, "failed")
                raise
            finally:
                if adapter is not None and handle is not None:
                    with contextlib.suppress(Exception):
                        await adapter.close(handle)

    async def _ensure_executor_runtime(
        self, task: dict[str, Any]
    ) -> tuple[Any, Any, dict[str, Any], str]:
        task_id = str(task["task_id"])
        spec = task.get("task_spec") or {}
        profile_id = str(task.get("target_profile_id") or "opencode-executor")
        profile = self.agent_profiles.get(profile_id)
        if profile is None or not profile.enabled:
            raise ValueError(f"invalid target profile: {profile_id}")
        role_value = self._profile_role(profile)
        if role_value != "executor":
            raise ValueError("team worker currently requires an executor target profile")

        active = self._team_active.get(task_id)
        if active and active.get("role") == role_value:
            return active["adapter"], active["handle"], active["attempt"], active["cwd"]

        latest = self._latest_attempt(task, role=role_value)
        repo_workspace = self._task_workspace(spec)
        rework_round = self.orchestrator.store.rework_round_count(task_id)
        if latest is None or latest.get("state") in {"completed", "failed", "cancelled"}:
            reopen = self._followup_reopen_source(task_id)
            latest = self.start_agent_attempt(
                task_id,
                {
                    "profile_id": profile_id,
                    "role": role_value,
                    "agent_session_id": (reopen or {}).get("agent_session_id"),
                    "worktree_path": (reopen or {}).get("worktree"),
                    "rework_round": rework_round,
                },
            )
            if latest.get("worktree"):
                acquired = self.orchestrator.store.acquire_worktree_lease(
                    worktree=str(latest["worktree"]),
                    task_id=task_id,
                    attempt_id=str(latest["attempt_id"]),
                )
                if not acquired:
                    raise RuntimeError(f"worktree lease already held: {latest['worktree']}")
        attempt_id = str(latest["attempt_id"])
        cwd = latest.get("worktree") or repo_workspace

        if role_value == "executor" and profile.workspace_policy == "worktree" and not latest.get("worktree"):
            plan = self.worktrees.create_executor_worktree(
                repo_root=repo_workspace,
                task_id=task_id,
                attempt_id=attempt_id,
                base_ref=str(spec.get("base_ref") or "HEAD"),
            )
            self.orchestrator.store.update_attempt_worktree(attempt_id, plan.worktree_path)
            latest = {**latest, "worktree": plan.worktree_path}
            cwd = plan.worktree_path
            self.add_agent_artifact(
                task_id,
                {
                    "kind": "worktree.plan",
                    "attempt_id": attempt_id,
                    "path": plan.worktree_path,
                    "payload": plan.to_dict(),
                },
            )

        adapter, handle = await self._open_team_session(
            profile=profile,
            cwd=str(cwd),
            existing_session_id=latest.get("agent_session_id"),
            checkpoint=self._team_checkpoint(task_id, attempt_id, spec),
        )
        self.orchestrator.save_agent_session(
            session_id=handle.session_id,
            conversation_id=str(task.get("conversation_id") or task_id),
            profile_id=profile.id,
            task_id=task_id,
            attempt_id=attempt_id,
            capabilities=handle.capabilities,
            metadata={"role": role_value, "cwd": str(cwd), "recovery_mode": handle.recovery_mode},
        )
        self.orchestrator.update_attempt(
            attempt_id,
            "running",
            agent_session_id=handle.session_id,
        )
        latest = {**latest, "agent_session_id": handle.session_id, "worktree": str(cwd)}
        self._team_active[task_id] = {
            "role": role_value,
            "adapter": adapter,
            "handle": handle,
            "attempt": latest,
            "cwd": str(cwd),
        }
        return adapter, handle, latest, str(cwd)

    async def _run_executor_prompt(
        self, task: dict[str, Any], *, rework_message: Optional[str] = None
    ) -> dict[str, Any]:
        task_id = str(task["task_id"])
        adapter, handle, attempt, cwd = await self._ensure_executor_runtime(task)
        attempt_id = str(attempt["attempt_id"])
        followups = self._followup_reopen_messages(task_id)
        followup_message_ids = [
            str(item.get("message_id") or "")
            for item in followups
            if str(item.get("message_id") or "")
        ]
        if followups:
            prompt = "[user-followup]\n" + "\n\n".join(
                str(item.get("message") or "").strip()
                for item in followups
                if str(item.get("message") or "").strip()
            )
        else:
            prompt = self._team_executor_prompt(
                task=task,
                attempt_id=attempt_id,
                workspace=cwd,
                rework_message=rework_message,
            )
        turn_identity = (
            "followup:" + ",".join(followup_message_ids)
            if followup_message_ids
            else "state:"
            + str(task.get("state") or "IMPLEMENTING")
            + ":rework:"
            + str(self.orchestrator.store.rework_round_count(task_id))
        )
        turn_digest = hashlib.sha256(turn_identity.encode("utf-8")).hexdigest()[:20]
        prompt_guard_id = f"{task_id}:executor_prompt:{attempt_id}:{turn_digest}"
        existing = self._execution_artifact_for_guard(task, prompt_guard_id)
        if existing is not None:
            for message_id in followup_message_ids:
                self.orchestrator.mark_message_delivered(task_id, message_id)
            return existing
        first_execution = self.orchestrator.store.should_execute_once(
            prompt_guard_id,
            event_type="agent.prompt.started",
            aggregate_type="task",
            aggregate_id=task_id,
            payload={
                "attempt_id": attempt_id,
                "role": "executor",
                "turn_identity": turn_identity,
                "message_ids": followup_message_ids,
            },
        )
        if not first_execution:
            raise RuntimeError(
                "executor prompt outcome is unknown; refusing automatic replay"
            )
        result = await adapter.prompt(handle, prompt)
        artifact = self.add_agent_artifact(
            task_id,
            {
                "kind": "execution",
                "attempt_id": attempt_id,
                "payload": {
                    "session_id": handle.session_id,
                    "stop_reason": str(result.stop_reason),
                    "text": result.text,
                    "prompt_guard_id": prompt_guard_id,
                    "followup_message_ids": followup_message_ids,
                    "events": [
                        event
                        for event in result.events
                        if isinstance(event, dict)
                        and event.get("type") != "acp.permission_requested"
                    ],
                },
            },
        )
        self.orchestrator.store.append_event(
            {
                "event_id": f"{prompt_guard_id}:completed",
                "event_type": "agent.prompt.completed",
                "aggregate_type": "task",
                "aggregate_id": task_id,
                "payload": {
                    "attempt_id": attempt_id,
                    "artifact_id": artifact.get("artifact_id"),
                    "message_ids": followup_message_ids,
                },
            }
        )
        for message_id in followup_message_ids:
            self.orchestrator.mark_message_delivered(task_id, message_id)
        return artifact

    @staticmethod
    def _execution_artifact_for_guard(
        task: dict[str, Any], prompt_guard_id: str
    ) -> Optional[dict[str, Any]]:
        for item in reversed(task.get("artifacts") or []):
            if item.get("kind") != "execution":
                continue
            if (item.get("metadata") or {}).get("prompt_guard_id") != prompt_guard_id:
                continue
            artifact = dict(item)
            artifact.setdefault("artifact_id", artifact.get("id"))
            return artifact
        return None

    def _retain_team_worktree(self, task: dict[str, Any], *, state: str) -> None:
        task_id = str(task["task_id"])
        attempt = self._latest_attempt(task, role="executor")
        if not attempt or not attempt.get("worktree"):
            return
        attempt_id = str(attempt["attempt_id"])
        event_id = f"{task_id}:worktree_retained:{attempt_id}:{state}"
        inserted = self.orchestrator.store.should_execute_once(
            event_id,
            event_type="worktree.retained",
            aggregate_type="task",
            aggregate_id=task_id,
            payload={
                "attempt_id": attempt_id,
                "worktree": attempt.get("worktree"),
                "state": state,
            },
        )
        if inserted:
            self.add_agent_artifact(
                task_id,
                {
                    "kind": "worktree.retained",
                    "attempt_id": attempt_id,
                    "path": attempt.get("worktree"),
                    "payload": {
                        "attempt_id": attempt_id,
                        "worktree": attempt.get("worktree"),
                        "state": state,
                    },
                },
            )

    async def _enqueue_terminal_delivery_once(
        self, task: dict[str, Any], *, state: str
    ) -> None:
        task_id = str(task["task_id"])
        attempt = self._latest_attempt(task, role="executor") or {}
        key_attempt = str(attempt.get("attempt_id") or "none")
        await self._enqueue_team_delivery(
            task,
            {
                "summary": f"team task {state.lower()}",
                "state": state,
                "task_id": task_id,
            },
            delivery_id=f"delivery_terminal:{task_id}:{key_attempt}:{state}",
        )

    async def _deliver_attempt_target_messages(
        self, task_id: str, attempt_id: str
    ) -> list[str]:
        """Resume/load a specialist ACP session and deliver its queued follow-ups."""

        attempt = self.orchestrator.store.get_attempt(attempt_id)
        if attempt is None or attempt.task_id != task_id:
            raise OrchestrationStoreError("message target attempt does not belong to mission")
        if not attempt.agent_session_id:
            raise OrchestrationStoreError(
                "attempt follow-up requires a recoverable agent session"
            )
        profile = self.agent_profiles.get(attempt.agent_profile_id)
        if profile is None or not profile.enabled or profile.role != attempt.role:
            raise OrchestrationStoreError("attempt Agent profile is unavailable")
        task = self.agent_task_result(task_id)
        spec = task.get("task_spec") or {}
        cwd = str(attempt.worktree or self._task_workspace(spec))
        pending = [
            item
            for item in self.orchestrator.pending_messages(task_id)
            if isinstance(item.get("target"), dict)
            and item["target"].get("kind") == "attempt"
            and str(item["target"].get("attempt_id") or "") == attempt_id
        ]
        if not pending:
            return []

        adapter = None
        handle = None
        delivered: list[str] = []
        try:
            adapter, handle = await self._open_team_session(
                profile=profile,
                cwd=cwd,
                existing_session_id=attempt.agent_session_id,
                checkpoint={
                    "task_id": task_id,
                    "attempt_id": attempt_id,
                    "role": attempt.role.value,
                    "mode": "user-followup",
                },
            )
            self.orchestrator.save_agent_session(
                session_id=handle.session_id,
                conversation_id=str(task.get("conversation_id") or task_id),
                profile_id=profile.id,
                task_id=task_id,
                attempt_id=attempt_id,
                capabilities=handle.capabilities,
                metadata={
                    "role": attempt.role.value,
                    "cwd": cwd,
                    "recovery_mode": handle.recovery_mode,
                    "followup": True,
                },
            )
            if handle.session_id != attempt.agent_session_id:
                self.orchestrator.store.update_attempt_status(
                    attempt_id,
                    attempt.status,
                    agent_session_id=handle.session_id,
                )
            for item in pending:
                message_id = str(item.get("message_id") or "")
                message = str(item.get("message") or "").strip()
                if not message_id or not message:
                    if message_id:
                        self.orchestrator.mark_message_delivered(task_id, message_id)
                        delivered.append(message_id)
                    continue
                guard_id = f"{message_id}:agent_prompt"
                first_execution = self.orchestrator.store.should_execute_once(
                    guard_id,
                    event_type="agent.message.prompt.started",
                    aggregate_type="task",
                    aggregate_id=task_id,
                    payload={"message_id": message_id, "attempt_id": attempt_id},
                )
                if not first_execution:
                    completed = self.orchestrator.store.get_event(
                        f"{guard_id}:completed"
                    )
                    if completed is not None:
                        self.orchestrator.mark_message_delivered(task_id, message_id)
                        delivered.append(message_id)
                        continue
                    raise RuntimeError(
                        f"message {message_id} prompt outcome is unknown; refusing replay"
                    )
                turn = await adapter.prompt(handle, "[user-followup]\n" + message)
                artifact = self.add_agent_artifact(
                    task_id,
                    {
                        "kind": f"{attempt.role.value}.followup",
                        "attempt_id": attempt_id,
                        "payload": {
                            "message_id": message_id,
                            "session_id": handle.session_id,
                            "stop_reason": str(turn.stop_reason),
                            "text": turn.text,
                        },
                    },
                )
                self.orchestrator.store.append_event(
                    {
                        "event_id": f"{guard_id}:completed",
                        "event_type": "agent.message.prompt.completed",
                        "aggregate_type": "task",
                        "aggregate_id": task_id,
                        "payload": {
                            "message_id": message_id,
                            "attempt_id": attempt_id,
                            "artifact_id": artifact.get("artifact_id"),
                        },
                    }
                )
                self.orchestrator.mark_message_delivered(task_id, message_id)
                delivered.append(message_id)
        finally:
            if adapter is not None and handle is not None:
                with contextlib.suppress(Exception):
                    await adapter.close(handle)
        return delivered

    async def _deliver_pending_task_messages(self, task: dict[str, Any]) -> None:
        task_id = str(task["task_id"])
        active = self._team_active.get(task_id)
        if not active:
            return
        adapter = active["adapter"]
        handle = active["handle"]
        active_attempt_id = str((active.get("attempt") or {}).get("attempt_id") or "")
        for item in self.orchestrator.pending_messages(task_id):
            target = item.get("target") if isinstance(item.get("target"), dict) else {}
            target_kind = str(target.get("kind") or "")
            if target_kind == "main":
                continue
            if (
                target_kind == "attempt"
                and str(target.get("attempt_id") or "") != active_attempt_id
            ):
                continue
            message_id = str(item.get("message_id") or "")
            message = str(item.get("message") or "").strip()
            if not message:
                if message_id:
                    self.orchestrator.mark_message_delivered(task_id, message_id)
                continue
            guard_id = f"{message_id}:agent_prompt"
            first_execution = self.orchestrator.store.should_execute_once(
                guard_id,
                event_type="agent.message.prompt.started",
                aggregate_type="task",
                aggregate_id=task_id,
                payload={"message_id": message_id},
            )
            if not first_execution:
                completed = any(
                    event.event_id == f"{guard_id}:completed"
                    for event in self.orchestrator.store.list_events(
                        aggregate_type="task", aggregate_id=task_id
                    )
                )
                if completed and message_id:
                    self.orchestrator.mark_message_delivered(task_id, message_id)
                    continue
                raise RuntimeError(
                    f"message {message_id} prompt outcome is unknown; refusing replay"
                )
            await adapter.prompt(handle, "[user-followup]\n" + message)
            self.orchestrator.store.append_event(
                {
                    "event_id": f"{guard_id}:completed",
                    "event_type": "agent.message.prompt.completed",
                    "aggregate_type": "task",
                    "aggregate_id": task_id,
                    "payload": {"message_id": message_id},
                }
            )
            if message_id:
                self.orchestrator.mark_message_delivered(task_id, message_id)

    async def _run_team_verification(
        self, task: dict[str, Any], *, attempt: dict[str, Any], cwd: str
    ) -> dict[str, Any]:
        spec = task.get("task_spec") or {}
        commands: list[list[str]] = []
        configured = spec.get("test_commands")
        if isinstance(configured, list):
            for item in configured:
                if isinstance(item, str):
                    commands.append(shlex.split(item))
                elif isinstance(item, list):
                    commands.append([str(part) for part in item])
        if not commands:
            root = Path(cwd)
            if (root / "pyproject.toml").exists() and (root / "tests").is_dir():
                commands.append([sys.executable, "-m", "pytest", "-q"])

        results: list[dict[str, Any]] = []
        skipped = not commands
        passed = True
        timeout = float((spec.get("verification_timeout_seconds") or 600))
        for argv in commands:
            if not argv:
                continue
            if not self._is_safe_verification_command(argv):
                results.append(
                    {
                        "argv": argv,
                        "passed": False,
                        "error": "verification command is outside the host test-runner allowlist",
                    }
                )
                passed = False
                continue
            started = time.time()
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    cwd=cwd,
                    env=build_minimal_env(),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
                stdout = stdout_b.decode("utf-8", errors="replace")[-12000:]
                stderr = stderr_b.decode("utf-8", errors="replace")[-12000:]
                ok = proc.returncode == 0
                results.append(
                    {
                        "argv": argv,
                        "returncode": proc.returncode,
                        "passed": ok,
                        "duration_seconds": round(time.time() - started, 3),
                        "stdout": stdout,
                        "stderr": stderr,
                    }
                )
                passed = passed and ok
            except asyncio.TimeoutError:
                with contextlib.suppress(Exception):
                    proc.kill()  # type: ignore[name-defined]
                results.append({"argv": argv, "passed": False, "timeout_seconds": timeout})
                passed = False

        artifact = self.add_agent_artifact(
            str(task["task_id"]),
            {
                "kind": "verification",
                "attempt_id": attempt.get("attempt_id"),
                "payload": {
                    "passed": passed and not skipped,
                    "skipped": skipped,
                    "commands": commands,
                    "results": results,
                },
            },
        )
        return {**artifact, "passed": passed and not skipped, "skipped": skipped}

    @staticmethod
    def _is_safe_verification_command(argv: list[str]) -> bool:
        """Accept test runners only; never execute arbitrary task-provided programs."""

        if not argv:
            return False
        raw_executable = Path(argv[0])
        if raw_executable.is_absolute() and raw_executable.resolve() != Path(
            sys.executable
        ).resolve():
            return False
        if not raw_executable.is_absolute() and len(raw_executable.parts) != 1:
            return False
        executable = raw_executable.name.lower()
        if executable.endswith(".exe"):
            executable = executable[:-4]
        python_names = {
            "python",
            "python3",
            f"python{sys.version_info.major}.{sys.version_info.minor}",
            Path(sys.executable).name.lower(),
        }
        if executable in python_names:
            return len(argv) >= 3 and argv[1:3] == ["-m", "pytest"]
        if executable in {"pytest", "py.test"}:
            return True
        if executable in {"npm", "pnpm", "yarn", "bun"}:
            return (len(argv) >= 2 and argv[1] == "test") or (
                len(argv) >= 3 and argv[1:3] == ["run", "test"]
            )
        if executable == "cargo":
            return len(argv) >= 2 and argv[1] == "test"
        if executable == "go":
            return len(argv) >= 2 and argv[1] == "test"
        if executable in {"mvn", "mvnw", "gradle", "gradlew"}:
            return len(argv) >= 2 and argv[1] in {"test", "check"}
        return False

    def _verification_failed_message(self, artifact: dict[str, Any]) -> str:
        meta = artifact.get("metadata") or {}
        if meta.get("skipped"):
            return "Verification was skipped because no safe test command was configured or detected."
        failures = [item for item in meta.get("results") or [] if not item.get("passed")]
        return "Verification failed:\n" + json.dumps(failures, ensure_ascii=False, indent=2)

    @staticmethod
    def _existing_review_for_artifact(
        task: dict[str, Any], artifact_id: str
    ) -> Optional[dict[str, Any]]:
        for review in reversed(task.get("reviews") or []):
            if str(review.get("artifact_id") or "") == artifact_id:
                return dict(review)
        return None

    def _resume_recorded_review(
        self,
        task_id: str,
        review: dict[str, Any],
        *,
        tests_passed: bool,
    ) -> dict[str, Any]:
        """Finish state transitions after a review row committed before a crash."""

        attempt_id = str(review.get("reviewer_attempt_id") or "")
        if attempt_id:
            with contextlib.suppress(Exception):
                self.orchestrator.update_attempt(attempt_id, "completed")
        current = self.agent_task_status(task_id)
        if current.get("state") != "REVIEWING":
            return current
        verdict = str(review.get("verdict") or "request_changes")
        effective_verdict = verdict
        if verdict == "pass" and not tests_passed:
            effective_verdict = "request_changes"
        if effective_verdict == "pass":
            self.orchestrator.set_task_state(task_id, "APPROVED")
            self.orchestrator.set_task_state(task_id, "DONE")
        elif effective_verdict == "block":
            self.orchestrator.set_task_state(task_id, "BLOCKED")
        else:
            self.orchestrator.set_task_state(task_id, "CHANGES_REQUESTED")
        return {**self.agent_task_status(task_id), "effective_verdict": effective_verdict}

    async def _run_team_review(
        self,
        task: dict[str, Any],
        *,
        execution_artifact: dict[str, Any],
        verification_artifact: dict[str, Any],
        cwd: str,
    ) -> dict[str, Any]:
        task_id = str(task["task_id"])
        execution_artifact = dict(execution_artifact)
        verification_artifact = dict(verification_artifact)
        execution_artifact.setdefault("artifact_id", execution_artifact.get("id"))
        verification_artifact.setdefault("artifact_id", verification_artifact.get("id"))
        artifact_id = str(execution_artifact["artifact_id"])
        tests_passed = bool((verification_artifact.get("metadata") or {}).get("passed"))
        existing_review = self._existing_review_for_artifact(task, artifact_id)
        if existing_review is not None:
            return self._resume_recorded_review(
                task_id,
                existing_review,
                tests_passed=tests_passed,
            )
        prompt_guard_id = f"{task_id}:review_prompt:{artifact_id}"
        first_execution = self.orchestrator.store.should_execute_once(
            prompt_guard_id,
            event_type="agent.prompt.started",
            aggregate_type="task",
            aggregate_id=task_id,
            payload={"role": "reviewer", "artifact_id": artifact_id},
        )
        if not first_execution:
            for attempt in task.get("attempts") or []:
                if attempt.get("role") == "reviewer" and attempt.get("state") not in {
                    "completed",
                    "failed",
                    "cancelled",
                }:
                    with contextlib.suppress(Exception):
                        self.orchestrator.update_attempt(
                            str(attempt.get("attempt_id") or attempt.get("id")),
                            "failed",
                        )
            raise RuntimeError(
                "reviewer prompt outcome is unknown; refusing automatic replay"
            )
        reviewer_profile = self.agent_profiles.get("opencode-reviewer")
        if reviewer_profile is None or not reviewer_profile.enabled:
            raise ValueError("opencode-reviewer profile is missing or disabled")
        reviewed = self.request_agent_review(execution_artifact["artifact_id"], {})
        if reviewed.get("state") != "REVIEWING":
            raise RuntimeError("review request did not enter REVIEWING")
        attempt = self.start_agent_attempt(
            task_id,
            {"profile_id": reviewer_profile.id, "role": "reviewer"},
        )
        attempt_id = str(attempt["attempt_id"])
        adapter = None
        handle = None
        try:
            adapter, handle = await self._open_team_session(
                profile=reviewer_profile,
                cwd=cwd,
                existing_session_id=attempt.get("agent_session_id"),
                checkpoint={
                    "task_id": task_id,
                    "reviewer_attempt_id": attempt_id,
                    "artifact_id": execution_artifact["artifact_id"],
                },
            )
            self.orchestrator.save_agent_session(
                session_id=handle.session_id,
                conversation_id=str(task.get("conversation_id") or task_id),
                profile_id=reviewer_profile.id,
                task_id=task_id,
                attempt_id=attempt_id,
                capabilities=handle.capabilities,
                metadata={"role": "reviewer", "cwd": cwd, "read_only": True},
            )
            self.orchestrator.update_attempt(
                attempt_id, "running", agent_session_id=handle.session_id
            )
            prompt = (
                "You are the read-only reviewer Agent. Inspect the fixed artifacts only. "
                "Return strict JSON: {\"verdict\":\"pass|request_changes|block\","
                "\"findings\":[{\"id\",\"severity\",\"path\",\"line\",\"title\",\"evidence\","
                "\"suggested_fix\"}],\"test_gaps\":[],\"confidence\":\"low|medium|high\"}.\n\n"
                + json.dumps(
                    {
                        "task_id": task_id,
                        "execution_artifact": execution_artifact,
                        "verification_artifact": verification_artifact,
                        "worktree": cwd,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            result = await adapter.prompt(handle, prompt)
            parsed = self._parse_review_result(result.text)
            recorded = self.record_agent_review(
                task_id,
                {
                    "artifact_id": artifact_id,
                    "result": parsed,
                    "reviewer_profile_id": reviewer_profile.id,
                    "reviewer_attempt_id": attempt_id,
                    "tests_passed": tests_passed,
                },
            )
            self.orchestrator.store.append_event(
                {
                    "event_id": f"{prompt_guard_id}:completed",
                    "event_type": "agent.prompt.completed",
                    "aggregate_type": "task",
                    "aggregate_id": task_id,
                    "payload": {
                        "role": "reviewer",
                        "artifact_id": artifact_id,
                        "review_id": (recorded.get("review") or {}).get("id"),
                    },
                }
            )
            return recorded
        except Exception:
            with contextlib.suppress(Exception):
                self.orchestrator.update_attempt(attempt_id, "failed")
            raise
        finally:
            if adapter is not None and handle is not None:
                with contextlib.suppress(Exception):
                    await adapter.close(handle)

    async def _close_team_runtime(
        self,
        task_id: str,
        *,
        cancel: bool = False,
        final_attempt_status: Optional[str] = None,
    ) -> None:
        active = self._team_active.pop(task_id, None)
        if not active:
            if final_attempt_status:
                with contextlib.suppress(Exception):
                    task = self.agent_task_result(task_id)
                    attempt = self._latest_attempt(task, role="executor") or {}
                    if attempt.get("attempt_id") and attempt.get("state") not in {
                        "completed",
                        "failed",
                        "cancelled",
                    }:
                        self.orchestrator.update_attempt(
                            str(attempt["attempt_id"]), final_attempt_status
                        )
            return
        adapter = active.get("adapter")
        handle = active.get("handle")
        attempt = active.get("attempt") or {}
        if adapter is not None and handle is not None:
            if cancel:
                with contextlib.suppress(Exception):
                    await adapter.cancel(handle)
            with contextlib.suppress(Exception):
                await adapter.close(handle)
        if final_attempt_status and attempt.get("attempt_id"):
            with contextlib.suppress(Exception):
                self.orchestrator.update_attempt(str(attempt["attempt_id"]), final_attempt_status)

    async def _team_process_task(self, task_id: str) -> None:
        try:
            while True:
                task = self.agent_task_result(task_id)
                state = str(task.get("state"))
                if state in {"DONE", "BLOCKED", "CANCELLED"}:
                    self._retain_team_worktree(task, state=state)
                    final = (
                        "cancelled"
                        if state == "CANCELLED"
                        else "completed"
                        if state == "DONE"
                        else "failed"
                    )
                    await self._close_team_runtime(
                        task_id,
                        cancel=state == "CANCELLED",
                        final_attempt_status=final,
                    )
                    await self._enqueue_terminal_delivery_once(task, state=state)
                    attempt = self._latest_attempt(task, role="executor") or {}
                    self.orchestrator.store.should_execute_once(
                        self._terminal_finalization_id(task, state=state),
                        event_type="task.terminal.finalized",
                        aggregate_type="task",
                        aggregate_id=task_id,
                        payload={
                            "state": state,
                            "attempt_id": attempt.get("attempt_id"),
                        },
                    )
                    return

                if state == "QUEUED":
                    await self._run_mission_preflight_members(task)
                    self.orchestrator.set_task_state(task_id, "IMPLEMENTING")
                    continue

                if state in {"IMPLEMENTING", "REWORK"}:
                    profile = self.agent_profiles.get(str(task.get("target_profile_id") or "opencode-executor"))
                    rework_message = None
                    if state == "REWORK":
                        reviews = task.get("reviews") or []
                        rework_message = json.dumps(reviews[-1] if reviews else {}, ensure_ascii=False)
                    execution_artifact = await self._run_executor_prompt(
                        task, rework_message=rework_message
                    )
                    await self._deliver_pending_task_messages(task)
                    self.orchestrator.set_task_state(task_id, "VERIFYING")
                    await self._enqueue_team_delivery(
                        task,
                        {
                            "summary": "executor finished",
                            "artifact_id": execution_artifact.get("artifact_id"),
                        },
                    )
                    continue

                if state == "VERIFYING":
                    attempt = self._latest_attempt(task, role="executor")
                    if not attempt:
                        raise RuntimeError("VERIFYING task has no executor attempt")
                    cwd = attempt.get("worktree") or self._task_workspace(task.get("task_spec") or {})
                    verification = await self._run_team_verification(
                        task, attempt=attempt, cwd=str(cwd)
                    )
                    if not verification.get("passed"):
                        message = self._verification_failed_message(verification)
                        self.orchestrator.set_task_state(task_id, "BLOCKED")
                        await self._enqueue_team_delivery(
                            task,
                            {
                                "summary": "verification failed",
                                "artifact_id": verification.get("artifact_id"),
                                "message": message,
                            },
                        )
                        continue
                    self.orchestrator.set_task_state(task_id, "REVIEWING")
                    continue

                if state == "REVIEWING":
                    attempt = self._latest_attempt(task, role="executor")
                    execution = self._latest_artifact(task, kind="execution")
                    verification = self._latest_artifact(task, kind="verification")
                    if not attempt or not execution or not verification:
                        raise RuntimeError("REVIEWING task is missing execution/verification artifacts")
                    cwd = str(attempt.get("worktree") or self._task_workspace(task.get("task_spec") or {}))
                    review_status = await self._run_team_review(
                        task,
                        execution_artifact=execution,
                        verification_artifact=verification,
                        cwd=cwd,
                    )
                    if review_status.get("state") == "CHANGES_REQUESTED":
                        if self.orchestrator.store.rework_round_count(task_id) < int(
                            task.get("max_rework_rounds", QhOrchestratorStore.DEFAULT_MAX_REWORK_ROUNDS)
                        ):
                            self.orchestrator.set_task_state(task_id, "REWORK")
                            continue
                        self.orchestrator.set_task_state(task_id, "BLOCKED")
                    continue

                if state == "CHANGES_REQUESTED":
                    if self.orchestrator.store.rework_round_count(task_id) < int(
                        task.get("max_rework_rounds", QhOrchestratorStore.DEFAULT_MAX_REWORK_ROUNDS)
                    ):
                        self.orchestrator.set_task_state(task_id, "REWORK")
                        continue
                    self.orchestrator.set_task_state(task_id, "BLOCKED")
                    continue

                return
        except asyncio.CancelledError:
            await self._close_team_runtime(task_id, cancel=True, final_attempt_status="cancelled")
            raise
        except Exception as exc:
            logger.exception("team worker task failed for %s: %s", task_id, exc)
            with contextlib.suppress(Exception):
                self.add_agent_artifact(
                    task_id,
                    {"kind": "team.error", "payload": {"error": str(exc)}},
                )
                self.orchestrator.set_task_state(task_id, "BLOCKED")
            await self._close_team_runtime(task_id, cancel=True, final_attempt_status="failed")
            with contextlib.suppress(Exception):
                await self._enqueue_team_delivery(
                    self.agent_task_status(task_id),
                    {"summary": "team task blocked", "error": str(exc)},
                )
        finally:
            self._team_jobs.pop(task_id, None)

    async def _enqueue_team_delivery(
        self,
        task: dict[str, Any],
        payload: dict[str, Any],
        *,
        delivery_id: Optional[str] = None,
    ) -> dict[str, Any]:
        return self.enqueue_agent_delivery(
            {
                "conversation_id": task.get("conversation_id"),
                "target_session_id": task.get("target_session_id")
                or task.get("conversation_id")
                or None,
                "source_task_id": task.get("task_id"),
                "payload": payload,
                "delivery_id": delivery_id,
            }
        )

    async def _team_worker_loop(self) -> None:
        try:
            while True:
                try:
                    await self._team_worker_iteration()
                except Exception as exc:
                    logger.warning("team worker iteration failed: %s", exc)
                await asyncio.sleep(self._team_worker_interval)
        except asyncio.CancelledError:
            return

    async def _team_worker_iteration(self) -> None:
        await self._drain_team_deliveries()
        states = [
            "QUEUED",
            "IMPLEMENTING",
            "VERIFYING",
            "REVIEWING",
            "CHANGES_REQUESTED",
            "REWORK",
            "DONE",
            "BLOCKED",
            "CANCELLED",
        ]
        for task in self.orchestrator.list_tasks(states):
            task_id = str(task["task_id"])
            state = str(task.get("state") or "")
            if state in {"DONE", "BLOCKED", "CANCELLED"} and self._terminal_finalized(
                task, state=state
            ):
                continue
            existing = self._team_jobs.get(task_id)
            if existing is not None and not existing.done():
                continue
            self._team_jobs[task_id] = asyncio.create_task(self._team_process_task(task_id))

    def _terminal_finalization_id(self, task: dict[str, Any], *, state: str) -> str:
        attempt = self._latest_attempt(task, role="executor") or {}
        attempt_id = str(attempt.get("attempt_id") or "none")
        return f"{task['task_id']}:terminal_finalized:{attempt_id}:{state}"

    def _terminal_finalized(self, task: dict[str, Any], *, state: str) -> bool:
        finalization_id = self._terminal_finalization_id(task, state=state)
        return any(
            event.event_id == finalization_id
            for event in self.orchestrator.store.list_events(
                aggregate_type="task",
                aggregate_id=str(task["task_id"]),
            )
        )

    def start_team_worker(self) -> None:
        if self._team_worker_task is not None and not self._team_worker_task.done():
            return
        loop = asyncio.get_running_loop()
        self._team_worker_task = loop.create_task(self._team_worker_loop())

    async def stop_team_worker(self) -> None:
        task = self._team_worker_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._team_worker_task = None
        jobs = list(self._team_jobs.values())
        self._team_jobs.clear()
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
        await asyncio.gather(
            *(self._close_team_runtime(task_id, cancel=True) for task_id in list(self._team_active)),
            return_exceptions=True,
        )

    async def _handle_acp_update(self, event: dict[str, Any]) -> None:
        logger.debug("acp update: %s", event.get("type"))
        session_id = event.get("session_id")
        if session_id:
            for runtime in getattr(self.main_acp_host, "_runtimes", {}).values():
                handle = getattr(runtime, "handle", None)
                if getattr(handle, "session_id", None) == session_id:
                    # MainAcpHost maps protocol events to the per-conversation UI stream.
                    # Returning here prevents the same token from also being emitted as an
                    # app-wide worker event and then replayed again at turn completion.
                    await self.main_acp_host.handle_update(event)
                    return
        await self.broadcast_event({"type": "agent_event", "data": event})

    async def _handle_main_acp_update(self, event: dict[str, Any]) -> None:
        agent_session_id = event.get("agent_session_id")
        conversation_id = None
        for runtime in getattr(self.main_acp_host, "_runtimes", {}).values():
            handle = getattr(runtime, "handle", None)
            if getattr(handle, "session_id", None) == agent_session_id:
                conversation_id = getattr(runtime, "conversation_id", None)
                break
        if not conversation_id:
            return
        await self.broadcast_session(
            str(conversation_id),
            {"type": str(event.get("type") or "agent_event"), "data": event},
        )

    @staticmethod
    def _parse_review_result(text: str) -> dict[str, Any]:
        if not text:
            return {"verdict": "request_changes", "findings": [], "test_gaps": ["empty review output"], "confidence": "low"}
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
        match = re.search(r"\{[\s\S]*\}", text)
        if match:
            try:
                data = json.loads(match.group(0))
                if isinstance(data, dict):
                    return data
            except Exception:
                pass
        return {"verdict": "request_changes", "findings": [], "test_gaps": [text[:500]], "confidence": "low"}

    # -- direct-message routing -------------------------------------------------
    def dm_session(self) -> Optional[str]:
        """The session a DM to the bot is routed to (user-designated). None → DMs are parked."""
        sid = self._prefs.get("dm_session")
        return sid or None

    def set_dm_session(self, session_id: Optional[str]) -> dict[str, Any]:
        """Designate (or clear, with a falsy id) the session that handles incoming DMs."""
        sid = (session_id or "").strip()
        if sid:
            self._prefs["dm_session"] = sid
        else:
            self._prefs.pop("dm_session", None)
        self._save_prefs()
        return {"ok": True, "dm_session": self.dm_session()}

    def _ollama_alive(self) -> bool:
        """Best-effort local-Ollama liveness, cached 30s (get_settings runs on every GUI
        fetch — no 2s probe inline). Keyless is not the same as PRESENT: `ollama:*` picker
        entries render only when an Ollama actually answers, so a machine with no Ollama
        never shows phantom local models (e.g. a stray pasted string saved as a model id,
        caught 2026-07-21)."""
        import time

        now = time.monotonic()
        cached = getattr(self, "_ollama_alive_cache", None)
        if cached and now - cached[0] < 30:
            return cached[1]
        profile = self.secrets.get("provider:ollama") or {}
        base = (profile.get("base_url") or "http://localhost:11434").strip().rstrip("/")
        if base.endswith("/v1"):
            base = base[: -len("/v1")]
        try:
            import httpx

            alive = httpx.get(base + "/api/tags", timeout=0.8).status_code == 200
        except Exception:
            alive = False
        self._ollama_alive_cache = (now, alive)
        return alive

    def _ollama_models(self) -> list[str]:
        """Live list of models pulled into the configured Ollama server (via its native
        `/api/tags`), as `ollama:<name>` so they're directly selectable. Empty if Ollama isn't
        configured or unreachable — best-effort, never raises."""
        profile = self.secrets.get("provider:ollama")
        if not profile:
            return []
        base = (profile.get("base_url") or "http://localhost:11434").strip().rstrip("/")
        if base.endswith("/v1"):
            base = base[: -len("/v1")]
        try:
            import httpx

            data = httpx.get(base + "/api/tags", timeout=2.0).json()
            return [
                f"ollama:{m['name']}" for m in data.get("models", []) if m.get("name")
            ]
        except Exception:
            return []

    def _curated_models(self) -> list[str]:
        """The models offered in the composer's selector: every curated-matrix model
        (`get_settings` culls the ones whose provider has no key) plus custom ids the user
        added, minus matrix models they removed. Deliberately NO built-in seed list — a
        fresh install offers nothing until a provider key exists, and then exactly that
        provider's matrix models appear. The active default is always kept selectable.
        """
        from ..providers.matrix import MATRIX

        user = self._prefs.get("models")
        user = user if isinstance(user, list) else []
        hidden = set(self._prefs.get("hidden_models") or [])
        models = [m for m in [*MATRIX, *user] if m not in hidden]
        return list(dict.fromkeys([self.model, *models]))

    def add_model(self, model: str) -> dict[str, Any]:
        """Add a model id (e.g. `gpt-4o`, `ollama:qwen2.5-coder:32b`) to the picker.
        Custom ids persist in prefs; a previously removed matrix model is just unhidden
        (storing it too would shadow future matrix updates). Junk ids are rejected up
        front — a model whose provider isn't configured is still accepted (the settings
        UI warns about that), only malformed strings are refused."""
        from ..providers.matrix import MATRIX

        model = (model or "").strip()
        if not model:
            return {"ok": False, "error": "empty model"}
        if len(model) > 200 or not model.isprintable() or any(
            c.isspace() for c in model
        ):
            return {
                "ok": False,
                "error": (
                    "invalid model id: printable, no whitespace, at most 200 "
                    'characters (e.g. "gpt-4o" or "ollama:qwen2.5-coder:32b")'
                ),
            }
        hidden = [m for m in self._prefs.get("hidden_models") or [] if m != model]
        if hidden:
            self._prefs["hidden_models"] = hidden
        else:
            self._prefs.pop("hidden_models", None)
        models = self._prefs.get("models")
        models = models if isinstance(models, list) else []
        if model not in models and model not in MATRIX:
            models.append(model)
        self._prefs["models"] = models
        self._save_prefs()
        return {"ok": True, **self.get_settings()}

    def remove_model(self, model: str) -> dict[str, Any]:
        """Remove a model id from the picker. Custom ids are dropped; matrix models are
        hidden by id (the matrix is derived, not stored, so a bare drop would resurrect
        them on the next read)."""
        from ..providers.matrix import MATRIX

        models = self._prefs.get("models")
        models = models if isinstance(models, list) else []
        self._prefs["models"] = [m for m in models if m != model]
        if model in MATRIX:
            hidden = self._prefs.get("hidden_models") or []
            if model not in hidden:
                self._prefs["hidden_models"] = [*hidden, model]
        self._save_prefs()
        return {"ok": True, **self.get_settings()}

    def get_settings(self) -> dict[str, Any]:
        """Model-access + UI status. Never returns the key; `source` says where it comes from."""
        import os

        current_provider = self._model_provider(self.model)
        current_descriptor = get_descriptor(current_provider)
        current_profile = self.secrets.get_raw(f"provider:{current_provider}") or {}
        credential_source = (
            provider_credential_source(
                current_descriptor,
                current_profile,
                self.secrets.resolve(current_profile),
            )
            if current_descriptor is not None
            else None
        )
        legacy_source = "env" if credential_source in {"env", "mixed"} else credential_source
        # Only surface models whose provider is actually configured — the composer picker
        # reflects exactly what's connected. The active default is always kept selectable
        # (it's hidden behind the "No model" state until a provider is connected anyway).
        # Ollama is keyless, so "configured" is meaningless there — its models show only
        # while a local Ollama answers (cached liveness probe).
        def _selectable(m: str) -> bool:
            provider = self._model_provider(m)
            if provider == "ollama":
                return self._ollama_alive()
            return self._provider_configured(provider)

        selectable = [m for m in self._curated_models() if _selectable(m)]
        if self.model not in selectable:
            selectable.insert(0, self.model)
        from ..providers.matrix import model_context_windows, model_labels

        return {
            "provider": current_provider,
            "model": self.model,
            "models": selectable,
            # Curated-matrix display names ({full id → "GLM-5.2 · via Together"}) so every
            # picker shows human labels; custom models absent here render their raw id.
            "model_labels": model_labels(),
            # {full id → context window in tokens}, verified matrix entries only —
            # drives the composer's context-fill meter (absent id → meter hides).
            "model_context_windows": model_context_windows(),
            "has_key": self._provider_configured(current_provider),
            # Provider-agnostic "can this default model actually run?" — true when the default
            # model's provider is configured (any provider, not just OpenAI). Drives the GUI's
            # "No model connected" composer chip and the onboarding Skip warning.
            "model_ready": self._model_ready(self.model),
            "source": legacy_source,
            "credential_source": credential_source,
            "onboarded": bool(self._prefs.get("onboarded")),
            "experimental_connectors": experimental_enabled(self.secrets),
            "surfaces": self._surfaces(),
            "nav_layout": self._nav_layout(),
            "sessions_peek": self.sessions_peek(),
            "context_bar": self.context_bar(),
            "scratch_base": self._prefs.get("scratch_base")
            or self.DEFAULT_SCRATCH_BASE,
            # Real on-disk secrets location, so the UI shows the OS-native path instead of a
            # hardcoded POSIX one (Windows -> %APPDATA%\coworker, macOS/Linux -> ~/.config).
            "secrets_path": str(self.secrets.path),
            **self.pdf_settings(),
            **self.compaction_settings_payload(),
        }

    def _surfaces(self) -> dict[str, bool]:
        """Which session surfaces are shown in the sidebar. Cowork is always on; Chat and Code
        are opt-in (default off) so a new user sees Cowork only."""
        return {
            "cowork": True,
            "chat": bool(self._prefs.get("show_chat", False)),
            "code": bool(self._prefs.get("show_code", False)),
        }

    def set_surfaces(
        self, chat: Optional[bool] = None, code: Optional[bool] = None
    ) -> dict[str, Any]:
        """Toggle Chat/Code visibility (Cowork is always shown). Persisted in prefs."""
        if chat is not None:
            self._prefs["show_chat"] = bool(chat)
        if code is not None:
            self._prefs["show_code"] = bool(code)
        self._save_prefs()
        return {"ok": True, "surfaces": self._surfaces()}

    def _nav_layout(self) -> str:
        """Sidebar layout: ``"flat"`` (default) or ``"grouped"`` (by persona). Persisted in
        prefs (UI-REFRESH §7)."""
        return "grouped" if self._prefs.get("nav_layout") == "grouped" else "flat"

    def set_nav_layout(self, nav_layout: str) -> dict[str, Any]:
        """Set + persist the sidebar layout. Unknown values fall back to ``"flat"``."""
        value = "grouped" if (nav_layout or "").strip() == "grouped" else "flat"
        self._prefs["nav_layout"] = value
        self._save_prefs()
        return {"ok": True, "nav_layout": value}

    DEFAULT_SESSIONS_PEEK = 5

    def sessions_peek(self) -> int:
        """How many sessions a sidebar group shows before "Show more" (owner ask, 2026-07-03)."""
        try:
            n = int(self._prefs.get("sessions_peek", self.DEFAULT_SESSIONS_PEEK))
        except (TypeError, ValueError):
            n = self.DEFAULT_SESSIONS_PEEK
        return max(1, min(n, 50))

    def set_sessions_peek(self, n: int) -> dict[str, Any]:
        try:
            self._prefs["sessions_peek"] = max(1, min(int(n), 50))
        except (TypeError, ValueError):
            return {"ok": False, "error": "sessions_peek must be a number"}
        self._save_prefs()
        return {"ok": True, "sessions_peek": self.sessions_peek()}

    def context_bar(self) -> bool:
        """Whether the composer shows the context-window fill bar. OFF by default (owner
        ask): the chip then states the session total, and the popover keeps both numbers."""
        return bool(self._prefs.get("context_bar", False))

    def set_context_bar(self, shown: Any) -> dict[str, Any]:
        self._prefs["context_bar"] = bool(shown)
        self._save_prefs()
        return {"ok": True, "context_bar": self.context_bar()}

    # -- PDF attachments / token savings (owner ask, 2026-07-17) ----------------
    DEFAULT_PDF_MAX_PAGES = 20
    DEFAULT_PDF_MAX_MB = 10

    def pdf_settings(self) -> dict[str, Any]:
        """Fallback mode for models without native PDF support + the attach-time
        thresholds (Settings → Token savings: big PDFs quietly eat tokens)."""
        from ..pdf_support import FALLBACK_MODES

        mode = self._prefs.get("pdf_fallback")
        try:
            pages = int(self._prefs.get("pdf_max_pages", self.DEFAULT_PDF_MAX_PAGES))
        except (TypeError, ValueError):
            pages = self.DEFAULT_PDF_MAX_PAGES
        try:
            mb = int(self._prefs.get("pdf_max_mb", self.DEFAULT_PDF_MAX_MB))
        except (TypeError, ValueError):
            mb = self.DEFAULT_PDF_MAX_MB
        return {
            "pdf_fallback": mode if mode in FALLBACK_MODES else "text",
            "pdf_max_pages": max(1, min(pages, 100)),
            "pdf_max_mb": max(1, min(mb, 10)),
        }

    def compaction_settings(self) -> dict[str, Any]:
        """The live auto-compaction knobs (OPE-27) — read by every engine per check, so a
        Settings change applies without a rebuild. Only the two spec'd overrides plus the
        summarizer-model pin; absent keys fall back to compaction.py defaults."""
        from ..compaction import DEFAULT_CAP_TOKENS, DEFAULT_THRESHOLD_PCT

        return {
            "threshold_pct": float(
                self._prefs.get("compaction_threshold_pct") or DEFAULT_THRESHOLD_PCT
            ),
            "cap_tokens": int(
                self._prefs.get("compaction_cap_tokens") or DEFAULT_CAP_TOKENS
            ),
            # "" → the session's own model (engine falls back to self.model).
            "model": str(self._prefs.get("compaction_model") or ""),
        }

    def compaction_settings_payload(self) -> dict[str, Any]:
        """The same knobs under REST-facing names (prefixed to keep /v1/settings flat)."""
        settings = self.compaction_settings()
        return {
            "compaction_threshold_pct": settings["threshold_pct"],
            "compaction_cap_tokens": settings["cap_tokens"],
            "compaction_model": settings["model"],
        }

    def set_compaction_settings(
        self,
        threshold_pct: Any = None,
        cap_tokens: Any = None,
        model: Any = None,
    ) -> dict[str, Any]:
        """Persist the auto-compaction overrides (OPE-27). Threshold is a percentage of
        the model's context window (10–95); the cap is an absolute token ceiling; model
        pins the summarizer ('' → the session's own model). Engines read these live via
        `compaction_settings()`, so changes apply to running sessions immediately."""
        if threshold_pct is not None:
            try:
                pct = float(threshold_pct)
            except (TypeError, ValueError):
                return {"ok": False, "error": "compaction_threshold_pct must be a number"}
            if not 0.10 <= pct <= 0.95:
                return {
                    "ok": False,
                    "error": "compaction_threshold_pct must be between 0.10 and 0.95",
                }
            self._prefs["compaction_threshold_pct"] = pct
        if cap_tokens is not None:
            try:
                self._prefs["compaction_cap_tokens"] = max(
                    10_000, min(int(cap_tokens), 2_000_000)
                )
            except (TypeError, ValueError):
                return {"ok": False, "error": "compaction_cap_tokens must be a number"}
        if model is not None:
            self._prefs["compaction_model"] = str(model)
        self._save_prefs()
        return {"ok": True, **self.compaction_settings()}

    def set_pdf_settings(
        self,
        fallback: Any = None,
        max_pages: Any = None,
        max_mb: Any = None,
    ) -> dict[str, Any]:
        from ..pdf_support import FALLBACK_MODES, set_fallback_mode

        if fallback is not None:
            if fallback not in FALLBACK_MODES:
                return {"ok": False, "error": "pdf_fallback must be 'text' or 'images'"}
            self._prefs["pdf_fallback"] = fallback
        for key, value, ceiling in (
            ("pdf_max_pages", max_pages, 100),
            ("pdf_max_mb", max_mb, 10),
        ):
            if value is None:
                continue
            try:
                self._prefs[key] = max(1, min(int(value), ceiling))
            except (TypeError, ValueError):
                return {"ok": False, "error": f"{key} must be a number"}
        self._save_prefs()
        settings = self.pdf_settings()
        set_fallback_mode(settings["pdf_fallback"])  # engines read the module global
        return {"ok": True, **settings}

    def set_model_key(self, api_key: str) -> dict[str, Any]:
        """Persist the model API key to the SecretStore (0600). The new provider client is
        built lazily on the next turn, so it picks the key up without a restart."""
        api_key = (api_key or "").strip()
        if not api_key:
            return {"ok": False, "error": "empty api key"}
        # Merge, don't replace: the profile may also hold a custom endpoint (base_url).
        profile = dict(self.secrets.get_raw("provider:openai") or {})
        profile.update({"type": "api_key", "api_key": api_key})
        self.secrets.put("provider:openai", profile)
        self._refresh_provider("openai")  # rebuild the OpenAI client with the new key
        return {"ok": True, **self.get_settings()}

    def set_default_model(self, model: str) -> dict[str, Any]:
        """Set + persist the default model for new sessions (the UI pre-selects it)."""
        model = (model or "").strip()
        if not model:
            return {"ok": False, "error": "empty model"}
        self.model = model
        self._prefs["default_model"] = model
        self._save_prefs()
        return {"ok": True, **self.get_settings()}

    def set_onboarded(self, value: bool = True) -> dict[str, Any]:
        """Record that first-run setup is complete (so it isn't shown again)."""
        self._prefs["onboarded"] = bool(value)
        self._save_prefs()
        return {"ok": True, "onboarded": bool(value)}

    def set_scratch_base(self, path: str) -> dict[str, Any]:
        """Set + persist the common area where each Cowork conversation's scratch directory is
        created (default ~/OpenWorker). The raw value is stored so the UI shows it as entered;
        new conversations use it immediately (existing ones keep their provisioned dir).
        """
        path = (path or "").strip()
        if not path:
            return {"ok": False, "error": "empty path"}
        resolved = Path(path).expanduser()
        if not resolved.is_absolute():
            # A relative path would silently create (and later provision scratch dirs
            # under) the server process's CWD — effectively a random location.
            return {"ok": False, "error": "path must be absolute"}
        try:
            resolved.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            return {"ok": False, "error": str(exc)}
        self._prefs["scratch_base"] = path
        self._save_prefs()
        return {"ok": True, **self.get_settings()}

    # -- gateway + connector allow-list (inbound messaging) ---------------------
    def allow_user(
        self,
        name: str,
        user_id: str,
        team_id: Optional[str] = None,
        *,
        display_name: str = "",
    ) -> dict[str, Any]:
        out = self._set_allowed(name, user_id, team_id=team_id, add=True)
        # Directory picks arrive with the name in hand — record it so the chip
        # is readable immediately (message-driven allows learn it on arrival).
        if out.get("ok") and display_name:
            self._note_person(name, user_id, display_name)
        return out

    def disallow_user(
        self, name: str, user_id: str, team_id: Optional[str] = None
    ) -> dict[str, Any]:
        if name == "slack" and user_id in self.slack_approval_owner_ids(team_id):
            return {
                "ok": False,
                "error": "Remove this person as an approval owner first.",
            }
        return self._set_allowed(name, user_id, team_id=team_id, add=False)

    def slack_approval_owner_ids(self, team_id: Optional[str] = None) -> set[str]:
        """Stable Slack user ids allowed to resolve consequential Inbox prompts.

        Managed relay installs are installer-owned. Manual Socket Mode has no
        human OAuth identity, so its owners are selected explicitly.
        """
        key = f"slack:team:{team_id}" if team_id else "slack:default"
        profile = self.secrets.get(key) or {}
        if team_id:
            installer = str(profile.get("slack_user_id") or "").strip()
            return {installer} if installer else set()
        if profile.get("mode") == "relay":
            return set()
        return {
            str(user_id).strip()
            for user_id in (profile.get("approval_owner_ids") or [])
            if str(user_id).strip()
        }

    def set_slack_approval_owner(
        self, user_id: str, *, add: bool, display_name: str = ""
    ) -> dict[str, Any]:
        """Edit Manual Socket Mode approval owners.

        Owner status implies inbound permission. Relay ownership is derived from
        the OAuth installer and is intentionally not editable here.
        """
        user_id = str(user_id).strip()
        if not user_id:
            return {"ok": False, "error": "user_id required"}
        profile = self.secrets.get("slack:default")
        if not profile:
            return {"ok": False, "error": "Slack is not connected in Manual mode."}
        if profile.get("mode") == "relay" or profile.get("managed"):
            return {
                "ok": False,
                "error": "Relay approval ownership is set by the Slack installer.",
            }

        owners = self.slack_approval_owner_ids()
        if add:
            owners.add(user_id)
        else:
            owners.discard(user_id)
            if not owners and self._has_manual_slack_inbox_binding():
                return {
                    "ok": False,
                    "error": (
                        "Choose another approval owner before removing the last one "
                        "while Slack Inbox routing is active."
                    ),
                }
        profile["approval_owner_ids"] = sorted(owners)
        if add:
            allowed = set(profile.get("allowed_users") or [])
            allowed.add(user_id)
            profile["allowed_users"] = sorted(allowed)
        self.secrets.put("slack:default", profile)
        if display_name:
            self._note_person("slack", user_id, display_name)
        if self.gateway is not None and "slack" in self.gateway.settings:
            self.gateway.settings["slack"].allowed_users = set(
                profile.get("allowed_users") or []
            )
        return {
            "ok": True,
            "approval_owner_ids": sorted(owners),
            "allowed_users": list(profile.get("allowed_users") or []),
        }

    def _has_manual_slack_inbox_binding(self) -> bool:
        for raw in self.inbox_routing.bindings():
            if raw.get("channel") != "slack":
                continue
            team_id, _ = slack_split(str(raw.get("target") or ""))
            if team_id is None:
                return True
        return False

    def _slack_actor_owns_item(
        self,
        item,
        *,
        actor_id: str,
        chat_id: str,
        team_id: Optional[str],
    ) -> bool:
        """Authorize a Slack resolution against both its owner and delivery binding."""
        event_team, event_channel = slack_split(chat_id)
        event_team = team_id or event_team
        binding = self.inbox_routing.binding_for(item.inbox)
        owner_team = event_team
        if binding.channel == "slack":
            owner_team, bound_channel = slack_split(binding.target)
            if owner_team != event_team or bound_channel != event_channel:
                return False
        return bool(actor_id) and actor_id in self.slack_approval_owner_ids(owner_team)

    def set_inbox_binding(
        self, name: str, *, channel: Optional[str], target: str
    ) -> dict[str, Any]:
        """Persist an Inbox transport after validating its approval identity."""
        channel = str(channel or "").strip() or None
        target = str(target or "").strip()
        if channel and not target:
            return {"ok": False, "error": "Choose a destination channel."}
        if channel == "slack":
            settings = load_settings(self.secrets).get("slack")
            if settings is None or not settings.enabled:
                return {"ok": False, "error": "Slack is not connected."}
            team_id, destination = slack_split(target)
            if not destination:
                return {"ok": False, "error": "Choose a destination channel."}
            key = f"slack:team:{team_id}" if team_id else "slack:default"
            if not self.secrets.get(key):
                return {
                    "ok": False,
                    "error": "That Slack workspace is not connected.",
                }
            if not self.slack_approval_owner_ids(team_id):
                return {
                    "ok": False,
                    "error": (
                        "Choose at least one approval owner in Slack settings before "
                        "routing Inbox requests there."
                    ),
                }
        self.inbox_routing.set_binding(name, channel=channel, target=target)
        return {"ok": True, "bindings": self.inbox_routing.bindings()}

    def _set_allowed(
        self, name: str, user_id: str, *, team_id: Optional[str] = None, add: bool
    ) -> dict[str, Any]:
        """Add/remove a sender on the allow-list. With `team_id` the edit targets that
        scope's profile — a workspace's `slack:team:<id>`, or a GitHub App
        installation's `github:install:<id>` (the same per-tenant pattern);
        without, the flat `<name>:default` list (manual single-workspace mode)."""
        user_id = str(user_id).strip()
        if not user_id:
            return {"ok": False, "error": "user_id required"}
        scope = "install" if name == "github" else "team"
        profile_key = f"{name}:{scope}:{team_id}" if team_id else f"{name}:default"
        profile = self.secrets.get(profile_key)
        if not profile:
            return {
                "ok": False,
                "error": (
                    "workspace not connected" if team_id else "connector not connected"
                ),
            }
        allowed = set(profile.get("allowed_users") or [])
        allowed.add(user_id) if add else allowed.discard(user_id)
        profile["allowed_users"] = sorted(allowed)
        self.secrets.put(profile_key, profile)
        # reflect into the live gateway so it takes effect without a restart
        if self.gateway is not None and name in self.gateway.settings:
            if team_id:
                from ..connectors import TeamAuth

                teams = self.gateway.settings[name].teams
                team = teams.setdefault(team_id, TeamAuth())
                team.allowed_users = set(allowed)
            else:
                self.gateway.settings[name].allowed_users = set(allowed)
        return {"ok": True, "allowed_users": sorted(allowed), "team_id": team_id}

    async def disconnect_slack_workspace(self, team_id: str) -> dict[str, Any]:
        """Stop relaying ONE workspace: delete the cloud routing row (best-effort),
        drop the local per-team token, and hot-reload the gateway. Removing the last
        workspace also clears relay mode on slack:default so the connector reads
        disconnected (the manual Socket Mode fields, if any, are left untouched)."""
        team_id = str(team_id).strip()
        profile_key = f"slack:team:{team_id}"
        if not team_id or not self.secrets.get(profile_key):
            return {"ok": False, "error": "workspace not connected"}
        from .. import cloud
        from ..config import load_config

        await asyncio.to_thread(
            lambda: cloud.slack_disconnect_workspace(
                self.secrets, load_config(), team_id
            )
        )
        self.secrets.delete(profile_key)
        remaining = [
            m["profile"]
            for m in self.secrets.status()
            if m.get("profile", "").startswith("slack:team:")
        ]
        if not remaining:
            default = self.secrets.get("slack:default") or {}
            if default.get("mode") == "relay":
                default.pop("mode", None)
                default.pop("managed", None)
                if default.get("bot_token"):
                    # Manual Socket Mode creds predating the relay switch: keep them
                    # stored but DISABLED — removing the last workspace must never
                    # silently start listening with old tokens.
                    default["type"] = "token"
                    default["enabled"] = False
                    self.secrets.put("slack:default", default)
                else:
                    default.pop("type", None)
                    default.pop("enabled", None)
                    if default:  # e.g. a flat allow-list worth keeping
                        self.secrets.put("slack:default", default)
                    else:
                        self.secrets.delete("slack:default")
        await self.refresh_gateway()
        return {"ok": True, "remaining_workspaces": len(remaining)}

    def slack_status(self) -> dict[str, Any]:
        """Slack connection health in three honest layers (UX-DECISIONS §21):
        the desktop↔relay socket, the cloud sign-in that authorizes it, and each
        workspace's bot token. The desktop can't see the Slack↔cloud leg, so no
        layer here ever claims it — event silence ≠ outage."""
        from .. import cloud

        default = self.secrets.get("slack:default") or {}
        mode = default.get("mode") or ""
        signin = cloud.status(self.secrets)

        relay: dict[str, Any] = {
            "state": "offline",
            "reconnects": 0,
            "last_event_at": None,
            "last_error": "",
        }
        teams: dict[str, Any] = {}
        adapter = (
            self.gateway._adapters.get("slack") if self.gateway is not None else None
        )
        snapshot = getattr(
            adapter, "status", None
        )  # relay adapter only; Socket Mode has none
        if callable(snapshot):
            relay = snapshot()
            teams = relay.pop("teams", {})
        return {
            "ok": True,
            "mode": mode,
            "relay": relay,
            "signed_in": bool(signin.get("signed_in")),
            "teams": teams,
        }

    async def disconnect_github_installation(
        self, installation_id: str
    ) -> dict[str, Any]:
        """Stop relaying ONE GitHub installation: delete the cloud routing rows
        (best-effort), drop the local profile, hot-reload the gateway. The Slack
        per-workspace disconnect, GitHub flavour — a manual PAT stays untouched."""
        installation_id = str(installation_id).strip()
        from .. import cloud
        from ..config import load_config
        from ..connectors import github_installs

        if not installation_id or not self.secrets.get(
            github_installs.PREFIX + installation_id
        ):
            return {"ok": False, "error": "installation not connected"}
        await asyncio.to_thread(
            lambda: cloud.github_disconnect_installation(
                self.secrets, load_config(), installation_id
            )
        )
        result = github_installs.disconnect_install(self.secrets, installation_id)
        await self.refresh_gateway()
        return result

    def github_status(self) -> dict[str, Any]:
        """GitHub relay health, same three honest layers as Slack: the shared
        relay socket, the cloud sign-in, and per-installation token health."""
        from .. import cloud

        default = self.secrets.get("github:default") or {}
        signin = cloud.status(self.secrets)
        relay: dict[str, Any] = {
            "state": "offline",
            "reconnects": 0,
            "last_event_at": None,
            "last_error": "",
        }
        installs: dict[str, Any] = {}
        missed: dict[str, Any] = {}
        adapter = (
            self.gateway._adapters.get("github") if self.gateway is not None else None
        )
        snapshot = getattr(adapter, "status", None)
        if callable(snapshot):
            relay = snapshot()
            installs = relay.pop("installs", {})
            missed = relay.pop("missed", {})
        return {
            "ok": True,
            "mode": default.get("mode") or "",
            "relay": relay,
            "signed_in": bool(signin.get("signed_in")),
            "installs": installs,
            "missed": missed,
        }

    async def start_gateway(self) -> list[str]:
        """Build the messaging gateway and start enabled listeners. Inbound messages route to
        durable sessions: a channel message to its subscribers, a DM to the designated DM session
        (else parked). Returns the platforms whose listeners came up."""
        self.scheduler.start()  # tick scheduler for automations (independent of connectors)
        return await self._build_and_start_gateway()

    async def refresh_gateway(self) -> list[str]:
        """Hot-reload the messaging listeners with fresh secrets — called after a connector
        connect/disconnect so pasting new tokens takes effect immediately. A platform socket
        (Slack Socket Mode) authenticates at connect time, so new creds mean reopening that
        socket; this replaces the adapters in-process — the sidecar never restarts."""
        await self.stop_gateway()
        started = await self._build_and_start_gateway()
        print(f"[coworker] messaging gateway reloaded: {', '.join(started) or 'none'}")
        return started

    async def _build_and_start_gateway(self) -> list[str]:
        settings = load_settings(self.secrets)
        self.gateway = Gateway(
            secrets=self.secrets,
            settings=settings,
            handler=self._dispatch_inbound,
            reply_resolver=self._resolve_inbox_reply,
            interaction_handler=self._on_interaction,
            on_unauthorized=self._park_unauthorized,
        )
        # Managed Slack relay wiring (only used when a connector picks relay mode):
        # the cloud sign-in JWT authorizes the relay WebSocket, and the relay
        # endpoint comes from config. Both are lazy — Socket Mode needs neither.
        from ..cloud import fresh_access_token
        from ..config import load_config

        cloud_config = load_config()

        def _relay_token() -> str:
            return fresh_access_token(self.secrets, cloud_config) or ""

        # Every relay-mode platform shares ONE cloud socket; the hub fans frames
        # out by provider tag. Built lazily on the first relay adapter.
        relay_ws_url = getattr(cloud_config, "cloud_relay_ws_url", "") or None
        relay_hub = None
        if relay_ws_url:
            from ..connectors.relay_client import RelayHub

            relay_hub = RelayHub(relay_ws_url, _relay_token)

        async def _github_token(installation_id: str) -> str:
            from ..cloud import github_installation_token

            return await asyncio.to_thread(
                github_installation_token, self.secrets, cloud_config, installation_id
            )

        for platform, st in settings.items():
            if not st.enabled:
                continue
            profile = self.secrets.get(f"{platform}:default") or {}
            adapter = make_adapter(
                platform,
                profile,
                secrets=self.secrets,
                token_provider=_relay_token,
                relay_url=relay_ws_url,
                relay_hub=relay_hub,
                github_token_client=_github_token,
            )
            if adapter is not None:
                self.gateway.register(adapter)
        return await self.gateway.start()

    async def stop_gateway(self) -> None:
        if self.gateway is not None:
            await self.gateway.stop()
            self.gateway = None

    # -- unauthorized inbound (parked, §19) --------------------------------------
    def _note_person(
        self, platform: str, user_id: Optional[str], name: Optional[str]
    ) -> None:
        """Remember a sender's display name (persisted) so ID-keyed surfaces — the allow-list
        chips above all — can show who a U07JK… actually is. Best-effort, newest name wins.
        """
        if not user_id or not name:
            return
        key = f"{platform}:{user_id}"
        if self._people.get(key) != name:
            self._people[key] = name
            try:
                self._people_path.write_text(json.dumps(self._people))
            except OSError:
                pass

    async def _park_unauthorized(self, event) -> None:
        """Gateway callback: keep what an unallowed sender said (names already resolved by the
        adapter, best-effort) so the owner can allow-and-deliver without a re-send."""
        s = event.source
        self._note_person(s.platform, s.user_id, s.user_name)
        self.parked.park(
            platform=s.platform,
            chat_id=s.chat_id,
            chat_name=s.chat_name,
            user_id=s.user_id or "?",
            user_name=s.user_name,
            chat_type=s.chat_type,
            thread_id=s.thread_id,
            team_id=s.team_id,
            text=event.text or "",
        )

    async def resolve_unauthorized(
        self, name: str, item_id: str, action: str
    ) -> dict[str, Any]:
        """Resolve one parked message: "dismiss" throws it away; "allow" adds the sender to the
        allow-list (future messages flow); "allow_deliver" also re-injects the parked message
        through the NORMAL inbound path — buffer + subscriptions — as if it just arrived.
        """
        item = self.parked.pop(item_id)
        if item is None or item.platform != name:
            return {"ok": False, "error": "unknown item"}
        if action == "dismiss":
            return {"ok": True}
        if action not in ("allow", "allow_deliver"):
            return {"ok": False, "error": f"unknown action: {action}"}
        allowed = self._set_allowed(name, item.user_id, team_id=item.team_id, add=True)
        if not allowed.get("ok"):
            return allowed
        if action == "allow_deliver":
            from ..connectors import MessageEvent, SessionSource

            event = MessageEvent(
                text=item.text,
                source=SessionSource(
                    platform=item.platform,
                    chat_id=item.chat_id,
                    user_id=item.user_id,
                    user_name=item.user_name,
                    chat_name=item.chat_name,
                    chat_type=item.chat_type,
                    thread_id=item.thread_id,
                    team_id=item.team_id,
                ),
            )
            await self._dispatch_inbound(event)
        return {"ok": True}

    # -- per-session live view --------------------------------------------------
    def register_event_client(self, send_cb: Any) -> None:
        self._event_clients.add(send_cb)

    def unregister_event_client(self, send_cb: Any) -> None:
        self._event_clients.discard(send_cb)

    async def broadcast_event(self, message: dict) -> None:
        """Fan an app-wide event out to every /ws/events socket. Best-effort: a dead
        socket is dropped, never fatal to the caller."""
        for cb in list(self._event_clients):
            try:
                await cb(message)
            except Exception:
                self.unregister_event_client(cb)

    def register_session_client(self, session_id: str, send_cb: Any) -> None:
        self._session_clients.setdefault(session_id, set()).add(send_cb)

    def unregister_session_client(self, session_id: str, send_cb: Any) -> None:
        clients = self._session_clients.get(session_id)
        if clients is not None:
            clients.discard(send_cb)
            if not clients:
                self._session_clients.pop(session_id, None)

    async def broadcast_session(self, session_id: str, message: dict) -> None:
        """Fan a turn event out to every socket viewing this session. Best-effort: a dead socket
        is dropped, never fatal to the turn (delivery is socket-independent)."""
        for cb in list(self._session_clients.get(session_id, ())):
            try:
                await cb(message)
            except Exception:
                self.unregister_session_client(session_id, cb)

    async def aclose(self) -> None:
        await self.stop_team_worker()
        await self.main_acp_host.aclose()
        await self.scheduler.stop()
        await self.stop_gateway()
        await self.mcp.aclose()
        self.orchestrator.close()
        self.audit_store.close()
        self.memory_store.close()
        self.session_store.close()
        self.task_store.close()

    # -- automation (scheduled tasks) -------------------------------------------
    def approval_prompt_data(self, session_id: str, request) -> dict[str, Any]:
        """Extra Inbox-item payload for a parked approval. Always carries the tool name +
        arguments so the GUI can render the same humanized card (§35) it shows live —
        without them a reopened session fell back to the raw 'Run `tool`?' treatment.
        Automation runs additionally carry the owning task + (when the call is eligible)
        the exact target a standing rule would pin: the GUI offers "Allow every time" only
        when both are present — in-app only, never on Slack-mirrored buttons (§25)."""
        from ..permissions import standing_rule_candidate

        data: dict[str, Any] = {
            "tool": request.tool_name,
            "arguments": getattr(request, "arguments", None) or {},
        }
        task = self.task_store.task_for_run_session(session_id)
        if task is None:
            return data
        data.update({"task_id": task.id, "task_title": task.title})
        target = standing_rule_candidate(
            request.tool_name,
            getattr(request, "arguments", None) or {},
            getattr(request, "metadata", None),
        )
        if target:
            data["standing_target"] = target
        return data

    def mint_task_rule(
        self, session_id: str, tool_name: str, arguments: Any, metadata: Any = None
    ) -> bool:
        """Persist a standing rule a human minted via "Allow every time" on a run's
        approval card (§25's retrofit path). Server-side validation, not trust in the
        card: the session must be an automation run and the call must be rule-eligible
        (external risk, declared target argument, non-empty target). Also applies the
        rule to the live engine so the run's next call auto-allows."""
        from ..permissions import standing_rule_candidate

        task = self.task_store.task_for_run_session(session_id)
        if task is None:
            return False
        target = standing_rule_candidate(tool_name, arguments or {}, metadata)
        if not target or not task.add_rule(tool_name, target):
            return False
        self.task_store.save(task)
        engine = self._engines.get(session_id)
        if engine is not None:
            engine.permissions.task_rules.setdefault(tool_name, set()).add(target)
        try:
            self.audit_store.append(
                {
                    "session_id": session_id,
                    "tool": tool_name,
                    "arguments": arguments or {},
                    "stage": "standing_rule_minted",
                    "status": "granted",
                    "reason": f"allow every time: {tool_name} → {target} (task {task.id})",
                }
            )
        except Exception:
            pass
        return True

    def approval_outcome(self, resolution: str, request, session_id: str):
        """Map an approval resolution (from any surface) to an ApprovalOutcome, handling
        the task-persistent "always_task" vocabulary alongside the session-scoped ones.
        """
        from ..engine import ApprovalOutcome

        if resolution == "always_task":
            self.mint_task_rule(
                session_id,
                request.tool_name,
                getattr(request, "arguments", None),
                getattr(request, "metadata", None),
            )
            return ApprovalOutcome.ONCE
        try:
            return ApprovalOutcome(resolution)
        except ValueError:
            pass
        if resolution == "allow":
            return ApprovalOutcome.ONCE
        if resolution == "always":
            return ApprovalOutcome.ALWAYS_TOOL
        return ApprovalOutcome.DENY

    def _scheduled_approver(self, task, session_id: str):
        from ..engine import ApprovalOutcome
        from ..permissions import WRITE_TOOLS

        name_allowed = task.name_allowed_tools()

        async def approver(request):
            # Unattended: auto-allow the deliverable writes (path-scoped to the task
            # workspace) + tools the task allows BY NAME (legacy entries). Target-bound
            # rules never reach here — the permission engine matched them already.
            if request.tool_name in WRITE_TOOLS or request.tool_name in name_allowed:
                return ApprovalOutcome.ONCE
            # Anything else parks in the Inbox and suspends the run (§25 graceful
            # degradation — an ungranted automation still works, it just asks). The item
            # carries the task binding so the in-app card can offer "Allow every time";
            # the Slack mirror renders only Approve/Deny buttons.
            item = self.inbox.add_approval(
                session_id,
                f"Run `{request.tool_name}`?",
                body=_approval_body(request),
                inbox=self.inbox_routing.route_for(session_id, task.agent),
                tool_call_id=getattr(request, "tool_call_id", None),
                data=self.approval_prompt_data(session_id, request),
            )
            if item.state == "pending":
                self.persist_session(session_id)
                await self.mirror_inbox_item(item)
            resolution = await self.inbox.wait(item.id)
            return self.approval_outcome(resolution, request, session_id)

        return approver

    def _seed_task_permissions(self, engine: TurnEngine, task) -> None:
        """Apply a task's standing allowances to an engine: target-bound rules feed the
        permission engine's matcher (connector tools included — the target binding is the
        safety); name-only legacy entries keep their session-allowlist behavior."""
        engine.permissions.task_rules = task.standing_rules()
        for tool in task.name_allowed_tools():
            engine.permissions.allow_tool_for_session(tool)

    def _build_task_engine(self, task, *, session_id: str) -> TurnEngine:
        ag = get_agent(task.agent)
        Path(task.workspace).mkdir(parents=True, exist_ok=True)
        engine = build_engine(
            agent=ag,
            workspace=task.workspace,
            model=task.model or self.model,
            mode=Mode.INTERACTIVE,
            approver=self._scheduled_approver(task, session_id),
            provider=self.provider,
            memory_store=self.memory_store,
            secrets=self.secrets,
            # No scheduling tools inside a scheduled run: the executing agent's job is to DO the
            # task, and instructions that mention timing ("every day at 5:32pm…") otherwise tempt
            # it to create another automation instead of running this one.
            task_store=None,
            session_id=session_id,
            audit_sink=self.audit_store.append,
            # Scheduled runs respect the same per-session connection hierarchy as live sessions:
            # expose only the persona's effective-enabled connectors' tools (§4.3).
            connector_filter=self.effective_connectors(session_id, task.agent),
        )
        self._seed_task_permissions(engine, task)
        return engine

    # -- mirroring inbox items to a bound channel -------------------------------
    async def mirror_inbox_item(self, item) -> None:
        """Mirror an Inbox item to its bound channel. Discrete choices (approve/deny, ask_user
        options) render as BUTTONS — the item id rides in each, so a click resolves it
        unambiguously. Free-text answers aren't offered over messaging (open the app).
        """
        from ..interactions import buttons_for

        binding = self.inbox_routing.binding_for(item.inbox)
        if not (binding.channel and self.gateway is not None):
            return
        if binding.channel == "slack":
            team_id, _ = slack_split(binding.target)
            # Legacy bindings may predate approval ownership. Keep the item
            # available in-app, but never mirror it to an ownerless channel.
            if not self.slack_approval_owner_ids(team_id):
                return
        target = f"{binding.channel}:{binding.target}"
        body = "\n".join(p for p in (item.title, item.body) if p).strip()
        buttons = buttons_for(item)
        try:
            if buttons:
                await self.gateway.deliver_interactive(target, body, buttons)
            else:
                await self.gateway.deliver(
                    target,
                    f"{body}\n(Open the app to respond.)\n[ow:{item.id}]".strip(),
                )
        except Exception:
            pass

    # -- interactive prompt buttons (Slack/Telegram) ----------------------------
    async def _on_interaction(self, event) -> None:
        """A button click on a mirrored Inbox prompt. The button value carries the item id + the
        resolution, so this is unambiguous — resolve the item, then swap the buttons for the
        outcome. Resolving releases any agent suspended on it (first-responder-wins)."""
        from ..interactions import decode

        decoded = decode(getattr(event, "value", "") or "")
        if decoded is None:
            return
        item_id, resolution = decoded
        item = self.inbox.get(item_id)
        if item is None:
            return
        protected_kinds = {"approval", "directory", "plan"}
        if (
            getattr(event, "platform", "") == "slack"
            and item.kind in protected_kinds
        ):
            actor_id = str(getattr(event, "user_id", "") or "")
            if not self._slack_actor_owns_item(
                item,
                actor_id=actor_id,
                chat_id=getattr(event, "chat_id", "") or "",
                team_id=getattr(event, "team_id", None),
            ):
                if self.gateway is not None:
                    await self.gateway.reject_interaction(event)
                return
        already = item is not None and item.state != "pending"
        resolved = await self.resolve_inbox(item_id, resolution)
        if not resolved and not already:
            return
        who = getattr(event, "user_name", None) or "someone"
        title = item.title
        outcome = "already resolved" if already else f"“{resolution}” — by {who}"
        if self.gateway is not None and getattr(event, "message_id", None):
            try:
                await self.gateway.update_message(
                    getattr(event, "platform", "slack"),
                    getattr(event, "chat_id", ""),
                    event.message_id,
                    f"{title}\n✅ {outcome}",
                )
            except Exception:
                pass

    # -- inbox replies over messaging connectors --------------------------------
    def _resolve_inbox_reply(self, event) -> bool:
        """Try to handle an inbound Slack/Telegram message as an Inbox reply. Returns True if the
        message carried an `[ow:<id>]` token (so it's consumed here, not routed as a new turn) —
        resolving the item also releases any agent suspended on it."""
        from ..inbox_routing import resolve_from_reply

        text = getattr(event, "text", "") or ""

        def _resolve(item_id: str, resolution: str) -> bool:
            item = self.inbox.get(item_id)
            if item is None:
                return False
            if (
                getattr(event.source, "platform", "") == "slack"
                and item.kind in {"approval", "directory", "plan"}
            ):
                actor_id = str(getattr(event.source, "user_id", "") or "")
                if not self._slack_actor_owns_item(
                    item,
                    actor_id=actor_id,
                    chat_id=getattr(event.source, "chat_id", "") or "",
                    team_id=getattr(event.source, "team_id", None),
                ):
                    return False
            return self.inbox.resolve(item_id, resolution)

        return resolve_from_reply(text, _resolve) is not None

    # -- self-wake resumption ---------------------------------------------------
    async def resume_due_wakes(self) -> int:
        """Resume sessions whose self-wakes are due (called each scheduler tick). A suspended
        agent (it called sleep_for / wake_on / wake_on_event and ended its turn) is re-invoked on
        its own session with a wake message so it continues where it left off. Returns the count.
        """
        resumed = 0
        for wake in self.wakes.due():
            try:
                await self._resume_wake(wake)
                resumed += 1
            except Exception:
                pass
            finally:
                self.wakes.mark_fired(wake.id)
        return resumed

    def mark_running(self, session_id: str) -> None:
        self._running_sessions.add(session_id)

    def try_mark_running(self, session_id: str) -> bool:
        """Atomically claim an idle session for one turn on the server event loop."""
        if session_id in self._running_sessions:
            return False
        self._running_sessions.add(session_id)
        return True

    def mark_idle(self, session_id: str) -> None:
        self._running_sessions.discard(session_id)
        # Every turn path (WS, background delivery, durable resume) marks idle when it
        # finishes — the one shared post-turn moment, so auto-titling hooks in here and
        # can never add latency to the response itself.
        self._maybe_autotitle(session_id)

    def is_running(self, session_id: str) -> bool:
        return session_id in self._running_sessions

    async def _resume_wake(self, wake) -> None:
        await self.deliver_to_session(wake.session_id, self._wake_message(wake))

    def _non_acp_delivery_state(self, session_id: str, delivery_id: str) -> str:
        event_types = {
            event.event_type
            for event in self.orchestrator.store.list_events(
                aggregate_type="session_delivery", aggregate_id=session_id
            )
            if str(event.payload.get("delivery_id")) == delivery_id
        }
        if "session.delivery.delivered" in event_types:
            return "delivered"
        if "session.delivery.prompting" in event_types:
            return "unknown"
        return "pending"

    async def deliver_to_session(
        self,
        session_id: str,
        message: str,
        *,
        source: Optional[dict[str, Any]] = None,
        delivery_id: Optional[str] = None,
        raise_on_error: bool = False,
    ) -> Optional[dict[str, Any]]:
        """Deliver an out-of-band message to a (durable) session — the agent stays resumable
        forever, so this works with no live socket. Busy (mid tool-loop): steer it into the live
        turn at its next step (don't start a colliding run). Idle: run a fresh background turn
        (results persist; if the session is Unattended, any approvals route to the Inbox). Shared
        by self-wake and channel-subscription delivery. `source` is the display-only MessageSource
        sidecar for connector messages (framed `message` stays the model-facing text).
        """
        if self.is_main_acp_session(session_id):
            result: Optional[dict[str, Any]] = None
            source_task_id = "host"
            if source:
                source_task_id = str(
                    source.get("connector")
                    or source.get("platform")
                    or source.get("task_id")
                    or source.get("kind")
                    or "host"
                )
            try:
                result = await self.main_acp_host.deliver(
                    session_id,
                    message,
                    source_task_id=source_task_id,
                    delivery_id=delivery_id,
                )
                if raise_on_error and not result.get("delivered"):
                    raise RuntimeError(
                        "main ACP delivery outcome is "
                        f"{result.get('state', 'unconfirmed')}; upstream delivery remains pending"
                    )
            except Exception as exc:
                logger.warning("main ACP delivery failed for %s: %s", session_id, exc)
                self.unrouted.record(session_id, "-", message, reason=str(exc))
                await self.broadcast_session(
                    session_id, {"type": "error", "data": {"error": str(exc)}}
                )
                if raise_on_error:
                    raise
            return result
        engine = self.get_engine(session_id)
        if engine is None:
            if raise_on_error:
                raise RuntimeError(f"target session is unavailable: {session_id}")
            return None
        if delivery_id:
            existing_state = self._non_acp_delivery_state(session_id, delivery_id)
            if existing_state != "pending":
                return {
                    "delivery_id": delivery_id,
                    "state": existing_state,
                    "delivered": existing_state == "delivered",
                }
        if not self.try_mark_running(session_id):
            if delivery_id:
                # A durable team delivery waits for the current turn to finish. Do not also
                # queue an in-memory steering message: doing both creates a replay window.
                return {
                    "delivery_id": delivery_id,
                    "state": "pending",
                    "delivered": False,
                }
            engine.queue_steering(message, source)
            return None
        if delivery_id:
            inserted = self.orchestrator.store.append_event(
                {
                    "event_id": f"session_delivery:{session_id}:{delivery_id}:prompting",
                    "event_type": "session.delivery.prompting",
                    "aggregate_type": "session_delivery",
                    "aggregate_id": session_id,
                    "payload": {"delivery_id": delivery_id},
                }
            )
            if not inserted:
                self.mark_idle(session_id)
                state = self._non_acp_delivery_state(session_id, delivery_id)
                return {
                    "delivery_id": delivery_id,
                    "state": state,
                    "delivered": state == "delivered",
                }
        turn_failed = False
        try:
            async for event in engine.run(message, source=source):
                # Stream every event to any socket viewing this session, so a background turn
                # (channel delivery, self-wake, durable resume) is seen live — not just on reselect.
                await self.broadcast_session(
                    session_id, {"type": event.type.value, "data": event.data}
                )
                # A background turn has no user watching to read an inline error: a dead model or
                # tool failure would otherwise vanish. Log it and park it in the dead-letter store.
                if event.type.value == "error":
                    turn_failed = True
                    reason = (event.data or {}).get("error", "unknown error")
                    logger.warning(
                        "background turn failed for %s: %s", session_id, reason
                    )
                    self.unrouted.record(session_id, "-", message, reason=reason)
            self.save(session_id, engine)
        except (
            Exception
        ) as exc:  # an unexpected raise out of the turn must not be swallowed
            turn_failed = True
            logger.warning("background turn crashed for %s: %s", session_id, exc)
            self.unrouted.record(session_id, "-", message, reason=str(exc))
            await self.broadcast_session(
                session_id, {"type": "error", "data": {"error": str(exc)}}
            )
            if raise_on_error:
                raise
        finally:
            self.mark_idle(session_id)
            await self.broadcast_session(session_id, {"type": "turn_done", "data": {}})
        if delivery_id:
            if not turn_failed:
                self.orchestrator.store.append_event(
                    {
                        "event_id": f"session_delivery:{session_id}:{delivery_id}:delivered",
                        "event_type": "session.delivery.delivered",
                        "aggregate_type": "session_delivery",
                        "aggregate_id": session_id,
                        "payload": {"delivery_id": delivery_id},
                    }
                )
            state = self._non_acp_delivery_state(session_id, delivery_id)
            return {
                "delivery_id": delivery_id,
                "state": state,
                "delivered": state == "delivered",
            }
        return None

    # -- channel subscriptions (inbound messaging) ------------------------------
    async def _dispatch_inbound(self, event) -> None:
        """Route a non-token inbound message. Channel messages are buffered (for catch-up) and
        fanned out to every subscribed session; a DM (or any non-channel) goes to the user-designated
        DM session (delivered like any background turn) or, if none is set, is parked as unrouted.
        """
        src = event.source
        text = getattr(event, "text", "") or ""
        who = src.user_name or src.user_id or "?"
        channel = f"{src.platform}:{src.chat_id}"  # thread-agnostic channel address
        self._note_person(src.platform, src.user_id, src.user_name)
        # Structured sidecar (display-only) built from the resolved identities on the event — the
        # framed text below stays the model-facing `content`; `ms.text` carries the RAW message.
        ms = MessageSource(
            connector=src.platform,
            kind="channel" if src.chat_type in ("channel", "group") else "dm",
            channel_id=src.chat_id,
            channel_name=src.chat_name or src.chat_id,
            sender_id=src.user_id or "",
            sender_name=src.user_name or src.user_id or "?",
            ts=_inbound_epoch(getattr(event, "message_id", None)),
            text=text,
        )
        if src.chat_type in ("channel", "group"):
            self.channel_buffer.record(
                channel, who, text, name=src.chat_name
            )  # buffer all, even unsubscribed
            subs = self.subscriptions.for_channel(channel)
            # §31 mention router: a direct @-mention of the bot outranks the passive fan-out —
            # subscribed sessions must answer it; an unsubscribed channel spawns (or steers)
            # the per-thread coworker session.
            if getattr(event, "mentions_me", False):
                await self._route_mention(event, ms, subs)
                return
            if subs:
                # Chattiness tiers (§31): untagged channel traffic is judgement-only —
                # silence is the default; the must-respond framing is the mention path's.
                msg = (
                    f"💬 New message on {src.chat_name or channel} from {who}: {text}\n"
                    f"(You're subscribed to this channel but were NOT mentioned. Use your "
                    f"judgement: stay silent unless the message clearly concerns your job and "
                    f"a reply adds real value — most channel chatter needs no response from "
                    f'you. If you do reply, use the send_message tool with target "{channel}".)'
                )
                for sub in subs:
                    # Per-session connection hierarchy (§4.3): a session that has muted this
                    # connector skips delivery — the message is still buffered (above) for catch-up.
                    if not self._inbound_connector_allowed(
                        sub.session_id, src.platform
                    ):
                        continue
                    try:
                        await self.deliver_to_session(
                            sub.session_id, msg, source=ms.to_dict()
                        )
                    except Exception:
                        pass
                return
            return  # channel with no subscribers — nobody is listening
        # DM (or any non-channel): route to the designated session, else park it for visibility.
        dm = self.dm_session()
        if dm and self._inbound_connector_allowed(dm, src.platform):
            await self.deliver_to_session(dm, event.tagged_text(), source=ms.to_dict())
        elif dm:
            # Designated, but this session has muted the connector → park rather than deliver.
            self.unrouted.record(
                src.target, who, text, reason="connector muted for DM session"
            )
        else:
            self.unrouted.record(
                src.target, who, text, reason="no DM session designated"
            )

    # -- mention router (§31) ----------------------------------------------------
    async def _route_mention(self, event, ms: MessageSource, subs) -> None:
        """@OpenWorker tagged in a channel. A subscribed (user-connected) coworker owns the channel
        and must answer; otherwise the per-thread coworker session handles it — spawned on the
        first tag, steered by follow-ups (deduped on the thread target)."""
        from ..connectors.base import format_target

        src = event.source
        # Slack semantics: replying to a top-level message threads on THAT message's ts, so a
        # top-level tag (no thread_ts) keys — and is answered — on its own ts.
        thread_key = src.thread_id or getattr(event, "message_id", None)
        thread_target = format_target(src.platform, src.chat_id, thread_key)
        who = src.user_name or src.user_id or "?"
        chan = f"#{src.chat_name}" if src.chat_name else src.chat_id
        if subs:
            # The user connected a coworker to this channel — it answers tags; no spawn.
            msg = (
                f"🔔 You were tagged by {who} in {chan}: {event.text}\n"
                f"(You are subscribed to this channel and were mentioned directly — you must "
                f"respond. Reply in the thread with the send_message tool, target "
                f'"{thread_target}".)'
            )
            for sub in subs:
                if not self._inbound_connector_allowed(sub.session_id, src.platform):
                    continue
                try:
                    await self.deliver_to_session(
                        sub.session_id, msg, source=ms.to_dict()
                    )
                except Exception:
                    pass
            return
        sid = self.mention_sessions.get(thread_target)
        if sid and self.session_store.load(sid) is not None:
            # Follow-up tag in a thread we already own → steer the same session.
            msg = (
                f"💬 Follow-up in your Slack thread ({chan}) from {who}: {event.text}\n"
                f'(Reply in the thread with the send_message tool, target "{thread_target}" '
                f"— replies there are pre-approved.)"
            )
            await self.deliver_to_session(sid, msg, source=ms.to_dict())
            return
        await self._spawn_mention_session(event, ms, thread_target)

    async def _spawn_mention_session(
        self, event, ms: MessageSource, thread_target: str
    ) -> None:
        """First tag in a thread: a NEW visible coworker session that owns the thread. Its
        in-thread replies carry a standing grant (§25 shape, exact-target match) so the
        conversation never stalls on an approval nobody in Slack can see; everything else
        asks as usual (approvals park to the Inbox)."""
        import uuid

        src = event.source
        who = src.user_name or src.user_id or "?"
        chan = f"#{src.chat_name}" if src.chat_name else src.chat_id
        sid = uuid.uuid4().hex
        engine = self.get_engine(sid, agent=self.personas.default_id())
        if engine is None:
            self.unrouted.record(
                src.target, who, event.text, reason="could not spawn mention session"
            )
            return
        # Durable mapping FIRST (a fast follow-up tag mid-turn dedupes into steering),
        # then the live grant; get_engine re-derives it from the store on any rebuild.
        self.mention_sessions.set(
            thread_target, sid, channel=f"{src.platform}:{src.chat_id}"
        )
        engine.permissions.task_rules.setdefault("send_message", set()).add(
            thread_target
        )
        self.save(sid, engine)  # the sessions row must exist before rename/set_origin
        # Title = the ASK first, channel last (owner call 2026-07-14): the text is what
        # varies between sessions, so it gets the truncation budget; the mention token is
        # noise (origin is already told by the From Slack group + icon + origin_label).
        ask = re.sub(r"<@[^>]+>", "", event.text or "")
        ask = " ".join(ask.split())[:48]
        self.session_store.rename(sid, f"{ask} — {chan}" if ask else chan)
        label = chan + (f" · {src.team_id}" if src.team_id else "")
        self.session_store.set_origin(sid, src.platform, label)
        # Up to 6 lines of channel context, minus the tag itself (it's the opening line).
        recent = self.channel_buffer.recent(f"{src.platform}:{src.chat_id}", 7)[:-1]
        context = "\n".join(f"- {m['from']}: {m['text']}" for m in recent)
        opening = (
            f"🔔 You were mentioned on Slack in {chan} by {who}: {event.text}\n\n"
            f"You own this Slack thread. Reply in the thread using the send_message tool "
            f'with target "{thread_target}" — replies to this thread are pre-approved and '
            f"never prompt the user. Anything else (other channels, files, external "
            f"actions) asks for approval as usual. Keep replies concise and "
            f"Slack-appropriate."
            + (f"\n\nRecent channel context:\n{context}" if context else "")
        )
        try:
            await self.deliver_to_session(sid, opening, source=ms.to_dict())
        except Exception:
            logger.exception("mention session %s opening turn failed", sid)

    @staticmethod
    def _wake_message(wake) -> str:
        note = f" (note: {wake.note})" if getattr(wake, "note", "") else ""
        if wake.kind == "completion":
            return (
                f"⏰ Wake — the job `{wake.job_id}` you were waiting on has completed{note}. "
                "Continue where you left off."
            )
        if wake.kind == "event":
            return (
                f"⏰ Wake — the event `{wake.event_key}` you were waiting on has fired{note}. "
                "Continue where you left off."
            )
        return (
            f"⏰ Wake — the timer you set has fired{note}. Continue where you left off."
        )

    async def _run_scheduled_task(self, task, trigger: str) -> TaskRun:
        run = TaskRun(
            task_id=task.id, trigger=trigger
        )  # __post_init__ sets run.session_id
        self.task_store.add_run(run)  # mark "running"
        # UX-026: tell every open app window a SCHEDULED run just started (the 5s
        # top-right toast). Manual runs never come through here — the user is
        # already watching those live.
        await self.broadcast_event(
            {
                "type": "automation_run_started",
                "data": {
                    "task_id": task.id,
                    "task_title": task.title,
                    "session_id": run.session_id,
                    "workspace": task.workspace,
                    "agent": task.agent,
                    "trigger": trigger,
                },
            }
        )
        # Each run is a real, persisted conversation thread: it runs the instructions under its
        # own session id, then saves the transcript. The user can reopen that session and ask a
        # follow-up — the scheduled agent is no longer fire-and-forget.
        engine = self._build_task_engine(task, session_id=run.session_id)
        # Register the live engine up-front: a parked approval persists the session
        # mid-run (durable suspend), and resolving from the Inbox must find this engine.
        self._engines[run.session_id] = engine
        # The first turn is the task itself. The framing matters: instructions often restate the
        # schedule ("every day at 5:32pm…"), so make explicit that the schedule already fired and
        # the job now is to execute, not to (re)schedule.
        opening = (
            f"⏰ Scheduled run — {task.title}\n\n"
            "This automation is due now: carry out the task below immediately and produce the "
            "result. The schedule already exists — do not create or modify any scheduled tasks.\n\n"
            f"{task.instructions}"
        )
        try:
            async for _event in engine.run(opening):
                pass
            run.result_text = _last_assistant_text(engine.messages)
            run.artifacts = _recent_files(task.workspace, since=run.started_at)
            # A provider-level failure surfaces as an ERROR event, not an exception —
            # the failed turn ends the transcript in an `error` notice (same signal
            # finalize_manual_run uses for live manual runs).
            run.error = _last_turn_error(engine.messages)
            run.status = "error" if run.error else "ok"
            if run.status == "ok" and task.notify_on_completion:
                await self._notify_task_done(task, run)
        except Exception as exc:
            run.status, run.error = "error", str(exc)
        finally:
            run.finished_at = _epoch()
            # Persist the run as a continuable session + keep the live engine for an immediate
            # follow-up; record the run (now carrying its session_id).
            try:
                self.save(run.session_id, engine)
                self._engines[run.session_id] = engine
            except Exception:
                pass
            self.task_store.add_run(run)
        return run

    async def _notify_task_done(self, task, run: TaskRun) -> None:
        summary = (run.result_text or "").strip()[:280]
        # Notify any socket viewing this scheduled run's session (it's a durable session of its own).
        await self.broadcast_session(
            run.session_id,
            {
                "type": "task_done",
                "data": {
                    "task": task.title,
                    "id": task.id,
                    "text": summary,
                    "run_id": run.run_id,
                },
            },
        )
        if task.notify_target:
            from ..connectors.base import parse_target
            from ..connectors.senders import DEFAULT_SENDERS

            try:
                platform, chat_id, thread = parse_target(task.notify_target)
                sender = DEFAULT_SENDERS.get(platform)
                creds = self.secrets.get(f"{platform}:default") or {}
                if sender and creds.get("bot_token"):
                    await asyncio.to_thread(
                        sender,
                        creds["bot_token"],
                        chat_id,
                        f"✓ {task.title}\n\n{summary}",
                        thread,
                    )
            except Exception:
                pass

    # -- automation REST --------------------------------------------------------
    def list_automations(self) -> dict[str, Any]:
        # Unseen = runs started after the task's seen mark (UX-023 sidebar badges).
        # `unseen_failed` tints the badge when the NEWEST unseen run errored.
        tasks = []
        for t in self.task_store.list():
            unseen = [
                r for r in self.task_store.runs(t.id) if r.started_at > t.seen_runs_at
            ]
            tasks.append(
                {
                    **t.public(),
                    "unseen_runs": len(unseen),
                    "unseen_failed": bool(unseen) and unseen[0].status == "error",
                }
            )
        return {"tasks": tasks}

    def mark_automation_seen(self, task_id: str) -> dict[str, Any]:
        task = self.task_store.get(task_id)
        if task is None:
            return {"ok": False, "error": "not found"}
        task.seen_runs_at = time.time()
        self.task_store.save(task)
        return {"ok": True}

    def get_automation(self, task_id: str) -> dict[str, Any]:
        task = self.task_store.get(task_id)
        if task is None:
            return {"error": "not found"}
        return {
            "task": task.public(),
            "runs": [r.to_dict() for r in self.task_store.runs(task_id)],
        }

    def create_automation(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Create an automation directly from the GUI (the "New automation" / template flow).
        Mirrors the agent-facing `create_scheduled_task` validation, but binds the task to a
        fresh per-task scratch workspace instead of an origin conversation's folder."""
        from croniter import croniter

        title = (payload.get("title") or "").strip()
        instructions = (payload.get("instructions") or "").strip()
        cron = (payload.get("cron") or "").strip() or None
        fire_at = (payload.get("fire_at") or "").strip() or None
        timezone = (payload.get("timezone") or "").strip() or "local"

        if not title:
            return {"ok": False, "error": "title is required"}
        if not instructions:
            return {"ok": False, "error": "instructions are required"}
        if not cron and not fire_at:
            return {
                "ok": False,
                "error": "provide a cron (recurring) or a fire_at ISO datetime (one-time)",
            }
        if cron and not croniter.is_valid(cron):
            return {"ok": False, "error": f"invalid cron expression: {cron}"}

        schedule = Schedule(
            kind="once" if (fire_at and not cron) else "cron",
            cron=cron,
            fire_at=fire_at,
            timezone=timezone,
        )
        from ..automation.models import grant_entries

        task = ScheduledTask(
            title=title,
            instructions=instructions,
            schedule=schedule,
            workspace="",
            origin_surface="cowork",
            agent="cowork",
            # Human-driven path (GUI form / onboarding recipes): the creating surface
            # rendered the grants, the submit IS the consent. Same validation as the
            # agent tool — only target-bound write grants survive.
            always_allowed_tools=grant_entries(payload.get("permissions")),
        )
        task.workspace = self._provision_scratch(task.task_session_id)
        self.task_store.save(task)
        return {"ok": True, "task": task.public()}

    def update_automation(
        self, task_id: str, changes: dict[str, Any]
    ) -> dict[str, Any]:
        task = self.task_store.get(task_id)
        if task is None:
            return {"ok": False, "error": "not found"}
        if "enabled" in changes:
            task.enabled = bool(changes["enabled"])
        if changes.get("instructions") is not None:
            task.instructions = changes["instructions"]
        if changes.get("title") is not None:
            task.title = changes["title"]
        if changes.get("cron") is not None:
            from croniter import croniter

            if not croniter.is_valid(changes["cron"]):
                return {"ok": False, "error": "invalid cron"}
            task.schedule.cron, task.schedule.kind = changes["cron"], "cron"
        if changes.get("revoke"):
            # Revocation from the task detail page ("Allowed without asking … · Revoke").
            # Human-only, like minting; the agent-facing update tool has no such field.
            task.revoke_rule(str(changes["revoke"]))
        self.task_store.save(task)
        if changes.get("revoke"):
            # A live run engine may still hold the revoked rule — reseed from the record.
            for sid, engine in self._engines.items():
                owner = self.task_store.task_for_run_session(sid)
                if owner is not None and owner.id == task.id:
                    engine.permissions.task_rules = task.standing_rules()
        return {"ok": True, "task": task.public()}

    def delete_automation(self, task_id: str) -> dict[str, Any]:
        return {"ok": self.task_store.delete(task_id), "id": task_id}

    def prepare_manual_run(self, task_id: str) -> dict[str, Any]:
        """Create a 'running' manual run and return its session, so the GUI can open it and
        drive the task LIVE over the normal session WS (you watch the agent + follow up). The
        automatic scheduler path stays headless (`_run_scheduled_task`)."""
        task = self.task_store.get(task_id)
        if task is None:
            return {"ok": False, "error": "not found"}
        Path(task.workspace).mkdir(parents=True, exist_ok=True)
        run = TaskRun(
            task_id=task.id, trigger="manual"
        )  # status "running", session_id auto
        self.task_store.add_run(run)
        return {
            "ok": True,
            "run_id": run.run_id,
            "session_id": run.session_id,
            "workspace": task.workspace,
            "agent": task.agent,
            # Same execute-now framing as the headless path — manual runs ride a normal live
            # session whose engine DOES have scheduling tools, so be explicit.
            "prompt": (
                f"⏰ Running automation '{task.title}' now. Carry out these instructions "
                "immediately and produce the result. The schedule already exists — do not create "
                f"or modify any scheduled tasks.\n\n{task.instructions}"
            ),
        }

    def finalize_manual_run(self, task_id: str, run_id: str) -> dict[str, Any]:
        """Mark a manual run complete once its first turn finished (the WS already saved the
        session). Pulls result text + artifacts from the persisted transcript/workspace.
        """
        run = next(
            (r for r in self.task_store.runs(task_id) if r.run_id == run_id), None
        )
        task = self.task_store.get(task_id)
        if run is None or task is None:
            return {"ok": False, "error": "not found"}
        if run.status == "running":
            record = self.session_store.load(run.session_id)
            messages = record.messages if record else []
            run.result_text = _last_assistant_text(messages)
            run.artifacts = _recent_files(task.workspace, since=run.started_at)
            # The GUI finalizes on ANY turn_done (errored turns included), so derive the
            # outcome from the transcript tail: a failed turn ends in an `error` notice.
            run.error = _last_turn_error(messages)
            run.status = "error" if run.error else "ok"
            run.finished_at = _epoch()
            self.task_store.add_run(run)
            task.last_run, task.last_status = run.finished_at, run.status
            task.run_count += 1
            self.task_store.save(task)
        return {"ok": True, "run": run.to_dict()}

    def save(self, session_id: str, engine: TurnEngine) -> None:
        executor = getattr(engine, "executor", None)
        workspace = os.path.realpath(str(executor.cwd)) if executor else ""
        self.session_store.save(
            SessionRecord(
                session_id=session_id,
                workspace=workspace,
                model=engine.model,
                mode=engine.permissions.mode.value,
                messages=engine.messages,
                title=title_from(engine.messages),
                agent=getattr(engine, "agent_name", "code"),
                extra_roots=self._extra_roots_of(engine),
                grants=_grants_of(engine),
                compaction=(
                    engine.compaction_state.as_dict()
                    if getattr(engine, "compaction_state", None)
                    else {}
                ),
            )
        )

    @staticmethod
    def _apply_grants(engine: TurnEngine, grants: dict[str, Any]) -> None:
        """Re-apply a reloaded session's persisted "Always allow" approvals — they're
        session-scoped, and the session outlives the process (owner-hit 2026-07-22)."""
        for tool in grants.get("tools") or []:
            engine.permissions.allow_tool_for_session(str(tool))
        for command in grants.get("commands") or []:
            engine.permissions.allow_command_for_session(str(command))

    @staticmethod
    def _extra_roots_of(engine: TurnEngine) -> list[dict[str, Any]]:
        """Added folders = the engine's roots minus the primary scratch (index 0)."""
        roots = getattr(engine, "roots", None) or []
        return [
            {"path": str(r.path), "writable": bool(r.writable), "label": r.label}
            for r in roots[1:]
        ]

    # -- LLM auto-titles (FB-010) -------------------------------------------------
    _AUTOTITLE_PROMPT = (
        "You title chat sessions. Given the user's opening message(s), reply with ONLY "
        "a 4-5 word title for the session — no quotes or punctuation wrapping it. If "
        'the opening is merely a greeting or small-talk with no topic ("hey", '
        '"how are you", "hi there"), reply with exactly: small-talk'
    )

    def _maybe_autotitle(self, session_id: str) -> None:
        """Kick off title generation after a turn completes, fire-and-forget. Only while
        the session has neither a manual rename nor a generated title, at most twice:
        attempt 1 rides turn 1, and the second window exists solely for the small-talk
        retry (with both openers). Attempts are counted in memory rather than derived
        from the user-message count — steering injections also land as role "user", and
        counting them would silently suppress titling on a steered first turn. A restart
        forgetting the counter is harmless: renamed/auto_title still gate re-titling."""
        if session_id.startswith("__"):
            return
        engine = self._engines.get(session_id)
        if engine is None or session_id in self._autotitle_inflight:
            return
        if self.task_store.task_for_run_session(session_id) is not None:
            return  # automation runs are titled by their task
        if self._autotitle_attempts.get(session_id, 0) >= 2:
            return
        users = [m for m in engine.messages if m.get("role") == "user"]
        if not users:
            return
        state = self.session_store.title_state(session_id)
        if state is None or state["renamed"] or state["auto_title"]:
            return
        from ..attachments import content_to_text

        openers = [
            text
            for m in users
            if (text := content_to_text(m.get("content"), image_placeholder="").strip())
        ][:2]
        if not openers:
            return
        self._autotitle_attempts[session_id] = (
            self._autotitle_attempts.get(session_id, 0) + 1
        )
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # no loop to ride (sync caller) — skip, never block
        self._autotitle_inflight.add(session_id)
        # Retain the task: the loop holds only a weak ref, and a GC'd task would both
        # kill the title mid-flight and strand the inflight guard.
        task = loop.create_task(self._generate_autotitle(session_id, engine, openers))
        self._autotitle_tasks.add(task)
        task.add_done_callback(self._autotitle_tasks.discard)

    async def _generate_autotitle(
        self, session_id: str, engine: TurnEngine, openers: list[str]
    ) -> None:
        """One cheap non-streaming completion on the session's own provider/model. Every
        failure (provider error, empty, absurdly long) is swallowed — the title_from
        fallback stays; the small-talk sentinel leaves auto_title unset so the turn-2
        retry can run."""
        try:
            turn = await asyncio.to_thread(
                engine.provider.complete,
                model=engine.model,
                messages=[
                    {"role": "system", "content": self._AUTOTITLE_PROMPT},
                    {"role": "user", "content": "\n\n".join(openers)},
                ],
                temperature=0.2,
                # Reasoning-routed models spend hidden tokens BEFORE emitting text; a
                # tight cap plus default effort yields an empty completion and a silent
                # no-op. Effort "none" reaches only the OpenAI-compat path (the native
                # providers whitelist their settings), and 64 leaves headroom either way.
                max_tokens=64,
                reasoning_effort="none",
            )
            raw = (getattr(turn, "text", None) or "").strip()
            # Sanitize: surrounding quotes off, whitespace collapsed, capped at 60.
            title = " ".join(raw.strip("\"'“”‘’`").split())
            # Sentinel tolerance: models riff on the exact token ("Small talk.", quoted,
            # trailing period) — normalize before comparing, else the riff becomes the title.
            if title.lower().strip(".!,;:'\"").replace(" ", "-").replace("_", "-") in (
                "small-talk",
                "smalltalk",
            ):
                return
            if not title or len(title) > 80:
                return
            if self.session_store.set_auto_title(session_id, title[:60]):
                # Best-effort nudge for any live viewer; the sidebar's poll and
                # post-turn refresh pick the new title up regardless.
                await self.broadcast_session(
                    session_id,
                    {
                        "type": "session_title",
                        "data": {"session_id": session_id, "title": title[:60]},
                    },
                )
        except Exception:
            # A failed title must never surface as a session error — but it must
            # not be invisible either (a silent provider 400 hid the max_tokens
            # rejection for a whole owner test pass, 2026-07-20).
            logger.debug("autotitle failed for %s", session_id, exc_info=True)
        finally:
            self._autotitle_inflight.discard(session_id)

    # -- session roots (orphan Cowork: scratch + added folders) ------------------
    def get_roots(self, session_id: str) -> list[dict[str, Any]]:
        """The directories this session can touch: primary scratch first, then added folders.
        Reads the live engine when one is running; otherwise reconstructs from persisted state.
        """
        engine = self._engines.get(session_id)
        if engine is not None and getattr(engine, "roots", None):
            return [
                {
                    "path": str(r.path),
                    "writable": bool(r.writable),
                    "label": r.label,
                    "primary": i == 0,
                    "exists": r.path.is_dir(),
                }
                for i, r in enumerate(engine.roots)
            ]
        record = self.session_store.load(session_id)
        primary = (
            record.workspace
            if record and record.workspace
            else self._provision_scratch(session_id)
        )
        extra = (record.extra_roots if record else []) or []
        out = [
            {
                "path": primary,
                "writable": True,
                "label": "scratch",
                "primary": True,
                "exists": Path(primary).is_dir(),
            }
        ]
        for r in extra:
            p = str(r.get("path", ""))
            out.append(
                {
                    "path": p,
                    "writable": bool(r.get("writable", False)),
                    "label": r.get("label") or Path(p).name,
                    "primary": False,
                    "exists": Path(p).is_dir(),
                }
            )
        return out

    def add_root(
        self, session_id: str, path: str, writable: bool = False
    ) -> dict[str, Any]:
        """Grant the session access to another folder (read-only or read-write). Mutates the live
        engine in place when running (file tools + permissions + context see it immediately) and
        persists it so a later resume still has it."""
        p = Path(path).expanduser()
        if not p.is_dir():
            return {"ok": False, "error": f"not a directory: {path}"}
        resolved = p.resolve()
        engine = self._engines.get(session_id)
        if engine is not None and getattr(engine, "roots", None) is not None:
            if any(r.path == resolved for r in engine.roots):
                # already present: just update its access level
                for r in engine.roots:
                    if r.path == resolved:
                        r.writable = bool(writable)
            else:
                engine.roots.append(RootDir(path=resolved, writable=bool(writable)))
            self.session_store.set_extra_roots(session_id, self._extra_roots_of(engine))
        else:
            # A brand-new conversation has no record yet (it's only saved after the first turn) —
            # create one now so set_extra_roots has a row to update and the folder survives.
            if self.session_store.load(session_id) is None:
                self.session_store.save(
                    SessionRecord(
                        session_id=session_id,
                        workspace=self._provision_scratch(session_id),
                        model=self.model,
                        mode=self.mode.value,
                        messages=[],
                        agent="cowork",  # folder access is a Cowork affordance
                    )
                )
            extra = [r for r in self.get_roots(session_id) if not r["primary"]]
            extra = [r for r in extra if Path(r["path"]).resolve() != resolved]
            extra.append(
                {
                    "path": str(resolved),
                    "writable": bool(writable),
                    "label": resolved.name,
                }
            )
            self.session_store.set_extra_roots(
                session_id,
                [
                    {
                        "path": r["path"],
                        "writable": r["writable"],
                        "label": r.get("label", ""),
                    }
                    for r in extra
                ],
            )
        self.session_store.touch_workspace(str(resolved))
        return {"ok": True, "roots": self.get_roots(session_id)}

    def remove_root(self, session_id: str, path: str) -> dict[str, Any]:
        """Revoke a previously-added folder. The primary scratch cannot be removed."""
        resolved = Path(path).expanduser().resolve()
        engine = self._engines.get(session_id)
        if engine is not None and getattr(engine, "roots", None):
            if engine.roots and engine.roots[0].path == resolved:
                return {
                    "ok": False,
                    "error": "cannot remove the primary scratch directory",
                }
            engine.roots[:] = [r for r in engine.roots if r.path != resolved]
            self.session_store.set_extra_roots(session_id, self._extra_roots_of(engine))
        else:
            current = self.get_roots(session_id)
            if (
                current
                and current[0]["primary"]
                and Path(current[0]["path"]).resolve() == resolved
            ):
                return {
                    "ok": False,
                    "error": "cannot remove the primary scratch directory",
                }
            extra = [
                r
                for r in current
                if not r["primary"] and Path(r["path"]).resolve() != resolved
            ]
            self.session_store.set_extra_roots(
                session_id,
                [
                    {
                        "path": r["path"],
                        "writable": r["writable"],
                        "label": r.get("label", ""),
                    }
                    for r in extra
                ],
            )
        return {"ok": True, "roots": self.get_roots(session_id)}

    def session_messages(self, session_id: str) -> list[dict[str, Any]]:
        # A live engine's in-memory thread is authoritative: mid-turn it's ahead of the
        # persisted record — which may not even exist yet for a scheduled run's first turn
        # (opening a "running" automation showed a blank session; owner report 2026-07-04).
        engine = self._engines.get(session_id)
        if engine is not None:
            return list(engine.messages)
        record = self.session_store.load(session_id)
        return record.messages if record else []

    def rename_session(self, session_id: str, title: str) -> dict[str, Any]:
        if session_id.startswith("__"):
            return {"ok": False, "error": "internal sessions cannot be renamed"}
        ok = self.session_store.rename(session_id, title)
        return {
            "ok": ok,
            "session_id": session_id,
            "title": " ".join((title or "").split())[:120],
        }

    def set_session_flags(
        self,
        session_id: str,
        *,
        pinned: Optional[bool] = None,
        archived: Optional[bool] = None,
    ) -> dict[str, Any]:
        if session_id.startswith("__"):
            return {"ok": False, "error": "internal sessions cannot be modified here"}
        ok = self.session_store.set_flags(session_id, pinned=pinned, archived=archived)
        return {"ok": ok, "session_id": session_id}

    def delete_session(self, session_id: str) -> dict[str, Any]:
        if session_id.startswith("__"):
            return {"ok": False, "error": "internal sessions cannot be deleted here"}
        engine = self._engines.pop(session_id, None)
        if engine is not None:
            try:
                # (was engine.interrupt() — a method that never existed; the AttributeError
                # was silently swallowed, so deleting a running session never stopped it.)
                engine.request_interrupt()
            except Exception:
                pass
        record = self.session_store.load(session_id)
        ok = self.session_store.delete(session_id)
        # Deleting a session is the one implicit unsubscribe (otherwise subscriptions are permanent).
        self.subscriptions.remove_session(session_id)
        # ...and releases any Slack threads it owned (§31): the next tag there spawns fresh.
        self.mention_sessions.remove_session(session_id)
        # ...and drops its per-session connector overrides (§4.2, like subscriptions).
        self.session_connections.remove_session(session_id)
        # ...and closes its pending Inbox items — an orphaned approval/question can never be
        # meaningfully answered (owner call, 2026-07-03).
        self.inbox.resolve_session(session_id)
        # ...and its scratch dir. STRICTLY scoped: only a directory inside scratch_base is
        # removed — a real project folder the user picked is never touched.
        if ok and record and record.workspace:
            scratch = self.scratch_base().resolve()
            ws = Path(record.workspace)
            try:
                resolved = ws.resolve()
                if (
                    resolved.is_relative_to(scratch)
                    and resolved != scratch
                    and resolved.is_dir()
                ):
                    shutil.rmtree(resolved)
            except OSError:
                pass  # a stale/foreign path must not fail the delete
        return {"ok": ok, "session_id": session_id}

    # -- provider proxy ---------------------------------------------------------
    def provider_complete(self, model, messages, tools=None):
        return self.provider.complete(model=model, messages=messages, tools=tools)

    def _refresh_provider(self, name: Optional[str] = None) -> None:
        """Drop the router's cached client(s) so the next turn rebuilds with fresh config.
        No-op for an injected non-router provider (tests)."""
        invalidate = getattr(self.provider, "invalidate", None)
        if callable(invalidate):
            invalidate(name)

    # -- read models ------------------------------------------------------------
    def list_sessions(self, workspace: Optional[str] = None) -> list[dict[str, Any]]:
        ws = self.resolve_workspace(workspace) if workspace else None
        return [
            {
                "session_id": r.session_id,
                "title": r.title or "New session",
                "workspace": r.workspace,
                "agent": r.agent,
                "model": r.model,
                "mode": r.mode,
                "updated_at": r.updated_at,
                "messages": r.message_count,
                "pinned": r.pinned,
                "archived": r.archived,
                # §31: non-user origin ("slack") + display label — drives the sidebar's
                # "From Slack" group and the row's platform icon.
                "origin": r.origin,
                "origin_label": r.origin_label,
                # Attention = Inbox items awaiting this session (the amber count that bubbles
                # session → persona → footer Inbox). Liveness = working (in-flight turn) /
                # sleeping (a self-wake is pending) / idle — a count-less dot that never bubbles.
                "attention": len(self.inbox.pending(session_id=r.session_id)),
                "liveness": self._session_liveness(r.session_id),
                # Channels this session listens to (inbound subscriptions) — drives the per-session
                # "connections" indicator.
                "subscriptions": [
                    s.channel for s in self.subscriptions.for_session(r.session_id)
                ],
            }
            for r in self.session_store.list(workspace=ws)
            if not r.session_id.startswith("__")  # hide internal threads
        ]

    def _session_liveness(self, session_id: str) -> str:
        if self.is_running(session_id):
            return "working"
        if self.wakes.pending(session_id):
            return "sleeping"
        return "idle"

    def list_agents(self) -> list[dict[str, Any]]:
        return _list_agents()

    def list_skills(self) -> list[dict[str, Any]]:
        loader = SkillLoader([state_dir() / "skills"])
        return loader.catalog()

    def list_memory(self) -> list[dict[str, Any]]:
        return [
            {"id": m.id, "scope": m.scope.value, "content": m.content}
            for m in self.memory_store.list()
        ]

    def add_memory(
        self, content: str, scope: str = "workspace", workspace: Optional[str] = None
    ) -> dict[str, Any]:
        chosen = Scope(scope) if scope in _SCOPES else Scope.WORKSPACE
        ws = self.resolve_workspace(workspace) if chosen is Scope.WORKSPACE else None
        item = self.memory_store.add(content, scope=chosen, workspace=ws)
        return {"id": item.id, "scope": item.scope.value, "content": item.content}

    def is_main_acp_session(self, session_id: str) -> bool:
        if session_id in getattr(self.main_acp_host, "_runtimes", {}):
            return True
        record = self.session_store.load(session_id)
        if record is not None and record.agent != "code":
            return False
        events = self.orchestrator.store.list_events(
            aggregate_type="main_session", aggregate_id=session_id
        )
        return any(event.event_type == "main_session.bound" for event in events)

    def add_audio_transcript_memory(self, body: dict[str, Any]) -> dict[str, Any]:
        forbidden = {
            "audio",
            "blob",
            "base64",
            "file",
            "bytes",
            "raw",
            "data_url",
            "dataUrl",
            "audio_blob",
            "audioBlob",
        }
        present = sorted(key for key in forbidden if key in (body or {}))
        if present:
            return {
                "ok": False,
                "error": "audio transcript memory accepts text only",
                "rejected_fields": present,
            }
        text = str((body or {}).get("text") or "").strip()
        if not text:
            return {"ok": False, "error": "text is required"}
        if text.startswith("data:") or "base64," in text[:256]:
            return {"ok": False, "error": "raw audio/base64 content is not accepted"}
        scope_raw = str((body or {}).get("scope") or "workspace")
        chosen = Scope(scope_raw) if scope_raw in _SCOPES else Scope.WORKSPACE
        workspace = None
        session_id = None
        if chosen is Scope.WORKSPACE:
            workspace = self.resolve_workspace((body or {}).get("workspace"))
            if not workspace:
                return {"ok": False, "error": "valid workspace is required"}
        elif chosen is Scope.SESSION:
            session_id = str((body or {}).get("session_id") or "").strip()
            if not session_id:
                return {"ok": False, "error": "session_id is required for session scope"}
        item = self.memory_store.add(
            text,
            scope=chosen,
            key=f"audio-transcript:{uuid.uuid4().hex}",
            workspace=workspace,
            session_id=session_id,
        )
        return {
            "ok": True,
            "id": item.id,
            "scope": item.scope.value,
            "content": item.content,
            "key": item.key,
        }


def _parse_inbox_json(s: str) -> dict[str, Any]:
    """Parse a structured Inbox resolution (directory/plan carry their reply as a JSON string)."""
    import json as _json

    try:
        v = _json.loads(s) if s else {}
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


def _epoch() -> float:
    import time

    return time.time()


# A Slack message ts looks like "1700000001.000001" (epoch seconds + microseconds). Other
# platforms use opaque/incrementing ids (e.g. a Telegram integer), so only parse the Slack shape.
_SLACK_TS_RE = re.compile(r"^\d+\.\d+$")


def _inbound_epoch(message_id: Optional[str]) -> float:
    """Best-effort epoch-seconds for a MessageSource: a Slack-style ts, else wall-clock now."""
    if message_id and _SLACK_TS_RE.match(str(message_id)):
        try:
            return float(message_id)
        except ValueError:
            pass
    return time.time()


def _last_assistant_text(messages: list[dict[str, Any]]) -> Optional[str]:
    for msg in reversed(messages or []):
        if msg.get("role") == "assistant" and msg.get("content"):
            return msg["content"]
    return None


def _last_turn_error(messages: list[dict[str, Any]]) -> Optional[str]:
    """The failure text if the transcript's LAST turn ended in an error, else None. The
    engine persists a display-only `notice` message with kind "error" as the terminal
    entry of a failed turn (engine._append_notice), so the tail decides; other trailing
    notices (interrupted, model_switch) don't count as failure."""
    for msg in reversed(messages or []):
        if msg.get("role") == "notice":
            if msg.get("kind") == "error":
                return str(msg.get("text") or "turn failed")
            continue
        return None
    return None


def _recent_files(workspace: str, *, since: float, limit: int = 20) -> list[str]:
    """Files in the task workspace modified during the run — the run's artifacts."""
    out: list[str] = []
    root = Path(workspace)
    if not root.is_dir():
        return out
    for path in root.rglob("*"):
        if any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        try:
            if path.is_file() and path.stat().st_mtime >= since - 1:
                out.append(str(path.relative_to(root)))
        except OSError:
            continue
        if len(out) >= limit:
            break
    return out


def _artifact_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".md", ".markdown"}:
        return "markdown"
    if suffix in {".html", ".htm"}:
        return "html"
    if suffix in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return "image"
    if suffix == ".pdf":
        return "pdf"
    if suffix in {".xlsx", ".xls"}:
        return "sheet"
    if suffix in {".pptx", ".ppt", ".pptm", ".docx", ".doc", ".docm"}:
        return "office"
    if suffix in {".csv", ".tsv"}:
        return "csv"
    if suffix in {".py", ".js", ".ts", ".tsx", ".css", ".json"}:
        return "code"
    return "text"


def _redact(raw: dict[str, Any]) -> dict[str, Any]:
    """Copy of a server config safe to return over REST — env/header values masked."""
    out = dict(raw)
    for key in ("env", "headers"):
        if isinstance(out.get(key), dict):
            out[key] = {k: ("***" if v else v) for k, v in out[key].items()}
    return out


def _git_branch(path: Path) -> Optional[str]:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=path,
            capture_output=True,
            text=True,
            timeout=3,
        )
        branch = result.stdout.strip()
        return branch or None
    except (OSError, subprocess.SubprocessError):
        return None
