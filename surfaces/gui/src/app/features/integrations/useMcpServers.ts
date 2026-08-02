// Data layer for the MCP 服务器 tab: server list, add/patch/delete, the tools
// viewer, and the OAuth connect flow. `connect` starts a sidecar-driven browser
// sign-in; while any server sits in "authorizing" we poll the list so the row
// flips to connected (or surfaces last_error) on its own.

import { useCallback, useEffect, useState } from "react";
import {
  addMcpServer,
  connectMcp,
  deleteMcpServer,
  getMcpServers,
  getMcpTools,
  patchMcpServer,
  reloadMcp,
  signoutMcp,
} from "../../lib/api/connectors";
import type { McpServer, McpTool } from "../../lib/api/types";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/** Per-server tools-viewer state. */
export type ToolsState =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "loaded"; tools: McpTool[] };

export function useMcpServers() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyNames, setBusyNames] = useState<ReadonlySet<string>>(new Set());
  const [toolsByName, setToolsByName] = useState<Record<string, ToolsState>>({});

  const refresh = useCallback(async () => {
    const list = await getMcpServers();
    setServers(list);
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

  // Poll while a browser sign-in is in flight (the Slack-page rule: the status
  // flip arrives on the list, not on the connect call).
  const authorizing = servers.some((s) => s.status === "authorizing");
  useEffect(() => {
    if (!authorizing) return;
    const timer = setInterval(() => {
      refresh().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [authorizing, refresh]);

  const markBusy = (name: string, on: boolean) =>
    setBusyNames((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const run = useCallback(
    async (
      name: string,
      action: () => Promise<{ ok: boolean; error?: string }>,
      fallback: string,
    ): Promise<ActionResult> => {
      setActionError(null);
      markBusy(name, true);
      try {
        const result = await action();
        if (!result.ok) {
          const error = result.error || fallback;
          setActionError(error);
          return { ok: false, error };
        }
        await refresh();
        return { ok: true };
      } catch (error) {
        const text = message(error);
        setActionError(text);
        return { ok: false, error: text };
      } finally {
        markBusy(name, false);
      }
    },
    [refresh],
  );

  const add = useCallback(
    (name: string, config: Record<string, unknown>) =>
      run(name, () => addMcpServer(name, config), "添加失败"),
    [run],
  );

  const patch = useCallback(
    (name: string, changes: Record<string, unknown>) =>
      run(name, () => patchMcpServer(name, changes), "保存失败"),
    [run],
  );

  const remove = useCallback(
    (name: string) => run(name, () => deleteMcpServer(name), "删除失败"),
    [run],
  );

  const toggle = useCallback(
    (server: McpServer) => patch(server.name, { enabled: !server.enabled }),
    [patch],
  );

  /** Start the OAuth browser flow (or an immediate reconnect). The status flip
   * arrives on the polled list — this call only kicks it off. */
  const connect = useCallback(
    async (name: string): Promise<ActionResult> => {
      setActionError(null);
      try {
        const result = await connectMcp(name);
        if (!result.ok) {
          setActionError("无法启动连接");
          return { ok: false, error: "无法启动连接" };
        }
        // Pull once right away so the row shows 授权中… without waiting a poll tick.
        await refresh().catch(() => {});
        return { ok: true };
      } catch (error) {
        const text = message(error);
        setActionError(text);
        return { ok: false, error: text };
      }
    },
    [refresh],
  );

  const signout = useCallback(
    (name: string) => run(name, () => signoutMcp(name), "退出失败"),
    [run],
  );

  const reload = useCallback(async (): Promise<ActionResult> => {
    setActionError(null);
    try {
      const result = await reloadMcp();
      if (!result.ok) {
        const error = result.error || "重载失败";
        setActionError(error);
        return { ok: false, error };
      }
      await refresh();
      return { ok: true };
    } catch (error) {
      const text = message(error);
      setActionError(text);
      return { ok: false, error: text };
    }
  }, [refresh]);

  /** Open/close the tools viewer for one server; fetches on first open. */
  const toggleTools = useCallback(
    async (name: string) => {
      const current = toolsByName[name];
      if (current) {
        setToolsByName((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
        return;
      }
      setToolsByName((prev) => ({ ...prev, [name]: { kind: "loading" } }));
      try {
        const result = await getMcpTools(name);
        setToolsByName((prev) => ({
          ...prev,
          [name]: result.ok
            ? { kind: "loaded", tools: result.tools }
            : { kind: "error", error: result.error || "连接失败" },
        }));
      } catch (error) {
        setToolsByName((prev) => ({ ...prev, [name]: { kind: "error", error: message(error) } }));
      }
    },
    [toolsByName],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return {
    servers,
    loading,
    loadError,
    actionError,
    busyNames,
    toolsByName,
    refresh,
    add,
    patch,
    remove,
    toggle,
    connect,
    signout,
    reload,
    toggleTools,
    clearActionError,
  };
}
