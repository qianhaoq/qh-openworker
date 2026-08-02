import { expect } from "@playwright/test";
import { test, AGENT_PROFILES } from "./fixtures";

// The Missions pages: list + filters, and the detail page (plan card, live timeline,
// team panel) with the confirm and create flows. Fixtures seed m-1 (AWAITING_CONFIRMATION,
// three seats) and m-2 (DONE); the ledger WS is a quiet socket.

test("the mission list renders with state filters", async ({ page }) => {
  await page.goto("/#/missions");
  await expect(page.getByRole("heading", { name: "任务" })).toBeVisible();
  await expect(page.getByText("重写设置页", { exact: true })).toBeVisible();
  await expect(page.getByText("整理本周周报", { exact: true })).toBeVisible();
  // Row state badges (scoped to the rows — the filter tabs share the same labels).
  await expect(
    page.locator("div[role='button']", { hasText: "重写设置页" }),
  ).toContainText("待确认");
  await expect(
    page.locator("div[role='button']", { hasText: "整理本周周报" }),
  ).toContainText("已完成");

  await page.getByRole("tab", { name: "需关注" }).click();
  await expect(page.getByText("重写设置页", { exact: true })).toBeVisible();
  await expect(page.getByText("整理本周周报", { exact: true })).toBeHidden();

  await page.getByRole("tab", { name: "已完成" }).click();
  await expect(page.getByText("整理本周周报", { exact: true })).toBeVisible();
  await expect(page.getByText("重写设置页", { exact: true })).toBeHidden();
});

test("the mission detail renders the plan, seats and timeline", async ({ page }) => {
  await page.goto("/#/missions/m-1");
  // The title renders twice (page h1 + plan-card h2) — take the first.
  await expect(page.getByRole("heading", { name: "重写设置页" }).first()).toBeVisible();
  await expect(page.getByText("待确认", { exact: true }).first()).toBeVisible();

  // Plan card: the goal + the three seats (read-only rows until 调整团队).
  await expect(page.getByText("拆解目标、协调团队并汇总交付").first()).toBeVisible();
  // Timeline: the seeded ledger rows humanize to Chinese entries.
  await expect(page.getByText("任务已创建", { exact: true })).toBeVisible();
  await expect(page.getByText("团队计划已提出", { exact: true })).toBeVisible();
  // Team panel lists the seats.
  await expect(page.getByText("kimi-main").first()).toBeVisible();
  await expect(page.getByText("opencode-executor").first()).toBeVisible();
  await expect(page.getByText("opencode-reviewer").first()).toBeVisible();

  await expect(page.getByRole("button", { name: "确认计划" })).toBeEnabled();
});

test("confirming the plan queues the mission", async ({ page }) => {
  await page.goto("/#/missions/m-1");
  await page.getByRole("button", { name: "确认计划" }).click();

  await expect(page.getByText("计划已确认 · v1", { exact: true })).toBeVisible();
  await expect(page.getByText("排队中", { exact: true }).first()).toBeVisible();
  // The detail view is back-button reachable from the list, which reflects the new state.
  await page.getByRole("button", { name: /任务列表/ }).click();
  await expect(page).toHaveURL(/#\/missions$/);
  await expect(page.getByText("排队中", { exact: true })).toBeVisible();
});

test("creating a mission navigates to its detail page", async ({ page }) => {
  await page.goto("/#/missions");
  await page.getByRole("button", { name: /新建任务/ }).first().click();

  const drawer = page.getByRole("dialog", { name: "新建任务" });
  await expect(drawer.locator("#mission-workspace")).toHaveValue("/Users/test/qh-agent");
  await drawer.locator("#mission-goal").fill("做一个 HTML 周报");
  await drawer.getByRole("button", { name: "创建任务" }).click();

  const planning = drawer.getByTestId("mission-planning-stream");
  await expect(planning).toContainText("主 Agent 正在规划");
  await expect(planning).toContainText('"goal"');
  await expect(page).toHaveURL(/#\/missions\/m-3$/);
  await expect(page.getByRole("heading", { name: "做一个 HTML 周报" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "确认计划" })).toBeEnabled();
});

test("a blocked mission renders the planning error repair actions", async ({ page }) => {
  await page.route(
    (url) => new URL(url).pathname === "/v1/missions/m-blocked",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mission_id: "m-blocked",
          task_id: "m-blocked",
          id: "m-blocked",
          state: "BLOCKED",
          status: "BLOCKED",
          title: "修复 Agent 配置",
          goal: "修复 Agent 配置",
          workspace: "/Users/test/qh-agent",
          task_spec: {},
          plan: null,
          members: [],
          attempts: [],
          artifacts: [],
          reviews: [],
          messages: [],
          timeline: [],
          permissions: [],
          needs_user_action: true,
          planning_error: {
            code: "ACP_PROFILE_UNUSABLE",
            message: "主 Agent profile 不可用",
            retryable: true,
          },
          fallback_used: false,
          created_at: "2026-08-01T08:00:00Z",
          updated_at: "2026-08-01T08:00:05Z",
        }),
      }),
  );
  await page.goto("/#/missions/m-blocked");
  const banner = page.getByTestId("mission-planning-error");
  await expect(banner).toContainText("规划失败：主 Agent profile 不可用");
  await expect(banner.getByRole("button", { name: "重新规划" })).toBeVisible();
  await banner.getByRole("button", { name: "去 Agent 设置" }).click();
  await expect(page).toHaveURL(/#\/agents$/);
});

// Route-override the profile list for the "fresh install" scenarios (no enabled +
// probed executor). Registered after the shared mock, so it wins for this path only.
const overrideProfiles = (
  page: import("@playwright/test").Page,
  profiles: unknown[],
): Promise<void> =>
  page.route(
    (url) => new URL(url).pathname === "/v1/agent-profiles",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ profiles }),
      }),
  );

test("the create drawer blocks submit when no usable executor exists", async ({ page }) => {
  await overrideProfiles(page, []);
  await page.goto("/#/missions");
  await page.getByRole("button", { name: /新建任务/ }).first().click();

  const drawer = page.getByRole("dialog", { name: "新建任务" });
  await expect(drawer.getByTestId("executor-missing-notice")).toContainText("执行");
  await drawer.locator("#mission-goal").fill("做一个 HTML 周报");
  await expect(drawer.getByRole("button", { name: "创建任务" })).toBeDisabled();

  await drawer.getByRole("button", { name: "前往 Agents" }).click();
  await expect(page).toHaveURL(/#\/agents$/);
});

test("confirm is blocked while a seat profile is disabled, with an Agents deep-link", async ({
  page,
}) => {
  await overrideProfiles(
    page,
    AGENT_PROFILES.map((p) => (p.id === "opencode-executor" ? { ...p, enabled: false } : p)),
  );
  await page.goto("/#/missions/m-1");

  const hint = page.getByTestId("confirm-blocked-hint");
  await expect(hint).toContainText("opencode-executor");
  await expect(page.getByRole("button", { name: "确认计划" })).toBeDisabled();

  await hint.click();
  await expect(page).toHaveURL(/#\/agents$/);
});

test("a terminal mission replaces the composer with a quiet note", async ({ page }) => {
  await page.goto("/#/missions/m-2");
  await expect(page.getByTestId("mission-terminal-note")).toContainText("已完成");
  await expect(page.locator("#mission-main-message")).toBeHidden();
});
