import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSocket, connectMissionEvents } from "./ws";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeWebSocket | null = null;
  static all: FakeWebSocket[] = [];

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
    FakeWebSocket.all.push(this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWebSocket.last = null;
  FakeWebSocket.all = [];
});

describe("SessionSocket", () => {
  it("builds the session URL with workspace/agent and the ACP runtime for code", () => {
    vi.stubGlobal("__COWORKER_WS__", "ws://sidecar.test");
    vi.stubGlobal("__COWORKER_API_TOKEN__", "launch-token");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const code = new SessionSocket("s1", "/workspace", "code", { onEvent: vi.fn() });
    expect(FakeWebSocket.last?.url).toBe(
      "ws://sidecar.test/ws/session/s1?workspace=%2Fworkspace&agent=code&runtime=acp",
    );
    expect(FakeWebSocket.last?.protocols).toEqual(["openworker", "launch-token"]);
    code.close();

    const cowork = new SessionSocket("s2", "/workspace", "cowork", { onEvent: vi.fn() });
    expect(FakeWebSocket.last?.url).toBe(
      "ws://sidecar.test/ws/session/s2?workspace=%2Fworkspace&agent=cowork",
    );
    cowork.close();
  });

  it("appends profile_id only on the ACP runtime", () => {
    vi.stubGlobal("__COWORKER_WS__", "ws://sidecar.test");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const bound = new SessionSocket("s1", "/w", "cowork", { onEvent: vi.fn() }, {
      runtime: "acp",
      profileId: "kimi-main",
    });
    expect(FakeWebSocket.last?.url).toBe(
      "ws://sidecar.test/ws/session/s1?workspace=%2Fw&agent=cowork&runtime=acp&profile_id=kimi-main",
    );
    bound.close();

    // Embedded ignores the binding entirely (the param is acp-only).
    const embedded = new SessionSocket("s2", "/w", "cowork", { onEvent: vi.fn() }, {
      runtime: "embedded",
      profileId: "kimi-main",
    });
    expect(FakeWebSocket.last?.url).toBe("ws://sidecar.test/ws/session/s2?workspace=%2Fw&agent=cowork");
    embedded.close();

    // ACP with no profile = the workspace main — no profile_id param.
    const main = new SessionSocket("s3", "/w", "cowork", { onEvent: vi.fn() }, { runtime: "acp" });
    expect(FakeWebSocket.last?.url).toBe(
      "ws://sidecar.test/ws/session/s3?workspace=%2Fw&agent=cowork&runtime=acp",
    );
    main.close();
  });

  it("omits the subprotocol pair when there is no token", () => {
    vi.stubGlobal("__COWORKER_WS__", "ws://sidecar.test");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const socket = new SessionSocket("s1", "/w", "cowork", { onEvent: vi.fn() });
    expect(FakeWebSocket.last?.protocols).toBeUndefined();
    socket.close();
  });

  it("queues payloads while connecting and flushes them on open", () => {
    vi.stubGlobal("__COWORKER_WS__", "ws://sidecar.test");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onOpen = vi.fn();

    const socket = new SessionSocket("s1", "/w", "cowork", { onEvent: vi.fn(), onOpen });
    const ws = FakeWebSocket.last!;
    socket.userMessage("hello", undefined, "gpt-5");
    socket.approve("once");
    expect(ws.send).not.toHaveBeenCalled();

    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      type: "user_message",
      text: "hello",
      model: "gpt-5",
    });
    expect(JSON.parse(ws.send.mock.calls[1][0])).toEqual({
      type: "approval",
      decision: "once",
    });
    socket.close();
  });

  it("reconnects after a drop (~1.2s base backoff) and reports willReconnect", () => {
    vi.useFakeTimers();
    vi.stubGlobal("__COWORKER_WS__", "ws://sidecar.test");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onClose = vi.fn();

    const socket = new SessionSocket("s1", "/w", "cowork", { onEvent: vi.fn(), onClose });
    expect(FakeWebSocket.all).toHaveLength(1);

    FakeWebSocket.last!.onclose?.();
    expect(onClose).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(1200);
    expect(FakeWebSocket.all).toHaveLength(2);

    socket.close();
    expect(onClose).toHaveBeenCalledTimes(1); // intentional close fires no handler
  });
});

describe("connectMissionEvents", () => {
  it("opens the cursor-resumable URL and unwraps ledger envelopes", () => {
    vi.stubGlobal("__COWORKER_WS__", "ws://sidecar.test");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onEvent = vi.fn();

    const handle = connectMissionEvents("mission-1", "cursor-before", { onEvent });
    expect(FakeWebSocket.last?.url).toBe(
      "ws://sidecar.test/v1/missions/mission-1/events?after=cursor-before",
    );

    FakeWebSocket.last?.onmessage?.({
      data: JSON.stringify({
        type: "mission.member_updated",
        cursor: "ledger-cursor-2",
        event: {
          event_id: "event-id-2",
          event_type: "mission.member_updated",
          payload: { role: "executor" },
          created_at: "2026-08-01T00:00:00Z",
        },
      }),
    } as MessageEvent);

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: "event-id-2", cursor: "ledger-cursor-2" }),
    );
    handle.close();
  });

  it("resumes from the last-seen cursor after a reconnect", () => {
    vi.useFakeTimers();
    vi.stubGlobal("__COWORKER_WS__", "ws://sidecar.test");
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const handle = connectMissionEvents("mission-1", null, { onEvent: vi.fn() });
    expect(FakeWebSocket.last?.url).toBe(
      "ws://sidecar.test/v1/missions/mission-1/events",
    );

    FakeWebSocket.last?.onmessage?.({
      data: JSON.stringify({
        type: "mission.plan_proposed",
        cursor: "cursor-9",
        event: { event_id: "e9", event_type: "mission.plan_proposed", payload: {} },
      }),
    } as MessageEvent);
    FakeWebSocket.last?.onclose?.();
    vi.advanceTimersByTime(1200);

    expect(FakeWebSocket.all).toHaveLength(2);
    expect(FakeWebSocket.last?.url).toBe(
      "ws://sidecar.test/v1/missions/mission-1/events?after=cursor-9",
    );
    handle.close();
  });
});
