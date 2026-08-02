import { describe, expect, it } from "vitest";
import type { Automation, Mission, Session } from "../../lib/api/types";
import {
  dateLine,
  deriveCards,
  greetingForHour,
  recentSessions,
  statusSummary,
  todaySessions,
  unseenRuns,
  type HomeData,
} from "./homeLogic";

const session = (id: string, updated_at: string, extra: Partial<Session> = {}): Session => ({
  session_id: id,
  title: id,
  workspace: "",
  agent: "cowork",
  model: "m",
  mode: "interactive",
  updated_at,
  messages: 1,
  ...extra,
});

const mission = (state: string): Mission => ({ mission_id: `m-${state}`, state }) as Mission;

const automation = (unseen_runs: number): Automation =>
  ({ id: `t-${unseen_runs}`, unseen_runs }) as Automation;

// 2026-08-02 is a Sunday; local-time based so the "today" filters line up with `now`.
const NOW = new Date(2026, 7, 2, 10, 30);

const empty: HomeData = { sessions: [], pendingApprovals: 0, missions: [], automations: [] };

describe("greetingForHour", () => {
  it("早上好 from 5:00 to 11:59", () => {
    expect(greetingForHour(5)).toBe("早上好");
    expect(greetingForHour(9)).toBe("早上好");
    expect(greetingForHour(11)).toBe("早上好");
  });
  it("下午好 from 12:00 to 17:59", () => {
    expect(greetingForHour(12)).toBe("下午好");
    expect(greetingForHour(17)).toBe("下午好");
  });
  it("晚上好 from 18:00 through the small hours", () => {
    expect(greetingForHour(18)).toBe("晚上好");
    expect(greetingForHour(23)).toBe("晚上好");
    expect(greetingForHour(0)).toBe("晚上好");
    expect(greetingForHour(4)).toBe("晚上好");
  });
});

describe("dateLine", () => {
  it("formats month/day + weekday in Chinese", () => {
    expect(dateLine(new Date(2026, 7, 2))).toBe("8月2日 星期日");
    expect(dateLine(new Date(2026, 0, 1))).toBe("1月1日 星期四");
  });
});

describe("todaySessions", () => {
  it("keeps only listed sessions whose updated_at falls on the local day", () => {
    const list = [
      session("a", "2026-08-02 09:00:00"),
      session("b", "2026-08-01 23:59:00"),
      session("c", "2026-08-02 00:01:00", { archived: true }), // archived still counts
      session("__run__r1", "2026-08-02 08:00:00"), // ephemeral run sessions stay out
      session("d", null as unknown as string), // unparseable stays out
    ];
    expect(todaySessions(list, NOW).map((s) => s.session_id)).toEqual(["a", "c"]);
  });
});

describe("unseenRuns", () => {
  it("sums per-task unseen counts, tolerating a missing field", () => {
    expect(unseenRuns([automation(2), automation(0), {} as Automation])).toBe(2);
    expect(unseenRuns([])).toBe(0);
  });
});

describe("deriveCards", () => {
  it("zero state: quiet lines, no attention", () => {
    const cards = deriveCards(empty, NOW);
    expect(cards.map((c) => c.id)).toEqual(["approvals", "missions", "sessions", "automations"]);
    for (const c of cards) {
      expect(c.count).toBe(0);
      expect(c.attention).toBe(false);
    }
    expect(cards[0].line).toBe("没有待处理的事");
    expect(cards[1].line).toBe("此刻没有进行中的任务");
    expect(cards[2].line).toBe("今天还没有会话");
    expect(cards[3].line).toBe("自动化暂无新动态");
  });

  it("counts approvals / running missions / today's sessions / unseen runs", () => {
    const data: HomeData = {
      sessions: [session("a", "2026-08-02 09:00:00"), session("b", "2026-08-02 10:00:00")],
      pendingApprovals: 3,
      missions: [
        mission("IMPLEMENTING"),
        mission("QUEUED"),
        mission("AWAITING_CONFIRMATION"), // attention ≠ running
        mission("DONE"),
      ],
      automations: [automation(2)],
    };
    const cards = deriveCards(data, NOW);
    expect(cards[0]).toMatchObject({ count: 3, attention: true, route: "inbox" });
    expect(cards[1]).toMatchObject({ count: 2, attention: false, route: "missions" });
    expect(cards[2]).toMatchObject({ count: 2, attention: false, route: "assistant" });
    expect(cards[3]).toMatchObject({ count: 2, attention: true, route: "automations" });
    expect(cards[0].line).toBe("3 项等你处理");
  });

  it("clamps a negative approvals count defensively", () => {
    expect(deriveCards({ ...empty, pendingApprovals: -1 }, NOW)[0].count).toBe(0);
  });
});

describe("statusSummary", () => {
  it("leads with approvals when anything waits", () => {
    const data: HomeData = { ...empty, pendingApprovals: 2, missions: [mission("QUEUED")] };
    expect(statusSummary(data)).toBe("有 2 项审批在等你，处理完就清爽了。");
  });
  it("mentions running missions next", () => {
    expect(statusSummary({ ...empty, missions: [mission("VERIFYING")] })).toBe(
      "1 个任务正在进行，我在这儿盯着。",
    );
  });
  it("then unseen automation runs", () => {
    expect(statusSummary({ ...empty, automations: [automation(1)] })).toBe(
      "自动化有 1 次新动态，得空可以看看。",
    );
  });
  it("falls back to the quiet line", () => {
    expect(statusSummary(empty)).toBe("没有待处理的事，今天想从哪开始？");
  });
});

describe("recentSessions", () => {
  it("newest first, archived and run sessions excluded, capped", () => {
    const list = [
      session("old", "2026-07-01 09:00:00"),
      session("new", "2026-08-02 09:00:00"),
      session("mid", "2026-07-15 09:00:00"),
      session("archived", "2026-08-02 10:00:00", { archived: true }),
      session("__run__r2", "2026-08-02 11:00:00"),
      session("extra", "2026-07-02 09:00:00"),
    ];
    expect(recentSessions(list, 3).map((s) => s.session_id)).toEqual(["new", "mid", "extra"]);
    expect(recentSessions(list, 2)).toHaveLength(2);
  });
});
