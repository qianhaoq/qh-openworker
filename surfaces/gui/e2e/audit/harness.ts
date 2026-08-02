// Screenshot-audit harness: theme control, the shot helper (one test step per PNG),
// an EXTENDED scripted session agent (superset of fixtures.ts' fake agent — adds the
// question/plan/directory prompt cards), rich per-test seeds layered over the shared
// mocks via route.fallback(), and a console-error collector written to _report.json.
//
// Everything here is additive: the shared fixture routes are registered first (the
// `page` fixture calls mockApi before the test body), so the overrides below win for
// the paths they handle and fall through for everything else. Existing specs are
// untouched.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test } from "../fixtures";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHOTS_DIR = path.join(HERE, "..", "audit-shots");

// ---------------------------------------------------------------------------
// theme + capture
// ---------------------------------------------------------------------------

export type Theme = "light" | "dark";

/** Pin the appearance before the app boots (index.html reads the same key pre-paint). */
export async function setTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("openwork-theme", t);
    } catch {
      /* private mode — the app still defaults sanely */
    }
  }, theme);
}

/** One screenshot = one test step. PNGs land in e2e/audit-shots/<name>.png. */
export async function capture(page: Page, name: string, theme?: Theme): Promise<void> {
  await test.step(`📸 ${name}`, async () => {
    if (theme) {
      // Guard against a theme that never applied (would silently mislabel the shot).
      await page.waitForFunction(
        (t) => document.documentElement.dataset.theme === t,
        theme,
        { timeout: 5_000 },
      );
    }
    // Let menus/drawers finish their enter transitions before the exposure.
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage: true });
  });
}

// ---------------------------------------------------------------------------
// console-error + notes collection → audit-shots/_report.json
// ---------------------------------------------------------------------------

const consoleErrors: { test: string; source: string; text: string }[] = [];
const notes: { test: string; note: string }[] = [];
let currentTest = "(setup)";

export function collectConsole(page: Page, title: string): void {
  currentTest = title;
  page.on("console", (msg) => {
    if (msg.type() === "error")
      consoleErrors.push({ test: currentTest, source: "console.error", text: msg.text() });
  });
  page.on("pageerror", (err) => {
    consoleErrors.push({ test: currentTest, source: "pageerror", text: String(err) });
  });
}

export function addNote(note: string): void {
  notes.push({ test: currentTest, note });
}

export function writeReport(): void {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  // fullyParallel workers each hold their own collectors — one file per worker.
  const file = path.join(SHOTS_DIR, `_report-worker${process.env.TEST_WORKER_INDEX ?? 0}.json`);
  fs.writeFileSync(file, JSON.stringify({ consoleErrors, notes }, null, 2));
  if (!consoleErrors.length && !notes.length) return;
  console.log(`\n[audit] ${consoleErrors.length} console error(s), ${notes.length} note(s) → ${file}`);
  for (const e of consoleErrors) console.log(`[audit][${e.source}] (${e.test}) ${e.text}`);
  for (const n of notes) console.log(`[audit][note] (${n.test}) ${n.note}`);
}

// ---------------------------------------------------------------------------
// composer helper
// ---------------------------------------------------------------------------

export const composer = (page: Page) =>
  page.getByPlaceholder("给助手发消息…");

export async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

// ---------------------------------------------------------------------------
// The extended scripted session agent. Registered AFTER mockApi's, so it wins.
// Mirrors the fixture's protocol (ready / turn_start / deltas / turn_done, the
// suspended "run a tool" approval, the reasoning turn, the slow epic stream) and
// adds the three prompt cards the fixture agent never raises:
//   · "ask me a question"  → question_requested (options + free text), suspended
//   · "propose a plan"     → plan_proposed, suspended
//   · "request a directory"→ directory_requested, suspended
//   · "show me markdown"   → a rich markdown assistant_message (code block, list, quote)
// ---------------------------------------------------------------------------

export const MARKDOWN_REPLY = [
  "这是上一轮整理好的发布说明草稿，要点列表和示例代码都在里面：",
  "",
  "- 支持 Slack 频道订阅，@ 提及会自动开新会话",
  "- 自动化任务现在可以常驻授权，避免每次审批",
  "- 设置页新增「记忆」分区，回复偏好长期生效",
  "",
  "核心改动如下：",
  "",
  "```python",
  "def summarize(commits):",
  '    """Pick the three most user-visible commits."""',
  "    top = sorted(commits, key=lambda c: c.impact, reverse=True)[:3]",
  '    return "\\n".join(f"- {c.title}" for c in top)',
  "```",
  "",
  "> 建议：发布说明保持一屏以内，细节放到链接里。",
  "",
  "如果需要，我可以继续生成英文版，或者把 `summarize` 改成按主题分组。",
].join("\n");

export function installAuditSessionAgent(page: Page): Promise<void> {
  return page.routeWebSocket(/\/ws\/session\//, (ws) => {
    const send = (type: string, data: Record<string, unknown> = {}) =>
      ws.send(JSON.stringify({ type, data }));
    send("ready");
    let pendingTool = "run_shell";
    let epicTimer: ReturnType<typeof setInterval> | null = null;

    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "user_message") {
        send("turn_start", { input: msg.text });
        // Inline permission card — suspends until the client's approval decision.
        if (/run a tool/i.test(msg.text)) {
          pendingTool = "run_shell";
          const args = { command: "ls -la ~/OpenWorker/launch-note" };
          send("tool_proposed", { name: "run_shell", arguments: args });
          send("permission_required", {
            name: "run_shell",
            arguments: args,
            reason: "The coworker wants to run a command.",
          });
          return;
        }
        // Question card (quick options + free text).
        if (/ask me a question/i.test(msg.text)) {
          send("question_requested", {
            question: "这份发布说明主要面向哪类读者？",
            options: ["内部团队", "现有用户", "潜在用户"],
            allow_text: true,
            multi: false,
          });
          return;
        }
        // Plan card (markdown plan body).
        if (/propose a plan/i.test(msg.text)) {
          send("plan_proposed", {
            plan: [
              "## 发布说明起草计划",
              "",
              "1. 通读本周期 diff，提炼三条用户可感知的变化",
              "2. 起草中文版（一屏以内），再翻成英文",
              "3. 生成 1440×900 封面图并附上 CHANGELOG 链接",
              "",
              "预计 15 分钟，完成后请你过目。",
            ].join("\n"),
          });
          return;
        }
        // Directory-access card.
        if (/request a directory/i.test(msg.text)) {
          send("directory_requested", {
            reason: "需要读取你桌面上的截图文件夹，挑选发布说明的封面图。",
            path: "/Users/test/Desktop/screenshots",
            writable: false,
          });
          return;
        }
        // Reasoning turn: thinking deltas tick in, then the answer with the full trace.
        if (/think hard/i.test(msg.text)) {
          const thoughts = [
            "读者首先是现有用户，所以变化要按影响面排序。 ",
            "Slack 订阅和常驻授权是功能项，记忆分区是体验项。 ",
            "封面图放最后，依赖文案定稿。",
          ];
          let tick = 0;
          const timer = setInterval(() => {
            if (tick < thoughts.length) {
              send("reasoning_delta", { text: thoughts[tick] });
              tick += 1;
              return;
            }
            clearInterval(timer);
            send("assistant_message", {
              text: "Decision made — 按影响面排序，功能项在前。",
              reasoning: thoughts.join(""),
            });
            send("turn_done");
          }, 60);
          return;
        }
        // A deliberately SLOW stream so the audit can capture a reply mid-flight.
        if (/stream the epic/i.test(msg.text)) {
          let ticks = 0;
          const line = "The epic scrolls ever onward, line upon line upon line. ";
          epicTimer = setInterval(() => {
            ticks += 1;
            send("assistant_delta", { text: line.repeat(3) + "\n\n" });
            if (ticks >= 40) {
              clearInterval(epicTimer!);
              epicTimer = null;
              send("assistant_message", { text: ("The epic concludes. " + line).repeat(20) });
              send("turn_done");
            }
          }, 120);
          return;
        }
        // Rich markdown reply (code block, list, quote, inline code).
        if (/show me markdown/i.test(msg.text)) {
          send("assistant_message", {
            text: MARKDOWN_REPLY,
            usage: {
              model: msg.model || "anthropic:claude-opus-4-8",
              input: 2_400,
              output: 640,
              cache_read: 12_000,
              cache_write: 1_100,
            },
          });
          send("turn_done");
          return;
        }
        // Default echo (fixture parity, with the usage sidecar so the rail has data).
        send("assistant_delta", { text: "Echo: " });
        send("assistant_delta", { text: msg.text });
        send("assistant_message", {
          text: `Echo: ${msg.text}`,
          usage: {
            model: msg.model || "anthropic:claude-opus-4-8",
            input: 1_000,
            output: 200,
            cache_read: 8_000,
            cache_write: 800,
          },
        });
        send("turn_done");
      } else if (msg.type === "approval") {
        if (msg.decision === "deny") {
          send("tool_finished", { name: pendingTool, status: "denied" });
          send("assistant_message", { text: "Understood — skipped the command." });
        } else {
          send("tool_finished", {
            name: pendingTool,
            status: "done",
            result_preview: "README.md  cover.html  launch-note.md",
          });
          send("assistant_message", { text: "The command ran; 3 files found." });
        }
        send("turn_done");
      } else if (msg.type === "interrupt") {
        if (epicTimer) {
          clearInterval(epicTimer);
          epicTimer = null;
        }
        send("interrupted", {});
        send("turn_done");
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Rich seeds, layered over the shared mocks (route.fallback passes the rest down).
// ---------------------------------------------------------------------------

const NOW = Math.floor(Date.now() / 1000);

const ARTIFACTS = [
  { path: "launch-note.md", abs_path: "/Users/test/OpenWorker/launch-note/launch-note.md", name: "launch-note.md", kind: "markdown", size: 4_821, modified_at: NOW - 540 },
  { path: "cover.html", abs_path: "/Users/test/OpenWorker/launch-note/cover.html", name: "cover.html", kind: "html", size: 12_804, modified_at: NOW - 260 },
  { path: "chart-signups.png", abs_path: "/Users/test/OpenWorker/launch-note/chart-signups.png", name: "chart-signups.png", kind: "image", size: 80_312, modified_at: NOW - 95 },
];

const MCP_SERVERS = [
  { name: "granola", enabled: true, transport: "http", requires_approval: true, auth: "oauth", status: "connected", last_error: null, tool_count: 6, config: { url: "https://mcp.granola.ai/mcp", auth: "oauth" } },
  { name: "filesystem", enabled: true, transport: "stdio", requires_approval: true, auth: null, status: "connected", last_error: null, tool_count: 11, config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/test/Documents"] } },
  { name: "linear", enabled: false, transport: "http", requires_approval: false, auth: "oauth", status: "needs_auth", last_error: "token expired", tool_count: null, config: { url: "https://mcp.linear.app/sse", auth: "oauth" } },
];

const AUDIT_EVENTS = [
  { id: 6, timestamp: "2026-08-01 17:42:10", session_id: "wp-1", agent: "cowork", workspace: "/Users/test/OpenWorker/launch-note", connector: "slack", tool: "send_message", stage: "done", status: "ok", approval: "always_task", args: { target: "slack:T1DL/C0AAA111", text: "发布说明草稿好了，请过目" }, result_preview: "delivered", reason: "", resource: "slack:T1DL/C0AAA111" },
  { id: 5, timestamp: "2026-08-01 17:40:02", session_id: "wp-1", agent: "cowork", workspace: "/Users/test/OpenWorker/launch-note", connector: "", tool: "write_file", stage: "done", status: "ok", approval: "once", args: { path: "launch-note.md" }, result_preview: "4.7 KB written", reason: "", resource: "launch-note.md" },
  { id: 4, timestamp: "2026-08-01 16:05:44", session_id: "ops-1", agent: "ops", workspace: "/Users/test/OpenWorker/ops-triage", connector: "", tool: "run_shell", stage: "done", status: "denied", approval: "deny", args: { command: "rm -rf build/" }, result_preview: "", reason: "denied by user", resource: "" },
  { id: 3, timestamp: "2026-08-01 15:58:31", session_id: "wp-3", agent: "cowork", workspace: "", connector: "gmail", tool: "gmail_search", stage: "done", status: "ok", approval: "auto", args: { query: "subject:周报 newer_than:7d" }, result_preview: "12 messages", reason: "", resource: "gmail:rohit@gmail.com" },
  { id: 2, timestamp: "2026-08-01 15:12:08", session_id: "__run__r1", agent: "cowork", workspace: "", connector: "github", tool: "github_list_commits", stage: "done", status: "ok", approval: "always_task", args: { repo: "rohit/agent-platform", limit: 20 }, result_preview: "20 commits", reason: "", resource: "github:rohit/agent-platform" },
  { id: 1, timestamp: "2026-08-01 09:00:00", session_id: "pinned-cowork-1", agent: "cowork", workspace: "/Users/test/OpenWorker/launch-note", connector: "", tool: "web_search", stage: "done", status: "error", approval: "auto", args: { query: "aisuite releases" }, result_preview: "", reason: "provider timeout", resource: "" },
];

// ACP permission (the Inbox's PermissionCard section) — one pending request.
const AGENT_PERMISSIONS = [
  {
    permission_id: "perm-1",
    profile_id: "opencode-executor",
    role: "executor",
    session_id: "acp-exec-1",
    tool_call: { name: "bash", arguments: { command: "npm run build && npm test" } },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ],
    state: "pending",
    status: "pending",
    created_at: NOW - 300,
  },
];

// Inbox: one of each kind pending (+ one automation-scoped approval), and a
// resolved set for the 已处理 tab. Shapes mirror fixtures.ts INBOX_ITEMS.
const INBOX_PENDING = [
  {
    id: "inb-approval-1", session_id: "wp-3", kind: "approval",
    title: "Approve: run_shell", body: "rm -rf build/",
    data: { tool: "run_shell", arguments: { command: "rm -rf build/" } },
    state: "pending", resolution: null, inbox: "default",
    created_at: "2026-07-01 08:00:00", resolved_at: null,
    session_title: "Weekly plan 3", session_agent: "cowork", session_workspace: "", session_exists: true,
  },
  {
    id: "inb-approval-2", session_id: "__run__r1", kind: "approval",
    title: "Approve: send_message", body: "Weekly digest ready — post to #ocw-test?",
    data: { tool: "send_message", arguments: { target: "slack:T1DL/C0AAA111", text: "Weekly digest ready" }, task_id: "task-1", standing_target: "slack:T1DL/C0AAA111" },
    state: "pending", resolution: null, inbox: "default",
    created_at: "2026-07-01 08:02:00", resolved_at: null,
    session_title: "Daily AI News · 运行", session_agent: "cowork", session_workspace: "", session_exists: true,
  },
  {
    id: "inb-question-1", session_id: "ops-1", kind: "question",
    title: "Which environment should I restart?", body: "",
    options: ["staging", "production"], allow_text: true, multi: false,
    state: "pending", resolution: null, inbox: "default",
    created_at: "2026-07-01 08:05:00", resolved_at: null,
    session_title: "Investigate alerts", session_agent: "ops", session_workspace: "", session_exists: true,
  },
  {
    id: "inb-directory-1", session_id: "wp-1", kind: "directory",
    title: "助手请求访问一个文件夹", body: "需要读取截图文件夹挑选封面图",
    data: { path: "/Users/test/Desktop/screenshots", writable: false },
    state: "pending", resolution: null, inbox: "default",
    created_at: "2026-07-01 08:07:00", resolved_at: null,
    session_title: "Weekly plan 1", session_agent: "cowork", session_workspace: "", session_exists: true,
  },
  {
    id: "inb-plan-1", session_id: "wp-4", kind: "plan",
    title: "助手提出了一份计划",
    body: "## 周报整理计划\n\n1. 汇总本周 merged PR\n2. 按主题分组\n3. 生成中英双语摘要",
    state: "pending", resolution: null, inbox: "default",
    created_at: "2026-07-01 08:09:00", resolved_at: null,
    session_title: "Weekly plan 4", session_agent: "cowork", session_workspace: "", session_exists: true,
  },
];

const INBOX_RESOLVED = [
  {
    id: "inb-res-1", session_id: "wp-2", kind: "approval",
    title: "Approve: write_file", body: "src/fetch_data.py",
    data: { tool: "write_file", arguments: { path: "src/fetch_data.py" } },
    state: "resolved", resolution: "allow", inbox: "default",
    created_at: "2026-06-30 18:00:00", resolved_at: "2026-06-30 18:01:12",
    session_title: "Weekly plan 2", session_agent: "cowork", session_workspace: "", session_exists: true,
  },
  {
    id: "inb-res-2", session_id: "ops-1", kind: "question",
    title: "要把告警转发到哪个频道？", body: "",
    options: ["#ops-alerts", "#general"], allow_text: true, multi: false,
    state: "resolved", resolution: "#ops-alerts", inbox: "default",
    created_at: "2026-06-30 17:40:00", resolved_at: "2026-06-30 17:44:02",
    session_title: "Investigate alerts", session_agent: "ops", session_workspace: "", session_exists: true,
  },
  {
    id: "inb-res-3", session_id: "wp-5", kind: "directory",
    title: "助手请求访问一个文件夹", body: "读取设计稿导出目录",
    data: { path: "/Users/test/Design/exports", writable: false },
    state: "resolved", resolution: JSON.stringify({ granted: true, path: "/Users/test/Design/exports", writable: false }),
    inbox: "default",
    created_at: "2026-06-30 16:20:00", resolved_at: "2026-06-30 16:25:00",
    session_title: "Weekly plan 5", session_agent: "cowork", session_workspace: "", session_exists: true,
  },
  {
    id: "inb-res-4", session_id: "wp-6", kind: "plan",
    title: "助手提出了一份计划", body: "## 数据清洗计划\n\n1. 去重\n2. 补全缺失字段",
    state: "resolved", resolution: JSON.stringify({ approved: false, feedback: "先只做去重" }),
    inbox: "default",
    created_at: "2026-06-30 15:00:00", resolved_at: "2026-06-30 15:30:00",
    session_title: "Weekly plan 6", session_agent: "cowork", session_workspace: "", session_exists: true,
  },
];

const MEMORY_ITEMS = [
  { id: "mem-1", content: "回复默认使用中文", scope: "workspace", created_at: "2026-07-01 08:00:00" },
  { id: "mem-2", content: "周五下午不发版", scope: "workspace", created_at: "2026-07-01 09:30:00" },
  { id: "mem-3", content: "发布说明控制在 200 字以内", scope: "global", created_at: "2026-07-02 10:15:00" },
];

/** Layer the audit's richer seeds over the shared mocks. Call AFTER mockApi (the
 * fixture does that), so these routes win; everything unmatched falls through. */
export async function installAuditSeeds(page: Page): Promise<void> {
  await page.route("**/v1/**", (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const m = req.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (m === "GET" && /\/v1\/sessions\/[^/]+\/artifacts$/.test(p))
      return json({ artifacts: ARTIFACTS });
    if (m === "GET" && p.endsWith("/v1/mcp")) return json({ servers: MCP_SERVERS });
    if (p.endsWith("/v1/audit")) return json({ events: AUDIT_EVENTS });
    if (p.endsWith("/v1/agent-permissions")) return json({ permissions: AGENT_PERMISSIONS });
    if (m === "GET" && p.endsWith("/v1/inbox")) {
      const state = new URL(req.url()).searchParams.get("state");
      return json({ items: state === "resolved" ? INBOX_RESOLVED : INBOX_PENDING });
    }
    if (m === "GET" && p.endsWith("/v1/memory")) return json({ memory: MEMORY_ITEMS });
    return route.fallback();
  });
}
