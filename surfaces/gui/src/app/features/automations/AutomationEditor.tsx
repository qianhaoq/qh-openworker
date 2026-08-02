// The automation editor: a right-side sheet over the list, for both 新建 and 编辑.
// Fields follow the backend contract — name / instructions / cron (presets + custom) /
// enabled. Workspace is server-assigned (a per-task scratch folder) and shown read-only;
// one-time tasks have no cron to edit.

import { useMemo, useState, type ReactNode } from "react";
import type { Automation } from "../../lib/api/types";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";
import {
  SCHEDULE_PRESETS,
  humanizeCron,
  scheduleText,
  validateCron,
  validateDraft,
  type AutomationDraft,
} from "./automationLogic";
import type { ActionResult } from "./useAutomations";

const GRP =
  "overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]";
const GRP_H = "mb-1.5 mt-5 px-1 text-[12px] font-semibold text-muted";
const FIELD =
  "w-full rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink outline-none focus:border-lineStrong disabled:opacity-50";
const BTN =
  "rounded-lg border border-line bg-paper px-3 py-1.5 text-[12.5px] text-ink hover:border-lineStrong disabled:opacity-40";
const BTN_ACCENT =
  "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40";
const BTN_DANGER =
  "rounded-lg border border-danger/30 bg-paper px-3 py-1.5 text-[12.5px] text-danger disabled:opacity-40";

export interface AutomationEditorProps {
  initial: AutomationDraft;
  /** null = creating; otherwise the automation being edited. */
  original: Automation | null;
  busy: boolean;
  onSave: (draft: AutomationDraft) => Promise<ActionResult>;
  onDelete: (automationId: string) => Promise<ActionResult>;
  onRunNow: (automation: Automation) => Promise<ActionResult>;
  onClose: () => void;
}

function Field({
  label,
  hint,
  stack,
  children,
}: {
  label: string;
  hint?: string;
  stack?: boolean;
  children: ReactNode;
}) {
  if (stack) {
    return (
      <div className="px-4 py-2.5">
        <div className="text-[13px]">{label}</div>
        <div className="mt-1.5">{children}</div>
        {hint && <div className="mt-1 text-[11px] text-faint">{hint}</div>}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="shrink-0 text-[13px]">{label}</span>
      <span className="w-[230px]">
        {children}
        {hint && <span className="mt-1 block text-[11px] leading-snug text-faint">{hint}</span>}
      </span>
    </div>
  );
}

export function AutomationEditor({
  initial,
  original,
  busy,
  onSave,
  onDelete,
  onRunNow,
  onClose,
}: AutomationEditorProps) {
  const [draft, setDraft] = useState<AutomationDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isNew = original === null;
  const isOnce = original?.schedule_raw?.kind === "once";
  const cronError = useMemo(
    () => (isOnce || !draft.cron.trim() ? null : validateCron(draft.cron)),
    [draft.cron, isOnce],
  );
  const cronPreview = useMemo(() => humanizeCron(draft.cron), [draft.cron]);

  const flash = (result: ActionResult, okText: string): boolean => {
    if (result.ok) {
      setError(null);
      setNotice(okText);
    } else {
      setNotice(null);
      setError(result.error || "操作失败");
    }
    return result.ok;
  };

  const save = async () => {
    const invalid = validateDraft(draft, isOnce);
    if (invalid) {
      setError(invalid);
      return;
    }
    const result = await onSave({
      ...draft,
      title: draft.title.trim(),
      instructions: draft.instructions.trim(),
      cron: draft.cron.trim(),
    });
    if (isNew) {
      if (result.ok) onClose();
      else flash(result, "");
    } else {
      flash(result, "已保存。");
    }
  };

  const remove = async () => {
    if (!original) return;
    const result = await onDelete(original.id);
    if (result.ok) onClose();
    else flash(result, "");
  };

  const runNow = async () => {
    if (!original) return;
    const result = await onRunNow(original);
    // 成功后页面会跳转到运行会话；失败才需要在这里说明。
    if (!result.ok) flash(result, "");
  };

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l border-line bg-paper shadow-2xl"
        role="dialog"
        aria-label={isNew ? "新建自动化" : `编辑 ${original.title}`}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-accentSoft text-accent">
              <Icon name="automations" size={14} />
            </span>
            <div className="text-[13.5px] font-semibold tracking-tight">
              {isNew ? "新建自动化" : original.title}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="grid h-6 w-6 place-items-center rounded text-faint hover:bg-paper hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* body */}
        <div className="hairline-scroll flex-1 overflow-y-auto px-4 pb-4">
          <div className={GRP_H}>基本信息</div>
          <div className={`${GRP} divide-y divide-line`}>
            <Field label="名称">
              <input
                className={FIELD}
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder="每日晨报"
              />
            </Field>
            <Field stack label="指令" hint="每次运行时助理要完成的任务。">
              <textarea
                className={`${FIELD} min-h-[96px] leading-relaxed`}
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                placeholder="例如：整理今天的日程和未读邮件，生成一份晨报。"
              />
            </Field>
          </div>

          <div className={GRP_H}>计划</div>
          <div className={`${GRP} divide-y divide-line`}>
            {isOnce && original ? (
              <Field label="触发">
                <span className="block py-1 text-[12.5px] text-muted">
                  {scheduleText(original).text}（一次性任务不可改期）
                </span>
              </Field>
            ) : (
              <Field stack label="频率">
                <div className="flex flex-wrap gap-1.5">
                  {SCHEDULE_PRESETS.map((preset) => {
                    const active = draft.cron.trim() === preset.cron;
                    return (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() => setDraft({ ...draft, cron: preset.cron })}
                        className={`rounded-full border px-2.5 py-1 text-[12px] ${
                          active
                            ? "border-accent bg-accentSoft text-accent"
                            : "border-line bg-paper text-muted hover:border-lineStrong"
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
                <input
                  className={`${FIELD} mt-2 font-mono`}
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                  placeholder="0 9 * * *"
                  spellCheck={false}
                />
                <div className="mt-1 text-[11px]">
                  {cronError ? (
                    <span className="text-danger">{cronError}</span>
                  ) : cronPreview ? (
                    <span className="text-faint">{cronPreview}</span>
                  ) : (
                    <span className="text-faint">自定义 cron，按原样执行（分 时 日 月 周）</span>
                  )}
                </div>
              </Field>
            )}
            <Field label="启用" hint={draft.enabled ? "按计划自动运行" : "暂停后不会自动触发"}>
              <Switch
                checked={draft.enabled}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
              />
            </Field>
          </div>

          {!isNew && (
            <>
              <div className={GRP_H}>详情</div>
              <div className={`${GRP} divide-y divide-line`}>
                <Field label="工作区">
                  <span className="block truncate py-1 font-mono text-[11.5px] text-muted" title={original.workspace}>
                    {original.workspace || "—"}
                  </span>
                </Field>
                <Field label="已运行">
                  <span className="block py-1 text-[12.5px] text-muted">{original.run_count} 次</span>
                </Field>
              </div>
            </>
          )}

          {error && (
            <p className="mt-3 text-[12px] text-danger" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="mt-3 text-[12px] text-ok">{notice}</p>}
        </div>

        {/* footer */}
        <div className="border-t border-line bg-panel px-4 py-3">
          <div className="mb-2 text-[11px] leading-relaxed text-faint">
            仅在 openworker-server 运行时触发；错过的计划会在下次启动时补跑一次。
          </div>
          <div className="flex items-center gap-2">
            {!isNew &&
              (confirmingDelete ? (
                <span className="flex items-center gap-1.5">
                  <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => void remove()}>
                    确认删除
                  </button>
                  <button type="button" className={BTN} onClick={() => setConfirmingDelete(false)}>
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={BTN_DANGER}
                  disabled={busy}
                  onClick={() => setConfirmingDelete(true)}
                >
                  删除
                </button>
              ))}
            <span className="flex-1" />
            {!isNew && (
              <button
                type="button"
                className={BTN}
                disabled={busy}
                title="立即运行一次（打开实时会话）"
                onClick={() => void runNow()}
              >
                立即运行
              </button>
            )}
            <button
              type="button"
              className={BTN_ACCENT}
              disabled={busy || !!cronError}
              onClick={() => void save()}
            >
              {isNew ? "创建" : "保存"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
