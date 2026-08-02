// Data layer for the 消息路由 tab: channel subscriptions (session ← channel),
// recent inbound channels (the picker's source), Inbox routing bindings, and the
// DM default route. Everything refreshes together — each list is small.

import { useCallback, useEffect, useState } from "react";
import {
  getDmRoute,
  getInboxRouting,
  getRecentChannels,
  getSubscriptions,
  setDmRoute,
  setInboxBinding,
  subscribeChannel,
  unsubscribeChannel,
} from "../../lib/api/inbox";
import type { InboxBinding, RecentChannel, Subscription } from "../../lib/api/types";
import { humanizeErrorText } from "../../lib/errorText";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export function useRouting() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [recentChannels, setRecentChannels] = useState<RecentChannel[]>([]);
  const [bindings, setBindings] = useState<InboxBinding[]>([]);
  const [dmRoute, setDmRouteState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [subs, channels, binds, dm] = await Promise.all([
      getSubscriptions(),
      getRecentChannels(),
      getInboxRouting(),
      getDmRoute(),
    ]);
    setSubscriptions(subs);
    setRecentChannels(channels);
    setBindings(binds);
    setDmRouteState(dm);
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

  const run = useCallback(
    async (
      action: () => Promise<{ ok: boolean; error?: string }>,
      fallback: string,
    ): Promise<ActionResult> => {
      setActionError(null);
      try {
        const result = await action();
        if (!result.ok) {
          const error = humanizeErrorText(result.error || fallback);
          setActionError(error);
          return { ok: false, error };
        }
        await refresh();
        return { ok: true };
      } catch (error) {
        const text = humanizeErrorText(message(error));
        setActionError(text);
        return { ok: false, error: text };
      }
    },
    [refresh],
  );

  const subscribe = useCallback(
    (sessionId: string, channel: string) =>
      run(() => subscribeChannel(sessionId, channel), "订阅失败"),
    [run],
  );

  const unsubscribe = useCallback(
    (sessionId: string, channel: string) =>
      run(async () => {
        const result = await unsubscribeChannel(sessionId, channel);
        return { ok: result.ok, error: result.ok ? undefined : "取消订阅失败" };
      }, "取消订阅失败"),
    [run],
  );

  /** A binding with channel=null mirrors to the in-app Inbox only (that IS the
   * "remove transport" state — named bindings have no delete endpoint). */
  const saveBinding = useCallback(
    (name: string, channel: string | null, target: string) =>
      run(() => setInboxBinding(name, channel, target), "保存失败"),
    [run],
  );

  /** Empty session id clears the designation (DMs then park as unrouted). */
  const setDm = useCallback(
    (sessionId: string) =>
      run(async () => {
        const result = await setDmRoute(sessionId);
        return { ok: result.ok, error: result.ok ? undefined : "设置失败" };
      }, "设置失败"),
    [run],
  );

  const clearActionError = useCallback(() => setActionError(null), []);

  return {
    subscriptions,
    recentChannels,
    bindings,
    dmRoute,
    loading,
    loadError,
    actionError,
    refresh,
    subscribe,
    unsubscribe,
    saveBinding,
    setDm,
    clearActionError,
  };
}
