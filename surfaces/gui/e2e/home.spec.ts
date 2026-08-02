import { expect } from "@playwright/test";
import { test } from "./fixtures";

// 伙伴桌面 — the assistant home (no session selected): the time-aware greeting, the four
// overview cards fed by the mocked APIs, card navigation, the 开始新会话 primary action,
// and the recent-session rows.
//
// Fixture 口径 (fixtures.ts): 2 pending inbox items + 0 ACP permissions → 待处理审批 2;
// one mission AWAITING_CONFIRMATION + one DONE → 进行中的任务 0 (attention ≠ running);
// session updated_at all in the past → 今日会话 0; AUTOMATION.unseen_runs=2 → 自动化动态 2.

test("the home greets with a time-aware greeting and a status summary", async ({ page }) => {
  await page.goto("/#/assistant");
  const greeting = page.getByTestId("home-greeting");
  await expect(greeting).toBeVisible();
  await expect(greeting).toHaveText(/^(早上好|下午好|晚上好)$/);
  // Date line ("8月2日 星期六" shape) and Q's partner subline.
  await expect(page.getByTestId("home-date")).toHaveText(/^\d{1,2}月\d{1,2}日 星期[日一二三四五六]$/);
  await expect(page.getByText("我是 Q，你的本地工作伙伴。今天想从哪开始？")).toBeVisible();
  // Two inbox items wait → the summary leads with them.
  await expect(page.getByTestId("home-summary")).toHaveText("有 2 项审批在等你，处理完就清爽了。");
});

test("the overview cards derive counts from the APIs", async ({ page }) => {
  await page.goto("/#/assistant");
  const approvals = page.getByTestId("home-card-approvals");
  await expect(approvals).toContainText("待处理审批");
  await expect(approvals).toContainText("2 项等你处理");

  const missions = page.getByTestId("home-card-missions");
  await expect(missions).toContainText("进行中的任务");
  await expect(missions).toContainText("此刻没有进行中的任务");

  const sessions = page.getByTestId("home-card-sessions");
  await expect(sessions).toContainText("今日会话");
  await expect(sessions).toContainText("今天还没有会话");

  const automations = page.getByTestId("home-card-automations");
  await expect(automations).toContainText("自动化动态");
  await expect(automations).toContainText("2 次运行还没看过");
});

test("cards navigate to their surfaces", async ({ page }) => {
  await page.goto("/#/assistant");
  await page.getByTestId("home-card-approvals").click();
  await expect(page).toHaveURL(/#\/inbox$/);
  await expect(page.getByRole("heading", { name: "收件箱" })).toBeVisible();

  await page.goto("/#/assistant");
  await page.getByTestId("home-card-automations").click();
  await expect(page).toHaveURL(/#\/automations$/);

  await page.goto("/#/assistant");
  await page.getByTestId("home-card-missions").click();
  await expect(page).toHaveURL(/#\/missions$/);
});

test("开始新会话 opens the idle hero and recent rows open their session", async ({ page }) => {
  await page.goto("/#/assistant");
  await page.getByRole("button", { name: "开始新会话" }).click();
  await expect(page).toHaveURL(/#\/assistant\/.+/);
  await expect(page.getByRole("heading", { name: "有什么想让我帮忙的？" })).toBeVisible();

  // Back home, the most recent session (the pinned one) opens from its quiet row.
  await page.goto("/#/assistant");
  const recents = page.getByTestId("home");
  await recents.getByText("Draft the launch note", { exact: true }).click();
  await expect(page).toHaveURL(/#\/assistant\/pinned-cowork-1$/);
  // The chat header carries the session title and Q's live status line.
  await expect(page.getByTestId("status-line")).toHaveText(/^(在线|连接中…|正在思考…)$/);
});
