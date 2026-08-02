// Data layer for the mission list page: initial REST load, a quiet 3s poll while any
// mission is still live (stopped once everything is terminal), and the create action
// (the detail page it navigates to takes over live updates from there).

import { useCallback, useEffect, useState } from "react";
import { createMission, listMissions } from "../../lib/api/missions";
import type { Mission } from "../../lib/api/types";
import { isMissionTerminal } from "./missionLogic";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const POLL_MS = 3000;

export function useMissions() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setMissions(await listMissions());
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

  // Quiet poll while anything is non-terminal; the interval re-arms only when the
  // "still live" answer flips, and stops for good once every mission is terminal.
  const anyLive = missions.some((mission) => !isMissionTerminal(mission.state));
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => refresh().catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [anyLive, refresh]);

  /** POST the goal and hand the created mission back so the page can navigate. */
  const create = useCallback(async (goal: string, workspace: string): Promise<Mission> => {
    setCreating(true);
    try {
      const trimmed = goal.trim();
      const mission = await createMission({
        goal: trimmed,
        title: trimmed.slice(0, 80),
        workspace: workspace.trim(),
      });
      setMissions((current) => [
        mission,
        ...current.filter((item) => item.mission_id !== mission.mission_id),
      ]);
      return mission;
    } finally {
      setCreating(false);
    }
  }, []);

  return { missions, loading, loadError, creating, refresh, create };
}
