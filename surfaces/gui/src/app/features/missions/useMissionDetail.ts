// Data layer for the mission detail page: initial REST load, live ledger events over
// the cursor-resumable WS (connectMissionEvents resumes from last_cursor on every
// reconnect), a debounced REST refresh after each event so state/attempts/artifacts
// converge to the server projection, and a quiet 3s poll while the mission is live.
// All mutations (plan patch, confirm, message, cancel) re-read the mission afterwards.

import { useCallback, useEffect, useRef, useState } from "react";
import { listAgentProfiles } from "../../lib/api/agents";
import {
  cancelMission,
  confirmMission,
  getMission,
  messageMission,
  updateMissionPlan,
} from "../../lib/api/missions";
import type {
  AgentProfile,
  MessageTarget,
  Mission,
  MissionEvent,
  MissionPlan,
} from "../../lib/api/types";
import { connectMissionEvents } from "../../lib/ws";
import { humanizeErrorText } from "../../lib/errorText";
import { isMissionTerminal } from "./missionLogic";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const POLL_MS = 3000;
/** Burst collapse: a turn emits several ledger rows; one reload follows them all. */
const RELOAD_DEBOUNCE_MS = 40;

export type MissionConnection = "connecting" | "connected" | "disconnected";

export function useMissionDetail(missionId: string) {
  const [mission, setMission] = useState<Mission | null>(null);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  // Distinguishes "profiles loaded and empty" from "profile list unavailable" — the
  // confirm-plan gate only applies once we actually know the profiles.
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connection, setConnection] = useState<MissionConnection>("connecting");
  const [mutating, setMutating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Dedupe set for WS-appended events; re-seeded from the authoritative timeline on
  // every REST reload so a reconnect replay never doubles rows.
  const seenRef = useRef<Set<string>>(new Set());

  const applyMission = useCallback((next: Mission) => {
    setMission(next);
    seenRef.current = new Set(next.timeline.map((event) => event.event_id));
    setEvents(next.timeline.map((event) => ({ ...event, cursor: event.event_id })));
  }, []);

  const reload = useCallback(async () => {
    applyMission(await getMission(missionId));
  }, [applyMission, missionId]);

  // Initial load + the ledger stream. The stream starts only after the first read so
  // the resume cursor (last_cursor) skips the history the timeline already shows.
  useEffect(() => {
    let disposed = false;
    let handle: { close(): void } | null = null;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        reload().catch(() => {});
      }, RELOAD_DEBOUNCE_MS);
    };

    setLoading(true);
    setLoadError(null);
    setConnection("connecting");
    (async () => {
      try {
        const [first, profileList] = await Promise.all([
          getMission(missionId),
          // null = the profile list is unavailable; the confirm gate stays open then
          // (the backend's 409 is the fallback, mapped to Chinese in runAction).
          listAgentProfiles().catch(() => null as AgentProfile[] | null),
        ]);
        if (disposed) return;
        applyMission(first);
        setProfiles(profileList ?? []);
        setProfilesLoaded(profileList !== null);
        setLoading(false);
        handle = connectMissionEvents(missionId, first.last_cursor, {
          onOpen: () => setConnection("connected"),
          onClose: () => !disposed && setConnection("disconnected"),
          onError: () => !disposed && setConnection("disconnected"),
          onEvent: (event) => {
            // Snapshots and pongs carry no ledger row — just re-read the projection.
            if (event.event_type === "mission.snapshot") {
              scheduleReload();
              return;
            }
            const id = event.event_id || String(event.cursor ?? "");
            if (id && !seenRef.current.has(id)) {
              seenRef.current.add(id);
              setEvents((current) => [...current, event]);
            }
            scheduleReload();
          },
        });
      } catch (error) {
        if (disposed) return;
        setLoadError(message(error));
        setLoading(false);
      }
    })();

    return () => {
      disposed = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      handle?.close();
    };
  }, [applyMission, missionId, reload]);

  // Fallback poll while the mission is live (a dropped WS reconnects on its own, but
  // this also covers servers without the stream). Stops when the mission is terminal.
  const live = mission !== null && !isMissionTerminal(mission.state);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => reload().catch(() => {}), POLL_MS);
    return () => clearInterval(timer);
  }, [live, reload]);

  const runAction = useCallback(async (operation: () => Promise<void>): Promise<boolean> => {
    setMutating(true);
    setActionError(null);
    try {
      await operation();
      return true;
    } catch (error) {
      setActionError(humanizeErrorText(message(error)));
      return false;
    } finally {
      setMutating(false);
    }
  }, []);

  const savePlan = useCallback(
    (plan: MissionPlan) =>
      runAction(async () => {
        applyMission(await updateMissionPlan(missionId, plan));
      }),
    [applyMission, missionId, runAction],
  );

  const confirm = useCallback(
    () =>
      runAction(async () => {
        const key = globalThis.crypto?.randomUUID?.() ?? `confirm-${Date.now()}`;
        applyMission(await confirmMission(missionId, key));
      }),
    [applyMission, missionId, runAction],
  );

  const send = useCallback(
    (text: string, target: MessageTarget = { kind: "main" }) =>
      runAction(async () => {
        const result = await messageMission(missionId, text, target);
        if (result.ok === false) throw new Error(result.error || "消息发送失败");
        await reload();
      }),
    [missionId, reload, runAction],
  );

  const cancel = useCallback(
    () =>
      runAction(async () => {
        applyMission(await cancelMission(missionId));
      }),
    [applyMission, missionId, runAction],
  );

  return {
    mission,
    events,
    profiles,
    profilesLoaded,
    loading,
    loadError,
    connection,
    mutating,
    actionError,
    clearActionError: () => setActionError(null),
    reload,
    savePlan,
    confirm,
    send,
    cancel,
  };
}
