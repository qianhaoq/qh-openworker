import { expect } from "@playwright/test";
import { test } from "./fixtures";

// The Agents page: ACP profile list, the add-and-test activation lifecycle, and the
// row-level enable toggle. Fixtures seed five genuinely probed+enabled profiles
// (kimi-main is the workspace main); activation completes instantly in the fake runtime.

test("the profile list renders with the main badge and probe states", async ({ page }) => {
  await page.goto("/#/agents");
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByText("已招募（5）")).toBeVisible();

  const mainRow = page.locator("div[role='button']", { hasText: "kimi-main" });
  await expect(mainRow).toContainText("主 Agent");
  await expect(mainRow).toContainText("kimi acp");
  // Every seeded profile row shows its probed state.
  await expect(page.locator("div[role='button']", { hasText: "已探测" })).toHaveCount(5);
  await expect(page.getByRole("button", { name: "添加 Agent" })).toBeVisible();
});

test("the preset drawer only lists directly detected local runtimes", async ({ page }) => {
  await page.goto("/#/agents");
  await page.getByRole("button", { name: "添加 Agent" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("OpenCode ACP", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Kimi ACP", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Claude Code（Claude 订阅）", { exact: true })).toBeHidden();
  await expect(dialog.getByText("Codex（ChatGPT 订阅）", { exact: true })).toBeHidden();
  await expect(dialog.getByText("Gemini CLI", { exact: true })).toBeHidden();
  await expect(dialog.getByText("空白自定义", { exact: true })).toBeVisible();
});

test("add-from-preset saves disabled then activates through a real handshake", async ({ page }) => {
  await page.goto("/#/agents");
  await page.getByRole("button", { name: "添加 Agent" }).click();

  // The presets drawer → pick OpenCode (its id collides, so the draft gets a suffix).
  const dialog = page.getByRole("dialog");
  await dialog.getByText("OpenCode ACP", { exact: true }).click();

  // The editor opens with a unique draft id; the primary action persists it DISABLED,
  // performs the ACP handshake, stores the returned capabilities and enables atomically.
  const editor = page.getByRole("dialog", { name: "招募 Agent" });
  await expect(editor.locator("input").first()).toHaveValue("opencode-executor-2");
  await editor.getByRole("button", { name: "添加并测试" }).click();

  const editDialog = page.getByRole("dialog", { name: "opencode-executor-2" });
  await expect(editDialog).toBeVisible();
  await expect(editDialog.getByText("已探测", { exact: true })).toBeVisible();
  const enableSwitch = editDialog.getByRole("switch");
  await expect(enableSwitch).toBeEnabled();
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
