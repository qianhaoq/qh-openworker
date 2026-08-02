// WebSocket clients for the three sidecar sockets: the per-session engine stream
// (/ws/session/{id}), the app-wide event stream (/ws/events), and the cursor-resumable
// mission ledger stream (/v1/missions/{id}/events). Auth rides the subprotocol via
// openWebSocket (see client.ts).

import { openWebSocket, wsUrl } from "./api/client";
import type {
  AppEvent,
  ApprovalDecision,
  Attachment,
  MissionEvent,
  PermissionMode,
  WsCommand,
  WsEvent,
} from "./api/types";

// Reconnect cadence: the old GUI reconnected its mission/session sockets ~1.2s after a
// drop; we keep that as the base delay and back off gently on repeated failures.
const RECONNECT_BASE_MS = 1200;
const RECONNECT_MAX_MS = 15_000;

const backoff = (attempt: number): number =>
  Math.min(RECONNECT_BASE_MS * Math.pow(1.5, attempt), RECONNECT_MAX_MS);

export interface SessionSocketHandlers {
  onEvent: (event: WsEvent) => void;
  onOpen?: () => void;
  // Fired on every underlying close. `willReconnect` is true when the socket is being
  // re-established automatically — the session is NOT lost (server-side state survives
  // a dropped socket; events broadcast while away are re-read on reconnect).
  onClose?: (willReconnect: boolean) => void;
}

export class SessionSocket {
  private ws: WebSocket | null = null;
  // Payloads sent before the socket finished opening (or between reconnects), replayed
  // on `onopen` — belt-and-suspenders against the first message being dropped.
  private outbox: WsCommand[] = [];
  private closed = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly url: string;

  constructor(
    sessionId: string,
    workspace: string,
    agent: string,
    private readonly handlers: SessionSocketHandlers,
    options?: { runtime?: "embedded" | "acp"; profileId?: string },
  ) {
    const q = new URLSearchParams({ workspace, agent });
    // app.py routes on `runtime=acp`: explicit option wins; the "code" agent defaults to it.
    const runtime = options?.runtime ?? (agent === "code" ? "acp" : "embedded");
    if (runtime === "acp") q.set("runtime", "acp");
    // Multi-agent control plane: bind the session to a specific ACP agent profile
    // (absent = the workspace main). Only meaningful on the acp runtime — an invalid
    // id makes the server answer an `error` event and close.
    if (runtime === "acp" && options?.profileId) q.set("profile_id", options.profileId);
    this.url = wsUrl(`/ws/session/${encodeURIComponent(sessionId)}?${q.toString()}`);
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = openWebSocket(this.url);
    this.ws = ws;
    ws.onmessage = (e) => {
      try {
        this.handlers.onEvent(JSON.parse(e.data) as WsEvent);
      } catch {
        /* malformed frame — ignore */
      }
    };
    ws.onopen = () => {
      this.attempts = 0;
      this.flush();
      this.handlers.onOpen?.();
    };
    ws.onclose = () => {
      if (this.closed) {
        this.handlers.onClose?.(false);
        return;
      }
      const delay = backoff(this.attempts);
      this.attempts += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.handlers.onClose?.(true);
    };
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const pending = this.outbox;
    this.outbox = [];
    for (const command of pending) this.ws.send(JSON.stringify(command));
  }

  /** Send a protocol command. Queues while the socket is down and flushes on (re)open. */
  send(command: WsCommand): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
    } else {
      this.outbox.push(command);
    }
  }

  /** `model` = the composer's CURRENT selection, carried on every message so the turn
   * uses exactly what the user sees — immune to set_model races across reconnects. */
  userMessage(text: string, attachments?: Attachment[], model?: string): void {
    this.send({
      type: "user_message",
      text,
      ...(model ? { model } : {}),
      ...(attachments?.length ? { attachments } : {}),
    });
  }

  approve(decision: ApprovalDecision | string): void {
    this.send({ type: "approval", decision });
  }

  // Reply to a `request_directory` prompt: grant a folder (with access level) or decline.
  respondDirectory(granted: boolean, path?: string, writable?: boolean): void {
    this.send({
      type: "directory_response",
      granted,
      ...(path ? { path } : {}),
      writable: !!writable,
    });
  }

  // Reply to a `propose_plan` prompt: approve (choosing the execution mode) or reject
  // with feedback.
  respondPlan(approved: boolean, mode?: string, feedback?: string): void {
    this.send({
      type: "plan_response",
      approved,
      ...(mode ? { mode } : {}),
      ...(feedback ? { feedback } : {}),
    });
  }

  // Answer a live `ask_user` prompt (attended sessions; unattended ones answer via Inbox).
  respondQuestion(answer: string): void {
    this.send({ type: "question_response", answer });
  }

  interrupt(): void {
    this.send({ type: "interrupt" });
  }

  // Re-run a turn that ended in a provider error — the server guards on the history tail,
  // so a stray frame is a no-op.
  retry(): void {
    this.send({ type: "retry" });
  }

  setMode(mode: PermissionMode): void {
    this.send({ type: "set_mode", mode });
  }

  setModel(model: string): void {
    this.send({ type: "set_model", model });
  }

  /** Stop reconnecting and tear the socket down. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // Detach before closing: this socket's async `close` event may land AFTER a
      // successor's `open`, and a torn-down socket must not clobber the new one's state.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.close();
    }
  }
}

// -- /ws/events: app-wide, session-independent pushes (automation_run_started, …) ------

/** Keep one open for the app's lifetime. Quietly reconnects (5s, the old cadence) while
 * open; the returned cleanup stops it for good. */
export function connectEvents(onEvent: (event: AppEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const open = () => {
    if (closed) return;
    ws = openWebSocket(wsUrl("/ws/events"));
    ws.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data) as AppEvent);
      } catch {
        /* malformed frame — ignore */
      }
    };
    ws.onclose = () => {
      if (!closed) timer = setTimeout(open, 5000);
    };
  };
  open();
  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    ws?.close();
  };
}

// -- /v1/missions/{id}/events: cursor-resumable ledger stream -------------------------

export interface MissionEventHandlers {
  onEvent: (event: MissionEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
}

export interface MissionEventsHandle {
  /** Ask the server for its current cursor (the answer arrives as a "pong" frame). */
  ping(): void;
  /** Stop reconnecting and tear the socket down. */
  close(): void;
}

/** Stream mission ledger events, resuming from `after` on first connect and from the
 * last-seen cursor after every reconnect (~1.2s, the old controller's cadence). */
export function connectMissionEvents(
  missionId: string,
  after: string | null | undefined,
  handlers: MissionEventHandlers,
): MissionEventsHandle {
  let cursor = after ?? null;
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    const q = cursor ? `?after=${encodeURIComponent(cursor)}` : "";
    const socket = openWebSocket(
      wsUrl(`/v1/missions/${encodeURIComponent(missionId)}/events${q}`),
    );
    ws = socket;
    socket.onmessage = (message) => {
      let parsed: any;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return; // malformed frame — ignore
      }
      // Frames are either {type, event, cursor} wrappers around a ledger row, the
      // initial mission.snapshot, or a pong — all may advance the resume cursor.
      const body = parsed?.event ?? parsed;
      const nextCursor = parsed?.cursor ?? body?.cursor ?? body?.event_id ?? null;
      if (nextCursor) cursor = String(nextCursor);
      if (parsed?.type === "pong") return; // keepalive answer, not a domain event
      handlers.onEvent({
        ...body,
        event_type: body?.event_type ?? body?.type ?? parsed?.type,
        cursor: nextCursor,
      } as MissionEvent);
    };
    socket.onopen = () => handlers.onOpen?.();
    socket.onclose = () => {
      handlers.onClose?.();
      if (!closed) timer = setTimeout(open, RECONNECT_BASE_MS);
    };
    socket.onerror = () => handlers.onError?.();
  };

  open();
  return {
    ping() {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      const socket = ws;
      ws = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.close();
      }
    },
  };
}
