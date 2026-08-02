// LIVE click-through audit of the new GUI against a real sidecar.
//
// Prereqs:
//   1. vite dev server on http://localhost:1420 (npm run dev / tauri dev)
//   2. isolated sidecar: COWORKER_STATE_DIR=/tmp/qh-audit-state COWORKER_API_TOKEN=audit-token \
//        .venv/bin/openworker-server --port 8899
//
// Run:  node e2e/live-audit.mjs [section...]     (default: all)
// Sections: assistant agents missions inbox automations integrations settings
//
// Output: e2e/live-audit-findings.json (raw findings, grouped by step).

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = process.env.AUDIT_BACKEND || "http://127.0.0.1:8899";
const TOKEN = process.env.AUDIT_TOKEN || "audit-token";
const APP = process.env.AUDIT_APP || "http://localhost:1420";
const FINDINGS_PATH = path.join(HERE, "live-audit-findings.json");

const findings = [];
const apiTrace = []; // every backend call, attributed to the current step
let currentStep = "(boot)";

function addFinding(kind, data) {
  findings.push({ step: currentStep, kind, ...data });
}

// Direct backend call (setup/cleanup) — bypasses the UI entirely.
async function api(method, p, body) {
  const res = await fetch(`${BACKEND}${p}`, {
    method,
    headers: { "Content-Type": "application/json", "X-OpenWorker-Token": TOKEN },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text: text.slice(0, 500) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
let prevErrorTexts = new Set();

// Scan the DOM for visible error-ish UI; report only NEW texts since the last scan.
async function scanUI() {
  const texts = await page.evaluate(() => {
    const out = new Set();
    const push = (t) => {
      const clean = (t || "").trim().replace(/\s+/g, " ").slice(0, 240);
      if (clean) out.add(clean);
    };
    for (const el of document.querySelectorAll('[role="alert"]')) push("alert: " + el.textContent);
    for (const el of document.querySelectorAll(".text-danger")) {
      if (el.closest("button, a, select, option")) continue; // styled buttons, not errors
      push("danger: " + el.textContent);
    }
    for (const el of document.querySelectorAll('[role="status"] .toast-enter, [role="status"] > div'))
      push("toast: " + el.textContent);
    return [...out];
  });
  for (const t of texts) {
    if (!prevErrorTexts.has(t)) addFinding("ui-error", { text: t });
  }
  prevErrorTexts = new Set(texts);
}

async function step(name, fn) {
  currentStep = name;
  process.stdout.write(`\n== ${name}\n`);
  try {
    await fn();
  } catch (e) {
    addFinding("step-failed", { text: String(e).split("\n").slice(0, 6).join(" | ").slice(0, 700) });
    try { await page.screenshot({ path: path.join(HERE, `audit-fail-${Date.now()}.png`) }); } catch {}
  }
  await sleep(500);
  await scanUI();
}

// Menus/popovers dismiss via a full-screen transparent overlay (div.fixed.inset-0) that
// intercepts all pointer events — a leftover menu bricks every later click. Close any
// open ones by clicking the overlay itself (what a user would do).
async function closeOverlays() {
  for (let i = 0; i < 3; i++) {
    const overlay = page.locator("div.fixed.inset-0.z-30").first();
    if (!(await overlay.count())) return;
    await overlay.click({ position: { x: 8, y: 8 }, force: true }).catch(() => {});
    await sleep(250);
  }
}

async function go(hash) {
  await page.goto(`${APP}/#/${hash}`, { waitUntil: "domcontentloaded" });
  await sleep(900);
  await scanUI();
}

// ---------------------------------------------------------------- sections --

async function sectionAssistant() {
  let sessionId = null;

  await step("assistant: open empty page", async () => {
    await go("assistant");
  });

  await step("assistant: click 新会话 (empty state)", async () => {
    await page.getByRole("button", { name: "新会话" }).first().click();
    await page.waitForURL(/#\/assistant\/.+/, { timeout: 5000 });
    sessionId = page.url().split("#/assistant/")[1];
    await sleep(1500); // WS connect + history fetch
  });

  await step("assistant: send message (no provider key)", async () => {
    await page.getByPlaceholder("给助手发消息…").fill("AUDIT: say hi");
    await page.getByRole("button", { name: "发送" }).click();
    await sleep(6000); // let the turn fail
  });

  await step("assistant: error card retry", async () => {
    const retry = page.getByRole("button", { name: "重试", exact: true });
    if (await retry.count()) await retry.first().click();
    await sleep(5000);
  });

  await step("assistant: error card 前往设置 + back", async () => {
    const goSettings = page.getByRole("button", { name: "前往设置" });
    if (await goSettings.count()) {
      await goSettings.first().click();
      await sleep(1200);
      addFinding("info", { text: `after 前往设置 hash=${await page.evaluate(() => location.hash)}` });
      await go(`assistant/${sessionId}`);
    }
  });

  await step("assistant: mode menu → 计划 → 自动", async () => {
    await page.getByRole("button", { name: "权限模式" }).click();
    await page.getByTestId("mode-menu").getByText("计划", { exact: true }).click();
    await sleep(400);
    await page.getByRole("button", { name: "权限模式" }).click();
    await page.getByTestId("mode-menu").getByText("自动", { exact: true }).click();
    await sleep(400);
  });

  await step("assistant: unattended toggle on/off", async () => {
    await page.getByRole("button", { name: "权限模式" }).click();
    const sw = page.getByTestId("mode-menu").getByRole("switch", { name: "无人值守" });
    await sw.click();
    await sleep(700);
    await sw.click(); // back off
    await sleep(700);
    await closeOverlays();
  });

  await step("assistant: model menu open + pick", async () => {
    const btn = page.getByTestId("model-menu-button");
    if (await btn.count()) {
      await btn.click();
      await sleep(400);
      const items = page.getByTestId("model-menu").locator("button");
      const n = await items.count();
      addFinding("info", { text: `model menu entries: ${n}` });
      if (n > 1) await items.nth(1).click();
      else await closeOverlays();
    } else {
      const loading = page.getByTestId("models-loading");
      addFinding("info", {
        text: (await loading.count()) ? "model picker shows 加载模型… (empty models list)" : "no model picker at all",
      });
    }
    await sleep(400);
  });

  await step("assistant: attach menu + text file + send", async () => {
    await page.getByRole("button", { name: "添加附件" }).click();
    await page.getByText("其他文件").click();
    const filePath = path.join(HERE, "audit-attachment.txt");
    fs.writeFileSync(filePath, "AUDIT attachment body\n");
    await page.locator('input[type="file"]').setInputFiles(filePath);
    await sleep(800);
    fs.unlinkSync(filePath);
    await page.getByPlaceholder("给助手发消息…").fill("AUDIT: with attachment");
    await page.getByRole("button", { name: "发送" }).click();
    await sleep(5000);
  });

  await step("assistant: ACP runtime toggle", async () => {
    await page.getByRole("button", { name: /ACP/ }).click();
    await sleep(2500); // WS reconnect with runtime=acp
    await page.getByRole("button", { name: /ACP/ }).click(); // toggle back
    await sleep(2000);
  });

  await step("assistant: rail tabs", async () => {
    for (const label of ["目录", "用量", "产物"]) {
      await page.getByTestId("right-rail").getByRole("button", { name: new RegExp(`^${label}`) }).click();
      await sleep(400);
    }
    // NB: 添加文件夹 opens a NATIVE OS dialog via the sidecar — deliberately not clicked.
  });

  await step("assistant: rail hide/show", async () => {
    await page.getByRole("button", { name: "隐藏侧面板" }).click();
    await sleep(300);
    await page.getByRole("button", { name: "显示侧面板" }).click();
    await sleep(300);
  });

  await step("assistant: session search filter", async () => {
    await page.getByPlaceholder("搜索会话").fill("AUDIT-nomatch");
    await sleep(400);
    await page.getByPlaceholder("搜索会话").fill("");
    await sleep(300);
  });

  await step("assistant: pin + archive active session", async () => {
    const row = page.locator(".group", { has: page.locator('[aria-current="page"]') }).first();
    await row.hover();
    await row.getByRole("button", { name: "置顶" }).click();
    await sleep(600);
    await row.hover();
    await row.getByRole("button", { name: "归档" }).click();
    await sleep(600);
  });

  await step("assistant: show archived + unarchive", async () => {
    const showBtn = page.getByRole("button", { name: /显示已归档/ });
    if (await showBtn.count()) {
      await showBtn.click();
      await sleep(600);
      const archived = page.locator(".group", { hasText: "已归档" }).first();
      if (await archived.count()) {
        await archived.hover();
        await archived.getByRole("button", { name: "取消归档" }).click();
        await sleep(600);
      }
    }
  });

  // Cleanup: the AUDIT session has no delete UI — remove it via the API.
  await step("assistant: cleanup audit session via API", async () => {
    if (sessionId) {
      const res = await api("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`);
      addFinding("info", { text: `DELETE /v1/sessions/${sessionId} -> ${res.status} ${res.text.slice(0, 120)}` });
    }
  });
}

async function sectionAgents() {
  await step("agents: open page", async () => {
    await go("agents");
    const rows = await page.locator('[role="button"][tabindex="0"]').count();
    addFinding("info", { text: `existing profile rows: ${rows}` });
  });

  await step("agents: open recruit drawer / preset grid", async () => {
    const recruit = page.getByRole("button", { name: "招募 Agent" });
    if (await recruit.count()) await recruit.first().click();
    await sleep(400);
    const cards = await page.getByText("Custom ACP stdio").count();
    if (!cards) throw new Error("preset card not found");
  });

  await step("agents: pick custom preset → editor", async () => {
    await page.getByText("Custom ACP stdio").first().click();
    await sleep(500);
    const dialog = page.getByRole("dialog", { name: "招募 Agent" });
    if (!(await dialog.count())) throw new Error("editor drawer did not open");
  });

  await step("agents: save with empty command (validation)", async () => {
    const dialog = page.getByRole("dialog", { name: "招募 Agent" });
    await dialog.getByPlaceholder("kimi").fill(""); // Command field — preset pre-fills "agent"
    await dialog.getByRole("button", { name: "保存" }).click();
    await sleep(500);
  });

  await step("agents: fill id+command, save", async () => {
    const dialog = page.getByRole("dialog", { name: "招募 Agent" });
    await dialog.getByPlaceholder("kimi-main").fill("audit-agent");
    await dialog.getByPlaceholder("kimi").fill("audit-no-such-binary-xyz");
    await dialog.getByRole("button", { name: "保存" }).click();
    await sleep(1200);
  });

  await step("agents: invalid args JSON inline error", async () => {
    const dialog = page.getByRole("dialog", { name: /编辑 audit-agent|招募 Agent/ });
    await dialog.locator("textarea").fill("{bad json");
    await sleep(400);
  });

  await step("agents: probe (binary missing)", async () => {
    const dialog = page.getByRole("dialog", { name: /编辑 audit-agent|招募 Agent/ });
    await dialog.locator("textarea").fill('["acp"]');
    await dialog.getByRole("button", { name: "保存" }).click(); // persist args fix first
    await sleep(1000);
    await dialog.getByRole("button", { name: "探测", exact: true }).click();
    // Probe spawns the runtime; a missing binary should fail fast, but allow 45s.
    await page
      .waitForFunction(
        () => {
          const d = document.querySelector('[role="dialog"]');
          return d && /探测失败|已探测|探测成功/.test(d.textContent || "");
        },
        { timeout: 45_000 },
      )
      .catch(() => addFinding("info", { text: "probe still running after 45s" }));
    await sleep(800);
    const errPre = dialog.locator("pre");
    if (await errPre.count()) {
      addFinding("info", { text: `probe error shown: ${(await errPre.first().textContent())?.slice(0, 300)}` });
    }
  });

  await step("agents: enable switch state after failed probe", async () => {
    const dialog = page.getByRole("dialog", { name: /编辑 audit-agent|招募 Agent/ });
    const sw = dialog.getByRole("switch");
    const n = await sw.count();
    for (let i = 0; i < n; i++) {
      const disabled = await sw.nth(i).isDisabled();
      addFinding("info", { text: `switch[${i}] disabled=${disabled}` });
    }
    if (n) await sw.first().click().catch(() => {}); // try anyway — is it truly gated?
    await sleep(800);
  });

  await step("agents: delete profile (inline confirm)", async () => {
    const dialog = page.getByRole("dialog", { name: /编辑 audit-agent|招募 Agent/ });
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await sleep(300);
    await dialog.getByRole("button", { name: "确认删除" }).click();
    await sleep(1000);
  });

  await step("agents: cleanup via API", async () => {
    const res = await api("DELETE", "/v1/agent-profiles/audit-agent");
    addFinding("info", { text: `DELETE audit-agent -> ${res.status} ${res.text.slice(0, 120)}` });
  });
}

async function sectionMissions() {
  let auditMissionId = null;

  await step("missions: open list + filter chips", async () => {
    await go("missions");
    const tabs = page.getByRole("tablist", { name: "任务状态筛选" }).getByRole("tab");
    const n = await tabs.count();
    const labels = [];
    for (let i = 0; i < n; i++) {
      labels.push(await tabs.nth(i).textContent());
      await tabs.nth(i).click();
      await sleep(250);
    }
    addFinding("info", { text: `filter chips: ${labels.join(" | ")}` });
    await tabs.first().click(); // back to 全部
  });

  await step("missions: create drawer — empty goal disabled", async () => {
    await page.getByRole("button", { name: "新建任务" }).first().click();
    await sleep(400);
    const dialog = page.getByRole("dialog", { name: "新建任务" });
    const submit = dialog.getByRole("button", { name: "创建任务" });
    addFinding("info", { text: `submit disabled with empty goal: ${await submit.isDisabled()}` });
  });

  await step("missions: create mission (expect executor-profile failure)", async () => {
    const dialog = page.getByRole("dialog", { name: "新建任务" });
    await dialog.locator("#mission-goal").fill("AUDIT: test mission — plan only, do not execute");
    await dialog.getByRole("button", { name: "创建任务" }).click();
    const navigated = await page
      .waitForURL(/#\/missions\/.+/, { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    if (navigated) {
      auditMissionId = decodeURIComponent(page.url().split("#/missions/")[1]);
      addFinding("info", { text: `created mission ${auditMissionId}` });
      await sleep(10_000); // let planning run / fail
    } else {
      // Creation rejected — close the drawer so later steps can proceed.
      await dialog.getByRole("button", { name: "取消" }).click();
      await sleep(400);
    }
  });

  await step("missions: detail — new mission planning outcome", async () => {
    if (!auditMissionId) return;
    const text = await page.locator("main").textContent();
    addFinding("info", { text: `detail text: ${text.replace(/\s+/g, " ").slice(0, 500)}` });
  });

  await step("missions: message main agent", async () => {
    if (!auditMissionId) return;
    await page.locator("#mission-main-message").fill("AUDIT: status?");
    await page.locator("form").getByRole("button", { name: "发送" }).click();
    await sleep(3000);
  });

  await step("missions: cancel audit mission", async () => {
    if (!auditMissionId) return;
    const cancel = page.getByRole("button", { name: "取消任务" });
    if (await cancel.count()) {
      await cancel.click();
      await sleep(300);
      await page.getByRole("button", { name: "确认取消" }).click();
      await sleep(2000);
    }
  });

  await step("missions: open existing mission (fallback plan)", async () => {
    await go("missions");
    const row = page.locator('[role="button"][tabindex="0"]').filter({ hasText: "你好" }).first();
    if (!(await row.count())) {
      addFinding("info", { text: "pre-existing 你好 mission not found" });
      return;
    }
    await row.click();
    await sleep(4000);
  });

  await step("missions: plan card — 调整团队 edit + 放弃修改", async () => {
    const edit = page.getByRole("button", { name: "调整团队" });
    if (!(await edit.count())) {
      addFinding("info", { text: "no 调整团队 button (plan not awaiting confirmation?)" });
      return;
    }
    await edit.click();
    await sleep(600);
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `edit-mode text: ${body.replace(/\s+/g, " ").slice(0, 400)}` });
    await page.getByRole("button", { name: "放弃修改" }).click();
    await sleep(400);
  });

  await step("missions: confirm plan → execution without runtimes", async () => {
    const confirm = page.getByRole("button", { name: "确认计划" });
    if (!(await confirm.count())) return;
    await confirm.click();
    await sleep(12_000); // execution starts → agents spawn/fail
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `post-confirm text: ${body.replace(/\s+/g, " ").slice(0, 500)}` });
  });

  await step("missions: cancel the confirmed mission", async () => {
    const cancel = page.getByRole("button", { name: "取消任务" });
    if (await cancel.count()) {
      await cancel.click();
      await sleep(300);
      await page.getByRole("button", { name: "确认取消" }).click();
      await sleep(2500);
    }
    await go("missions");
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `list after cancels: ${body.replace(/\s+/g, " ").slice(0, 300)}` });
  });

  await step("missions: cleanup via API", async () => {
    if (auditMissionId) {
      const res = await api("POST", `/v1/missions/${encodeURIComponent(auditMissionId)}/cancel`);
      addFinding("info", { text: `cancel ${auditMissionId} -> ${res.status} ${res.text.slice(0, 150)}` });
    }
  });
}

async function sectionInbox() {
  await step("inbox: open page + tabs + refresh", async () => {
    await go("inbox");
    await page.getByRole("tab", { name: /已处理/ }).click();
    await sleep(500);
    await page.getByRole("tab", { name: /待处理/ }).click();
    await sleep(500);
    await page.getByRole("button", { name: "刷新" }).click();
    await sleep(1000);
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `inbox body: ${body.replace(/\s+/g, " ").slice(0, 200)}` });
  });
}

async function sectionAutomations() {
  let auditId = null;

  await step("automations: open page", async () => {
    await go("automations");
    await sleep(600);
    const rows = await page.locator('[role="button"][tabindex="0"]').count();
    addFinding("info", { text: `existing automation rows: ${rows}` });
  });

  await step("automations: open create drawer", async () => {
    const headerBtn = page.getByRole("button", { name: "新建自动化" });
    if (await headerBtn.count()) {
      await headerBtn.first().click();
    } else {
      await page.getByText("或从空白自定义开始").click();
    }
    await sleep(500);
    if (!(await page.getByRole("dialog", { name: "新建自动化" }).count())) throw new Error("create drawer did not open");
  });

  await step("automations: save empty draft (validation)", async () => {
    const dialog = page.getByRole("dialog", { name: "新建自动化" });
    await dialog.getByRole("button", { name: "创建" }).click();
    await sleep(400);
  });

  await step("automations: invalid cron inline error", async () => {
    const dialog = page.getByRole("dialog", { name: "新建自动化" });
    await dialog.getByPlaceholder("每日晨报").fill("AUDIT automation");
    await dialog.locator("textarea").fill("AUDIT instructions body");
    await dialog.getByPlaceholder("0 9 * * *").fill("not-a-cron");
    await sleep(400);
    addFinding("info", { text: `save disabled with bad cron: ${await dialog.getByRole("button", { name: "创建" }).isDisabled()}` });
  });

  await step("automations: create with preset cron", async () => {
    const dialog = page.getByRole("dialog", { name: "新建自动化" });
    // pick the first frequency preset chip, then create
    const chips = dialog.locator("button.rounded-full");
    if (await chips.count()) await chips.first().click();
    await dialog.getByRole("button", { name: "创建" }).click();
    await sleep(1500);
    // capture the created id from the API trace (last POST /v1/automations 200)
    const list = await api("GET", "/v1/automations");
    const found = (list.json?.tasks ?? []).find((t) => t.title === "AUDIT automation");
    auditId = found?.id ?? null;
    addFinding("info", { text: `created automation id: ${auditId}` });
  });

  await step("automations: toggle enable switch", async () => {
    const row = page.locator("div", { hasText: "AUDIT automation" }).last();
    const sw = page.getByRole("switch").first();
    await sw.click();
    await sleep(800);
    await sw.click();
    await sleep(800);
  });

  await step("automations: expand 运行记录", async () => {
    await page.getByText("运行记录").first().click();
    await sleep(1200);
  });

  await step("automations: open editor + 立即运行", async () => {
    await page.getByText("AUDIT automation").first().click();
    await sleep(800);
    const dialog = page.getByRole("dialog", { name: /编辑 AUDIT automation/ });
    await dialog.getByRole("button", { name: "立即运行" }).click();
    await sleep(3000);
    addFinding("info", { text: `hash after 立即运行: ${await page.evaluate(() => location.hash)}` });
    // let the run's first turn fail (no model key) and finalize
    await sleep(8000);
  });

  await step("automations: run history after failed run", async () => {
    await go("automations");
    await sleep(800);
    await page.getByText("运行记录").first().click();
    await sleep(1500);
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `runs view: ${body.replace(/\s+/g, " ").slice(0, 400)}` });
  });

  await step("automations: delete via editor", async () => {
    await page.getByText("AUDIT automation").first().click();
    await sleep(800);
    const dialog = page.getByRole("dialog", { name: /编辑 AUDIT automation/ });
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await sleep(300);
    await dialog.getByRole("button", { name: "确认删除" }).click();
    await sleep(1200);
  });

  await step("automations: cleanup via API", async () => {
    if (auditId) {
      const res = await api("DELETE", `/v1/automations/${encodeURIComponent(auditId)}`);
      addFinding("info", { text: `DELETE automation -> ${res.status} ${res.text.slice(0, 120)}` });
    }
  });
}

async function sectionIntegrations() {
  // ---- 连接器 tab ----------------------------------------------------------
  await step("integrations: connectors tab + search", async () => {
    await go("integrations");
    await sleep(1200);
    await page.getByPlaceholder("搜索").fill("tele");
    await sleep(400);
    const rows = await page.locator('[data-testid="available-list"] [role="button"]').count();
    addFinding("info", { text: `available rows matching 'tele': ${rows}` });
    await page.getByPlaceholder("搜索").fill("");
    await sleep(400);
  });

  await step("integrations: open telegram detail", async () => {
    await page.locator('[data-testid="available-list"] [role="button"]', { hasText: "Telegram" }).first().click();
    await sleep(600);
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `telegram detail: ${body.replace(/\s+/g, " ").slice(0, 250)}` });
  });

  await step("integrations: telegram connect with bogus token", async () => {
    await page.getByTestId("detail-connect-btn").click();
    await sleep(500);
    const sheet = page.getByTestId("connect-sheet");
    if (!(await sheet.count())) throw new Error("connect sheet did not open");
    await sheet.locator("input").first().fill("AUDIT-BOGUS-TOKEN-123");
    await sheet.getByRole("button", { name: "连接", exact: true }).last().click();
    await sleep(6000); // backend validates against the Telegram API
    const errText = await sheet.locator(".text-danger").evaluateAll((els) => els.map((e) => e.textContent));
    addFinding("info", { text: `sheet error: ${JSON.stringify(errText).slice(0, 300)}` });
  });

  await step("integrations: close sheet, check page-level error duplication", async () => {
    await page.keyboard.press("Escape");
    await sleep(600);
    const alerts = await page.locator('[role="alert"]').evaluateAll((els) => els.map((e) => e.textContent));
    addFinding("info", { text: `page alerts after close: ${JSON.stringify(alerts).slice(0, 300)}` });
    await page.getByText("‹ 连接器").click();
    await sleep(500);
  });

  await step("integrations: connected connector detail (browser)", async () => {
    const row = page.locator('[data-testid="connected-list"] button').first();
    if (!(await row.count())) {
      addFinding("info", { text: "no connected connectors" });
      return;
    }
    const name = await row.textContent();
    addFinding("info", { text: `connected row: ${name?.replace(/\s+/g, " ").slice(0, 120)}` });
    await row.click();
    await sleep(600);
    // tools disclosure
    const tools = page.locator("details", { hasText: "工具" }).last();
    if (await tools.count()) {
      await tools.locator("summary").click();
      await sleep(400);
      const box = tools.locator('input[type="checkbox"]').first();
      if (await box.count()) {
        await box.click();
        await sleep(800);
        await box.click(); // restore
        await sleep(800);
      }
    }
    await page.getByText("‹ 连接器").click();
    await sleep(400);
  });

  await step("integrations: telegram tools toggle while unconnected", async () => {
    await page.locator('[data-testid="available-list"] [role="button"]', { hasText: "Telegram" }).first().click();
    await sleep(500);
    const tools = page.locator("details", { hasText: "工具" }).last();
    if (await tools.count()) {
      await tools.locator("summary").click();
      await sleep(400);
      const box = tools.locator('input[type="checkbox"]').first();
      if (await box.count()) {
        await box.click();
        await sleep(900);
        await box.click();
        await sleep(900);
      } else {
        addFinding("info", { text: "telegram tools disclosure has no checkboxes" });
      }
    } else {
      addFinding("info", { text: "no tools disclosure for telegram" });
    }
    await page.getByText("‹ 连接器").click();
    await sleep(400);
  });

  // ---- MCP 服务器 tab -------------------------------------------------------
  await step("integrations: mcp tab — add drawer validation", async () => {
    await page.getByTestId("integrations-tab-mcp").click();
    await sleep(800);
    await page.getByRole("button", { name: "＋ 添加服务器" }).click();
    await sleep(400);
    const dialog = page.getByRole("dialog", { name: "添加 MCP 服务器" });
    await dialog.getByRole("button", { name: "保存" }).click(); // empty form
    await sleep(500);
  });

  await step("integrations: mcp add stdio fake command", async () => {
    const dialog = page.getByRole("dialog", { name: "添加 MCP 服务器" });
    await dialog.getByPlaceholder("如 filesystem").fill("audit-mcp");
    await dialog.getByPlaceholder("如 npx 或 uvx").fill("audit-fake-mcp-binary");
    await dialog.getByPlaceholder('["-y","@modelcontextprotocol/server-filesystem"]').fill("[]");
    await dialog.getByRole("button", { name: "保存" }).click();
    await sleep(1500);
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `mcp list after add: ${body.replace(/\s+/g, " ").slice(0, 300)}` });
  });

  await step("integrations: mcp tools view (spawn fails)", async () => {
    const btn = page.getByTestId("mcp-tools-audit-mcp");
    if (!(await btn.count())) throw new Error("audit-mcp row missing");
    await btn.click();
    await sleep(6000); // tries to spawn the fake binary
    const area = page.getByTestId("mcp-tools-list-audit-mcp");
    if (await area.count()) {
      addFinding("info", { text: `tools area: ${(await area.textContent())?.replace(/\s+/g, " ").slice(0, 250)}` });
    }
  });

  await step("integrations: mcp toggle + reload", async () => {
    const row = page.getByTestId("mcp-server-audit-mcp");
    await row.getByRole("switch").click();
    await sleep(1000);
    await row.getByRole("switch").click();
    await sleep(1000);
    await page.getByRole("button", { name: "立即重载" }).click();
    await sleep(2500);
  });

  await step("integrations: mcp edit + delete", async () => {
    await page.getByTestId("mcp-server-audit-mcp").locator('[role="button"]').first().click();
    await sleep(600);
    const dialog = page.getByRole("dialog", { name: "编辑 audit-mcp" });
    await dialog.getByRole("button", { name: "删除服务器" }).click();
    await sleep(300);
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await sleep(1200);
  });

  await step("integrations: mcp add http server + delete (no OAuth click)", async () => {
    await page.getByRole("button", { name: "＋ 添加服务器" }).click();
    await sleep(400);
    const dialog = page.getByRole("dialog", { name: "添加 MCP 服务器" });
    await dialog.getByRole("button", { name: "远程 HTTP" }).click();
    await dialog.getByPlaceholder("如 filesystem").fill("audit-http");
    await dialog.getByPlaceholder("https://mcp.example.com/mcp").fill("http://127.0.0.1:9/nope");
    await dialog.getByRole("button", { name: "保存" }).click();
    await sleep(1500);
    const row = page.getByTestId("mcp-server-audit-http");
    addFinding("info", { text: `http row: ${(await row.textContent())?.replace(/\s+/g, " ").slice(0, 250)}` });
    // NB: 授权连接 would open a browser on the host — deliberately not clicked.
    await row.locator('[role="button"]').first().click();
    await sleep(600);
    const edit = page.getByRole("dialog", { name: "编辑 audit-http" });
    await edit.getByRole("button", { name: "删除服务器" }).click();
    await sleep(300);
    await edit.getByRole("button", { name: "删除", exact: true }).click();
    await sleep(1200);
  });

  // ---- 消息路由 tab ---------------------------------------------------------
  await step("integrations: routing tab — binding add + neutralize", async () => {
    await page.getByTestId("integrations-tab-routing").click();
    await sleep(800);
    await page.getByTestId("binding-name").fill("audit-inbox");
    await page.getByPlaceholder("平台,如 slack").fill("slack");
    await page.getByPlaceholder("目标,如 T0123/C0123").fill("T000/C000");
    await page.getByRole("button", { name: "添加" }).last().click();
    await sleep(1000);
    const neutralize = page.getByRole("button", { name: "改为仅应用内" });
    if (await neutralize.count()) await neutralize.first().click();
    await sleep(800);
  });

  await step("integrations: routing — DM route set + clear", async () => {
    const select = page.getByTestId("dm-route-session");
    const options = await select.locator("option").evaluateAll((els) => els.map((e) => e.textContent));
    addFinding("info", { text: `dm session options: ${options.length}` });
    if (options.length > 1) {
      await select.selectOption({ index: 1 });
      await page.getByRole("button", { name: "设为默认" }).click();
      await sleep(900);
      await page.getByRole("button", { name: "清除" }).click();
      await sleep(900);
    }
  });

  // ---- 审计 tab -------------------------------------------------------------
  await step("integrations: audit tab + filters", async () => {
    await page.getByTestId("integrations-tab-audit").click();
    await sleep(1200);
    await page.getByPlaceholder("连接器").fill("telegram");
    await page.getByRole("button", { name: "筛选" }).click();
    await sleep(1000);
    const list = page.getByTestId("audit-list");
    addFinding("info", { text: `audit rows for telegram: ${(await list.count()) ? await list.locator("details").count() : 0}` });
    await page.getByPlaceholder("连接器").fill("");
    await page.getByRole("button", { name: "筛选" }).click();
    await sleep(1000);
    const all = page.getByTestId("audit-list");
    if (await all.count()) {
      // expand the first row
      await all.locator("summary").first().click();
      await sleep(400);
    }
  });
}

async function sectionSettings() {
  const nav = (label) => page.getByRole("button", { name: label, exact: true }).first();

  await step("settings: appearance — theme segmented", async () => {
    await go("settings");
    await sleep(800);
    const group = page.getByRole("radiogroup", { name: "外观主题" });
    const opts = group.getByRole("radio");
    const n = await opts.count();
    addFinding("info", { text: `theme options: ${n}` });
    for (let i = 0; i < n; i++) {
      await opts.nth(i).click();
      await sleep(250);
    }
  });

  await step("settings: models — default select roundtrip", async () => {
    await nav("模型").click();
    await sleep(1000);
    const select = page.locator("select").first();
    const values = await select.locator("option").evaluateAll((els) => els.map((e) => e.value));
    addFinding("info", { text: `default model options: ${JSON.stringify(values).slice(0, 200)}` });
    if (values.length > 1) {
      await select.selectOption(values[1]);
      await sleep(800);
      await select.selectOption(values[0]);
      await sleep(800);
    }
  });

  await step("settings: models — add invalid then valid model", async () => {
    const input = page.getByPlaceholder("模型 ID,如 provider/model-name");
    await input.fill("AUDIT BAD MODEL");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await sleep(500);
    await input.fill("openai:audit-model");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await sleep(1000);
  });

  await step("settings: models — remove the audit model", async () => {
    const trash = page.getByTitle("移除 openai:audit-model");
    if (await trash.count()) {
      await trash.click();
      await sleep(1000);
    } else {
      addFinding("info", { text: "audit model row not found (add may have failed)" });
    }
  });

  await step("settings: provider drawer — verify bogus key", async () => {
    const row = page.locator('[role="button"][tabindex="0"]').filter({ hasText: "OpenAI" }).first();
    const target = (await row.count()) ? row : page.locator('[role="button"][tabindex="0"]').first();
    await target.click();
    await sleep(600);
    const dialog = page.getByRole("dialog");
    const dialogLabel = await dialog.getAttribute("aria-label");
    addFinding("info", { text: `provider drawer: ${dialogLabel}` });
    const secret = dialog.locator('input[type="password"]').first();
    if (await secret.count()) {
      await secret.fill("AUDIT-FAKE-KEY-123");
      await sleep(300);
    }
    await dialog.getByRole("button", { name: /验证并保存|检测并保存/ }).click();
    await sleep(8000); // verify hits the vendor API
    const err = await dialog.locator('[role="alert"]').evaluateAll((els) => els.map((e) => e.textContent));
    addFinding("info", { text: `verify result: ${JSON.stringify(err).slice(0, 300)}` });
    await dialog.getByTitle("关闭").click();
    await sleep(400);
  });

  await step("settings: voice section (browser build)", async () => {
    await nav("语音").click();
    await sleep(800);
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `voice body: ${body.replace(/\s+/g, " ").slice(0, 250)}` });
  });

  await step("settings: memory — add entry", async () => {
    await nav("记忆").click();
    await sleep(800);
    await page.getByPlaceholder("例如:回复一律使用简体中文").fill("AUDIT memory entry — safe to delete");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await sleep(1200);
    const body = await page.locator("main").textContent();
    addFinding("info", { text: `memory after add: ${body.includes("AUDIT memory entry")}` });
  });

  await step("settings: personas — install bogus git URL", async () => {
    await nav("Personas").click();
    await sleep(1000);
    await page.getByPlaceholder("https://github.com/acme/ops-persona").fill("https://example.com/audit-nope.git");
    await page.getByRole("button", { name: "安装", exact: true }).click();
    await sleep(10_000); // git clone attempt
  });

  await step("settings: personas — toggle builtin off/on", async () => {
    const sw = page.getByRole("switch").first();
    if (await sw.count()) {
      await sw.click();
      await sleep(1200);
      await sw.click();
      await sleep(1200);
    }
  });

  await step("settings: personas — detail drawer", async () => {
    const row = page.locator('[role="button"][tabindex="0"]').first();
    await row.click();
    await sleep(1200);
    const dialog = page.getByRole("dialog", { name: "Persona 详情" });
    if (await dialog.count()) {
      await dialog.getByTitle("关闭").click();
      await sleep(400);
    }
  });

  await step("settings: advanced — files form invalid + valid", async () => {
    await nav("高级").click();
    await sleep(1000);
    const input = page.getByPlaceholder("~/OpenWorker");
    const original = await input.inputValue();
    addFinding("info", { text: `scratch base: ${original}` });
    await input.fill("relative/path");
    await page.getByRole("button", { name: "保存" }).first().click();
    await sleep(600);
    await input.fill(original);
    await page.getByRole("button", { name: "保存" }).first().click();
    await sleep(800);
  });

  await step("settings: advanced — pdf + compaction + websearch saves", async () => {
    // PDF form: second 保存 button on the page
    const saves = page.getByRole("button", { name: "保存", exact: true });
    const n = await saves.count();
    addFinding("info", { text: `save buttons in advanced: ${n}` });
    for (let i = 1; i < n && i < 4; i++) {
      await saves.nth(i).click();
      await sleep(900);
    }
  });

  await step("settings: advanced — experimental connectors toggle", async () => {
    const sw = page.getByRole("switch").last();
    await sw.click();
    await sleep(1000);
    await sw.click();
    await sleep(1000);
  });
}

const SECTIONS = {
  assistant: sectionAssistant,
  agents: sectionAgents,
  missions: sectionMissions,
  inbox: sectionInbox,
  automations: sectionAutomations,
  integrations: sectionIntegrations,
  settings: sectionSettings,
};

async function main() {
  const args = process.argv.slice(2);
  const wanted = args.length ? args : Object.keys(SECTIONS);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  ctx.setDefaultTimeout(8000);
  await ctx.addInitScript(
    ({ http, ws, token }) => {
      window.__COWORKER_HTTP__ = http;
      window.__COWORKER_WS__ = ws;
      window.__COWORKER_API_TOKEN__ = token;
    },
    { http: BACKEND, ws: BACKEND.replace(/^http/, "ws"), token: TOKEN },
  );
  page = await ctx.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") addFinding("console.error", { text: msg.text().slice(0, 400) });
  });
  page.on("pageerror", (err) => addFinding("pageerror", { text: String(err).slice(0, 500) }));
  page.on("requestfailed", (req) => {
    if (!req.url().startsWith(BACKEND)) return;
    addFinding("requestfailed", {
      method: req.method(),
      path: req.url().slice(BACKEND.length),
      failure: req.failure()?.errorText,
    });
  });
  page.on("websocket", (ws) => {
    if (!ws.url().includes("8899")) return;
    apiTrace.push({ step: currentStep, ws: ws.url() });
    ws.on("socketerror", (e) => addFinding("ws-error", { url: ws.url(), text: String(e) }));
    ws.on("close", () => addFinding("ws-close", { url: ws.url() }));
  });
  page.on("response", async (res) => {
    const url = res.url();
    if (!url.startsWith(BACKEND)) return;
    const p = url.slice(BACKEND.length);
    const status = res.status();
    const req = res.request();
    const reqBody = req.postData()?.slice(0, 300);
    apiTrace.push({ step: currentStep, method: req.method(), path: p, status });
    if (status >= 400) {
      let body = "";
      try { body = (await res.text()).slice(0, 400); } catch {}
      addFinding("http>=400", { method: req.method(), path: p, status, reqBody, respBody: body });
      return;
    }
    const ct = res.headers()["content-type"] || "";
    if (ct.includes("json")) {
      try {
        const j = await res.json();
        if (j && typeof j === "object" && j.ok === false) {
          addFinding("ok:false", {
            method: req.method(),
            path: p,
            reqBody,
            error: typeof j.error === "string" ? j.error : JSON.stringify(j).slice(0, 300),
          });
        }
      } catch { /* not json */ }
    }
  });

  for (const name of wanted) {
    const fn = SECTIONS[name];
    if (!fn) { console.error(`unknown section ${name}`); continue; }
    await fn();
  }

  fs.writeFileSync(FINDINGS_PATH, JSON.stringify({ findings, apiTrace }, null, 2));
  console.log(`\n\n${findings.length} findings -> ${FINDINGS_PATH}`);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
