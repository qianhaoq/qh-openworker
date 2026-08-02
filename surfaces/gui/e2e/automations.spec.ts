import { expect } from "@playwright/test";
import { test } from "./fixtures";

// The Automations page: the scheduled-task list with enable toggles, expandable run
// history, and 立即运行 — which prepares a run server-side and opens its live session in
// the assistant. Fixtures seed task-1 (running run + unseen badges) and task-2 (quiet).

test("the automation list renders with schedules and status", async ({ page }) => {
  await page.goto("/#/automations");
  await expect(page.getByRole("heading", { name: "自动化" })).toBeVisible();
  await expect(page.getByText("全部自动化（2）")).toBeVisible();
  await expect(page.getByText("Daily AI News", { exact: true })).toBeVisible();
  await expect(page.getByText("Weekly CRM digest", { exact: true })).toBeVisible();
  // task-1 carries the unseen-runs pill (2 new, newest failed).
  await expect(page.getByText("2 条新记录", { exact: true })).toBeVisible();
});

test("toggling an automation off marks it paused", async ({ page }) => {
  await page.goto("/#/automations");
  const row = page.locator("div[role='button']", { hasText: "Weekly CRM digest" });
  const toggle = row.getByRole("switch");
  await expect(toggle).toBeChecked();
  // Controlled switch: click, then the PATCH + refetch flips it.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(row).toContainText("已暂停");
});

test("expanding 运行记录 shows the run history and clears the unseen pill", async ({ page }) => {
  await page.goto("/#/automations");
  // task-1 is the first row; its 运行记录 toggle is a sibling of the row button.
  await page.getByRole("button", { name: /运行记录/ }).first().click();

  // The running seeded run renders its live status.
  const runs = page.locator("main").getByText("进行中…", { exact: true });
  await expect(runs).toBeVisible();
  // Expanding marks the runs seen — the pill clears on the refetch.
  await expect(page.getByText("条新记录", { exact: false })).toBeHidden();
});

test("立即运行 prepares a run and opens its live session", async ({ page }) => {
  await page.goto("/#/automations");
  // exact: the row's own accessible name embeds the button's aria-label.
  await page.getByRole("button", { name: "立即运行 Weekly CRM digest", exact: true }).click();

  await expect(page).toHaveURL(/#\/assistant\/__run__r2$/);
  // The run session is a fresh conversation view (its prompt streams on the driver socket).
  await expect(page.getByText("新会话", { exact: true }).first()).toBeVisible();
});
