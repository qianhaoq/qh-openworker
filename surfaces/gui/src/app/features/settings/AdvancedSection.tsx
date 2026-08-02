// 高级:api/settings.ts 里实际存在的设置子端点,按组划分,每组一个表单 + 保存。
// 文件(scratch-base)、PDF(pdf)、上下文压缩(compaction)、网络搜索(web-search)、
// 实验性功能(experimental-connectors,单开关即时生效)。旧「界面」组(侧栏布局/每组
// 会话数/上下文用量条)配置的是旧产品的会话侧栏与输入框,新 UI 均未消费,已移除。
// surfaces 端点面向旧产品的 chat/code 面板,本应用没有对应开关,不收录。

import { useEffect, useState } from "react";
import {
  getWebSearch,
  setCompactionSettings,
  setExperimentalConnectors,
  setPdfSettings,
  setScratchBase,
  setWebSearch,
} from "../../lib/api/settings";
import type { WebSearchSettings } from "../../lib/api/types";
import { humanizeErrorText } from "../../lib/errorText";
import { chooseFolder } from "../../../tauri";
import { Switch } from "../../components/Switch";
import {
  BTN,
  FormFooter,
  GRP,
  GRP_H,
  GRP_NOTE,
  INPUT,
  Row,
  SectionHeader,
  Segmented,
} from "./controls";
import {
  apiErrorMessage,
  compactionDraftFromSettings,
  modelDisplayName,
  parseCompactionDraft,
  parsePdfDraft,
  pdfDraftFromSettings,
  validateScratchBase,
  type CompactionDraft,
  type PdfDraft,
  type SettingsRead,
} from "./settingsLogic";

type FormState = { busy: boolean; error: string | null; notice: string | null };
const IDLE: FormState = { busy: false, error: null, notice: null };

function FilesForm({ settings, onApplied }: { settings: SettingsRead; onApplied: () => void }) {
  const [path, setPath] = useState(settings.scratch_base || "");
  const [state, setState] = useState<FormState>(IDLE);

  const save = async () => {
    const invalid = validateScratchBase(path);
    if (invalid) {
      setState({ ...IDLE, error: invalid });
      return;
    }
    setState({ busy: true, error: null, notice: null });
    try {
      const res = await setScratchBase(path.trim());
      if (!res.ok) {
        setState({ ...IDLE, error: humanizeErrorText(res.error || "无法使用该位置") });
        return;
      }
      setState({ ...IDLE, notice: "已保存,新会话将使用此位置" });
      onApplied();
    } catch (err) {
      setState({ ...IDLE, error: humanizeErrorText(apiErrorMessage(err, "保存失败")) });
    }
  };

  const browse = async () => {
    const picked = await chooseFolder().catch(() => null);
    if (picked) setPath(picked);
  };

  return (
    <>
      <div className={GRP_H}>文件</div>
      <div className={GRP + " divide-y divide-line"}>
        <Row label="会话文件夹" hint="每个会话在此位置下获得自己的文件夹" stack>
          <div className="flex items-center gap-2">
            <input
              className={INPUT}
              placeholder="~/OpenWorker"
              value={path}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void save()}
            />
            <button type="button" className={BTN + " shrink-0"} onClick={() => void browse()}>
              浏览…
            </button>
          </div>
        </Row>
        <FormFooter
          busy={state.busy}
          error={state.error}
          notice={state.notice}
          disabled={!path.trim()}
          onSave={() => void save()}
        />
      </div>
    </>
  );
}

function PdfForm({ settings, onApplied }: { settings: SettingsRead; onApplied: () => void }) {
  const [draft, setDraft] = useState<PdfDraft>(() => pdfDraftFromSettings(settings));
  const [state, setState] = useState<FormState>(IDLE);

  const save = async () => {
    const parsed = parsePdfDraft(draft);
    if (!parsed.ok) {
      setState({ ...IDLE, error: parsed.error });
      return;
    }
    setState({ busy: true, error: null, notice: null });
    try {
      const res = await setPdfSettings(parsed.patch);
      if (!res.ok) {
        setState({ ...IDLE, error: res.error || "保存失败" });
        return;
      }
      setState({ ...IDLE, notice: "已保存" });
      onApplied();
    } catch (err) {
      setState({ ...IDLE, error: apiErrorMessage(err, "保存失败") });
    }
  };

  return (
    <>
      <div className={GRP_H}>PDF 附件</div>
      <div className={GRP + " divide-y divide-line"}>
        <Row
          label="无原生 PDF 支持的模型"
          hint="提取文本最省 token;页面图像需要视觉模型"
        >
          <Segmented
            ariaLabel="PDF 回退方式"
            options={[
              { value: "text", label: "提取文本" },
              { value: "images", label: "页面图像" },
            ]}
            value={draft.fallback}
            onChange={(fallback) => setDraft((d) => ({ ...d, fallback }))}
          />
        </Row>
        <Row label="最大页数" hint="超过则不附加,输入框中会提示">
          <input
            className={INPUT}
            type="number"
            min={1}
            max={100}
            value={draft.maxPages}
            onChange={(e) => setDraft((d) => ({ ...d, maxPages: e.target.value }))}
          />
        </Row>
        <Row label="最大大小(MB)">
          <input
            className={INPUT}
            type="number"
            min={1}
            max={10}
            value={draft.maxMb}
            onChange={(e) => setDraft((d) => ({ ...d, maxMb: e.target.value }))}
          />
        </Row>
        <FormFooter
          busy={state.busy}
          error={state.error}
          notice={state.notice}
          onSave={() => void save()}
        />
      </div>
      <p className={GRP_NOTE}>PDF 附件随每一轮对话发送,大文档会成倍消耗 token。</p>
    </>
  );
}

function CompactionForm({ settings, onApplied }: { settings: SettingsRead; onApplied: () => void }) {
  const [draft, setDraft] = useState<CompactionDraft>(() => compactionDraftFromSettings(settings));
  const [state, setState] = useState<FormState>(IDLE);
  const labels = settings.model_labels;

  const save = async () => {
    const parsed = parseCompactionDraft(draft);
    if (!parsed.ok) {
      setState({ ...IDLE, error: parsed.error });
      return;
    }
    setState({ busy: true, error: null, notice: null });
    try {
      const res = await setCompactionSettings(parsed.patch);
      if (!res.ok) {
        setState({ ...IDLE, error: res.error || "保存失败" });
        return;
      }
      setState({ ...IDLE, notice: "已保存" });
      onApplied();
    } catch (err) {
      setState({ ...IDLE, error: apiErrorMessage(err, "保存失败") });
    }
  };

  return (
    <>
      <div className={GRP_H}>上下文压缩</div>
      <div className={GRP + " divide-y divide-line"}>
        <Row label="触发阈值(%)" hint="占用达到上下文窗口的该比例时自动压缩">
          <input
            className={INPUT}
            type="number"
            min={10}
            max={95}
            value={draft.thresholdPct}
            onChange={(e) => setDraft((d) => ({ ...d, thresholdPct: e.target.value }))}
          />
        </Row>
        <Row label="token 上限" hint="达到该 token 数也会触发,两者取先">
          <input
            className={INPUT}
            type="number"
            min={10_000}
            max={2_000_000}
            step={10_000}
            value={draft.capTokens}
            onChange={(e) => setDraft((d) => ({ ...d, capTokens: e.target.value }))}
          />
        </Row>
        <Row label="摘要模型" hint="生成压缩摘要所用的模型">
          <select
            className={INPUT}
            value={draft.model}
            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
          >
            <option value="">跟随会话模型(默认)</option>
            {(settings.models || []).map((model) => (
              <option key={model} value={model}>
                {modelDisplayName(model, labels)}
              </option>
            ))}
          </select>
        </Row>
        <FormFooter
          busy={state.busy}
          error={state.error}
          notice={state.notice}
          onSave={() => void save()}
        />
      </div>
      <p className={GRP_NOTE}>
        长会话接近上下文上限时,较早的轮次会被自动摘要;可见的对话记录不会改变。
      </p>
    </>
  );
}

function WebSearchForm() {
  const [ws, setWs] = useState<WebSearchSettings | null>(null);
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [state, setState] = useState<FormState>(IDLE);

  useEffect(() => {
    let active = true;
    getWebSearch()
      .then((data) => {
        if (!active) return;
        setWs(data);
        setProvider(data.provider || data.providers[0] || "");
      })
      .catch((err) => active && setState({ ...IDLE, error: apiErrorMessage(err, "加载失败") }));
    return () => {
      active = false;
    };
  }, []);

  const save = async () => {
    if (!provider) {
      setState({ ...IDLE, error: "请选择搜索提供商" });
      return;
    }
    setState({ busy: true, error: null, notice: null });
    try {
      const res = await setWebSearch(provider, apiKey.trim() || undefined);
      if (!res.ok) {
        setState({ ...IDLE, error: res.error || "保存失败" });
        return;
      }
      setState({ ...IDLE, notice: "已保存" });
      setApiKey("");
      const fresh = await getWebSearch().catch(() => null);
      if (fresh) setWs(fresh);
    } catch (err) {
      setState({ ...IDLE, error: apiErrorMessage(err, "保存失败") });
    }
  };

  return (
    <>
      <div className={GRP_H}>网络搜索</div>
      <div className={GRP + " divide-y divide-line"}>
        {!ws ? (
          <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-faint">
            <span className="spinner" /> 加载中
          </div>
        ) : (
          <>
            <Row label="搜索提供商">
              <select
                className={INPUT}
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                {ws.providers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Row>
            <Row
              label="API 密钥"
              hint={ws.has_key ? "已保存密钥;输入新密钥以替换,留空保持不变" : "提供商需要时填写"}
            >
              <input
                className={INPUT}
                type="password"
                placeholder={ws.has_key ? "已保存,输入以替换" : "API 密钥"}
                value={apiKey}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Row>
            <FormFooter
              busy={state.busy}
              error={state.error}
              notice={state.notice}
              onSave={() => void save()}
            />
          </>
        )}
      </div>
    </>
  );
}

function ExperimentalForm({ settings }: { settings: SettingsRead }) {
  const [enabled, setEnabled] = useState(settings.experimental_connectors === true);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (value: boolean) => {
    setEnabled(value);
    setError(null);
    try {
      const res = await setExperimentalConnectors(value);
      if (!res.ok) {
        setEnabled(!value);
        setError(res.error || "保存失败");
      }
    } catch (err) {
      setEnabled(!value);
      setError(apiErrorMessage(err, "保存失败"));
    }
  };

  return (
    <>
      <div className={GRP_H}>实验性功能</div>
      <div className={GRP + " divide-y divide-line"}>
        <Row label="实验性连接器" hint="启用尚在开发中的连接器,可能不稳定">
          <Switch checked={enabled} onChange={(value) => void toggle(value)} />
        </Row>
      </div>
      {error && (
        <p className={GRP_NOTE + " text-danger"} role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function AdvancedSection({ settings, onApplied }: { settings: SettingsRead; onApplied: () => void }) {
  return (
    <section>
      <SectionHeader title="高级" sub="文件、PDF 与上下文压缩等进阶选项,每组独立保存。" />
      <FilesForm settings={settings} onApplied={onApplied} />
      <PdfForm settings={settings} onApplied={onApplied} />
      <CompactionForm settings={settings} onApplied={onApplied} />
      <WebSearchForm />
      <ExperimentalForm settings={settings} />
    </section>
  );
}
