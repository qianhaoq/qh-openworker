# ACP-first personal multi-Agent coding assistant

QH OpenWorker is the host and durable control plane. It does not hard-code one coding
Agent implementation:

- ACP owns one local Agent session: initialize, streaming updates, permission requests,
  prompt turns, cancellation, and recovery.
- MCP exposes the small host-controlled team tool surface to the main Agent.
- The QH orchestrator owns routing, task state, SQLite persistence, worktree isolation,
  verification, review, and rework.

Agents do not exchange messages directly. Every delegation, follow-up, artifact, review,
and delivery passes through the orchestrator and the append-only ledger.

## Default profiles

The first launch seeds four editable profiles in `qh_orchestrator.db`:

| Profile | Role | Transport | Default |
| --- | --- | --- | --- |
| `opencode-main` | main | `opencode acp` | enabled |
| `opencode-executor` | executor | `opencode acp` | enabled |
| `opencode-reviewer` | reviewer | `opencode acp` | enabled, host-enforced read-only policy |
| `pi-experimental` | executor | `pi --mode rpc` | disabled experiment |

Profiles and per-workspace main-Agent selection are available in Settings and through
the `/v1/agent-profiles` API. Capability probing runs the configured binary and persists
the negotiated capabilities; callers must not assume resume/load support before probing.

## Main session behavior

The Code persona uses `runtime=acp`. A conversation remains bound to the same Agent
session across prompt turns. After a host restart the adapter tries ACP resume, then ACP
load, and finally creates a new session with a compact checkpoint when neither capability
is available. Only one prompt may be active in a session; asynchronous worker results wait
in a durable FIFO and are delivered after the current turn.

ACP main sessions receive the `qh-team` MCP stdio server with these tools:

```text
team.delegate
team.status
team.result
team.message
team.cancel
review.request
```

`team.delegate` is asynchronous: it creates a durable task and returns immediately. The
desktop team worker executes it in the background and wakes the original main session with
the result. Every `team.message` call requires a caller-generated idempotency key; retries
must reuse that key, while distinct user intents use distinct keys.

## Coding task state machine

```text
QUEUED -> IMPLEMENTING -> VERIFYING -> REVIEWING -> APPROVED -> DONE
                                      -> CHANGES_REQUESTED -> REWORK -> VERIFYING
```

A failed verification or blocking review moves the task to `BLOCKED`. A user follow-up to
a `DONE` or `BLOCKED` executor task reopens it explicitly, creates a new attempt, reuses the
original Agent session and retained worktree, then runs verification and review again.
`CANCELLED` is intentionally not resumable.

Each executor receives an independent git worktree. Reviewers receive the same fixed
worktree and artifact references but their ACP permission policy rejects every mutation.
Automatic review rework is limited to two rounds by default and is configurable from zero
to five. Test failure is a hard gate; a reviewer pass cannot override it.

## Knowledge and audio transcripts

The `/v1/memory/audio-transcripts` endpoint accepts transcript text only and rejects raw
audio/blob/base64 fields. Main and child Agents receive a bounded package containing only
global, current-workspace, and current-conversation text memories. Raw audio is never
placed in an Agent context.

## Security boundaries

ACP read-only is a policy enforced by the OpenWorker host at protocol and orchestration
boundaries. The configured Agent binary is trusted local code; this policy is not an OS,
container, or VM sandbox and must not be described as one.

- Agent subprocesses receive a minimal environment. Ambient credentials are excluded;
  only a profile's explicit `secret_refs` may be injected.
- Reviewer and explorer profiles never receive secret references.
- ACP permission requests are surfaced in the GUI; reviewer mutations are denied even if
  a custom resolver tries to allow them.
- Team messages are append-only and marked delivered only after a successful prompt. A
  crash after prompting but before acknowledgement is retained as `unknown`: the upstream
  queue stays pending and the prompt is not automatically replayed.
- Verification commands are restricted to known test runners and run with a minimal,
  credential-free environment.
- At most three non-main attempts may be active per task. The capacity check and insertion
  are one SQLite `BEGIN IMMEDIATE` transaction across desktop and MCP processes.

## Development verification

```shell
.venv/bin/python -m pytest -q \
  tests/test_acp_adapter.py \
  tests/test_pi_rpc_adapter.py \
  tests/test_main_acp.py \
  tests/test_main_acp_integration.py \
  tests/test_orchestration_store.py \
  tests/test_team_mcp.py \
  tests/test_team_worker.py

cd surfaces/gui
npm run test -- src/api.auth.test.ts src/components/AgentControlPanel.test.tsx
npm run build
```

Pi remains an experimental JSONL adapter. GUI Agents, A2A, cross-host execution, and a
general dynamic DAG are intentionally outside this MVP; their future adapters must reuse
the same profile, task, artifact, permission, and ledger contracts.
