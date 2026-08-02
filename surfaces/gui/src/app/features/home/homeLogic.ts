// 伙伴桌面 (the assistant home) — pure derivation: the time-aware greeting, the date
// line, the four overview cards (待处理审批 / 进行中的任务 / 今日会话 / 自动化动态), the
// one-line status summary, and the recent-session picks. No React, no fetching — the
// page wires real API data in; every function here is unit-tested in homeLogic.test.ts.

import type { Automation, Mission, Session } from "../../lib/api/types";
import { isMissionRunning } from "../missions/missionLogic";

/** Everything the home needs, already fetched by the page. */
export interface HomeData {
  sessions: Session[];
  /** 收件箱 pending + ACP 权限请求 (the same 口径 as the sidebar inbox badge). */
  pendingApprovals: number;
  missions: Mission[];
  automations: Automation[];
}

export type HomeCardId = "approvals" | "missions" | "sessions" | "automations";

export interface HomeCard {
  id: HomeCardId;
  title: string;
  count: number;
  /** The quiet line under the count — zero states read as "没有待处理的事" style. */
  line: string;
  /** true = the card wants your action and gets the accent tint. */
  attention: boolean;
  route: string;
}

// ---------------------------------------------------------------------------
// Greeting + date
// ---------------------------------------------------------------------------

/** 早上好 (5–11) / 下午好 (12–17) / 晚上好 (18–4). */
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "早上好";
  if (hour >= 12 && hour < 18) return "下午好";
  return "晚上好";
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** "8月2日 星期六". */
export function dateLine(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 星期${WEEKDAYS[date.getDay()]}`;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// The server's updated_at is "YYYY-MM-DD HH:mm:ss" (or an epoch fallback) — the same
// parse the session list panel uses.
const sessionTs = (s: Session): number => Date.parse(s.updated_at || "") || Number(s.updated_at) || 0;

/** Run/ephemeral sessions stay out of the home, exactly like the session list. */
const isListed = (s: Session): boolean => !!s.session_id && !s.session_id.startsWith("__");

/** Sessions touched today (local day), archived included — they were still worked on. */
export function todaySessions(sessions: Session[], now: Date): Session[] {
  const day = now.toDateString();
  return sessions.filter((s) => {
    if (!isListed(s)) return false;
    const ts = sessionTs(s);
    return ts > 0 && new Date(ts).toDateString() === day;
  });
}

/** Total unseen automation runs (the sidebar badge's 口径: sum of per-task unseen). */
export function unseenRuns(automations: Automation[]): number {
  return automations.reduce((sum, a) => sum + (a.unseen_runs ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** The four overview cards, in display order. Counts are always shown — zero states
 *  stay quiet ("没有待处理的事" style); only cards that need your action tint accent. */
export function deriveCards(data: HomeData, now: Date): HomeCard[] {
  const running = data.missions.filter((m) => isMissionRunning(m.state)).length;
  const today = todaySessions(data.sessions, now).length;
  const unseen = unseenRuns(data.automations);
  const approvals = Math.max(0, data.pendingApprovals);
  return [
    {
      id: "approvals",
      title: "待处理审批",
      count: approvals,
      line: approvals > 0 ? `${approvals} 项等你处理` : "没有待处理的事",
      attention: approvals > 0,
      route: "inbox",
    },
    {
      id: "missions",
      title: "进行中的任务",
      count: running,
      line: running > 0 ? `${running} 个任务正在进行` : "此刻没有进行中的任务",
      attention: false,
      route: "missions",
    },
    {
      id: "sessions",
      title: "今日会话",
      count: today,
      line: today > 0 ? `今天 ${today} 个会话有更新` : "今天还没有会话",
      attention: false,
      route: "assistant",
    },
    {
      id: "automations",
      title: "自动化动态",
      count: unseen,
      line: unseen > 0 ? `${unseen} 次运行还没看过` : "自动化暂无新动态",
      attention: unseen > 0,
      route: "automations",
    },
  ];
}

// ---------------------------------------------------------------------------
// Summary + recents
// ---------------------------------------------------------------------------

/** One-line status summary under the greeting — mentions only what needs saying. */
export function statusSummary(data: HomeData): string {
  const approvals = Math.max(0, data.pendingApprovals);
  const running = data.missions.filter((m) => isMissionRunning(m.state)).length;
  const unseen = unseenRuns(data.automations);
  if (approvals > 0) return `有 ${approvals} 项审批在等你，处理完就清爽了。`;
  if (running > 0) return `${running} 个任务正在进行，我在这儿盯着。`;
  if (unseen > 0) return `自动化有 ${unseen} 次新动态，得空可以看看。`;
  return "没有待处理的事，今天想从哪开始？";
}

/** The most recently updated conversations (newest first), for the quiet quick rows. */
export function recentSessions(sessions: Session[], limit = 3): Session[] {
  return sessions
    .filter((s) => isListed(s) && !s.archived)
    .sort((a, b) => sessionTs(b) - sessionTs(a))
    .slice(0, limit);
}
