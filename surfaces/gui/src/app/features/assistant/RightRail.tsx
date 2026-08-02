// The session right rail (~300px, toggleable): four tabs — 待办 (todo_write items, hidden
// until the first one arrives), 产物 (artifacts list + read preview), 目录 (session roots:
// add via the native picker, remove), 用量 (per-model token stats from the live session).

import { useEffect, useState } from "react";
import {
  addRoot,
  getArtifacts,
  getRoots,
  readArtifact,
  removeRoot,
  revealArtifact,
} from "../../lib/api/sessions";
import type { Artifact, ArtifactContent, RootEntry, SessionUsage } from "../../lib/api/types";
import { chooseFolder } from "../../../tauri";
import { Icon, type IconName } from "../../components/Icon";
import { Markdown, OPEN_ARTIFACT_EVENT } from "../../components/Markdown";
import { formatTokens, totalTokens, type TodoItem } from "./timeline";
import { shortModel } from "./Composer";

type Tab = "todo" | "artifacts" | "roots" | "usage";

const TABS: { id: Tab; label: string }[] = [
  { id: "todo", label: "待办" },
  { id: "artifacts", label: "产物" },
  { id: "roots", label: "目录" },
  { id: "usage", label: "用量" },
];

function kindIcon(kind: string): IconName {
  if (kind === "image") return "image";
  if (kind === "html" || kind === "code") return "fileCode";
  return "file";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(epochSeconds: number): string {
  if (!epochSeconds) return "";
  return new Date(epochSeconds * 1000).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export interface RightRailProps {
  sessionId: string;
  todo: TodoItem[];
  todoSeen: boolean;
  usage: SessionUsage;
  modelLabels?: Record<string, string>;
  /** Bump to refetch artifacts + roots (file writes, turn end, a granted directory). */
  refreshKey: number;
}

export function RightRail({ sessionId, todo, todoSeen, usage, modelLabels, refreshKey }: RightRailProps) {
  const [tab, setTab] = useState<Tab>("artifacts");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [roots, setRoots] = useState<RootEntry[]>([]);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [content, setContent] = useState<ArtifactContent | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);

  useEffect(() => {
    getArtifacts(sessionId).then(setArtifacts).catch(() => setArtifacts([]));
    getRoots(sessionId).then(setRoots).catch(() => setRoots([]));
  }, [sessionId, refreshKey]);

  // Switching conversations closes any open artifact — it belongs to the previous
  // session's workspace, which the new session can't (and shouldn't) read.
  useEffect(() => {
    setSelected(null);
    setContent(null);
  }, [sessionId]);

  useEffect(() => {
    setContent(null);
    if (!selected) return;
    readArtifact(sessionId, selected.path).then(setContent).catch(() => setContent(null));
  }, [selected?.path, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // [标题](artifact:path) chips in the transcript open the viewer directly (§34).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const path = String((e as CustomEvent).detail?.path || "");
      if (!path) return;
      const match = (list: Artifact[]) =>
        list.find((a) => a.path === path || a.path.endsWith("/" + path) || a.name === path);
      setTab("artifacts");
      const found = match(artifacts);
      if (found) {
        setSelected(found);
        return;
      }
      getArtifacts(sessionId)
        .then((list) => {
          setArtifacts(list);
          setSelected(match(list) ?? null);
        })
        .catch(() => {});
    };
    window.addEventListener(OPEN_ARTIFACT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ARTIFACT_EVENT, onOpen);
  }, [sessionId, artifacts]);

  const addFolder = async () => {
    setRootError(null);
    const path = await chooseFolder();
    if (!path) return;
    const res = await addRoot(sessionId, path, true).catch(() => null);
    if (res?.ok && res.roots) setRoots(res.roots);
    else setRootError(res?.error || "无法添加文件夹");
  };

  const dropFolder = async (path: string) => {
    setRootError(null);
    const res = await removeRoot(sessionId, path).catch(() => null);
    if (res?.ok && res.roots) setRoots(res.roots);
    else setRootError(res?.error || "无法移除文件夹");
  };

  const visibleTabs = TABS.filter((t) => t.id !== "todo" || todoSeen);

  return (
    <aside data-testid="right-rail" className="flex h-full w-[300px] shrink-0 flex-col border-l border-line bg-panel">
      {/* 标签栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              if (t.id !== "artifacts") setSelected(null);
            }}
            className={`rounded-md px-2.5 py-1 text-[12.5px] ${
              tab === t.id ? "bg-accentSoft font-medium text-accent" : "text-muted hover:bg-paper hover:text-ink"
            }`}
          >
            {t.label}
            {t.id === "artifacts" && artifacts.length > 0 && (
              <span className="ml-1 text-[11px] text-faint">{artifacts.length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="hairline-scroll min-h-0 flex-1 overflow-y-auto">
        {tab === "todo" && (
          <div className="px-3 py-3">
            {todo.length === 0 ? (
              <div className="text-[12px] text-faint">当前没有待办事项。</div>
            ) : (
              <div className="space-y-1.5">
                {todo.map((item, index) => (
                  <div key={index} className="flex items-start gap-2 text-[13px]">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        item.status === "done"
                          ? "bg-ok"
                          : item.status === "in_progress"
                            ? "bg-accent"
                            : "bg-lineStrong"
                      }`}
                    />
                    <span className={item.status === "done" ? "text-faint line-through" : ""}>
                      {item.content}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "artifacts" &&
          (selected ? (
            <ArtifactViewer
              sessionId={sessionId}
              artifact={selected}
              content={content}
              onBack={() => setSelected(null)}
            />
          ) : (
            <div className="px-3 py-3">
              {artifacts.length === 0 ? (
                <div className="text-[12px] text-faint">还没有可预览的文件。</div>
              ) : (
                <div className="space-y-0.5">
                  {artifacts.map((a) => (
                    <button
                      key={a.path}
                      type="button"
                      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-paper"
                      onClick={() => setSelected(a)}
                    >
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-paper text-muted" title={a.kind}>
                        <Icon name={kindIcon(a.kind)} size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{a.name}</span>
                        <span className="block text-[11px] text-faint">
                          {formatBytes(a.size)}
                          {a.modified_at ? ` · ${formatTime(a.modified_at)}` : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-faint">打开</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

        {tab === "roots" && (
          <div className="space-y-1 px-3 py-3">
            {roots.map((root) => (
              <div key={root.path} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-paper">
                <Icon name="folder" size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]" title={root.path}>
                    {root.label || root.path.split("/").pop() || root.path}
                  </span>
                  <span className="block truncate font-mono text-[10.5px] text-faint" title={root.path}>
                    {root.path}
                  </span>
                </span>
                {root.primary && (
                  <span className="shrink-0 rounded-full bg-paper px-1.5 text-[10.5px] text-faint">主目录</span>
                )}
                <span
                  className={`shrink-0 rounded-full px-1.5 text-[10.5px] ${
                    root.writable ? "bg-okSoft text-ok" : "bg-paper text-faint"
                  }`}
                >
                  {root.writable ? "可写" : "只读"}
                </span>
                {!root.primary && (
                  <button
                    type="button"
                    className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint hover:text-danger"
                    title="移除"
                    aria-label={`移除 ${root.path}`}
                    onClick={() => void dropFolder(root.path)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
            ))}
            {roots.length === 0 && <div className="text-[12px] text-faint">暂无目录。</div>}
            {rootError && <div className="px-2 text-[12px] text-danger">{rootError}</div>}
            <button
              type="button"
              onClick={() => void addFolder()}
              className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12.5px] text-muted hover:bg-paper hover:text-ink"
            >
              <Icon name="folderPlus" size={14} />
              添加文件夹
            </button>
          </div>
        )}

        {tab === "usage" && (
          <div className="px-3 py-3">
            {totalTokens(usage) === 0 ? (
              <div className="text-[12px] text-faint">本会话还没有 token 用量。</div>
            ) : (
              <div className="space-y-3">
                {usage.context > 0 && (
                  <div className="text-[12px] text-muted">
                    当前上下文 <span className="tabular-nums text-ink">{formatTokens(usage.context)}</span> tokens
                  </div>
                )}
                {Object.entries(usage.byModel).map(([id, t]) => (
                  <div key={id} className="rounded-lg border border-line px-2.5 py-2">
                    <div className="truncate text-[12.5px] font-medium" title={id}>
                      {id === "unknown" ? "未知模型" : modelLabels?.[id]?.split(" · ")[0] || shortModel(id)}
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {stat("输入", t.input)}
                      {t.cache_read + t.cache_write > 0 && (
                        <>
                          {stat("缓存读取", t.cache_read)}
                          {stat("缓存写入", t.cache_write)}
                        </>
                      )}
                      {stat("输出", t.output)}
                    </div>
                  </div>
                ))}
                <div className="flex items-baseline justify-between border-t border-line pt-2 text-[12px]">
                  <span className="text-faint">合计</span>
                  <span className="tabular-nums text-ink">{formatTokens(totalTokens(usage))} tokens</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

const stat = (label: string, value: number) => (
  <div key={label} className="flex items-baseline justify-between text-[11.5px] leading-snug">
    <span className="text-faint">{label}</span>
    <span className="tabular-nums text-ink">{formatTokens(value)}</span>
  </div>
);

function ArtifactViewer({
  sessionId,
  artifact,
  content,
  onBack,
}: {
  sessionId: string;
  artifact: Artifact;
  content: ArtifactContent | null;
  onBack: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2">
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
          onClick={onBack}
          aria-label="返回产物列表"
          title="返回"
        >
          <Icon name="arrowLeft" size={15} />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{artifact.name}</span>
          <span className="block truncate font-mono text-[10.5px] text-faint">{artifact.path}</span>
        </span>
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
          onClick={() => navigator.clipboard?.writeText(artifact.abs_path || artifact.path)}
          aria-label="复制完整路径"
          title="复制完整路径"
        >
          <Icon name="copy" size={14} />
        </button>
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
          onClick={() => revealArtifact(sessionId, artifact.path, "reveal")}
          aria-label="在文件夹中显示"
          title="在文件夹中显示"
        >
          <Icon name="folder" size={14} />
        </button>
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
          onClick={() => revealArtifact(sessionId, artifact.path, "open")}
          aria-label="用默认应用打开"
          title="用默认应用打开"
        >
          <Icon name="external" size={14} />
        </button>
      </div>
      <div className="hairline-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {!content ? (
          <div className="text-[12px] text-faint">加载中…</div>
        ) : content.error ? (
          <div className="text-[12px] text-danger">{content.error}</div>
        ) : content.kind === "markdown" ? (
          <Markdown text={content.content || ""} />
        ) : content.kind === "image" ? (
          <img className="max-w-full rounded-lg border border-line" src={content.data_url} alt={artifact.name} />
        ) : content.kind === "text" || content.kind === "code" || content.kind === "csv" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted">
            {content.content}
          </pre>
        ) : (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <Icon name="external" size={22} className="text-faint" />
            <p className="text-[12.5px] text-muted">此文件类型无法在应用内预览。</p>
            <button
              type="button"
              className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:border-lineStrong"
              onClick={() => revealArtifact(sessionId, artifact.path, "open")}
            >
              用默认应用打开
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
