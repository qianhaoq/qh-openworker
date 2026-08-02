import { describe, expect, it } from "vitest";
import type { MemoryScope, ProviderField, ProviderInfo, Settings } from "../../lib/api/types";
import type { DictationStatus } from "../../../tauri";
import {
  MEMORY_SCOPE_META,
  MEMORY_SCOPE_OPTIONS,
  apiErrorMessage,
  canRemoveModel,
  canSubmitProvider,
  clampInt,
  compactionDraftFromSettings,
  defaultModelOptions,
  dictationReady,
  downloadPercent,
  fieldKind,
  fieldVisible,
  formatBytes,
  formatContextWindow,
  initialProviderDraft,
  missingRequiredFields,
  modelAddNeedsProviderHint,
  modelDisplayName,
  parseCompactionDraft,
  parsePdfDraft,
  pdfDraftFromSettings,
  personaInstallBody,
  personaInstallMessage,
  providerStatus,
  relTime,
  validateMemoryDraft,
  validateModelDraft,
  validateScratchBase,
  validateWebSearchProvider,
  visibleProviderFields,
  voiceErrorMessage,
  type SettingsRead,
} from "./settingsLogic";

const field = (over: Partial<ProviderField>): ProviderField => ({
  key: "api_key",
  label: "API Key",
  secret: false,
  required: false,
  help: "",
  placeholder: "",
  ...over,
});

const provider = (over: Partial<ProviderInfo>): ProviderInfo => ({
  name: "demo",
  title: "Demo",
  needs_key: true,
  fields: [],
  configured: false,
  values: {},
  suggested_models: [],
  recommended_model: null,
  ...over,
});

const settings = (over: Partial<SettingsRead>): SettingsRead =>
  ({
    provider: "openai",
    model: "gpt-5",
    models: ["gpt-5"],
    has_key: true,
    model_ready: true,
    source: "store",
    onboarded: true,
    surfaces: { cowork: true, chat: true, code: false },
    scratch_base: "/tmp",
    secrets_path: "/tmp/secrets",
    ...over,
  }) as SettingsRead;

describe("clampInt", () => {
  it("clamps and rounds", () => {
    expect(clampInt(5, 1, 10)).toBe(5);
    expect(clampInt(0, 1, 10)).toBe(1);
    expect(clampInt(11, 1, 10)).toBe(10);
    expect(clampInt(4.6, 1, 10)).toBe(5);
  });
});

describe("apiErrorMessage", () => {
  it("prefers Error.message, then strings, then the fallback", () => {
    expect(apiErrorMessage(new Error("boom"))).toBe("boom");
    expect(apiErrorMessage("nope")).toBe("nope");
    expect(apiErrorMessage(null)).toBe("操作失败,请重试");
    expect(apiErrorMessage(new Error(""), "f")).toBe("f");
  });
});

describe("formatBytes", () => {
  it("renders MiB", () => {
    expect(formatBytes(0)).toBe("0 MiB");
    expect(formatBytes(147_964_211)).toBe("141 MiB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MiB");
  });
});

describe("formatContextWindow", () => {
  it("formats K and M", () => {
    expect(formatContextWindow(200_000)).toBe("200K");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
    expect(formatContextWindow(32_768)).toBe("32.8K");
    expect(formatContextWindow(0)).toBe("");
  });
});

describe("relTime", () => {
  const now = 1_000_000_000_000;
  it("covers 刚刚/分钟/小时/天 and null", () => {
    expect(relTime(null, now)).toBeNull();
    expect(relTime(now / 1000 - 30, now)).toBe("刚刚");
    expect(relTime(now / 1000 - 300, now)).toBe("5 分钟前");
    expect(relTime(now / 1000 - 7200, now)).toBe("2 小时前");
    expect(relTime(now / 1000 - 3 * 86400, now)).toBe("3 天前");
  });
});

describe("fieldKind", () => {
  it("choices wins, then secret, then text", () => {
    expect(fieldKind(field({ choices: [{ value: "a", label: "A" }] }))).toBe("choices");
    expect(fieldKind(field({ secret: true }))).toBe("secret");
    expect(fieldKind(field({}))).toBe("text");
    expect(fieldKind(field({ choices: [] }))).toBe("text");
  });
});

describe("initialProviderDraft", () => {
  it("prefills stored values, then defaults, then empty", () => {
    const p = provider({
      fields: [
        field({ key: "base_url" }),
        field({ key: "region", default: "us-east-1" }),
        field({ key: "api_key", secret: true }),
      ],
      values: { base_url: "https://x" },
    });
    expect(initialProviderDraft(p)).toEqual({
      base_url: "https://x",
      region: "us-east-1",
      api_key: "",
    });
  });
});

describe("show_when visibility", () => {
  const p = provider({
    fields: [
      field({ key: "auth_method", choices: [{ value: "api_key", label: "Key" }, { value: "iam", label: "IAM" }] }),
      field({ key: "api_key", secret: true, show_when: { auth_method: "api_key" } }),
      field({ key: "profile", show_when: { auth_method: "iam" } }),
    ],
  });

  it("hides fields whose show_when does not match the draft", () => {
    expect(fieldVisible(p.fields[1], { auth_method: "api_key" })).toBe(true);
    expect(fieldVisible(p.fields[1], { auth_method: "iam" })).toBe(false);
    expect(fieldVisible(p.fields[1], {})).toBe(false);
    expect(fieldVisible(p.fields[0], {})).toBe(true); // no show_when → always visible
  });

  it("visibleProviderFields filters by the draft", () => {
    expect(visibleProviderFields(p, { auth_method: "iam" }).map((f) => f.key)).toEqual([
      "auth_method",
      "profile",
    ]);
  });
});

describe("provider submit gating", () => {
  const p = provider({
    fields: [
      field({ key: "api_key", secret: true, required: true }),
      field({ key: "base_url", required: false }),
    ],
  });

  it("requires visible required fields when unconfigured", () => {
    expect(missingRequiredFields(p, { api_key: "" }).map((f) => f.key)).toEqual(["api_key"]);
    expect(canSubmitProvider(p, { api_key: "" })).toBe(false);
    expect(canSubmitProvider(p, { api_key: " sk " })).toBe(true);
  });

  it("configured providers may submit with blank fields (server falls back to stored)", () => {
    const configured = provider({ ...p, configured: true });
    expect(canSubmitProvider(configured, { api_key: "" })).toBe(true);
  });
});

describe("providerStatus", () => {
  it("已配置 / 无需密钥 / 未配置", () => {
    expect(providerStatus(provider({ configured: true, needs_key: true }))).toEqual({
      label: "已配置",
      tone: "ok",
    });
    expect(providerStatus(provider({ needs_key: false }))).toEqual({
      label: "无需密钥",
      tone: "faint",
    });
    expect(providerStatus(provider({}))).toEqual({ label: "未配置", tone: "faint" });
  });
});

describe("model helpers", () => {
  it("modelDisplayName splits the curated label", () => {
    expect(modelDisplayName("glm-5.2", { "glm-5.2": "GLM-5.2 · via Together" })).toBe("GLM-5.2");
    expect(modelDisplayName("custom")).toBe("custom");
  });

  it("defaultModelOptions prepends a default missing from the list", () => {
    expect(defaultModelOptions(settings({ models: ["a", "b"], model: "a" }) as Settings)).toEqual([
      "a",
      "b",
    ]);
    expect(defaultModelOptions(settings({ models: ["a"], model: "custom" }) as Settings)).toEqual([
      "custom",
      "a",
    ]);
  });

  it("validateModelDraft rejects empty, whitespace and duplicates", () => {
    expect(validateModelDraft(["a"], "  ")).toBe("请输入模型 ID");
    expect(validateModelDraft(["a"], "bad model")).toBe("模型 ID 不能包含空格或空白字符");
    expect(validateModelDraft(["a"], "openai:\tmodel")).toBe("模型 ID 不能包含空格或空白字符");
    expect(validateModelDraft(["a"], "a")).toBe("该模型已在列表中");
    expect(validateModelDraft(["a"], " b ")).toBeNull();
  });

  it("modelAddNeedsProviderHint follows the provider prefix (bare ids = default provider)", () => {
    const providers = [
      provider({ name: "openai", configured: true }),
      provider({ name: "zai", configured: false }),
    ];
    expect(modelAddNeedsProviderHint("openai:gpt-5.5", providers, "openai")).toBe(false);
    expect(modelAddNeedsProviderHint("zai:glm-5.2", providers, "openai")).toBe(true);
    expect(modelAddNeedsProviderHint("unknown:model", providers, "openai")).toBe(true);
    // 裸 id 走默认提供商。
    expect(modelAddNeedsProviderHint("gpt-5.5", providers, "openai")).toBe(false);
    expect(modelAddNeedsProviderHint("gpt-5.5", providers, "zai")).toBe(true);
    // 提供商列表未加载时不提示。
    expect(modelAddNeedsProviderHint("zai:glm-5.2", null, "openai")).toBe(false);
  });

  it("canRemoveModel guards the current default", () => {
    const s = settings({ model: "a", models: ["a", "b"] }) as Settings;
    expect(canRemoveModel(s, "a")).toBe(false);
    expect(canRemoveModel(s, "b")).toBe(true);
  });
});

describe("memory", () => {
  it("every scope has a label and the picker covers all scopes", () => {
    const scopes: MemoryScope[] = ["global", "workspace", "session"];
    for (const scope of scopes) {
      expect(MEMORY_SCOPE_META[scope].label).toBeTruthy();
      expect(MEMORY_SCOPE_OPTIONS).toContain(scope);
    }
    expect(MEMORY_SCOPE_OPTIONS[0]).toBe("workspace");
  });

  it("validateMemoryDraft rejects blank content", () => {
    expect(validateMemoryDraft("  ")).toBe("请输入记忆内容");
    expect(validateMemoryDraft("记得用中文回复")).toBeNull();
  });
});

describe("personaInstallBody", () => {
  it("builds the request per source mode and rejects blank input", () => {
    expect(personaInstallBody("git", " https://github.com/a/b ")).toEqual({
      git_url: "https://github.com/a/b",
    });
    expect(personaInstallBody("dir", "/tmp/p")).toEqual({ dir: "/tmp/p" });
    expect(personaInstallBody("git", "  ")).toBeNull();
  });

  it("install message mentions the count", () => {
    expect(personaInstallMessage(2)).toContain("2");
  });
});

describe("settings read", () => {
  it("reads experimental_connectors through SettingsRead", () => {
    const s = settings({ experimental_connectors: true });
    expect(s.experimental_connectors).toBe(true);
  });
});

describe("pdf draft", () => {
  it("round-trips settings into the form", () => {
    expect(pdfDraftFromSettings(settings({}))).toEqual({
      fallback: "text",
      maxPages: "20",
      maxMb: "10",
    });
    expect(
      pdfDraftFromSettings(settings({ pdf_fallback: "images", pdf_max_pages: 5, pdf_max_mb: 3 })),
    ).toEqual({ fallback: "images", maxPages: "5", maxMb: "3" });
  });

  it("parses a valid draft into the API patch", () => {
    const result = parsePdfDraft({ fallback: "images", maxPages: "30", maxMb: "8" });
    expect(result).toEqual({
      ok: true,
      patch: { pdf_fallback: "images", pdf_max_pages: 30, pdf_max_mb: 8 },
    });
  });

  it("rejects out-of-range values with Chinese errors", () => {
    expect(parsePdfDraft({ fallback: "text", maxPages: "0", maxMb: "5" })).toEqual({
      ok: false,
      error: "最大页数需为 1–100 的整数",
    });
    expect(parsePdfDraft({ fallback: "text", maxPages: "20", maxMb: "11" })).toEqual({
      ok: false,
      error: "最大大小需为 1–10 MB 的整数",
    });
  });
});

describe("compaction draft", () => {
  it("reads percent from the fraction", () => {
    expect(compactionDraftFromSettings(settings({}))).toEqual({
      thresholdPct: "80",
      capTokens: "250000",
      model: "",
    });
    expect(
      compactionDraftFromSettings(
        settings({ compaction_threshold_pct: 0.6, compaction_cap_tokens: 100_000, compaction_model: "m" }),
      ),
    ).toEqual({ thresholdPct: "60", capTokens: "100000", model: "m" });
  });

  it("parses back to the fraction patch", () => {
    const result = parseCompactionDraft({ thresholdPct: "70", capTokens: "150000", model: "m" });
    expect(result).toEqual({
      ok: true,
      patch: { compaction_threshold_pct: 0.7, compaction_cap_tokens: 150000, compaction_model: "m" },
    });
  });

  it("rejects bad ranges", () => {
    expect(parseCompactionDraft({ thresholdPct: "5", capTokens: "150000", model: "" }).ok).toBe(false);
    expect(parseCompactionDraft({ thresholdPct: "80", capTokens: "100", model: "" })).toEqual({
      ok: false,
      error: "token 上限需为 10000–2000000 的整数",
    });
  });
});

describe("scratch base / web search validation", () => {
  it("rejects blank paths and providers", () => {
    expect(validateScratchBase(" ")).toBe("请输入文件夹路径");
    expect(validateScratchBase("relative/path")).toBe("请输入绝对路径(以 / 或 ~/ 开头)");
    expect(validateScratchBase("..")).toBe("请输入绝对路径(以 / 或 ~/ 开头)");
    expect(validateScratchBase("/var/tmp/scratch")).toBeNull();
    expect(validateScratchBase("~/work")).toBeNull();
    expect(validateScratchBase("~")).toBeNull();
    expect(validateWebSearchProvider("")).toBe("请选择搜索提供商");
    expect(validateWebSearchProvider("brave")).toBeNull();
  });
});

describe("voice helpers", () => {
  const status = (over: Partial<DictationStatus>): DictationStatus => ({
    recording: false,
    model_installed: false,
    model_verified: false,
    test_passed: false,
    download_in_progress: false,
    model_name: "Whisper Base",
    model_bytes: 0,
    supported: true,
    device_summary: "macOS",
    compatibility_reason: null,
    ...over,
  });

  it("dictationReady needs support + verified model + passed test", () => {
    expect(dictationReady(null)).toBe(false);
    expect(dictationReady(status({}))).toBe(false);
    expect(
      dictationReady(status({ model_verified: true, test_passed: true })),
    ).toBe(true);
    expect(
      dictationReady(status({ supported: false, model_verified: true, test_passed: true })),
    ).toBe(false);
  });

  it("downloadPercent uses progress, falls back to model size, clamps at 100", () => {
    expect(downloadPercent(null, status({ model_bytes: 0 }))).toBe(0);
    expect(downloadPercent({ downloaded_bytes: 50, total_bytes: 200 }, null)).toBe(25);
    expect(downloadPercent({ downloaded_bytes: 300, total_bytes: 200 }, null)).toBe(100);
    expect(downloadPercent(null, status({ model_bytes: 200 }))).toBe(0);
  });

  it("voiceErrorMessage normalizes unknowns", () => {
    expect(voiceErrorMessage(new Error("mic denied"))).toBe("mic denied");
    expect(voiceErrorMessage(undefined)).toBe("语音输入操作失败,请重试");
  });
});
