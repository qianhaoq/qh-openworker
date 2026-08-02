// 单个收件箱条目的卡片:图标 + 标题 + 会话引用 + 时间 + 载荷摘要,按 kind 渲染操作区。
// 待处理:approval 允许/拒绝(自动化运行可「始终允许」)、question 快捷选项 + 自由输入、
// directory 授权/拒绝、plan 批准/拒绝、notification 知晓关闭。已处理:只读,显示处理结果。

import { useState } from "react";
import { Icon } from "../../components/Icon";
import type { InboxItem } from "../../lib/api/types";
import {
  approvalResolution,
  canAlwaysTask,
  directoryResolution,
  formatAge,
  itemSummary,
  kindMeta,
  planResolution,
  questionResolution,
  resolutionText,
  sessionLabel,
} from "./inboxLogic";

const BTN_PRIMARY =
  "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40 disabled:hover:brightness-100";
const BTN_BORDERED =
  "rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:border-lineStrong disabled:opacity-40";
const BTN_QUIET = "px-3 py-1.5 text-[12.5px] text-faint hover:text-danger disabled:opacity-40";
const OPT_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors disabled:opacity-40";
const OPT_OFF = "border-line bg-panel text-ink hover:border-accent hover:bg-accentSoft/50";
const OPT_ON = "border-accent bg-accentSoft text-accent font-medium";
const INPUT =
  "min-w-0 flex-1 rounded-lg border border-line bg-paper px-3 py-2 text-[13px] text-ink outline-none placeholder:text-faint focus:border-lineStrong";

export interface InboxItemCardProps {
  item: InboxItem;
  busy: boolean;
  onResolve: (item: InboxItem, resolution: string) => void;
  onOpenSession: (item: InboxItem) => void;
}

export function InboxItemCard({ item, busy, onResolve, onOpenSession }: InboxItemCardProps) {
  const meta = kindMeta(item.kind);
  const summary = itemSummary(item);
  const isResolved = item.state === "resolved";
  const sessionExists = item.session_exists !== false;

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg ${meta.tint}`}
        >
          <Icon name={meta.icon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] font-medium leading-snug">
              {item.title}
            </span>
            <span
              className="shrink-0 text-[11px] text-faint"
              title={isResolved ? item.resolved_at ?? item.created_at : item.created_at}
            >
              {isResolved ? formatAge(item.resolved_at) || formatAge(item.created_at) : formatAge(item.created_at)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-faint">
            <span>{meta.label}</span>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              disabled={!sessionExists}
              title={sessionExists ? `打开会话「${sessionLabel(item)}」` : "会话已删除"}
              onClick={() => onOpenSession(item)}
              className="group inline-flex min-w-0 items-center gap-0.5 text-muted enabled:hover:text-accent disabled:cursor-default disabled:opacity-60"
            >
              <span className="truncate enabled:group-hover:underline">{sessionLabel(item)}</span>
              {sessionExists && <Icon name="chevronRight" size={12} className="shrink-0" />}
            </button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="mt-2 truncate font-mono text-[11.5px] text-muted" title={summary}>
          {summary}
        </div>
      )}
      {item.body && (
        <div
          className={`mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-muted ${
            item.kind === "plan" ? "hairline-scroll max-h-56 overflow-y-auto" : ""
          }`}
        >
          {item.body}
        </div>
      )}

      {isResolved ? (
        <div className="mt-2.5 flex items-center gap-1.5 text-[12px] text-faint">
          <Icon name="check" size={13} className="text-ok" />
          {resolutionText(item)}
        </div>
      ) : (
        <Actions item={item} busy={busy} onResolve={onResolve} />
      )}
    </div>
  );
}

function Actions({
  item,
  busy,
  onResolve,
}: {
  item: InboxItem;
  busy: boolean;
  onResolve: (item: InboxItem, resolution: string) => void;
}) {
  switch (item.kind) {
    case "approval":
      return (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy}
            onClick={() => onResolve(item, approvalResolution("allow"))}
          >
            允许
          </button>
          {canAlwaysTask(item) && (
            <button
              type="button"
              className={BTN_BORDERED}
              disabled={busy}
              title={`针对「${String(item.data?.task_title || "此自动化")}」始终允许 — 可随时在它的自动化页面撤销`}
              onClick={() => onResolve(item, approvalResolution("always_task"))}
            >
              始终允许
            </button>
          )}
          <button
            type="button"
            className={BTN_QUIET}
            disabled={busy}
            onClick={() => onResolve(item, approvalResolution("deny"))}
          >
            拒绝
          </button>
        </div>
      );
    case "question":
      return <QuestionActions item={item} busy={busy} onResolve={onResolve} />;
    case "directory":
      return (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy || !item.data?.path}
            title={typeof item.data?.path === "string" ? item.data.path : "未建议文件夹"}
            onClick={() =>
              onResolve(
                item,
                directoryResolution(
                  true,
                  typeof item.data?.path === "string" ? item.data.path : "",
                  !!item.data?.writable,
                ),
              )
            }
          >
            授权访问
          </button>
          <button
            type="button"
            className={BTN_BORDERED}
            disabled={busy}
            onClick={() => onResolve(item, directoryResolution(false))}
          >
            拒绝
          </button>
        </div>
      );
    case "plan":
      return (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy}
            onClick={() => onResolve(item, planResolution(true))}
          >
            批准并执行
          </button>
          <button
            type="button"
            className={BTN_BORDERED}
            disabled={busy}
            onClick={() => onResolve(item, planResolution(false))}
          >
            拒绝
          </button>
        </div>
      );
    default:
      // notification 以及任何未知类型:知晓后关闭。
      return (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            className={BTN_BORDERED}
            disabled={busy}
            onClick={() => onResolve(item, "seen")}
          >
            知道了
          </button>
        </div>
      );
  }
}

/** question:快捷选项(单选即答,多选后提交)+ 自由输入(allow_text 或没有选项时)。 */
function QuestionActions({
  item,
  busy,
  onResolve,
}: {
  item: InboxItem;
  busy: boolean;
  onResolve: (item: InboxItem, resolution: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const options = item.options ?? [];
  const multi = !!item.multi;
  const allowText = item.allow_text !== false;

  return (
    <>
      {options.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {options.map((option) => {
            const on = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                className={`${OPT_BASE} ${on ? OPT_ON : OPT_OFF}`}
                disabled={busy}
                onClick={() => {
                  if (multi) {
                    setSelected((current) =>
                      on ? current.filter((entry) => entry !== option) : [...current, option],
                    );
                  } else {
                    onResolve(item, option); // 单选立即提交
                  }
                }}
              >
                {multi && on && <span className="text-[11px] leading-none text-accent">✓</span>}
                {option}
              </button>
            );
          })}
        </div>
      )}
      {multi && options.length > 0 && (
        <div className="mt-2.5">
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy || selected.length === 0}
            onClick={() => onResolve(item, questionResolution(selected))}
          >
            发送{selected.length > 0 ? `(${selected.length})` : ""}
          </button>
        </div>
      )}
      {(allowText || options.length === 0) && (
        <div className="mt-2.5 flex items-center gap-2">
          <input
            className={INPUT}
            placeholder={options.length > 0 ? "或者输入你自己的回答…" : "输入回答…"}
            value={answer}
            disabled={busy}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && answer.trim()) onResolve(item, answer.trim());
            }}
          />
          <button
            type="button"
            className={BTN_PRIMARY}
            disabled={busy || !answer.trim()}
            onClick={() => onResolve(item, answer.trim())}
          >
            发送
          </button>
        </div>
      )}
    </>
  );
}
