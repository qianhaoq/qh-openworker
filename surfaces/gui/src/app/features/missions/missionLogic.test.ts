import { describe, expect, it } from "vitest";
import type {
  AgentProfile,
  Mission,
  MissionPlan,
  MissionTimelineEvent,
  PlanMember,
  TeamArtifact,
  TeamAttempt,
} from "../../lib/api/types";
import {
  addPlanMember,
  artifactIcon,
  artifactName,
  artifactPreviewText,
  artifactsForAttempt,
  attemptsForMember,
  canAddMemberRole,
  findingLocation,
  formatDependsOnInput,
  formatDuration,
  formatTime,
  humanizeMissionEvent,
  isMissionRunning,
  isMissionTerminal,
  memberStatusMeta,
  missionMatchesFilter,
  missionNeedsAttention,
  missionPlanningErrorText,
  missionTitle,
  parseDependsOnInput,
  planDraftFromPlan,
  planDraftHasExecutor,
  planDraftToPlan,
  removePlanMember,
  reviewVerdictMeta,
  severityMeta,
  sortMissionsByUpdated,
  stateMeta,
  updatePlanMember,
  validateMissionWorkspace,
  validatePlanDraft,
  type PlanDraft,
} from "./missionLogic";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeMission = (partial: Partial<Mission>): Mission =>
  ({
    mission_id: "m-1",
    task_id: "m-1",
    id: "m-1",
    state: "QUEUED",
    status: "QUEUED",
    title: "",
    goal: "修复登录页",
    members: [],
    attempts: [],
    artifacts: [],
    reviews: [],
    messages: [],
    timeline: [],
    permissions: [],
    needs_user_action: false,
    ...partial,
  }) as Mission;

const makeMember = (partial: Partial<PlanMember>): PlanMember =>
  ({
    id: "executor:opencode-executor",
    seat_id: "executor:opencode-executor",
    role: "executor",
    profile_id: "opencode-executor",
    objective: "实现修改",
    depends_on: [],
    dependencies: [],
    ...partial,
  }) as PlanMember;

const makePlan = (partial: Partial<MissionPlan>): MissionPlan =>
  ({
    version: 1,
    status: "proposed",
    goal: "  修复登录页  ",
    members: [makeMember({})],
    max_rework_rounds: 2,
    ...partial,
  }) as MissionPlan;

const makeAttempt = (partial: Partial<TeamAttempt>): TeamAttempt =>
  ({
    id: "attempt-1",
    task_id: "m-1",
    agent_profile_id: "opencode-executor",
    role: "executor",
    status: "running",
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:05:00Z",
    ...partial,
  }) as TeamAttempt;

const makeProfile = (id: string, role: AgentProfile["role"], enabled = true): AgentProfile =>
  ({
    id,
    role,
    transport: "acp_stdio",
    command: "agent",
    args: ["acp"],
    workspace_policy: "worktree",
    permission_policy: "coding-default",
    secret_refs: [],
    limits: {},
    enabled,
    capabilities: {},
  }) as AgentProfile;

const makeEvent = (event_type: string, payload: Record<string, unknown> = {}): MissionTimelineEvent => ({
  event_id: `e-${event_type}`,
  event_type,
  payload,
  created_at: "2026-08-01T10:00:00Z",
});

// ---------------------------------------------------------------------------
// States / filters
// ---------------------------------------------------------------------------

describe("stateMeta", () => {
  it("labels every known state and falls back for unknown ones", () => {
    expect(stateMeta("AWAITING_CONFIRMATION").label).toBe("待确认");
    expect(stateMeta("IMPLEMENTING").label).toBe("实现中");
    expect(stateMeta("CANCELLED").label).toBe("已取消");
    expect(stateMeta("WEIRD").label).toBe("WEIRD");
    expect(stateMeta(undefined).label).toBe("未知");
  });
});

describe("state groups", () => {
  it("running covers the active pipeline states", () => {
    for (const state of ["PLANNING", "QUEUED", "IMPLEMENTING", "VERIFYING", "REVIEWING", "REWORK"]) {
      expect(isMissionRunning(state)).toBe(true);
      expect(isMissionTerminal(state)).toBe(false);
    }
  });

  it("attention states are neither running nor terminal", () => {
    expect(isMissionRunning("AWAITING_CONFIRMATION")).toBe(false);
    expect(isMissionTerminal("AWAITING_CONFIRMATION")).toBe(false);
    expect(isMissionTerminal("BLOCKED")).toBe(false);
  });

  it("done/cancelled are terminal", () => {
    for (const state of ["DONE", "APPROVED", "CANCELLED"]) {
      expect(isMissionTerminal(state)).toBe(true);
    }
  });

  it("missionNeedsAttention honors the server flag and the attention states", () => {
    expect(missionNeedsAttention(makeMission({ needs_user_action: true }))).toBe(true);
    expect(missionNeedsAttention(makeMission({ state: "AWAITING_CONFIRMATION" }))).toBe(true);
    expect(missionNeedsAttention(makeMission({ state: "BLOCKED" }))).toBe(true);
    expect(missionNeedsAttention(makeMission({ state: "IMPLEMENTING" }))).toBe(false);
  });
});

describe("missionMatchesFilter", () => {
  const running = makeMission({ state: "IMPLEMENTING" });
  const awaiting = makeMission({ state: "AWAITING_CONFIRMATION", needs_user_action: true });
  const done = makeMission({ state: "DONE" });
  const cancelled = makeMission({ state: "CANCELLED" });

  it("all matches everything", () => {
    for (const mission of [running, awaiting, done, cancelled]) {
      expect(missionMatchesFilter(mission, "all")).toBe(true);
    }
  });

  it("running/attention/done/cancelled partition the states", () => {
    expect(missionMatchesFilter(running, "running")).toBe(true);
    expect(missionMatchesFilter(running, "attention")).toBe(false);
    expect(missionMatchesFilter(awaiting, "attention")).toBe(true);
    expect(missionMatchesFilter(awaiting, "running")).toBe(false);
    expect(missionMatchesFilter(done, "done")).toBe(true);
    expect(missionMatchesFilter(makeMission({ state: "APPROVED" }), "done")).toBe(true);
    expect(missionMatchesFilter(done, "cancelled")).toBe(false);
    expect(missionMatchesFilter(cancelled, "cancelled")).toBe(true);
    expect(missionMatchesFilter(cancelled, "done")).toBe(false);
  });
});

describe("missionTitle", () => {
  it("prefers title, then plan goal, then goal, then the id", () => {
    expect(missionTitle(makeMission({ title: "标题" }))).toBe("标题");
    expect(missionTitle(makeMission({ plan: makePlan({ goal: "计划目标" }) }))).toBe("计划目标");
    expect(missionTitle(makeMission({ goal: "裸目标" }))).toBe("裸目标");
    expect(missionTitle(makeMission({ goal: "", mission_id: "m-9" }))).toBe("m-9");
  });
});

describe("mission planning contracts", () => {
  it("renders a safe planning error summary", () => {
    expect(missionPlanningErrorText(makeMission({ planning_error: null }))).toBeNull();
    expect(
      missionPlanningErrorText(
        makeMission({
          planning_error: {
            code: "ACP_PROFILE_UNUSABLE",
            message: "主 Agent profile 不可用",
            retryable: true,
          },
        }),
      ),
    ).toBe("规划失败：主 Agent profile 不可用");
  });

  it("requires a workspace before creating a mission", () => {
    expect(validateMissionWorkspace("")).toBe("请选择 workspace");
    expect(validateMissionWorkspace("  ")).toBe("请选择 workspace");
    expect(validateMissionWorkspace("/repo")).toBeNull();
  });
});

describe("sortMissionsByUpdated", () => {
  it("orders newest first without mutating the input", () => {
    const old = makeMission({ mission_id: "old", updated_at: "2026-08-01T09:00:00Z" });
    const fresh = makeMission({ mission_id: "fresh", updated_at: "2026-08-01T11:00:00Z" });
    const input = [old, fresh];
    const sorted = sortMissionsByUpdated(input);
    expect(sorted.map((m) => m.mission_id)).toEqual(["fresh", "old"]);
    expect(input[0].mission_id).toBe("old");
  });
});

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

describe("formatTime", () => {
  it("handles empty, invalid, and real timestamps", () => {
    expect(formatTime(null)).toBe("刚刚");
    expect(formatTime("not-a-date")).toBe("not-a-date");
    expect(formatTime("2026-08-01T10:00:00Z")).toMatch(/\d{2}[/\-.]\d{2}/);
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration("2026-08-01T10:00:00Z", "2026-08-01T10:00:45Z")).toBe("45 秒");
    expect(formatDuration("2026-08-01T10:00:00Z", "2026-08-01T10:12:00Z")).toBe("12 分钟");
    expect(formatDuration("2026-08-01T10:00:00Z", "2026-08-01T12:05:00Z")).toBe("2 小时 5 分");
  });

  it("returns empty for missing or inverted input", () => {
    expect(formatDuration(null, "2026-08-01T10:00:00Z")).toBe("");
    expect(formatDuration("2026-08-01T11:00:00Z", "2026-08-01T10:00:00Z")).toBe("");
    expect(formatDuration("junk", "also-junk")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Team helpers
// ---------------------------------------------------------------------------

describe("memberStatusMeta", () => {
  it("maps runtime statuses and falls back to 待启动", () => {
    expect(memberStatusMeta("running").label).toBe("进行中");
    expect(memberStatusMeta("needs_rework").label).toBe("待返修");
    expect(memberStatusMeta("planned").label).toBe("待启动");
    expect(memberStatusMeta(undefined).label).toBe("待启动");
    expect(memberStatusMeta("custom-state").label).toBe("custom-state");
  });
});

describe("attemptsForMember", () => {
  it("collects every attempt of the seat (rework rounds included), by id or profile+role", () => {
    const first = makeAttempt({ id: "a-1", rework_round: 0 });
    const second = makeAttempt({ id: "a-2", rework_round: 1 });
    const other = makeAttempt({ id: "a-3", agent_profile_id: "kimi-reviewer", role: "reviewer" });
    const mission = makeMission({ attempts: [first, second, other] });
    const member = makeMember({ attempt_id: "a-2" });
    expect(attemptsForMember(mission, member).map((a) => a.id)).toEqual(["a-1", "a-2"]);
  });
});

describe("artifactsForAttempt", () => {
  const own = { id: "art-1", task_id: "m-1", attempt_id: "a-1", kind: "diff" } as TeamArtifact;
  const shared = { id: "art-2", task_id: "m-1", attempt_id: null, kind: "log" } as TeamArtifact;
  const foreign = { id: "art-3", task_id: "m-1", attempt_id: "a-9", kind: "diff" } as TeamArtifact;
  const mission = makeMission({ artifacts: [own, shared, foreign] });

  it("returns the attempt's own artifacts when it has any", () => {
    expect(artifactsForAttempt(mission, "a-1").map((a) => a.id)).toEqual(["art-1"]);
  });

  it("falls back to mission-level artifacts, and returns all for a null attempt", () => {
    expect(artifactsForAttempt(mission, "a-2").map((a) => a.id)).toEqual(["art-2"]);
    expect(artifactsForAttempt(mission, null)).toHaveLength(3);
  });
});

const makeArtifact = (partial: Partial<TeamArtifact>): TeamArtifact =>
  ({
    id: "art-0",
    task_id: "m-1",
    kind: "file",
    ...partial,
  }) as TeamArtifact;

describe("artifact display helpers", () => {
  it("artifactIcon maps kinds onto the file icon family", () => {
    expect(artifactIcon("screenshot")).toBe("image");
    expect(artifactIcon("diff")).toBe("fileCode");
    expect(artifactIcon("log")).toBe("file");
  });

  it("artifactName prefers metadata title, then the uri tail", () => {
    expect(artifactName(makeArtifact({ metadata: { title: "测试报告" }, kind: "report" }))).toBe("测试报告");
    expect(artifactName(makeArtifact({ uri: "artifact://m-1/diff.patch", kind: "diff" }))).toBe("diff.patch");
  });

  it("artifactPreviewText reads inline content, then metadata payloads", () => {
    expect(artifactPreviewText(makeArtifact({ content: "  正文  ", kind: "markdown" }))).toBe("  正文  ");
    expect(artifactPreviewText(makeArtifact({ metadata: { diff: "--- a/x\n+++ b/x" }, kind: "diff" }))).toBe(
      "--- a/x\n+++ b/x",
    );
    expect(artifactPreviewText(makeArtifact({ metadata: { size: 3 }, kind: "diff" }))).toBeNull();
  });
});

describe("review helpers", () => {
  it("reviewVerdictMeta covers pass/request_changes/block and unknown", () => {
    expect(reviewVerdictMeta("pass").label).toBe("通过");
    expect(reviewVerdictMeta("request_changes").label).toBe("要求返修");
    expect(reviewVerdictMeta("block").label).toBe("阻止交付");
    expect(reviewVerdictMeta("custom").label).toBe("custom");
  });

  it("severityMeta buckets severities into 严重/中等/轻微/提示", () => {
    expect(severityMeta("critical").label).toBe("严重");
    expect(severityMeta("high").label).toBe("严重");
    expect(severityMeta("medium").label).toBe("中等");
    expect(severityMeta("low").label).toBe("轻微");
    expect(severityMeta(undefined).label).toBe("提示");
  });

  it("findingLocation joins path and line", () => {
    expect(findingLocation({ path: "src/a.ts", line: 42 })).toBe("src/a.ts:42");
    expect(findingLocation({ path: "src/a.ts", line: null })).toBe("src/a.ts");
    expect(findingLocation({})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Plan editing model
// ---------------------------------------------------------------------------

describe("planDraftFromPlan", () => {
  it("copies goal/rework/members into an editable draft", () => {
    const draft = planDraftFromPlan(
      makePlan({
        goal: "目标",
        max_rework_rounds: 3,
        members: [makeMember({ depends_on: ["main:kimi-main"], dependencies: ["main:kimi-main"] })],
      }),
    );
    expect(draft.goal).toBe("目标");
    expect(draft.maxReworkRounds).toBe(3);
    expect(draft.members).toHaveLength(1);
    expect(draft.members[0].dependsOn).toEqual(["main:kimi-main"]);
  });
});

describe("updatePlanMember", () => {
  it("recomputes the seat id and rewrites depends_on references", () => {
    const base = planDraftFromPlan(
      makePlan({
        members: [
          makeMember({ id: "main:kimi-main", seat_id: "main:kimi-main", role: "main", profile_id: "kimi-main" }),
          makeMember({ depends_on: ["main:kimi-main"], dependencies: ["main:kimi-main"] }),
        ],
      }),
    );
    const mainKey = base.members[0].key;
    const next = updatePlanMember(base, mainKey, { profileId: "kimi-main-2" });
    expect(next.members[0].id).toBe("main:kimi-main-2");
    expect(next.members[1].dependsOn).toEqual(["main:kimi-main-2"]);
  });

  it("leaves ids alone when only the objective changes", () => {
    const base = planDraftFromPlan(makePlan({}));
    const next = updatePlanMember(base, base.members[0].key, { objective: "新职责" });
    expect(next.members[0].objective).toBe("新职责");
    expect(next.members[0].id).toBe("executor:opencode-executor");
  });
});

describe("removePlanMember", () => {
  it("drops the seat and scrubs dangling dependencies", () => {
    const base = planDraftFromPlan(
      makePlan({
        members: [
          makeMember({}),
          makeMember({
            id: "reviewer:opencode-reviewer",
            seat_id: "reviewer:opencode-reviewer",
            role: "reviewer",
            profile_id: "opencode-reviewer",
            depends_on: ["executor:opencode-executor"],
            dependencies: ["executor:opencode-executor"],
          }),
        ],
      }),
    );
    const next = removePlanMember(base, base.members[0].key);
    expect(next.members).toHaveLength(1);
    expect(next.members[0].dependsOn).toEqual([]);
  });

  it("is a no-op for an unknown key", () => {
    const base = planDraftFromPlan(makePlan({}));
    expect(removePlanMember(base, "missing")).toBe(base);
  });
});

describe("addPlanMember", () => {
  const profiles = [
    makeProfile("kimi-main", "main"),
    makeProfile("opencode-executor", "executor"),
    makeProfile("opencode-reviewer", "reviewer", false),
    makeProfile("kimi-reviewer", "reviewer"),
  ];

  it("picks the first enabled profile with a free seat", () => {
    const draft = planDraftFromPlan(makePlan({}));
    const next = addPlanMember(draft, "reviewer", profiles);
    expect(next.members).toHaveLength(2);
    // opencode-reviewer is disabled, so the enabled kimi-reviewer wins.
    expect(next.members[1].profileId).toBe("kimi-reviewer");
  });

  it("a new reviewer seat depends on the first executor seat", () => {
    const draft = planDraftFromPlan(makePlan({}));
    const next = addPlanMember(draft, "reviewer", profiles);
    expect(next.members[1].dependsOn).toEqual(["executor:opencode-executor"]);
  });

  it("returns the draft unchanged when no free profile exists for the role", () => {
    const draft = planDraftFromPlan(
      makePlan({
        members: [makeMember({ id: "main:kimi-main", seat_id: "main:kimi-main", role: "main", profile_id: "kimi-main" })],
      }),
    );
    const next = addPlanMember(draft, "main", profiles);
    expect(next.members).toHaveLength(1);
    expect(canAddMemberRole(draft, "main", profiles)).toBe(false);
    expect(canAddMemberRole(draft, "reviewer", profiles)).toBe(true);
  });
});

describe("validatePlanDraft", () => {
  const validDraft = (): PlanDraft => ({
    goal: "修复登录页",
    maxReworkRounds: 2,
    members: [
      { key: "a", id: "main:kimi-main", role: "main", profileId: "kimi-main", objective: "协调", dependsOn: [] },
      {
        key: "b",
        id: "executor:opencode-executor",
        role: "executor",
        profileId: "opencode-executor",
        objective: "实现",
        dependsOn: ["main:kimi-main"],
      },
    ],
  });

  it("accepts a well-formed draft", () => {
    expect(validatePlanDraft(validDraft())).toBeNull();
    expect(planDraftHasExecutor(validDraft())).toBe(true);
  });

  it("rejects empty goals and empty teams", () => {
    expect(validatePlanDraft({ ...validDraft(), goal: "  " })).toContain("目标");
    expect(validatePlanDraft({ ...validDraft(), members: [] })).toContain("席位");
  });

  it("rejects duplicate seat ids and dangling dependencies", () => {
    const dup = validDraft();
    dup.members[1] = { ...dup.members[1], id: "main:kimi-main" };
    expect(validatePlanDraft(dup)).toContain("重复");
    const dangling = validDraft();
    dangling.members[1] = { ...dangling.members[1], dependsOn: ["explorer:nobody"] };
    expect(validatePlanDraft(dangling)).toContain("不存在的席位");
  });

  it("rejects missing profiles and out-of-range rework rounds", () => {
    const noProfile = validDraft();
    noProfile.members[0] = { ...noProfile.members[0], profileId: " " };
    expect(validatePlanDraft(noProfile)).toContain("profile");
    expect(validatePlanDraft({ ...validDraft(), maxReworkRounds: 6 })).toContain("0–5");
  });
});

describe("planDraftToPlan", () => {
  it("serializes members with mirrored seat/dependency fields and trims strings", () => {
    const draft: PlanDraft = {
      goal: "  目标  ",
      maxReworkRounds: 1,
      members: [
        {
          key: "a",
          id: "executor:opencode-executor",
          role: "executor",
          profileId: " opencode-executor ",
          objective: "  实现  ",
          dependsOn: ["main:kimi-main"],
        },
      ],
    };
    const plan = planDraftToPlan(draft, makePlan({ version: 2 }));
    expect(plan.version).toBe(2);
    expect(plan.status).toBe("proposed");
    expect(plan.goal).toBe("目标");
    expect(plan.max_rework_rounds).toBe(1);
    const member = plan.members[0];
    expect(member.seat_id).toBe("executor:opencode-executor");
    expect(member.profile_id).toBe("opencode-executor");
    expect(member.objective).toBe("实现");
    expect(member.depends_on).toEqual(["main:kimi-main"]);
    expect(member.dependencies).toEqual(["main:kimi-main"]);
  });
});

describe("depends_on edit-field parsing", () => {
  it("splits on commas/whitespace, dropping blanks and duplicates", () => {
    expect(parseDependsOnInput("main:kimi, executor:opencode\nmain:kimi")).toEqual([
      "main:kimi",
      "executor:opencode",
    ]);
    expect(parseDependsOnInput("")).toEqual([]);
  });

  it("round-trips through the formatter", () => {
    expect(parseDependsOnInput(formatDependsOnInput(["a", "b"]))).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Event humanizing
// ---------------------------------------------------------------------------

describe("humanizeMissionEvent", () => {
  it("renders plan proposals with source and member count", () => {
    const line = humanizeMissionEvent(
      makeEvent("mission.plan_proposed", {
        source: "control_plane_fallback",
        plan: { members: [{}, {}, {}] },
      }),
    );
    expect(line.title).toBe("团队计划已提出");
    expect(line.detail).toContain("控制面兜底");
    expect(line.detail).toContain("3");
  });

  it("marks review verdicts", () => {
    const pass = humanizeMissionEvent(makeEvent("mission.review_updated", { review: { verdict: "pass", findings: [] } }));
    expect(pass.title).toBe("审查已通过");
    const changes = humanizeMissionEvent(
      makeEvent("mission.review_updated", { review: { verdict: "request_changes", findings: [{}, {}] } }),
    );
    expect(changes.title).toBe("审查要求返修");
    expect(changes.detail).toContain("2");
  });

  it("tags member events with the seat reference", () => {
    const line = humanizeMissionEvent(
      makeEvent("mission.member_updated", {
        member: { role: "executor", agent_profile_id: "opencode-executor", status: "running" },
      }),
    );
    expect(line.member).toBe("执行 · opencode-executor");
    expect(line.detail).toContain("running");
  });

  it("humanizes task transitions with the target state label", () => {
    const line = humanizeMissionEvent(makeEvent("task.transition", { from: "QUEUED", to: "IMPLEMENTING" }));
    expect(line.title).toContain("实现中");
  });

  it("falls back to the raw event type for unknown events", () => {
    const line = humanizeMissionEvent(makeEvent("custom.thing", { message: "发生了一些事" }));
    expect(line.title).toBe("custom · thing");
    expect(line.detail).toBe("发生了一些事");
  });

  it("truncates long payload text", () => {
    const line = humanizeMissionEvent(makeEvent("mission.message_enqueued", { message: "长".repeat(200) }));
    expect(line.detail.length).toBeLessThanOrEqual(120);
  });
});
