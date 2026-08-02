import { describe, expect, it } from "vitest";
import { hasPendingPrompt, sessionStatus, statusLine } from "./statusLine";
import { initialChatState, type TimelineItem } from "./timeline";

const state = (overrides: Partial<ReturnType<typeof initialChatState>> = {}) => ({
  ...initialChatState(),
  ...overrides,
});

describe("hasPendingPrompt", () => {
  it("false for plain conversation items", () => {
    const items: TimelineItem[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "hello" },
      { kind: "notice", tone: "info", text: "n" },
    ];
    expect(hasPendingPrompt(items)).toBe(false);
  });

  it("true while any prompt is unresolved, false once resolved", () => {
    const approval: TimelineItem = { kind: "approval", name: "run_shell", args: {}, reason: "" };
    expect(hasPendingPrompt([approval])).toBe(true);
    expect(hasPendingPrompt([{ ...approval, resolved: "once" }])).toBe(false);

    const question: TimelineItem = { kind: "question", question: "?" };
    expect(hasPendingPrompt([question])).toBe(true);
    expect(hasPendingPrompt([{ ...question, resolved: "yes" }])).toBe(false);

    const plan: TimelineItem = { kind: "planreq", plan: "do things" };
    expect(hasPendingPrompt([plan])).toBe(true);
    expect(hasPendingPrompt([{ ...plan, resolved: "approved" }])).toBe(false);

    const dir: TimelineItem = { kind: "dirreq", reason: "" };
    expect(hasPendingPrompt([dir])).toBe(true);
    expect(hasPendingPrompt([{ ...dir, resolved: "granted" }])).toBe(false);
  });
});

describe("sessionStatus", () => {
  it("connecting beats everything else", () => {
    expect(
      sessionStatus(
        state({
          connected: false,
          running: true,
          items: [{ kind: "approval", name: "run_shell", args: {}, reason: "" }],
        }),
      ),
    ).toBe("connecting");
  });

  it("waiting beats thinking (the ball is with the user mid-turn)", () => {
    expect(
      sessionStatus(
        state({
          connected: true,
          running: true,
          items: [{ kind: "question", question: "?" }],
        }),
      ),
    ).toBe("waiting");
  });

  it("thinking while a turn runs with nothing parked", () => {
    expect(sessionStatus(state({ connected: true, running: true }))).toBe("thinking");
  });

  it("online when connected and idle", () => {
    expect(sessionStatus(state({ connected: true }))).toBe("online");
  });
});

describe("statusLine", () => {
  it("bare status text for the embedded partner (Q)", () => {
    expect(statusLine(state({ connected: true }))).toBe("在线");
    expect(statusLine(state({ connected: true, running: true }))).toBe("正在思考…");
    expect(statusLine(state({ connected: false }))).toBe("连接中…");
    expect(
      statusLine(
        state({ connected: true, running: true, items: [{ kind: "dirreq", reason: "" }] }),
      ),
    ).toBe("等待你的回复");
  });

  it("prefixes the agent name for ACP sessions", () => {
    expect(statusLine(state({ connected: true, running: true }), "codex-main")).toBe(
      "codex-main · 正在思考…",
    );
    expect(statusLine(state({ connected: true }), "ACP")).toBe("ACP · 在线");
  });
});
