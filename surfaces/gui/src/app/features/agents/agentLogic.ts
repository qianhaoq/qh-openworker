// Pure logic for the Agents page: presets → profile drafts, form validation, role →
// policy coupling, and capability/probe-state derivation. No React, no API — every
// function here is unit-tested in agentLogic.test.ts.
//
// Backend invariants this mirrors (coworker/orchestration/models.py + store.py):
// - New profiles always save DISABLED; enabling requires a capability probe whose stored
//   fingerprint matches the current runtime identity (role/transport/command/args/
//   model_profile/workspace_policy/permission_policy/secret_refs). The store clears
//   capabilities + disables on any identity-changing upsert, so "fingerprint set and
//   capabilities non-empty" on a served profile implies the probe is current.
// - reviewer profiles must be permission_policy="read-only" with no secret_refs.

import type { AgentCapabilities, AgentProfile, AgentRole, Transport } from "../../lib/api/types";

// ---------------------------------------------------------------------------
// Roles / transports
// ---------------------------------------------------------------------------

export const ROLE_ORDER: readonly AgentRole[] = ["main", "explorer", "executor", "reviewer", "gui"];

export interface RoleMeta {
  label: string;
  /** Tint classes for the 34px list badge (background + text). */
  tint: string;
  /** Tint classes for small tags. */
  tagTint: string;
  description: string;
}

export const ROLE_META: Record<AgentRole, RoleMeta> = {
  main: {
    label: "主",
    tint: "bg-accentSoft text-accent",
    tagTint: "bg-accentSoft text-accent",
    description: "拆解目标、协调团队与总结交付",
  },
  explorer: {
    label: "探索",
    tint: "bg-tealSoft text-tealInk",
    tagTint: "bg-tealSoft text-tealInk",
    description: "只读探索代码、定位上下文",
  },
  executor: {
    label: "执行",
    tint: "bg-okSoft text-ok",
    tagTint: "bg-okSoft text-ok",
    description: "在受控 worktree 中实现修改",
  },
  reviewer: {
    label: "审查",
    tint: "bg-reviewSoft text-reviewInk",
    tagTint: "bg-reviewSoft text-reviewInk",
    description: "只读审查 diff、测试与风险",
  },
  gui: {
    label: "GUI",
    tint: "bg-solid text-onSolid",
    tagTint: "bg-solid text-onSolid",
    description: "检查桌面交互、截图与可访问性",
  },
};

export const roleMeta = (role: string): RoleMeta =>
  ROLE_META[role as AgentRole] ?? {
    label: role || "Agent",
    tint: "bg-solid text-onSolid",
    tagTint: "bg-solid text-onSolid",
    description: "自定义 Agent 角色",
  };

export const TRANSPORT_LABEL: Record<Transport, string> = {
  acp_stdio: "ACP stdio",
  jsonl_rpc: "JSONL RPC",
  embedded: "内嵌",
};

export const transportLabel = (transport: string): string =>
  TRANSPORT_LABEL[transport as Transport] ?? transport;

/** Explorer/reviewer are read-only seats; the backend pins their policies. */
export const isReadOnlyRole = (role: string): boolean => role === "explorer" || role === "reviewer";

export const WORKSPACE_POLICIES = [
  { value: "worktree", label: "独立 worktree" },
  { value: "workspace", label: "当前 workspace" },
  { value: "readonly", label: "只读" },
] as const;

export const PERMISSION_POLICIES = [
  { value: "coding-default", label: "写入、Shell、网络需审批" },
  { value: "read-only", label: "宿主强制只读" },
  { value: "full-access", label: "Full Access（按 workspace 手动启用）" },
] as const;

// ---------------------------------------------------------------------------
// Presets → profile drafts
// ---------------------------------------------------------------------------

export interface AgentPreset {
  key: string;
  title: string;
  description: string;
  command: string;
  args: string[];
  role: AgentRole;
  transport: Transport;
  modelProfile: string | null;
  experimental?: boolean;
}

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    key: "claude-code",
    title: "Claude Code（Claude 订阅）",
    description: "自带 Claude Pro/Max 订阅登录态。",
    command: "npx",
    args: ["-y", "@zed-industries/claude-code-acp"],
    role: "main",
    transport: "acp_stdio",
    modelProfile: null,
  },
  {
    key: "codex",
    title: "Codex（ChatGPT 订阅）",
    description: "使用 ChatGPT Plus/Pro 订阅。",
    command: "npx",
    // codex-acp 内置的 codex 版本通常落后于本机 CLI：全局 config.toml 里的 model
    // （如 gpt-5.6-sol）它可能不认识，首轮即报 "requires a newer version of Codex"。
    // 用 -c 覆盖一个它认识的模型，避免读取全局默认。想换模型改这里即可。
    args: ["-y", "@zed-industries/codex-acp", "-c", 'model="gpt-5.5"'],
    role: "main",
    transport: "acp_stdio",
    modelProfile: null,
  },
  {
    key: "gemini",
    title: "Gemini CLI",
    description: "需要本机已安装 gemini。",
    command: "gemini",
    args: ["--experimental-acp"],
    role: "main",
    transport: "acp_stdio",
    modelProfile: null,
  },
  {
    key: "opencode",
    title: "OpenCode ACP",
    description: "默认本地 coding runtime，命令 opencode acp。",
    command: "opencode",
    args: ["acp"],
    role: "executor",
    transport: "acp_stdio",
    modelProfile: "deepseek-coder",
  },
  {
    key: "kimi",
    title: "Kimi ACP",
    description: "可作为主 Agent 或 GUI/Review 角色。",
    command: "kimi",
    args: ["acp"],
    role: "main",
    transport: "acp_stdio",
    modelProfile: "kimi-code/k3",
  },
  {
    key: "custom",
    title: "Custom ACP stdio",
    description: "注册任意本地 ACP stdio Agent。",
    command: "agent",
    args: ["acp"],
    role: "explorer",
    transport: "acp_stdio",
    modelProfile: null,
  },
  {
    key: "pi",
    title: "Pi JSONL",
    description: "实验性 adapter，默认禁用。",
    command: "pi",
    args: ["--mode", "rpc"],
    role: "executor",
    transport: "jsonl_rpc",
    modelProfile: null,
    experimental: true,
  },
];

/** The executable a preset relies on — the command's first word ("npx -y …" → "npx").
 * Fed to the detect endpoint for the preset cards' 已安装/未安装 badge. */
export const presetCommandName = (preset: AgentPreset): string =>
  preset.command.split(/\s+/)[0] ?? preset.command;

/** "opencode-executor" → "opencode-executor-2" → … until free of `existingIds`. */
export function uniqueProfileId(base: string, existingIds: ReadonlySet<string>): string {
  const cleaned = base.trim() || "agent";
  if (!existingIds.has(cleaned)) return cleaned;
  for (let n = 2; ; n += 1) {
    const candidate = `${cleaned}-${n}`;
    if (!existingIds.has(candidate)) return candidate;
  }
}

/** A disabled draft profile from a preset, with an id that does not collide with the list. */
export function profileFromPreset(preset: AgentPreset, existingIds: ReadonlySet<string>): AgentProfile {
  const readonly = isReadOnlyRole(preset.role);
  return {
    id: uniqueProfileId(`${preset.key}-${preset.role}`, existingIds),
    role: preset.role,
    transport: preset.transport,
    command: preset.command,
    args: [...preset.args],
    model_profile: preset.modelProfile,
    workspace_policy: readonly ? "readonly" : "worktree",
    permission_policy: readonly ? "read-only" : "coding-default",
    secret_refs: [],
    limits: { timeout_seconds: 1800, max_cost: 5 },
    enabled: false,
    capabilities: {},
    capability_probe_fingerprint: null,
  };
}

/** A blank custom profile — the "从零开始" add path. */
export function blankProfile(existingIds: ReadonlySet<string>): AgentProfile {
  return {
    id: uniqueProfileId("custom-main", existingIds),
    role: "main",
    transport: "acp_stdio",
    command: "",
    args: [],
    model_profile: null,
    workspace_policy: "worktree",
    permission_policy: "coding-default",
    secret_refs: [],
    limits: { timeout_seconds: 1800, max_cost: 5 },
    enabled: false,
    capabilities: {},
    capability_probe_fingerprint: null,
  };
}

/**
 * Role switch side-effects on an editor draft (mirrors the old FleetPage): read-only
 * roles pin readonly/read-only policies and reviewers drop secret refs; switching back
 * to a writable role restores the writable defaults.
 */
export function applyRoleToDraft(draft: AgentProfile, role: AgentRole): AgentProfile {
  const readonly = isReadOnlyRole(role);
  return {
    ...draft,
    role,
    workspace_policy: readonly
      ? "readonly"
      : draft.workspace_policy === "readonly"
        ? "worktree"
        : draft.workspace_policy,
    permission_policy: readonly
      ? "read-only"
      : draft.permission_policy === "read-only"
        ? "coding-default"
        : draft.permission_policy,
    secret_refs: role === "reviewer" ? [] : draft.secret_refs,
  };
}

// ---------------------------------------------------------------------------
// Field parsing / validation
// ---------------------------------------------------------------------------

export type ArgsParse = { ok: true; args: string[] } | { ok: false; error: string };

/** Args editor input: must be a JSON array of strings ("" and "[]" both mean no args). */
export function parseArgsJson(text: string): ArgsParse {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, args: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "args 不是合法的 JSON" };
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    return { ok: false, error: "args 必须是字符串 JSON 数组" };
  }
  return { ok: true, args: parsed as string[] };
}

/** secret_refs are reference NAMES (secrets live in the local store) — comma/space separated. */
export function parseSecretRefs(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export const formatSecretRefs = (refs: readonly string[]): string => refs.join(", ");

export const commandSummary = (profile: Pick<AgentProfile, "command" | "args">): string =>
  [profile.command, ...(profile.args ?? [])].filter(Boolean).join(" ");

/** Client-side mirror of the backend's save-time checks; returns the first error or null. */
export function validateProfile(
  draft: AgentProfile,
  existingIds: ReadonlySet<string>,
  originalId: string | null,
): string | null {
  const id = draft.id.trim();
  if (!id) return "Profile ID 不能为空";
  if (id !== originalId && existingIds.has(id)) return `Profile ID "${id}" 已存在`;
  if (!draft.command.trim()) return "Command 不能为空";
  if (draft.role === "reviewer") {
    if (draft.permission_policy !== "read-only") return "审查角色必须使用宿主强制只读权限";
    if (draft.secret_refs.length > 0) return "审查角色不能引用 secret";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Capabilities / probe state
// ---------------------------------------------------------------------------

// ACP probes persist the InitializeResponse (camelCase aliases: loadSession,
// promptCapabilities.{image,audio,embeddedContext}, mcpCapabilities.{http,sse},
// agentInfo); the JSONL adapter persists {transport, state}. Tolerate snake_case too.

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const pick = (source: Record<string, unknown> | null, ...keys: string[]): unknown => {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined) return source[key];
  }
  return undefined;
};

/** Short capability tags for probed profiles, e.g. ["loadSession", "image", "MCP"]. */
export function capabilityBadges(capabilities: AgentCapabilities): string[] {
  const badges: string[] = [];
  const agentCaps = asRecord(pick(asRecord(capabilities), "agentCapabilities", "agent_capabilities"));
  if (pick(agentCaps, "loadSession", "load_session") === true) badges.push("loadSession");
  const prompt = asRecord(pick(agentCaps, "promptCapabilities", "prompt_capabilities"));
  if (prompt?.image === true) badges.push("image");
  if (prompt?.audio === true) badges.push("audio");
  if (prompt?.embeddedContext === true || prompt?.embedded_context === true) badges.push("context");
  const mcp = asRecord(pick(agentCaps, "mcpCapabilities", "mcp_capabilities"));
  if (mcp && (mcp.http === true || mcp.sse === true)) badges.push("MCP");
  if (capabilities.transport === "jsonl_rpc" && capabilities.state !== undefined) badges.push("state");
  return badges;
}

/** The probed runtime's self-reported name/version, when the transport provides one. */
export function agentInfoLine(capabilities: AgentCapabilities): string | null {
  const info = asRecord(pick(asRecord(capabilities), "agentInfo", "agent_info"));
  if (!info) return null;
  const name = typeof info.title === "string" && info.title ? info.title : info.name;
  const version = typeof info.version === "string" ? info.version : "";
  if (typeof name !== "string" || !name) return null;
  return version ? `${name} v${version}` : name;
}

export type ProbeView = "unprobed" | "probing" | "probed" | "failed";

/**
 * Row-level probe state. `probing`/`error` are the in-flight result; otherwise the
 * stored profile decides (the server keeps fingerprint+capabilities consistent).
 */
export function probeView(profile: AgentProfile, probing: boolean, error?: string): ProbeView {
  if (probing) return "probing";
  if (error) return "failed";
  if (profile.capability_probe_fingerprint && Object.keys(profile.capabilities ?? {}).length > 0) {
    return "probed";
  }
  return "unprobed";
}

export const PROBE_VIEW_LABEL: Record<ProbeView, string> = {
  unprobed: "未探测",
  probing: "探测中",
  probed: "已探测",
  failed: "探测失败",
};

/** Enabling is gated on a current probe (the backend rejects the upsert otherwise). */
export function canEnable(profile: AgentProfile, view: ProbeView): boolean {
  return !profile.enabled && view === "probed";
}

/** Usable in a mission seat: enabled AND a current stored probe (the same stored-state
 * rule probeView applies — fingerprint set + capabilities non-empty). The backend
 * rejects mission create/confirm otherwise. */
export function isProfileUsable(profile: AgentProfile): boolean {
  return profile.enabled && probeView(profile, false) === "probed";
}

/** At least one seat-usable executor exists (the create-mission pre-check). */
export function hasUsableExecutor(profiles: readonly AgentProfile[]): boolean {
  return profiles.some((profile) => profile.role === "executor" && isProfileUsable(profile));
}

/** Seat ids (profile ids) in `profileIds` that are not seat-usable — unknown, disabled
 * or unprobed (the confirm-plan pre-check; the backend's 409 names the same ids). */
export function unusableProfileIds(
  profileIds: readonly string[],
  profiles: readonly AgentProfile[],
): string[] {
  return profileIds.filter((id) => {
    const profile = profiles.find((item) => item.id === id);
    return !profile || !isProfileUsable(profile);
  });
}

/** Setting the workspace main needs an enabled role=main profile (backend-enforced). */
export function canSetMain(profile: AgentProfile): boolean {
  return profile.role === "main" && profile.enabled;
}
