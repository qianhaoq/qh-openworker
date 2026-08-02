// 计划卡片 — 任务的结构化团队计划。待确认(AWAITING_CONFIRMATION)时可编辑:席位按行
// 编辑(角色 / profile / 职责 / 依赖),保存走 PATCH plan,确认走 POST confirm。确认后
// 整卡只读,只保留一行低调摘要。纯编辑逻辑在 missionLogic.ts。

import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { navigate } from "../../nav";
import type { AgentProfile, Mission, MissionPlan } from "../../lib/api/types";
import { roleMeta, unusableProfileIds } from "../agents/agentLogic";
import {
  addPlanMember,
  canAddMemberRole,
  formatDependsOnInput,
  parseDependsOnInput,
  planDraftHasExecutor,
  planDraftFromPlan,
  planDraftToPlan,
  removePlanMember,
  updatePlanMember,
  validatePlanDraft,
  type PlanDraft,
} from "./missionLogic";

const TAG = "rounded px-1.5 py-0.5 text-[10.5px] font-semibold";
const ROLE_ORDER = ["main", "explorer", "executor", "reviewer", "gui"] as const;

function proposalLabel(mission: Mission): { text: string; fallback: boolean; reason?: string } {
  const source = mission.plan_proposal?.source;
  if (source === "main_agent") return { text: "主 Agent 提案", fallback: false };
  if (source === "control_plane_fallback" || source === "control_plane") {
    return {
      text: "控制面兜底提案",
      fallback: source === "control_plane_fallback",
      reason: mission.plan_proposal?.fallback_reason ?? undefined,
    };
  }
  return { text: "结构化提案", fallback: false };
}

export function PlanCard({
  mission,
  profiles,
  profilesLoaded,
  mutating,
  onSave,
  onConfirm,
}: {
  mission: Mission;
  profiles: AgentProfile[];
  /** false = the profile list never loaded — skip the confirm gate (the backend's
   * 409, already mapped to Chinese, is the fallback). */
  profilesLoaded: boolean;
  mutating: boolean;
  onSave: (plan: MissionPlan) => Promise<boolean>;
  onConfirm: () => Promise<boolean>;
}) {
  const plan = mission.plan ?? null;
  const awaiting = mission.state === "AWAITING_CONFIRMATION" || mission.state === "PLANNING";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PlanDraft | null>(plan ? planDraftFromPlan(plan) : null);

  // Reset the editor only on a NEW plan version/status — depending on `plan` itself
  // would wipe an in-progress edit on every 3s live poll (same version, new identity).
  const planVersion = plan?.version;
  const planStatus = plan?.status;
  useEffect(() => {
    setDraft(plan ? planDraftFromPlan(plan) : null);
    setEditing(false);
  }, [planVersion, planStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const proposal = proposalLabel(mission);
  const validation = editing && draft ? validatePlanDraft(draft) : null;

  // Confirm gate: any seat whose profile is unknown/disabled/unprobed makes the
  // backend 409 — block the click and deep-link to the Agents page instead.
  const confirmBlockers =
    profilesLoaded && plan && awaiting
      ? unusableProfileIds(
          plan.members.map((member) => member.profile_id),
          profiles,
        )
      : [];

  const save = async () => {
    if (!draft || validation) return;
    const ok = await onSave(planDraftToPlan(draft, plan));
    if (ok) setEditing(false);
  };

  return (
    <section className="overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span
          className={`${TAG} ${mission.state === "AWAITING_CONFIRMATION" ? "bg-warnSoft text-warnInk" : "bg-okSoft text-ok"}`}
        >
          {mission.state === "AWAITING_CONFIRMATION" ? "待确认" : plan?.status === "confirmed" ? "已确认" : "计划中"}
        </span>
        <span
          className={`${TAG} ${proposal.fallback ? "bg-warnSoft text-warnInk" : "bg-solid text-muted"}`}
          title={proposal.reason}
        >
          {proposal.text}
        </span>
        <span className="ml-auto text-[11.5px] text-faint">
          {plan ? `v${plan.version}` : "等待计划"}
        </span>
      </header>

      <div className="px-4 py-3.5">
        {!plan ? (
          <div className="flex items-center gap-2 py-4 text-[13px] text-faint">
            <span className="spinner spinner-lg" /> 主 Agent 正在生成团队计划…
          </div>
        ) : editing && draft ? (
          <div>
            <label htmlFor="plan-goal" className="mb-1.5 block text-[12px] font-semibold text-muted">
              目标
            </label>
            <textarea
              id="plan-goal"
              value={draft.goal}
              onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
              rows={3}
              className="w-full resize-none rounded-lg border border-line bg-paper px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-lineStrong"
            />

            <div className="mb-1.5 mt-4 text-[12px] font-semibold text-muted">团队席位</div>
            <div className="space-y-2">
              {draft.members.map((member) => {
                const meta = roleMeta(member.role);
                const choices = profiles.filter((profile) => profile.role === member.role);
                return (
                  <div key={member.key} className="rounded-lg border border-line p-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`grid h-6 w-10 shrink-0 place-items-center rounded-md text-[11px] font-semibold ${meta.tint}`}>
                        {meta.label}
                      </span>
                      <label className="sr-only" htmlFor={`profile-${member.key}`}>
                        {meta.label} profile
                      </label>
                      <select
                        id={`profile-${member.key}`}
                        value={member.profileId}
                        onChange={(event) =>
                          setDraft(updatePlanMember(draft, member.key, { profileId: event.target.value }))
                        }
                        className="min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 font-mono text-[11.5px] outline-none"
                      >
                        {!choices.some((profile) => profile.id === member.profileId) && (
                          <option value={member.profileId}>{member.profileId || "未分配"}</option>
                        )}
                        {choices.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.id}
                            {profile.enabled ? "" : " · 未启用"}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setDraft(removePlanMember(draft, member.key))}
                        title={`移除 ${meta.label} 席位`}
                        aria-label={`移除 ${meta.label} 席位`}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:text-danger"
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                    <label className="sr-only" htmlFor={`objective-${member.key}`}>
                      {meta.label} 职责
                    </label>
                    <input
                      id={`objective-${member.key}`}
                      value={member.objective}
                      onChange={(event) =>
                        setDraft(updatePlanMember(draft, member.key, { objective: event.target.value }))
                      }
                      placeholder="职责说明"
                      className="mt-2 w-full rounded-md border border-line bg-panel px-2 py-1 text-[12px] outline-none placeholder:text-faint"
                    />
                    <label className="sr-only" htmlFor={`depends-${member.key}`}>
                      {meta.label} 依赖
                    </label>
                    <input
                      id={`depends-${member.key}`}
                      value={formatDependsOnInput(member.dependsOn)}
                      onChange={(event) =>
                        setDraft(
                          updatePlanMember(draft, member.key, {
                            dependsOn: parseDependsOnInput(event.target.value),
                          }),
                        )
                      }
                      placeholder="依赖席位(逗号分隔,如 main:kimi-main)"
                      className="mt-1.5 w-full rounded-md border border-line bg-panel px-2 py-1 font-mono text-[11px] outline-none placeholder:text-faint"
                    />
                  </div>
                );
              })}
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {ROLE_ORDER.filter((role) => canAddMemberRole(draft, role, profiles)).map((role) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => setDraft(addPlanMember(draft, role, profiles))}
                  className="flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] text-muted hover:border-lineStrong hover:text-ink"
                >
                  <Icon name="plus" size={12} />
                  添加{roleMeta(role).label}
                </button>
              ))}
            </div>

            <div className="mt-4 flex items-center gap-2">
              <label htmlFor="max-rework" className="text-[12px] font-semibold text-muted">
                最多返修轮数
              </label>
              <input
                id="max-rework"
                type="number"
                min={0}
                max={5}
                value={draft.maxReworkRounds}
                onChange={(event) =>
                  setDraft({ ...draft, maxReworkRounds: Number(event.target.value) })
                }
                className="w-16 rounded-md border border-line bg-panel px-2 py-1 text-[12px] outline-none"
              />
            </div>

            {validation ? (
              <p className="mt-3 text-[12px] text-danger" role="alert">
                {validation}
              </p>
            ) : !planDraftHasExecutor(draft) ? (
              <p className="mt-3 text-[12px] text-warnInk">
                当前计划没有「执行」席位,确认前请添加一个,否则后端会拒绝启动。
              </p>
            ) : null}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setDraft(planDraftFromPlan(plan));
                  setEditing(false);
                }}
                className="rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
              >
                放弃修改
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={mutating || Boolean(validation)}
                className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
              >
                保存计划
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="text-[14.5px] font-semibold leading-snug tracking-tight">{plan.goal}</h2>
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              {plan.summary ||
                (proposal.fallback
                  ? "主 Agent 当前不可用,控制面已生成可审计的兜底团队提案;确认前不会创建写入型执行。"
                  : "主 Agent 已提出团队分工、依赖和返修上限;确认前不会创建写入型执行。")}
            </p>
            <div className="mt-3 divide-y divide-line rounded-lg border border-line">
              {plan.members.map((member) => {
                const meta = roleMeta(member.role);
                return (
                  <div key={member.id || `${member.role}-${member.profile_id}`} className="flex items-start gap-2.5 px-3 py-2">
                    <span className={`mt-0.5 grid h-6 w-10 shrink-0 place-items-center rounded-md text-[11px] font-semibold ${meta.tint}`}>
                      {meta.label}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11.5px] text-ink">{member.profile_id}</span>
                      {member.objective && (
                        <span className="mt-0.5 block text-[12px] leading-snug text-muted">{member.objective}</span>
                      )}
                      {(member.depends_on ?? []).length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {(member.depends_on ?? []).map((dep) => (
                            <span key={dep} className="rounded bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-faint">
                              依赖 {dep}
                            </span>
                          ))}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {!editing && (
        <footer className="flex items-center justify-between border-t border-line px-4 py-2.5">
          <span className="text-[11.5px] text-faint">
            最多返修 {plan?.max_rework_rounds ?? mission.max_rework_rounds ?? 2} 轮
          </span>
          {awaiting && plan ? (
            <div className="flex items-center gap-2">
              {confirmBlockers.length > 0 && (
                <button
                  type="button"
                  onClick={() => navigate("agents")}
                  data-testid="confirm-blocked-hint"
                  className="max-w-[300px] text-left text-[11.5px] leading-snug text-warnInk hover:underline"
                >
                  席位 {confirmBlockers.join("、")} 的 agent 未启用或未探测 —— 前往 Agents 处理
                </button>
              )}
              <button
                type="button"
                onClick={() => setEditing(true)}
                disabled={mutating}
                className="flex items-center gap-1 rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:border-lineStrong disabled:opacity-40"
              >
                <Icon name="pencil" size={13} />
                调整团队
              </button>
              <button
                type="button"
                onClick={() => void onConfirm()}
                disabled={
                  mutating || mission.state !== "AWAITING_CONFIRMATION" || confirmBlockers.length > 0
                }
                title={
                  confirmBlockers.length > 0
                    ? "先到 Agents 页启用并探测这些 agent"
                    : mission.state !== "AWAITING_CONFIRMATION"
                      ? "等待计划生成后即可确认"
                      : undefined
                }
                className="flex items-center gap-1 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
              >
                <Icon name="check" size={13} />
                确认计划
              </button>
            </div>
          ) : plan?.status === "confirmed" ? (
            <span className="flex items-center gap-1 text-[11.5px] text-ok">
              <Icon name="check" size={13} />
              计划已确认 · v{plan.version}
            </span>
          ) : null}
        </footer>
      )}
    </section>
  );
}
