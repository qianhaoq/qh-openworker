// Global event toasts: subtle, transient, top-right. `useToasts` owns the list and the
// auto-dismiss timers; `toastForEvent` maps a /ws/events AppEvent to toast copy (or null
// for events too noisy to surface); `Toasts` renders the stack.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppEvent } from "../lib/api/types";
import { Icon } from "./Icon";

export type ToastKind = "info" | "ok" | "warn" | "danger";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
}

const DISMISS_MS = 5200;
const MAX_VISIBLE = 4;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = nextId.current;
      nextId.current += 1;
      // Keep at most MAX_VISIBLE — drop the oldest rather than bury the screen.
      setToasts((list) => [...list.slice(-(MAX_VISIBLE - 1)), { ...toast, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), DISMISS_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

const pickString = (
  data: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
};

/** Map an app-wide event to toast copy. null = deliberately not toasted. */
export function toastForEvent(event: AppEvent): Omit<Toast, "id"> | null {
  const data = event.data;
  switch (event.type) {
    case "automation_run_started":
      return {
        kind: "info",
        title: "自动化开始运行",
        body: pickString(data, ["task_title"]),
      };
    case "agent_permission":
      return {
        kind: "warn",
        title: "Agent 请求权限",
        body: pickString(data, ["role"]),
      };
    // ACP per-session updates mirrored app-wide — far too noisy for global toasts.
    case "agent_event":
      return null;
    default:
      return {
        kind: "info",
        title: event.type.replace(/_/g, " "),
        body: pickString(data, ["title", "task_title", "name", "message"]),
      };
  }
}

const KIND_DOT: Record<ToastKind, string> = {
  info: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warnInk",
  danger: "bg-danger",
};

export interface ToastsProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function Toasts({ toasts, onDismiss }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed right-3.5 top-3.5 z-50 flex w-[320px] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast-enter flex items-start gap-2.5 rounded-xl2 border border-line bg-panel px-3.5 py-3 shadow-lg shadow-black/5"
        >
          <span
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${KIND_DOT[toast.kind]}`}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-snug">{toast.title}</div>
            {toast.body && (
              <div className="mt-0.5 truncate text-[12px] text-muted">{toast.body}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            title="关闭"
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-faint hover:text-ink"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
