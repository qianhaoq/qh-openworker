// 设置页纯逻辑:provider 字段渲染模型(show_when/secret/choices)、各分组表单草稿与
// 校验、以及格式化助手。无 React、无 API —— 全部函数由 settingsLogic.test.ts 覆盖。
//
// 镜像的后端契约(coworker/server/app.py + manager.py):
// - ProviderField.show_when:仅当草稿中对应字段值等于指定值时该字段才渲染(如 Bedrock
//   的 auth_method 分段选择决定显示哪组凭证字段);verify/save 时空字段由服务端回退到
//   已存值,所以"已配置"的 provider 留空密钥也能验证。
// - GET /v1/settings 实际还返回 experimental_connectors,但 lib/api 的 Settings 类型
//   尚未声明 —— 这里用 SettingsRead 本地扩展,不改共享类型文件。
// - 记忆接口只有 GET/POST,没有删除端点,记忆区因此不提供删除。

import type {
  CompactionSettings,
  MemoryScope,
  PdfSettings,
  ProviderField,
  ProviderInfo,
  Settings,
} from "../../lib/api/types";
import type { DictationDownloadProgress, DictationStatus } from "../../../tauri";
import type { ThemePref } from "../../../theme";

/** GET /v1/settings 的完整形状(Settings 类型 + 服务端实际多给的字段)。 */
export type SettingsRead = Settings & { experimental_connectors?: boolean };

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

export const clampInt = (value: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, Math.round(value)));

/** 统一把 unknown 错误收敛成一行可读文案(ApiError 的 message 已带后端 detail)。 */
export const apiErrorMessage = (err: unknown, fallback = "操作失败,请重试"): string =>
  err instanceof Error && err.message ? err.message : typeof err === "string" && err ? err : fallback;

/** 表单解析结果:要么得到可提交的 patch,要么得到一条中文错误。 */
export type ParseResult<T> = { ok: true; patch: T } | { ok: false; error: string };

export const formatBytes = (bytes: number): string =>
  !bytes ? "0 MiB" : `${Math.round(bytes / 1024 / 1024)} MiB`;

/** 上下文窗口大小的紧凑写法:200000 → "200K",1000000 → "1M",32768 → "32.8K"。 */
export const formatContextWindow = (tokens: number): string => {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 ? m.toFixed(1) : m}M`;
  }
  const k = tokens / 1000;
  return `${k % 1 ? k.toFixed(1) : k}K`;
};

/** "2 小时前"式的中文相对时间(null = 从未使用)。 */
export const relTime = (epoch?: number | null, now = Date.now()): string | null => {
  if (!epoch) return null;
  const secs = Math.max(0, Math.floor(now / 1000 - epoch));
  if (secs < 90) return "刚刚";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs} 小时前`;
  return `${Math.floor(hrs / 24)} 天前`;
};

// ---------------------------------------------------------------------------
// 外观
// ---------------------------------------------------------------------------

export const THEME_OPTIONS: readonly { value: ThemePref; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "auto", label: "跟随系统" },
];

// ---------------------------------------------------------------------------
// 模型:providers
// ---------------------------------------------------------------------------

// 各提供商创建 API key 的直达链接(参考旧 ProviderSetup,UI 文案中文化)。
export const KEY_HELP: Record<string, { url: string; label: string }> = {
  anthropic: { url: "https://console.anthropic.com/settings/keys", label: "console.anthropic.com" },
  openai: { url: "https://platform.openai.com/api-keys", label: "platform.openai.com" },
  gemini: { url: "https://aistudio.google.com/apikey", label: "aistudio.google.com" },
  openrouter: { url: "https://openrouter.ai/keys", label: "openrouter.ai" },
  bedrock: { url: "https://console.aws.amazon.com/bedrock/home#/api-keys", label: "AWS Bedrock 控制台" },
  fireworks: { url: "https://fireworks.ai/account/api-keys", label: "fireworks.ai" },
  together: { url: "https://api.together.xyz/settings/api-keys", label: "together.xyz" },
  zai: { url: "https://z.ai/manage-apikey/apikey-list", label: "z.ai" },
  kimi: { url: "https://platform.moonshot.ai/console/api-keys", label: "platform.moonshot.ai" },
  deepseek: { url: "https://platform.deepseek.com/api_keys", label: "platform.deepseek.com" },
  mistral: { url: "https://console.mistral.ai/api-keys", label: "console.mistral.ai" },
  qwen: { url: "https://modelstudio.console.alibabacloud.com", label: "alibabacloud.com" },
  minimax: { url: "https://platform.minimax.io", label: "platform.minimax.io" },
  xai: { url: "https://console.x.ai", label: "console.x.ai" },
};

export type ProviderFieldKind = "choices" | "secret" | "text";

/** 字段渲染形态:有 choices → 分段选择;secret → 密码输入;其余 → 普通文本。 */
export const fieldKind = (field: ProviderField): ProviderFieldKind =>
  field.choices && field.choices.length > 0 ? "choices" : field.secret ? "secret" : "text";

/** 初始草稿:已存的非密值优先,其次字段默认值,最后空串(密钥永不回显)。 */
export const initialProviderDraft = (provider: ProviderInfo): Record<string, string> => {
  const draft: Record<string, string> = {};
  for (const field of provider.fields) {
    draft[field.key] = provider.values?.[field.key] || field.default || "";
  }
  return draft;
};

/** show_when 的每一条 key=value 都要与当前草稿值一致才渲染(与旧表单同语义)。 */
export const fieldVisible = (field: ProviderField, draft: Record<string, string>): boolean =>
  !field.show_when ||
  Object.entries(field.show_when).every(([key, want]) => (draft[key] || "") === want);

export const visibleProviderFields = (
  provider: ProviderInfo,
  draft: Record<string, string>,
): ProviderField[] => provider.fields.filter((field) => fieldVisible(field, draft));

/** 当前可见、必填、但草稿为空的字段 —— 用于未配置 provider 的提交门禁。 */
export const missingRequiredFields = (
  provider: ProviderInfo,
  draft: Record<string, string>,
): ProviderField[] =>
  visibleProviderFields(provider, draft).filter(
    (field) => field.required && !(draft[field.key] || "").trim(),
  );

/** 已配置的 provider 留空也能验证(服务端回退到已存值);未配置的必须填齐必填项。 */
export const canSubmitProvider = (
  provider: ProviderInfo,
  draft: Record<string, string>,
): boolean => provider.configured || missingRequiredFields(provider, draft).length === 0;

export interface ProviderStatus {
  label: string;
  tone: "ok" | "faint";
}

export type CredentialSource = "env" | "store" | "mixed" | null;

export function credentialSource(provider: ProviderInfo): CredentialSource {
  return provider.credential_source ?? provider.source ?? null;
}

export function credentialSourceLabel(source: CredentialSource): string | null {
  switch (source) {
    case "env":
      return "环境变量";
    case "store":
      return "本地密钥库";
    case "mixed":
      return "混合来源";
    default:
      return null;
  }
}

export const providerStatus = (provider: ProviderInfo): ProviderStatus => {
  if (provider.configured && provider.needs_key) return { label: "已配置", tone: "ok" };
  if (!provider.needs_key) return { label: "无需密钥", tone: "faint" };
  return { label: "未配置", tone: "faint" };
};

// ---------------------------------------------------------------------------
// 模型:默认模型与模型列表
// ---------------------------------------------------------------------------

/** 模型显示名:model_labels 的 "名字 · via 渠道" 取前半,缺失时回退原始 id。 */
export const modelDisplayName = (id: string, labels?: Record<string, string>): string =>
  labels?.[id]?.split(" · ")[0] || id;

/** 默认模型下拉的选项:默认模型不在列表里(自定义 id)时把它补到最前,避免下拉空白。 */
export const defaultModelOptions = (settings: Settings): string[] => {
  const models = settings.models || [];
  return settings.model && !models.includes(settings.model)
    ? [settings.model, ...models]
    : models;
};

export const validateModelDraft = (models: string[], draft: string): string | null => {
  const model = draft.trim();
  if (!model) return "请输入模型 ID";
  // 后端同样拒绝含空白的 id(映射见 lib/errorText.ts)—— 客户端先拦下。
  if (/\s/.test(model)) return "模型 ID 不能包含空格或空白字符";
  if (models.includes(model)) return "该模型已在列表中";
  return null;
};

/**
 * 刚添加的模型会不会被列表隐藏:服务端只下发「提供商已配置」的模型,所以提供商
 * 未配置时添加会表现为"静默无效"。provider 前缀 = `:` 之前的部分;裸 id 属于
 * 默认提供商(settings.provider)。providers 未加载完时不提示(返回 false)。
 */
export const modelAddNeedsProviderHint = (
  model: string,
  providers: ProviderInfo[] | null,
  defaultProvider: string,
): boolean => {
  if (!providers) return false;
  const idx = model.indexOf(":");
  const name = idx > 0 ? model.slice(0, idx) : defaultProvider;
  return !providers.some((provider) => provider.name === name && provider.configured);
};

/** 当前默认模型不可移除(先切换默认,再移除)。 */
export const canRemoveModel = (settings: Settings, model: string): boolean =>
  model !== settings.model;

// ---------------------------------------------------------------------------
// 记忆
// ---------------------------------------------------------------------------

export const MEMORY_SCOPE_META: Record<MemoryScope, { label: string; tint: string }> = {
  global: { label: "全局", tint: "bg-accentSoft text-accent" },
  workspace: { label: "工作区", tint: "bg-tealSoft text-tealInk" },
  session: { label: "会话", tint: "bg-solid text-muted" },
};

/** 添加表单的 scope 顺序(默认工作区,与 API 默认值一致)。 */
export const MEMORY_SCOPE_OPTIONS: readonly MemoryScope[] = ["workspace", "global", "session"];

export const validateMemoryDraft = (content: string): string | null =>
  content.trim() ? null : "请输入记忆内容";

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

export type PersonaInstallBody = { git_url: string } | { dir: string };

/** 安装来源 → 请求体;空输入返回 null(按钮应处于禁用态,这里是双保险)。 */
export const personaInstallBody = (
  mode: "git" | "dir",
  src: string,
): PersonaInstallBody | null => {
  const trimmed = src.trim();
  if (!trimmed) return null;
  return mode === "git" ? { git_url: trimmed } : { dir: trimmed };
};

export const personaInstallMessage = (count: number): string =>
  `已安装 ${count} 个 persona —— 默认处于停用状态,请在上方列表中启用。`;

// ---------------------------------------------------------------------------
// 高级:PDF(token 节省)
// ---------------------------------------------------------------------------

export interface PdfDraft {
  fallback: "text" | "images";
  maxPages: string;
  maxMb: string;
}

export const pdfDraftFromSettings = (settings: SettingsRead): PdfDraft => ({
  fallback: settings.pdf_fallback === "images" ? "images" : "text",
  maxPages: String(settings.pdf_max_pages ?? 20),
  maxMb: String(settings.pdf_max_mb ?? 10),
});

export const parsePdfDraft = (draft: PdfDraft): ParseResult<Partial<PdfSettings>> => {
  const pages = Number(draft.maxPages.trim());
  if (!Number.isInteger(pages) || pages < 1 || pages > 100) {
    return { ok: false, error: "最大页数需为 1–100 的整数" };
  }
  const mb = Number(draft.maxMb.trim());
  if (!Number.isInteger(mb) || mb < 1 || mb > 10) {
    return { ok: false, error: "最大大小需为 1–10 MB 的整数" };
  }
  return {
    ok: true,
    patch: { pdf_fallback: draft.fallback, pdf_max_pages: pages, pdf_max_mb: mb },
  };
};

// ---------------------------------------------------------------------------
// 高级:上下文压缩
// ---------------------------------------------------------------------------

export interface CompactionDraft {
  thresholdPct: string;
  capTokens: string;
  model: string;
}

export const compactionDraftFromSettings = (settings: SettingsRead): CompactionDraft => ({
  thresholdPct: String(Math.round((settings.compaction_threshold_pct ?? 0.8) * 100)),
  capTokens: String(settings.compaction_cap_tokens ?? 250_000),
  model: settings.compaction_model ?? "",
});

export const parseCompactionDraft = (
  draft: CompactionDraft,
): ParseResult<Partial<CompactionSettings>> => {
  const pct = Number(draft.thresholdPct.trim());
  if (!Number.isInteger(pct) || pct < 10 || pct > 95) {
    return { ok: false, error: "触发阈值需为 10–95 的整数百分比" };
  }
  const cap = Number(draft.capTokens.trim());
  if (!Number.isInteger(cap) || cap < 10_000 || cap > 2_000_000) {
    return { ok: false, error: "token 上限需为 10000–2000000 的整数" };
  }
  return {
    ok: true,
    patch: {
      compaction_threshold_pct: pct / 100,
      compaction_cap_tokens: cap,
      compaction_model: draft.model,
    },
  };
};

// ---------------------------------------------------------------------------
// 高级:文件 / 网络搜索 / 实验
// ---------------------------------------------------------------------------

/** 会话文件夹必须是绝对路径(/… 或 ~/…)—— 相对路径会被服务端解析到进程 CWD 下。 */
export const validateScratchBase = (path: string): string | null => {
  const p = path.trim();
  if (!p) return "请输入文件夹路径";
  if (!p.startsWith("/") && p !== "~" && !p.startsWith("~/")) {
    return "请输入绝对路径(以 / 或 ~/ 开头)";
  }
  return null;
};

export const validateWebSearchProvider = (provider: string): string | null =>
  provider ? null : "请选择搜索提供商";

// ---------------------------------------------------------------------------
// 语音(桌面端本地听写)
// ---------------------------------------------------------------------------

/** 就绪 = 设备兼容 + 模型已验证 + 麦克风测试通过(决定输入框麦克风的可用态)。 */
export const dictationReady = (status: DictationStatus | null): boolean =>
  !!status && status.supported && status.model_verified && status.test_passed;

export const downloadPercent = (
  progress: DictationDownloadProgress | null,
  status: DictationStatus | null,
): number => {
  const total = progress?.total_bytes || status?.model_bytes || 0;
  if (!total) return 0;
  return Math.min(100, Math.round(((progress?.downloaded_bytes || 0) / total) * 100));
};

export const voiceErrorMessage = (err: unknown): string =>
  apiErrorMessage(err, "语音输入操作失败,请重试");
