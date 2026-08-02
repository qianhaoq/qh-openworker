// MCP 服务器 tab: the grouped server list (name, command/URL, status, tool count,
// enable switch, tools viewer, connect/sign-out), an add/edit drawer (stdio 命令 +
// 参数 + 环境变量,或 HTTP 地址 + OAuth), and 重新加载. OAuth connect starts a
// sidecar-driven browser sign-in; the hook polls while any server is "authorizing".

import { useState } from "react";
import type { McpServer } from "../../lib/api/types";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";
import {
  blankMcpForm,
  configFromMcpForm,
  editChangesFromMcpForm,
  mcpConfigSummary,
  mcpFormFromServer,
  mcpStatusView,
  type McpFormState,
} from "./integrationLogic";
import { useMcpServers } from "./useMcpServers";
import { FOOT, GRP, GRP_H, INPUT, PILL_ACCENT, PILL_LINE, ROW, TAG_QUIET } from "./ui";
import { Dot } from "./widgets";

type Mcp = ReturnType<typeof useMcpServers>;

type DrawerState = { kind: "new" } | { kind: "edit"; name: string } | null;

export function McpServersView() {
  const mcp = useMcpServers();
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [reloading, setReloading] = useState(false);

  const editing =
    drawer?.kind === "edit" ? mcp.servers.find((s) => s.name === drawer.name) ?? null : null;

  if (mcp.loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-faint">
        <span className="spinner spinner-lg" /> 加载中
      </div>
    );
  }
  if (mcp.loadError) {
    return (
      <div className="py-20 text-center">
        <p className="text-[13px] text-danger">{mcp.loadError}</p>
        <button
          type="button"
          onClick={() => void mcp.refresh().catch(() => {})}
          className="mt-3 rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight">MCP 服务器</h2>
          <p className="mt-1 text-[13px] text-muted">
            外部工具服务器(stdio 或 HTTP),所有 Agent 共享。改动对新会话生效。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className={PILL_LINE}
            disabled={reloading}
            onClick={async () => {
              setReloading(true);
              await mcp.reload();
              setReloading(false);
            }}
          >
            {reloading ? "重载中…" : "立即重载"}
          </button>
          <button type="button" className={PILL_ACCENT} onClick={() => setDrawer({ kind: "new" })}>
            ＋ 添加服务器
          </button>
        </div>
      </header>

      {mcp.actionError && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {mcp.actionError}
        </p>
      )}

      {mcp.servers.length === 0 ? (
        <div className={`${GRP} mt-5`}>
          <div className={`${ROW} text-[12.5px] text-muted`}>
            还没有配置 MCP 服务器。点击右上角“添加服务器”开始。
          </div>
        </div>
      ) : (
        <>
          <div className={GRP_H}>已配置({mcp.servers.length})</div>
          <div className={`${GRP} divide-y divide-line`} data-testid="mcp-list">
            {mcp.servers.map((s) => (
              <McpRow
                key={s.name}
                server={s}
                mcp={mcp}
                onEdit={() => setDrawer({ kind: "edit", name: s.name })}
              />
            ))}
          </div>
          <p className={FOOT}>工具调用默认需要审批;“已连接”的服务器才会向 Agent 暴露工具。</p>
        </>
      )}

      {drawer?.kind === "new" && (
        <McpEditor
          key="new"
          title="添加 MCP 服务器"
          initial={blankMcpForm()}
          existingNames={mcp.servers.map((s) => s.name)}
          onSubmit={async (name, config) => {
            const result = await mcp.add(name, config);
            return result.ok ? null : result.error || "添加失败";
          }}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.kind === "edit" && editing && (
        <McpEditor
          key={editing.name}
          title={`编辑 ${editing.name}`}
          initial={mcpFormFromServer(editing)}
          existingNames={[]}
          fixedName={editing.name}
          onSubmit={async (_name, changes) => {
            // Edit = top-level shallow merge into the flat stored record
            // (patch_global_server) — the drawer's change set keeps enabled /
            // requires_approval and any untouched masked env intact.
            const result = await mcp.patch(editing.name, changes);
            return result.ok ? null : result.error || "保存失败";
          }}
          onDelete={async () => {
            const result = await mcp.remove(editing.name);
            return result.ok ? null : result.error || "删除失败";
          }}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

function McpRow({
  server,
  mcp,
  onEdit,
}: {
  server: McpServer;
  mcp: Mcp;
  onEdit: () => void;
}) {
  const status = mcpStatusView(server);
  const tools = mcp.toolsByName[server.name];
  const isOauth = server.auth === "oauth";
  const summary = mcpConfigSummary(server.config);
  const needsAuth = server.status === "needs_auth";
  const authorizing = server.status === "authorizing";

  return (
    <div data-testid={`mcp-server-${server.name}`}>
      <div
        role="button"
        tabIndex={0}
        className={`${ROW} cursor-pointer hover:bg-paper/50`}
        onClick={onEdit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onEdit();
          }
        }}
      >
        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg bg-solid text-[11px] font-bold text-onSolid">
          MCP
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{server.name}</span>
            {server.requires_approval && <span className={TAG_QUIET}>需审批</span>}
          </span>
          {summary && (
            <span className="mt-0.5 block truncate font-mono text-[11px] text-faint" title={summary}>
              {summary}
            </span>
          )}
          {server.last_error && server.status !== "connected" && (
            <span className="mt-0.5 block truncate text-[11.5px] text-danger" title={server.last_error}>
              {server.last_error}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          {server.tool_count != null && (
            <span className="text-[11.5px] text-faint">{server.tool_count} 工具</span>
          )}
          <span className="flex items-center gap-1.5 text-[11.5px]">
            {authorizing && <span className="spinner" />}
            <Dot tone={status.tone} />
            <span className="text-muted">{status.label}</span>
          </span>
          {isOauth && needsAuth && (
            <button
              type="button"
              className={PILL_ACCENT}
              data-testid={`mcp-connect-${server.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void mcp.connect(server.name);
              }}
            >
              授权连接
            </button>
          )}
          {isOauth && server.status === "connected" && (
            <button
              type="button"
              className="text-[12px] text-muted hover:text-ink"
              data-testid={`mcp-signout-${server.name}`}
              onClick={(e) => {
                e.stopPropagation();
                void mcp.signout(server.name);
              }}
            >
              退出登录
            </button>
          )}
          <button
            type="button"
            className="text-[12px] text-muted hover:text-ink"
            data-testid={`mcp-tools-${server.name}`}
            onClick={(e) => {
              e.stopPropagation();
              void mcp.toggleTools(server.name);
            }}
          >
            {tools ? "收起工具" : "工具"}
          </button>
          <Switch
            checked={server.enabled}
            disabled={mcp.busyNames.has(server.name)}
            title={server.enabled ? "停用" : "启用"}
            onChange={() => void mcp.toggle(server)}
          />
        </span>
      </div>
      {tools && (
        <div className="border-t border-line px-4 py-2.5" data-testid={`mcp-tools-list-${server.name}`}>
          {tools.kind === "loading" && (
            <span className="flex items-center gap-2 text-[12px] text-faint">
              <span className="spinner" /> 连接服务器中…
            </span>
          )}
          {tools.kind === "error" && <span className="text-[12px] text-danger">{tools.error}</span>}
          {tools.kind === "loaded" && tools.tools.length === 0 && (
            <span className="text-[12px] text-faint">该服务器没有暴露工具。</span>
          )}
          {tools.kind === "loaded" && tools.tools.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tools.tools.map((t) => (
                <span
                  key={t.name}
                  title={t.description}
                  className="rounded-md bg-paper px-1.5 py-0.5 font-mono text-[11.5px] shadow-[inset_0_0_0_0.5px_var(--line-strong)]"
                >
                  {t.name}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit drawer
// ---------------------------------------------------------------------------

function McpEditor({
  title,
  initial,
  existingNames,
  fixedName,
  onSubmit,
  onDelete,
  onClose,
}: {
  title: string;
  initial: McpFormState;
  /** Names that would collide (add mode). */
  existingNames: string[];
  /** Set in edit mode — the name is the record key and cannot change. */
  fixedName?: string;
  /** Returns an error string, or null on success (drawer closes). */
  onSubmit: (name: string, config: Record<string, unknown>) => Promise<string | null>;
  onDelete?: () => Promise<string | null>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<McpFormState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof McpFormState>(key: K, value: McpFormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const submit = async () => {
    const name = (fixedName ?? form.name).trim();
    if (!fixedName && existingNames.includes(name)) {
      setError(`已存在名为 ${name} 的服务器`);
      return;
    }
    // Edit goes through the merge-safe change set (top-level keys, env only when
    // touched — the served config masks stored secrets with ***); add stores the
    // full config record.
    const built = fixedName
      ? editChangesFromMcpForm({ ...form, name }, form.envText !== initial.envText)
      : configFromMcpForm({ ...form, name });
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onSubmit(name, built.value);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l border-line bg-paper shadow-2xl"
        role="dialog"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
          <div className="text-[13.5px] font-semibold tracking-tight">{title}</div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="grid h-6 w-6 place-items-center rounded text-faint hover:bg-paper hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="hairline-scroll flex-1 space-y-4 overflow-y-auto p-4">
          <div>
            <div className="mb-1 text-[12px] font-semibold text-muted">名称</div>
            <input
              className={INPUT}
              value={fixedName ?? form.name}
              disabled={!!fixedName}
              placeholder="如 filesystem"
              spellCheck={false}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>

          <div>
            <div className="mb-1 text-[12px] font-semibold text-muted">传输方式</div>
            <div className="inline-flex rounded-full bg-panel p-0.5 text-[12.5px] font-medium shadow-[inset_0_0_0_0.5px_var(--line-strong)]">
              {(
                [
                  ["stdio", "本地命令 (stdio)"],
                  ["http", "远程 HTTP"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded-full px-3.5 py-1 ${
                    form.transport === key ? "bg-paper text-ink shadow-sm" : "text-muted"
                  }`}
                  onClick={() => set("transport", key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {form.transport === "stdio" ? (
            <>
              <div>
                <div className="mb-1 text-[12px] font-semibold text-muted">启动命令</div>
                <input
                  className={`${INPUT} font-mono`}
                  value={form.command}
                  placeholder="如 npx 或 uvx"
                  spellCheck={false}
                  onChange={(e) => set("command", e.target.value)}
                />
              </div>
              <div>
                <div className="mb-1 text-[12px] font-semibold text-muted">参数(JSON 数组)</div>
                <input
                  className={`${INPUT} font-mono`}
                  value={form.argsText}
                  placeholder='["-y","@modelcontextprotocol/server-filesystem"]'
                  spellCheck={false}
                  onChange={(e) => set("argsText", e.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <div className="mb-1 text-[12px] font-semibold text-muted">服务器地址</div>
                <input
                  className={`${INPUT} font-mono`}
                  value={form.url}
                  placeholder="https://mcp.example.com/mcp"
                  spellCheck={false}
                  onChange={(e) => set("url", e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="h-[15px] w-[15px] accent-accent"
                  checked={form.oauth}
                  onChange={(e) => set("oauth", e.target.checked)}
                />
                需要 OAuth 浏览器登录
              </label>
            </>
          )}

          <div>
            <div className="mb-1 text-[12px] font-semibold text-muted">环境变量(每行 KEY=VALUE)</div>
            <textarea
              className={`${INPUT} resize-y font-mono`}
              rows={3}
              value={form.envText}
              placeholder={"API_KEY=…\nROOT=/tmp"}
              spellCheck={false}
              onChange={(e) => set("envText", e.target.value)}
            />
            {fixedName && (
              <p className="mt-1 text-[11.5px] text-faint">
                *** 是已保存密钥的掩码 — 不动这段文本则原样保留;改动则需重新输入真实值。
              </p>
            )}
          </div>

          {error && (
            <p className="text-[12px] text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line bg-panel px-4 py-3">
          <button type="button" className={PILL_ACCENT} onClick={submit} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
          <button type="button" className={PILL_LINE} onClick={onClose} disabled={busy}>
            取消
          </button>
          {onDelete && (
            <span className="ml-auto">
              {confirmDelete ? (
                <span className="flex items-center gap-2 text-[12.5px]">
                  <span className="text-danger">确认删除?</span>
                  <button
                    type="button"
                    className="font-medium text-danger hover:underline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      const failure = await onDelete();
                      setBusy(false);
                      if (failure) setError(failure);
                      else onClose();
                    }}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="text-muted hover:text-ink"
                    onClick={() => setConfirmDelete(false)}
                  >
                    保留
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="text-[12.5px] text-danger/80 hover:text-danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  删除服务器
                </button>
              )}
            </span>
          )}
        </div>
      </aside>
    </>
  );
}
