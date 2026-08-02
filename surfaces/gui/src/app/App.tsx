// The new application shell: sidebar chrome + per-route page + global event toasts.
// Pages are placeholders for now; each phase swaps one in without touching this file
// beyond the PAGES table.

import { useEffect, useState, type ComponentType } from "react";
import { connectEvents } from "./lib/ws";
import { getInbox } from "./lib/api/inbox";
import { listAgentPermissions } from "./lib/api/agents";
import { useRoute, type RouteName } from "./nav";
import { Sidebar } from "./components/Sidebar";
import { Toasts, toastForEvent, useToasts } from "./components/Toasts";
import { INBOX_CHANGED_EVENT } from "./features/inbox/inboxBadge";
import { AssistantPage } from "./features/assistant/AssistantPage";
import { AgentsPage } from "./features/agents/AgentsPage";
import { MissionsPage } from "./features/missions/MissionsPage";
import { InboxPage } from "./features/inbox/InboxPage";
import { AutomationsPage } from "./features/automations/AutomationsPage";
import { IntegrationsPage } from "./features/integrations/IntegrationsPage";
import { SettingsPage } from "./features/settings/SettingsPage";

const PAGES: Record<RouteName, ComponentType> = {
  assistant: AssistantPage,
  agents: AgentsPage,
  missions: MissionsPage,
  inbox: InboxPage,
  automations: AutomationsPage,
  integrations: IntegrationsPage,
  settings: SettingsPage,
};

// 待处理计数 = 收件箱 pending + ACP 权限请求,与收件箱页「待处理」tab 同一口径
// (那边是 pendingItems.length + permissions.length)。
const loadInboxCount = (): Promise<number> =>
  Promise.all([getInbox(undefined, "pending"), listAgentPermissions(true)]).then(
    ([items, permissions]) => items.length + permissions.length,
  );

export function App() {
  const route = useRoute();
  const [collapsed, setCollapsed] = useState(false);
  const { toasts, push, dismiss } = useToasts();
  // Pending 事项计数 → 收件箱 nav badge。Refreshes on app-wide events and on every
  // route change (answering items on any surface settles them).
  const [inboxCount, setInboxCount] = useState(0);

  // App-wide server pushes → quiet top-right toasts + an Inbox badge refresh. The badge
  // refetch is throttled: `agent_event` mirrors can be chatty while an ACP session runs.
  useEffect(() => {
    let lastFetch = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshBadge = () => {
      lastFetch = Date.now();
      loadInboxCount()
        .then(setInboxCount)
        .catch(() => {});
    };
    const throttledRefresh = () => {
      const since = Date.now() - lastFetch;
      if (since >= 2000) {
        refreshBadge();
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          refreshBadge();
        }, 2000 - since);
      }
    };
    const stop = connectEvents((event) => {
      const toast = toastForEvent(event);
      if (toast) push(toast);
      throttledRefresh();
    });
    // 收件箱页处理完事项后 dispatch 这个事件(见 features/inbox/inboxBadge.ts)—— 直接刷新,
    // 不走节流,让徽标立刻跟手。
    const onInboxChanged = () => refreshBadge();
    window.addEventListener(INBOX_CHANGED_EVENT, onInboxChanged);
    return () => {
      stop();
      window.removeEventListener(INBOX_CHANGED_EVENT, onInboxChanged);
      if (pendingTimer) clearTimeout(pendingTimer);
    };
  }, [push]);

  useEffect(() => {
    loadInboxCount()
      .then(setInboxCount)
      .catch(() => {});
  }, [route]);

  const Page = PAGES[route.name];

  return (
    <div className="flex h-screen overflow-hidden bg-paper font-sans text-ink">
      <Sidebar
        active={route.name}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        badges={{ inbox: inboxCount }}
      />
      <main className="hairline-scroll min-w-0 flex-1 overflow-y-auto">
        {/* Keyed by route name: pages re-mount (and re-enter with a 150ms fade+rise) on a
            section switch, while in-section navigation (e.g. between sessions) doesn't. */}
        <div key={route.name} className="page-enter h-full">
          <Page />
        </div>
      </main>
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
