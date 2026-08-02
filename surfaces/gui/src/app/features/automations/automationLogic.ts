// Pure logic for the Automations page: cron humanizing (Chinese) + validation, run
// status/trigger presentation, time formatting, prompt summaries, editor drafts and
// quick-start templates. No React, no API — everything here is unit-testable.

import type { Automation, AutomationRun } from "../../lib/api/types";

// ---------------------------------------------------------------------------
// Schedule: cron humanize + validate
// ---------------------------------------------------------------------------

export interface SchedulePreset {
  key: string;
  label: string;
  cron: string;
}

// The editor's shortcut chips; 自定义 cron stays a free-text input.
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { key: "hourly", label: "每小时", cron: "0 * * * *" },
  { key: "daily", label: "每天早上", cron: "0 9 * * *" },
  { key: "weekdays", label: "每工作日", cron: "0 9 * * 1-5" },
  { key: "monday", label: "每周一", cron: "0 9 * * 1" },
];

const DOW_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** "9:00" — no leading zero on the hour, matching the mocks' quiet style. */
const hhmm = (hour: number, minute: number): string => `${hour}:${String(minute).padStart(2, "0")}`;

const isDigits = (field: string): boolean => /^\d+$/.test(field);

/**
 * Humanize a 5-field cron into Chinese (每工作日 9:00). Returns null for anything
 * unrecognized — the caller then shows the raw cron in SF Mono.
 */
export function humanizeCron(cron: string | null | undefined): string | null {
  const parts = (cron ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;

  if (month !== "*") return null;

  // 每分钟 / 每 n 分钟
  if (hour === "*" && dom === "*" && dow === "*") {
    if (minute === "*") return "每分钟";
    const every = /^\*\/(\d+)$/.exec(minute);
    if (every) {
      const n = Number(every[1]);
      if (n > 1 && n < 60) return `每 ${n} 分钟`;
    }
  }

  // 每小时 / 每 n 小时 / 每小时第 m 分
  if (dom === "*" && dow === "*" && isDigits(minute)) {
    const m = Number(minute);
    if (hour === "*") return m === 0 ? "每小时" : `每小时第 ${m} 分`;
    const hourStep = /^\*\/(\d+)$/.exec(hour);
    if (hourStep && m === 0) {
      const n = Number(hourStep[1]);
      if (n > 1 && n < 24) return `每 ${n} 小时`;
    }
  }

  // Everything below pins a concrete time of day.
  if (!isDigits(minute) || !isDigits(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  const time = hhmm(h, m);

  if (dow === "*") {
    if (dom === "*") return `每天 ${time}`;
    const domStep = /^\*\/(\d+)$/.exec(dom);
    if (domStep) {
      const n = Number(domStep[1]);
      if (n > 1 && n <= 31) return `每 ${n} 天 ${time}`;
      return null;
    }
    if (isDigits(dom)) return `每月 ${Number(dom)} 日 ${time}`;
    return null;
  }

  if (dom !== "*") return null;
  if (dow === "1-5") return `每工作日 ${time}`;
  if (dow === "0,6" || dow === "6,0") return `每周末 ${time}`;
  if (isDigits(dow)) {
    const d = Number(dow);
    if (d >= 0 && d <= 7) return `每周${DOW_CN[d % 7]} ${time}`;
    return null;
  }
  // A small weekday list (1,3,5) → 每周一、三、五
  if (/^\d(,\d)+$/.test(dow)) {
    const days = dow.split(",").map(Number);
    if (days.every((d) => d >= 0 && d <= 7)) {
      return `每周${days.map((d) => DOW_CN[d % 7]).join("、")} ${time}`;
    }
  }
  return null;
}

// Per-field numeric bounds (分 时 日 月 周); dow accepts 0–7 (both 0 and 7 = Sunday).
const CRON_BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const CRON_FIELD_NAMES = ["分", "时", "日", "月", "周"];

/**
 * A "valid-looking" client-side cron check (the backend's croniter stays authoritative):
 * exactly 5 fields, each a comma list of `*`, `*\/n`, `a`, `a-b`, `a-b/n`, `a/n`,
 * with every number inside the field's bounds. Returns a Chinese error or null.
 */
export function validateCron(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return "请填写 cron 表达式";
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return `cron 需要 5 段（分 时 日 月 周），当前是 ${parts.length} 段`;
  for (let i = 0; i < 5; i += 1) {
    const field = parts[i];
    const [lo, hi] = CRON_BOUNDS[i];
    for (const token of field.split(",")) {
      if (!/^\*$|^\*\/\d+$|^\d+$|^\d+-\d+$|^\d+-\d+\/\d+$|^\d+\/\d+$/.test(token)) {
        return `第 ${i + 1} 段（${CRON_FIELD_NAMES[i]}）的「${token}」无法识别`;
      }
      const numbers = token.match(/\d+/g)?.map(Number) ?? [];
      // A step's own value (/n) only needs n ≥ 1; the rest must sit inside bounds.
      const stepValue = token.includes("/") ? numbers[numbers.length - 1] : null;
      const ranged = stepValue !== null ? numbers.slice(0, -1) : numbers;
      if (stepValue !== null && stepValue < 1) {
        return `第 ${i + 1} 段（${CRON_FIELD_NAMES[i]}）的步长不能为 0`;
      }
      if (ranged.some((n) => n < lo || n > hi)) {
        return `第 ${i + 1} 段（${CRON_FIELD_NAMES[i]}）超出范围（${lo}–${hi}）`;
      }
    }
  }
  return null;
}

/** What the list row / editor shows for an automation's schedule. */
export function scheduleText(automation: Automation): { text: string; raw: boolean } {
  const raw = automation.schedule_raw;
  if (raw?.kind === "once") {
    const fire = raw.fire_at ? new Date(raw.fire_at) : null;
    const when = fire && !Number.isNaN(fire.getTime()) ? formatDateTime(fire.getTime() / 1000) : raw.fire_at;
    return { text: `单次 · ${when ?? "未安排"}`, raw: false };
  }
  const cron = raw?.cron ?? null;
  const human = humanizeCron(cron);
  if (human) return { text: human, raw: false };
  if (cron) return { text: cron, raw: true };
  return { text: automation.schedule || "—", raw: false };
}

// ---------------------------------------------------------------------------
// Runs: status / trigger presentation
// ---------------------------------------------------------------------------

export type RunTone = "accent" | "ok" | "danger" | "muted";

export interface RunStatusMeta {
  label: string;
  tone: RunTone;
}

// TaskRun.status: running | ok | error | skipped (coworker/automation/models.py).
export function runStatusMeta(status: string): RunStatusMeta {
  switch (status) {
    case "running":
      return { label: "运行中", tone: "accent" };
    case "ok":
      return { label: "完成", tone: "ok" };
    case "error":
      return { label: "失败", tone: "danger" };
    case "skipped":
      return { label: "已跳过", tone: "muted" };
    default:
      return { label: status || "未知", tone: "muted" };
  }
}

/** A run the page should keep polling for. */
export const isRunActive = (run: Pick<AutomationRun, "status">): boolean => run.status === "running";

// TaskRun.trigger: schedule | manual | catchup.
export function triggerLabel(trigger: string): string {
  switch (trigger) {
    case "schedule":
      return "定时";
    case "manual":
      return "手动";
    case "catchup":
      return "补跑";
    default:
      return trigger || "—";
  }
}

// ---------------------------------------------------------------------------
// Time formatting (epoch seconds in, quiet Chinese strings out)
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, "0");

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 今天 09:30 / 昨天 09:30 / 8月1日 09:30 / 2025年8月1日 09:30. `nowMs` is injectable for tests. */
export function formatDateTime(epochSecs: number | null | undefined, nowMs?: number): string {
  if (!epochSecs) return "—";
  const date = new Date(epochSecs * 1000);
  const now = new Date(nowMs ?? Date.now());
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (sameDay(date, now)) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

/** 45 秒 / 2 分 5 秒 / 1 小时 3 分. Runs under a second read as 0 秒. */
export function formatDuration(startSecs: number, endSecs: number): string {
  const total = Math.max(0, Math.round(endSecs - startSecs));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

// ---------------------------------------------------------------------------
// Prompt summary + editor drafts
// ---------------------------------------------------------------------------

/** One quiet line for the list row: whitespace collapsed, truncated with an ellipsis. */
export function summarizePrompt(instructions: string, max = 80): string {
  const flat = instructions.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max).trimEnd()}…`;
}

export interface AutomationDraft {
  title: string;
  instructions: string;
  cron: string;
  enabled: boolean;
}

export const blankDraft = (): AutomationDraft => ({
  title: "",
  instructions: "",
  cron: "0 9 * * *",
  enabled: true,
});

export const draftFromAutomation = (automation: Automation): AutomationDraft => ({
  title: automation.title,
  instructions: automation.instructions,
  cron: automation.schedule_raw?.cron ?? "",
  enabled: automation.enabled,
});

/** 一次性任务没有 cron 可编辑 — skip cron validation for them. */
export function validateDraft(draft: AutomationDraft, isOnce = false): string | null {
  if (!draft.title.trim()) return "请填写名称";
  if (!draft.instructions.trim()) return "请填写指令";
  if (!isOnce) return validateCron(draft.cron);
  return null;
}

// ---------------------------------------------------------------------------
// Quick-start templates (the empty state + "从模板开始" shortcuts)
// ---------------------------------------------------------------------------

export interface QuickStart {
  key: string;
  title: string;
  description: string;
  cron: string;
  instructions: string;
}

export const QUICK_STARTS: QuickStart[] = [
  {
    key: "morning-brief",
    title: "每日晨报",
    description: "每天早上整理日程与未读邮件，生成一份简短晨报。",
    cron: "0 8 * * *",
    instructions:
      "整理今天的日程安排和昨晚以来的未读邮件，生成一份简短的中文晨报，保存为 markdown 文件。",
  },
  {
    key: "news",
    title: "每日新闻简报",
    description: "搜索过去 24 小时的要闻，写成 5 条要点。",
    cron: "0 8 * * *",
    instructions:
      "搜索过去 24 小时最重要的科技与世界新闻，写成 5 条要点的中文简报，保存为 markdown 文件。",
  },
  {
    key: "weekly-review",
    title: "每周复盘",
    description: "周五傍晚回顾本周工作，整理成一份周报。",
    cron: "0 18 * * 5",
    instructions:
      "回顾本周的工作文件与笔记，总结本周完成的事项和下周待办，保存为一份中文周报 markdown。",
  },
  {
    key: "downloads-cleanup",
    title: "下载整理",
    description: "每周五整理下载文件夹，按类型归类。",
    cron: "30 17 * * 5",
    instructions: "整理下载文件夹：按文件类型归类到子文件夹，重复文件标记出来，并输出一份整理报告。",
  },
];

export const draftFromQuickStart = (template: QuickStart): AutomationDraft => ({
  title: template.title,
  instructions: template.instructions,
  cron: template.cron,
  enabled: true,
});
