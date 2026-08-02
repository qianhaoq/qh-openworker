import { expect } from "@playwright/test";
import { test } from "./fixtures";

// The hash-routed shell: Mission-first four-item navigation and the approval badge.
// Fixtures seed two pending Inbox items (fixtures.ts INBOX_ITEMS), so the badge reads 2.

test("boots into home and navigates the four primary sections", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/localhost:5199\/?$/);
  await expect(page.getByRole("link", { name: "首页" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("home-greeting")).toBeVisible();

  const sections: { nav: string; hash: string; marker: ReturnType<typeof page.locator> }[] = [
    { nav: "Agents", hash: "#/agents", marker: page.getByRole("heading", { name: "Agents" }) },
    { nav: "Missions", hash: "#/missions", marker: page.getByRole("heading", { name: "Missions" }) },
    { nav: "审批", hash: "#/inbox", marker: page.getByRole("heading", { name: "收件箱" }) },
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

test("direct legacy links still land; an unknown hash falls back to home", async ({
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
  // Collapsed: the approval badge becomes a dot on the icon (no count label).
  await expect(page.getByRole("link", { name: "审批", exact: true })).not.toContainText("2");

  await page.getByTitle("展开侧栏").click();
  await expect(page.getByText("QH 助理", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /审批/ })).toContainText("2");
});

test("the inbox nav badge shows the pending count", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: /审批/ })).toContainText("2");
});
