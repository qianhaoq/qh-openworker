// Missions (structured multi-agent runs) + the team task endpoints they build on.
// Routes verified against coworker/server/app.py:1472-1634.

import { api } from "./client";
import type {
  MessageTarget,
  Mission,
  MissionCreateInput,
  MissionEventsPage,
  MissionPlan,
  MissionState,
  TeamArtifact,
  TeamAttempt,
  TeamReview,
  TeamTask,
  TeamTaskResult,
} from "./types";

// The backend serves the get_mission projection directly (orchestrator.get_mission), but
// older payloads wrap it ({mission: …}) or hand back a bare Task aggregate — normalize to
// one Mission view so consumers never care.
function missionFromResponse(value: any): Mission {
  const mission = value?.mission ?? value ?? {};
  const taskSpec = mission.task_spec ?? {};
  const plan = mission.plan ?? taskSpec.plan ?? null;
  const attempts = Array.isArray(mission.attempts) ? mission.attempts : [];
  const members = Array.isArray(mission.members)
    ? mission.members
    : Array.isArray(plan?.members)
      ? plan.members
      : [];
  const missionId = String(mission.mission_id ?? mission.task_id ?? mission.id ?? "");
  const state = String(mission.state ?? mission.status ?? "PLANNING") as MissionState;
  return {
    ...mission,
    id: String(mission.id ?? missionId),
    task_id: String(mission.task_id ?? missionId),
    mission_id: missionId,
    state,
    status: mission.status ?? state,
    task_spec: taskSpec,
    goal: mission.goal ?? plan?.goal ?? taskSpec.goal ?? taskSpec.prompt ?? "",
    plan,
    members,
    attempts,
    artifacts: Array.isArray(mission.artifacts) ? mission.artifacts : [],
    reviews: Array.isArray(mission.reviews) ? mission.reviews : [],
    messages: Array.isArray(mission.messages) ? mission.messages : [],
    timeline: Array.isArray(mission.timeline) ? mission.timeline : [],
    permissions: Array.isArray(mission.permissions) ? mission.permissions : [],
    needs_user_action: Boolean(
      mission.needs_user_action ??
        (state === "AWAITING_CONFIRMATION" || state === "BLOCKED"),
    ),
    last_cursor: mission.last_cursor == null ? null : String(mission.last_cursor),
  } as Mission;
}

// -- missions (app.py:1472-1548) --------------------------------------------------
export async function createMission(input: MissionCreateInput): Promise<Mission> {
  return missionFromResponse(await api.post("/v1/missions", input));
}

export async function listMissions(states?: MissionState[]): Promise<Mission[]> {
  // The backend accepts repeated `state` params (or a csv `states`) (app.py:1479).
  const payload = await api.get<{ missions?: unknown[] } | unknown[]>(
    "/v1/missions",
    states?.length ? { state: states } : undefined,
  );
  const list = Array.isArray(payload) ? payload : (payload?.missions ?? []);
  return list.map(missionFromResponse);
}

export async function getMission(missionId: string): Promise<Mission> {
  return missionFromResponse(await api.get(`/v1/missions/${encodeURIComponent(missionId)}`));
}

export async function updateMissionPlan(missionId: string, plan: MissionPlan): Promise<Mission> {
  return missionFromResponse(
    await api.patch(`/v1/missions/${encodeURIComponent(missionId)}/plan`, { plan }),
  );
}

export async function confirmMission(
  missionId: string,
  idempotencyKey?: string,
): Promise<Mission> {
  return missionFromResponse(
    await api.post(
      `/v1/missions/${encodeURIComponent(missionId)}/confirm`,
      idempotencyKey ? { idempotency_key: idempotencyKey } : {},
    ),
  );
}

export const messageMission = (
  missionId: string,
  message: string,
  target: MessageTarget = { kind: "main" },
  idempotencyKey: string = globalThis.crypto?.randomUUID?.() ??
    `mission-message-${Date.now()}-${Math.random()}`,
): Promise<{
  ok: boolean;
  mission_id?: string;
  task_id?: string;
  message_id?: string;
  newly_enqueued?: boolean;
  delivered?: boolean;
  error?: string;
}> =>
  api.post(`/v1/missions/${encodeURIComponent(missionId)}/messages`, {
    message,
    target,
    idempotency_key: idempotencyKey,
  });

export async function cancelMission(missionId: string): Promise<Mission> {
  return missionFromResponse(
    await api.post(`/v1/missions/${encodeURIComponent(missionId)}/cancel`),
  );
}

// REST fallback for the WS ledger stream: one page of events after `cursor` (app.py:1535).
export const getMissionEvents = (
  missionId: string,
  options: { after?: string | null; limit?: number } = {},
): Promise<MissionEventsPage> =>
  api.get<MissionEventsPage>(`/v1/missions/${encodeURIComponent(missionId)}/events`, {
    after: options.after ?? undefined,
    limit: options.limit,
  });

// -- team tasks (app.py:1550-1634) ------------------------------------------------
export const delegateAgentTask = (body: {
  prompt: string;
  title?: string;
  workspace?: string | null;
  conversation_id?: string;
  target_profile_id?: string;
  max_rework_rounds?: number;
  task_spec?: Record<string, unknown>;
}): Promise<TeamTask> => {
  const taskSpec = body.task_spec ?? {
    prompt: body.prompt,
    title: body.title || body.prompt.slice(0, 80),
    workspace: body.workspace || undefined,
  };
  return api.post("/v1/team/delegate", {
    conversation_id: body.conversation_id,
    target_profile_id: body.target_profile_id,
    max_rework_rounds: body.max_rework_rounds,
    task_spec: taskSpec,
  });
};

export const getAgentTaskStatus = (taskId: string): Promise<TeamTask> =>
  api.get(`/v1/team/${encodeURIComponent(taskId)}/status`);

export const getAgentTaskResult = (taskId: string): Promise<TeamTaskResult> =>
  api.get(`/v1/team/${encodeURIComponent(taskId)}/result`);

export const messageAgentTask = (
  taskId: string,
  message: string,
  idempotencyKey: string = globalThis.crypto?.randomUUID?.() ??
    `message-${Date.now()}-${Math.random()}`,
): Promise<{ ok: boolean; task_id?: string; message_id?: string; error?: string }> =>
  api.post(`/v1/team/${encodeURIComponent(taskId)}/message`, {
    message,
    idempotency_key: idempotencyKey,
  });

export const cancelAgentTask = (taskId: string): Promise<TeamTask> =>
  api.post(`/v1/team/${encodeURIComponent(taskId)}/cancel`);

export const startAgentAttempt = (
  taskId: string,
  body: {
    profile_id?: string;
    role?: string;
    agent_session_id?: string;
    worktree_path?: string;
    rework_round?: number;
  } = {},
): Promise<TeamAttempt> => api.post(`/v1/team/${encodeURIComponent(taskId)}/attempts`, body);

export const addAgentArtifact = (
  taskId: string,
  body: {
    kind?: string;
    attempt_id?: string;
    path?: string;
    payload?: Record<string, unknown>;
  },
): Promise<TeamArtifact> => api.post(`/v1/team/${encodeURIComponent(taskId)}/artifacts`, body);

// Ask for a review of one artifact (app.py:1607).
export const requestAgentReview = (
  artifactId: string,
  reviewerProfileId?: string,
): Promise<{ ok: boolean; error?: string } & Record<string, unknown>> =>
  api.post("/v1/review/request", {
    artifact_id: artifactId,
    ...(reviewerProfileId ? { reviewer_profile_id: reviewerProfileId } : {}),
  });

// Record a review verdict for a task's artifact (app.py:1617).
export const recordAgentReview = (
  taskId: string,
  body: {
    artifact_id: string;
    result?: Partial<TeamReview>;
    reviewer_profile_id?: string;
    reviewer_attempt_id?: string;
    tests_passed?: boolean;
  },
): Promise<TeamReview> => api.post(`/v1/team/${encodeURIComponent(taskId)}/reviews`, body);
