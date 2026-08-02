import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../lib/api/types";
import { formatSessionTime, sessionRowMeta, visibleSessions } from "./SessionListPanel";

const session = (over: Partial<Session>): Session => ({
  session_id: "s",
  workspace: "/w",
  agent: "cowork",
  model: "gpt-5",
  mode: "interactive",
  updated_at: null,
  messages: 0,
  ...over,
});

describe("visibleSessions", () => {
  const list = [
    session({ session_id: "run-1", title: "自动化运行" }),
    session({ session_id: "__run__abc", title: "临时运行" }), // ephemeral — always hidden
    session({ session_id: "old", title: "旧会话", updated_at: "2026-07-01T10:00:00Z" }),
    session({ session_id: "new", title: "新讨论", updated_at: "2026-07-02T10:00:00Z" }),
    session({ session_id: "pin", title: "置顶", pinned: true, updated_at: "2026-06-01T10:00:00Z" }),
    session({ session_id: "arch", title: "已归档", archived: true, updated_at: "2026-07-03T10:00:00Z" }),
  ];

  it("hides archived + __run__ sessions by default, pinned first then most recent", () => {
    const ids = visibleSessions(list, "", false).map((s) => s.session_id);
    expect(ids).toEqual(["pin", "new", "old", "run-1"]);
  });

  it("shows archived sessions when asked (still not __run__)", () => {
    const ids = visibleSessions(list, "", true).map((s) => s.session_id);
    expect(ids).toEqual(["pin", "arch", "new", "old", "run-1"]);
  });

  it("filters by title / workspace / id, case-insensitively", () => {
    expect(visibleSessions(list, "新讨论", false).map((s) => s.session_id)).toEqual(["new"]);
    expect(visibleSessions(list, "/W", false)).toHaveLength(4);
    expect(visibleSessions(list, "PIN", false).map((s) => s.session_id)).toEqual(["pin"]);
    expect(visibleSessions(list, "不存在的", false)).toEqual([]);
  });
});

describe("sessionRowMeta", () => {
  it("mutes archived rows and tags them 已归档; live rows render normally", () => {
    expect(sessionRowMeta(session({ archived: true }))).toEqual({ muted: true, tag: "已归档" });
    expect(sessionRowMeta(session({ archived: false }))).toEqual({ muted: false, tag: null });
    expect(sessionRowMeta(session({}))).toEqual({ muted: false, tag: null });
  });
});

describe("formatSessionTime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats today as HH:MM, yesterday as 昨天, this year as M月d日, older with the year", () => {
    // Pin "now" to 2026-08-01 15:00 local; dates are built locally so the test is tz-safe.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 1, 15, 0, 0));

    expect(formatSessionTime(new Date(2026, 7, 1, 9, 5).toISOString())).toMatch(/^\d{2}:\d{2}$/);
    expect(formatSessionTime(new Date(2026, 6, 31, 9, 5).toISOString())).toBe("昨天");
    expect(formatSessionTime(new Date(2026, 2, 10, 9, 5).toISOString())).toBe("3月10日");
    expect(formatSessionTime(new Date(2024, 2, 2, 10, 0).toISOString())).toBe("2024/3/2");
  });

  it("returns empty for missing or unparseable stamps", () => {
    expect(formatSessionTime(null)).toBe("");
    expect(formatSessionTime("not-a-date")).toBe("");
  });
});
