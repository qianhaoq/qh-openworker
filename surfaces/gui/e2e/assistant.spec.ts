import { expect } from "@playwright/test";
import { sessionSocketUrls, test } from "./fixtures";

// The assistant surface: the session list panel, the live conversation (mocked session
// WebSocket = scripted fake agent), and the inline permission card.
//
// Scripted-agent contract (fixtures.ts): any user_message → turn_start → deltas →
// assistant_message "Echo: <text> [model=…]" → turn_done; a message containing
// "run a tool" suspends on permission_required until the client's approval decision.

const composer = (page: import("@playwright/test").Page) =>
  page.getByPlaceholder("给助手发消息…");

// Session titles also appear on the 伙伴桌面 home's recent rows — scope list assertions
// to the session list panel.
const panel = (page: import("@playwright/test").Page) => page.getByTestId("session-list-panel");

test("the session list renders pinned-first and filters by search", async ({ page }) => {
  await page.goto("/");
  // The pinned session sorts first; the weekly-plan rows follow.
  const firstRow = panel(page).locator(".group").first();
  await expect(firstRow).toContainText("Draft the launch note");
  await expect(panel(page).getByText("Weekly plan 1", { exact: true })).toBeVisible();

  await page.getByPlaceholder("搜索会话").fill("Weekly plan 3");
  await expect(panel(page).getByText("Weekly plan 3", { exact: true })).toBeVisible();
  await expect(panel(page).getByText("Weekly plan 1", { exact: true })).toBeHidden();
  await expect(panel(page).getByText("Draft the launch note", { exact: true })).toBeHidden();
});

test("opening a session and sending a message streams the reply", async ({ page }) => {
  await page.goto("/");
  await panel(page).getByText("Draft the launch note", { exact: true }).click();
  await expect(page).toHaveURL(/#\/assistant\/pinned-cowork-1$/);
  // The chat header shows the session title.
  await expect(page.getByText("Draft the launch note", { exact: true }).first()).toBeVisible();

  await composer(page).fill("hello there");
  await composer(page).press("Enter");
  // The user bubble and the streamed echo both render.
  await expect(page.getByText("hello there").first()).toBeVisible();
  await expect(page.getByText(/Echo: hello there/)).toBeVisible();
});

test("the new-session idle state sends a suggestion", async ({ page }) => {
  await page.goto("/");
  // The home's 开始新会话 button (the session panel has a 新会话 one too — take the last).
  await page.getByRole("button", { name: "新会话" }).last().click();
  await expect(page).toHaveURL(/#\/assistant\/.+/);
  await expect(page.getByRole("heading", { name: "有什么想让我帮忙的？" })).toBeVisible();

  await page.getByText("帮我写个周报草稿").click();
  await expect(page.getByText(/Echo: 帮我写个周报草稿/)).toBeVisible();
});

test("a tool permission card approves inline and the turn continues", async ({ page }) => {
  await page.goto("/#/assistant/pinned-cowork-1");
  await composer(page).fill("please run a tool");
  await composer(page).press("Enter");

  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("ls");
  await card.getByRole("button", { name: "允许一次" }).click();

  // The turn completes, then collapses into a group; expanding it shows the approval chip.
  await expect(page.getByText("The command ran; 1 file found.")).toBeVisible();
  await page.getByTestId("turn-group-head").click();
  await expect(page.getByTitle("已批准 · 一次")).toBeVisible();
});

test("a tool permission card can be denied", async ({ page }) => {
  await page.goto("/#/assistant/pinned-cowork-1");
  await composer(page).fill("please run a tool");
  await composer(page).press("Enter");

  const card = page.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "拒绝" }).click();

  // Denied approvals are called out on the collapsed turn group and as a chip inside.
  await expect(page.getByText("Understood — skipped the command.")).toBeVisible();
  await expect(page.getByTestId("turn-group-head")).toContainText("1 个被拒绝");
  await page.getByTestId("turn-group-head").click();
  await expect(page.getByText("✕ 已拒绝", { exact: true })).toBeVisible();
});

test("the header agent picker binds an ACP profile to the session socket", async ({ page }) => {
  await page.goto("/#/assistant/pinned-cowork-1");
  const picker = page.getByTestId("agent-picker");
  await expect(picker).toContainText("内置助理");

  // A turn first, so the status line has settled into 在线 (it reads 正在思考… mid-turn).
  await composer(page).fill("hello there");
  await composer(page).press("Enter");
  await expect(page.getByText(/Echo: hello there/)).toBeVisible();

  // The menu lists 内置助理 plus every usable (enabled + probed) profile with its role.
  await picker.click();
  const menu = page.getByTestId("agent-menu");
  await expect(menu.getByRole("button", { name: /内置助理/ })).toBeVisible();
  const profileRow = menu.getByRole("button", { name: /claude-code-main/ });
  await expect(profileRow).toBeVisible();
  await expect(profileRow).toContainText("主");

  await profileRow.click();
  await expect(picker).toContainText("claude-code-main");

  // Switching reconnects the socket with runtime=acp & profile_id bound …
  await expect
    .poll(() =>
      sessionSocketUrls(page).some(
        (url) => url.includes("runtime=acp") && url.includes("profile_id=claude-code-main"),
      ),
    )
    .toBe(true);
  // … and the agent name leads the header's live status line.
  await expect(page.getByTestId("status-line")).toContainText("claude-code-main");

  // The selection persists per session (assistant:agent:{id}) across a reload.
  await page.reload();
  await expect(page.getByTestId("agent-picker")).toContainText("claude-code-main");
  await expect
    .poll(() => sessionSocketUrls(page).some((url) => url.includes("profile_id=claude-code-main")))
    .toBe(true);
});

test("a session can be renamed from the row menu", async ({ page }) => {
  await page.goto("/");
  const row = panel(page).locator(".group", { hasText: "Weekly plan 1" });
  await row.hover();
  await row.getByTestId("session-row-menu-button").click();

  const menu = page.getByTestId("session-row-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "重命名" }).click();

  const input = page.getByTestId("session-rename-input");
  await expect(input).toHaveValue("Weekly plan 1");
  await input.fill("周报草稿 A");
  await input.press("Enter");

  await expect(panel(page).locator(".group", { hasText: "周报草稿 A" })).toBeVisible();
});

test("deleting the open session returns to the assistant home", async ({ page }) => {
  await page.goto("/#/assistant/wp-1");
  await expect(page).toHaveURL(/#\/assistant\/wp-1$/);

  const row = panel(page).locator(".group", { hasText: "Weekly plan 1" });
  await row.hover();
  await row.getByTestId("session-row-menu-button").click();

  const menu = page.getByTestId("session-row-menu");
  await menu.getByRole("menuitem", { name: "删除" }).click();
  // Two-step inline confirm inside the same menu.
  await menu.getByRole("button", { name: "确认删除" }).click();

  await expect(page).toHaveURL(/#\/assistant$/);
  // Gone from the list AND from the home's recent rows once the refetch lands.
  await expect(panel(page).getByText("Weekly plan 1", { exact: true })).toBeHidden();
  await expect(page.getByTestId("home").getByText("Weekly plan 1", { exact: true })).toBeHidden();
});
