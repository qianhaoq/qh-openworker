// Owns one open conversation: history hydration (module-level cache so switching sessions
// doesn't refetch), the SessionSocket lifecycle, and every outbound action. All incoming
// events funnel through the pure reducer in timeline.ts — this hook is the only
// side-effecting layer. The server stays the source of truth: history is re-read on
// entry (cache is just the instant first paint).

import { useCallback, useEffect, useRef, useState } from "react";
import { getSessionMessages } from "../../lib/api/sessions";
import type { ApprovalDecision, Attachment, PermissionMode, SessionUsage, WsEvent } from "../../lib/api/types";
import { SessionSocket } from "../../lib/ws";
import { resolveAgentChoice, type AgentChoice } from "./agentChoice";
import {
  appendUserMessage,
  applyWsEvent,
  emptyUsage,
  hydrateChat,
  initialChatState,
  itemsFromMessages,
  markConnected,
  markHistoryStale,
  markUnattended,
  resolveLastApproval,
  resolveLastDirReq,
  resolveLastPlan,
  resolveLastQuestion,
  usageFromMessages,
  type ChatState,
  type TimelineItem,
} from "./timeline";

const requestFrame = (cb: () => void): number =>
  typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame(cb)
    : window.setTimeout(cb, 16);

const cancelFrame = (id: number): void => {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(id);
  } else {
    window.clearTimeout(id);
  }
};

export function reduceWsEventsInOrder(
  state: ChatState,
  events: WsEvent[],
  now: number = Date.now(),
): ChatState {
  return events.reduce((next, event) => applyWsEvent(next, event, now), state);
}

// -- module-level history cache (instant paint when switching back to a session) --------

interface HistorySnapshot {
  items: TimelineItem[];
  usage: SessionUsage;
}

const historyCache = new Map<string, HistorySnapshot>();
const CACHE_CAP = 20;

function cacheRead(sessionId: string): HistorySnapshot | null {
  const hit = historyCache.get(sessionId);
  if (!hit) return null;
  // Refresh recency (Map preserves insertion order → LRU-ish eviction below).
  historyCache.delete(sessionId);
  historyCache.set(sessionId, hit);
  return hit;
}

function cacheWrite(sessionId: string, snapshot: HistorySnapshot): void {
  historyCache.delete(sessionId);
  historyCache.set(sessionId, snapshot);
  while (historyCache.size > CACHE_CAP) {
    const oldest = historyCache.keys().next().value;
    if (oldest === undefined) break;
    historyCache.delete(oldest);
  }
}

// -- the hook ----------------------------------------------------------------------------

export interface UseSessionChatOptions {
  sessionId: string;
  /** From the session record; "" for a brand-new session (the server provisions scratch). */
  workspace: string;
  agent: string;
  /** Header picker selection: "embedded" | "acp" (workspace main) | an agent profile id.
   * Changing it reconnects the socket with the new runtime/profile binding. */
  agentChoice: AgentChoice;
  connect?: boolean;
  /** turn_done settled — the session list / artifacts are now stale. */
  onTurnSettled?: () => void;
}

export interface SessionChat {
  state: ChatState;
  setUnattended: (on: boolean) => void;
  send: (text: string, attachments: Attachment[] | undefined, model?: string) => void;
  approve: (decision: ApprovalDecision) => void;
  respondPlan: (approved: boolean, mode?: string, feedback?: string) => void;
  respondDirectory: (granted: boolean, path?: string, writable?: boolean) => void;
  answerQuestion: (answer: string) => void;
  interrupt: () => void;
  retry: () => void;
  setMode: (mode: PermissionMode) => void;
  setModel: (model: string) => void;
}

export function useSessionChat({
  sessionId,
  workspace,
  agent,
  agentChoice,
  connect = true,
  onTurnSettled,
}: UseSessionChatOptions): SessionChat {
  const [state, setState] = useState<ChatState>(initialChatState);
  const socketRef = useRef<SessionSocket | null>(null);
  const eventQueueRef = useRef<WsEvent[]>([]);
  const frameRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const onTurnSettledRef = useRef(onTurnSettled);
  onTurnSettledRef.current = onTurnSettled;
  runningRef.current = state.running;

  const flushQueuedEvents = useCallback(() => {
    frameRef.current = null;
    const queued = eventQueueRef.current;
    if (!queued.length) return;
    eventQueueRef.current = [];
    setState((s) => reduceWsEventsInOrder(s, queued));
  }, []);

  const enqueueEvent = useCallback(
    (event: WsEvent) => {
      eventQueueRef.current.push(event);
      if (event.type === "turn_start") runningRef.current = true;
      else if (event.type === "turn_done") runningRef.current = false;
      if (frameRef.current === null) frameRef.current = requestFrame(flushQueuedEvents);
    },
    [flushQueuedEvents],
  );

  // -- history: instant paint from cache, then the authoritative re-read ----------------
  useEffect(() => {
    const cached = cacheRead(sessionId);
    setState((s) => ({
      ...initialChatState(),
      connected: s.connected && socketRef.current !== null,
      items: cached?.items ?? [],
      usage: cached?.usage ?? emptyUsage(),
      historyStale: !!cached,
    }));
    let stale = false;
    getSessionMessages(sessionId)
      .then((messages) => {
        if (stale) return;
        const items = itemsFromMessages(messages);
        const usage = usageFromMessages(messages);
        cacheWrite(sessionId, { items, usage });
        // A live turn is ahead of the server's persisted history — keep it.
        if (runningRef.current) return;
        setState((s) => hydrateChat(s, items, usage));
      })
      .catch(() => {
        setState((s) => markHistoryStale(s, !!cached));
      });
    return () => {
      stale = true;
    };
  }, [sessionId]);

  // Keep the cache warm as the live timeline grows (cheap Map.set on each change).
  useEffect(() => {
    if (state.items.length) cacheWrite(sessionId, { items: state.items, usage: state.usage });
  }, [sessionId, state.items, state.usage]);

  // -- socket -----------------------------------------------------------------------------
  // NOTE: `workspace` is intentionally NOT a dependency. Every real workspace change is
  // paired with a sessionId change, so the socket still reconnects when it should; the one
  // workspace-only change is the server adopting a provisioned scratch dir on `ready`,
  // and reconnecting for THAT dropped the first message (the old app's "send twice" bug).
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  useEffect(() => {
    if (!connect) {
      socketRef.current?.close();
      socketRef.current = null;
      eventQueueRef.current = [];
      if (frameRef.current !== null) {
        cancelFrame(frameRef.current);
        frameRef.current = null;
      }
      setState((s) => markConnected(s, false));
      return;
    }
    const { runtime, profileId } = resolveAgentChoice(agentChoice);
    const socket = new SessionSocket(sessionId, workspaceRef.current, agent, {
      onEvent: (event) => {
        enqueueEvent(event);
        if (event.type === "turn_done") onTurnSettledRef.current?.();
      },
      onOpen: () => setState((s) => markConnected(s, true)),
      onClose: () => setState((s) => markConnected(s, false)),
    }, { runtime, ...(profileId ? { profileId } : {}) });
    socketRef.current = socket;
    return () => {
      socketRef.current = null;
      socket.close();
      eventQueueRef.current = [];
      if (frameRef.current !== null) {
        cancelFrame(frameRef.current);
        frameRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agent, agentChoice, connect, enqueueEvent]);

  const setUnattended = useCallback(
    (on: boolean) => setState((s) => markUnattended(s, on)),
    [],
  );

  // -- actions (optimistic local resolve + the matching WS command) ----------------------
  const send = useCallback(
    (text: string, attachments: Attachment[] | undefined, model?: string) => {
      setState((s) => appendUserMessage(s, text, attachments, Date.now()));
      // The visible model rides along with the message (single source of truth per turn).
      socketRef.current?.userMessage(text, attachments, model);
    },
    [],
  );

  const approve = useCallback((decision: ApprovalDecision) => {
    setState((s) => ({ ...s, items: resolveLastApproval(s.items, decision) }));
    socketRef.current?.approve(decision);
  }, []);

  const respondPlan = useCallback((approved: boolean, mode?: string, feedback?: string) => {
    setState((s) => ({
      ...s,
      items: resolveLastPlan(s.items, approved ? "approved" : "rejected"),
      // The server flips the live engine to the approved mode.
      ...(approved && mode ? { mode } : {}),
    }));
    socketRef.current?.respondPlan(approved, mode, feedback);
  }, []);

  const respondDirectory = useCallback((granted: boolean, path?: string, writable?: boolean) => {
    setState((s) => ({ ...s, items: resolveLastDirReq(s.items, granted ? "granted" : "denied") }));
    socketRef.current?.respondDirectory(granted, path, writable);
  }, []);

  const answerQuestion = useCallback((answer: string) => {
    setState((s) => ({ ...s, items: resolveLastQuestion(s.items, answer) }));
    socketRef.current?.respondQuestion(answer);
  }, []);

  const interrupt = useCallback(() => socketRef.current?.interrupt(), []);

  const retry = useCallback(() => {
    // Optimistic running: turn_start confirms; a rejected retry still ends in turn_done.
    setState((s) => ({ ...s, running: true }));
    socketRef.current?.retry();
  }, []);

  const setMode = useCallback((mode: PermissionMode) => {
    setState((s) => ({ ...s, mode }));
    socketRef.current?.setMode(mode);
  }, []);

  const setModel = useCallback((model: string) => {
    setState((s) => ({ ...s, model }));
    socketRef.current?.setModel(model);
  }, []);

  return {
    state,
    setUnattended,
    send,
    approve,
    respondPlan,
    respondDirectory,
    answerQuestion,
    interrupt,
    retry,
    setMode,
    setModel,
  };
}
