// 连接器 tab: the two-group list (已连接 / 未连接) and one generic detail shell
// whose body switches per connector kind — Slack workspaces, GitHub installations,
// Gmail/Calendar accounts (+ privacy filters), HubSpot portals (+ hidden fields),
// generic account rows. Connect goes through ConnectSheet; every account mutation
// rides the useConnectors hook. Out of scope by design (see the phase report):
// cloud-managed one-click (the API layer drops it), allow-list editing, and the
// parked unauthorized-sender queue.

import { useMemo, useState } from "react";
import {
  getSlackChannels,
  type Connector,
  type SlackChannelEntry,
} from "../../lib/api";
import { Icon } from "../../components/Icon";
import {
  accountCount,
  connectorStatus,
  enabledToolCount,
  githubHealthView,
  needsReauth,
  slackHealthView,
} from "./integrationLogic";
import { ConnectSheet } from "./ConnectSheet";
import { useConnectors } from "./useConnectors";
import { FOOT, GRP, GRP_H, LABEL, PILL_ACCENT, PILL_QUIET, ROW, TAG_QUIET, TAG_WARN, XBTN } from "./ui";
import { ChipEditorRow, ConnectorBadge, Dot } from "./widgets";

type Connectors = ReturnType<typeof useConnectors>;

export function ConnectorsView() {
  const ctl = useConnectors();
  const [selected, setSelected] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ctl.connectors;
    return ctl.connectors.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        (c.blurb || "").toLowerCase().includes(q),
    );
  }, [ctl.connectors, query]);

  const selectedConnector = ctl.connectors.find((c) => c.name === selected) ?? null;
  const connectingConnector = ctl.connectors.find((c) => c.name === connecting) ?? null;

  if (ctl.loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-faint">
        <span className="spinner spinner-lg" /> 加载中
      </div>
    );
  }
  if (ctl.loadError) {
    return (
      <div className="py-20 text-center">
        <p className="text-[13px] text-danger">{ctl.loadError}</p>
        <button
          type="button"
          onClick={() => {
            ctl.clearActionError();
            void ctl.refresh().catch(() => {});
          }}
          className="mt-3 rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
        >
          重试
        </button>
      </div>
    );
  }

  if (selectedConnector) {
    return (
      <>
        <ConnectorDetail
          c={selectedConnector}
          ctl={ctl}
          onBack={() => setSelected(null)}
          onConnect={() => setConnecting(selectedConnector.name)}
        />
        {connectingConnector && (
          <ConnectSheet c={connectingConnector} ctl={ctl} onClose={() => setConnecting(null)} />
        )}
      </>
    );
  }

  const connectedList = filtered.filter((c) => c.connected);
  const availableList = filtered.filter((c) => !c.connected && c.available);
  const unavailableList = filtered.filter((c) => !c.connected && !c.available);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-4">
        <h2 className="text-[22px] font-semibold tracking-tight">连接器</h2>
        <input
          className="w-44 rounded-full bg-panel px-3.5 py-1.5 text-[13px] outline-none shadow-[0_0_0_0.5px_var(--line-strong)] placeholder:text-faint focus:shadow-[0_0_0_1.5px_var(--accent)]"
          placeholder="搜索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {ctl.actionError && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {ctl.actionError}
        </p>
      )}

      {connectedList.length > 0 && (
        <>
          <div className={GRP_H}>已连接</div>
          <div className={`${GRP} divide-y divide-line`} data-testid="connected-list">
            {connectedList.map((c) => (
              <ConnectedRow key={c.name} c={c} onOpen={() => setSelected(c.name)} />
            ))}
          </div>
        </>
      )}

      <div className={GRP_H}>未连接</div>
      <div className={`${GRP} divide-y divide-line`} data-testid="available-list">
        {availableList.length === 0 && unavailableList.length === 0 && (
          <div className={`${ROW} text-[12.5px] text-muted`}>没有更多可连接的连接器。</div>
        )}
        {availableList.map((c) => (
          <AvailableRow key={c.name} c={c} onOpen={() => setSelected(c.name)} onConnect={() => setConnecting(c.name)} />
        ))}
        {unavailableList.map((c) => (
          <div key={c.name} className={ROW} title={c.blurb}>
            <ConnectorBadge c={c} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-muted">{c.title}</span>
              <span className="block truncate text-[12px] text-faint">{c.blurb}</span>
            </span>
            <span className={TAG_QUIET}>不可用</span>
          </div>
        ))}
      </div>

      {connectingConnector && (
        <ConnectSheet c={connectingConnector} ctl={ctl} onClose={() => setConnecting(null)} />
      )}
    </div>
  );
}

function ConnectedRow({ c, onOpen }: { c: Connector; onOpen: () => void }) {
  const status = connectorStatus(c);
  const reauth = needsReauth(c);
  return (
    <button type="button" className={`${ROW} w-full text-left hover:bg-paper/50`} onClick={onOpen}>
      <ConnectorBadge c={c} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{c.title}</span>
        <span className="block truncate text-[12px] text-muted">{status.detail}</span>
      </span>
      {reauth ? <span className={TAG_WARN}>需要授权</span> : <Dot tone={status.tone} />}
      <Icon name="chevronRight" size={14} className="text-faint" />
    </button>
  );
}

function AvailableRow({
  c,
  onOpen,
  onConnect,
}: {
  c: Connector;
  onOpen: () => void;
  onConnect: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`${ROW} cursor-pointer hover:bg-paper/50`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <ConnectorBadge c={c} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{c.title}</span>
        <span className="block truncate text-[12px] text-muted">{c.blurb}</span>
      </span>
      <button
        type="button"
        className={PILL_QUIET}
        onClick={(e) => {
          e.stopPropagation();
          onConnect();
        }}
      >
        连接
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail shell + per-kind bodies
// ---------------------------------------------------------------------------

function ConnectorDetail({
  c,
  ctl,
  onBack,
  onConnect,
}: {
  c: Connector;
  ctl: Connectors;
  onBack: () => void;
  onConnect: () => void;
}) {
  const status = connectorStatus(c);
  const count = accountCount(c);
  // The header's connect/add-entry button. Relay-connected Slack/GitHub get NONE:
  // adding a workspace/installation rides the cloud-managed flow the new API layer
  // intentionally drops, and the only local alternative (manual tokens) pauses the
  // relay — never offer that behind an innocent-looking "add" button. Multi-account
  // kinds accumulate locally, so their add-entry button is safe.
  const relayManaged =
    (c.name === "slack" || c.name === "github") && c.connected && c.mode === "relay";
  const addLabel = !c.connected
    ? "连接"
    : relayManaged
      ? null
      : c.name === "hubspot"
        ? "＋ 添加门户"
        : c.accounts
          ? "＋ 添加账户"
          : null;

  return (
    <div>
      <button type="button" className="mb-3 text-[13px] text-accent hover:underline" onClick={onBack}>
        ‹ 连接器
      </button>
      <div className="flex items-center gap-3.5">
        <ConnectorBadge c={c} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight">{c.title}</h2>
          <div className="flex items-center gap-1.5 text-[12.5px] text-muted">
            {c.connected && <Dot tone={status.tone} />}
            <span>
              {c.connected ? status.detail || status.label : "未连接"}
            </span>
          </div>
        </div>
        {addLabel && (
          <button type="button" className={PILL_ACCENT} onClick={onConnect} data-testid="detail-connect-btn">
            {addLabel}
          </button>
        )}
      </div>

      {ctl.actionError && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {ctl.actionError}
        </p>
      )}

      {!c.connected && (
        <div className={`${GRP} mt-5`}>
          <div className={`${ROW} text-[12.5px] text-muted`}>{c.blurb}</div>
        </div>
      )}

      {c.connected && c.name === "slack" && <SlackBody c={c} ctl={ctl} />}
      {c.connected && c.name === "github" && <GithubBody c={c} ctl={ctl} />}
      {c.connected && c.name === "gmail" && <GmailBody c={c} ctl={ctl} />}
      {c.connected && c.name === "google_calendar" && <CalendarBody c={c} ctl={ctl} />}
      {c.connected && c.name === "hubspot" && <HubSpotBody c={c} ctl={ctl} />}
      {c.connected &&
        !["slack", "github", "gmail", "google_calendar", "hubspot"].includes(c.name) && (
          <GenericBody c={c} ctl={ctl} />
        )}

      {c.tools.length > 0 && <ToolsDisclosure c={c} ctl={ctl} />}

      {/* Single-entry connectors (no account collections): one quiet disconnect. */}
      {c.connected && count === 0 && (
        <div className={`${GRP} mt-6`}>
          <div className={ROW}>
            <span className="flex-1" />
            <DisconnectButton label="断开连接" onClick={() => void ctl.disconnect(c.name)} />
          </div>
        </div>
      )}
    </div>
  );
}

function DisconnectButton({ label, onClick }: { label: string; onClick: () => Promise<unknown> | void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 text-[12.5px] text-danger/80 hover:text-danger disabled:opacity-50"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await onClick();
        setBusy(false);
      }}
    >
      {busy ? "断开中…" : label}
    </button>
  );
}

// -- Slack ---------------------------------------------------------------------

function SlackBody({ c, ctl }: { c: Connector; ctl: Connectors }) {
  const relay = c.mode === "relay";
  const workspaces = c.workspaces ?? [];
  if (!relay) {
    return (
      <>
        <div className={GRP_H}>{c.account || "工作区"} <span className="font-normal text-faint">· 手动令牌</span></div>
        <div className={GRP} data-testid="slack-manual">
          <div className={ROW}>
            <span className={LABEL}>模式</span>
            <span className="min-w-0 flex-1 text-[12.5px] text-muted">
              Socket Mode(手动令牌) · {c.allowed_users.length} 人在允许列表
            </span>
          </div>
          <div className={ROW}>
            <span className="flex-1" />
            <DisconnectButton label="断开连接" onClick={() => void ctl.disconnect("slack")} />
          </div>
        </div>
      </>
    );
  }
  const health = slackHealthView(ctl.slackStatus);
  return (
    <>
      <div className={`${GRP} mt-5`}>
        <div className={`${ROW} text-[12.5px] text-muted`}>
          <Dot tone={health.tone} />
          <span className="min-w-0 flex-1">{health.text}</span>
        </div>
      </div>
      {workspaces.map((w) => {
        const tokenOk = ctl.slackStatus?.teams?.[w.team_id]?.token_ok !== false;
        return (
          <div key={w.team_id} data-testid={`slack-workspace-${w.team_id}`}>
            <div className={`${GRP_H} flex items-center gap-2`}>
              <span className="truncate">
                {w.account || w.team_id}{" "}
                <span className="font-normal text-faint" title={w.team_id}>
                  · {w.domain || w.team_id}
                </span>
              </span>
              {!tokenOk && <span className={TAG_WARN}>令牌已失效 — 请重新安装</span>}
            </div>
            <div className={GRP}>
              <div className={ROW}>
                <span className={LABEL}>成员</span>
                <span className="min-w-0 flex-1 text-[12.5px] text-muted">
                  {w.allow_all
                    ? "允许所有人"
                    : w.allowed_users.length > 0
                      ? `${w.allowed_users.length} 人在允许列表`
                      : "尚未允许任何人 — @提及会先在收件箱等待你批准"}
                </span>
              </div>
              <SlackChannelsPreview teamId={w.team_id} />
              <div className={ROW}>
                <span className="flex-1" />
                <DisconnectButton
                  label="断开此工作区"
                  onClick={() => void ctl.disconnectEntry("slack", w.team_id)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

/** Collapsible channel roster preview (first 20), loaded on first expand. */
function SlackChannelsPreview({ teamId }: { teamId: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "error"; error: string }
    | { kind: "loaded"; channels: SlackChannelEntry[] }
  >({ kind: "idle" });

  const load = () => {
    if (state.kind !== "idle" && state.kind !== "error") return;
    setState({ kind: "loading" });
    getSlackChannels(teamId, "", 20)
      .then((r) =>
        r.ok
          ? setState({ kind: "loaded", channels: r.channels ?? [] })
          : setState({ kind: "error", error: r.error || "无法加载频道" }),
      )
      .catch(() => setState({ kind: "error", error: "无法加载频道" }));
  };

  return (
    <details
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) load();
      }}
    >
      <summary className={`${ROW} cursor-pointer list-none hover:bg-paper/50 [&::-webkit-details-marker]:hidden`}>
        <span className={LABEL}>› 频道</span>
        <span className="min-w-0 flex-1 text-[12.5px] text-muted">
          {state.kind === "loaded" ? `${state.channels.length} 个可见频道(前 20)` : "预览机器人可见的频道"}
        </span>
      </summary>
      <div className="border-t border-line px-4 py-2.5" data-testid={`slack-channels-${teamId}`}>
        {state.kind === "loading" && (
          <span className="flex items-center gap-2 text-[12px] text-faint">
            <span className="spinner" /> 加载中
          </span>
        )}
        {state.kind === "error" && <span className="text-[12px] text-danger">{state.error}</span>}
        {state.kind === "loaded" && state.channels.length === 0 && (
          <span className="text-[12px] text-faint">机器人还不在任何频道里。</span>
        )}
        {state.kind === "loaded" && (
          <div className="flex flex-wrap gap-1.5">
            {state.channels.map((ch) => (
              <span
                key={ch.id}
                className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-[12px] shadow-[inset_0_0_0_0.5px_var(--line-strong)]"
                title={ch.id}
              >
                #{ch.name}
                {ch.is_private && <span className="text-[10px] text-faint">私有</span>}
              </span>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

// -- GitHub --------------------------------------------------------------------

function GithubBody({ c, ctl }: { c: Connector; ctl: Connectors }) {
  const relay = c.mode === "relay";
  const installations = c.installations ?? [];
  if (!relay) {
    return (
      <div className={`${GRP} mt-5`} data-testid="github-manual">
        <div className={`${ROW} text-[12.5px] text-muted`}>
          <span className="min-w-0 flex-1">
            个人访问令牌 · 仅工具调用。安装 GitHub App 后,@提及和标签才能触达这台电脑。
          </span>
        </div>
        <div className={ROW}>
          <span className="flex-1" />
          <DisconnectButton label="断开连接" onClick={() => void ctl.disconnect("github")} />
        </div>
      </div>
    );
  }
  const health = githubHealthView(ctl.githubStatus);
  return (
    <>
      <div className={`${GRP} mt-5`}>
        <div className={`${ROW} text-[12.5px] text-muted`}>
          <Dot tone={health.tone} />
          <span className="min-w-0 flex-1">{health.text}</span>
        </div>
      </div>
      {installations.map((inst) => {
        const tokenOk = ctl.githubStatus?.installs?.[inst.installation_id]?.token_ok !== false;
        return (
          <div key={inst.installation_id} data-testid={`github-install-${inst.installation_id}`}>
            <div className={`${GRP_H} flex items-center gap-2`}>
              <span className="truncate">
                {inst.account_login}{" "}
                <span className="font-normal text-faint" title={`installation ${inst.installation_id}`}>
                  · {inst.repo_selection === "all" ? "全部仓库" : "所选仓库"}
                </span>
              </span>
              {!tokenOk && <span className={TAG_WARN}>安装已撤销 — 请重新安装</span>}
            </div>
            <div className={GRP}>
              <div className={ROW}>
                <span className={LABEL}>成员</span>
                <span className="min-w-0 flex-1 text-[12.5px] text-muted">
                  {inst.allow_all
                    ? "允许所有人"
                    : inst.allowed_users.length > 0
                      ? `${inst.allowed_users.length} 人在允许列表`
                      : "尚未允许任何人 — @提及会先等待你批准"}
                </span>
              </div>
              <div className={ROW}>
                <span className="flex-1" />
                <DisconnectButton
                  label="断开此安装"
                  onClick={() => void ctl.disconnectEntry("github", inst.installation_id)}
                />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

// -- Gmail / Google Calendar ----------------------------------------------------

interface AccountLike {
  email: string;
  default: boolean;
  needs_reauth?: boolean;
  scopes?: string;
}

function AccountRows({
  c,
  accounts,
  onMakeDefault,
  onDisconnect,
}: {
  c: Connector;
  accounts: AccountLike[];
  onMakeDefault: (email: string) => void;
  onDisconnect: (email: string) => void;
}) {
  return (
    <>
      <div className={GRP_H}>账户</div>
      <div className={GRP} data-testid={`${c.name}-accounts`}>
        {accounts.map((a) => (
          <div key={a.email} className={ROW}>
            <ConnectorBadge c={c} size={24} />
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-[13px] font-medium">{a.email}</span>
              {a.default && <span className={TAG_QUIET}>默认</span>}
              {a.needs_reauth && <span className={TAG_WARN}>需要重新授权</span>}
            </span>
            {!a.default && (
              <button
                type="button"
                className="shrink-0 text-[12px] text-muted hover:text-ink"
                onClick={() => onMakeDefault(a.email)}
              >
                设为默认
              </button>
            )}
            <button
              type="button"
              className={XBTN}
              title="断开此账户"
              onClick={() => onDisconnect(a.email)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function GmailBody({ c, ctl }: { c: Connector; ctl: Connectors }) {
  const accounts = (c.accounts ?? []) as AccountLike[];
  const filters = c.filters ?? { senders: [], labels: [] };
  return (
    <>
      {accounts.length > 0 && (
        <AccountRows
          c={c}
          accounts={accounts}
          onMakeDefault={(email) => void ctl.setDefaultEntry("gmail", email)}
          onDisconnect={(email) => void ctl.disconnectEntry("gmail", email)}
        />
      )}
      <div className={GRP_H}>不对 Agent 展示</div>
      <div className={GRP} data-testid="gmail-filters">
        <ChipEditorRow
          label="发件人"
          placeholder="name@example.com 或 @domain.com"
          mono
          values={filters.senders}
          onSave={(senders) => void ctl.saveGmailFilters({ senders })}
        />
        <ChipEditorRow
          label="标签"
          placeholder="标签名,如 机密"
          values={filters.labels}
          onSave={(labels) => void ctl.saveGmailFilters({ labels })}
        />
      </div>
      <div className={FOOT}>
        匹配的邮件在 Agent 看来完全不存在 — 没有发件人、主题,也没有任何“已隐藏”的痕迹。
      </div>
    </>
  );
}

function CalendarBody({ c, ctl }: { c: Connector; ctl: Connectors }) {
  const accounts = (c.accounts ?? []) as AccountLike[];
  if (accounts.length === 0) return null;
  return (
    <>
      <AccountRows
        c={c}
        accounts={accounts}
        onMakeDefault={(email) => void ctl.setDefaultEntry("google_calendar", email)}
        onDisconnect={(email) => void ctl.disconnectEntry("google_calendar", email)}
      />
      <div className={FOOT}>创建、修改或删除日程都会先请求你的批准,批准时会注明所用账户。</div>
    </>
  );
}

// -- HubSpot ---------------------------------------------------------------------

function HubSpotBody({ c, ctl }: { c: Connector; ctl: Connectors }) {
  const portals = c.portals ?? [];
  const hidden = c.hidden_fields ?? [];
  return (
    <>
      {portals.length > 0 && (
        <>
          <div className={GRP_H}>门户</div>
          <div className={GRP} data-testid="hubspot-portals">
            {portals.map((p) => (
              <div key={p.hub_id} className={ROW}>
                <ConnectorBadge c={c} size={24} />
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="truncate text-[13px] font-medium" title={`hub ${p.hub_id}`}>
                    {p.name}
                  </span>
                  {p.default && <span className={TAG_QUIET}>默认</span>}
                  {p.sandbox && <span className={TAG_WARN}>沙盒</span>}
                  {p.access && (
                    <span className={TAG_QUIET}>{p.access === "write" ? "读写" : "只读"}</span>
                  )}
                  {!p.managed && <span className={TAG_QUIET}>Private App</span>}
                </span>
                {!p.default && (
                  <button
                    type="button"
                    className="shrink-0 text-[12px] text-muted hover:text-ink"
                    onClick={() => void ctl.setDefaultEntry("hubspot", p.hub_id)}
                  >
                    设为默认
                  </button>
                )}
                <button
                  type="button"
                  className={XBTN}
                  title="断开此门户"
                  onClick={() => void ctl.disconnectEntry("hubspot", p.hub_id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <div className={GRP_H}>访问与隐私</div>
      <div className={GRP} data-testid="hubspot-hidden-fields">
        <ChipEditorRow
          label="隐藏字段"
          placeholder="属性名,如 salary"
          mono
          values={hidden}
          onSave={(fields) => void ctl.saveHubSpotHiddenFields(fields)}
        />
      </div>
      <div className={FOOT}>隐藏的字段会从 Agent 读到的每条记录中剔除,对所有门户生效。</div>
    </>
  );
}

// -- Generic (any other connected connector) --------------------------------------

function GenericBody({ c, ctl }: { c: Connector; ctl: Connectors }) {
  const accounts = (c.accounts ?? []) as { account_id: string; name: string; default: boolean }[];
  if (accounts.length === 0) {
    return (
      <div className={`${GRP} mt-5`}>
        <div className={ROW}>
          <span className="min-w-0 flex-1 text-[12.5px] text-muted">
            {c.account ? `已连接:${c.account}` : "已连接"}
          </span>
          <DisconnectButton label="断开连接" onClick={() => void ctl.disconnect(c.name)} />
        </div>
      </div>
    );
  }
  return (
    <>
      <div className={GRP_H}>账户</div>
      <div className={GRP}>
        {accounts.map((a) => (
          <div key={a.account_id} className={ROW}>
            <ConnectorBadge c={c} size={24} />
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="truncate text-[13px] font-medium">{a.name || a.account_id}</span>
              {a.default && <span className={TAG_QUIET}>默认</span>}
            </span>
            {!a.default && (
              <button
                type="button"
                className="shrink-0 text-[12px] text-muted hover:text-ink"
                onClick={() => void ctl.setDefaultEntry(c.name, a.account_id)}
              >
                设为默认
              </button>
            )}
            <button
              type="button"
              className={XBTN}
              title="断开此账户"
              onClick={() => void ctl.disconnectEntry(c.name, a.account_id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

// -- Tools (shared by every connector) ----------------------------------------------

function ToolsDisclosure({ c, ctl }: { c: Connector; ctl: Connectors }) {
  const { enabled, total } = enabledToolCount(c);
  return (
    <div className={`${GRP} mt-6`} data-testid={`${c.name}-tools`}>
      <details>
        <summary className={`${ROW} cursor-pointer list-none hover:bg-paper/50 [&::-webkit-details-marker]:hidden`}>
          <span className={LABEL}>› 工具</span>
          <span className="min-w-0 flex-1 text-[12.5px] text-muted">
            {total} 项中的 {enabled} 项已启用
          </span>
        </summary>
        <div className="border-t border-line">
          {c.tools.map((tool) => (
            <label
              key={tool.name}
              className={`${ROW} cursor-pointer`}
              title={`${tool.name} — ${tool.description}`}
            >
              <input
                type="checkbox"
                className="h-[15px] w-[15px] accent-accent"
                checked={tool.enabled}
                onChange={(e) => void ctl.toggleTool(c.name, tool.name, e.target.checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{tool.label || tool.name}</span>
                {tool.description && (
                  <span className="block truncate text-[11.5px] text-faint">{tool.description}</span>
                )}
              </span>
              <span className={tool.kind === "write" ? TAG_WARN : TAG_QUIET}>
                {tool.kind === "write" ? "需审批" : "只读"}
              </span>
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}
