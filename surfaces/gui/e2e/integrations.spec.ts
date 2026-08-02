import { expect } from "@playwright/test";
import { test } from "./fixtures";

// The Integrations page: the 连接器 list (connected/available groups) with a token-paste
// connect flow, plus the MCP 服务器 / 消息路由 / 审计 tabs. Fixtures connect Browser,
// Slack and GitHub; Telegram connects instantly via the mocked /connect route.

test("the connectors tab lists connected and available groups", async ({ page }) => {
  await page.goto("/#/integrations");
  await expect(page.getByRole("heading", { name: "连接器" })).toBeVisible();

  const connected = page.getByTestId("connected-list");
  await expect(connected).toContainText("Browser");
  await expect(connected).toContainText("Slack");
  await expect(connected).toContainText("GitHub");

  const available = page.getByTestId("available-list");
  await expect(available).toContainText("Telegram");
  await expect(available).toContainText("Gmail");
  await expect(available).not.toContainText("Browser");
});

test("connecting Telegram with a bot token moves it to 已连接", async ({ page }) => {
  await page.goto("/#/integrations");
  const telegramRow = page.getByTestId("available-list").locator("div[role='button']", {
    hasText: "Telegram",
  });
  await telegramRow.getByRole("button", { name: "连接", exact: true }).click();

  // The connect sheet takes the bot token and submits synchronously.
  const sheet = page.getByTestId("connect-sheet");
  await expect(sheet).toContainText("连接 Telegram");
  await sheet.getByPlaceholder("123456:ABC…").fill("123456:TEST-TOKEN");
  await sheet.getByRole("button", { name: "连接", exact: true }).click();

  // Sheet closes; the card refiles under 已连接.
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId("connected-list")).toContainText("Telegram");
  await expect(page.getByTestId("available-list")).not.toContainText("Telegram");
});

test("the MCP, routing and audit tabs render", async ({ page }) => {
  await page.goto("/#/integrations");

  await page.getByTestId("integrations-tab-mcp").click();
  await expect(page.getByRole("heading", { name: "MCP 服务器" })).toBeVisible();
  await expect(page.getByText(/还没有配置 MCP 服务器/)).toBeVisible();

  await page.getByTestId("integrations-tab-routing").click();
  await expect(page.getByRole("heading", { name: "消息路由" })).toBeVisible();
  // The seeded subscription (Weekly plan 1 ← #ocw-test) renders.
  await expect(page.getByTestId("subscriptions-group")).toContainText("ocw-test");

  await page.getByTestId("integrations-tab-audit").click();
  await expect(page.getByRole("heading", { name: "审计" })).toBeVisible();
  await expect(page.getByText("还没有审计记录。", { exact: true })).toBeVisible();
});
