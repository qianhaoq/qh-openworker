import { expect } from "@playwright/test";
import { test } from "./fixtures";

// The Agents page: ACP profile list, the preset → save → probe → enable lifecycle, and
// the row-level enable toggle. Fixtures seed five probed+enabled profiles (kimi-main is
// the workspace main); probe completes instantly and records capabilities.

test("the profile list renders with the main badge and probe states", async ({ page }) => {
  await page.goto("/#/agents");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByText("已招募（5）")).toBeVisible();

  const mainRow = page.locator("div[role='button']", { hasText: "kimi-main" });
  await expect(mainRow).toContainText("主 Agent");
  await expect(mainRow).toContainText("kimi acp");
  // Every seeded profile row shows its probed state.
  await expect(page.locator("div[role='button']", { hasText: "已探测" })).toHaveCount(5);
  await expect(page.getByRole("button", { name: /招募 Agent/ })).toBeVisible();
});

test("the preset drawer lists the subscription presets with PATH badges", async ({ page }) => {
  await page.goto("/#/agents");
  await page.getByRole("button", { name: /招募 Agent/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Claude Code（Claude 订阅）", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Codex（ChatGPT 订阅）", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Gemini CLI", { exact: true })).toBeVisible();

  // The detect endpoint (mocked: npx/opencode/kimi installed) drives the badges — the
  // npx-backed subscription presets read 已安装, gemini reads 未安装. Neither blocks 招募.
  const claudeCard = dialog.locator("button", { hasText: "Claude Code（Claude 订阅）" });
  await expect(claudeCard.getByText("已安装", { exact: true })).toBeVisible();
  const codexCard = dialog.locator("button", { hasText: "Codex（ChatGPT 订阅）" });
  await expect(codexCard.getByText("已安装", { exact: true })).toBeVisible();
  const geminiCard = dialog.locator("button", { hasText: "Gemini CLI" });
  await expect(geminiCard.getByText("未安装", { exact: true })).toBeVisible();
});

test("add-from-preset: save disabled, probe, then enable", async ({ page }) => {
  await page.goto("/#/agents");
  await page.getByRole("button", { name: /招募 Agent/ }).click();

  // The presets drawer → pick OpenCode (its id collides, so the draft gets a suffix).
  const dialog = page.getByRole("dialog");
  await dialog.getByText("OpenCode ACP", { exact: true }).click();

  // The editor opens with a unique draft id; 保存 persists it DISABLED and switches the
  // drawer to edit mode (the save notice unmounts with the new-editor — the lifecycle
  // footer note stays).
  const editor = page.getByRole("dialog", { name: "招募 Agent" });
  // The Profile ID field (基本信息 first row) carries the unique draft id.
  await expect(editor.locator("input").first()).toHaveValue("opencode-executor-2");
  await editor.getByRole("button", { name: "保存" }).click();

  const editDialog = page.getByRole("dialog", { name: "编辑 opencode-executor-2" });
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByText("未探测", { exact: true })).toBeVisible();
  const enableSwitch = editDialog.getByRole("switch");
  await expect(enableSwitch).toBeDisabled(); // 探测通过后才能启用
  await editDialog.getByRole("button", { name: "探测", exact: true }).click();
  await expect(editDialog.getByText("探测成功，能力已记录。")).toBeVisible();
  await expect(editDialog.getByText("已探测", { exact: true })).toBeVisible();
  await expect(enableSwitch).toBeEnabled();
  // Controlled switch: the state flips only after the upsert + list refresh round-trip.
  await enableSwitch.click();
  await expect(editDialog.getByText("已启用。")).toBeVisible();
  await expect(enableSwitch).toBeChecked();

  // Closing the drawer shows the new row, enabled.
  await editDialog.getByTitle("关闭").click();
  const row = page.locator("div[role='button']", { hasText: "opencode-executor-2" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("switch")).toBeChecked();
  await expect(page.getByText("已招募（6）")).toBeVisible();
});

test("the row switch disables an enabled profile", async ({ page }) => {
  await page.goto("/#/agents");
  const row = page.locator("div[role='button']", { hasText: "opencode-reviewer" });
  const toggle = row.getByRole("switch");
  await expect(toggle).toBeChecked();
  // Controlled switch: click, then the upsert + refresh flips it.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
});
