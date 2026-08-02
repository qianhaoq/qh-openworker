# Live UI audit — new GUI vs real sidecar (2026-08-02)

Systematic click-through of all 7 sections of `surfaces/gui` (Chromium + Playwright) against a
real `openworker-server` on port 8899 running an **isolated copy** of the user state
(`COWORKER_STATE_DIR=/tmp/qh-audit-state`, token `audit-token`). Providers have no API keys in
this state, so every model-dependent flow was exercised on its failure path.

- Harness (re-runnable): `surfaces/gui/e2e/live-audit.mjs`
  - Prereqs: vite on :1420; sidecar as above on :8899.
  - Run: `cd surfaces/gui && node e2e/live-audit.mjs [assistant|agents|missions|inbox|automations|integrations|settings]`
  - Injects `__COWORKER_HTTP__/__COWORKER_WS__/__COWORKER_API_TOKEN__` via `addInitScript`;
    captures console errors, pageerrors, HTTP ≥ 400, `{ok:false}` envelopes, WS errors, and
    visible error UI (`role=alert`, `.text-danger`, toasts) per step.
- Origin gate: WS + CORS accepted `http://localhost:1420` (allowlist regex in
  `coworker/server/app.py:32` covers localhost) — no handshake issues.
- Noise to ignore on re-runs: one `WebSocket is closed before the connection is established`
  per socket at page load. That's React StrictMode double-mount in dev (`src/main.tsx:26`);
  the second socket connects. Not a production defect.
- Deliberately NOT clicked (host side effects): right-rail 添加文件夹 and 设置→高级 浏览…
  (open native OS dialogs via the sidecar), MCP 授权连接 / connector 一键连接 (open the
  system browser for OAuth), voice dictation controls (desktop-only).

Classifications: (a) frontend bug · (b) contract mismatch · (c) missing frontend guard for a
predictable backend error · (d) dead/confusing control · (e) backend issue.

---

## Issues

### #/missions

**1. [high · (c)] Create mission fails with raw, cryptic English error**
- Repro: `#/missions` → 新建任务 → enter any goal → 创建任务 (with no enabled+probed executor
  agent profile — the default state for a fresh install).
- `POST /v1/missions` `{"goal":"…","title":"…"}` → **400** `{"detail":"confirmed coding
  missions require an executor profile"}` — shown verbatim in the drawer alert.
- Why it's bad: a first-run user hits this on the very first mission. The message doesn't say
  what an executor profile is, where to create one (Agents page), or that it must be
  probed+enabled first. Should be a friendly inline state (or the drawer should pre-check and
  deep-link to `#/agents`).
- Files: `coworker/orchestrator.py:608` (message); `surfaces/gui/src/app/features/missions/MissionsPage.tsx`
  (`CreateMissionDrawer` shows `error` raw); `useMissions.ts` `create`.

**2. [medium · (c)] Confirm plan → raw English 409 banner**
- Repro: open a mission in AWAITING_CONFIRMATION whose plan seats reference disabled profiles
  (e.g. the pre-existing one) → 确认计划.
- `POST /v1/missions/{id}/confirm` → **409** `{"detail":"unknown or disabled mission profile:
  opencode-executor"}` — shown raw in the page `actionError` banner.
- The plan editor already warns in Chinese when a plan lacks an executor seat
  (`PlanCard.tsx:222-226`), but nothing pre-checks profile *enabled* state before confirm.
- Files: `coworker/orchestrator.py:598`; `MissionDetailPage.tsx:200-210`; `useMissionDetail.ts`.

**3. [low · (c)] Composer still active on terminal missions**
- Repro: open a CANCELLED mission → type in the 发给主 Agent composer → 发送.
- `POST /v1/missions/{id}/messages` → **409** `{"detail":"cancelled tasks cannot be reopened"}`
  — raw English in the banner; the draft is lost.
- `MainComposer` renders unconditionally (`MissionDetailPage.tsx:222`); it should be
  disabled/hidden for DONE/APPROVED/CANCELLED like the cancel button already is
  (`cancellable` check at line 160).

### #/automations

**4. [medium · (e)+(a)] A failed 立即运行 is recorded as 完成 (success)**
- Repro: create automation → editor → 立即运行 (no provider key) → the run's session shows the
  model-key error card; back in 自动化 → 运行记录 the run reads **完成 · 手动 · 用时 0 秒**,
  and the automation row's last status is 完成. Indistinguishable from a real success.
- Root cause chain: frontend `drivePreparedRun` finalizes on *any* `turn_done`
  (`useAutomations.ts:43-60`, comment acknowledges it); backend `finalize_manual_run` sets
  `run.status = "ok"` unconditionally (`coworker/server/manager.py:5698`) without looking at
  the turn's error state. The turn error (provider key missing) is only visible inside the
  session itself.
- Either propagate the turn's error flag through `turn_done` and let finalize mark
  `error`, or have finalize inspect the transcript tail for an error event.

### #/integrations

**5. [high · (e)+(c)] Telegram connect with a bad token → the error shown is literally "Not Found"**
- Repro: 连接器 → Telegram → 连接 → paste `AUDIT-BOGUS-TOKEN-123` → 连接.
- `POST /v1/connectors/telegram/connect` → `{ok:false, "error":"Not Found"}` — the sheet shows
  just **Not Found**.
- Root cause: `_validate_telegram` returns Telegram's raw API `description` field
  (`coworker/connectors/descriptors.py:111`); for an invalid token Telegram returns 404
  `{"description":"Not Found"}`. The backend's own fallback "invalid bot token" is only used
  when `description` is missing. Map the 404 to a real message ("bot token 无效").

**6. [medium · (c)] The sheet's error also lingers as a page-level alert after the sheet closes**
- Repro: same as #5 → close the sheet (Esc) → the connectors page now shows an alert reading
  **Not Found**, with zero context.
- `useConnectors.run()` sets the global `actionError` on every failure
  (`useConnectors.ts:113-132`) even though `ManualPane` already displays the same error
  locally (`ConnectSheet.tsx:167-173`). Double reporting + the page-level copy loses all
  context once the sheet is gone. Connect-flow failures should stay sheet-local.

**7. [medium · (c)] MCP tools view surfaces raw Python errno**
- Repro: MCP 服务器 → add stdio server with a nonexistent command → 工具.
- `GET /v1/mcp/{name}/tools` → `{ok:false, "error":"[Errno 2] No such file or directory"}` —
  shown raw in the tools area. Doesn't say *which* command failed or that the binary is
  missing (compare: agent-probe 400 "agent command not found on PATH: agent" is much better).
- Files: `coworker/server/app.py:689-691` → `manager.mcp_tools`;
  `useMcpServers.ts:183-197` (renders `result.error` raw).

**8. [low · (c)] Routing binding save error is English-raw**
- Repro: 消息路由 → 收件箱路由 → name `x`, 平台 `slack`, target `T000/C000` → 添加 (Slack not
  connected) → alert **"Slack is not connected."** Clear but unlocalized; consider a hint
  linking to the Slack connector. Files: `useRouting.ts` `run()`; backend
  `/v1/inbox/routing/binding`.

### #/settings

**9. [high · (e)+(c)] 模型列表 add is a silent no-op — any string accepted, model never appears**
- Repro: 设置 → 模型 → 模型列表 → type `openai:audit-model` → 添加. Input clears, no error, and
  the model never shows up (row absent; composer model menu still has 1 entry).
- Verified at the API: `POST /v1/settings/models/add` → `{ok:true, models:["gpt-5.6-sol"]…}`.
  The model **is persisted** to `prefs.json` (verified: even the garbage string
  `AUDIT BAD MODEL` — with spaces — was stored), but `get_settings()` filters the served list
  to models whose provider is configured (`coworker/server/manager.py:3981` `add_model` +
  `_selectable` in `get_settings`), so nothing unconfigured ever appears.
- Two defects stacked: (i) backend accepts any junk string as a model id with no validation
  and reports success; (ii) the served list silently hides what was just added — from the
  user's seat the button simply does nothing. Frontend `validateModelDraft`
  (`settingsLogic.ts:165`) only checks empty/duplicate.
- Suggested: backend rejects unknown ids (or returns `ok:false` "provider 未配置"), or the UI
  warns "已添加，但配置该提供商前不会显示".

**10. [medium · (c)+(e)] 会话文件夹 accepts relative paths — created under the sidecar's CWD**
- Repro: 设置 → 高级 → 文件 → 会话文件夹 → enter `relative/path` → 保存 → "已保存".
- `POST /v1/settings/scratch-base` `{path:"relative/path"}` → `{ok:true}` and the backend
  **created the directory relative to the server process CWD**
  (`coworker/server/manager.py:4271` — `Path(path).expanduser().mkdir(...)`). During this
  audit it created `<repo>/relative/path` (removed afterwards). New sessions would then get
  scratch dirs in an effectively random location.
- Frontend `validateScratchBase` (`settingsLogic.ts:283`) only checks non-empty. Both ends
  should require an absolute path.

**11. [medium · (e)+(c)] Persona install failure leaks raw subprocess text + internal paths**
- Repro: 设置 → Personas → Git URL `https://example.com/audit-nope.git` → 安装.
- `POST /v1/personas/install` → `{ok:false, "error":"Command '['git', 'clone', '--depth', '1',
  'https://example.com/audit-nope.git', '/tmp/qh-audit-state/persona-cache/audit-nope-80d7cebb']'
  returned non-zero exit status 128."}` — shown raw under the form.
- `CalledProcessError.__str__` verbatim (`coworker/personas/loading.py:39-45`): leaks the
  machine's state-dir path and says nothing actionable. Should be "无法克隆该仓库，请检查 URL
  是否正确/可访问" (+ optional stderr tail).

**12. [trivial · (a)] Memory section renders a permanent empty `role="alert"` span**
- `MemorySection.tsx:99-102`: `<span role="alert">{formError}</span>` is always in the DOM,
  empty when there's no error. Empty live-region in the a11y tree; render it only when set.

### #/assistant

**13. [medium · (c)] Model-key error points to a UI that doesn't exist ("Manage → Settings")**
- Repro: new session → send any message (no provider key).
- Timeline error card: `错误：No model API key configured. Set OPENAI_API_KEY in the
  environment, or add your key in Manage → Settings.` with working 前往设置 / 重试 buttons.
- The card itself is good (inline, actionable, verified that 前往设置 navigates to
  `#/settings` and 重试 re-runs the turn), but the backend's message text
  (`coworker/providers/openai_provider.py:152`) references "Manage → Settings" from the old
  product — there is no "Manage" in this UI (it's 设置 in the sidebar). Also fully English in
  a Chinese UI. Same text appears for automation manual runs.

**14. [medium · (d)] No way to delete or rename a session**
- `renameSession` / `deleteSession` exist in `lib/api/sessions.ts:68,80` but no component
  calls them (verified by grep). `SessionListPanel` rows offer only 置顶/归档; the chat header
  has no menu. Sessions (including failed/empty ones) accumulate forever — archive is the only
  way out. Either wire the existing API functions into a row hover-menu or drop them.

### #/agents

**15. [low · (c)] Probe failure message is English-raw (but structurally well presented)**
- Repro: add profile with command `agent` (nonexistent) → 保存 → 探测.
- `POST /v1/agent-profiles/{id}/probe` → **400** `{"detail":"agent command not found on PATH:
  agent"}` — shown inline in the editor's error `<pre>` and on the row with 探测失败. The
  presentation is right (inline, contextual, enable switch stays correctly gated); only the
  English text is off-brand for the Chinese UI. Backend: `coworker/server/app.py` probe route.

---

## Works fine (verified clean)

- **Assistant**: new session via both buttons; error-card 重试 + 前往设置; mode menu
  (计划/确认/自动, `set_mode` over WS); unattended toggle (`POST …/unattended` 200, badge
  appears); model menu (shows exactly the configured providers' models — 1 entry here);
  attach menu → text file → chip → send; ACP runtime toggle (WS reconnects with
  `runtime=acp`); rail tabs 产物/目录/用量; rail hide/show; session search filter;
  pin/archive/unarchive + 显示已归档 toggle; hidden `__run__` sessions stay out of the list.
- **Agents**: preset → editor flow; empty-command and bad-args-JSON inline validation (save
  disabled); enable switch hard-gated until a successful probe (`disabled=true` after failed
  probe); delete with inline confirm.
- **Missions**: status filter chips (全部/进行中/需关注/已完成/已取消); empty-goal submit
  disabled; 调整团队 edit mode (seats show 未启用 tags) + 放弃修改; cancel with inline confirm;
  live timeline over `/v1/missions/{id}/events` WS (实时 · N 条事件).
- **Inbox**: pending/resolved tabs, manual refresh, empty states. (Resolve flows untestable
  here — pending items need a working model to generate approvals/questions.)
- **Automations**: form validation (请填写名称; cron "需要 5 段（分 时 日 月 周）…" with save
  disabled); create; enable toggle; 运行记录 expand; 立即运行 navigates to the live run
  session; delete via editor.
- **Integrations**: connector search; connect sheet opens/closes (Esc); MCP add (stdio+HTTP)
  /edit/delete with confirm; MCP enable toggle + 立即重载; DM route set + clear; audit tab
  filters (0 rows is correct — the copied state has no audit events); browser connector
  detail + tools disclosure toggle.
- **Settings**: theme segmented (3 options, instant); default-model select; provider drawer
  with bogus key → clean inline **"Invalid API key."** via `/v1/providers/verify` (nothing
  saved); voice section's browser degradation card (proper "仅在桌面应用中可用" state);
  memory add; persona enable/disable toggle + detail drawer; advanced PDF/compaction/websearch
  saves; experimental-connectors toggle.

## Environment notes for the next agent

- The audit ran against a **copy** of state at `/tmp/qh-audit-state` (deleted after the run);
  the user's real `~/.config/qh-openworker` and running Tauri instance were untouched.
- The `relative/path` directory accidentally created in the repo root by issue #10's probe
  was removed.
- `surfaces/gui/e2e/live-audit-findings*.json` (per-run raw captures) were folded into this
  report; the harness is kept for re-runs.
