// The assistant page's second column: search, the new-session button, and the session
// list (pinned first, archived behind a toggle). Rows carry the attention count and the
// liveness dot; pin/archive PATCH through and ask the parent to refresh. A per-row ⋯
// menu adds 重命名 (inline title edit) and 删除 (two-step inline confirm); deleting the
// open session navigates back to the assistant home.

import { useEffect, useMemo, useState } from "react";
import { deleteSession, renameSession, setSessionFlags } from "../../lib/api/sessions";
import type { Session } from "../../lib/api/types";
import { Icon } from "../../components/Icon";
import { navigate } from "../../nav";

/** "14:32" today, "昨天" yesterday, "7月21日" this year, "2025/12/3" older. */
export function formatSessionTime(updatedAt: string | null): string {
  const ms = Date.parse(updatedAt || "") || Number(updatedAt) || 0;
  if (!ms) return "";
  const date = new Date(ms);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay)
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

const sessionTs = (s: Session): number => Date.parse(s.updated_at || "") || Number(s.updated_at) || 0;

/** Sort + filter for the list: pinned first, then most-recent; archived hidden unless asked. */
export function visibleSessions(sessions: Session[], query: string, showArchived: boolean): Session[] {
  const q = query.trim().toLowerCase();
  return sessions
    .filter((s) => s.session_id && !s.session_id.startsWith("__")) // run/ephemeral sessions stay out
    .filter((s) => (showArchived ? true : !s.archived))
    .filter(
      (s) =>
        !q ||
        (s.title || "").toLowerCase().includes(q) ||
        s.workspace.toLowerCase().includes(q) ||
        s.session_id.toLowerCase().includes(q),
    )
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || sessionTs(b) - sessionTs(a));
}

export interface SessionListPanelProps {
  sessions: Session[];
  activeId: string | null;
  onSelect: (session: Session) => void;
  onNew: () => void;
  /** Ask the parent to refetch the list (after pin/archive/rename/delete). */
  onChanged: () => void;
}

/** Row presentation: archived sessions (only listed when 显示已归档 is on) render
 *  muted and carry a small 「已归档」 tag after the timestamp. */
export function sessionRowMeta(session: Session): { muted: boolean; tag: string | null } {
  return { muted: !!session.archived, tag: session.archived ? "已归档" : null };
}

interface RowMenu {
  id: string;
  confirmingDelete: boolean;
}

export function SessionListPanel({ sessions, activeId, onSelect, onNew, onChanged }: SessionListPanelProps) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const list = useMemo(() => visibleSessions(sessions, query, showArchived), [sessions, query, showArchived]);
  const archivedCount = useMemo(
    () => sessions.filter((s) => s.archived && !s.session_id.startsWith("__")).length,
    [sessions],
  );

  // Esc closes an open row menu.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  const flag = async (session: Session, flags: { pinned?: boolean; archived?: boolean }) => {
    await setSessionFlags(session.session_id, flags).catch(() => null);
    onChanged();
  };

  const commitRename = async () => {
    if (!renaming) return;
    const { id, value } = renaming;
    setRenaming(null);
    const title = value.trim();
    const current = sessions.find((s) => s.session_id === id);
    if (!title || title === (current?.title || "")) return;
    const res = await renameSession(id, title).catch(() => null);
    if (!res || res.ok === false) {
      setRowError("重命名失败,请重试");
      return;
    }
    setRowError(null);
    onChanged();
  };

  const confirmDelete = async (session: Session) => {
    setMenu(null);
    const res = await deleteSession(session.session_id).catch(() => null);
    if (!res || res.ok === false) {
      setRowError("删除失败,请重试");
      return;
    }
    setRowError(null);
    // Deleting the conversation on screen — drop back to the assistant home.
    if (session.session_id === activeId) navigate("assistant");
    onChanged();
  };

  return (
    <div className="flex h-full w-[260px] shrink-0 flex-col border-r border-line bg-panel" data-testid="session-list-panel">
      {/* 新会话 + 搜索（顶部留白区在 macOS 下兼作窗口拖拽区） */}
      <div data-tauri-drag-region className="space-y-2 px-3 pb-2 pt-3">
        <button
          type="button"
          onClick={onNew}
          className="accent-grad flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px] font-medium text-white hover:brightness-105"
        >
          <Icon name="plus" size={14} />
          新会话
        </button>
        <div className="relative">
          <Icon
            name="search"
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            className="w-full rounded-lg border border-line bg-paper py-1.5 pl-8 pr-2.5 text-[12.5px] text-ink placeholder:text-faint focus:border-lineStrong"
          />
        </div>
        {rowError && (
          <p className="px-1 text-[11.5px] text-danger" role="alert">
            {rowError}
          </p>
        )}
      </div>

      {/* 会话列表 */}
      <div className="hairline-scroll flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {list.length === 0 && (
          <div className="px-2 py-8 text-center text-[12px] text-faint">
            {query ? "没有匹配的会话" : "还没有会话"}
          </div>
        )}
        {list.map((session) => {
          const active = session.session_id === activeId;
          const meta = sessionRowMeta(session);
          const menuOpen = menu?.id === session.session_id;
          const isRenaming = renaming?.id === session.session_id;
          return (
            <div
              key={session.session_id}
              className={`group relative rounded-lg ${
                active ? "bg-accentSoft" : "hover:bg-paper"
              } ${meta.muted ? "opacity-60" : ""}`}
            >
              {isRenaming ? (
                <div className="px-2 py-1.5">
                  <input
                    autoFocus
                    value={renaming.value}
                    data-testid="session-rename-input"
                    aria-label="会话名称"
                    onChange={(e) => setRenaming({ id: session.session_id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={() => void commitRename()}
                    className="w-full rounded-md border border-line bg-paper px-1.5 py-0.5 text-[13px] text-ink outline-none focus:border-lineStrong"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(session)}
                  aria-current={active ? "page" : undefined}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[13px] ${
                        active ? "font-medium text-accent" : session.pinned ? "font-medium" : ""
                      }`}
                    >
                      {session.pinned && <Icon name="pin" size={11} className="mr-1 inline text-faint" />}
                      {session.title || "新会话"}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-faint">
                      {formatSessionTime(session.updated_at)}
                      {session.agent === "code" ? " · ACP" : ""}
                      {meta.tag && (
                        <span className="ml-1 rounded border border-line px-1 text-[10px] text-faint">
                          {meta.tag}
                        </span>
                      )}
                    </span>
                  </span>
                  {/* 待处理 / 活跃状态 */}
                  {(session.attention ?? 0) > 0 && (
                    <span className="shrink-0 rounded-full bg-warnSoft px-1.5 text-[10.5px] font-semibold leading-[16px] text-warnInk">
                      {session.attention}
                    </span>
                  )}
                  {session.liveness === "working" && (
                    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" title="正在工作" />
                  )}
                  {session.liveness === "sleeping" && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-faint/60" title="待唤醒" />
                  )}
                </button>
              )}
              {/* hover 操作：置顶 / 归档 / 更多（重命名、删除） */}
              {!isRenaming && (
                <div
                  className={`absolute right-1.5 top-1/2 -translate-y-1/2 gap-0.5 rounded-md ${
                    active ? "bg-accentSoft" : "bg-paper"
                  } px-0.5 py-0.5 ${menuOpen ? "flex" : "hidden group-hover:flex"}`}
                >
                  <button
                    type="button"
                    title={session.pinned ? "取消置顶" : "置顶"}
                    aria-label={session.pinned ? "取消置顶" : "置顶"}
                    onClick={() => void flag(session, { pinned: !session.pinned })}
                    className={`grid h-6 w-6 place-items-center rounded ${
                      session.pinned ? "text-accent" : "text-faint hover:text-ink"
                    }`}
                  >
                    <Icon name="pin" size={13} />
                  </button>
                  <button
                    type="button"
                    title={session.archived ? "取消归档" : "归档"}
                    aria-label={session.archived ? "取消归档" : "归档"}
                    onClick={() => void flag(session, { archived: !session.archived })}
                    className="grid h-6 w-6 place-items-center rounded text-faint hover:text-ink"
                  >
                    <Icon name="archive" size={13} />
                  </button>
                  <button
                    type="button"
                    title="更多操作"
                    aria-label="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    data-testid="session-row-menu-button"
                    onClick={() =>
                      setMenu(menuOpen ? null : { id: session.session_id, confirmingDelete: false })
                    }
                    className="grid h-6 w-6 place-items-center rounded text-faint hover:text-ink"
                  >
                    <Icon name="dots" size={13} />
                  </button>
                </div>
              )}
              {menuOpen && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setMenu(null)} aria-hidden="true" />
                  <div
                    role="menu"
                    data-testid="session-row-menu"
                    className="absolute right-1.5 top-[calc(100%-4px)] z-30 w-32 rounded-lg border border-line bg-panel py-1 shadow-lg"
                  >
                    {menu?.confirmingDelete ? (
                      <div className="px-2.5 py-1.5">
                        <p className="text-[11.5px] text-muted">删除该会话？不可恢复。</p>
                        <div className="mt-1.5 flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => void confirmDelete(session)}
                            className="rounded-md bg-danger px-2 py-0.5 text-[11px] font-medium text-white hover:brightness-105"
                          >
                            确认删除
                          </button>
                          <button
                            type="button"
                            onClick={() => setMenu(null)}
                            className="rounded-md border border-line bg-panel px-2 py-0.5 text-[11px] hover:border-lineStrong"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(null);
                            setRenaming({ id: session.session_id, value: session.title || "" });
                          }}
                          className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[12px] hover:bg-paper"
                        >
                          <Icon name="pencil" size={12} className="text-faint" />
                          重命名
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => setMenu({ id: session.session_id, confirmingDelete: true })}
                          className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[12px] text-danger hover:bg-paper"
                        >
                          <Icon name="trash" size={12} />
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
        {archivedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-left text-[11.5px] text-faint hover:bg-paper hover:text-muted"
          >
            {showArchived ? "隐藏已归档" : `显示已归档（${archivedCount}）`}
          </button>
        )}
      </div>
    </div>
  );
}
