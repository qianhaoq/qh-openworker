// Settings (model key/models/onboarding/surfaces/pdf/compaction), model providers,
// memory, personas and web search. Routes verified against coworker/server/app.py:
// settings 1333-1404, providers 1309-1330, memory 643-658, personas 250-557, web-search
// 1297-1306.

import { api } from "./client";
import type {
  CompactionSettings,
  MemoryItem,
  MemoryScope,
  PdfSettings,
  Persona,
  PersonaConsent,
  PersonaDefaultConnection,
  PersonaDetail,
  ProviderInfo,
  Settings,
  Readiness,
  SurfaceVisibility,
  WebSearchSettings,
} from "./types";

// -- settings (app.py:1333-1404) ----------------------------------------------------
export const getSettings = (): Promise<Settings> => api.get<Settings>("/v1/settings");

export const getReadiness = (workspace?: string): Promise<Readiness> =>
  api.get<Readiness>("/v1/readiness", workspace ? { workspace } : undefined);

export const setModelKey = (
  apiKey: string,
): Promise<{ ok: boolean; error?: string; has_key?: boolean; source?: string }> =>
  api.post("/v1/settings/model-key", { api_key: apiKey });

export const setDefaultModel = (
  model: string,
): Promise<{ ok: boolean; error?: string; model?: string }> =>
  api.post("/v1/settings/default-model", { model });

export const addModel = (
  model: string,
): Promise<Settings & { ok: boolean; error?: string }> =>
  api.post("/v1/settings/models/add", { model });

export const removeModel = (model: string): Promise<Settings & { ok: boolean }> =>
  api.post("/v1/settings/models/remove", { model });

export const setOnboarded = (value: boolean): Promise<{ ok: boolean; onboarded: boolean }> =>
  api.post("/v1/settings/onboarded", { value });

export const setExperimentalConnectors = (
  value: boolean,
): Promise<{ ok: boolean; experimental_connectors?: boolean; error?: string }> =>
  api.post("/v1/settings/experimental-connectors", { value });

export const setSurfaces = (flags: {
  chat?: boolean;
  code?: boolean;
}): Promise<{ ok: boolean; surfaces: SurfaceVisibility }> =>
  api.post("/v1/settings/surfaces", flags);

export const setScratchBase = (
  path: string,
): Promise<{ ok: boolean; error?: string; scratch_base?: string }> =>
  api.post("/v1/settings/scratch-base", { path });

/** Persist the sidebar layout preference (flat ↔ grouped-by-persona). */
export const setNavLayout = (
  layout: "flat" | "grouped",
): Promise<{ ok: boolean; nav_layout?: "flat" | "grouped"; error?: string }> =>
  api.post("/v1/settings/nav-layout", { nav_layout: layout });

/** Persist how many sessions a sidebar group shows before "Show more". */
export const setSessionsPeek = (
  n: number,
): Promise<{ ok: boolean; sessions_peek?: number; error?: string }> =>
  api.post("/v1/settings/sessions-peek", { sessions_peek: n });

/** Persist whether the composer shows the context-window fill bar. */
export const setContextBar = (
  shown: boolean,
): Promise<{ ok: boolean; context_bar?: boolean; error?: string }> =>
  api.post("/v1/settings/context-bar", { context_bar: shown });

/** Persist the token-savings PDF settings (fallback mode + attach thresholds). */
export const setPdfSettings = (
  patch: Partial<PdfSettings>,
): Promise<{ ok: boolean; error?: string } & Partial<PdfSettings>> =>
  api.post("/v1/settings/pdf", patch);

/** Persist the auto-compaction overrides (threshold %, token cap, summarizer model). */
export const setCompactionSettings = (
  patch: Partial<CompactionSettings>,
): Promise<{ ok: boolean; error?: string }> => api.post("/v1/settings/compaction", patch);

// -- model providers (app.py:1309-1330) ----------------------------------------------
export const getProviders = (): Promise<ProviderInfo[]> =>
  api.get<ProviderInfo[]>("/v1/providers");

export const setProvider = (
  name: string,
  fields: Record<string, string>,
): Promise<{
  ok: boolean;
  error?: string;
  provider?: string;
  recommended_model?: string | null;
}> => api.post("/v1/providers", { name, fields });

/** Forget a provider's stored config. */
export const removeProvider = (name: string): Promise<{ ok: boolean; error?: string }> =>
  api.delete(`/v1/providers/${encodeURIComponent(name)}`);

/** Live read-only credential check (does NOT save the key). */
export const verifyProvider = (
  name: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> => api.post("/v1/providers/verify", { name, fields });

// -- memory (app.py:643-651) -----------------------------------------------------------
export async function getMemory(): Promise<MemoryItem[]> {
  const data = await api.get<{ memory?: MemoryItem[] }>("/v1/memory");
  return data.memory ?? [];
}

export const addMemory = (
  content: string,
  scope: MemoryScope = "workspace",
): Promise<MemoryItem & { ok?: boolean; error?: string }> =>
  api.post("/v1/memory", { content, scope });

// -- personas (app.py:250-252, 420-557) ------------------------------------------------
export async function getPersonas(): Promise<Persona[]> {
  const data = await api.get<{ personas?: Persona[] }>("/v1/personas");
  return data.personas ?? [];
}

/** Install from a local dir or a git URL. Returns a consent summary per persona; they
 * land disabled pending approval (then updatePersona {enabled:true, surfaced:true}). */
export const installPersona = (body: {
  dir?: string;
  git_url?: string;
}): Promise<{
  ok: boolean;
  consent?: PersonaConsent[];
  personas?: Persona[];
  error?: string;
}> => api.post("/v1/personas/install", body);

export const updatePersona = (
  id: string,
  body: { enabled?: boolean; surfaced?: boolean; default?: boolean },
): Promise<{ ok: boolean; personas?: Persona[]; archived_sessions?: number; error?: string }> =>
  api.post(`/v1/personas/${encodeURIComponent(id)}`, body);

/** Uninstall a non-builtin persona (its snapshot + state). Local; works signed out. */
export const deletePersona = (
  id: string,
): Promise<{ ok: boolean; personas?: Persona[]; error?: string }> =>
  api.delete(`/v1/personas/${encodeURIComponent(id)}`);

export const getPersonaDetail = (id: string): Promise<PersonaDetail> =>
  api.get<PersonaDetail>(`/v1/personas/${encodeURIComponent(id)}`);

/** Enable/disable the persona (disable archives its sessions server-side). */
export const setPersonaEnabled = (
  id: string,
  enabled: boolean,
): Promise<{ ok: boolean; personas?: Persona[]; error?: string }> =>
  api.post(`/v1/personas/${encodeURIComponent(id)}/enable`, { enabled });

/** Set a persona-default connection (new sessions of this persona get it on/off). */
export const setPersonaConnection = (
  id: string,
  connector: string,
  enabled: boolean,
): Promise<{ ok: boolean; default_connections?: PersonaDefaultConnection[]; error?: string }> =>
  api.post(`/v1/personas/${encodeURIComponent(id)}/connections`, { connector, enabled });

// -- web search (app.py:1297-1306) -------------------------------------------------------
export const getWebSearch = (): Promise<WebSearchSettings> =>
  api.get<WebSearchSettings>("/v1/web-search");

export const setWebSearch = (
  provider: string,
  apiKey?: string,
): Promise<{ ok: boolean; provider?: string; error?: string }> =>
  api.post("/v1/web-search", { provider, ...(apiKey ? { api_key: apiKey } : {}) });
