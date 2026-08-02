// Screenshot audit: every meaningful screen/state of the rewritten GUI, captured to
// e2e/audit-shots/<name>.png (1440×900 @2x, light + dark where marked). Run with:
//   npx playwright test e2e/audit
//
// This spec ASSERTS NOTHING about pixels — each capture is one test step; the waits
// only make sure the state on screen is the intended one before the exposure. Console
// errors and ad-hoc observations (e.g. mobile overflow) land in audit-shots/_report.json.
//
// Data: the shared fixtures (sessions/inbox/automations/profiles/missions…) plus the
// audit-only overlays in ./harness (richer inbox kinds, an ACP permission, MCP servers,
// audit-log rows, artifacts, memory) — installed as later routes, so shared mocks are
// untouched and sibling specs are unaffected.

import { expect } from "@playwright/test";
import { test } from "../fixtures";
import {
  addNote,
  capture,
  collectConsole,
  composer,
  installAuditSeeds,
  installAuditSessionAgent,
  send,
  setTheme,
  writeReport,
  type Theme,
} from "./harness";

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

test.beforeEach(async ({ page }, testInfo) => {
  collectConsole(page, testInfo.title);
  await installAuditSessionAgent(page);
  await installAuditSeeds(page);
});

test.afterAll(() => writeReport());

const THEMES: Theme[] = ["light", "dark"];

// ---------------------------------------------------------------------------
// 1. Assistant — the 伙伴桌面 home (greeting + overview cards + recents), the
//    new-session idle hero, and the session list (pinned row, attention badge,
//    the archived toggle expanded). [2x]
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`assistant: home + session list [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/assistant");
    await expect(page.getByText("Draft the launch note", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("home-greeting")).toBeVisible();
    // Wait for the card data so the capture shows real counts, not the loading zeros
    // (audit seeds: 5 pending inbox items + 1 ACP permission).
    await expect(page.getByTestId("home-card-approvals")).toContainText("6 项等你处理");
    await capture(page, `assistant-01-home-${theme}`, theme);

    // The new-session idle hero with suggestion chips.
    await page.getByRole("button", { name: "新会话" }).last().click();
    await expect(page.getByRole("heading", { name: "有什么想让我帮忙的？" })).toBeVisible();
    await capture(page, `assistant-02-new-session-${theme}`, theme);

    // Archive two sessions through the real PATCH flow, then expand the toggle.
    await page.evaluate(async () => {
      for (const id of ["wp-6", "wp-7"]) {
        await fetch(`/v1/sessions/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        });
      }
    });
    await page.goto("/#/assistant");
    await expect(page.getByText("Draft the launch note", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: /显示已归档/ }).click();
    await expect(page.getByText("Weekly plan 6", { exact: true })).toBeVisible();
    await capture(page, `assistant-03-session-list-archived-${theme}`, theme);
  });
}

// The row ⋯ menu: 重命名 (inline edit) + 删除 (two-step inline confirm). [light]
test("assistant: session row menu [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/assistant");
  const row = page.locator("main .group", { hasText: "Weekly plan 1" });
  await row.hover();
  await row.getByTestId("session-row-menu-button").click();
  await expect(page.getByTestId("session-row-menu")).toBeVisible();
  await capture(page, "assistant-17-session-row-menu-light", "light");
});

// ---------------------------------------------------------------------------
// 2. Assistant — a rich transcript: user bubbles, markdown (code block + list),
//    a collapsed tool-call turn group, an expanded reasoning block, and a
//    streaming reply mid-flight. [2x]
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`assistant: rich chat transcript [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/assistant/pinned-cowork-1");
    // The rail gets its own shots below — give the transcript the width here.
    await page.getByRole("button", { name: "隐藏侧面板" }).click();

    await send(page, "帮我把发布说明的要点过一遍");
    await expect(page.getByText(/Echo: 帮我把发布说明/)).toBeVisible();

    await send(page, "show me markdown");
    await expect(page.getByText(/这是上一轮整理好的发布说明草稿/)).toBeVisible();

    // Tool turn: approve inline, then it collapses into a turn group.
    await send(page, "please run a tool");
    await page.getByTestId("approval-card").getByRole("button", { name: "允许一次" }).click();
    await expect(page.getByText("The command ran; 3 files found.")).toBeVisible();
    await expect(page.getByTestId("turn-group-head")).toBeVisible();
    await capture(page, `assistant-04-chat-${theme}`, theme);

    // Reasoning turn, expanded.
    await send(page, "think hard");
    await expect(page.getByText(/Decision made/)).toBeVisible();
    await page.getByTestId("thinking-toggle").click();
    await expect(page.getByTestId("thinking-body")).toBeVisible();
    await capture(page, `assistant-05-reasoning-${theme}`, theme);

    // A reply still streaming.
    await send(page, "stream the epic");
    await expect(page.getByText(/The epic scrolls/).first()).toBeVisible();
    await capture(page, `assistant-06-streaming-${theme}`, theme);
  });
}

// ---------------------------------------------------------------------------
// 3. Assistant — the four pending prompt cards, one per session. [2x]
// ---------------------------------------------------------------------------

const CARD_CASES = [
  { session: "wp-1", prompt: "please run a tool", testid: "approval-card", shot: "assistant-07-card-permission" },
  { session: "wp-2", prompt: "ask me a question", testid: "question-card", shot: "assistant-08-card-question" },
  { session: "wp-4", prompt: "propose a plan", testid: "plan-card", shot: "assistant-09-card-plan" },
  { session: "wp-5", prompt: "request a directory", testid: "directory-card", shot: "assistant-10-card-directory" },
];

for (const theme of THEMES) {
  test(`assistant: pending prompt cards [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    for (const c of CARD_CASES) {
      await page.goto(`/#/assistant/${c.session}`);
      await send(page, c.prompt);
      await expect(page.getByTestId(c.testid)).toBeVisible();
      await capture(page, `${c.shot}-${theme}`, theme);
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Assistant — composer states (attachment chips, model menu, mode menu) and
//    the right rail (产物 / 目录 / 用量). [2x]
// ---------------------------------------------------------------------------

// 1×1 transparent PNG for the image chip.
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

for (const theme of THEMES) {
  test(`assistant: composer + right rail [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/assistant/pinned-cowork-1");
    // One turn so the 用量 tab has data.
    await send(page, "先随便聊一句，攒一点用量");
    await expect(page.getByText(/Echo: 先随便/)).toBeVisible();

    // Attachment chips (image + text file) via the composer's hidden file input.
    await page.locator('input[type="file"]').setInputFiles([
      { name: "cover-draft.png", mimeType: "image/png", buffer: PNG_1PX },
      {
        name: "release-notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("# 发布说明要点\n\n- Slack 订阅\n- 常驻授权\n"),
      },
    ]);
    await expect(page.getByText("release-notes.md")).toBeVisible();
    await capture(page, `assistant-11-composer-attachments-${theme}`, theme);

    // Model menu open (clicking the same button again closes it via the overlay).
    await page.getByTestId("model-menu-button").click();
    await expect(page.getByTestId("model-menu")).toBeVisible();
    await capture(page, `assistant-12-model-menu-${theme}`, theme);
    await page.getByTestId("model-menu-button").click({ force: true });
    await expect(page.getByTestId("model-menu")).toBeHidden();

    // Mode menu open.
    await page.getByRole("button", { name: "权限模式" }).click();
    await expect(page.getByTestId("mode-menu")).toBeVisible();
    await capture(page, `assistant-13-mode-menu-${theme}`, theme);
    await page.getByRole("button", { name: "权限模式" }).click({ force: true });
    await expect(page.getByTestId("mode-menu")).toBeHidden();

    // Right rail (open by default): 产物 / 目录 / 用量.
    const rail = page.locator("aside");
    await expect(rail.getByText("launch-note.md")).toBeVisible();
    await capture(page, `assistant-14-rail-artifacts-${theme}`, theme);

    await rail.getByRole("button", { name: "目录", exact: true }).click();
    await expect(rail.getByText("/Users/test/OpenWorker/launch-note").first()).toBeVisible();
    await capture(page, `assistant-15-rail-roots-${theme}`, theme);

    await rail.getByRole("button", { name: "用量", exact: true }).click();
    await expect(rail.getByText(/tokens/).first()).toBeVisible();
    await capture(page, `assistant-16-rail-usage-${theme}`, theme);
  });
}

// ---------------------------------------------------------------------------
// 5. Agents — the profile list [2x]; editor drawer + preset picker (light).
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`agents: profile list [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/agents");
    await expect(page.getByText("已招募（5）")).toBeVisible();
    await capture(page, `agents-01-list-${theme}`, theme);
  });
}

test("agents: editor drawer + preset picker [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/agents");
  await expect(page.getByText("已招募（5）")).toBeVisible();

  await page.locator("div[role='button']", { hasText: "kimi-main" }).first().click();
  const editor = page.getByRole("dialog", { name: "编辑 kimi-main" });
  await expect(editor).toBeVisible();
  await capture(page, "agents-02-editor-light", "light");
  await editor.getByTitle("关闭").click();
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: /招募 Agent/ }).click();
  await expect(page.getByText("OpenCode ACP", { exact: true })).toBeVisible();
  await capture(page, "agents-03-preset-picker-light", "light");
});

// ---------------------------------------------------------------------------
// 6. Missions — list [2x]; detail (plan card + timeline + team panel) and the
//    AWAITING_CONFIRMATION plan-editing mode (light).
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`missions: list [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/missions");
    await expect(page.getByRole("heading", { name: "任务" })).toBeVisible();
    await expect(page.getByText("重写设置页", { exact: true })).toBeVisible();
    await capture(page, `missions-01-list-${theme}`, theme);
  });
}

test("missions: detail + plan editing [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/missions/m-1");
  await expect(page.getByRole("heading", { name: "重写设置页" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "确认计划" })).toBeEnabled();
  await capture(page, "missions-02-detail-light", "light");

  await page.getByRole("button", { name: "调整团队" }).click();
  await expect(page.getByRole("button", { name: "保存计划" })).toBeVisible();
  await capture(page, "missions-03-plan-editing-light", "light");
});

test("missions: create drawer, with and without a usable executor [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/missions");
  await page.getByRole("button", { name: /新建任务/ }).first().click();
  const drawer = page.getByRole("dialog", { name: "新建任务" });
  await expect(drawer.locator("#mission-goal")).toBeVisible();
  await capture(page, "missions-04-create-drawer-light", "light");
  await drawer.getByTitle("关闭").click();
  await expect(drawer).toBeHidden();

  // Fresh-install state: no enabled + probed executor → submit gated + Agents deep-link.
  await page.route(
    (url) => new URL(url).pathname === "/v1/agent-profiles",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ profiles: [] }),
      }),
  );
  await page.getByRole("button", { name: /新建任务/ }).first().click();
  await expect(drawer.getByTestId("executor-missing-notice")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "创建任务" })).toBeDisabled();
  await capture(page, "missions-05-create-no-executor-light", "light");
});

test("missions: terminal detail hides the composer [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/missions/m-2");
  await expect(page.getByTestId("mission-terminal-note")).toBeVisible();
  await capture(page, "missions-06-terminal-detail-light", "light");
});

// ---------------------------------------------------------------------------
// 7. Inbox — pending tab with every kind + the ACP permission card [2x];
//    resolved tab (light).
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`inbox: pending [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/inbox");
    await expect(page.getByRole("heading", { name: "收件箱" })).toBeVisible();
    await expect(page.getByText("请求调用")).toBeVisible(); // the ACP permission card
    await expect(page.getByText("Approve: run_shell", { exact: true })).toBeVisible();
    await capture(page, `inbox-01-pending-${theme}`, theme);
  });
}

test("inbox: resolved [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/inbox");
  await page.getByRole("tab", { name: /已处理/ }).click();
  await expect(page.getByText("已允许", { exact: true }).first()).toBeVisible();
  await capture(page, "inbox-02-resolved-light", "light");
});

// ---------------------------------------------------------------------------
// 8. Automations — list [2x]; editor drawer + expanded run history (light).
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`automations: list [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/automations");
    await expect(page.getByText("全部自动化（2）")).toBeVisible();
    await capture(page, `automations-01-list-${theme}`, theme);
  });
}

test("automations: editor + run history [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/automations");
  await expect(page.getByText("全部自动化（2）")).toBeVisible();

  await page.locator("div[role='button']", { hasText: "Daily AI News" }).first().click();
  const editor = page.getByRole("dialog", { name: "编辑 Daily AI News" });
  await expect(editor).toBeVisible();
  await capture(page, "automations-02-editor-light", "light");
  await editor.getByTitle("关闭").click();
  await expect(editor).toBeHidden();

  await page.getByRole("button", { name: /运行记录/ }).first().click();
  await expect(page.locator("main").getByText("进行中…", { exact: true })).toBeVisible();
  await capture(page, "automations-03-run-history-light", "light");
});

// ---------------------------------------------------------------------------
// 9. Integrations — connectors list [2x]; connector detail, MCP servers,
//    routing, audit (light).
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`integrations: connectors [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/integrations");
    await expect(page.getByTestId("connected-list")).toContainText("Slack");
    await expect(page.getByTestId("available-list")).toContainText("Gmail");
    await capture(page, `integrations-01-connectors-${theme}`, theme);
  });
}

test("integrations: detail, MCP, routing, audit [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/integrations");

  // One connector detail (Slack — the relay-managed multi-workspace one).
  await page
    .getByTestId("connected-list")
    .getByRole("button", { name: /Slack/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Slack" })).toBeVisible();
  await capture(page, "integrations-02-connector-detail-light", "light");
  await page.getByRole("button", { name: "‹ 连接器" }).click();

  await page.getByTestId("integrations-tab-mcp").click();
  await expect(page.getByTestId("mcp-server-granola")).toBeVisible();
  await capture(page, "integrations-03-mcp-light", "light");

  await page.getByTestId("integrations-tab-routing").click();
  await expect(page.getByTestId("subscriptions-group")).toContainText("ocw-test");
  await capture(page, "integrations-04-routing-light", "light");

  await page.getByTestId("integrations-tab-audit").click();
  await expect(page.getByTestId("audit-list")).toBeVisible();
  await capture(page, "integrations-05-audit-light", "light");
});

// ---------------------------------------------------------------------------
// 10. Settings — the six sections (light); the provider editor drawer [2x].
// ---------------------------------------------------------------------------

test("settings: all six sections [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/settings");
  const nav = page.getByRole("navigation", { name: "设置" });
  const sections: { key: string; shot: string; marker: ReturnType<typeof page.getByRole> }[] = [
    { key: "外观", shot: "settings-01-appearance-light", marker: page.getByRole("radio", { name: "跟随系统" }) },
    { key: "模型", shot: "settings-02-models-light", marker: page.getByRole("heading", { name: "模型" }) },
    { key: "语音", shot: "settings-03-voice-light", marker: page.getByRole("heading", { name: "语音" }) },
    { key: "记忆", shot: "settings-04-memory-light", marker: page.getByRole("heading", { name: "记忆" }) },
    { key: "Personas", shot: "settings-05-personas-light", marker: page.getByRole("heading", { name: "Personas" }) },
    { key: "高级", shot: "settings-06-advanced-light", marker: page.getByRole("heading", { name: "高级" }) },
  ];
  for (const s of sections) {
    if (s.key !== "外观") await nav.getByRole("button", { name: s.key }).click();
    await expect(s.marker).toBeVisible();
    await capture(page, s.shot, "light");
  }
});

for (const theme of THEMES) {
  test(`settings: provider editor drawer [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/settings");
    await page
      .getByRole("navigation", { name: "设置" })
      .getByRole("button", { name: "模型" })
      .click();
    // The OpenAI row is the only one with a 上次使用 sub-line.
    await page.locator("div[role='button']", { hasText: "上次使用" }).click();
    await expect(page.getByRole("dialog", { name: "配置 OpenAI" })).toBeVisible();
    await capture(page, `settings-07-provider-drawer-${theme}`, theme);
  });
}

// Adding a model whose provider is unconfigured: the hint explains why it won't list. [light]
test("settings: models add hint [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.goto("/#/settings");
  await page.getByRole("navigation", { name: "设置" }).getByRole("button", { name: "模型" }).click();
  await page.getByPlaceholder("模型 ID,如 provider/model-name").fill("zai:glm-5.2");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByTestId("model-add-notice")).toBeVisible();
  await capture(page, "settings-08-models-add-hint-light", "light");
});

// ---------------------------------------------------------------------------
// 11. Sidebar collapsed to the icon rail. [2x]
// ---------------------------------------------------------------------------

for (const theme of THEMES) {
  test(`shell: sidebar collapsed [${theme}]`, async ({ page }) => {
    await setTheme(page, theme);
    await page.goto("/#/assistant");
    await expect(page.getByText("Draft the launch note", { exact: true }).first()).toBeVisible();
    await page.getByTitle("收起侧栏").click();
    await expect(page.getByText("QH 助理", { exact: true })).toBeHidden();
    await capture(page, `shell-01-sidebar-collapsed-${theme}`, theme);
  });
}

// ---------------------------------------------------------------------------
// 12. Mobile-ish minimum window (980×640): the assistant chat, checking for
//     horizontal overflow.
// ---------------------------------------------------------------------------

test("mobile-ish: assistant chat at 980×640 [light]", async ({ page }) => {
  await setTheme(page, "light");
  await page.setViewportSize({ width: 980, height: 640 });
  await page.goto("/#/assistant/pinned-cowork-1");
  await send(page, "在窄窗口下检查一下布局");
  await expect(page.getByText(/Echo: 在窄窗口/)).toBeVisible();

  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      docScrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      mainScrollW: main?.scrollWidth ?? -1,
      mainClientW: main?.clientWidth ?? -1,
    };
  });
  addNote(
    `980×640 overflow check: ${JSON.stringify(overflow)}` +
      (overflow.docScrollW > overflow.innerW ? " — DOCUMENT OVERFLOWS HORIZONTALLY" : " (no horizontal overflow)"),
  );

  // Below 1150px the right rail auto-closes so the chat column keeps its width…
  await expect(page.getByTestId("right-rail")).toBeHidden();
  // …but the manual toggle still works (the auto-close fires once, it doesn't fight).
  await page.getByRole("button", { name: "显示侧面板" }).click();
  await expect(page.getByTestId("right-rail")).toBeVisible();
  await page.getByRole("button", { name: "隐藏侧面板" }).click();
  await expect(page.getByTestId("right-rail")).toBeHidden();

  await capture(page, "mobile-01-assistant-chat-light", "light");
});
