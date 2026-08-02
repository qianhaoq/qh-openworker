// 任务详情页 — header(目标、状态徽标、取消)、计划卡片、实时时间线、团队面板和指向主
// Agent 的消息 composer。数据全部来自 useMissionDetail(REST + WS + 运行期轮询)。

import { useState, type FormEvent } from "react";
import { Icon } from "../../components/Icon";
import { createMission } from "../../lib/api/missions";
import { navigate } from "../../nav";
import { PlanCard } from "./PlanCard";
import { ArtifactsDrawer, ReviewsDrawer, TeamPanel } from "./TeamPanel";
import { Timeline } from "./Timeline";
import { formatTime, missionPlanningErrorText, missionTitle, stateMeta } from "./missionLogic";
import { useMissionDetail } from "./useMissionDetail";

type SideDrawer = { kind: "artifacts"; attemptId: string | null } | { kind: "reviews" } | null;

function CancelButton({ mutating, onCancel }: { mutating: boolean; onCancel: () => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-[12px] text-muted">确认取消该任务?</span>
        <button
          type="button"
          disabled={mutating}
          onClick={() => {
            void onCancel().then((ok) => {
              if (!ok) setConfirming(false);
            });
          }}
          className="rounded-md bg-danger px-2.5 py-1 text-[11.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
        >
          确认取消
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="rounded-md border border-line bg-panel px-2.5 py-1 text-[11.5px] hover:border-lineStrong"
        >
          再想想
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] text-danger hover:border-lineStrong"
    >
      取消任务
    </button>
  );
}

function MainComposer({
  mutating,
  onSend,
}: {
  mutating: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || mutating) return;
    const ok = await onSend(trimmed);
    if (ok) setText("");
  };
  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
      className="rounded-xl bg-panel p-3 shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]"
    >
      <label className="sr-only" htmlFor="mission-main-message">
        发给主 Agent 的消息
      </label>
      <textarea
        id="mission-main-message"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        rows={2}
        placeholder="发给主 Agent:继续追问、调整方向,或要求返修…"
        className="w-full resize-none rounded-lg border border-line bg-paper px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-faint focus:border-lineStrong"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-faint">Enter 发送 · Shift+Enter 换行</span>
        <button
          type="submit"
          disabled={!text.trim() || mutating}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
        >
          <Icon name="send" size={13} />
          发送
        </button>
      </div>
    </form>
  );
}

export function MissionDetailPage({ missionId }: { missionId: string }) {
  const {
    mission,
    events,
    profiles,
    profilesLoaded,
    loading,
    loadError,
    connection,
    mutating,
    actionError,
    clearActionError,
    reload,
    savePlan,
    confirm,
    send,
    cancel,
  } = useMissionDetail(missionId);
  const [drawer, setDrawer] = useState<SideDrawer>(null);
  const [planningRetrying, setPlanningRetrying] = useState(false);
  const [planningRetryError, setPlanningRetryError] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-faint">
        <span className="spinner spinner-lg" /> 加载中
      </div>
    );
  }

  if (loadError || !mission) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <p className="text-[13px] text-danger">{loadError || "未找到该任务"}</p>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void reload().catch(() => {})}
            className="rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
          >
            重试
          </button>
          <button
            type="button"
            onClick={() => navigate("missions")}
            className="rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
          >
            返回任务列表
          </button>
        </div>
      </div>
    );
  }

  const meta = stateMeta(mission.state);
  const cancellable = !["DONE", "APPROVED", "CANCELLED"].includes(mission.state);
  const planningError = missionPlanningErrorText(mission);
  const retryPlanning = async () => {
    const workspace = mission.workspace?.trim();
    const goal = mission.goal?.trim();
    if (!workspace || !goal || planningRetrying) return;
    setPlanningRetrying(true);
    setPlanningRetryError(null);
    try {
      const replacement = await createMission({
        goal,
        title: missionTitle(mission),
        workspace,
      });
      navigate(`missions/${encodeURIComponent(replacement.mission_id)}`);
    } catch (error) {
      setPlanningRetryError(error instanceof Error ? error.message : "重新规划失败");
    } finally {
      setPlanningRetrying(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <button
        type="button"
        onClick={() => navigate("missions")}
        className="flex items-center gap-1 text-[12.5px] text-muted hover:text-ink"
      >
        <Icon name="arrowLeft" size={14} />
        任务列表
      </button>

      <header data-tauri-drag-region className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${meta.tint}`}>
              {meta.label}
            </span>
            {mission.needs_user_action && mission.state !== "AWAITING_CONFIRMATION" && (
              <span className="rounded bg-warnSoft px-1.5 py-0.5 text-[10.5px] font-semibold text-warnInk">
                需要处理
              </span>
            )}
          </div>
          <h1 className="mt-2 text-[20px] font-semibold leading-snug tracking-tight">
            {missionTitle(mission)}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-faint">
            {mission.mission_id} · 创建于 {formatTime(mission.created_at)} · 更新于{" "}
            {formatTime(mission.updated_at)}
          </p>
        </div>
        {cancellable && (
          <div className="shrink-0 pt-1">
            <CancelButton mutating={mutating} onCancel={cancel} />
          </div>
        )}
      </header>

      {(planningError || mission.state === "BLOCKED") && (
        <div
          role="alert"
          data-testid="mission-planning-error"
          className="mt-4 rounded-xl bg-dangerSoft px-4 py-3 text-[12.5px] leading-relaxed text-danger"
        >
          <div className="font-semibold">{planningError || "任务已阻塞"}</div>
          <div className="mt-1 text-danger/80">
            检查 workspace、主 Agent profile、认证与运行时配置后再重试。
            {mission.fallback_used && " 本次使用了 fallback proposal。"}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => navigate("agents")}
              className="rounded-lg border border-danger/30 bg-panel px-3 py-1.5 text-[12px] font-medium hover:border-danger/50"
            >
              去 Agent 设置
            </button>
            <button
              type="button"
              disabled={!mission.workspace || !mission.goal || planningRetrying}
              onClick={() => void retryPlanning()}
              className="rounded-lg border border-danger/30 bg-panel px-3 py-1.5 text-[12px] font-medium hover:border-danger/50"
            >
              {planningRetrying ? "重新规划中…" : "重新规划"}
            </button>
          </div>
          {planningRetryError && <div className="mt-2 text-[12px]">{planningRetryError}</div>}
        </div>
      )}

      {actionError && (
        <div
          role="alert"
          className="mt-4 flex items-center justify-between rounded-lg bg-dangerSoft px-3.5 py-2 text-[12.5px] text-danger"
        >
          <span>{actionError}</span>
          <button type="button" onClick={clearActionError} aria-label="关闭错误提示">
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <PlanCard
            mission={mission}
            profiles={profiles}
            profilesLoaded={profilesLoaded}
            mutating={mutating}
            onSave={savePlan}
            onConfirm={confirm}
          />
          <Timeline events={events} connection={connection} />
          {cancellable ? (
            <MainComposer mutating={mutating} onSend={(text) => send(text, { kind: "main" })} />
          ) : (
            <p
              data-testid="mission-terminal-note"
              className="rounded-xl bg-panel px-4 py-3 text-center text-[12.5px] text-faint shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]"
            >
              任务{meta.label},不再接受新消息。
            </p>
          )}
        </div>
        <TeamPanel
          mission={mission}
          mutating={mutating}
          onSend={send}
          onOpenArtifacts={(attemptId) => setDrawer({ kind: "artifacts", attemptId })}
          onOpenReviews={() => setDrawer({ kind: "reviews" })}
        />
      </div>

      {drawer?.kind === "artifacts" && (
        <ArtifactsDrawer mission={mission} attemptId={drawer.attemptId} onClose={() => setDrawer(null)} />
      )}
      {drawer?.kind === "reviews" && <ReviewsDrawer mission={mission} onClose={() => setDrawer(null)} />}
    </div>
  );
}
