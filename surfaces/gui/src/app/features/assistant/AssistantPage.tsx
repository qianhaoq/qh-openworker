// The assistant surface: session list (260px) + the open conversation + the toggleable
// right rail — or, with no session selected, the 伙伴桌面 home (features/home). Owns the
// session list (polled so attention/liveness badges stay live), the route-driven
// selection, and new-session creation.

import { useCallback, useEffect, useState } from "react";
import { getSessions } from "../../lib/api/sessions";
import type { Session } from "../../lib/api/types";
import { navigate, useRoute } from "../../nav";
import { HomePage } from "../home/HomePage";
import { ChatView, newId } from "./ChatView";
import { SessionListPanel } from "./SessionListPanel";
import { useAutoCloseBelow } from "./useAutoCloseBelow";

export function AssistantPage() {
  const route = useRoute();
  const sessionId = route.params.sessionId ?? null;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [railOpen, setRailOpen] = useState(true);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // At min window width the rail would crush the chat column — close it once when
  // crossing below the threshold. Never auto-reopens; the manual toggle is untouched.
  useAutoCloseBelow(
    "(max-width: 1150px)",
    useCallback(() => setRailOpen(false), []),
  );

  // Poll so the attention/liveness badges stay live and sessions created out-of-band
  // (unattended work, messaging, automations) appear without a manual refresh.
  useEffect(() => {
    let stale = false;
    const load = () =>
      getSessions()
        .then((list) => !stale && setSessions(list))
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [refreshKey]);

  // Clicking an artifact chip anywhere must land somewhere visible — un-hide the rail.
  useEffect(() => {
    const show = () => setRailOpen(true);
    window.addEventListener("ocw-open-artifact", show);
    return () => window.removeEventListener("ocw-open-artifact", show);
  }, []);

  const active = sessionId ? sessions.find((s) => s.session_id === sessionId) ?? null : null;

  const startNew = () => navigate(`assistant/${newId()}`);
  const select = (session: Session) => navigate(`assistant/${session.session_id}`);

  return (
    <div className="flex h-full">
      <SessionListPanel
        sessions={sessions}
        activeId={sessionId}
        onSelect={select}
        onNew={startNew}
        onChanged={refresh}
      />
      {sessionId ? (
        <ChatView
          key={sessionId}
          session={active}
          sessionId={sessionId}
          railOpen={railOpen}
          onToggleRail={() => setRailOpen((v) => !v)}
          onSessionsChanged={refresh}
        />
      ) : (
        <HomePage sessions={sessions} onNew={startNew} />
      )}
    </div>
  );
}
