import { expect } from "@playwright/test";
import { test } from "./fixtures";

// The Settings page: left sub-nav switching independent sections. 外观 is local-only;
// 模型 rides /v1/settings + /v1/providers; 记忆 rides GET/POST /v1/memory (mock-mutated).

test("settings opens on 外观 and switches sections from the sub-nav", async ({ page }) => {
  await page.goto("/#/settings");
  // 外观 by default: theme radios render, sub-nav marks it current.
  await expect(page.getByRole("radio", { name: "跟随系统" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "设置" }).getByRole("button", { name: "外观" }),
  ).toHaveAttribute("aria-current", "page");

  await page.getByRole("navigation", { name: "设置" }).getByRole("button", { name: "模型" }).click();
  await expect(page.getByText("模型提供商与默认模型", { exact: false }).first()).toBeVisible();
});

test("the models section renders providers and the default model", async ({ page }) => {
  await page.goto("/#/settings");
  await page.getByRole("navigation", { name: "设置" }).getByRole("button", { name: "模型" }).click();

  // Providers in all three states (configured / configured-unused / unconfigured).
  await expect(page.getByText("OpenAI", { exact: true })).toBeVisible();
  await expect(page.getByText("Claude (Anthropic)", { exact: true })).toBeVisible();
  await expect(page.getByText("Z AI (GLM)", { exact: true })).toBeVisible();
  // The default model row shows the current selection from /v1/settings; the models list
  // below shows the raw id (options in the select are hidden — match the visible row).
  await expect(page.getByText("默认模型", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/anthropic:claude-opus-4-8/).first()).toBeVisible();
});

test("adding a model for an unconfigured provider shows a hint", async ({ page }) => {
  await page.goto("/#/settings");
  await page.getByRole("navigation", { name: "设置" }).getByRole("button", { name: "模型" }).click();

  const input = page.getByPlaceholder("模型 ID,如 provider/model-name");
  const addButton = page.getByRole("button", { name: "添加", exact: true });

  // Whitespace ids are rejected client-side, before any request.
  await input.fill("bad model");
  await addButton.click();
  await expect(page.getByText("模型 ID 不能包含空格或空白字符")).toBeVisible();

  // zai 未配置 → 已持久化但不出现在列表,提示说明原因。
  await input.fill("zai:glm-5.2");
  await addButton.click();
  await expect(page.getByTestId("model-add-notice")).toContainText(
    "已添加,配置对应提供商后才会出现在模型列表",
  );
  await expect(page.locator("span.font-mono", { hasText: "zai:glm-5.2" })).toHaveCount(0);

  // openai 已配置 → 正常出现在列表,无提示。
  await input.fill("openai:gpt-5.5-turbo");
  await addButton.click();
  await expect(page.locator("span.font-mono", { hasText: "openai:gpt-5.5-turbo" })).toHaveCount(1);
  await expect(page.getByTestId("model-add-notice")).toBeHidden();
});

test("adding a memory item lists it", async ({ page }) => {
  await page.goto("/#/settings");
  await page
    .getByRole("navigation", { name: "设置" })
    .getByRole("button", { name: "记忆" })
    .click();

  // The seeded item renders.
  await expect(page.getByText("回复默认使用中文", { exact: true })).toBeVisible();
  await expect(page.getByText("已有记忆(1)", { exact: true })).toBeVisible();

  await page.getByPlaceholder("例如:回复一律使用简体中文").fill("周五下午不发版");
  await page.getByRole("button", { name: "添加", exact: true }).click();

  await expect(page.getByText("周五下午不发版", { exact: true })).toBeVisible();
  await expect(page.getByText("已有记忆(2)", { exact: true })).toBeVisible();
});
