// Agent profiles (multi-agent control plane) + agent permissions.
// Routes verified against coworker/server/app.py:1407-1470.

import { api } from "./client";
import type {
  AgentCapabilities,
  AgentMainProfile,
  AgentPermission,
  AgentProfile,
} from "./types";

// -- agent profiles (app.py:1407-1453) ------------------------------------------
export async function listAgentProfiles(): Promise<AgentProfile[]> {
  const data = await api.get<{ profiles?: AgentProfile[] }>("/v1/agent-profiles");
  return data.profiles ?? [];
}

export const upsertAgentProfile = (
  profile: AgentProfile,
): Promise<{ ok: boolean; profile?: AgentProfile; error?: string }> =>
  api.post("/v1/agent-profiles", profile);

export const deleteAgentProfile = (
  profileId: string,
): Promise<{ ok: boolean; deleted?: boolean; profile_id?: string; error?: string }> =>
  api.delete(`/v1/agent-profiles/${encodeURIComponent(profileId)}`);

// Live capability probe: launches the profile's runtime read-only and records what it
// reports (app.py:1444). Slow — the caller should treat this as a background action.
export const probeAgentProfile = (
  profileId: string,
  workspace?: string,
): Promise<{
  ok: boolean;
  profile?: AgentProfile;
  capabilities?: AgentCapabilities;
  error?: string;
}> => api.post(`/v1/agent-profiles/${encodeURIComponent(profileId)}/probe`, { workspace });

export const getWorkspaceMainAgent = (workspace?: string): Promise<AgentMainProfile> =>
  api.get<AgentMainProfile>(
    "/v1/agent-profiles/main",
    workspace ? { workspace } : undefined,
  );

// PATH detection for the preset cards' 已安装/未安装 badge (app.py detect route).
// Informational only — a missing command never blocks profile creation.
export const detectAgentCommands = (
  commands: string[],
): Promise<{ results: Record<string, boolean> }> =>
  api.get("/v1/agent-profiles/detect", { commands: commands.join(",") });

export const setWorkspaceMainAgent = (
  workspace: string | null | undefined,
  profileId: string,
): Promise<{ ok: boolean; workspace?: string; main_profile_id?: string; error?: string }> =>
  api.post("/v1/agent-profiles/main", { workspace, profile_id: profileId });

// -- agent permissions (app.py:1455-1470) ---------------------------------------
export async function listAgentPermissions(pendingOnly = true): Promise<AgentPermission[]> {
  const data = await api.get<{ permissions?: AgentPermission[] }>("/v1/agent-permissions", {
    pending_only: pendingOnly,
  });
  return data.permissions ?? [];
}

// Resolve a parked permission request; `optionId` null = deny.
export const resolveAgentPermission = (
  permissionId: string,
  optionId: string | null,
): Promise<{ ok: boolean; permission?: AgentPermission; error?: string }> =>
  api.post(`/v1/agent-permissions/${encodeURIComponent(permissionId)}`, {
    option_id: optionId,
  });
