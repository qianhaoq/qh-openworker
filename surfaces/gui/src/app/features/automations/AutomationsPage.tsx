// 自动化页面 — 定时任务的列表与管理。macOS 设置语法：灰色底上的分组内嵌列表。
// 行内可展开运行记录（运行中的每 3s 轮询直到结束）；新建/编辑走右侧抽屉；
// 立即运行会准备实时会话并跳转到助理页观看。

import { useState } from "react";
import type { Automation, AutomationRun } from "../../lib/api/types";
import { navigate } from "../../nav";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";
import { AutomationEditor } from "./AutomationEditor";
import {
  QUICK_STARTS,
  blankDraft,
  draftFromAutomation,
  draftFromQuickStart,
  formatDateTime,
  formatDuration,
  humanizeCron,
  runStatusMeta,
  scheduleText,
  summarizePrompt,
  triggerLabel,
  type AutomationDraft,
  type RunTone,
} from "./automationLogic";
import { useAutomations } from "./useAutomations";

const GRP =
  "overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]";
const TAG = "rounded px-1.5 py-0.5 text-[10.5px] font-semibold";

type DrawerState = { kind: "new"; draft: AutomationDraft } | { kind: "edit"; id: string };

const TONE_CLASS: Record<RunTone, string> = {
  accent: "bg-accentSoft text-accent",
  ok: "bg-okSoft text-ok",
  danger: "bg-dangerSoft text-danger",
  muted: "bg-solid text-muted",
};

function StatusTag({ status }: { status: string }) {
  const meta = runStatusMeta(status);
  return <span className={`${TAG} ${TONE_CLASS[meta.tone]}`}>{meta.label}</span>;
}

function RunRow({ run }: { run: AutomationRun }) {
  const open = () => {
    if (run.session_id) navigate(`assistant/${encodeURIComponent(run.session_id)}`);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      title="打开这次运行的会话"
      className="cursor-pointer px-4 py-2.5 hover:bg-paper/50"
    >
      <div className="flex items-center gap-2">
        <StatusTag status={run.status} />
        <span className="text-[12px] text-muted">{triggerLabel(run.trigger)}</span>
        <span className="text-[12px] text-ink">{formatDateTime(run.started_at)}</span>
        <span className="text-[11.5px] text-faint">
          {run.status === "running"
            ? "进行中…"
            : run.finished_at
              ? `用时 ${formatDuration(run.started_at, run.finished_at)}`
              : ""}
        </span>
        {run.artifacts.length > 0 && (
          <span className="text-[11.5px] text-faint">{run.artifacts.length} 个文件</span>
        )}
        <Icon name="chevronRight" size={14} className="ml-auto shrink-0 text-faint" />
      </div>
      {run.error && <div className="mt-1 text-[11.5px] text-danger">{run.error}</div>}
      {run.result_text && (
        <div className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-faint">
          {run.result_text}
        </div>
      )}
    </div>
  );
}

function AutomationRow({
  automation,
  expanded,
  runs,
  runsLoading,
  busy,
  onOpen,
  onToggle,
  onRunNow,
  onToggleRuns,
}: {
  automation: Automation;
  expanded: boolean;
  runs: AutomationRun[];
  runsLoading: boolean;
  busy: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onToggleRuns: () => void;
}) {
  const schedule = scheduleText(automation);
  const unseen = automation.unseen_runs ?? 0;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-paper/50"
      >
        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg bg-accentSoft text-accent">
          <Icon name="automations" size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium">{automation.title}</span>
            {automation.last_status && <StatusTag status={automation.last_status} />}
            {unseen > 0 && (
              <span className={`${TAG} ${automation.unseen_failed ? "bg-dangerSoft text-danger" : "bg-accentSoft text-accent"}`}>
                {unseen} 条新记录
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-[11.5px] text-muted">
            <span className={schedule.raw ? "font-mono text-[11px]" : undefined}>{schedule.text}</span>
            {" · "}
            {automation.enabled ? `下次 ${formatDateTime(automation.next_run)}` : "已暂停"}
            {" · "}
            {automation.run_count} 次运行
            {automation.last_run ? ` · 上次 ${formatDateTime(automation.last_run)}` : ""}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-faint">
            {summarizePrompt(automation.instructions)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2.5">
          <button
            type="button"
            title="立即运行"
            aria-label={`立即运行 ${automation.title}`}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onRunNow();
            }}
            className="grid h-7 w-7 place-items-center rounded-lg border border-line bg-panel text-muted hover:border-lineStrong hover:text-accent disabled:opacity-40"
          >
            {busy ? <span className="spinner" /> : <Icon name="play" size={14} />}
          </button>
          <Switch
            checked={automation.enabled}
            disabled={busy}
            title={automation.enabled ? "停用" : "启用"}
            onChange={(enabled) => onToggle(enabled)}
          />
          <Icon name="chevronRight" size={14} className="text-faint" />
        </span>
      </div>
      {/* 运行记录开关条（不触发行点击） */}
      <button
        type="button"
        onClick={onToggleRuns}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 border-t border-line px-4 py-1.5 text-[11.5px] text-faint hover:bg-paper/50 hover:text-muted"
      >
        <Icon
          name="chevronDown"
          size={12}
          className={`transition-transform ${expanded ? "" : "-rotate-90"}`}
        />
        运行记录
        {expanded && runs.length > 0 ? `（${runs.length}）` : ""}
      </button>
      {expanded && (
        <div className="divide-y divide-line border-t border-line bg-paper/40">
          {runsLoading ? (
            <div className="flex items-center gap-2 px-4 py-3 text-[12px] text-faint">
              <span className="spinner" /> 加载中
            </div>
          ) : runs.length === 0 ? (
            <div className="px-4 py-3 text-[12px] text-faint">还没有运行记录。</div>
          ) : (
            runs.map((run) => <RunRow key={run.run_id} run={run} />)
          )}
        </div>
      )}
    </div>
  );
}

function QuickStartCard({
  template,
  onPick,
}: {
  template: (typeof QUICK_STARTS)[number];
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`${GRP} p-3.5 text-left transition-shadow hover:shadow-[0_0_0_1px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]`}
    >
      <span className="block text-[13px] font-semibold">{template.title}</span>
      <span className="mt-1 block text-[12px] leading-relaxed text-muted">{template.description}</span>
      <span className="mt-2 inline-block rounded bg-solid px-1.5 py-0.5 text-[10.5px] font-semibold text-muted">
        {humanizeCron(template.cron) ?? template.cron}
      </span>
    </button>
  );
}

export function AutomationsPage() {
  const {
    automations,
    loading,
    loadError,
    busyIds,
    expandedId,
    runs,
    runsLoading,
    refresh,
    setEnabled,
    create,
    update,
    remove,
    runNow,
    toggleRuns,
  } = useAutomations();
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = async (operation: () => Promise<{ ok: boolean; error?: string }>) => {
    setActionError(null);
    const result = await operation();
    if (!result.ok) setActionError(result.error || "操作失败");
  };

  const editAutomation =
    drawer?.kind === "edit" ? automations.find((a) => a.id === drawer.id) ?? null : null;

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header data-tauri-drag-region className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">自动化</h1>
          <p className="mt-1 text-[13px] text-muted">
            按计划自动运行的任务：定时触发、手动补跑，每次运行都是一段可查看的会话。
          </p>
        </div>
        {automations.length > 0 && (
          <button
            type="button"
            onClick={() => setDrawer({ kind: "new", draft: blankDraft() })}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white hover:brightness-105"
          >
            <Icon name="plus" size={14} />
            新建自动化
          </button>
        )}
      </header>

      {actionError && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {actionError}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-faint">
          <span className="spinner spinner-lg" /> 加载中
        </div>
      ) : loadError ? (
        <div className="py-20 text-center">
          <p className="text-[13px] text-danger">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              void refresh();
            }}
            className="mt-3 rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
          >
            重试
          </button>
        </div>
      ) : automations.length === 0 ? (
        /* 空状态：从模板快速开始 */
        <div className="flex flex-col items-center py-16 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-xl2 bg-accentSoft text-accent">
            <Icon name="automations" size={20} />
          </div>
          <h2 className="mt-4 text-[15px] font-semibold tracking-tight">创建你的第一个自动化</h2>
          <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
            让助理按计划工作：晨报、新闻简报、每周复盘……从模板开始，或自定义一条。
          </p>
          <div className="mt-6 grid w-full max-w-lg grid-cols-2 gap-2.5 text-left">
            {QUICK_STARTS.map((template) => (
              <QuickStartCard
                key={template.key}
                template={template}
                onPick={() => setDrawer({ kind: "new", draft: draftFromQuickStart(template) })}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setDrawer({ kind: "new", draft: blankDraft() })}
            className="mt-4 text-[13px] text-accent hover:underline"
          >
            或从空白自定义开始
          </button>
        </div>
      ) : (
        <>
          <div className="mb-1.5 mt-6 px-1 text-[12px] font-semibold text-muted">
            全部自动化（{automations.length}）
          </div>
          <div className={`${GRP} divide-y divide-line`}>
            {automations.map((automation) => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                expanded={expandedId === automation.id}
                runs={expandedId === automation.id ? runs : []}
                runsLoading={expandedId === automation.id && runsLoading}
                busy={busyIds.has(automation.id)}
                onOpen={() => setDrawer({ kind: "edit", id: automation.id })}
                onToggle={(enabled) => void act(() => setEnabled(automation, enabled))}
                onRunNow={() => void act(() => runNow(automation))}
                onToggleRuns={() => toggleRuns(automation)}
              />
            ))}
          </div>
          <p className="mt-2 px-1 text-[12px] text-faint">
            点击行编辑；点击「运行记录」展开历史。仅在本地服务运行时触发，错过的计划会在下次启动时补跑一次。
          </p>
        </>
      )}

      {/* 新建 drawer */}
      {drawer?.kind === "new" && (
        <AutomationEditor
          key="new"
          initial={drawer.draft}
          original={null}
          busy={busyIds.has("*")}
          onSave={create}
          onDelete={remove}
          onRunNow={runNow}
          onClose={() => setDrawer(null)}
        />
      )}
      {/* 编辑 drawer */}
      {drawer?.kind === "edit" && editAutomation && (
        <AutomationEditor
          key={editAutomation.id}
          initial={draftFromAutomation(editAutomation)}
          original={editAutomation}
          busy={busyIds.has(editAutomation.id)}
          onSave={(draft) => update(editAutomation, draft)}
          onDelete={remove}
          onRunNow={runNow}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}
