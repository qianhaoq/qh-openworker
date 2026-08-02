// Health, workspaces, sessions (CRUD, messages, roots, artifacts), unattended mode and
// per-session connections. Every route verified against coworker/server/app.py.

import { api } from "./client";
import type {
  Artifact,
  ArtifactContent,
  Health,
  Message,
  OpenWorkspaceResult,
  RecentWorkspace,
  RootEntry,
  Session,
  SessionConnections,
  WorkspaceCommandTrust,
} from "./types";

// -- health (app.py:236) ------------------------------------------------------
export const getHealth = (): Promise<Health> => api.get<Health>("/v1/health");

// -- workspaces (app.py:563-588) ----------------------------------------------
export async function getRecentWorkspaces(): Promise<RecentWorkspace[]> {
  const data = await api.get<{ workspaces?: RecentWorkspace[] }>("/v1/workspaces/recent");
  return data.workspaces ?? [];
}

export const openWorkspace = (path: string, create = false): Promise<OpenWorkspaceResult> =>
  api.post<OpenWorkspaceResult>("/v1/workspaces/open", { path, create });

export async function getTrustedWorkspaces(): Promise<WorkspaceCommandTrust[]> {
  const data = await api.get<{ workspaces?: WorkspaceCommandTrust[] }>("/v1/workspaces/trusted");
  return data.workspaces ?? [];
}

export const setWorkspaceTrusted = (
  path: string,
  trusted: boolean,
): Promise<{ ok: boolean; error?: string } & Partial<WorkspaceCommandTrust>> =>
  api.post("/v1/workspaces/trust", { path, trusted });

/** Ask the LOCAL sidecar to open the OS folder picker — the browser GUI can't obtain
 * absolute paths from web file dialogs. Blocks until pick/cancel; null on cancel. */
export async function pickFolderViaServer(): Promise<string | null> {
  try {
    const data = await api.post<{ ok: boolean; path?: string }>("/v1/workspaces/pick");
    return data.ok && data.path ? data.path : null;
  } catch {
    return null;
  }
}

// -- sessions (app.py:590-611) --------------------------------------------------
export async function getSessions(workspace?: string): Promise<Session[]> {
  const data = await api.get<{ sessions?: Session[] }>(
    "/v1/sessions",
    workspace ? { workspace } : undefined,
  );
  return data.sessions ?? [];
}

export async function getSessionMessages(sessionId: string): Promise<Message[]> {
  const data = await api.get<{ messages?: Message[] }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
  );
  return data.messages ?? [];
}

export const renameSession = (
  sessionId: string,
  title: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, { title });

export const setSessionFlags = (
  sessionId: string,
  flags: { pinned?: boolean; archived?: boolean },
): Promise<{ ok: boolean; error?: string }> =>
  api.patch(`/v1/sessions/${encodeURIComponent(sessionId)}`, flags);

export const deleteSession = (sessionId: string): Promise<{ ok: boolean; error?: string }> =>
  api.delete(`/v1/sessions/${encodeURIComponent(sessionId)}`);

// -- roots (app.py:613-626) -----------------------------------------------------
export async function getRoots(sessionId: string): Promise<RootEntry[]> {
  const data = await api.get<{ roots?: RootEntry[] }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/roots`,
  );
  return data.roots ?? [];
}

export const addRoot = (
  sessionId: string,
  path: string,
  writable: boolean,
): Promise<{ ok: boolean; error?: string; roots?: RootEntry[] }> =>
  api.post(`/v1/sessions/${encodeURIComponent(sessionId)}/roots`, { path, writable });

export const removeRoot = (
  sessionId: string,
  path: string,
): Promise<{ ok: boolean; error?: string; roots?: RootEntry[] }> =>
  api.delete(`/v1/sessions/${encodeURIComponent(sessionId)}/roots`, { path });

// -- artifacts (app.py:628-641) -------------------------------------------------
export async function getArtifacts(sessionId: string): Promise<Artifact[]> {
  const data = await api.get<{ artifacts?: Artifact[] }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`,
  );
  return data.artifacts ?? [];
}

export const readArtifact = (sessionId: string, path: string): Promise<ArtifactContent> =>
  api.get<ArtifactContent>(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/read`, { path });

/** Show the artifact in the OS file manager ("reveal") or open it with its default app. */
export const revealArtifact = (
  sessionId: string,
  path: string,
  mode: "reveal" | "open" = "reveal",
): Promise<{ ok: boolean; error?: string }> =>
  api.post(`/v1/sessions/${encodeURIComponent(sessionId)}/artifacts/reveal`, { path, mode });

// -- unattended (app.py:382-391) ------------------------------------------------
export async function getUnattended(sessionId: string): Promise<boolean> {
  const data = await api.get<{ unattended: boolean }>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/unattended`,
  );
  return data.unattended;
}

export const setUnattended = (
  sessionId: string,
  unattended: boolean,
): Promise<{ ok: boolean; unattended: boolean }> =>
  api.post(`/v1/sessions/${encodeURIComponent(sessionId)}/unattended`, { unattended });

// -- per-session connections (app.py:393-418) -----------------------------------
/** `persona` = the active persona hint — required for brand-new sessions (no server-side
 * record yet), otherwise the view resolves to the default persona's defaults/recommends. */
export const getSessionConnections = (
  sessionId: string,
  persona?: string,
): Promise<SessionConnections> =>
  api.get<SessionConnections>(
    `/v1/sessions/${encodeURIComponent(sessionId)}/connections`,
    persona ? { persona } : undefined,
  );

/** Set a per-session connection override. Pass `clear: true` to drop the override and
 * inherit the persona default again. Returns the refreshed view. */
export const setSessionConnection = (
  sessionId: string,
  connector: string,
  enabled: boolean,
  options: { clear?: boolean; persona?: string } = {},
): Promise<{ ok: boolean; error?: string; connections?: SessionConnections }> =>
  api.post(`/v1/sessions/${encodeURIComponent(sessionId)}/connections`, {
    connector,
    enabled,
    ...(options.clear ? { clear: true } : {}),
    ...(options.persona ? { persona: options.persona } : {}),
  });
