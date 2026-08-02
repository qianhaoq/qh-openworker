// 设置页共享的小控件与样式常量:macOS System Settings 语法(分组内嵌列表 + 细分隔线)。
// 常量与 Segmented/Row/FormFooter 供六个 section 复用,避免每个文件各抄一份。

import type { ReactNode } from "react";

export const GRP =
  "overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]";
export const GRP_H = "mb-1.5 mt-6 px-1 text-[12px] font-semibold text-muted";
export const GRP_NOTE = "mt-2 px-1 text-[12px] leading-relaxed text-faint";
export const INPUT =
  "w-full rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink outline-none focus:border-lineStrong disabled:opacity-50";
export const BTN =
  "rounded-lg border border-line bg-paper px-3 py-1.5 text-[12.5px] text-ink hover:border-lineStrong disabled:opacity-40";
export const BTN_ACCENT =
  "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40";
export const TAG = "rounded px-1.5 py-0.5 text-[10.5px] font-semibold";

/** 页头:标题 + 一行说明。 */
export function SectionHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <header>
      <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{sub}</p>
    </header>
  );
}

/** 分段选择(浅色轨 + 白色选中块),radio 语义。 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      className="inline-flex gap-0.5 rounded-[10px] border border-line bg-line/40 p-[3px]"
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={
              "rounded-lg px-3 py-1 text-[12.5px] transition-colors " +
              (active
                ? "bg-panel font-medium text-ink shadow-sm ring-1 ring-line"
                : "text-muted hover:text-ink")
            }
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 表单行:左标签、右控件(可选 stack:标签在上、控件占满)。 */
export function Row({
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
        {hint && <div className="mt-1 text-[11px] leading-snug text-faint">{hint}</div>}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="shrink-0 text-[13px]">{label}</span>
      <span className="w-[240px]">
        {children}
        {hint && <span className="mt-1 block text-[11px] leading-snug text-faint">{hint}</span>}
      </span>
    </div>
  );
}

/** 表单底部:错误/成功提示 + 保存按钮(每组一个)。 */
export function FormFooter({
  busy,
  error,
  notice,
  disabled,
  saveLabel = "保存",
  onSave,
}: {
  busy: boolean;
  error: string | null;
  notice: string | null;
  disabled?: boolean;
  saveLabel?: string;
  onSave: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="min-w-0 truncate text-[12px]" role="status">
        {error ? (
          <span className="text-danger" role="alert">
            {error}
          </span>
        ) : notice ? (
          <span className="text-ok">{notice}</span>
        ) : null}
      </span>
      <button
        type="button"
        className={BTN_ACCENT + " shrink-0"}
        disabled={busy || disabled}
        onClick={onSave}
      >
        {busy ? "保存中…" : saveLabel}
      </button>
    </div>
  );
}
