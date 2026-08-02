// 伙伴桌面 — the assistant home (the default page when no session is selected): a
// time-aware greeting from Q, four overview cards that navigate to their surfaces, a
// primary Mission creation, a secondary quick-chat action, and up to three recent
// sessions as quiet rows. All aggregation
// lives in homeLogic.ts; this file is data wiring + layout.

import { useEffect, useState } from "react";
import {
  activateAgentProfile,
  detectAgentCommands,
  listAgentPermissions,
  listAgentProfiles,
  setWorkspaceMainAgent,
  upsertAgentProfile,
} from "../../lib/api/agents";
import { getAutomations } from "../../lib/api/automations";
import { getInbox } from "../../lib/api/inbox";
import { listMissions } from "../../lib/api/missions";
import { getSessions, openWorkspace, pickFolderViaServer } from "../../lib/api/sessions";
import { getReadiness, getSettings, setOnboarded } from "../../lib/api/settings";
import type { Automation, Mission, Readiness, Session } from "../../lib/api/types";
import { Icon, type IconName } from "../../components/Icon";
import { navigate } from "../../nav";
import { formatSessionTime } from "../assistant/SessionListPanel";
import { profileFromPreset } from "../agents/agentLogic";
import {
  dateLine,
  deriveCards,
  greetingForHour,
  recentSessions,
  statusSummary,
  todaySessions,
  type HomeCard,
  type HomeCardId,
  type HomeData,
} from "./homeLogic";

const CARD_ICONS: Record<HomeCardId, IconName> = {
  approvals: "inbox",
  missions: "missions",
  sessions: "assistant",
  automations: "automations",
};

interface HomeRest {
  approvals: number;
  missions: Mission[];
  automations: Automation[];
  readiness: Readiness | null;
  sessions: Session[];
  onboarded: boolean;
}

// 待处理计数 = 收件箱 pending + ACP 权限请求 (the sidebar badge's 口径, App.tsx:31).
const loadApprovals = (): Promise<number> =>
  Promise.all([getInbox(undefined, "pending"), listAgentPermissions(true)]).then(
    ([items, permissions]) => items.length + permissions.length,
  );

const newSessionId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const startQuickChat = (onNew?: () => void) => {
  if (onNew) onNew();
  else navigate(`assistant/${newSessionId()}`);
};

export function HomePage({
  sessions: suppliedSessions,
  onNew,
}: {
  sessions?: Session[];
  onNew?: () => void;
}) {
  const [rest, setRest] = useState<HomeRest>({
    approvals: 0,
    missions: [],
    automations: [],
    readiness: null,
    sessions: suppliedSessions ?? [],
    onboarded: false,
  });
  const [nextBusy, setNextBusy] = useState(false);
  const [nextError, setNextError] = useState<string | null>(null);

  // Sessions arrive live from AssistantPage's poll; the other three surfaces refresh on
  // a slow cadence — the home is a glance, not a dashboard.
  useEffect(() => {
    let stale = false;
    const load = () =>
      Promise.all([
        loadApprovals().catch(() => 0),
        listMissions().catch(() => [] as Mission[]),
        getAutomations().catch(() => [] as Automation[]),
        suppliedSessions ? Promise.resolve(suppliedSessions) : getSessions().catch(() => [] as Session[]),
        getReadiness().catch(() => null),
        getSettings().then((settings) => settings.onboarded).catch(() => false),
      ]).then(([approvals, missions, automations, sessions, readiness, onboarded]) => {
        if (!stale) setRest({ approvals, missions, automations, sessions, readiness, onboarded });
      });
    load();
    const timer = setInterval(load, 15000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [suppliedSessions]);

  const now = new Date();
  const data: HomeData = {
    sessions: rest.sessions,
    pendingApprovals: rest.approvals,
    missions: rest.missions,
    automations: rest.automations,
  };
  const cards = deriveCards(data, now);
  const recents = recentSessions(rest.sessions, 3);
  const setupMode = !rest.onboarded && !rest.readiness?.can_create_mission;
  const missionReady = rest.readiness?.can_create_mission === true;
  const quickChatReady = rest.readiness?.model_ready === true;

  const openCard = (card: HomeCard) => {
    // 今日会话 has no page of its own — land on the most recent conversation of the day.
    if (card.id === "sessions" && card.count > 0) {
      const latest = recentSessions(todaySessions(rest.sessions, now), 1)[0];
      if (latest) {
        navigate(`assistant/${latest.session_id}`);
        return;
      }
    }
    navigate(card.route);
  };

  const chooseWorkspace = async () => {
    setNextError(null);
    setNextBusy(true);
    try {
      const picked = await pickFolderViaServer();
      if (!picked) return;
      const opened = await openWorkspace(picked);
      const readiness = await getReadiness(opened.path || picked);
      setRest((current) => ({ ...current, readiness }));
    } catch (error) {
      setNextError(error instanceof Error ? error.message : String(error));
    } finally {
      setNextBusy(false);
    }
  };

  const activateBoundMain = async () => {
    const profileId = rest.readiness?.main_profile?.id;
    if (!profileId) {
      navigate("agents");
      return;
    }
    setNextError(null);
    setNextBusy(true);
    try {
      const activated = await activateAgentProfile(profileId, rest.readiness?.workspace || undefined);
      if (!activated.ok) throw new Error(activated.error || "激活 Agent 失败");
      const readiness = await getReadiness(rest.readiness?.workspace || undefined);
      setRest((current) => ({ ...current, readiness }));
    } catch (error) {
      setNextError(error instanceof Error ? error.message : String(error));
    } finally {
      setNextBusy(false);
    }
  };

  const addKimiMain = async () => {
    setNextError(null);
    setNextBusy(true);
    try {
      const detected = await detectAgentCommands(["kimi"]);
      if (!detected.results.kimi) {
        setNextError("未检测到本机 kimi runtime。请先安装 Kimi CLI，或到 Agents 手动添加。");
        return;
      }
      const profiles = await listAgentProfiles();
      const existingKimi = profiles.find(
        (profile) => profile.role === "main" && profile.command.trim() === "kimi",
      );
      const draft = existingKimi ??
        profileFromPreset(
          {
            key: "kimi",
            title: "Kimi ACP",
            description: "本机 Kimi ACP runtime",
            command: "kimi",
            args: ["acp"],
            role: "main",
            transport: "acp_stdio",
            modelProfile: "kimi-code/k3",
          },
          new Set(profiles.map((profile) => profile.id)),
        );
      if (!existingKimi) {
        const saved = await upsertAgentProfile({ ...draft, enabled: false });
        if (!saved.ok) throw new Error(saved.error || "保存 Agent 失败");
      }
      const activated = await activateAgentProfile(draft.id, rest.readiness?.workspace || undefined);
      if (!activated.ok) throw new Error(activated.error || "激活 Agent 失败");
      await setWorkspaceMainAgent(rest.readiness?.workspace || null, draft.id);
      const readiness = await getReadiness(rest.readiness?.workspace || undefined);
      setRest((current) => ({ ...current, readiness }));
    } catch (error) {
      setNextError(error instanceof Error ? error.message : String(error));
    } finally {
      setNextBusy(false);
    }
  };

  const runNextAction = async () => {
    const action = rest.readiness?.next_action;
    if (action === "choose_workspace") {
      await chooseWorkspace();
    } else if (action === "select_main_agent" || action === "activate_main_agent") {
      if (action === "activate_main_agent") await activateBoundMain();
      else await addKimiMain();
    } else if (action === "fix_main_agent") {
      navigate("agents");
    } else {
      navigate("missions");
    }
  };

  const deferSetup = async () => {
    setNextError(null);
    setNextBusy(true);
    try {
      const result = await setOnboarded(true);
      if (!result.ok) throw new Error("保存稍后设置失败");
      setRest((current) => ({ ...current, onboarded: true }));
    } catch (error) {
      setNextError(error instanceof Error ? error.message : String(error));
    } finally {
      setNextBusy(false);
    }
  };

  const nextTitle = (() => {
    switch (rest.readiness?.next_action) {
      case "choose_workspace":
        return "添加 workspace";
      case "select_main_agent":
      case "activate_main_agent":
        return "添加并激活 main Agent";
      case "fix_main_agent":
        return "修复 main Agent";
      default:
        return "创建首个 Mission";
    }
  })();

  return (
    <div className="hairline-scroll min-w-0 flex-1 overflow-y-auto" data-testid="home">
      <div className="mx-auto max-w-2xl px-8 pb-16 pt-16">
        {/* 问候：日期 + 时段问候 + Q 的自我介绍 + 一句话状态 */}
        <div className="flex items-center gap-3.5">
          <span className="accent-grad grid h-11 w-11 shrink-0 place-items-center rounded-xl2 text-white shadow-sm">
            <Icon name="brand" size={20} />
          </span>
          <div className="min-w-0">
            <p className="text-[12.5px] text-faint" data-testid="home-date">
              {dateLine(now)}
            </p>
            <h1 className="mt-0.5 text-[22px] font-semibold tracking-tight" data-testid="home-greeting">
              {greetingForHour(now.getHours())}
            </h1>
          </div>
        </div>
        <p className="mt-4 text-[13.5px] leading-relaxed text-muted">
          我是 Q，你的本地工作伙伴。把目标变成 Mission，再由本地 Agent 执行和回报。
        </p>
        <p className="mt-1.5 text-[12.5px] text-faint" data-testid="home-summary">
          {setupMode ? "完成当前步骤后，就可以创建第一个 Mission。" : statusSummary(data)}
        </p>

        {setupMode ? (
          <div className="mt-9 rounded-xl2 border border-line bg-panel p-4" data-testid="home-next-action">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accentSoft text-accent">
                <Icon name="sparkle" size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[14px] font-semibold tracking-tight">{nextTitle}</h2>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
                  {rest.readiness?.workspace_valid
                    ? `当前 workspace：${rest.readiness.workspace}`
                    : "先选择一个真实 workspace，Mission 会在该目录下运行。"}
                </p>
                {nextError && (
                  <p className="mt-2 text-[12px] text-danger" role="alert">
                    {nextError}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={nextBusy}
                    onClick={() => void runNextAction()}
                    className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white hover:brightness-105 disabled:opacity-40"
                  >
                    {nextBusy ? <span className="spinner" /> : <Icon name="chevronRight" size={14} />}
                    {nextTitle}
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("agents")}
                    className="rounded-lg border border-line bg-paper px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
                  >
                    手动配置 Agents
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("settings")}
                    className="rounded-lg border border-line bg-paper px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
                  >
                    设置
                  </button>
                  <button
                    type="button"
                    disabled={nextBusy}
                    onClick={() => void deferSetup()}
                    className="px-2 py-1.5 text-[12.5px] text-muted hover:text-ink disabled:opacity-40"
                  >
                    稍后
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <>
        {!missionReady && rest.readiness && (
          <div className="mt-7 flex items-center gap-3 rounded-xl border border-warn/25 bg-warnSoft px-3.5 py-3 text-[12.5px] text-warnInk">
            <span className="min-w-0 flex-1">Mission 尚未就绪：{nextTitle}</span>
            <button
              type="button"
              onClick={() => void runNextAction()}
              className="shrink-0 rounded-md border border-warnInk/30 px-2.5 py-1 font-medium hover:opacity-80"
            >
              前往修复
            </button>
          </div>
        )}
        {/* 总览卡片（点击 → 对应页面） */}
        <div className="mt-9 grid grid-cols-2 gap-3">
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              onClick={() => openCard(card)}
              data-testid={`home-card-${card.id}`}
              className={`rounded-xl2 border p-4 text-left transition-colors ${
                card.attention
                  ? "accent-grad-soft border-accent/25 hover:border-accent/40"
                  : "border-line bg-panel hover:border-lineStrong"
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon
                  name={CARD_ICONS[card.id]}
                  size={14}
                  className={card.attention ? "text-accent" : "text-faint"}
                />
                <span className="text-[12.5px] text-muted">{card.title}</span>
                <span
                  className={`ml-auto text-[20px] font-semibold tabular-nums ${
                    card.attention ? "text-accent" : "text-ink"
                  }`}
                >
                  {card.count}
                </span>
              </div>
              <p className="mt-1.5 text-[12px] text-faint">{card.line}</p>
            </button>
          ))}
        </div>

        {/* Mission-first 快捷动作；快速对话仍在首页，但不冒充主工作流。 */}
        <div className="mt-9">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => navigate("missions")}
              className="accent-grad flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium text-white hover:brightness-105"
            >
              <Icon name="missions" size={14} />
              创建 Mission
            </button>
            <button
              type="button"
              onClick={() => (quickChatReady ? startQuickChat(onNew) : navigate("settings"))}
              className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-4 py-2 text-[13px] font-medium text-ink hover:border-lineStrong"
            >
              <Icon name={quickChatReady ? "plus" : "settings"} size={14} />
              {quickChatReady ? "开始快速对话" : "配置快速对话模型"}
            </button>
          </div>

          {recents.length > 0 && (
            <div className="mt-6">
              <p className="text-[11.5px] uppercase tracking-[0.06em] text-faint">最近会话</p>
              <div className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
                {recents.map((s) => (
                  <button
                    key={s.session_id}
                    type="button"
                    onClick={() => navigate(`assistant/${s.session_id}`)}
                    className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-paper"
                  >
                    <Icon name="assistant" size={13} className="shrink-0 text-faint" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{s.title || "新会话"}</span>
                    <span className="shrink-0 text-[11.5px] text-faint">
                      {formatSessionTime(s.updated_at)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
          </>
        )}
      </div>
    </div>
  );
}
