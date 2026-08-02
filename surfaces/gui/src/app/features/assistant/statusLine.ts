// The chat header's live status line — a pure derivation from ChatState plus the header's
// agent selection, so ChatView stays layout-only and every state is unit-testable here.
//
// Priority: 连接中… (socket down) → 等待你的回复 (a prompt card is parked on you) →
// 正在思考… (a turn is running) → 在线. ACP sessions prefix the agent name
// ("codex-main · 正在思考…"); the embedded partner answers as Q, unprefixed.

import type { ChatState, TimelineItem } from "./timeline";

export type SessionStatus = "connecting" | "waiting" | "thinking" | "online";

export const STATUS_TEXT: Record<SessionStatus, string> = {
  online: "在线",
  thinking: "正在思考…",
  waiting: "等待你的回复",
  connecting: "连接中…",
};

/** Any inline prompt still awaiting the user (unresolved approval/question/plan/directory). */
export function hasPendingPrompt(items: TimelineItem[]): boolean {
  return items.some((it) => {
    switch (it.kind) {
      case "approval":
      case "question":
      case "planreq":
      case "dirreq":
        return !it.resolved;
      default:
        return false;
    }
  });
}

export function sessionStatus(
  state: Pick<ChatState, "connected" | "running" | "items">,
): SessionStatus {
  if (!state.connected) return "connecting";
  if (hasPendingPrompt(state.items)) return "waiting";
  if (state.running) return "thinking";
  return "online";
}

/** The rendered line. `agentName` = the ACP agent (profile id / "ACP"), null for Q. */
export function statusLine(
  state: Pick<ChatState, "connected" | "running" | "items">,
  agentName?: string | null,
): string {
  const text = STATUS_TEXT[sessionStatus(state)];
  return agentName ? `${agentName} · ${text}` : text;
}
