import { expect } from "@playwright/test";
import { test } from "./fixtures";

// The hash-routed shell: sidebar chrome, the seven destinations, and the Inbox badge.
// Fixtures seed two pending Inbox items (fixtures.ts INBOX_ITEMS), so the badge reads 2.

test("boots into the assistant and navigates every section from the sidebar", async ({ page }) => {
  await page.goto("/");
  // Default route = assistant; the sidebar reflects it.
  await expect(page).toHaveURL(/localhost:5199\/(#\/assistant)?$/);
  const assistantNav = page.getByRole("link", { name: "助理" });
  await expect(assistantNav).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("home-greeting")).toBeVisible();

  const sections: { nav: string; hash: string; marker: ReturnType<typeof page.locator> }[] = [
    { nav: "Agents", hash: "#/agents", marker: page.getByRole("heading", { name: "Agents" }) },
    { nav: "任务", hash: "#/missions", marker: page.getByRole("heading", { name: "任务" }) },
    { nav: "收件箱", hash: "#/inbox", marker: page.getByRole("heading", { name: "收件箱" }) },
    { nav: "自动化", hash: "#/automations", marker: page.getByRole("heading", { name: "自动化" }) },
    { nav: "集成", hash: "#/integrations", marker: page.getByRole("heading", { name: "连接器" }) },
    // 设置 renders the 外观 section by default (no page-level h1 — assert a real control).
    { nav: "设置", hash: "#/settings", marker: page.getByRole("radio", { name: "跟随系统" }) },
  ];
  for (const section of sections) {
    // Non-exact name: the 收件箱 link's accessible name carries its badge count.
    await page.getByRole("link", { name: section.nav }).first().click();
    await expect(page).toHaveURL(new RegExp(`${section.hash.replace("/", "\\/")}$`));
    await expect(section.marker).toBeVisible();
    await expect(page.getByRole("link", { name: section.nav }).first()).toHaveAttribute(
      "aria-current",
      "page",
    );
  }
});

test("direct hash links land on their page; an unknown hash falls back to the assistant", async ({
  page,
}) => {
  await page.goto("/#/inbox");
  await expect(page.getByRole("heading", { name: "收件箱" })).toBeVisible();

  await page.goto("/#/missions/m-1");
  // The detail renders the title twice (page h1 + plan-card h2) — take the first.
  await expect(page.getByRole("heading", { name: "重写设置页" }).first()).toBeVisible();

  await page.goto("/#/not-a-page");
  await expect(page.getByTestId("home-greeting")).toBeVisible();
});

test("the sidebar collapses to an icon rail and expands back", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("QH 助理", { exact: true })).toBeVisible();

  await page.getByTitle("收起侧栏").click();
  await expect(page.getByText("QH 助理", { exact: true })).toBeHidden();
  // Collapsed: the 收件箱 badge becomes a dot on the icon (no count label).
  await expect(page.getByRole("link", { name: "收件箱", exact: true })).not.toContainText("2");

  await page.getByTitle("展开侧栏").click();
  await expect(page.getByText("QH 助理", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /收件箱/ })).toContainText("2");
});

test("the inbox nav badge shows the pending count", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /收件箱/ })).toContainText("2");
});
