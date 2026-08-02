// The assistant timeline: the item model, the history mapper (REST messages → items) and
// the live-event reducer (WS events → items/streams/flags). Pure and side-effect free so
// every transition is unit-testable; ChatView/useSessionChat only wire it to the socket.
//
// Behavior is a faithful port of the old app's wiring (src/itemsFromMessages.ts,
// src/usage.ts, src/streamGate.ts and LegacyWorkspace's handleEvent), with Chinese copy.

import type {
  ApprovalDecision,
  Attachment,
  Message,
  MessageSource,
  SessionUsage,
  UsageInfo,
  WsEvent,
} from "../../lib/api/types";
import { humanizeErrorText } from "../../lib/errorText";

// ---------------------------------------------------------------------------
// Item model
// ---------------------------------------------------------------------------

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "done";
}

// `ts` = unix seconds (the server's canonical-message stamp; live items stamp locally).
export type TimelineItem =
  | { kind: "user"; text: string; attachments?: Attachment[]; ts?: number }
  // A connector-delivered inbound message (Slack/…), rendered as a structured card.
  | { kind: "connector"; source: MessageSource }
  | { kind: "assistant"; text: string; ts?: number; reasoning?: string }
  // `hidden` = results privacy filters removed before the agent saw them; `standingRule`
  // = the task-scoped rule that auto-allowed this call. `durationMs` fills on finish.
  | {
      kind: "tool";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: string;
      preview?: string;
      hidden?: number;
      standingRule?: string;
      startedAt?: number;
      durationMs?: number;
    }
  | {
      kind: "approval";
      name: string;
      args: Record<string, unknown>;
      reason: string;
      category?: string;
      standingTarget?: string;
      resolved?: ApprovalDecision;
    }
  | {
      kind: "dirreq";
      reason: string;
      path?: string;
      writable?: boolean;
      resolved?: "granted" | "denied";
    }
  | { kind: "planreq"; plan: string; resolved?: "approved" | "rejected" }
  | {
      kind: "question";
      question: string;
      options?: string[];
      allow_text?: boolean;
      multi?: boolean;
      resolved?: string;
    }
  | { kind: "notice"; tone: "info" | "warn" | "error"; text: string; retriable?: boolean };

export type ToolItem = Extract<TimelineItem, { kind: "tool" }>;
export type ApprovalItem = Extract<TimelineItem, { kind: "approval" }>;
export type AssistantItem = Extract<TimelineItem, { kind: "assistant" }>;
export type QuestionItem = Extract<TimelineItem, { kind: "question" }>;
export type DirReqItem = Extract<TimelineItem, { kind: "dirreq" }>;
export type PlanReqItem = Extract<TimelineItem, { kind: "planreq" }>;

let nextLocalId = 1;
const localId = () => `local-${nextLocalId++}`;

// ---------------------------------------------------------------------------
// History: GET /v1/sessions/{id}/messages → items
// ---------------------------------------------------------------------------

export function userItemFromContent(content: unknown): Extract<TimelineItem, { kind: "user" }> {
  if (typeof content === "string") return { kind: "user", text: content };
  if (!Array.isArray(content)) return { kind: "user", text: "" };

  const text: string[] = [];
  const attachments: Attachment[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && p.text) {
      text.push(String(p.text));
    } else if (p.type === "image_url") {
      const url = (p.image_url as Record<string, unknown> | undefined)?.url;
      if (typeof url === "string" && url.startsWith("data:image/")) {
        attachments.push({ kind: "image", name: "image", data_url: url });
      }
    }
  }
  return { kind: "user", text: text.join("\n\n"), attachments };
}

export function itemsFromMessages(messages: Message[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  // Index tool results by tool_call_id so replayed tool rows can show their output
  // (the live view gets this from `tool_finished`; on replay it's the role:"tool" msgs).
  const results: Record<string, string> = {};
  // `_display` sidecar = user-facing metadata the agent never saw (privacy-filter hits).
  const hiddenCounts: Record<string, number> = {};
  for (const m of messages || []) {
    if (m.role === "tool" && m.tool_call_id) {
      results[m.tool_call_id] =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const hidden = Number((m._display as Record<string, unknown> | undefined)?.hidden_by_filters || 0);
      if (hidden > 0) hiddenCounts[m.tool_call_id] = hidden;
    }
  }
  for (const m of messages || []) {
    if (m.role === "user") {
      if (m.source?.connector) {
        items.push({ kind: "connector", source: m.source });
        continue;
      }
      const user = userItemFromContent(m.content);
      if (typeof m.ts === "number") user.ts = m.ts;
      if (user.text || user.attachments?.length) items.push(user);
    } else if (m.role === "assistant") {
      const reasoning = typeof m.reasoning === "string" ? m.reasoning : undefined;
      const content = typeof m.content === "string" ? m.content : "";
      if (content || reasoning) {
        items.push({
          kind: "assistant",
          text: content,
          ...(typeof m.ts === "number" ? { ts: m.ts } : {}),
          ...(reasoning ? { reasoning } : {}),
        });
      }
      for (const raw of (m.tool_calls as Record<string, unknown>[]) || []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse((raw.function as Record<string, unknown> | undefined)?.arguments as string || "{}");
        } catch {
          args = {};
        }
        const id = String(raw.id ?? localId());
        const preview = results[id];
        const hidden = hiddenCounts[id];
        items.push({
          kind: "tool",
          id,
          name: String((raw.function as Record<string, unknown> | undefined)?.name ?? ""),
          args,
          status: "ok",
          preview,
          ...(hidden ? { hidden } : {}),
        });
      }
    } else if (m.role === "notice") {
      // Persisted markers survive reload exactly like the live view rendered them. An error
      // notice is retriable — the timeline only offers the button at the transcript tail.
      items.push(
        m.kind === "interrupted"
          ? { kind: "notice", tone: "warn", text: "已中断。" }
          : m.kind === "model_switch"
            ? { kind: "notice", tone: "info", text: (m.text as string) || "已切换模型" }
            : m.kind === "compacted"
              ? { kind: "notice", tone: "info", text: (m.text as string) || "上下文已压缩" }
              : {
                  kind: "notice",
                  tone: "error",
                  text: "错误：" + humanizeErrorText((m.text as string) || "未知错误"),
                  retriable: true,
                },
      );
    }
    // system messages are omitted; tool-result messages fold into the tool row above
  }
  return items;
}

// ---------------------------------------------------------------------------
// Token usage (per-session accumulation; the server sidecars UsageInfo on turns)
// ---------------------------------------------------------------------------

export const emptyUsage = (): SessionUsage => ({ byModel: {}, context: 0 });

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Fold one turn's usage sidecar into the session accumulation. */
export function addTurnUsage(prev: SessionUsage, raw: unknown): SessionUsage {
  if (!raw || typeof raw !== "object") return prev;
  const r = raw as UsageInfo;
  const turn: UsageInfo = {
    model: typeof r.model === "string" && r.model ? r.model : null,
    input: num(r.input),
    output: num(r.output),
    cache_read: num(r.cache_read),
    cache_write: num(r.cache_write),
  };
  const key = turn.model || "unknown";
  const cur = prev.byModel[key];
  return {
    byModel: {
      ...prev.byModel,
      [key]: {
        model: turn.model,
        input: (cur?.input || 0) + turn.input,
        output: (cur?.output || 0) + turn.output,
        cache_read: (cur?.cache_read || 0) + turn.cache_read,
        cache_write: (cur?.cache_write || 0) + turn.cache_write,
      },
    },
    // Prompt-side total of the LATEST round-trip = what currently sits in the context
    // window (not a sum — each request resends the whole history).
    context: turn.input + turn.cache_read + turn.cache_write,
  };
}

/** Rebuild the accumulation from a replayed transcript (session load/switch). */
export function usageFromMessages(messages: Message[]): SessionUsage {
  let acc = emptyUsage();
  for (const m of messages || []) {
    if (m.role === "assistant" && m.usage) acc = addTurnUsage(acc, m.usage);
  }
  return acc;
}

/** All tokens consumed this session, across models and directions. */
export function totalTokens(u: SessionUsage): number {
  return Object.values(u.byModel).reduce(
    (sum, t) => sum + t.input + t.output + t.cache_read + t.cache_write,
    0,
  );
}

/** 980 → "980", 12_400 → "12.4k", 982_000 → "982k", 1_240_000 → "1.24M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k < 100 ? k.toFixed(1).replace(/\.0$/, "") : String(Math.round(k))) + "k";
  }
  const m = n / 1_000_000;
  return (m < 100 ? m.toFixed(2).replace(/\.?0+$/, "") : String(Math.round(m))) + "M";
}

// ---------------------------------------------------------------------------
// Stream placement: the first non-empty assistant_delta is visible as the live answer.
// Tool/reasoning activity is rendered separately by the view.
// ---------------------------------------------------------------------------

export type StreamMode = "none" | "answer";

export function midTurn(items: TimelineItem[], running: boolean): boolean {
  if (!running) return false;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "notice") continue;
    return item.kind === "tool" || item.kind === "approval" || item.kind === "assistant";
  }
  return false;
}

export function streamMode(streaming: string, items: TimelineItem[], running: boolean): StreamMode {
  void items;
  void running;
  if (!streaming) return "none";
  return "answer";
}

export function lastItemIsAssistant(items: TimelineItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "notice") continue;
    return item.kind === "assistant";
  }
  return false;
}

/** The transcript index whose notice gets the 重试 button: the tail error notice, looking
 * through info notices after it (a model switch must not consume the retry). -1 otherwise. */
export function retryAnchor(items: TimelineItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== "notice") return -1;
    if (it.retriable) return i;
    if (it.tone !== "info") return -1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Targeted list updates (optimistic resolves + tool completion)
// ---------------------------------------------------------------------------

export function updateLastTool(
  items: TimelineItem[],
  name: string,
  status: string,
  preview?: string,
  hidden?: number,
  standingRule?: string,
  durationMs?: number,
): TimelineItem[] {
  const copy = [...items];
  for (let i = copy.length - 1; i >= 0; i--) {
    const it = copy[i];
    if (it.kind === "tool" && it.name === name && it.status === "…") {
      copy[i] = {
        ...it,
        status,
        preview,
        ...(hidden ? { hidden } : {}),
        ...(standingRule ? { standingRule } : {}),
        ...(typeof durationMs === "number" ? { durationMs } : {}),
      };
      break;
    }
  }
  return copy;
}

export function resolveLastApproval(items: TimelineItem[], decision: ApprovalDecision): TimelineItem[] {
  const copy = [...items];
  for (let i = copy.length - 1; i >= 0; i--) {
    const it = copy[i];
    if (it.kind === "approval" && !it.resolved) {
      copy[i] = { ...it, resolved: decision };
      break;
    }
  }
  return copy;
}

export function resolveLastDirReq(items: TimelineItem[], resolved: "granted" | "denied"): TimelineItem[] {
  const copy = [...items];
  for (let i = copy.length - 1; i >= 0; i--) {
    const it = copy[i];
    if (it.kind === "dirreq" && !it.resolved) {
      copy[i] = { ...it, resolved };
      break;
    }
  }
  return copy;
}

export function resolveLastPlan(items: TimelineItem[], resolved: "approved" | "rejected"): TimelineItem[] {
  const copy = [...items];
  for (let i = copy.length - 1; i >= 0; i--) {
    const it = copy[i];
    if (it.kind === "planreq" && !it.resolved) {
      copy[i] = { ...it, resolved };
      break;
    }
  }
  return copy;
}

export function resolveLastQuestion(items: TimelineItem[], answer: string): TimelineItem[] {
  const copy = [...items];
  for (let i = copy.length - 1; i >= 0; i--) {
    const it = copy[i];
    if (it.kind === "question" && !it.resolved) {
      copy[i] = { ...it, resolved: answer };
      break;
    }
  }
  return copy;
}

// Models sometimes pass todo items as bare strings instead of {content, status} objects.
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const statuses = new Set(["pending", "in_progress", "done"]);
  return raw.map((entry: unknown) => {
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const status = e.status === "completed" ? "done" : e.status; // common model alias
      return {
        content: String(e.content ?? ""),
        status: statuses.has(status as string) ? (status as TodoItem["status"]) : "pending",
      };
    }
    return { content: String(entry ?? ""), status: "pending" as const };
  });
}

// ---------------------------------------------------------------------------
// Chat state + the live-event reducer
// ---------------------------------------------------------------------------

export interface ChatState {
  items: TimelineItem[];
  /** assistant_delta buffer — finalized into an assistant item by assistant_message. */
  streaming: string;
  /** reasoning_delta buffer — folds onto the assistant item at finalize. */
  reasoning: string;
  running: boolean;
  compacting: boolean;
  connected: boolean;
  /** Unattended sessions park prompts in the Inbox — live inline cards stay suppressed. */
  unattended: boolean;
  model: string | null;
  mode: string | null;
  /** Adopted from `ready`: the server-provisioned scratch dir for brand-new sessions. */
  workspace: string | null;
  /** The visible timeline came from cache and has not been refreshed by history yet. */
  historyStale: boolean;
  usage: SessionUsage;
  todo: TodoItem[];
  /** Sticky: once any todo_write arrives the 待办 tab exists (even after the list clears). */
  todoSeen: boolean;
}

export const initialChatState = (): ChatState => ({
  items: [],
  streaming: "",
  reasoning: "",
  running: false,
  compacting: false,
  connected: false,
  unattended: false,
  model: null,
  mode: null,
  workspace: null,
  historyStale: false,
  usage: emptyUsage(),
  todo: [],
  todoSeen: false,
});

/** Hydrate from history (session load/switch). Keeps connection flags. */
export function hydrateChat(state: ChatState, items: TimelineItem[], usage: SessionUsage): ChatState {
  return { ...state, items, usage, streaming: "", reasoning: "", historyStale: false, todo: [], todoSeen: false };
}

export function markConnected(state: ChatState, connected: boolean): ChatState {
  return { ...state, connected };
}

export function markHistoryStale(state: ChatState, historyStale: boolean): ChatState {
  return { ...state, historyStale };
}

export function markUnattended(state: ChatState, unattended: boolean): ChatState {
  return { ...state, unattended };
}

/** Append the locally-sent user message (the server echoes it back as turn_start, which
 * the reducer de-duplicates). */
export function appendUserMessage(
  state: ChatState,
  text: string,
  attachments: Attachment[] | undefined,
  now: number,
): ChatState {
  return {
    ...state,
    items: [...state.items, { kind: "user", text, attachments, ts: now / 1000 }],
  };
}

/** Apply one live WS event. `now` = ms epoch (injectable for tests). */
export function applyWsEvent(state: ChatState, ev: WsEvent, now: number = Date.now()): ChatState {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  // An interrupted/errored turn never emits assistant_message; promote the streamed
  // partial to a durable item (the engine persists the same text server-side).
  const flushPartial = (s: ChatState): ChatState => {
    if (!s.streaming && !s.reasoning) return s;
    return {
      ...s,
      streaming: "",
      reasoning: "",
      items: [
        ...s.items,
        {
          kind: "assistant",
          text: s.streaming,
          ts: now / 1000,
          ...(s.reasoning ? { reasoning: s.reasoning } : {}),
        },
      ],
    };
  };
  // Any engine event after `compacting` means the summarizer finished.
  if (ev.type !== "compacting" && state.compacting) state = { ...state, compacting: false };

  switch (ev.type) {
    case "ready":
      return {
        ...state,
        connected: true,
        model: (ev.data.model as string) || state.model,
        mode: (ev.data.mode as string) || state.mode,
        workspace: (ev.data.workspace as string | null) ?? state.workspace,
      };
    case "turn_start": {
      let items = state.items;
      const source = d.source as MessageSource | undefined;
      if (source?.connector) {
        // Background-delivered connector turn — surface the triggering message once.
        const last = items[items.length - 1];
        if (!(last && last.kind === "connector" && last.source.ts === source.ts && last.source.text === source.text)) {
          items = [...items, { kind: "connector", source }];
        }
      } else if (typeof d.input === "string" && d.input) {
        // Foreground sends already appended the user item — skip the echo.
        const last = items[items.length - 1];
        if (!(last && last.kind === "user" && last.text === d.input)) {
          items = [...items, { kind: "user", text: d.input, ts: now / 1000 }];
        }
      }
      return { ...state, items, running: true, streaming: "", reasoning: "" };
    }
    case "assistant_delta":
      return { ...state, streaming: state.streaming + (ev.data.text || "") };
    case "reasoning_delta":
      return { ...state, reasoning: state.reasoning + (ev.data.text || "") };
    case "assistant_message": {
      const reasoning = ev.data.reasoning || state.reasoning;
      const finalText = ev.data.text || "";
      const last = state.items[state.items.length - 1];
      const hasFinalContent = !!(finalText || reasoning);
      const duplicateFinal =
        hasFinalContent &&
        last?.kind === "assistant" &&
        last.text === finalText &&
        (last.reasoning || "") === (reasoning || "");
      const shouldAppend = hasFinalContent && !duplicateFinal;
      const items =
        shouldAppend
          ? [
              ...state.items,
              {
                kind: "assistant" as const,
                text: finalText,
                ts: now / 1000,
                ...(reasoning ? { reasoning } : {}),
              },
            ]
          : state.items;
      return {
        ...state,
        items,
        streaming: "",
        reasoning: "",
        usage: ev.data.usage && !duplicateFinal ? addTurnUsage(state.usage, ev.data.usage) : state.usage,
      };
    }
    case "tool_proposed": {
      const args = (ev.data.arguments ?? {}) as Record<string, unknown>;
      let { todo, todoSeen } = state;
      if (ev.data.name === "todo_write" && (args.todos || args.items)) {
        todo = normalizeTodos(args.todos ?? args.items);
        todoSeen = true;
      }
      return {
        ...state,
        todo,
        todoSeen,
        items: [
          ...state.items,
          { kind: "tool", id: localId(), name: ev.data.name, args, status: "…", startedAt: now },
        ],
      };
    }
    case "permission_required":
      // Unattended → parked in the Inbox; don't also surface a live card.
      if (state.unattended) return state;
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "approval",
            name: ev.data.name,
            args: (ev.data.arguments ?? {}) as Record<string, unknown>,
            reason: ev.data.reason,
            category: ev.data.category,
            standingTarget: ev.data.standing_target || undefined,
          },
        ],
      };
    case "directory_requested":
      if (state.unattended) return state;
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "dirreq",
            reason: ev.data.reason || "",
            path: ev.data.path || "",
            writable: !!ev.data.writable,
          },
        ],
      };
    case "plan_proposed":
      if (state.unattended) return state;
      return { ...state, items: [...state.items, { kind: "planreq", plan: ev.data.plan || "" }] };
    case "question_requested":
      // ask_user in an attended session — answered inline (the server only emits this attended).
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "question",
            question: ev.data.question || "",
            options: ev.data.options || [],
            allow_text: ev.data.allow_text !== false,
            multi: !!ev.data.multi,
          },
        ],
      };
    case "tool_started":
      return state; // tool_proposed already created the row
    case "tool_finished": {
      const started = [...state.items].reverse().find(
        (it) => it.kind === "tool" && it.name === ev.data.name && it.status === "…",
      ) as ToolItem | undefined;
      const durationMs =
        started?.startedAt != null ? Math.max(0, now - started.startedAt) : undefined;
      return {
        ...state,
        items: updateLastTool(
          state.items,
          ev.data.name,
          ev.data.status,
          ev.data.result_preview || ev.data.reason,
          ev.data.display?.hidden_by_filters as number | undefined,
          ev.data.standing_rule,
          durationMs,
        ),
      };
    }
    case "iteration_end":
      return state;
    case "turn_end":
      if (ev.data.status === "max_iterations_exceeded") {
        return {
          ...state,
          items: [...state.items, { kind: "notice", tone: "warn", text: "已停止：达到最大迭代次数。" }],
        };
      }
      return state;
    case "model_changed":
      return {
        ...state,
        model: ev.data.model || state.model,
        items: [...state.items, { kind: "notice", tone: "info", text: ev.data.text || "已切换模型" }],
      };
    case "compacting":
      return { ...state, compacting: true };
    case "compacted":
      return {
        ...state,
        items: [...state.items, { kind: "notice", tone: "info", text: ev.data.text || "上下文已压缩" }],
      };
    case "interrupted": {
      const s = flushPartial(state);
      return { ...s, items: [...s.items, { kind: "notice", tone: "warn", text: "已中断。" }] };
    }
    case "error": {
      const s = flushPartial(state);
      return {
        ...s,
        items: [
          ...s.items,
          {
            kind: "notice",
            tone: "error",
            text: "错误：" + humanizeErrorText(ev.data.error || "未知错误"),
            retriable: true,
          },
        ],
      };
    }
    case "input_rejected":
      // Validation failure, not a provider failure — no retry, no partial flush.
      return {
        ...state,
        items: [...state.items, { kind: "notice", tone: "warn", text: ev.data.error || "这条消息被拒绝了。" }],
      };
    case "turn_done":
      return { ...state, running: false };
    default:
      return state;
  }
}
