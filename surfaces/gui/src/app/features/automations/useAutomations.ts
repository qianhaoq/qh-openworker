// Data layer for the Automations page: the task list (quiet 5s poll so 下次运行 /
// 最近状态 stay fresh), the create/update/toggle/delete mutations, the expandable
// per-automation run history (3s poll while any run is live), and 立即运行 — which
// prepares a live manual run server-side, then drives its session over the normal
// session WS (send the opening prompt, finalize the run when the first turn ends).
// The server broadcasts session events to every socket on the session, so the driver
// socket coexists with the assistant page's own view of the run.

import { useCallback, useEffect, useState } from "react";
import {
  createAutomation,
  deleteAutomation,
  finalizeAutomationRun,
  getAutomation,
  getAutomations,
  markAutomationSeen,
  runAutomation,
  updateAutomation,
} from "../../lib/api/automations";
import type { Automation, AutomationRun, PreparedRun } from "../../lib/api/types";
import { SessionSocket } from "../../lib/ws";
import { navigate } from "../../nav";
import { isRunActive, type AutomationDraft } from "./automationLogic";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const LIST_POLL_MS = 5000;
const RUNS_POLL_MS = 3000;

// ---------------------------------------------------------------------------
// 立即运行 driver — module-level on purpose: it must survive page navigation (the
// user is taken to the run's live session while the first turn is still going).
// ---------------------------------------------------------------------------

const drivers = new Map<string, SessionSocket>(); // keyed by run_id

function drivePreparedRun(taskId: string, prepared: PreparedRun): void {
  if (drivers.has(prepared.run_id)) return;
  const socket = new SessionSocket(prepared.session_id, prepared.workspace, prepared.agent, {
    onOpen: () => socket.userMessage(prepared.prompt),
    onEvent: (event) => {
      // turn_done fires even for errored/interrupted turns (server `finally`) — the run
      // produced its first answer either way, so finalize marks it complete.
      if (event.type !== "turn_done") return;
      finalizeAutomationRun(taskId, prepared.run_id).catch(() => {});
      socket.close();
      drivers.delete(prepared.run_id);
    },
    onClose: (willReconnect) => {
      if (!willReconnect) drivers.delete(prepared.run_id);
    },
  });
  drivers.set(prepared.run_id, socket);
}

// ---------------------------------------------------------------------------

export function useAutomations() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Toggle/save/delete/run-now per id.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  // Expanded run history (one automation at a time).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setAutomations(await getAutomations());
  }, []);

  // Initial load + the quiet list poll.
  useEffect(() => {
    let stale = false;
    const load = () =>
      refresh()
        .then(() => !stale && setLoadError(null))
        .catch((error: unknown) => !stale && setLoadError(message(error)));
    setLoading(true);
    load().finally(() => !stale && setLoading(false));
    const timer = setInterval(() => void load(), LIST_POLL_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const markBusy = (id: string, on: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const setEnabled = useCallback(
    async (automation: Automation, enabled: boolean): Promise<ActionResult> => {
      markBusy(automation.id, true);
      try {
        const result = await updateAutomation(automation.id, { enabled });
        if (!result.ok) return { ok: false, error: result.error || "更新失败" };
        await refresh();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        markBusy(automation.id, false);
      }
    },
    [refresh],
  );

  const create = useCallback(
    async (draft: AutomationDraft): Promise<ActionResult> => {
      markBusy("*", true);
      try {
        const result = await createAutomation({
          title: draft.title.trim(),
          instructions: draft.instructions.trim(),
          cron: draft.cron.trim(),
        });
        if (!result.ok) return { ok: false, error: result.error || "创建失败" };
        await refresh();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        markBusy("*", false);
      }
    },
    [refresh],
  );

  const update = useCallback(
    async (automation: Automation, draft: AutomationDraft): Promise<ActionResult> => {
      markBusy(automation.id, true);
      try {
        const changes: Record<string, unknown> = {
          title: draft.title.trim(),
          instructions: draft.instructions.trim(),
          enabled: draft.enabled,
        };
        // A blank cron means "leave the schedule alone" (one-time tasks have none to
        // edit); the backend rejects empty/invalid crons outright.
        if (draft.cron.trim()) changes.cron = draft.cron.trim();
        const result = await updateAutomation(automation.id, changes);
        if (!result.ok) return { ok: false, error: result.error || "保存失败" };
        await refresh();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        markBusy(automation.id, false);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (automationId: string): Promise<ActionResult> => {
      markBusy(automationId, true);
      try {
        const result = await deleteAutomation(automationId);
        if (!result.ok) return { ok: false, error: result.error || "删除失败" };
        setExpandedId((current) => (current === automationId ? null : current));
        await refresh();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: message(error) };
      } finally {
        markBusy(automationId, false);
      }
    },
    [refresh],
  );

  /** POST /run, drive the prepared session, then take the user to it (live view). */
  const runNow = useCallback(async (automation: Automation): Promise<ActionResult> => {
    markBusy(automation.id, true);
    try {
      const prepared = await runAutomation(automation.id);
      if (!prepared.ok) return { ok: false, error: prepared.error || "启动失败" };
      drivePreparedRun(automation.id, prepared);
      navigate(`assistant/${encodeURIComponent(prepared.session_id)}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: message(error) };
    } finally {
      markBusy(automation.id, false);
    }
  }, []);

  const loadRuns = useCallback(async (automationId: string) => {
    const data = await getAutomation(automationId);
    setRuns(data.runs ?? []);
  }, []);

  /** Expand/collapse the run history. Expanding IS reading it: the seen mark advances
   * (clearing the unseen pill) and the list refetches so the pill disappears. */
  const toggleRuns = useCallback(
    (automation: Automation) => {
      if (expandedId === automation.id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(automation.id);
      setRuns([]);
      setRunsLoading(true);
      loadRuns(automation.id)
        .catch(() => {})
        .finally(() => setRunsLoading(false));
      markAutomationSeen(automation.id)
        .then(() => refresh())
        .catch(() => {});
    },
    [expandedId, loadRuns, refresh],
  );

  // Poll the expanded automation's runs while any of them is live; stops on collapse
  // or once every run is terminal.
  const anyActive = expandedId !== null && runs.some(isRunActive);
  useEffect(() => {
    if (!anyActive || !expandedId) return;
    const timer = setInterval(() => loadRuns(expandedId).catch(() => {}), RUNS_POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, expandedId, loadRuns]);

  return {
    automations,
    loading,
    loadError,
    busyIds,
    expandedId,
    runs,
    runsLoading,
    refresh,
    setEnabled,
    create,
    update,
    remove,
    runNow,
    toggleRuns,
  };
}
