// Inbox (cross-session attention queue), channel subscriptions, recent channels,
// unrouted dead-letters, inbox routing bindings and DM routing.
// Routes verified against coworker/server/app.py:254-380, 1644-1651.

import { api } from "./client";
import type {
  InboxBinding,
  InboxItem,
  InboxReconcile,
  RecentChannel,
  Subscription,
  UnroutedItem,
} from "./types";

// -- inbox (app.py:254-296) -------------------------------------------------------
// Without `sessionId` the list shows only inbox-visibility items; a per-session query
// returns inline ones too (the answer-in-context card).
export async function getInbox(sessionId?: string, state?: string): Promise<InboxItem[]> {
  const data = await api.get<{ items?: InboxItem[] }>("/v1/inbox", {
    session_id: sessionId || undefined,
    state: state || undefined,
  });
  return data.items ?? [];
}

// Idempotent + first-responder-wins: ok=false means it was already resolved elsewhere.
export const resolveInboxItem = (
  itemId: string,
  resolution: string,
): Promise<{ ok: boolean }> =>
  api.post(`/v1/inbox/${encodeURIComponent(itemId)}/resolve`, { resolution });

// Called when a session resumes attended control (surface pending + recap inline)
// (app.py:362).
export const reconcileInbox = (sessionId: string): Promise<InboxReconcile> =>
  api.get<InboxReconcile>("/v1/inbox/reconcile", { session_id: sessionId });

// -- inbox routing bindings (app.py:367-380) --------------------------------------
export async function getInboxRouting(): Promise<InboxBinding[]> {
  const data = await api.get<{ bindings?: InboxBinding[] }>("/v1/inbox/routing");
  return data.bindings ?? [];
}

export const setInboxBinding = (
  name: string,
  channel: string | null,
  target: string,
): Promise<{ ok: boolean; bindings?: InboxBinding[]; error?: string }> =>
  api.post("/v1/inbox/routing/binding", { name, channel, target });

// -- channel subscriptions (app.py:298-360) ---------------------------------------
export async function getSubscriptions(): Promise<Subscription[]> {
  const data = await api.get<{ subscriptions?: Subscription[] }>("/v1/subscriptions");
  return data.subscriptions ?? [];
}

export const subscribeChannel = (
  sessionId: string,
  channel: string,
): Promise<{ ok: boolean; channel?: string; error?: string }> =>
  api.post("/v1/subscriptions", { session_id: sessionId, channel });

export const unsubscribeChannel = (
  sessionId: string,
  channel: string,
): Promise<{ ok: boolean; removed?: boolean }> =>
  api.post("/v1/subscriptions/remove", { session_id: sessionId, channel });

// Channels the bot has recently received messages from (the picker's source) (app.py:323).
export async function getRecentChannels(): Promise<RecentChannel[]> {
  const data = await api.get<{ channels?: RecentChannel[] }>("/v1/channels/recent");
  return data.channels ?? [];
}

// Dead-letter view: inbound messages with no destination + background-turn failures
// (app.py:328).
export async function getUnrouted(): Promise<UnroutedItem[]> {
  const data = await api.get<{ items?: UnroutedItem[] }>("/v1/unrouted");
  return data.items ?? [];
}

// -- direct-message routing (app.py:1644-1651) ------------------------------------
export async function getDmRoute(): Promise<string | null> {
  const data = await api.get<{ dm_session?: string | null }>("/v1/messaging/dm-route");
  return data.dm_session ?? null;
}

// A falsy sessionId clears the designation (DMs then park as unrouted).
export const setDmRoute = (
  sessionId: string,
): Promise<{ ok: boolean; dm_session: string | null }> =>
  api.post("/v1/messaging/dm-route", { session_id: sessionId });
