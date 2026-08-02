// The chat header's agent picker: which runtime/agent serves this session. Pure logic
// (selection value model, localStorage persistence + legacy migration, menu derivation)
// — no React; every function here is unit-tested in agentChoice.test.ts.
//
// Value model: "embedded" (内置助理, the built-in engine) | "acp" (the workspace-main
// ACP agent, no explicit profile) | an agent profile id (a specific ACP profile).

import type { AgentProfile } from "../../lib/api/types";
import { isProfileUsable } from "../agents/agentLogic";

export type AgentChoice = string;

export const agentChoiceKey = (sessionId: string) => `assistant:agent:${sessionId}`;

// The pre-picker boolean ACP toggle ("acp" | "embedded") — migrated on first read.
const legacyRuntimeKey = (sessionId: string) => `assistant:runtime:${sessionId}`;

/** No stored choice: the "code" agent still defaults to the ACP workspace main. */
export const defaultAgentChoice = (agent: string): AgentChoice =>
  agent === "code" ? "acp" : "embedded";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Read the stored choice (null = none). Migrates the legacy runtime key: "acp" maps to
 * the ACP workspace-main selection, anything else to "embedded"; the old key is removed. */
export function loadAgentChoice(
  sessionId: string,
  storage: StorageLike = localStorage,
): AgentChoice | null {
  try {
    const stored = storage.getItem(agentChoiceKey(sessionId));
    if (stored) return stored;
    const legacy = storage.getItem(legacyRuntimeKey(sessionId));
    if (legacy === null) return null;
    storage.removeItem(legacyRuntimeKey(sessionId));
    const migrated: AgentChoice = legacy === "acp" ? "acp" : "embedded";
    storage.setItem(agentChoiceKey(sessionId), migrated);
    return migrated;
  } catch {
    return null; // storage blocked (private mode) — fall back to the default
  }
}

export function saveAgentChoice(
  sessionId: string,
  choice: AgentChoice,
  storage: StorageLike = localStorage,
): void {
  try {
    storage.setItem(agentChoiceKey(sessionId), choice);
  } catch {
    /* best effort */
  }
}

export interface ResolvedAgent {
  runtime: "embedded" | "acp";
  /** Present only when a specific profile is bound (goes on the socket query). */
  profileId?: string;
}

/** Map a selection onto the socket options. */
export function resolveAgentChoice(choice: AgentChoice): ResolvedAgent {
  if (choice === "embedded") return { runtime: "embedded" };
  if (choice === "acp") return { runtime: "acp" };
  return { runtime: "acp", profileId: choice };
}

/** The pill's current-selection label. */
export function agentChoiceLabel(choice: AgentChoice): string {
  if (choice === "embedded") return "内置助理";
  if (choice === "acp") return "ACP";
  return choice;
}

/** The selectable agents: profiles that are enabled AND carry a current probe (the same
 * rule the Agents page and mission seats apply). An empty result = the menu's empty
 * state (内置助理 + the quiet 去 Agents 页招募 row). */
export function selectableProfiles(profiles: readonly AgentProfile[]): AgentProfile[] {
  return profiles.filter(isProfileUsable);
}
