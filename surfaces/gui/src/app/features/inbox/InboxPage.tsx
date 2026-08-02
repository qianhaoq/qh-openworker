// 收件箱 — 统一审批中心(#/inbox)。汇总各会话挂起的审批 / 提问 / 文件夹授权 / 计划确认,
// 以及本地 ACP agent 的权限请求;在任何一端处理都会释放挂起的 agent(first-responder-wins)。
// 「待处理」是操作队列(旧的在前),「已处理」是最近 50 条回溯。点击会话名跳回来源会话。

import { useState } from "react";
import { Icon } from "../../components/Icon";
import { navigate } from "../../nav";
import type { InboxItem } from "../../lib/api/types";
import { InboxItemCard } from "./InboxItemCard";
import { PermissionCard } from "./PermissionCard";
import { pendingView, resolvedView } from "./inboxLogic";
import { useInbox } from "./useInbox";

const GRP =
  "overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]";
const GRP_H = "mb-1.5 mt-6 px-1 text-[12px] font-semibold text-muted";

const RESOLVED_LIMIT = 50;

type Tab = "pending" | "resolved";

function Segmented({
  tab,
  pendingCount,
  resolvedCount,
  onChange,
}: {
  tab: Tab;
  pendingCount: number;
  resolvedCount: number;
  onChange: (tab: Tab) => void;
}) {
  const segments: { key: Tab; label: string; count: number }[] = [
    { key: "pending", label: "待处理", count: pendingCount },
    { key: "resolved", label: "已处理", count: resolvedCount },
  ];
  return (
    <div className="inline-flex rounded-lg bg-solid p-0.5" role="tablist">
      {segments.map((segment) => {
        const active = tab === segment.key;
        return (
          <button
            key={segment.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(segment.key)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-[12.5px] ${
              active
                ? "bg-panel font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                : "text-muted hover:text-ink"
            }`}
          >
            {segment.label}
            {segment.count > 0 && (
              <span
                className={`rounded-full px-1.5 text-[10.5px] font-semibold leading-4 ${
                  segment.key === "pending" ? "bg-accentSoft text-accent" : "bg-paper text-faint"
                }`}
              >
                {segment.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function EmptyBlock({ icon, title, description }: { icon: "inbox" | "check"; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-xl2 bg-accentSoft text-accent">
        <Icon name={icon} size={20} />
      </div>
      <h2 className="mt-4 text-[15px] font-semibold tracking-tight">{title}</h2>
      <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">{description}</p>
    </div>
  );
}

export function InboxPage() {
  const {
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
  } = useInbox();
  const [tab, setTab] = useState<Tab>("pending");
  const [refreshing, setRefreshing] = useState(false);

  const pendingItems = pendingView(pending);
  const resolvedItems = resolvedView(resolved, RESOLVED_LIMIT);
  const actionable = pendingItems.length + permissions.length;

  const openSession = (item: InboxItem) => navigate(`assistant/${item.session_id}`);

  const manualRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } catch {
      /* 横幅交给 loadError / actionError;手动刷新失败保持现状即可 */
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header data-tauri-drag-region className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">收件箱</h1>
          <p className="mt-1 text-[13px] text-muted">
            各会话与本地 agent 挂起的审批、提问与授权请求,在这里统一处理。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void manualRefresh()}
          disabled={refreshing}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:border-lineStrong disabled:opacity-40"
        >
          <Icon name="refresh" size={14} className={refreshing ? "animate-spin" : undefined} />
          刷新
        </button>
      </header>

      {actionError && (
        <div
          role="alert"
          className="mt-4 flex items-center gap-2 rounded-lg bg-dangerSoft px-3 py-2 text-[12.5px] text-danger"
        >
          <Icon name="alert" size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">处理失败:{actionError}</span>
          <button
            type="button"
            onClick={dismissActionError}
            title="关闭"
            className="grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-danger/10"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <div className="mt-5">
        <Segmented
          tab={tab}
          pendingCount={actionable}
          resolvedCount={resolved.length}
          onChange={setTab}
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-faint">
          <span className="spinner spinner-lg" /> 加载中
        </div>
      ) : loadError ? (
        <div className="py-20 text-center">
          <p className="text-[13px] text-danger">{loadError}</p>
          <button
            type="button"
            onClick={() => void manualRefresh()}
            className="mt-3 rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
          >
            重试
          </button>
        </div>
      ) : tab === "pending" ? (
        actionable === 0 ? (
          <EmptyBlock
            icon="inbox"
            title="没有待处理的事项"
            description="各会话与本地 agent 的审批、提问会汇总到这里;在 Slack 镜像里处理过的也会自动同步。"
          />
        ) : (
          <>
            {permissions.length > 0 && (
              <>
                <div className={GRP_H}>ACP 权限请求({permissions.length})</div>
                <div className={`${GRP} divide-y divide-line`}>
                  {permissions.map((permission) => (
                    <PermissionCard
                      key={permission.permission_id}
                      permission={permission}
                      busy={busyIds.has(permission.permission_id)}
                      onResolve={(id, optionId) => void resolvePermission(id, optionId)}
                    />
                  ))}
                </div>
              </>
            )}
            {pendingItems.length > 0 && (
              <>
                {permissions.length > 0 && <div className={GRP_H}>会话请求({pendingItems.length})</div>}
                <div className={`${GRP} divide-y divide-line`}>
                  {pendingItems.map((item) => (
                    <InboxItemCard
                      key={item.id}
                      item={item}
                      busy={busyIds.has(item.id)}
                      onResolve={(target, resolution) => void resolve(target, resolution)}
                      onOpenSession={openSession}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )
      ) : resolvedItems.length === 0 ? (
        <EmptyBlock
          icon="check"
          title="还没有已处理的事项"
          description="处理过的审批与提问会留在这里,方便回溯当时的决定。"
        />
      ) : (
        <>
          <div className={`${GRP} divide-y divide-line`}>
            {resolvedItems.map((item) => (
              <InboxItemCard
                key={item.id}
                item={item}
                busy={false}
                onResolve={() => {}}
                onOpenSession={openSession}
              />
            ))}
          </div>
          {resolved.length > RESOLVED_LIMIT && (
            <p className="mt-2 px-1 text-[12px] text-faint">仅显示最近 {RESOLVED_LIMIT} 条。</p>
          )}
        </>
      )}
    </div>
  );
}
