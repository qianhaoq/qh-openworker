// Smoke tests for the Automations page wiring: empty state + quick-start, list rows
// (schedule humanized, last status, unseen pill, enable toggle), editor open +
// validation + inline delete confirm, run history expansion, 立即运行. The data hook
// is mocked; the pure logic is covered in automationLogic.test.ts.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Automation, AutomationRun } from "../../lib/api/types";
import { AutomationsPage } from "./AutomationsPage";

const base: Automation = {
  id: "task-1",
  title: "每日晨报",
  instructions: "整理今天的日程和未读邮件，生成一份简短晨报。",
  schedule: "Every day at ~9:00 AM",
  schedule_raw: { kind: "cron", cron: "0 9 * * 1-5", timezone: "local" },
  workspace: "/tmp/scratch/task-1",
  agent: "cowork",
  enabled: true,
  next_run: null,
  last_run: null,
  last_status: "ok",
  run_count: 3,
  notify_on_completion: true,
  unseen_runs: 2,
  unseen_failed: true,
  always_allowed: [],
};

const paused: Automation = {
  ...base,
  id: "task-2",
  title: "下载整理",
  schedule_raw: { kind: "cron", cron: "0 9-17 * * *", timezone: "local" }, // 无法口语化 → 原样
  enabled: false,
  last_status: null,
  unseen_runs: 0,
  unseen_failed: false,
};

const okRun: AutomationRun = {
  run_id: "run-1",
  task_id: "task-1",
  session_id: "__run__run-1",
  started_at: 1000,
  finished_at: 1125,
  status: "ok",
  result_text: "晨报已生成。",
  artifacts: ["brief.md"],
  error: null,
  trigger: "schedule",
};

const runningRun: AutomationRun = {
  ...okRun,
  run_id: "run-2",
  session_id: "__run__run-2",
  finished_at: null,
  status: "running",
  result_text: null,
  artifacts: [],
  trigger: "manual",
};

const failedRun: AutomationRun = {
  ...okRun,
  run_id: "run-3",
  session_id: "__run__run-3",
  finished_at: 1090,
  status: "error",
  result_text: null,
  error: "provider timeout",
  artifacts: [],
};

interface MockController {
  automations: Automation[];
  loading: boolean;
  loadError: string | null;
  busyIds: ReadonlySet<string>;
  expandedId: string | null;
  runs: AutomationRun[];
  runsLoading: boolean;
  refresh: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  runNow: ReturnType<typeof vi.fn>;
  toggleRuns: ReturnType<typeof vi.fn>;
}

const controller = (overrides: Partial<MockController> = {}): MockController => ({
  automations: [],
  loading: false,
  loadError: null,
  busyIds: new Set(),
  expandedId: null,
  runs: [],
  runsLoading: false,
  refresh: vi.fn(async () => {}),
  setEnabled: vi.fn(async () => ({ ok: true })),
  create: vi.fn(async () => ({ ok: true })),
  update: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
  runNow: vi.fn(async () => ({ ok: true })),
  toggleRuns: vi.fn(),
  ...overrides,
});

let mock = controller();

vi.mock("./useAutomations", () => ({
  useAutomations: () => mock,
}));

afterEach(cleanup);

describe("AutomationsPage", () => {
  it("shows the quick-start empty state and opens a prefilled create drawer", () => {
    mock = controller();
    render(<AutomationsPage />);
    expect(screen.getByText("创建你的第一个自动化")).toBeTruthy();
    fireEvent.click(screen.getByText("每日新闻简报"));
    // Drawer opens with the template prefilled (title in the header, cron in the input).
    const dialog = screen.getByRole("dialog", { name: "新建自动化" });
    const cronInput = screen.getByPlaceholderText("0 9 * * *") as HTMLInputElement;
    expect(cronInput.value).toBe("0 8 * * *");
    expect(within(dialog).getByText("每天 8:00")).toBeTruthy(); // humanized preview
  });

  it("renders rows with humanized schedule, raw cron fallback, status and unseen pills", () => {
    mock = controller({ automations: [base, paused] });
    render(<AutomationsPage />);
    expect(screen.getByText("每日晨报")).toBeTruthy();
    expect(screen.getByText("每工作日 9:00")).toBeTruthy(); // humanized cron
    expect(screen.getByText("0 9-17 * * *")).toBeTruthy(); // raw fallback
    expect(screen.getByText("完成")).toBeTruthy(); // last_status badge
    expect(screen.getByText("2 条新记录")).toBeTruthy(); // unseen pill
    expect(screen.getByText("已暂停", { exact: false })).toBeTruthy();
    const toggles = screen.getAllByRole("switch");
    expect(toggles.map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    fireEvent.click(toggles[1]); // 停用 → 启用
    expect(mock.setEnabled).toHaveBeenCalledWith(paused, true);
  });

  it("opens the editor on row click, validates, and confirms delete inline", () => {
    mock = controller({ automations: [base] });
    render(<AutomationsPage />);
    fireEvent.click(screen.getByText("每日晨报"));
    expect(screen.getByRole("dialog", { name: "编辑 每日晨报" })).toBeTruthy();
    // Empty title → inline validation error, save stays local.
    const titleInput = screen.getByPlaceholderText("每日晨报") as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: " " } });
    fireEvent.click(screen.getByText("保存"));
    expect(screen.getByText("请填写名称")).toBeTruthy();
    expect(mock.update).not.toHaveBeenCalled();
    // Two-step delete.
    fireEvent.click(screen.getByText("删除"));
    fireEvent.click(screen.getByText("确认删除"));
    expect(mock.remove).toHaveBeenCalledWith("task-1");
  });

  it("applies a schedule preset chip in the editor", () => {
    mock = controller({ automations: [base] });
    render(<AutomationsPage />);
    fireEvent.click(screen.getByText("每日晨报"));
    fireEvent.click(screen.getByText("每小时"));
    const cronInput = screen.getByPlaceholderText("0 9 * * *") as HTMLInputElement;
    expect(cronInput.value).toBe("0 * * * *");
  });

  it("expands the run history with status badges, duration and error", () => {
    mock = controller({
      automations: [base],
      expandedId: "task-1",
      runs: [runningRun, failedRun, okRun],
    });
    render(<AutomationsPage />);
    fireEvent.click(screen.getByRole("button", { name: /运行记录/ }));
    expect(mock.toggleRuns).toHaveBeenCalledWith(base);
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("进行中…")).toBeTruthy();
    expect(screen.getByText("用时 2 分 5 秒")).toBeTruthy();
    expect(screen.getByText("provider timeout")).toBeTruthy();
    expect(screen.getByText("晨报已生成。")).toBeTruthy();
    expect(screen.getByText("1 个文件")).toBeTruthy();
    expect(screen.getByText("手动")).toBeTruthy(); // trigger label
  });

  it("shows the empty runs note", () => {
    mock = controller({ automations: [base], expandedId: "task-1", runs: [] });
    render(<AutomationsPage />);
    expect(screen.getByText("还没有运行记录。")).toBeTruthy();
  });

  it("triggers 立即运行 from the row action", () => {
    mock = controller({ automations: [base] });
    render(<AutomationsPage />);
    fireEvent.click(screen.getByLabelText("立即运行 每日晨报"));
    expect(mock.runNow).toHaveBeenCalledWith(base);
  });

  it("surfaces a load error with a retry", () => {
    mock = controller({ loadError: "Network request failed" });
    render(<AutomationsPage />);
    expect(screen.getByText("Network request failed")).toBeTruthy();
    fireEvent.click(screen.getByText("重试"));
    expect(mock.refresh).toHaveBeenCalled();
  });
});
