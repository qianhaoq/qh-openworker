// 模型:默认模型下拉、模型列表增删、提供商列表 + 右侧抽屉配置(字段按 ProviderField
// 渲染:choices → 分段选择,secret → 密码框;show_when 决定可见性)。保存走
// POST /v1/providers；验证是独立的 /v1/providers/verify 只读动作。

import { useEffect, useState } from "react";
import {
  addModel,
  getProviders,
  removeModel,
  removeProvider,
  setDefaultModel,
  setProvider,
  verifyProvider,
} from "../../lib/api/settings";
import type { ProviderField, ProviderInfo } from "../../lib/api/types";
import { Icon } from "../../components/Icon";
import { openExternal } from "../../../tauri";
import {
  BTN,
  BTN_ACCENT,
  GRP,
  GRP_H,
  GRP_NOTE,
  INPUT,
  Row,
  SectionHeader,
  TAG,
} from "./controls";
import {
  KEY_HELP,
  apiErrorMessage,
  canRemoveModel,
  canSubmitProvider,
  credentialSource,
  credentialSourceLabel,
  defaultModelOptions,
  fieldKind,
  formatContextWindow,
  initialProviderDraft,
  modelAddNeedsProviderHint,
  modelDisplayName,
  providerStatus,
  relTime,
  validateModelDraft,
  visibleProviderFields,
} from "./settingsLogic";
import { humanizeErrorText } from "../../lib/errorText";
import { useSettings } from "./useSettings";

type Verify = { state: "idle" | "testing" | "ok" | "error"; msg?: string };

function ProviderEditor({
  provider,
  onClose,
  onChanged,
}: {
  provider: ProviderInfo;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => initialProviderDraft(provider));
  const [dirty, setDirty] = useState(false);
  const [verify, setVerify] = useState<Verify>({ state: "idle" });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const setFieldValue = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setVerify({ state: "idle" });
  };

  const status = providerStatus(provider);
  const sourceLabel = credentialSourceLabel(credentialSource(provider));
  const keyHelp = KEY_HELP[provider.name];
  const submitLabel = "保存";

  const submit = async () => {
    setVerify({ state: "testing" });
    try {
      const saved = await setProvider(provider.name, draft);
      if (!saved.ok) {
        setVerify({ state: "error", msg: saved.error || "保存失败" });
        return;
      }
      setVerify({
        state: "ok",
        msg: saved.recommended_model
          ? `已保存 · 推荐模型 ${saved.recommended_model}`
          : "已保存",
      });
      setDirty(false);
      onChanged();
    } catch (err) {
      setVerify({ state: "error", msg: apiErrorMessage(err) });
    }
  };

  const verifyOnly = async () => {
    setVerify({ state: "testing" });
    try {
      const checked = await verifyProvider(provider.name, draft);
      setVerify(
        checked.ok
          ? { state: "ok", msg: "验证通过" }
          : { state: "error", msg: checked.error || "验证失败" },
      );
    } catch (err) {
      setVerify({ state: "error", msg: apiErrorMessage(err, "验证失败") });
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const res = await removeProvider(provider.name);
      if (!res.ok) {
        setVerify({ state: "error", msg: res.error || "移除失败" });
        setConfirmRemove(false);
        return;
      }
      onChanged();
      onClose();
    } catch (err) {
      setVerify({ state: "error", msg: apiErrorMessage(err) });
      setConfirmRemove(false);
    } finally {
      setRemoving(false);
    }
  };

  const fieldView = (f: ProviderField) => {
    const kind = fieldKind(f);
    if (kind === "choices") {
      const current = draft[f.key] || f.default || "";
      const selected = f.choices?.find((choice) => choice.value === current);
      return (
        <div key={f.key} className="px-4 py-2.5">
          <div className="text-[13px]">{f.label}</div>
          <div
            className="mt-1.5 inline-flex gap-0.5 rounded-[10px] border border-line bg-line/40 p-[3px]"
            role="radiogroup"
            aria-label={f.label}
          >
            {(f.choices || []).map((choice) => {
              const active = choice.value === current;
              return (
                <button
                  key={choice.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setFieldValue(f.key, choice.value)}
                  className={
                    "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1 text-[12.5px] transition-colors " +
                    (active
                      ? "bg-panel font-medium text-ink shadow-sm ring-1 ring-line"
                      : "text-muted hover:text-ink")
                  }
                >
                  {choice.label}
                  {choice.tag && (
                    <span className={`${TAG} bg-accentSoft text-accent`}>{choice.tag}</span>
                  )}
                </button>
              );
            })}
          </div>
          {selected?.desc && <p className="mt-1.5 text-[11.5px] text-muted">{selected.desc}</p>}
          {selected?.command && (
            <button
              type="button"
              className="mt-1.5 inline-flex items-center gap-2 rounded-md border border-line bg-paper px-2 py-1 font-mono text-[11.5px] text-ink hover:border-lineStrong"
              title="复制命令"
              onClick={() => void navigator.clipboard?.writeText(selected.command || "")}
            >
              {selected.command}
              <Icon name="copy" size={12} className="text-faint" />
            </button>
          )}
          {f.help && <p className="mt-1 text-[11px] leading-snug text-faint">{f.help}</p>}
        </div>
      );
    }
    return (
      <Row key={f.key} label={f.required ? `${f.label} *` : f.label} hint={f.help || undefined}>
        <input
          className={INPUT}
          type={kind === "secret" ? "password" : "text"}
          placeholder={
            kind === "secret" && provider.configured && !dirty
              ? "已保存,输入以替换"
              : f.placeholder
          }
          value={draft[f.key] || ""}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setFieldValue(f.key, e.target.value)}
        />
      </Row>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l border-line bg-paper shadow-2xl"
        role="dialog"
        aria-label={`配置 ${provider.title}`}
      >
        <div className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[13.5px] font-semibold tracking-tight">
              {provider.title}
            </div>
            <span className={`${TAG} ${status.tone === "ok" ? "bg-okSoft text-ok" : "bg-solid text-muted"}`}>
              {status.label}
            </span>
            {sourceLabel && (
              <span className={`${TAG} bg-accentSoft text-accent`}>{sourceLabel}</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="grid h-6 w-6 place-items-center rounded text-faint hover:bg-paper hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="hairline-scroll flex-1 overflow-y-auto py-1">
          {provider.blurb && <p className="px-4 py-2.5 text-[12px] text-muted">{provider.blurb}</p>}
          <div className="divide-y divide-line">
            {visibleProviderFields(provider, draft).map(fieldView)}
          </div>
          {keyHelp && provider.needs_key && (
            <p className="px-4 py-2.5 text-[12px] text-faint">
              还没有密钥?{" "}
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => openExternal(keyHelp.url)}
              >
                到 {keyHelp.label} 创建 ↗
              </button>
            </p>
          )}
          {verify.state === "error" && (
            <p className="px-4 py-2 text-[12px] text-danger" role="alert">
              {verify.msg}
            </p>
          )}
          {verify.state === "ok" && <p className="px-4 py-2 text-[12px] text-ok">{verify.msg}</p>}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line bg-panel px-4 py-3">
          {provider.configured ? (
            confirmRemove ? (
              <span className="flex items-center gap-2 text-[12px] text-muted">
                确定移除已保存的配置?
                <button
                  type="button"
                  className="rounded-lg bg-danger px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-40"
                  disabled={removing}
                  onClick={() => void remove()}
                >
                  移除
                </button>
                <button type="button" className={BTN + " px-2.5 py-1 text-[12px]"} onClick={() => setConfirmRemove(false)}>
                  保留
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="text-[12.5px] text-danger hover:underline"
                onClick={() => setConfirmRemove(true)}
              >
                移除配置…
              </button>
            )
          ) : (
            <span className="text-[11.5px] text-faint">可先保存配置,再执行只读验证。</span>
          )}
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className={BTN + " px-3 py-1.5"}
              disabled={verify.state === "testing" || !canSubmitProvider(provider, draft)}
              onClick={() => void verifyOnly()}
            >
              验证
            </button>
            <button
              type="button"
              className={BTN_ACCENT}
              disabled={verify.state === "testing" || !canSubmitProvider(provider, draft)}
              onClick={() => void submit()}
            >
              {verify.state === "testing" ? "处理中…" : submitLabel}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

export function ModelsSection() {
  const { settings, error: settingsError, refresh, apply } = useSettings();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsNotice, setModelsNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshProviders = async () => {
    try {
      setProviders(await getProviders());
      setProvidersError(null);
    } catch (err) {
      setProvidersError(apiErrorMessage(err, "提供商加载失败"));
    }
  };
  useEffect(() => {
    void refreshProviders();
  }, []);

  const changeDefault = async (model: string) => {
    try {
      const res = await setDefaultModel(model);
      if (res.ok) await refresh();
      else setModelsError(res.error || "设置默认模型失败");
    } catch (err) {
      setModelsError(apiErrorMessage(err));
    }
  };

  const add = async () => {
    if (!settings) return;
    const invalid = validateModelDraft(settings.models || [], modelDraft);
    if (invalid) {
      setModelsError(invalid);
      return;
    }
    const id = modelDraft.trim();
    setBusy(true);
    setModelsError(null);
    setModelsNotice(null);
    try {
      const res = await addModel(id);
      if (res.ok) {
        apply(res);
        // 提供商未配置时模型已持久化但不出现在下发列表里 —— 明示,免得看起来像没加上。
        setModelsNotice(
          modelAddNeedsProviderHint(id, providers, settings.provider)
            ? "已添加,配置对应提供商后才会出现在模型列表"
            : null,
        );
        setModelDraft("");
      } else {
        setModelsError(humanizeErrorText(res.error || "添加失败"));
      }
    } catch (err) {
      setModelsError(humanizeErrorText(apiErrorMessage(err)));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (model: string) => {
    setModelsError(null);
    setModelsNotice(null);
    try {
      const res = await removeModel(model);
      if (res.ok) apply(res);
      else setModelsError("移除失败");
    } catch (err) {
      setModelsError(humanizeErrorText(apiErrorMessage(err)));
    }
  };

  const labels = settings?.model_labels;
  const contextWindows = settings?.model_context_windows ?? {};
  const selectedProvider = providers?.find((p) => p.name === selected) ?? null;

  return (
    <section>
      <SectionHeader
        title="模型"
        sub="模型提供商与默认模型。密钥只保存在这台电脑上,不会上传。"
      />

      {settingsError && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {settingsError}
        </p>
      )}

      {!settings ? (
        <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
          <span className="spinner spinner-lg" /> 加载中
        </div>
      ) : (
        <>
          <div className={GRP + " divide-y divide-line"}>
            <Row label="默认模型" hint="新会话使用的模型">
              <select
                className={INPUT}
                value={settings.model}
                onChange={(e) => void changeDefault(e.target.value)}
              >
                {defaultModelOptions(settings).map((model) => (
                  <option key={model} value={model}>
                    {modelDisplayName(model, labels)}
                  </option>
                ))}
              </select>
            </Row>
          </div>
          {!settings.model_ready && (
            <p className={GRP_NOTE + " text-warnInk"}>
              默认模型的提供商尚未配置密钥 —— 请在下方「服务提供商」中完成配置。
            </p>
          )}

          <div className={GRP_H}>模型列表</div>
          <div className={GRP + " divide-y divide-line"}>
            {(settings.models || []).map((model) => (
              <div key={model} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">
                      {modelDisplayName(model, labels)}
                    </span>
                    {model === settings.model && (
                      <span className={`${TAG} bg-accentSoft text-accent`}>默认</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-faint">
                    {model}
                    {contextWindows[model] ? ` · 上下文 ${formatContextWindow(contextWindows[model])}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded text-faint hover:bg-paper hover:text-danger disabled:opacity-30"
                  title={
                    canRemoveModel(settings, model) ? `移除 ${model}` : "默认模型不可移除"
                  }
                  disabled={!canRemoveModel(settings, model)}
                  onClick={() => void remove(model)}
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2 px-4 py-2.5">
              <input
                className={INPUT}
                placeholder="模型 ID,如 provider/model-name"
                value={modelDraft}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setModelDraft(e.target.value);
                  setModelsError(null);
                  setModelsNotice(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && void add()}
              />
              <button
                type="button"
                className={BTN_ACCENT + " shrink-0"}
                disabled={busy || !modelDraft.trim()}
                onClick={() => void add()}
              >
                添加
              </button>
            </div>
          </div>
          {modelsError && (
            <p className={GRP_NOTE + " text-danger"} role="alert">
              {modelsError}
            </p>
          )}
          {modelsNotice && (
            <p className={GRP_NOTE + " text-warnInk"} data-testid="model-add-notice">
              {modelsNotice}
            </p>
          )}
        </>
      )}

      <div className={GRP_H}>服务提供商</div>
      {providersError && (
        <p className="mt-1 text-[12px] text-danger" role="alert">
          {providersError}
        </p>
      )}
      {!providers ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-faint">
          <span className="spinner" /> 加载中
        </div>
      ) : (
        <div className={GRP + " divide-y divide-line"}>
          {providers.map((provider) => {
            const status = providerStatus(provider);
            const sourceLabel = credentialSourceLabel(credentialSource(provider));
            const used = relTime(provider.last_used_at);
            return (
              <div
                key={provider.name}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(provider.name)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(provider.name);
                  }
                }}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-paper/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{provider.title}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-faint">
                    {provider.name}
                    {used ? ` · 上次使用 ${used}` : ""}
                  </span>
                </span>
                <span
                  className={`${TAG} shrink-0 ${
                    status.tone === "ok" ? "bg-okSoft text-ok" : "bg-solid text-muted"
                  }`}
                >
                  {status.label}
                </span>
                {sourceLabel && (
                  <span className={`${TAG} shrink-0 bg-accentSoft text-accent`}>
                    {sourceLabel}
                  </span>
                )}
                <Icon name="chevronRight" size={14} className="shrink-0 text-faint" />
              </div>
            );
          })}
        </div>
      )}
      <p className={GRP_NOTE}>点击提供商配置密钥或接入方式；保存可离线完成，验证是独立只读检查。</p>

      {selectedProvider && (
        <ProviderEditor
          key={selectedProvider.name}
          provider={selectedProvider}
          onClose={() => setSelected(null)}
          onChanged={() => {
            void refreshProviders();
            void refresh();
          }}
        />
      )}
    </section>
  );
}
