# E2E tests (Playwright)

End-to-end regression tests for the GUI. They drive the real app in Chromium but are **hermetic**:
every `/v1` request and the event WebSocket are mocked at the network layer, so tests need **no
Python backend**, run deterministically, and never mutate real state.

## Run

```bash
npm run e2e          # headless
npm run e2e:ui       # Playwright UI mode (watch/inspect)
npx playwright test e2e/settings.spec.ts   # a single spec
```

## Live smoke (not CI)

`npm run e2e:live` runs `e2e-live/` (separate `playwright.live.config.ts`) against the **real**
backend on :8765. Two flavors, both skip cleanly when the backend is down:

- **API-shape smoke** (`api-smoke.spec.ts`) — no model tokens, no creds. Asserts `/v1/health` and
  `/v1/providers` return the shapes the GUI reads, catching drift between the mocks and the real
  backend. Cheap enough to run anytime the sidecar is up.
- **Full vertical** (`fib.spec.ts`, …) — asks a fresh Cowork session to produce `fib.md` and
  verifies the file lands on disk. Needs a model configured, is nondeterministic, and costs a few
  tokens per run. Exercises the vertical the hermetic specs mock: model wiring, the tool/approval
  loop, file I/O, and WebSocket streaming.

The config (`playwright.config.ts`) starts the Vite dev server on port **5199** (dedicated, so it
won't clash with a running `npm run dev` on 5173) and reuses it if already up.

## How the mock works

`e2e/fixtures.ts` exports a `test` whose `page` has `mockApi()` installed before navigation:

- `page.route("**/v1/**", …)` dispatches by pathname + method to fixtures whose shapes mirror the
  real backend (captured from a live server). Unknown endpoints return an empty-but-valid body.
- Mutations are held in per-test in-memory state so they reflect through the real UI on re-fetch:
  sessions (archive/rename/delete), personas (enable/surface/delete — enable implies surface,
  matching the backend), inbox items + the routing binding, roots, channel subscriptions.
- The session WebSocket (`routeWebSocket`) is a **scripted fake agent** speaking the real
  `{type, data}` event protocol: `ready` on connect; `user_message` → `turn_start` → deltas →
  `assistant_message "Echo: <text>"` → `turn_done`; a message containing **"run a tool"** emits
  `tool_proposed` + `permission_required` and suspends until the client's `approval` decision
  arrives. The mission ledger socket (`/v1/missions/{id}/events`) is a quiet fake (pongs only).
  This runs the production send/stream/approve code paths with zero model cost.
- Seed data worth knowing: the pinned session "Draft the launch note" sorts first in the
  assistant's session list; two pending Inbox items (an approval and a question) drive the
  Inbox resolve flows and the sidebar badge. Three ACP agent profiles (kimi-main is the
  workspace main; all pre-probed + enabled) drive the Agents page and the seeded missions'
  team seats — `POST /v1/agent-profiles/{id}/probe` instantly records capabilities. Two
  missions: m-1 AWAITING_CONFIRMATION (plan/confirm flows) and m-2 DONE (list filters);
  `POST /v1/missions` creates m-N awaiting confirmation. Providers are seeded in three states
  (OpenAI configured+used, Anthropic configured-unused, Z AI unconfigured). Browser/Slack/GitHub
  are connected; `POST /v1/connectors/{name}/connect` flips token-paste connectors (Telegram).
  One memory item; `POST /v1/memory` prepends. One automation ("Daily AI News") with a running
  run + unseen badges, one quiet — `POST .../run` appends a run, `PATCH`/`DELETE` toggle/remove.

## Adding a spec

```ts
import { test, expect } from "./fixtures";

test("…", async ({ page }) => {
  await page.goto("/");
  // interact + assert
});
```

If a flow reads a new endpoint, add its fixture + a route branch in `fixtures.ts` — the catch-all
returns `{}`, which will crash components that expect arrays (e.g. persona `recommends`). Prefer
`getByRole`, but watch two new-UI traps: collapsible turn groups hide approval chips until
expanded (`turn-group-head`), and controlled switches flip only after the mutation + refetch
round-trip (`click()` then assert, never `check()`/`uncheck()`).
```
