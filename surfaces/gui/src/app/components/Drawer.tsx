import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DrawerProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  dirty?: boolean;
  closeConfirmText?: string;
  initialFocus?: string;
  onClose: () => void;
}

export function Drawer({
  title,
  children,
  footer,
  icon,
  dirty = false,
  closeConfirmText = "有未保存的修改，确定关闭？",
  initialFocus,
  onClose,
}: DrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const requestClose = () => {
    if (dirty && !window.confirm(closeConfirmText)) return;
    onClose();
  };

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = initialFocus ? panel.querySelector<HTMLElement>(initialFocus) : null;
    const fallback = panel.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? fallback ?? panel).focus();
    return () => returnFocusRef.current?.focus();
  }, [initialFocus]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.matches("input, textarea, select, [contenteditable='true']") ||
            target.closest("[data-escape-consumer='true']"))
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={requestClose} aria-hidden="true" />
      <aside
        ref={panelRef}
        className="fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l border-line bg-paper shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon}
            <div className="truncate text-[13.5px] font-semibold tracking-tight">{title}</div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            title="关闭"
            className="grid h-6 w-6 place-items-center rounded text-faint hover:bg-paper hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="hairline-scroll flex-1 overflow-y-auto">{children}</div>
        {footer}
      </aside>
    </>
  );
}
