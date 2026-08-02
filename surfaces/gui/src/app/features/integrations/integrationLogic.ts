// Pure logic for the 集成 page: connector status derivation, brand monogram chips,
// MCP server form ↔ config mapping, routing/audit formatters. No React, no API —
// every function here is unit-tested in integrationLogic.test.ts.
//
// Contract notes (verified against coworker/server/app.py + connectors/descriptors.py):
// - Connectors carry per-kind account collections: Slack `workspaces`, GitHub
//   `installations`, Gmail/Calendar/generic `accounts`, HubSpot `portals`.
// - Connect endpoints never return an OAuth URL — the sidecar opens the system
//   browser itself and the GUI polls the list until the status flips.
// - MCP server `config` is either stdio ({command, args, env}) or remote
//   ({type:"http"|"sse", url, auth:"oauth"?}).

import type {
  AuditEntry,
  Connector,
  GithubStatus,
  InboxBinding,
  McpServer,
  SlackStatus,
} from "../../lib/api/types";

// ---------------------------------------------------------------------------
// Status tones (shared by every status dot / tag on the page)
// ---------------------------------------------------------------------------

export type StatusTone = "ok" | "warn" | "danger" | "accent" | "off";

export const TONE_DOT: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warnInk",
  danger: "bg-danger",
  accent: "bg-accent",
  off: "bg-faint/60",
};

// ---------------------------------------------------------------------------
// Connector brand chip (tinted monogram — no logo dependency)
// ---------------------------------------------------------------------------

const FALLBACK_BRAND = "#6b7280";
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

/** Soft-tint badge + solid dot styles derived from the server's brand_color. */
export function brandStyles(brandColor: string | undefined): {
  badge: { background: string; color: string };
  dot: { background: string };
} {
  const brand = brandColor && HEX_RE.test(brandColor.trim()) ? brandColor.trim() : FALLBACK_BRAND;
  return {
    badge: { background: `color-mix(in srgb, ${brand} 12%, transparent)`, color: brand },
    dot: { background: brand },
  };
}

/** The 1–2 char monogram inside the chip: the server `icon` glyph when it's short
 * ("#", "✉", "H"), else the title's first letter. */
export function monogram(c: Pick<Connector, "icon" | "title" | "name">): string {
  const icon = (c.icon || "").trim();
  if (icon && [...icon].length <= 2) return icon;
  const title = (c.title || c.name || "?").trim();
  return title ? [...title][0]!.toUpperCase() : "?";
}

// ---------------------------------------------------------------------------
// Connector status derivation
// ---------------------------------------------------------------------------

export interface ConnectorStatus {
  tone: StatusTone;
  /** Short label: 已连接 / 未连接 / 需要授权 / 不可用. */
  label: string;
  /** Quiet second line: 2 个工作区 · 中继 / acme@corp.com … */
  detail: string;
}

/** The per-kind noun for account collections. */
export function accountUnit(c: Pick<Connector, "name">): string {
  switch (c.name) {
    case "slack":
      return "工作区";
    case "github":
      return "安装";
    case "hubspot":
      return "门户";
    default:
      return "账户";
  }
}

/** How many accounts/workspaces/installations/portals the connector carries. */
export function accountCount(c: Connector): number {
  if (c.workspaces) return c.workspaces.length;
  if (c.installations) return c.installations.length;
  if (c.portals) return c.portals.length;
  if (c.accounts) return c.accounts.length;
  return c.connected ? 1 : 0;
}

/** True when any Gmail/Calendar account needs re-authorization. */
export function needsReauth(c: Connector): boolean {
  return (c.accounts ?? []).some((a) => "needs_reauth" in a && a.needs_reauth);
}

export function connectorStatus(c: Connector): ConnectorStatus {
  if (!c.available) return { tone: "off", label: "不可用", detail: c.blurb || "" };
  if (!c.connected) return { tone: "off", label: "未连接", detail: c.blurb || "" };
  const count = accountCount(c);
  const unit = accountUnit(c);
  let detail = count > 0 ? `${count} 个${unit}` : c.account || "已连接";
  if (c.name === "slack" && c.mode === "relay") detail += " · 中继";
  if (needsReauth(c)) return { tone: "warn", label: "需要授权", detail };
  return { tone: "ok", label: "已连接", detail };
}

/** Slack relay health — one honest layer at a time (sign-in → socket → live). */
export function slackHealthView(s: SlackStatus | null): { tone: StatusTone; text: string } {
  if (!s) return { tone: "ok", text: "实时 · 托管中继" };
  if (!s.signed_in) return { tone: "warn", text: "未登录云端 — 中继已暂停" };
  if (s.relay.state === "offline") return { tone: "off", text: "离线 — 无法连接中继" };
  if (s.relay.state === "reconnecting") return { tone: "warn", text: "正在重连中继…" };
  return { tone: "ok", text: "实时 · 托管中继" };
}

/** GitHub relay health — same layering as Slack. */
export function githubHealthView(g: GithubStatus | null): { tone: StatusTone; text: string } {
  if (!g) return { tone: "ok", text: "实时 · 托管中继" };
  if (!g.signed_in) return { tone: "warn", text: "未登录云端 — 中继已暂停" };
  if (g.relay.state === "offline") return { tone: "off", text: "离线 — 无法连接中继" };
  if (g.relay.state === "reconnecting") return { tone: "warn", text: "正在重连中继…" };
  return { tone: "ok", text: "实时 · 托管中继" };
}

export function enabledToolCount(c: Connector): { enabled: number; total: number } {
  const tools = c.tools ?? [];
  return { enabled: tools.filter((t) => t.enabled).length, total: tools.length };
}

/** Two-letter initials for a person chip. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return [...parts[0]!].slice(0, 2).join("").toUpperCase();
  return ([...parts[0]!][0]! + [...parts[parts.length - 1]!][0]!).toUpperCase();
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export function mcpStatusView(s: McpServer): { tone: StatusTone; label: string } {
  if (!s.enabled || s.status === "disabled") return { tone: "off", label: "已停用" };
  switch (s.status) {
    case "connected":
      return { tone: "ok", label: "已连接" };
    case "authorizing":
      return { tone: "accent", label: "授权中…" };
    case "needs_auth":
      return { tone: "warn", label: "需要授权" };
    case "configured":
      return { tone: "off", label: "未连接" };
    default:
      return { tone: "off", label: s.status || "未知" };
  }
}

/** One-line config summary for the list row: `npx -y server` or the remote URL. */
export function mcpConfigSummary(config: Record<string, unknown>): string {
  const command = typeof config.command === "string" ? config.command : "";
  if (command) {
    const args = Array.isArray(config.args) ? config.args.filter((a) => typeof a === "string") : [];
    return [command, ...(args as string[])].join(" ");
  }
  if (typeof config.url === "string") return config.url;
  return "";
}

export const isRemoteConfig = (config: Record<string, unknown>): boolean =>
  typeof config.url === "string" || config.type === "http" || config.type === "sse";

// -- add/edit drawer form ----------------------------------------------------

export interface McpFormState {
  name: string;
  transport: "stdio" | "http";
  command: string;
  /** JSON string array, e.g. ["-y","@scope/server"] — empty text means no args. */
  argsText: string;
  /** KEY=VALUE per line. */
  envText: string;
  url: string;
  oauth: boolean;
}

export const blankMcpForm = (): McpFormState => ({
  name: "",
  transport: "stdio",
  command: "",
  argsText: "",
  envText: "",
  url: "",
  oauth: false,
});

/** Prefill the drawer from an existing server (edit mode). */
export function mcpFormFromServer(s: McpServer): McpFormState {
  const config = s.config ?? {};
  const env = config.env && typeof config.env === "object" ? (config.env as Record<string, unknown>) : {};
  const envText = Object.entries(env)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  if (isRemoteConfig(config)) {
    return {
      name: s.name,
      transport: "http",
      command: "",
      argsText: "",
      envText,
      url: typeof config.url === "string" ? config.url : "",
      oauth: config.auth === "oauth",
    };
  }
  return {
    name: s.name,
    transport: "stdio",
    command: typeof config.command === "string" ? config.command : "",
    argsText: Array.isArray(config.args) ? JSON.stringify(config.args) : "",
    envText,
    url: "",
    oauth: false,
  };
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `["-y","pkg"]` → string[]; empty/blank text → []. Rejects non-string items. */
export function parseArgsText(text: string): ParseResult<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: [] };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      return { ok: false, error: "参数必须是 JSON 字符串数组" };
    }
    return { ok: true, value: parsed as string[] };
  } catch {
    return { ok: false, error: "参数不是合法的 JSON" };
  }
}

/** KEY=VALUE per line → a plain env record. Blank lines are skipped. */
export function parseEnvLines(text: string): ParseResult<Record<string, string>> {
  const env: Record<string, string> = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return { ok: false, error: `第 ${i + 1} 行应为 KEY=VALUE` };
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return { ok: true, value: env };
}

/** Form → the config record the sidecar stores. Validates required fields. */
export function configFromMcpForm(
  form: McpFormState,
): ParseResult<Record<string, unknown>> {
  if (!form.name.trim()) return { ok: false, error: "请填写名称" };
  const env = parseEnvLines(form.envText);
  if (!env.ok) return env;
  const withEnv = (config: Record<string, unknown>) =>
    Object.keys(env.value).length > 0 ? { ...config, env: env.value } : config;
  if (form.transport === "http") {
    const url = form.url.trim();
    if (!/^https?:\/\//.test(url)) return { ok: false, error: "请填写 http(s) 地址" };
    return {
      ok: true,
      value: withEnv({ type: "http", url, ...(form.oauth ? { auth: "oauth" } : {}) }),
    };
  }
  const command = form.command.trim();
  if (!command) return { ok: false, error: "请填写启动命令" };
  const args = parseArgsText(form.argsText);
  if (!args.ok) return args;
  return { ok: true, value: withEnv({ command, args: args.value }) };
}

/** The backend's redaction mask for stored env/header values (manager._redact). */
export const ENV_MASK = "***";

/**
 * Form → the PATCH change set for EDITING an existing server. The stored record
 * is flat and patch_global_server shallow-merges into it (coworker/mcp/config.py),
 * so:
 * - config keys go top-level (never a nested `config` key);
 * - switching transport must NULL the other side's keys, else a stale `url`
 *   keeps the server http (or a stale `command` litters a remote one);
 * - `env` is only included when the user actually touched the env text
 *   (envTouched) — the served config masks stored values with `***`, and a blind
 *   replace would clobber real secrets with the mask. Any remaining masked line
 *   after an edit is an explicit error: retype the real value.
 */
export function editChangesFromMcpForm(
  form: McpFormState,
  envTouched: boolean,
): ParseResult<Record<string, unknown>> {
  if (!form.name.trim()) return { ok: false, error: "请填写名称" };
  let changes: Record<string, unknown>;
  if (form.transport === "http") {
    const url = form.url.trim();
    if (!/^https?:\/\//.test(url)) return { ok: false, error: "请填写 http(s) 地址" };
    changes = {
      type: "http",
      url,
      auth: form.oauth ? "oauth" : null,
      command: null,
      args: null,
    };
  } else {
    const command = form.command.trim();
    if (!command) return { ok: false, error: "请填写启动命令" };
    const args = parseArgsText(form.argsText);
    if (!args.ok) return args;
    changes = { command, args: args.value, type: null, url: null, auth: null, headers: null };
  }
  if (envTouched) {
    const env = parseEnvLines(form.envText);
    if (!env.ok) return env;
    if (Object.values(env.value).some((v) => v === ENV_MASK)) {
      return { ok: false, error: "值为 *** 的是已保存的密钥 — 请重新输入真实值,或整段保留不改" };
    }
    changes.env = env.value;
  }
  return { ok: true, value: changes };
}

// ---------------------------------------------------------------------------
// 消息路由 (subscriptions / bindings / channels)
// ---------------------------------------------------------------------------

/** `slack:T01AB/C02XY` → { platform: "slack", target: "C02XY" }; no prefix → target = channel. */
export function splitChannel(channel: string): { platform: string; target: string } {
  const colon = channel.indexOf(":");
  if (colon < 0) return { platform: "", target: channel };
  const platform = channel.slice(0, colon);
  const rest = channel.slice(colon + 1);
  const target = rest.includes("/") ? rest.slice(rest.lastIndexOf("/") + 1) : rest;
  return { platform, target };
}

/** Display label for a subscription/binding channel: resolved name beats the raw id. */
export function channelLabel(channel: string, resolvedName?: string | null): string {
  if (resolvedName) return `#${resolvedName}`;
  return splitChannel(channel).target || channel;
}

/** Where an Inbox binding mirrors to: "Slack · C02XY", or 应用内 when channel is null. */
export function bindingTargetLabel(b: InboxBinding): string {
  if (!b.channel) return "应用内收件箱";
  const platform = b.channel.charAt(0).toUpperCase() + b.channel.slice(1);
  return `${platform} · ${b.target}`;
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/** Result tone from the entry status (engine.py: finished/denied/error/filtered/…). */
export function auditTone(e: Pick<AuditEntry, "status">): StatusTone {
  const s = (e.status || "").toLowerCase();
  if (s === "error" || s === "failed") return "danger";
  if (s === "denied" || s === "interrupted") return "warn";
  if (s === "ok" || s === "approved" || s === "allowed" || s === "success") return "ok";
  return "off";
}

/** `k=v  k2=v2` — non-string values JSON-encoded (arguments are sanitized server-side). */
export function formatAuditArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}

// ---------------------------------------------------------------------------
// Time formatters
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");

/** ISO timestamp → "MM-DD HH:mm" local time; unparseable input passes through. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Epoch seconds → same compact label as formatTimestamp. */
export function formatEpoch(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return formatTimestamp(new Date(ts * 1000).toISOString());
}

export function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
