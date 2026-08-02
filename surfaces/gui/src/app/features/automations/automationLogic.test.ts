import { describe, expect, it } from "vitest";
import type { Automation, AutomationRun } from "../../lib/api/types";
import {
  blankDraft,
  draftFromAutomation,
  formatDateTime,
  formatDuration,
  humanizeCron,
  isRunActive,
  runStatusMeta,
  scheduleText,
  summarizePrompt,
  triggerLabel,
  validateCron,
  validateDraft,
} from "./automationLogic";

describe("humanizeCron", () => {
  it("humanizes the common cadences", () => {
    expect(humanizeCron("0 9 * * *")).toBe("每天 9:00");
    expect(humanizeCron("30 18 * * *")).toBe("每天 18:30");
    expect(humanizeCron("0 9 * * 1-5")).toBe("每工作日 9:00");
    expect(humanizeCron("0 9 * * 0,6")).toBe("每周末 9:00");
    expect(humanizeCron("0 9 * * 6,0")).toBe("每周末 9:00");
  });

  it("humanizes weekly and weekday-list crons", () => {
    expect(humanizeCron("0 9 * * 1")).toBe("每周一 9:00");
    expect(humanizeCron("0 9 * * 5")).toBe("每周五 9:00");
    expect(humanizeCron("0 9 * * 0")).toBe("每周日 9:00");
    expect(humanizeCron("0 9 * * 7")).toBe("每周日 9:00"); // 7 = Sunday too
    expect(humanizeCron("0 9 * * 1,3,5")).toBe("每周一、三、五 9:00");
  });

  it("humanizes minute/hour steps and monthly days", () => {
    expect(humanizeCron("* * * * *")).toBe("每分钟");
    expect(humanizeCron("*/15 * * * *")).toBe("每 15 分钟");
    expect(humanizeCron("0 * * * *")).toBe("每小时");
    expect(humanizeCron("5 * * * *")).toBe("每小时第 5 分");
    expect(humanizeCron("0 */2 * * *")).toBe("每 2 小时");
    expect(humanizeCron("0 9 */3 * *")).toBe("每 3 天 9:00");
    expect(humanizeCron("0 9 1 * *")).toBe("每月 1 日 9:00");
  });

  it("returns null for non-trivial crons (caller shows the raw expression)", () => {
    expect(humanizeCron("0 9 * 1 *")).toBeNull(); // month pinned
    expect(humanizeCron("0 9 1 * 1")).toBeNull(); // dom + dow both pinned
    expect(humanizeCron("0 9-17 * * *")).toBeNull(); // hour range
    expect(humanizeCron("0 9")).toBeNull(); // not 5 fields
    expect(humanizeCron("")).toBeNull();
    expect(humanizeCron(null)).toBeNull();
  });
});

describe("validateCron", () => {
  it("accepts standard 5-field expressions", () => {
    expect(validateCron("0 9 * * *")).toBeNull();
    expect(validateCron("*/15 9-17 1,15 * 1-5")).toBeNull();
    expect(validateCron("0 9 * * 7")).toBeNull(); // dow 7 = Sunday
    expect(validateCron("  0   9  *  *  *  ")).toBeNull(); // sloppy whitespace
  });

  it("rejects the wrong field count", () => {
    expect(validateCron("")).toContain("请填写");
    expect(validateCron("0 9 * *")).toContain("4 段");
    expect(validateCron("0 9 * * * *")).toContain("6 段");
  });

  it("rejects out-of-range numbers and garbage tokens", () => {
    expect(validateCron("60 9 * * *")).toContain("超出范围");
    expect(validateCron("0 24 * * *")).toContain("超出范围");
    expect(validateCron("0 9 0 * *")).toContain("超出范围");
    expect(validateCron("0 9 * 13 *")).toContain("超出范围");
    expect(validateCron("0 9 * * 8")).toContain("超出范围");
    expect(validateCron("0 9 * * mon")).toContain("无法识别");
    expect(validateCron("x * * * *")).toContain("无法识别");
    expect(validateCron("*/0 * * * *")).toContain("步长");
  });
});

describe("scheduleText", () => {
  const automation = (overrides: Partial<Automation>): Automation =>
    ({
      id: "task-1",
      title: "t",
      instructions: "i",
      schedule: "Every day at ~9:00 AM",
      schedule_raw: { kind: "cron", cron: "0 9 * * 1-5", timezone: "local" },
      workspace: "/tmp",
      agent: "cowork",
      enabled: true,
      next_run: null,
      last_run: null,
      last_status: null,
      run_count: 0,
      notify_on_completion: true,
      always_allowed: [],
      ...overrides,
    }) as Automation;

  it("humanizes a cron schedule from schedule_raw", () => {
    expect(scheduleText(automation({}))).toEqual({ text: "每工作日 9:00", raw: false });
  });

  it("falls back to the raw cron for non-trivial expressions", () => {
    const result = scheduleText(
      automation({ schedule_raw: { kind: "cron", cron: "0 9-17 * * *", timezone: "local" } }),
    );
    expect(result).toEqual({ text: "0 9-17 * * *", raw: true });
  });

  it("labels one-time tasks from fire_at", () => {
    const result = scheduleText(
      automation({ schedule_raw: { kind: "once", fire_at: "not-a-date" } }),
    );
    expect(result.text).toBe("单次 · not-a-date");
    expect(result.raw).toBe(false);
  });

  it("falls back to the backend's human string when no cron is available", () => {
    const result = scheduleText(automation({ schedule_raw: undefined }));
    expect(result).toEqual({ text: "Every day at ~9:00 AM", raw: false });
  });
});

describe("runStatusMeta / isRunActive / triggerLabel", () => {
  it("maps the backend statuses to Chinese badges", () => {
    expect(runStatusMeta("running")).toEqual({ label: "运行中", tone: "accent" });
    expect(runStatusMeta("ok")).toEqual({ label: "完成", tone: "ok" });
    expect(runStatusMeta("error")).toEqual({ label: "失败", tone: "danger" });
    expect(runStatusMeta("skipped")).toEqual({ label: "已跳过", tone: "muted" });
    expect(runStatusMeta("weird")).toEqual({ label: "weird", tone: "muted" });
  });

  it("only running runs are active", () => {
    expect(isRunActive({ status: "running" } as AutomationRun)).toBe(true);
    expect(isRunActive({ status: "ok" } as AutomationRun)).toBe(false);
  });

  it("labels triggers", () => {
    expect(triggerLabel("schedule")).toBe("定时");
    expect(triggerLabel("manual")).toBe("手动");
    expect(triggerLabel("catchup")).toBe("补跑");
  });
});

describe("formatDateTime", () => {
  // Local-time fixtures: 2026-08-01 15:30 is "now".
  const now = new Date(2026, 7, 1, 15, 30).getTime();
  const at = (y: number, mo: number, d: number, h: number, mi: number) =>
    new Date(y, mo, d, h, mi).getTime() / 1000;

  it("uses 今天 / 昨天 for recent times", () => {
    expect(formatDateTime(at(2026, 7, 1, 9, 5), now)).toBe("今天 09:05");
    expect(formatDateTime(at(2026, 6, 31, 23, 59), now)).toBe("昨天 23:59");
  });

  it("drops the year within the same year, keeps it across years", () => {
    expect(formatDateTime(at(2026, 0, 5, 8, 5), now)).toBe("1月5日 08:05");
    expect(formatDateTime(at(2025, 11, 31, 23, 5), now)).toBe("2025年12月31日 23:05");
  });

  it("renders missing times as —", () => {
    expect(formatDateTime(null, now)).toBe("—");
    expect(formatDateTime(0, now)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(100, 100)).toBe("0 秒");
    expect(formatDuration(100, 145)).toBe("45 秒");
    expect(formatDuration(0, 125)).toBe("2 分 5 秒");
    expect(formatDuration(0, 120)).toBe("2 分");
    expect(formatDuration(0, 3780)).toBe("1 小时 3 分");
    expect(formatDuration(0, 7200)).toBe("2 小时");
  });

  it("never goes negative", () => {
    expect(formatDuration(200, 100)).toBe("0 秒");
  });
});

describe("summarizePrompt", () => {
  it("collapses whitespace into one line", () => {
    expect(summarizePrompt("  整理今天的\n日程   和邮件 ")).toBe("整理今天的 日程 和邮件");
  });

  it("truncates long prompts with an ellipsis", () => {
    const long = "字".repeat(100);
    const summary = summarizePrompt(long, 80);
    expect(summary).toHaveLength(81);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("drafts + validateDraft", () => {
  const automation = {
    id: "task-1",
    title: "晨报",
    instructions: "整理日程",
    schedule: "Every day at ~9:00 AM",
    schedule_raw: { kind: "cron", cron: "0 9 * * *", timezone: "local" },
    workspace: "/tmp",
    agent: "cowork",
    enabled: false,
    next_run: null,
    last_run: null,
    last_status: null,
    run_count: 0,
    notify_on_completion: true,
    always_allowed: [],
  } as Automation;

  it("prefills a draft from an existing automation", () => {
    expect(draftFromAutomation(automation)).toEqual({
      title: "晨报",
      instructions: "整理日程",
      cron: "0 9 * * *",
      enabled: false,
    });
  });

  it("requires a title and instructions", () => {
    expect(validateDraft(blankDraft())).toBe("请填写名称");
    expect(validateDraft({ ...blankDraft(), title: "x" })).toBe("请填写指令");
    expect(validateDraft({ ...blankDraft(), title: "x", instructions: "y" })).toBeNull();
  });

  it("validates the cron unless the task is one-time", () => {
    const draft = { ...blankDraft(), title: "x", instructions: "y", cron: "bad" };
    expect(validateDraft(draft)).toContain("5 段");
    expect(validateDraft(draft, true)).toBeNull();
  });
});
