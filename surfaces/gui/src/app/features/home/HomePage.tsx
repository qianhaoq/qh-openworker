// 伙伴桌面 — the assistant home (the default page when no session is selected): a
// time-aware greeting from Q, four overview cards that navigate to their surfaces, a
// primary 开始新会话, and up to three recent sessions as quiet rows. All aggregation
// lives in homeLogic.ts; this file is data wiring + layout.

import { useEffect, useState } from "react";
import { listAgentPermissions } from "../../lib/api/agents";
import { getAutomations } from "../../lib/api/automations";
import { getInbox } from "../../lib/api/inbox";
import { listMissions } from "../../lib/api/missions";
import type { Automation, Mission, Session } from "../../lib/api/types";
import { Icon, type IconName } from "../../components/Icon";
import { navigate } from "../../nav";
import { formatSessionTime } from "../assistant/SessionListPanel";
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
}

// 待处理计数 = 收件箱 pending + ACP 权限请求 (the sidebar badge's 口径, App.tsx:31).
const loadApprovals = (): Promise<number> =>
  Promise.all([getInbox(undefined, "pending"), listAgentPermissions(true)]).then(
    ([items, permissions]) => items.length + permissions.length,
  );

export function HomePage({ sessions, onNew }: { sessions: Session[]; onNew: () => void }) {
  const [rest, setRest] = useState<HomeRest>({ approvals: 0, missions: [], automations: [] });

  // Sessions arrive live from AssistantPage's poll; the other three surfaces refresh on
  // a slow cadence — the home is a glance, not a dashboard.
  useEffect(() => {
    let stale = false;
    const load = () =>
      Promise.all([
        loadApprovals().catch(() => 0),
        listMissions().catch(() => [] as Mission[]),
        getAutomations().catch(() => [] as Automation[]),
      ]).then(([approvals, missions, automations]) => {
        if (!stale) setRest({ approvals, missions, automations });
      });
    load();
    const timer = setInterval(load, 15000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, []);

  const now = new Date();
  const data: HomeData = {
    sessions,
    pendingApprovals: rest.approvals,
    missions: rest.missions,
    automations: rest.automations,
  };
  const cards = deriveCards(data, now);
  const recents = recentSessions(sessions, 3);

  const openCard = (card: HomeCard) => {
    // 今日会话 has no page of its own — land on the most recent conversation of the day.
    if (card.id === "sessions" && card.count > 0) {
      const latest = recentSessions(todaySessions(sessions, now), 1)[0];
      if (latest) {
        navigate(`assistant/${latest.session_id}`);
        return;
      }
    }
    navigate(card.route);
  };

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
          我是 Q，你的本地工作伙伴。今天想从哪开始？
        </p>
        <p className="mt-1.5 text-[12.5px] text-faint" data-testid="home-summary">
          {statusSummary(data)}
        </p>

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

        {/* 快捷动作 */}
        <div className="mt-9">
          <button
            type="button"
            onClick={onNew}
            className="accent-grad flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-medium text-white hover:brightness-105"
          >
            <Icon name="plus" size={14} />
            开始新会话
          </button>

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
      </div>
    </div>
  );
}
