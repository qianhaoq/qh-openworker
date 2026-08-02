// 收件箱数据层:pending / resolved 两个列表 + ACP 权限请求,以及 resolve 动作。
// 刷新时机:挂载、窗口重新聚焦、/ws/events 推送(2s 节流 —— agent_event 很吵,与
// App.tsx 的徽标刷新同一节奏)。resolve 走乐观更新:条目立刻移入「已处理」,失败时
// 全量刷新回滚并挂出错误横幅;ok=false 表示已在其它端处理(first-responder-wins),
// 静默对齐即可,不算错误。

import { useCallback, useEffect, useState } from "react";
import { listAgentPermissions, resolveAgentPermission } from "../../lib/api/agents";
import { getInbox, resolveInboxItem } from "../../lib/api/inbox";
import type { AgentPermission, InboxItem } from "../../lib/api/types";
import { connectEvents } from "../../lib/ws";
import { refreshInboxBadge } from "./inboxBadge";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const EVENT_THROTTLE_MS = 2000;

export function useInbox() {
  const [pending, setPending] = useState<InboxItem[]>([]);
  const [resolved, setResolved] = useState<InboxItem[]>([]);
  const [permissions, setPermissions] = useState<AgentPermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 正在 resolve 的条目 id(卡片按钮据此禁用,防双击)。
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    const [pendingItems, resolvedItems, permissionItems] = await Promise.all([
      getInbox(undefined, "pending"),
      getInbox(undefined, "resolved"),
      listAgentPermissions(true),
    ]);
    setPending(pendingItems);
    setResolved(resolvedItems);
    setPermissions(permissionItems);
  }, []);

  // 首次加载。
  useEffect(() => {
    let stale = false;
    refresh()
      .catch((error) => !stale && setLoadError(message(error)))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [refresh]);

  // 窗口重新聚焦时对齐(用户可能刚在 Slack 镜像里处理过)。
  useEffect(() => {
    const onFocus = () => void refresh().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // /ws/events:任何推送都可能改变收件箱(新审批、ACP 权限、会话删除自动关闭……),
  // 节流后全量刷新。
  useEffect(() => {
    let lastFetch = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      lastFetch = Date.now();
      void refresh().catch(() => {});
    };
    const throttled = () => {
      const since = Date.now() - lastFetch;
      if (since >= EVENT_THROTTLE_MS) {
        fire();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          fire();
        }, EVENT_THROTTLE_MS - since);
      }
    };
    const stop = connectEvents(throttled);
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const markBusy = (id: string, on: boolean) =>
    setBusyIds((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** 处理一个收件箱条目:乐观移入「已处理」,失败回滚 + 横幅。 */
  const resolve = useCallback(
    async (item: InboxItem, resolution: string) => {
      setActionError(null);
      markBusy(item.id, true);
      const optimistic: InboxItem = {
        ...item,
        state: "resolved",
        resolution,
        resolved_at: new Date().toISOString(),
      };
      setPending((current) => current.filter((entry) => entry.id !== item.id));
      setResolved((current) => [optimistic, ...current]);
      try {
        await resolveInboxItem(item.id, resolution);
      } catch (error) {
        setActionError(message(error));
      } finally {
        markBusy(item.id, false);
        // 不管成功失败都对齐一次服务端:成功则确认落库;失败则回滚乐观更新;
        // ok=false(别处已处理)也在这里被静默吸收。
        await refresh().catch(() => {});
        refreshInboxBadge();
      }
    },
    [refresh],
  );

  /** 处理一个 ACP 权限请求:optionId 为 null 表示拒绝。乐观移除,失败回滚。 */
  const resolvePermission = useCallback(
    async (permissionId: string, optionId: string | null) => {
      setActionError(null);
      markBusy(permissionId, true);
      setPermissions((current) =>
        current.filter((entry) => entry.permission_id !== permissionId),
      );
      try {
        await resolveAgentPermission(permissionId, optionId);
      } catch (error) {
        setActionError(message(error));
      } finally {
        markBusy(permissionId, false);
        await refresh().catch(() => {});
        // 徽标把 ACP 权限也计入待处理(见 App.tsx 的 loadInboxCount),处理完立刻对齐。
        refreshInboxBadge();
      }
    },
    [refresh],
  );

  const dismissActionError = useCallback(() => setActionError(null), []);

  return {
    pending,
    resolved,
    permissions,
    loading,
    loadError,
    actionError,
    busyIds,
    refresh,
    resolve,
    resolvePermission,
    dismissActionError,
  };
}
