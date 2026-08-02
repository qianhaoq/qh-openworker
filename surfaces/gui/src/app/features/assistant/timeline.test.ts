// Focused tests for the assistant timeline's pure logic: history mapping, the live-event
// reducer (streaming deltas, tool lifecycle, prompts, notices), usage accumulation and the
// stream gate. Socket-level integration uses the FakeWebSocket pattern from lib/ws.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, WsEvent } from "../../lib/api/types";
import { SessionSocket } from "../../lib/ws";
import {
  addTurnUsage,
  applyWsEvent,
  emptyUsage,
  formatTokens,
  initialChatState,
  itemsFromMessages,
  lastItemIsAssistant,
  markUnattended,
  normalizeTodos,
  resolveLastApproval,
  retryAnchor,
  streamMode,
  totalTokens,
  usageFromMessages,
  userItemFromContent,
  type ChatState,
} from "./timeline";

const NOW = 1_700_000_000_000; // fixed clock for deterministic ts/duration

const reduce = (state: ChatState, events: WsEvent[], now = NOW): ChatState =>
  events.reduce((s, ev) => applyWsEvent(s, ev, now), state);

describe("itemsFromMessages", () => {
  it("maps user/assistant messages and folds tool results into tool rows", () => {
    const messages: Message[] = [
      { role: "user", content: "帮我看看 README", ts: 100 },
      {
        role: "assistant",
        content: "好的，先读一下。",
        reasoning: "需要先打开文件",
        ts: 101,
        tool_calls: [
          { id: "tc1", function: { name: "read_file", arguments: JSON.stringify({ path: "/w/README.md" }) } },
        ],
      },
      { role: "tool", tool_call_id: "tc1", content: "# README 内容" },
      { role: "assistant", content: "读完了，这是一个助手项目。", ts: 102 },
    ];
    const items = itemsFromMessages(messages);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
    const tool = items[2];
    if (tool.kind !== "tool") throw new Error("expected tool");
    expect(tool.name).toBe("read_file");
    expect(tool.args).toEqual({ path: "/w/README.md" });
    expect(tool.preview).toBe("# README 内容");
    expect(tool.status).toBe("ok");
    const first = items[1];
    if (first.kind !== "assistant") throw new Error("expected assistant");
    expect(first.reasoning).toBe("需要先打开文件");
  });

  it("renders connector-delivered user messages as connector items", () => {
    const source = {
      connector: "slack",
      kind: "channel" as const,
      channel_id: "C1",
      channel_name: "general",
      sender_id: "U1",
      sender_name: "Jordan",
      ts: 5,
      text: "hi",
    };
    const items = itemsFromMessages([{ role: "user", content: "hi", source }]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("connector");
  });

  it("maps persisted notices (compacted / model_switch / error / interrupted)", () => {
    const items = itemsFromMessages([
      { role: "notice", kind: "compacted", text: "已压缩 12k tokens" },
      { role: "notice", kind: "model_switch", text: "切换到 gpt-5" },
      { role: "notice", kind: "error", text: "provider timeout" },
      { role: "notice", kind: "interrupted" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["notice", "notice", "notice", "notice"]);
    const [compacted, switched, failed, interrupted] = items;
    if (compacted.kind !== "notice" || switched.kind !== "notice" || failed.kind !== "notice" || interrupted.kind !== "notice")
      throw new Error("expected notices");
    expect(compacted.tone).toBe("info");
    expect(switched.text).toBe("切换到 gpt-5");
    expect(failed.tone).toBe("error");
    expect(failed.retriable).toBe(true);
    expect(interrupted.text).toBe("已中断。");
  });

  it("localizes the backend's missing-model-key error in persisted and live notices", () => {
    const raw =
      "No model API key configured. Set OPENAI_API_KEY in the environment, or add your key in Manage → Settings.";
    const want = "错误：未配置模型 API 密钥。请在 设置 → 模型 中添加,或设置环境变量。";

    const persisted = itemsFromMessages([{ role: "notice", kind: "error", text: raw }]);
    if (persisted[0].kind !== "notice") throw new Error("expected notice");
    expect(persisted[0].text).toBe(want);
    expect(persisted[0].retriable).toBe(true);

    const live = applyWsEvent(initialChatState(), { type: "error", data: { error: raw } }, NOW);
    const notice = live.items[live.items.length - 1];
    if (notice.kind !== "notice") throw new Error("expected notice");
    expect(notice.text).toBe(want);
  });

  it("extracts text and image attachments from multipart user content", () => {
    const item = userItemFromContent([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "image_url", image_url: { url: "https://example.com/x.png" } }, // remote — dropped
    ]);
    expect(item.text).toBe("看图");
    expect(item.attachments).toEqual([{ kind: "image", name: "image", data_url: "data:image/png;base64,AAA" }]);
  });
});

describe("applyWsEvent — streaming", () => {
  it("accumulates deltas and finalizes into an assistant item with reasoning + usage", () => {
    const events: WsEvent[] = [
      { type: "turn_start", data: { input: "你好" } },
      { type: "reasoning_delta", data: { text: "先想" } },
      { type: "reasoning_delta", data: { text: "一下" } },
      { type: "assistant_delta", data: { text: "你" } },
      { type: "assistant_delta", data: { text: "好！" } },
      {
        type: "assistant_message",
        data: {
          text: "你好！",
          tool_calls: [],
          reasoning: "先想一下",
          usage: { model: "gpt-5", input: 10, output: 5, cache_read: 2, cache_write: 1 },
        },
      },
      { type: "turn_end", data: { status: "done", iterations: 1 } },
      { type: "turn_done", data: {} },
    ];
    const state = reduce(initialChatState(), events);
    expect(state.streaming).toBe("");
    expect(state.reasoning).toBe("");
    expect(state.running).toBe(false);
    const assistant = state.items.find((i) => i.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected assistant item");
    expect(assistant.text).toBe("你好！");
    expect(assistant.reasoning).toBe("先想一下");
    expect(totalTokens(state.usage)).toBe(18);
    expect(state.usage.context).toBe(13); // input + cache_read + cache_write
  });

  it("turn_start de-duplicates the locally-echoed user message but appends background turns", () => {
    let state = applyWsEvent(initialChatState(), { type: "turn_start", data: { input: "本地发的" } }, NOW);
    // Simulate the optimistic local append having landed first.
    state = { ...state, items: [{ kind: "user", text: "后台来的", ts: 1 }] };
    state = applyWsEvent(state, { type: "turn_start", data: { input: "后台来的" } }, NOW);
    expect(state.items.filter((i) => i.kind === "user")).toHaveLength(1);
    state = applyWsEvent(state, { type: "turn_start", data: { input: "又一条" } }, NOW);
    expect(state.items.filter((i) => i.kind === "user")).toHaveLength(2);
    expect(state.running).toBe(true);
  });

  it("flushes the partial stream into a durable item on error and interrupted", () => {
    let state = reduce(initialChatState(), [
      { type: "turn_start", data: { input: "写点什么" } },
      { type: "assistant_delta", data: { text: "写了一半" } },
    ]);
    state = applyWsEvent(state, { type: "error", data: { error: "boom" } }, NOW);
    const assistant = state.items.find((i) => i.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected flushed assistant item");
    expect(assistant.text).toBe("写了一半");
    const notice = state.items[state.items.length - 1];
    if (notice.kind !== "notice") throw new Error("expected notice");
    expect(notice.retriable).toBe(true);
    expect(retryAnchor(state.items)).toBe(state.items.length - 1);
  });

  it("compacting sets the flag; the next engine event clears it and compacted adds a divider", () => {
    let state = applyWsEvent(initialChatState(), { type: "compacting", data: {} }, NOW);
    expect(state.compacting).toBe(true);
    state = applyWsEvent(state, { type: "compacted", data: { text: "已压缩上下文" } }, NOW);
    expect(state.compacting).toBe(false);
    expect(state.items[state.items.length - 1]).toMatchObject({ kind: "notice", tone: "info" });
  });

  it("ready adopts model/mode and the server-provisioned workspace", () => {
    const state = applyWsEvent(initialChatState(), {
      type: "ready",
      data: {
        session_id: "s1",
        agent: "cowork",
        model: "gpt-5",
        mode: "interactive",
        workspace: "/tmp/scratch/s1",
      },
    }, NOW);
    expect(state.connected).toBe(true);
    expect(state.model).toBe("gpt-5");
    expect(state.mode).toBe("interactive");
    expect(state.workspace).toBe("/tmp/scratch/s1");
  });
});

describe("applyWsEvent — tools & prompts", () => {
  it("tool_proposed → tool_finished updates the row with status, preview and duration", () => {
    let state = reduce(initialChatState(), [
      { type: "turn_start", data: { input: "跑下测试" } },
      { type: "tool_proposed", data: { name: "run_shell", arguments: { command: "npm test" } } },
    ]);
    state = applyWsEvent(
      state,
      { type: "tool_finished", data: { name: "run_shell", status: "ok", result_preview: "42 passed" } },
      NOW + 1500,
    );
    const tool = state.items.find((i) => i.kind === "tool");
    if (tool?.kind !== "tool") throw new Error("expected tool");
    expect(tool.status).toBe("ok");
    expect(tool.preview).toBe("42 passed");
    expect(tool.durationMs).toBe(1500);
  });

  it("captures todo_write proposals into the todo list (and tolerates bare strings)", () => {
    const state = applyWsEvent(
      initialChatState(),
      {
        type: "tool_proposed",
        data: {
          name: "todo_write",
          arguments: { todos: [{ content: "读代码", status: "in_progress" }, "写测试"] },
        },
      },
      NOW,
    );
    expect(state.todo).toEqual([
      { content: "读代码", status: "in_progress" },
      { content: "写测试", status: "pending" },
    ]);
    expect(state.todoSeen).toBe(true);
  });

  it("suppresses live prompt cards while unattended", () => {
    const unattended = markUnattended(initialChatState(), true);
    const events: WsEvent[] = [
      { type: "permission_required", data: { name: "write_file", arguments: {}, reason: "需要批准" } },
      { type: "directory_requested", data: { reason: "需要访问" } },
      { type: "plan_proposed", data: { plan: "1. 先做" } },
    ];
    expect(reduce(unattended, events).items).toHaveLength(0);
    const attended = reduce(initialChatState(), events);
    expect(attended.items.map((i) => i.kind)).toEqual(["approval", "dirreq", "planreq"]);
  });

  it("approval resolves optimistically via resolveLastApproval", () => {
    let state = applyWsEvent(
      initialChatState(),
      { type: "permission_required", data: { name: "run_shell", arguments: { command: "ls" }, reason: "" } },
      NOW,
    );
    state = { ...state, items: resolveLastApproval(state.items, "once") };
    const approval = state.items[0];
    if (approval.kind !== "approval") throw new Error("expected approval");
    expect(approval.resolved).toBe("once");
  });

  it("model_changed updates the model and drops an info marker; turn_end warns on max iterations", () => {
    let state = applyWsEvent(initialChatState(), { type: "model_changed", data: { model: "gpt-5", text: "已切换模型" } }, NOW);
    expect(state.model).toBe("gpt-5");
    state = applyWsEvent(state, { type: "turn_end", data: { status: "max_iterations_exceeded", iterations: 25 } }, NOW);
    expect(state.items.map((i) => i.kind)).toEqual(["notice", "notice"]);
    expect(lastItemIsAssistant(state.items)).toBe(false);
  });
});

describe("stream gate", () => {
  it("holds turn-start trickles, keeps mid-turn text quiet, promotes long answers", () => {
    const running = { ...initialChatState(), running: true };
    expect(streamMode("正在", running.items, true)).toBe("hold");
    const midItems = applyWsEvent(
      running,
      { type: "tool_proposed", data: { name: "read_file", arguments: {} } },
      NOW,
    ).items;
    expect(streamMode("还在读", midItems, true)).toBe("quiet");
    const long = Array.from({ length: 45 }, (_, i) => `词${i}`).join(" ");
    expect(streamMode(long, running.items, true)).toBe("answer");
    expect(streamMode("done", [], false)).toBe("answer");
    expect(streamMode("", [], true)).toBe("none");
  });
});

describe("usage helpers", () => {
  it("accumulates per model and formats token counts", () => {
    let usage = emptyUsage();
    usage = addTurnUsage(usage, { model: "gpt-5", input: 100, output: 50, cache_read: 10, cache_write: 5 });
    usage = addTurnUsage(usage, { model: "gpt-5", input: 200, output: 60, cache_read: 0, cache_write: 0 });
    usage = addTurnUsage(usage, { model: null, input: 3, output: 1, cache_read: 0, cache_write: 0 });
    expect(usage.byModel["gpt-5"].input).toBe(300);
    expect(usage.byModel["unknown"].output).toBe(1);
    expect(usage.context).toBe(3); // the LATEST round-trip's prompt side (3 + 0 + 0)
    expect(totalTokens(usage)).toBe(429);
    expect(formatTokens(980)).toBe("980");
    expect(formatTokens(12_400)).toBe("12.4k");
    expect(formatTokens(982_000)).toBe("982k");
    expect(formatTokens(1_240_000)).toBe("1.24M");
  });

  it("rebuilds from replayed messages", () => {
    const usage = usageFromMessages([
      { role: "assistant", content: "a", usage: { model: "gpt-5", input: 10, output: 5, cache_read: 0, cache_write: 0 } },
      { role: "user", content: "b" },
      { role: "assistant", content: "c", usage: { model: "gpt-5", input: 20, output: 6, cache_read: 1, cache_write: 0 } },
    ]);
    expect(usage.byModel["gpt-5"].input).toBe(30);
    expect(usage.context).toBe(21);
  });

  it("normalizeTodos maps aliases and bare entries", () => {
    expect(normalizeTodos([{ content: "a", status: "completed" }, "b", { content: "c", status: "weird" }])).toEqual([
      { content: "a", status: "done" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ]);
    expect(normalizeTodos("nope")).toEqual([]);
  });
});

// -- socket plumbing: the explicit runtime option (FakeWebSocket pattern from ws.test.ts) --

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    FakeWebSocket.last = this;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.last = null;
});

describe("SessionSocket runtime option", () => {
  it("rides runtime=acp only when asked; the code agent still defaults to it", () => {
    vi.stubGlobal("__COWORKER_WS__", "ws://sidecar.test");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const acp = new SessionSocket("s1", "/w", "cowork", { onEvent: vi.fn() }, { runtime: "acp" });
    expect(FakeWebSocket.last?.url).toContain("runtime=acp");
    acp.close();

    const embedded = new SessionSocket("s2", "/w", "cowork", { onEvent: vi.fn() }, { runtime: "embedded" });
    expect(FakeWebSocket.last?.url).not.toContain("runtime=acp");
    embedded.close();

    const codeDefault = new SessionSocket("s3", "/w", "code", { onEvent: vi.fn() });
    expect(FakeWebSocket.last?.url).toContain("runtime=acp");
    codeDefault.close();
  });
});
