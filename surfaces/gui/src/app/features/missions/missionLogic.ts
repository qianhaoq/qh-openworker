// Pure logic for the Missions feature: state derivation, list filtering, plan-draft
// editing, and ledger-event humanizing. No React, no API — every function here is
// unit-tested in missionLogic.test.ts.
//
// Backend invariants this mirrors (coworker/orchestrator.py + orchestration/models.py):
// - Mission/task states flow QUEUED→IMPLEMENTING→VERIFYING→REVIEWING→APPROVED→DONE,
//   with CHANGES_REQUESTED/REWORK/BLOCKED/CANCELLED as the sideways exits.
// - Plan members are addressed by seat id ("role:profile_id"); ids must be unique and
//   every depends_on entry must reference a known id; max_rework_rounds is 0..5;
//   confirmation additionally requires at least one executor seat.

import type { IconName } from "../../components/Icon";
import type {
  AgentProfile,
  AgentRole,
  Mission,
  MissionPlan,
  MissionState,
  MissionTimelineEvent,
  PlanMember,
  ReviewFinding,
  TeamArtifact,
  TeamAttempt,
} from "../../lib/api/types";
import { roleMeta } from "../agents/agentLogic";

// ---------------------------------------------------------------------------
// Mission states
// ---------------------------------------------------------------------------

export interface StateMeta {
  label: string;
  /** Badge tint classes (background + text), matching the design tokens. */
  tint: string;
}

export const STATE_META: Record<MissionState, StateMeta> = {
  PLANNING: { label: "规划中", tint: "bg-accentSoft text-accent" },
  AWAITING_CONFIRMATION: { label: "待确认", tint: "bg-warnSoft text-warnInk" },
  QUEUED: { label: "排队中", tint: "bg-accentSoft text-accent" },
  IMPLEMENTING: { label: "实现中", tint: "bg-accentSoft text-accent" },
  VERIFYING: { label: "验证中", tint: "bg-accentSoft text-accent" },
  REVIEWING: { label: "审查中", tint: "bg-accentSoft text-accent" },
  APPROVED: { label: "已通过", tint: "bg-okSoft text-ok" },
  DONE: { label: "已完成", tint: "bg-okSoft text-ok" },
  CHANGES_REQUESTED: { label: "待返修", tint: "bg-warnSoft text-warnInk" },
  REWORK: { label: "返修中", tint: "bg-warnSoft text-warnInk" },
  BLOCKED: { label: "已阻塞", tint: "bg-dangerSoft text-danger" },
  CANCELLED: { label: "已取消", tint: "bg-solid text-muted" },
};

export const stateMeta = (state?: string): StateMeta =>
  STATE_META[state as MissionState] ?? { label: state || "未知", tint: "bg-solid text-muted" };

/** Non-terminal states: the mission is still being worked (or planned). */
export const RUNNING_STATES: ReadonlySet<string> = new Set([
  "PLANNING",
  "QUEUED",
  "IMPLEMENTING",
  "VERIFYING",
  "REVIEWING",
  "CHANGES_REQUESTED",
  "REWORK",
]);

/** States where the mission needs a human decision (mirrors needs_user_action). */
export const ATTENTION_STATES: ReadonlySet<string> = new Set([
  "AWAITING_CONFIRMATION",
  "CHANGES_REQUESTED",
  "BLOCKED",
]);

export const isMissionRunning = (state?: string): boolean => RUNNING_STATES.has(String(state ?? ""));

export const isMissionTerminal = (state?: string): boolean =>
  !isMissionRunning(state) && !ATTENTION_STATES.has(String(state ?? ""));

export const missionNeedsAttention = (mission: Mission): boolean =>
  Boolean(mission.needs_user_action) || ATTENTION_STATES.has(mission.state);

/** Runtime status of a plan seat / attempt ("planned", "running", "completed", …). */
export function memberStatusMeta(status?: string): StateMeta {
  switch (String(status ?? "")) {
    case "running":
    case "active":
      return { label: "进行中", tint: "bg-accentSoft text-accent" };
    case "completed":
    case "done":
      return { label: "已完成", tint: "bg-okSoft text-ok" };
    case "needs_rework":
      return { label: "待返修", tint: "bg-warnSoft text-warnInk" };
    case "failed":
    case "error":
      return { label: "失败", tint: "bg-dangerSoft text-danger" };
    case "cancelled":
      return { label: "已取消", tint: "bg-solid text-muted" };
    case "planned":
      return { label: "待启动", tint: "bg-solid text-muted" };
    default:
      return { label: status || "待启动", tint: "bg-solid text-muted" };
  }
}

// ---------------------------------------------------------------------------
// List filtering / sorting / titles
// ---------------------------------------------------------------------------

export type MissionFilter = "all" | "running" | "attention" | "done" | "cancelled";

export const MISSION_FILTERS: readonly { id: MissionFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "running", label: "进行中" },
  { id: "attention", label: "需关注" },
  { id: "done", label: "已完成" },
  { id: "cancelled", label: "已取消" },
];

export function missionMatchesFilter(mission: Mission, filter: MissionFilter): boolean {
  switch (filter) {
    case "running":
      return isMissionRunning(mission.state);
    case "attention":
      return missionNeedsAttention(mission);
    case "done":
      return mission.state === "DONE" || mission.state === "APPROVED";
    case "cancelled":
      return mission.state === "CANCELLED";
    default:
      return true;
  }
}

export function missionTitle(mission: Mission): string {
  return (
    mission.title ||
    mission.plan?.goal ||
    mission.goal ||
    String(mission.task_spec?.title ?? "") ||
    mission.mission_id
  );
}

/** Newest first, by updated_at falling back to created_at. Returns a new array. */
export function sortMissionsByUpdated(missions: readonly Mission[]): Mission[] {
  return [...missions].sort((left, right) =>
    String(right.updated_at ?? right.created_at ?? "").localeCompare(
      String(left.updated_at ?? left.created_at ?? ""),
    ),
  );
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/** "08-01 14:32" in zh-CN; unparseable input passes through, empty input → "刚刚". */
export function formatTime(value?: string | number | null): string {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Human span between two ISO timestamps: "45 秒" / "12 分钟" / "2 小时 5 分". */
export function formatDuration(startIso?: string | null, endIso?: string | null): string {
  if (!startIso || !endIso) return "";
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

// ---------------------------------------------------------------------------
// Team panel helpers (attempts / artifacts / reviews per member)
// ---------------------------------------------------------------------------

/** Every attempt a plan member has had (rework rounds included), oldest first. */
export function attemptsForMember(mission: Mission, member: PlanMember): TeamAttempt[] {
  return mission.attempts.filter(
    (attempt) =>
      attempt.id === member.attempt_id ||
      (attempt.agent_profile_id === member.profile_id && attempt.role === member.role),
  );
}

/** Artifacts produced by one attempt; artifacts with no attempt_id are mission-level. */
export function artifactsForAttempt(mission: Mission, attemptId: string | null): TeamArtifact[] {
  if (!attemptId) return mission.artifacts;
  const own = mission.artifacts.filter((artifact) => artifact.attempt_id === attemptId);
  return own.length ? own : mission.artifacts.filter((artifact) => !artifact.attempt_id);
}

export function artifactIcon(kind: string): IconName {
  if (kind === "image" || kind === "screenshot") return "image";
  if (kind === "code" || kind === "diff") return "fileCode";
  return "file";
}

/** Short display name for an artifact: its metadata title/name, else the uri tail. */
export function artifactName(artifact: TeamArtifact): string {
  const meta = artifact.metadata ?? {};
  const titled = meta.title ?? meta.name;
  if (typeof titled === "string" && titled.trim()) return titled.trim();
  const uri = String(artifact.uri ?? "");
  return uri.split("/").pop() || uri || artifact.id;
}

/**
 * The previewable text of an artifact: an inline content field, or the first sizable
 * string payload in metadata (diff/report/log bodies ride there). Null = no preview.
 */
export function artifactPreviewText(artifact: TeamArtifact): string | null {
  if (typeof artifact.content === "string" && artifact.content.trim()) return artifact.content;
  const meta = artifact.metadata ?? {};
  for (const key of ["content", "text", "diff", "report", "log", "body", "summary"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export interface VerdictMeta {
  label: string;
  tint: string;
}

export function reviewVerdictMeta(verdict?: string): VerdictMeta {
  switch (verdict) {
    case "pass":
      return { label: "通过", tint: "bg-okSoft text-ok" };
    case "request_changes":
      return { label: "要求返修", tint: "bg-warnSoft text-warnInk" };
    case "block":
      return { label: "阻止交付", tint: "bg-dangerSoft text-danger" };
    default:
      return { label: verdict || "未知", tint: "bg-solid text-muted" };
  }
}

export function severityMeta(severity?: string): VerdictMeta {
  switch (String(severity ?? "").toLowerCase()) {
    case "critical":
    case "high":
    case "blocker":
      return { label: "严重", tint: "bg-dangerSoft text-danger" };
    case "medium":
    case "major":
      return { label: "中等", tint: "bg-warnSoft text-warnInk" };
    default:
      return { label: severity ? severityMetaLabel(severity) : "提示", tint: "bg-solid text-muted" };
  }
}

const severityMetaLabel = (severity: string): string =>
  severity === "low" || severity === "minor" ? "轻微" : severity;

/** Where a finding points: "path:line", "path", or "" when it is file-less. */
export function findingLocation(finding: ReviewFinding): string {
  const path = String(finding.path ?? "");
  if (!path) return "";
  return finding.line != null ? `${path}:${finding.line}` : path;
}

// ---------------------------------------------------------------------------
// Plan editing model
// ---------------------------------------------------------------------------

export interface PlanMemberDraft {
  /** Stable React key for the row (survives seat-id recomputation). */
  key: string;
  /** Seat id ("role:profile_id") — recomputed when role/profile change. */
  id: string;
  role: AgentRole;
  profileId: string;
  objective: string;
  dependsOn: string[];
}

export interface PlanDraft {
  goal: string;
  maxReworkRounds: number;
  members: PlanMemberDraft[];
}

export const memberSeatId = (role: string, profileId: string): string => `${role}:${profileId}`;

let draftKeyCounter = 0;
const nextDraftKey = (): string => `member-${(draftKeyCounter += 1)}`;

export function planDraftFromPlan(plan: MissionPlan): PlanDraft {
  return {
    goal: plan.goal ?? "",
    maxReworkRounds: plan.max_rework_rounds ?? 2,
    members: (plan.members ?? []).map((member) => ({
      key: nextDraftKey(),
      id: member.id || memberSeatId(member.role, member.profile_id),
      role: member.role,
      profileId: member.profile_id ?? "",
      objective: member.objective ?? "",
      dependsOn: [...(member.depends_on ?? member.dependencies ?? [])],
    })),
  };
}

/** Patch one member. Role/profile changes recompute the seat id and rewrite every
 * depends_on entry that referenced the old id, so the draft never dangles. */
export function updatePlanMember(
  draft: PlanDraft,
  key: string,
  patch: Partial<Pick<PlanMemberDraft, "role" | "profileId" | "objective" | "dependsOn">>,
): PlanDraft {
  const members = draft.members.map((member) => {
    if (member.key !== key) return member;
    const next = { ...member, ...patch };
    next.id = memberSeatId(next.role, next.profileId);
    return next;
  });
  const renamed = new Map<string, string>();
  draft.members.forEach((member, index) => {
    if (member.key === key && members[index].id !== member.id) {
      renamed.set(member.id, members[index].id);
    }
  });
  if (renamed.size === 0) return { ...draft, members };
  return {
    ...draft,
    members: members.map((member) => ({
      ...member,
      dependsOn: member.dependsOn.map((dep) => renamed.get(dep) ?? dep),
    })),
  };
}

/** Drop one member and scrub its id from every remaining depends_on list. */
export function removePlanMember(draft: PlanDraft, key: string): PlanDraft {
  const removed = draft.members.find((member) => member.key === key);
  if (!removed) return draft;
  return {
    ...draft,
    members: draft.members
      .filter((member) => member.key !== key)
      .map((member) => ({
        ...member,
        dependsOn: member.dependsOn.filter((dep) => dep !== removed.id),
      })),
  };
}

/**
 * Append a seat for `role`: the first enabled profile of that role whose seat id is
 * free (mirrors the backend's default-team preference for enabled profiles). A new
 * reviewer seat depends on the first executor seat, as the control plane does.
 * Returns the draft unchanged when no free profile exists for the role.
 */
export function addPlanMember(
  draft: PlanDraft,
  role: AgentRole,
  profiles: readonly AgentProfile[],
): PlanDraft {
  const taken = new Set(draft.members.map((member) => member.id));
  const candidates = profiles.filter((profile) => profile.role === role);
  const profile =
    candidates.find((item) => item.enabled && !taken.has(memberSeatId(role, item.id))) ??
    candidates.find((item) => !taken.has(memberSeatId(role, item.id)));
  if (!profile) return draft;
  const id = memberSeatId(role, profile.id);
  const executor = draft.members.find((member) => member.role === "executor");
  const dependsOn = role === "reviewer" && executor ? [executor.id] : [];
  return {
    ...draft,
    members: [
      ...draft.members,
      {
        key: nextDraftKey(),
        id,
        role,
        profileId: profile.id,
        objective: roleMeta(role).description,
        dependsOn,
      },
    ],
  };
}

/** Whether a role could still gain a seat (an untaken profile exists for it). */
export function canAddMemberRole(
  draft: PlanDraft,
  role: AgentRole,
  profiles: readonly AgentProfile[],
): boolean {
  return addPlanMember(draft, role, profiles).members.length > draft.members.length;
}

/** Client-side mirror of MissionPlan.validate(); returns the first error or null. */
export function validatePlanDraft(draft: PlanDraft): string | null {
  if (!draft.goal.trim()) return "计划目标不能为空";
  if (draft.members.length === 0) return "计划至少需要一个成员席位";
  const seen = new Set<string>();
  for (const member of draft.members) {
    if (!member.profileId.trim()) return `成员 ${member.id || member.role} 缺少 Agent profile`;
    if (seen.has(member.id)) return `成员席位重复：${member.id}`;
    seen.add(member.id);
  }
  for (const member of draft.members) {
    const missing = member.dependsOn.filter((dep) => !seen.has(dep));
    if (missing.length) return `成员 ${member.id} 依赖了不存在的席位：${missing.join("、")}`;
  }
  if (draft.maxReworkRounds < 0 || draft.maxReworkRounds > 5) return "返修轮数需在 0–5 之间";
  return null;
}

/** Confirmation additionally requires an executor seat (backend-enforced). */
export const planDraftHasExecutor = (draft: PlanDraft): boolean =>
  draft.members.some((member) => member.role === "executor");

/** Serialize the draft into the plan payload for PATCH /v1/missions/{id}/plan. The
 * server merges it over the stored plan and bumps the version itself. */
export function planDraftToPlan(draft: PlanDraft, base: MissionPlan | null): MissionPlan {
  return {
    version: base?.version ?? 1,
    status: "proposed",
    goal: draft.goal.trim(),
    ...(base?.summary ? { summary: base.summary } : {}),
    members: draft.members.map((member) => ({
      id: member.id,
      seat_id: member.id,
      role: member.role,
      profile_id: member.profileId.trim(),
      objective: member.objective.trim(),
      depends_on: [...member.dependsOn],
      dependencies: [...member.dependsOn],
      status: "planned",
    })),
    max_rework_rounds: draft.maxReworkRounds,
    ...(base?.created_at ? { created_at: base.created_at } : {}),
    ...(base?.updated_at ? { updated_at: base.updated_at } : {}),
  };
}

/** Parse a comma/space-separated depends_on edit field, dropping blanks and dupes. */
export function parseDependsOnInput(text: string): string[] {
  const out: string[] = [];
  for (const item of text.split(/[\s,]+/)) {
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

export const formatDependsOnInput = (dependsOn: readonly string[]): string => dependsOn.join(", ");

// ---------------------------------------------------------------------------
// Ledger event humanizing
// ---------------------------------------------------------------------------

export interface HumanizedEvent {
  icon: IconName;
  title: string;
  detail: string;
  /** Seat reference for member-scoped events ("执行 · opencode-executor"). */
  member?: string;
}

const shortText = (value: unknown, fallback: string): string => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return fallback;
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const memberTag = (member: Record<string, unknown>): string | undefined => {
  const role = String(member.role ?? "");
  const profile = String(member.agent_profile_id ?? member.profile_id ?? "");
  if (!role && !profile) return undefined;
  return profile ? `${roleMeta(role).label} · ${profile}` : roleMeta(role).label;
};

/** One Chinese line (+ icon) per ledger event type, for the mission timeline. */
export function humanizeMissionEvent(event: MissionTimelineEvent): HumanizedEvent {
  const payload = asRecord(event.payload);
  const member = asRecord(payload.member);
  const artifact = asRecord(payload.artifact);
  const plan = asRecord(payload.plan);
  const review = asRecord(payload.review);

  switch (event.event_type) {
    case "mission.created":
      return { icon: "missions", title: "任务已创建", detail: "目标已写入本地 ledger，等待主 Agent 规划。" };
    case "mission.plan_proposed": {
      const members = Array.isArray(plan.members)
        ? plan.members.length
        : Number(payload.members || 0);
      const source = payload.source === "control_plane_fallback" ? "控制面兜底" : "主 Agent";
      return {
        icon: "sparkle",
        title: "团队计划已提出",
        detail: `${source}给出 ${members || "多"} 个 Agent 席位；确认前不会启动写入型执行。`,
      };
    }
    case "mission.plan_updated":
      return {
        icon: "pencil",
        title: "团队计划已调整",
        detail: `计划更新为第 ${plan.version || payload.version || "新"} 版，等待再次确认。`,
      };
    case "mission.plan_confirmed":
      return { icon: "check", title: "计划已确认", detail: "任务进入排队与执行阶段。" };
    case "task.transition": {
      const next = String(payload.to || payload.status || payload.state || "");
      const meta = stateMeta(next);
      return { icon: "clock", title: `任务进入「${meta.label}」`, detail: "状态变更已写入 ledger，断线后可继续重放。" };
    }
    case "task.delegated":
      return {
        icon: "agents",
        title: "任务已委派",
        detail: shortText(payload.target_profile_id, "已指定目标 Agent。"),
      };
    case "mission.member_updated": {
      const status = String(member.status || payload.status || "已更新");
      return {
        icon: "agents",
        title: `${roleMeta(String(member.role ?? "")).label} 状态更新`,
        detail: `当前状态：${status}`,
        member: memberTag(member),
      };
    }
    case "mission.artifact_added":
      return {
        icon: artifactIcon(String(artifact.kind ?? "")),
        title: "新增交付工件",
        detail: shortText(
          artifact.title ?? asRecord(artifact.metadata).title ?? artifact.name ?? artifact.uri ?? artifact.kind,
          "代码、日志或测试结果已归档。",
        ),
      };
    case "review.requested":
      return { icon: "shield", title: "已请求只读审查", detail: "Reviewer 将检查固定工件与测试结果，不获得写权限。" };
    case "mission.review_updated": {
      const verdict = String(review.verdict ?? "");
      const findings = Array.isArray(review.findings) ? review.findings.length : 0;
      return {
        icon: verdict === "pass" ? "check" : "alert",
        title: verdict === "pass" ? "审查已通过" : verdict === "block" ? "审查阻止交付" : "审查要求返修",
        detail: `${findings} 条 findings 已结构化归档。`,
      };
    }
    case "permission.required":
      return {
        icon: "shield",
        title: "等待权限审批",
        detail: shortText(payload.reason ?? payload.tool_name, "Agent 请求执行受控操作。"),
      };
    case "permission.resolved":
      return {
        icon: payload.decision === "deny" ? "close" : "check",
        title: "权限请求已处理",
        detail: `决策：${payload.decision || "已完成"}`,
      };
    case "mission.message_enqueued":
    case "agent.message.enqueued":
      return {
        icon: "send",
        title: "消息已排队",
        detail: shortText(payload.message, "将在目标 Agent 当前回合结束后投递。"),
      };
    case "agent.message.delivered":
      return { icon: "check", title: "消息已投递", detail: "目标 Agent 的会话已继续执行。" };
    case "main.delivery.enqueued":
      return { icon: "send", title: "结果已发回主 Agent", detail: "交付摘要已排队，等待主 Agent 会话处理。" };
    case "main.delivery.delivered":
      return { icon: "check", title: "主 Agent 已接收交付", detail: "执行结果已送达主 Agent 会话。" };
    case "mission.completed":
      return { icon: "check", title: "任务已完成", detail: "实现、验证和审查闭环已经收敛。" };
    default:
      return {
        icon: "file",
        title: event.event_type.split(".").join(" · "),
        detail: shortText(payload.message ?? payload.summary, "事件已写入任务 ledger。"),
      };
  }
}
