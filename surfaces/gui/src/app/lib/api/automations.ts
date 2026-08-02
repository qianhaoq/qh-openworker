// Automations (scheduled tasks). Routes verified against coworker/server/app.py:1681-1712.

import { api } from "./client";
import type { Automation, AutomationCreateInput, AutomationRun, PreparedRun } from "./types";

export async function getAutomations(): Promise<Automation[]> {
  const data = await api.get<{ tasks?: Automation[] }>("/v1/automations");
  return data.tasks ?? [];
}

export const createAutomation = (
  payload: AutomationCreateInput,
): Promise<{ ok: boolean; error?: string; task?: Automation }> =>
  api.post("/v1/automations", payload);

export const getAutomation = (
  id: string,
): Promise<{ task: Automation; runs: AutomationRun[] }> =>
  api.get(`/v1/automations/${encodeURIComponent(id)}`);

export const updateAutomation = (
  id: string,
  changes: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; task?: Automation }> =>
  api.patch(`/v1/automations/${encodeURIComponent(id)}`, changes);

export const deleteAutomation = (id: string): Promise<{ ok: boolean; error?: string }> =>
  api.delete(`/v1/automations/${encodeURIComponent(id)}`);

/** Advance the automation's seen mark — clears its unseen-runs badge. */
export const markAutomationSeen = (id: string): Promise<{ ok: boolean }> =>
  api.post(`/v1/automations/${encodeURIComponent(id)}/seen`);

/** Prepare a live manual run: returns the session to open + the opening prompt to send. */
export const runAutomation = (id: string): Promise<PreparedRun> =>
  api.post(`/v1/automations/${encodeURIComponent(id)}/run`);

/** Mark a manual run complete after its first turn finished. */
export const finalizeAutomationRun = (
  id: string,
  runId: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.post(
    `/v1/automations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/finalize`,
  );
