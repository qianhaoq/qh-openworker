// Data layer for the Agents page: the profile list + workspace main, and the
// save/probe/enable/delete/set-main actions. Probe is slow (it spawns the runtime),
// so its state is tracked per profile id; every mutation ends with a refresh.

import { useCallback, useEffect, useState } from "react";
import {
  activateAgentProfile,
  deleteAgentProfile,
  getWorkspaceMainAgent,
  listAgentProfiles,
  probeAgentProfile,
  setWorkspaceMainAgent,
  upsertAgentProfile,
} from "../../lib/api/agents";
import type { AgentCapabilities, AgentProfile } from "../../lib/api/types";
import { humanizeErrorText } from "../../lib/errorText";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ActionResult {
  ok: boolean;
  error?: string;
  capabilities?: AgentCapabilities;
}

export function useAgentProfiles() {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [mainProfileId, setMainProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [probingIds, setProbingIds] = useState<ReadonlySet<string>>(new Set());
  const [probeErrors, setProbeErrors] = useState<Record<string, string>>({});
  // Save/toggle/delete/set-main per id ("*" while the initial list loads).
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    const [list, main] = await Promise.all([
      listAgentProfiles(),
      // 404s here mean "no default main profile yet" — not an error worth surfacing.
      getWorkspaceMainAgent().catch(() => null),
    ]);
    setProfiles(list);
    setMainProfileId(main?.main_profile_id ?? null);
  }, []);

  useEffect(() => {
    let stale = false;
    refresh()
      .catch((error) => !stale && setLoadError(message(error)))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [refresh]);

  const markBusy = (id: string, on: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = useCallback(
    async (profile: AgentProfile): Promise<ActionResult> => {
      markBusy(profile.id, true);
      try {
        const result = await upsertAgentProfile(profile);
        if (!result.ok) return { ok: false, error: result.error || "保存失败" };
        await refresh();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        markBusy(profile.id, false);
      }
    },
    [refresh],
  );

  const probe = useCallback(
    async (profileId: string): Promise<ActionResult> => {
      setProbingIds((current) => new Set(current).add(profileId));
      setProbeErrors((current) => {
        const next = { ...current };
        delete next[profileId];
        return next;
      });
      try {
        const result = await probeAgentProfile(profileId);
        if (!result.ok) {
          // Backend probe errors are English ("agent command not found on PATH: …") —
          // localize the known shapes, pass the rest through.
          const error = humanizeErrorText(result.error || "探测失败");
          setProbeErrors((current) => ({ ...current, [profileId]: error }));
          return { ok: false, error };
        }
        await refresh();
        return { ok: true, capabilities: result.capabilities };
      } catch (error) {
        const text = humanizeErrorText(message(error));
        setProbeErrors((current) => ({ ...current, [profileId]: text }));
        return { ok: false, error: text };
      } finally {
        setProbingIds((current) => {
          const next = new Set(current);
          next.delete(profileId);
          return next;
        });
      }
    },
    [refresh],
  );

  const activate = useCallback(
    async (profileId: string): Promise<ActionResult> => {
      setProbingIds((current) => new Set(current).add(profileId));
      setProbeErrors((current) => {
        const next = { ...current };
        delete next[profileId];
        return next;
      });
      markBusy(profileId, true);
      try {
        const result = await activateAgentProfile(profileId);
        if (!result.ok) {
          const error = humanizeErrorText(result.error || "激活失败");
          setProbeErrors((current) => ({ ...current, [profileId]: error }));
          return { ok: false, error };
        }
        await refresh();
        return { ok: true, capabilities: result.capabilities };
      } catch (error) {
        const text = humanizeErrorText(message(error));
        setProbeErrors((current) => ({ ...current, [profileId]: text }));
        return { ok: false, error: text };
      } finally {
        setProbingIds((current) => {
          const next = new Set(current);
          next.delete(profileId);
          return next;
        });
        markBusy(profileId, false);
      }
    },
    [refresh],
  );

  const setEnabled = useCallback(
    async (profile: AgentProfile, enabled: boolean): Promise<ActionResult> => {
      markBusy(profile.id, true);
      try {
        const result = await upsertAgentProfile({ ...profile, enabled });
        if (!result.ok) return { ok: false, error: result.error || "更新失败" };
        await refresh();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        markBusy(profile.id, false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (profileId: string): Promise<ActionResult> => {
      markBusy(profileId, true);
      try {
        const result = await deleteAgentProfile(profileId);
        if (!result.ok) return { ok: false, error: result.error || "删除失败" };
        await refresh();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        markBusy(profileId, false);
      }
    },
    [refresh],
  );

  const setMain = useCallback(
    async (profileId: string): Promise<ActionResult> => {
      markBusy(profileId, true);
      try {
        const result = await setWorkspaceMainAgent(null, profileId);
        if (!result.ok) return { ok: false, error: result.error || "设置失败" };
        await refresh();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        markBusy(profileId, false);
      }
    },
    [refresh],
  );

  return {
    profiles,
    mainProfileId,
    loading,
    loadError,
    probingIds,
    probeErrors,
    busyIds,
    refresh,
    save,
    probe,
    activate,
    setEnabled,
    remove,
    setMain,
  };
}
