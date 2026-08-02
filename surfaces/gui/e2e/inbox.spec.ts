import { expect } from "@playwright/test";
import { test } from "./fixtures";

// The Inbox: pending approvals/questions from sessions, resolved inline (optimistic, then
// re-aligned with the server). Fixtures seed one approval (Weekly plan 3) and one question
// (ops session) — resolving one drops the sidebar badge from 2 to 1.

test("pending items render with their kinds and actions", async ({ page }) => {
  await page.goto("/#/inbox");
  await expect(page.getByRole("heading", { name: "收件箱" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /待处理/ })).toContainText("2");

  await expect(page.getByText("Approve: run_shell", { exact: true })).toBeVisible();
  await expect(page.getByText("审批", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Which environment should I restart?", { exact: true })).toBeVisible();
  await expect(page.getByText("提问", { exact: true }).first()).toBeVisible();
  // The question's quick options render as choices.
  await expect(page.getByRole("button", { name: "staging", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "production", exact: true })).toBeVisible();
});

test("allowing an approval moves it to 已处理 and updates the badge", async ({ page }) => {
  await page.goto("/#/inbox");
  await page.getByRole("button", { name: "允许", exact: true }).click();

  // Gone from pending; only the question remains.
  await expect(page.getByText("Approve: run_shell", { exact: true })).toBeHidden();
  await expect(page.getByText("Which environment should I restart?", { exact: true })).toBeVisible();
  // The sidebar badge drops to 1.
  await expect(page.getByRole("link", { name: /收件箱/ })).toContainText("1");

  await page.getByRole("tab", { name: /已处理/ }).click();
  await expect(page.getByText("Approve: run_shell", { exact: true })).toBeVisible();
  await expect(page.getByText("已允许", { exact: true })).toBeVisible();
});

test("answering a question resolves it; clearing both empties the queue", async ({ page }) => {
  await page.goto("/#/inbox");
  await page.getByRole("button", { name: "staging", exact: true }).click();

  // The question is gone; the approval is still queued.
  await expect(page.getByText("Which environment should I restart?", { exact: true })).toBeHidden();
  await expect(page.getByText("Approve: run_shell", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "允许", exact: true }).click();
  await expect(page.getByText("没有待处理的事项", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /已处理/ }).click();
  await expect(page.getByText("Which environment should I restart?", { exact: true })).toBeVisible();
  await expect(page.getByText("已回答:staging", { exact: true })).toBeVisible();
});
