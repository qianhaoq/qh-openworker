// Data layer for the 连接器 tab: the connector list plus Slack/GitHub relay health,
// and every mutation the detail views ride on. Connect flows come in two shapes —
// manual token fields (connectConnector) and MCP-backed one-click (connectMcpBacked,
// which runs the OAuth flow in the sidecar-opened browser while we poll the list
// until the card flips to connected).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectConnector,
  connectMcpBacked,
  disconnectConnector,
  disconnectAccount,
  disconnectGcalAccount,
  disconnectGithubInstallation,
  disconnectGmailAccount,
  disconnectHubSpotPortal,
  disconnectSlackWorkspace,
  getConnectors,
  getGithubStatus,
  getSlackStatus,
  setDefaultAccount,
  setGcalDefaultAccount,
  setGmailDefaultAccount,
  setGmailFilters,
  setHubSpotDefaultPortal,
  setHubSpotHiddenFields,
  updateConnectorTools,
} from "../../lib/api/connectors";
import type { Connector, GithubStatus, SlackStatus } from "../../lib/api/types";
import { humanizeErrorText } from "../../lib/errorText";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** How long we keep polling after an MCP-backed connect starts (the browser flow can
 * take a while; the sidecar's own callback deadline is the real bound). */
const CONNECT_POLL_MS = 3 * 60 * 1000;

export function useConnectors() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Names with an MCP-backed browser connect in flight (poll until connected). */
  const [pendingConnects, setPendingConnects] = useState<ReadonlySet<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollDeadlineRef = useRef(0);

  const refresh = useCallback(async () => {
    const list = await getConnectors();
    setConnectors(list);
    const names = new Set(list.map((c) => c.name));
    // Relay health only matters for a connected managed connector — skip the calls
    // (and their noise) otherwise.
    if (names.has("slack") && list.find((c) => c.name === "slack")?.connected) {
      getSlackStatus().then(setSlackStatus).catch(() => setSlackStatus(null));
    }
    if (names.has("github") && list.find((c) => c.name === "github")?.connected) {
      getGithubStatus().then(setGithubStatus).catch(() => setGithubStatus(null));
    }
    return list;
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

  // The connect poll: while any name is pending, refetch until it flips to
  // connected (or the deadline passes). One interval for all pending names.
  useEffect(() => {
    if (pendingConnects.size === 0) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    if (pollRef.current) return; // already ticking
    pollRef.current = setInterval(() => {
      if (Date.now() > pollDeadlineRef.current) {
        setPendingConnects(new Set());
        return;
      }
      refresh()
        .then((list) => {
          setPendingConnects((current) => {
            const next = new Set(current);
            for (const name of current) {
              if (list.find((c) => c.name === name)?.connected) next.delete(name);
            }
            return next;
          });
        })
        .catch(() => {});
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [pendingConnects.size, refresh]);

  /** Shared mutation wrapper: error capture + refresh on success. `report: "local"`
   * keeps the failure out of the page-level banner — the caller (the connect sheet)
   * already shows it inline, and a page alert would double-report it (and linger,
   * context-free, after the sheet closes). */
  const run = useCallback(
    async (
      action: () => Promise<{ ok: boolean; error?: string }>,
      report: "page" | "local" = "page",
    ): Promise<ActionResult> => {
      setActionError(null);
      try {
        const result = await action();
        if (!result.ok) {
          const error = humanizeErrorText(result.error || "操作失败");
          if (report === "page") setActionError(error);
          return { ok: false, error };
        }
        await refresh();
        return { ok: true };
      } catch (error) {
        const text = humanizeErrorText(message(error));
        if (report === "page") setActionError(text);
        return { ok: false, error: text };
      }
    },
    [refresh],
  );

  const connectFields = useCallback(
    (name: string, fields: Record<string, string>, acknowledgeRisk = false) =>
      run(() => connectConnector(name, fields, { acknowledgeRisk }), "local"),
    [run],
  );

  /** MCP-backed one-click: the sidecar opens the vendor sign-in in the system
   * browser; we poll the list until the connector flips to connected. Failures stay
   * sheet-local (the sheet shows them next to its connect button). */
  const startMcpConnect = useCallback(
    async (name: string): Promise<ActionResult> => {
      setActionError(null);
      try {
        const result = await connectMcpBacked(name);
        if (!result.ok) {
          return { ok: false, error: humanizeErrorText(result.error || "无法启动连接") };
        }
        pollDeadlineRef.current = Date.now() + CONNECT_POLL_MS;
        setPendingConnects((current) => new Set(current).add(name));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: humanizeErrorText(message(error)) };
      }
    },
    [],
  );

  const disconnect = useCallback((name: string) => run(() => disconnectConnector(name)), [run]);

  /** Per-account disconnect / set-default, keyed by connector kind. */
  const disconnectEntry = useCallback(
    (connector: string, id: string): Promise<ActionResult> => {
      switch (connector) {
        case "slack":
          return run(() => disconnectSlackWorkspace(id));
        case "github":
          return run(() => disconnectGithubInstallation(id));
        case "gmail":
          return run(() => disconnectGmailAccount(id));
        case "google_calendar":
          return run(() => disconnectGcalAccount(id));
        case "hubspot":
          return run(() => disconnectHubSpotPortal(id));
        default:
          return run(() => disconnectAccount(connector, id));
      }
    },
    [run],
  );

  const setDefaultEntry = useCallback(
    (connector: string, id: string): Promise<ActionResult> => {
      switch (connector) {
        case "gmail":
          return run(() => setGmailDefaultAccount(id));
        case "google_calendar":
          return run(() => setGcalDefaultAccount(id));
        case "hubspot":
          return run(() => setHubSpotDefaultPortal(id));
        default:
          return run(() => setDefaultAccount(connector, id));
      }
    },
    [run],
  );

  const saveGmailFilters = useCallback(
    (filters: { senders?: string[]; labels?: string[] }) => run(() => setGmailFilters(filters)),
    [run],
  );

  const saveHubSpotHiddenFields = useCallback(
    (fields: string[]) => run(() => setHubSpotHiddenFields(fields)),
    [run],
  );

  const toggleTool = useCallback(
    (connector: string, tool: string, enabled: boolean) =>
      run(() => updateConnectorTools(connector, { [tool]: enabled })),
    [run],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return {
    connectors,
    slackStatus,
    githubStatus,
    loading,
    loadError,
    actionError,
    pendingConnects,
    refresh,
    connectFields,
    startMcpConnect,
    disconnect,
    disconnectEntry,
    setDefaultEntry,
    saveGmailFilters,
    saveHubSpotHiddenFields,
    toggleTool,
    clearActionError,
  };
}
