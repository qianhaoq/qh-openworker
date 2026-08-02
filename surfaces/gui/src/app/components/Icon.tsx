// Inline SVG icon set — macOS-style stroke glyphs (24×24 grid, round caps), no icon
// dependency. Only the icons the shell actually uses live here; add one when a page
// needs it, not before.

import type { ReactNode } from "react";

export type IconName =
  | "brand"
  | "assistant"
  | "agents"
  | "missions"
  | "inbox"
  | "automations"
  | "integrations"
  | "settings"
  | "collapse"
  | "expand"
  | "close"
  | "plus"
  | "mic"
  | "stop"
  | "send"
  | "chevronDown"
  | "chevronRight"
  | "file"
  | "fileCode"
  | "image"
  | "folder"
  | "folderPlus"
  | "pin"
  | "archive"
  | "search"
  | "refresh"
  | "copy"
  | "external"
  | "trash"
  | "shield"
  | "sparkle"
  | "arrowLeft"
  | "panelRight"
  | "help"
  | "clock"
  | "check"
  | "alert"
  | "pencil"
  | "bell"
  | "play"
  | "sun"
  | "cpu"
  | "dots";

const PATHS: Record<IconName, ReactNode> = {
  // Brand mark — 「空盔与一缕在场」. The symmetric dome and pill visor stay
  // intentionally generic: no ears, fins, or borrowed character silhouette.
  brand: (
    <>
      <path d="M12 3c-5 0-8 3.6-8 8.4V16a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 16v-4.6C20 6.6 17 3 12 3Z" />
      <rect x="8.2" y="11.1" width="7.6" height="3.2" rx="1.6" fill="currentColor" stroke="none" />
      <path
        className="brand-smoke"
        d="M12 18.5c-.9.7-.9 1.6 0 2.4"
        strokeWidth="1.5"
      />
    </>
  ),
  // 助理 — chat bubble
  assistant: (
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  ),
  // Agents — person
  agents: (
    <>
      <circle cx="12" cy="7" r="4" />
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    </>
  ),
  // 任务 — check in a square
  missions: (
    <>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </>
  ),
  // 收件箱 — tray
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  // 自动化 — bolt
  automations: <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />,
  // 集成 — 2×2 grid
  integrations: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  // 设置 — gear
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  // 收起 / 展开侧栏 — double chevrons
  collapse: (
    <>
      <path d="M11 17l-5-5 5-5" />
      <path d="M18 17l-5-5 5-5" />
    </>
  ),
  expand: (
    <>
      <path d="M13 17l5-5-5-5" />
      <path d="M6 17l5-5-5-5" />
    </>
  ),
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  // 语音输入 — mic
  mic: (
    <>
      <rect x="8" y="3" width="8" height="13" rx="4" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="2" />,
  // 发送 — arrow up
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  fileCode: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M10 13l-2 2 2 2M14 13l2 2-2 2" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </>
  ),
  folder: (
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  ),
  folderPlus: (
    <>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  // 置顶 — bookmark
  pin: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />,
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </>
  ),
  refresh: (
    <>
      <path d="M23 4v6h-6M1 20v-6h6" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  external: (
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </>
  ),
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  // 计划 — four-point star
  sparkle: <path d="M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2z" />,
  arrowLeft: <path d="M19 12H5M12 19l-7-7 7-7" />,
  // 右侧面板开关
  panelRight: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  // 完成 / 通过 — check
  check: <path d="M20 6L9 17l-5-5" />,
  // 阻塞 / 警告 — alert triangle
  alert: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  // 编辑 — pencil
  pencil: <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
  // 通知 — bell
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  // 立即运行 — play triangle
  play: <path d="M7 4.5v15l12-7.5-12-7.5z" />,
  // 外观 — sun
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  // 模型 — chip
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="10" y="10" width="4" height="4" />
      <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
    </>
  ),
  // 更多操作 — 三个点
  dots: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  /** Brand smoke moves only while work is live; all other icons ignore this. */
  live?: boolean;
}

export function Icon({ name, size = 16, className, strokeWidth, live = false }: IconProps) {
  const brandClass =
    name === "brand"
      ? `${size <= 16 ? "brand-mark-compact" : "brand-mark-detailed"} ${live ? "brand-mark-live" : "brand-mark-idle"}`
      : "";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? (name === "brand" ? 2.4 : 1.8)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={[className, brandClass].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
