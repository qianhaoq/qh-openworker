// 收件箱页面的纯逻辑 — 类型元数据、时间与摘要格式化、每种 item 的 resolve payload 构造。
// 不依赖 React / window,全部在 inboxLogic.test.ts 里有单元测试。
//
// 后端契约(coworker/inbox.py + coworker/server/app.py:1750-1886):
// - approval: title "Run `tool`?",body = 原因 + args 预览,data 可带 {tool, arguments,
//   task_id, task_title, standing_target}(自动化运行 → 「始终允许」)。resolution 为
//   "allow" / "deny" / "always_task"(后端同时接受 once/always_tool/always_command/always)。
// - question(ask_user): title 即问题,options/allow_text/multi 控制快捷选项与自由输入;
//   resolution 就是回答文本(多选用 ", " 连接)。
// - directory: data = {path, writable};resolution 为 JSON {granted, path, writable}。
// - plan: body 即计划文本;resolution 为 JSON {approved, mode, feedback}。
// - notification 及其他: resolution "seen"(关闭)。

import type { IconName } from "../../components/Icon";
import type {
  AgentPermission,
  AgentPermissionOption,
  InboxItem,
} from "../../lib/api/types";

// ---------------------------------------------------------------------------
// kind 元数据
// ---------------------------------------------------------------------------

export interface KindMeta {
  icon: IconName;
  label: string;
  /** 图标底片的颜色(参照 AgentsPage 的角色 chip)。 */
  tint: string;
}

const KIND_META: Record<string, KindMeta> = {
  approval: { icon: "shield", label: "审批", tint: "bg-warnSoft text-warnInk" },
  question: { icon: "help", label: "提问", tint: "bg-accentSoft text-accent" },
  directory: { icon: "folder", label: "文件夹", tint: "bg-tealSoft text-tealInk" },
  plan: { icon: "sparkle", label: "计划", tint: "bg-okSoft text-ok" },
  notification: { icon: "bell", label: "通知", tint: "bg-solid text-muted" },
};

const FALLBACK_KIND: KindMeta = { icon: "inbox", label: "事项", tint: "bg-solid text-muted" };

export function kindMeta(kind: string): KindMeta {
  return KIND_META[kind] ?? FALLBACK_KIND;
}

// ---------------------------------------------------------------------------
// 时间格式化
// ---------------------------------------------------------------------------

/** 相对时长:「刚刚 / N 分钟前 / N 小时前 / N 天前」;超过 7 天落回「MM-DD」。 */
export function formatAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(time);
}

// ---------------------------------------------------------------------------
// 摘要(标题之外的第二行)
// ---------------------------------------------------------------------------

const collapse = (value: string): string => value.split(/\s+/).join(" ").trim();

const trunc = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** 与 coworker/inbox.py 的 args_preview 同构:k: v 用「 · 」连接,折叠空白并截断。 */
export function argsPreview(args: unknown, limit = 120): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    parts.push(`${key}: ${trunc(collapse(raw), 80)}`);
  }
  return trunc(parts.join(" · "), limit);
}

/** approval 条目对应的工具名(新版条目在 data.tool 里;旧条目没有)。 */
export function approvalTool(item: InboxItem): string {
  const tool = item.data?.tool;
  return typeof tool === "string" ? tool : "";
}

/** 自动化运行中发起的审批可以给出「始终允许」的常驻授权(§25)。 */
export function canAlwaysTask(item: InboxItem): boolean {
  return Boolean(item.data?.task_id && item.data?.standing_target);
}

/** 各类型的载荷摘要行;没有合适摘要时返回空串(调用方改渲染 body)。 */
export function itemSummary(item: InboxItem): string {
  switch (item.kind) {
    case "approval": {
      const tool = approvalTool(item);
      if (!tool) return "";
      const args = argsPreview(item.data?.arguments);
      return args ? `${tool} · ${args}` : tool;
    }
    case "directory": {
      const path = typeof item.data?.path === "string" ? item.data.path : "";
      if (!path) return "";
      return `${path}(${item.data?.writable ? "读写" : "只读"})`;
    }
    default:
      return "";
  }
}

/** 发起来源会话的显示名。 */
export function sessionLabel(item: InboxItem): string {
  return item.session_title || item.session_id;
}

// ---------------------------------------------------------------------------
// resolve payload 构造(POST /v1/inbox/{id}/resolve 的 `resolution` 字符串)
// ---------------------------------------------------------------------------

export type ApprovalDecision = "allow" | "deny" | "always_task";

export function approvalResolution(decision: ApprovalDecision): string {
  return decision;
}

/** directory:授权(带上路径与读写级别)或拒绝。 */
export function directoryResolution(granted: boolean, path?: string, writable?: boolean): string {
  if (!granted) return JSON.stringify({ granted: false });
  return JSON.stringify({ granted: true, path: path ?? "", writable: !!writable });
}

/** plan:批准(交互模式执行)或拒绝。 */
export function planResolution(approved: boolean): string {
  return approved
    ? JSON.stringify({ approved: true, mode: "interactive" })
    : JSON.stringify({ approved: false, feedback: "" });
}

/** question 多选:用「, 」连接(与旧版 InboxItemCard 一致)。 */
export function questionResolution(selected: readonly string[]): string {
  return selected.join(", ");
}

// ---------------------------------------------------------------------------
// 已处理视图
// ---------------------------------------------------------------------------

const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const APPROVAL_RESOLUTION_LABEL: Record<string, string> = {
  allow: "已允许",
  once: "已允许",
  deny: "已拒绝",
  always: "始终允许",
  always_tool: "始终允许",
  always_command: "始终允许",
  always_task: "始终允许(此任务)",
};

/** 已处理条目的处理结果一句话描述。 */
export function resolutionText(item: InboxItem): string {
  const resolution = item.resolution ?? "";
  if (resolution === "session deleted") return "会话已删除";
  switch (item.kind) {
    case "approval":
      return APPROVAL_RESOLUTION_LABEL[resolution] ?? (resolution ? `已处理:${resolution}` : "已处理");
    case "question":
      return resolution ? `已回答:${trunc(resolution, 60)}` : "已处理";
    case "directory": {
      const parsed = parseJson(resolution);
      if (parsed) {
        if (!parsed.granted) return "已拒绝授权";
        const path = typeof parsed.path === "string" && parsed.path ? ` ${parsed.path}` : "";
        return `已授权${path}`;
      }
      return resolution ? `已处理:${trunc(resolution, 60)}` : "已处理";
    }
    case "plan": {
      const parsed = parseJson(resolution);
      if (parsed) return parsed.approved ? "已批准计划" : "已拒绝计划";
      return resolution ? `已处理:${trunc(resolution, 60)}` : "已处理";
    }
    case "notification":
      return resolution === "seen" ? "已知晓" : resolution ? `已处理:${trunc(resolution, 60)}` : "已处理";
    default:
      return resolution ? `已处理:${trunc(resolution, 60)}` : "已处理";
  }
}

/** 待处理队列:按创建时间升序(先来先处理;服务端本身也按升序返回)。 */
export function pendingView(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** 已处理列表:最近处理的在前,最多 `limit` 条(后端返回全量历史)。 */
export function resolvedView(items: readonly InboxItem[], limit = 50): InboxItem[] {
  const key = (item: InboxItem) => item.resolved_at ?? item.created_at;
  return [...items].sort((a, b) => key(b).localeCompare(key(a))).slice(0, limit);
}

// ---------------------------------------------------------------------------
// ACP 权限请求(/v1/agent-permissions)
// ---------------------------------------------------------------------------

export function permissionOptionId(option: AgentPermissionOption): string {
  return String(option.optionId ?? option.option_id ?? option.id ?? "");
}

/** ACP 选项标签中文化:后端给的是英文 name(各 agent 不一致),未知的原样透传。 */
const PERMISSION_OPTION_LABEL: Record<string, string> = {
  "allow once": "允许一次",
  allow_once: "允许一次",
  "always allow": "始终允许",
  allow_always: "始终允许",
  always: "始终允许",
  reject: "拒绝",
  reject_once: "拒绝",
  reject_always: "拒绝",
  deny: "拒绝",
};

export function permissionOptionLabel(option: AgentPermissionOption): string {
  const label = option.name ?? (option as Record<string, unknown>).label;
  const raw = String(label ?? permissionOptionId(option) ?? "").trim();
  if (!raw) return "允许";
  return PERMISSION_OPTION_LABEL[raw.toLowerCase()] ?? raw;
}

/** ACP 选项里的拒绝类(kind 形如 reject_once;名字形如 "Reject")— 渲染成低调危险色。 */
export function permissionOptionIsDeny(option: AgentPermissionOption): boolean {
  const kind = String(option.kind ?? "").toLowerCase();
  if (kind.includes("reject") || kind.includes("deny")) return true;
  return /reject|deny|拒绝/i.test(String(option.name ?? ""));
}

export function permissionToolName(permission: AgentPermission): string {
  const call = permission.tool_call ?? {};
  const name = call.name ?? call.tool ?? call.title;
  return typeof name === "string" && name ? name : "工具调用";
}

/** tool_call 的紧凑单行 JSON(卡片的第二行,title 里放全文)。 */
export function permissionToolDetail(permission: AgentPermission, limit = 160): string {
  const call = permission.tool_call;
  if (!call || Object.keys(call).length === 0) return "";
  try {
    return trunc(JSON.stringify(call), limit);
  } catch {
    return "";
  }
}
