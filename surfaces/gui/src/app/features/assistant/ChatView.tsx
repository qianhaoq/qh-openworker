// One open conversation: header (title + the live status line, the agent picker, the rail
// switch), the scrolling timeline with stream-following, the composer, and the right rail.
// All session IO lives in useSessionChat; this file is layout + view state.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getWorkspaceMainAgent } from "../../lib/api/agents";
import { getSettings } from "../../lib/api/settings";
import {
  getRecentWorkspaces,
  getUnattended,
  openWorkspace,
  pickFolderViaServer,
  setUnattended,
} from "../../lib/api/sessions";
import type { Attachment, RecentWorkspace, Session, Settings } from "../../lib/api/types";
import { navigate } from "../../nav";
import { Icon } from "../../components/Icon";
import { isProfileUsable } from "../agents/agentLogic";
import { AgentPicker } from "./AgentPicker";
import {
  agentChoiceLabel,
  defaultAgentChoice,
  loadAgentChoice,
  saveAgentChoice,
  type AgentChoice,
} from "./agentChoice";
import { Composer } from "./Composer";
import { RightRail } from "./RightRail";
import { sessionStatus, statusLine } from "./statusLine";
import { Timeline, type TimelineAgent } from "./TimelineView";
import { useSessionChat } from "./useSessionChat";

const SUGGESTIONS = [
  { icon: "inbox" as const, text: "看看今天有什么要处理的" },
  { icon: "file" as const, text: "帮我写个周报草稿" },
  { icon: "folder" as const, text: "整理一下最近的文件" },
];

// Tools whose success means a new/changed file should show up under 产物 right away.
const FILE_WRITE_TOOLS = new Set(["write_file", "apply_patch", "apply_unified_diff", "replace_in_file"]);

const newId = () =>
  (crypto as unknown as { randomUUID?: () => string }).randomUUID
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);

export interface ChatViewProps {
  /** The session record from the list; null = a brand-new id (server provisions on send). */
  session: Session | null;
  sessionId: string;
  railOpen: boolean;
  onToggleRail: () => void;
  /** The session list is stale (turn settled, flags changed) — refetch. */
  onSessionsChanged: () => void;
}

export function ChatView({ session, sessionId, railOpen, onToggleRail, onSessionsChanged }: ChatViewProps) {
  const agent = session?.agent || "cowork";
  const [localWorkspace, setLocalWorkspace] = useState("");
  const workspace = session?.workspace || localWorkspace;
  const isNewSession = session === null;

  // -- agent picker (内置助理 ↔ ACP workspace main ↔ a bound profile) -------------------
  // Stored per session ("assistant:agent:{id}"); absent = default (code agent → acp).
  const [storedChoice, setStoredChoice] = useState<AgentChoice | null>(() =>
    loadAgentChoice(sessionId),
  );
  useEffect(() => {
    setStoredChoice(loadAgentChoice(sessionId));
  }, [sessionId]);
  const agentChoice = storedChoice ?? defaultAgentChoice(agent);
  const selectAgent = (next: AgentChoice) => {
    setStoredChoice(next);
    saveAgentChoice(sessionId, next);
  };

  // -- settings (model list for the composer) ----------------------------------------------
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    getSettings().then(setSettings).catch(() => {});
  }, []);

  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>([]);
  useEffect(() => {
    if (!isNewSession) return;
    let stale = false;
    getRecentWorkspaces()
      .then((list) => !stale && setRecentWorkspaces(list))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [isNewSession]);

  const [mainAcpReady, setMainAcpReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (!isNewSession || agentChoice !== "acp" || !workspace.trim()) {
      setMainAcpReady(null);
      return;
    }
    let stale = false;
    getWorkspaceMainAgent(workspace)
      .then(({ profile }) => {
        if (stale) return;
        setMainAcpReady(
          profile.role === "main" &&
            profile.transport !== "embedded" &&
            isProfileUsable(profile),
        );
      })
      .catch(() => !stale && setMainAcpReady(false));
    return () => {
      stale = true;
    };
  }, [agentChoice, isNewSession, workspace]);

  const pickWorkspace = async () => {
    const picked = await pickFolderViaServer();
    if (!picked) return;
    const opened = await openWorkspace(picked).catch(() => null);
    setLocalWorkspace(opened?.ok && opened.path ? opened.path : picked);
    selectAgent("acp");
  };

  // -- the session itself -----------------------------------------------------------------
  const [turnSettledKey, setTurnSettledKey] = useState(0);
  const wantsAcp = agentChoice !== "embedded" || agent === "code";
  const embeddedBlocked =
    isNewSession && agentChoice === "embedded" && settings?.model_ready === false;
  const workspaceBlocked = isNewSession && wantsAcp && !workspace.trim();
  const mainAcpBlocked =
    isNewSession && agentChoice === "acp" && Boolean(workspace.trim()) && mainAcpReady === false;
  const mainAcpChecking =
    isNewSession && agentChoice === "acp" && Boolean(workspace.trim()) && mainAcpReady === null;
  const connectSession =
    !embeddedBlocked &&
    !workspaceBlocked &&
    !mainAcpBlocked &&
    !mainAcpChecking &&
    (!isNewSession || settings !== null);
  const chat = useSessionChat({
    sessionId,
    workspace,
    agent,
    agentChoice,
    connect: connectSession,
    onTurnSettled: useCallback(() => {
      setTurnSettledKey((k) => k + 1);
      onSessionsChanged();
    }, [onSessionsChanged]),
  });
  const { state } = chat;

  // -- unattended ---------------------------------------------------------------------------
  const [unattended, setUnattendedState] = useState(false);
  useEffect(() => {
    let stale = false;
    getUnattended(sessionId)
      .then((on) => {
        if (stale) return;
        setUnattendedState(on);
        chat.setUnattended(on);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const toggleUnattended = async (on: boolean) => {
    setUnattendedState(on);
    chat.setUnattended(on);
    await setUnattended(sessionId, on).catch(() => null);
  };

  // -- model / mode ---------------------------------------------------------------------------
  const model = state.model ?? session?.model ?? settings?.model ?? "";
  const mode = state.mode ?? session?.mode ?? "interactive";
  const changeModel = (m: string) => {
    if (state.running) return; // the server refuses mid-turn rebinds — don't let the UI lie
    chat.setModel(m);
  };

  // -- rail refresh (turn end + every finished file write) --------------------------------------
  const finishedWrites = useMemo(
    () =>
      state.items.filter(
        (i) => i.kind === "tool" && FILE_WRITE_TOOLS.has(i.name) && i.status !== "…",
      ).length,
    [state.items],
  );
  const railRefreshKey = turnSettledKey * 1000 + finishedWrites;

  // -- stream-following (auto-scroll only while the user is AT the bottom) -----------------------
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const autoScrollingRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const [following, setFollowing] = useState(true);
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollingRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  const followLatest = () => {
    atBottomRef.current = true;
    setFollowing(true);
    scrollToBottom();
  };
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const atBottom = el.scrollHeight - top - el.clientHeight < 48;
    if (autoScrollingRef.current) {
      if (atBottom) autoScrollingRef.current = false;
      else if (top >= lastScrollTopRef.current) {
        lastScrollTopRef.current = top;
        return;
      } else autoScrollingRef.current = false;
    }
    lastScrollTopRef.current = top;
    atBottomRef.current = atBottom;
    setFollowing(atBottom);
  };
  // A different session is a fresh viewport — never inherit a scrolled-up state.
  useEffect(() => {
    atBottomRef.current = true;
    setFollowing(true);
  }, [sessionId]);
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [state.items, state.streaming]);

  const send = (text: string, attachments?: Attachment[]) => {
    if (!connectSession) return;
    chat.send(text, attachments, model || undefined);
    followLatest(); // sending always re-engages stream-following
  };

  const idle = state.items.length === 0 && !state.streaming;
  // The header's live status line: bare for Q, "<agent> · …" for an ACP-served session.
  const status = sessionStatus(state);
  const acpName = agentChoice === "embedded" ? null : agentChoiceLabel(agentChoice);
  const agentDisplay: TimelineAgent =
    agentChoice === "embedded" ? { kind: "q" } : { kind: "acp", name: acpName ?? "ACP" };
  const gateMessage = embeddedBlocked
    ? "当前模型未配置。配置模型，或选择 workspace 使用 ACP。"
    : workspaceBlocked
      ? "ACP 会话需要先选择 workspace。"
      : mainAcpBlocked
        ? "该 workspace 尚未配置可用的 main ACP Agent。"
        : null;

  return (
    <div className="flex h-full min-w-0 flex-1">
      {/* 中间：会话区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 — macOS 下同时是窗口拖拽区 */}
        <div data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel/70 px-5 backdrop-blur">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13.5px] font-semibold">
              {session?.title || "新会话"}
            </div>
            <div
              className="flex items-center gap-1.5 truncate text-[11px] text-faint"
              data-testid="status-line"
            >
              <span className={`status-dot status-dot-${status}`} />
              {statusLine(state, acpName)}
            </div>
          </div>
          {/* Agent 选择（内置助理 / ACP profile） */}
          <AgentPicker choice={agentChoice} onSelect={selectAgent} />
          <button
            type="button"
            onClick={onToggleRail}
            aria-label={railOpen ? "隐藏侧面板" : "显示侧面板"}
            title={railOpen ? "隐藏侧面板" : "显示侧面板"}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${
              railOpen ? "bg-paper text-ink" : "text-muted hover:bg-paper hover:text-ink"
            }`}
          >
            <Icon name="panelRight" size={16} />
          </button>
        </div>

        {/* 时间线 */}
        <div className="hairline-scroll min-h-0 flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleScroll}>
          <div className="mx-auto max-w-3xl px-6 py-6">
            {idle ? (
              <div className="flex flex-col items-center pt-16 text-center">
                <div className="accent-grad grid h-11 w-11 place-items-center rounded-xl2 text-white shadow-sm">
                  <Icon name="brand" size={20} />
                </div>
                <h1 className="mt-4 text-[17px] font-semibold tracking-tight">有什么想让我帮忙的？</h1>
                <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
                  我是 Q，你的本地工作伙伴 — 直接说事儿就好，或从下面挑一个开始。
                </p>
                {gateMessage && (
                  <div
                    data-testid="new-session-runtime-gate"
                    className="mt-5 w-full max-w-md rounded-xl bg-warnSoft px-3.5 py-3 text-left text-[12.5px] leading-relaxed text-warnInk"
                  >
                    <div>{gateMessage}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {embeddedBlocked && (
                        <button
                          type="button"
                          onClick={() => navigate("settings")}
                          className="flex items-center gap-1 rounded-lg border border-warnInk/30 bg-panel/60 px-2.5 py-1 text-[12px] font-medium"
                        >
                          <Icon name="settings" size={13} />
                          配置模型
                        </button>
                      )}
                      {mainAcpBlocked && (
                        <button
                          type="button"
                          onClick={() => navigate("agents")}
                          className="flex items-center gap-1 rounded-lg border border-warnInk/30 bg-panel/60 px-2.5 py-1 text-[12px] font-medium"
                        >
                          <Icon name="settings" size={13} />
                          配置 main Agent
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void pickWorkspace()}
                        className="flex items-center gap-1 rounded-lg border border-warnInk/30 bg-panel/60 px-2.5 py-1 text-[12px] font-medium"
                      >
                        <Icon name="folder" size={13} />
                        选择 workspace 使用 ACP
                      </button>
                      {recentWorkspaces.slice(0, 2).map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          onClick={() => {
                            setLocalWorkspace(item.path);
                            selectAgent("acp");
                          }}
                          className="rounded-lg border border-warnInk/20 bg-panel/40 px-2.5 py-1 text-[12px]"
                        >
                          {item.name || item.path}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-6 grid w-full max-w-md gap-2">
                  {SUGGESTIONS.map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={!connectSession}
                      className="flex items-center gap-2.5 rounded-xl border border-line bg-panel px-3.5 py-2.5 text-left text-[13px] text-ink hover:border-lineStrong"
                      onClick={() => send(s.text)}
                    >
                      <Icon name={s.icon} size={14} className="shrink-0 text-faint" />
                      {s.text}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <Timeline
                agent={agentDisplay}
                items={state.items}
                running={state.running}
                compacting={state.compacting}
                streaming={state.streaming}
                reasoning={state.reasoning}
                onRetry={chat.retry}
                onApprove={chat.approve}
                onRespondPlan={chat.respondPlan}
                onRespondDirectory={chat.respondDirectory}
                onAnswerQuestion={chat.answerQuestion}
              />
            )}
          </div>
        </div>

        {/* 向上滚动后回到最新的入口 */}
        {!following && (state.running || !!state.streaming) && (
          <div className="relative z-10 h-0">
            <button
              type="button"
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-panel px-3 py-1.5 text-[12px] text-muted shadow-md hover:text-ink"
              data-testid="jump-to-latest"
              onClick={followLatest}
            >
              <Icon name="chevronDown" size={13} />
              回到最新
            </button>
          </div>
        )}

        <Composer
          running={state.running}
          connected={state.connected}
          model={model}
          models={settings?.models ?? []}
          modelLabels={settings?.model_labels}
          mode={mode}
          unattended={unattended}
          onUnattendedChange={(on) => void toggleUnattended(on)}
          onSend={send}
          onInterrupt={chat.interrupt}
          onModeChange={chat.setMode}
          onModelChange={changeModel}
          onConfigureVoiceInput={() => navigate("settings")}
          resetKey={sessionId}
        />
      </div>

      {/* 右侧面板 */}
      {railOpen && (
        <RightRail
          sessionId={sessionId}
          todo={state.todo}
          todoSeen={state.todoSeen}
          usage={state.usage}
          modelLabels={settings?.model_labels}
          refreshKey={railRefreshKey}
        />
      )}
    </div>
  );
}

export { newId };
