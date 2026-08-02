// 任务页面 — 多 Agent 协作任务的列表(#/missions)与详情(#/missions/:id)之间的路由开关。
// 列表:状态筛选 chips + 任务行 + 「新建任务」drawer(目标 → 创建 → 直达详情页确认计划)。

import { useEffect, useState, type FormEvent } from "react";
import { Drawer } from "../../components/Drawer";
import { Icon } from "../../components/Icon";
import { navigate, useRoute } from "../../nav";
import { getRecentWorkspaces, openWorkspace, pickFolderViaServer } from "../../lib/api/sessions";
import { getReadiness } from "../../lib/api/settings";
import type { Mission, Readiness, RecentWorkspace } from "../../lib/api/types";
import { humanizeErrorText } from "../../lib/errorText";
import { MissionDetailPage } from "./MissionDetailPage";
import {
  MISSION_FILTERS,
  formatTime,
  missionMatchesFilter,
  missionPlanningErrorText,
  missionTitle,
  sortMissionsByUpdated,
  stateMeta,
  validateMissionWorkspace,
  type MissionFilter,
} from "./missionLogic";
import { useMissions } from "./useMissions";

const GRP =
  "overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]";

export function MissionsPage() {
  const route = useRoute();
  const missionId = route.params.missionId;
  if (missionId) return <MissionDetailPage key={missionId} missionId={missionId} />;
  return <MissionListPage />;
}

function MissionRow({ mission, onOpen }: { mission: Mission; onOpen: () => void }) {
  const meta = stateMeta(mission.state);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-paper/50"
    >
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${meta.tint}`}>
        {meta.label}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{missionTitle(mission)}</span>
        <span className="mt-0.5 block text-[11.5px] text-faint">
          {mission.members.length} 个席位
          {mission.workspace ? ` · ${mission.workspace}` : ""} · 更新于{" "}
          {formatTime(mission.updated_at ?? mission.created_at)}
        </span>
        {missionPlanningErrorText(mission) && (
          <span className="mt-1 block truncate text-[11.5px] text-danger">
            {missionPlanningErrorText(mission)}
          </span>
        )}
      </span>
      <Icon name="chevronRight" size={14} className="shrink-0 text-faint" />
    </div>
  );
}

function CreateMissionDrawer({
  creating,
  planningOutput,
  onClose,
  onCreate,
}: {
  creating: boolean;
  planningOutput: string;
  onClose: () => void;
  onCreate: (goal: string, workspace: string) => Promise<string | null>;
}) {
  const [goal, setGoal] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);

  useEffect(() => {
    let stale = false;
    getRecentWorkspaces()
      .then((list) => {
        if (stale) return;
        setRecentWorkspaces(list);
        const first = list.find((item) => item.exists !== false)?.path ?? "";
        if (first) setWorkspace((current) => current || first);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    let stale = false;
    getReadiness(workspace || undefined)
      .then((value) => {
        if (!stale) setReadiness(value);
      })
      .catch(() => {
        if (!stale) setReadiness(null);
      });
    return () => {
      stale = true;
    };
  }, [workspace]);

  const readinessError =
    readiness && !readiness.can_create_mission
      ? readiness.next_action === "choose_workspace"
        ? "需要先选择一个可用 workspace。"
        : readiness.next_action === "select_main_agent"
          ? "当前 workspace 缺少 main Agent。"
          : readiness.next_action === "activate_main_agent"
            ? "当前 workspace 的 main Agent 还未激活。"
            : "当前 workspace 的 main Agent 不可用。"
      : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalidWorkspace = validateMissionWorkspace(workspace);
    if (invalidWorkspace) {
      setError(invalidWorkspace);
      return;
    }
    if (!goal.trim() || creating || readinessError) return;
    setError(null);
    const failure = await onCreate(goal, workspace);
    // The raw 400 can still slip through (profile flipped between load and submit).
    if (failure) setError(humanizeErrorText(failure));
  };

  const browseWorkspace = async () => {
    const picked = await pickFolderViaServer();
    if (!picked) return;
    const opened = await openWorkspace(picked).catch(() => null);
    setWorkspace(opened?.ok && opened.path ? opened.path : picked);
  };

  return (
    <Drawer
      title="新建 Mission"
      dirty={Boolean(goal.trim())}
      initialFocus="#mission-goal"
      onClose={onClose}
      footer={
        <div className="border-t border-line bg-panel px-4 py-3">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
            >
              取消
            </button>
            <button
              type="submit"
              form="mission-create-form"
              disabled={!goal.trim() || !workspace.trim() || creating || Boolean(readinessError)}
              title={readinessError || undefined}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
            >
              {creating ? <span className="spinner" /> : <Icon name="sparkle" size={14} />}
              创建 Mission
            </button>
          </div>
        </div>
      }
    >
        <form id="mission-create-form" onSubmit={(event) => void submit(event)} className="flex min-h-full flex-col p-4">
          <p className="text-[12.5px] leading-relaxed text-muted">
            描述目标后,主 Agent 会提出结构化的团队计划;你确认前不会启动任何写入型执行。
          </p>
          <label htmlFor="mission-goal" className="mb-1.5 mt-5 text-[12px] font-semibold text-muted">
            目标
          </label>
          <textarea
            id="mission-goal"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="例如:让 Kimi 做 UI,OpenCode 实现,Reviewer 做只读审查"
            rows={6}
            autoFocus
            className="w-full resize-none rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-faint focus:border-lineStrong"
          />
          <label htmlFor="mission-workspace" className="mb-1.5 mt-4 text-[12px] font-semibold text-muted">
            Workspace
          </label>
          <div className="flex items-center gap-2">
            <select
              id="mission-workspace"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-2 text-[13px] outline-none focus:border-lineStrong"
            >
              <option value="">选择 workspace</option>
              {recentWorkspaces.map((item) => (
                <option key={item.path} value={item.path}>
                  {item.name || item.path}
                </option>
              ))}
              {workspace && !recentWorkspaces.some((item) => item.path === workspace) && (
                <option value={workspace}>{workspace}</option>
              )}
            </select>
            <button
              type="button"
              onClick={() => void browseWorkspace()}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px] hover:border-lineStrong"
            >
              <Icon name="folder" size={14} />
              选择
            </button>
          </div>
          {error && (
            <p className="mt-2 text-[12px] text-danger" role="alert">
              {error}
            </p>
          )}
          {readinessError && (
            <div
              className="mt-3 rounded-lg bg-warnSoft px-3 py-2 text-[12.5px] leading-relaxed text-warnInk"
              data-testid="mission-readiness-notice"
            >
              {readinessError}
              <button
                type="button"
                onClick={() => navigate(readiness?.next_action === "fix_main_agent" ? "agents" : "home")}
                className="mt-1.5 flex items-center gap-1 rounded-md border border-warnInk/30 px-2 py-0.5 text-[11.5px] font-medium hover:opacity-80"
              >
                前往修复
                <Icon name="chevronRight" size={12} />
              </button>
            </div>
          )}
          {creating && (
            <div
              className="mt-3 rounded-lg border border-line bg-panel px-3 py-2.5"
              data-testid="mission-planning-stream"
              aria-live="polite"
            >
              <div className="flex items-center gap-2 text-[12px] font-medium text-muted">
                <span className="spinner" />
                主 Agent 正在规划
              </div>
              <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-faint">
                {planningOutput || "正在连接规划会话…"}
              </pre>
            </div>
          )}
        </form>
    </Drawer>
  );
}

function MissionListPage() {
  const { missions, loading, loadError, creating, planningOutput, refresh, create } = useMissions();
  const [filter, setFilter] = useState<MissionFilter>("all");
  const [composing, setComposing] = useState(false);

  const filtered = sortMissionsByUpdated(missions.filter((mission) => missionMatchesFilter(mission, filter)));

  const createAndOpen = async (goal: string, workspace: string): Promise<string | null> => {
    try {
      const mission = await create(goal, workspace);
      navigate(`missions/${encodeURIComponent(mission.mission_id)}`);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header data-tauri-drag-region className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Missions</h1>
          <p className="mt-1 text-[13px] text-muted">
            把目标交给可审计的本地 Agent 团队:先确认计划,再跟踪执行、审查与交付。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setComposing(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white hover:brightness-105"
        >
          <Icon name="plus" size={14} />
          新建 Mission
        </button>
      </header>

      <div className="mt-5 flex items-center gap-1" role="tablist" aria-label="任务状态筛选">
        {MISSION_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={`rounded-md px-2.5 py-1 text-[12.5px] ${
              filter === item.id
                ? "bg-accentSoft font-medium text-accent"
                : "text-muted hover:bg-panel hover:text-ink"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-faint">
          <span className="spinner spinner-lg" /> 加载中
        </div>
      ) : loadError ? (
        <div className="py-20 text-center">
          <p className="text-[13px] text-danger">{loadError}</p>
          <button
            type="button"
            onClick={() => void refresh().catch(() => {})}
            className="mt-3 rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
          >
            重试
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-xl2 bg-accentSoft text-accent">
            <Icon name="missions" size={20} />
          </div>
          <h2 className="mt-4 text-[15px] font-semibold tracking-tight">
            {missions.length === 0 ? "还没有 Mission" : "没有匹配的 Mission"}
          </h2>
          <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
            {missions.length === 0
              ? "新建一个 Mission,主 Agent 会先提出团队计划,确认后开始执行。"
              : "切换上方筛选,或新建一个 Mission。"}
          </p>
          {missions.length === 0 && (
            <button
              type="button"
              onClick={() => setComposing(true)}
              className="mt-5 flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white hover:brightness-105"
            >
              <Icon name="plus" size={14} />
              新建 Mission
            </button>
          )}
        </div>
      ) : (
        <div className={`${GRP} mt-3 divide-y divide-line`}>
          {filtered.map((mission) => (
            <MissionRow
              key={mission.mission_id}
              mission={mission}
              onOpen={() => navigate(`missions/${encodeURIComponent(mission.mission_id)}`)}
            />
          ))}
        </div>
      )}

      {composing && (
        <CreateMissionDrawer
          creating={creating}
          planningOutput={planningOutput}
          onClose={() => setComposing(false)}
          onCreate={createAndOpen}
        />
      )}
    </div>
  );
}
