// The chat composer: autosize multiline input (Enter 发送 / Shift+Enter 换行), drag-drop +
// picker attachments with the PDF page/size thresholds, the model picker, the permission
// mode chip (计划/确认/自动), the unattended toggle, native voice dictation with the four
// §37 states (ready → listening waveform+timer → transcribing → draft inserted, never
// auto-sent; browser fallback = no mic), and send ↔ stop while a turn runs.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment } from "../../lib/api/types";
import { getSettings } from "../../lib/api/settings";
import { inspectPdf } from "../../lib/api/attachments";
import { Icon } from "../../components/Icon";
import {
  cancelDictation,
  getDictationLevel,
  getDictationStatus,
  isTauri,
  startDictation,
  stopDictation,
  type DictationStatus,
} from "../../../tauri";
import { isPdfFile, mergeAttachments, readFile } from "./attachments";

// 权限模式（ws set_mode）。discuss/custom 仍被服务端支持，但这个版本不提供入口。
const PERMISSION_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: "plan", label: "计划", description: "先讨论方案，批准后再执行" },
  { value: "interactive", label: "确认", description: "编辑文件、运行命令前先询问" },
  { value: "auto", label: "自动", description: "不再询问，直接执行" },
];

// Drop the provider prefix for display (anthropic:claude-opus-4-8 → claude-opus-4-8).
export const shortModel = (m: string) => (m.includes(":") ? m.split(":").slice(1).join(":") : m);

export interface ComposerProps {
  running: boolean;
  connected: boolean;
  model: string;
  models: string[];
  modelLabels?: Record<string, string>;
  mode: string;
  unattended?: boolean;
  onUnattendedChange?: (on: boolean) => void;
  onSend: (text: string, attachments?: Attachment[]) => void;
  onInterrupt: () => void;
  onModeChange: (mode: string) => void;
  onModelChange: (model: string) => void;
  /** Voice Input not configured — send the user to 设置. */
  onConfigureVoiceInput: () => void;
  placeholder?: string;
  /** Changes when the active conversation changes; clears any unsent draft. */
  resetKey?: string;
}

export function Composer(props: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [dictation, setDictation] = useState<DictationStatus | null>(null);
  const [dictationBusy, setDictationBusy] = useState<string | null>(null);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [attachNotice, setAttachNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const noticeTimer = useRef<number | null>(null);

  // Rejected-attachment notice: visible ~8s, then clears (or on ✕).
  const showAttachNotice = (message: string) => {
    setAttachNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setAttachNotice(null), 8000);
  };

  // Autosize: grow to 4 lines, then scroll.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = parseFloat(getComputedStyle(el).lineHeight || "22") * 4;
    const next = Math.min(el.scrollHeight, max);
    el.style.height = `${Math.max(next, 24)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [text]);

  // Clear the draft when the conversation changes.
  useEffect(() => {
    setText("");
    setAttachments([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.resetKey]);

  // Dictation is intentionally native-only: the browser/dev build never turns on the
  // browser microphone or ships audio anywhere (fallback = hide the mic button).
  useEffect(() => {
    if (!isTauri()) return;
    const refresh = (event?: Event) => {
      const supplied = (event as CustomEvent<DictationStatus> | undefined)?.detail;
      if (supplied) {
        setDictation(supplied);
        return;
      }
      void getDictationStatus().then((status) => status && setDictation(status));
    };
    refresh();
    window.addEventListener("coworker:voice-input-changed", refresh);
    return () => window.removeEventListener("coworker:voice-input-changed", refresh);
  }, []);

  useEffect(() => {
    if (!dictation?.recording) {
      setRecordingSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => {
      setRecordingSeconds(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => window.clearInterval(timer);
  }, [dictation?.recording]);

  // Live waveform: poll mic loudness at ~10Hz while recording; the bars scroll left so the
  // trace reads as a real input meter.
  const [levels, setLevels] = useState<number[]>([]);
  useEffect(() => {
    if (!dictation?.recording) {
      setLevels([]);
      return;
    }
    const timer = window.setInterval(() => {
      getDictationLevel().then((level) => {
        if (typeof level === "number") setLevels((cur) => [...cur.slice(-13), level]);
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [dictation?.recording]);

  useEffect(() => {
    if (!dictation?.recording) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      void cancelDictation()
        .catch(() => undefined)
        .finally(() => {
          void getDictationStatus().then((status) => status && setDictation(status));
        });
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [dictation?.recording]);

  const voiceReady = !!dictation?.supported && !!dictation?.model_verified && !!dictation?.test_passed;
  const recordingTime = `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`;

  // Attach-time PDF thresholds (设置 → PDF): over the page or size limit = rejected with a
  // visible notice — never attached, never silently dropped. A big PDF re-rides every turn.
  const addFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    let maxPages = 20;
    let maxMb = 10;
    if (list.some(isPdfFile)) {
      try {
        const s = await getSettings();
        if (s.pdf_max_pages) maxPages = s.pdf_max_pages;
        if (s.pdf_max_mb) maxMb = s.pdf_max_mb;
      } catch {
        /* offline settings fetch — fall back to defaults */
      }
    }
    const accepted: File[] = [];
    for (const file of list) {
      if (isPdfFile(file) && file.size > maxMb * 1024 * 1024) {
        showAttachNotice(
          `已跳过 ${file.name} — ${(file.size / 1024 / 1024).toFixed(1)} MB 超过 ${maxMb} MB 上限（设置 → PDF）`,
        );
        continue;
      }
      accepted.push(file);
    }
    const read = (await Promise.all(accepted.map(readFile))).filter(Boolean) as Attachment[];
    const next: Attachment[] = [];
    for (const a of read) {
      if (a.kind === "pdf" && a.data_url) {
        const info = await inspectPdf(a.data_url).catch(() => null);
        if (info?.ok && (info.pages ?? 0) > maxPages) {
          showAttachNotice(
            `已跳过 ${a.name} — ${info.pages} 页超过 ${maxPages} 页上限（设置 → PDF）`,
          );
          continue;
        }
        if (info && !info.ok) {
          showAttachNotice(`已跳过 ${a.name} — ${info.error || "无法读取 PDF"}`);
          continue;
        }
      }
      next.push(a);
    }
    if (next.length) setAttachments((a) => mergeAttachments(a, next));
  };

  const pickFiles = (accept: string) => {
    setAttachMenuOpen(false);
    if (fileInput.current) {
      fileInput.current.accept = accept;
      fileInput.current.click();
    }
  };

  const submit = () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || props.running || dictation?.recording || dictationBusy) return;
    props.onSend(t, attachments);
    setText("");
    setAttachments([]);
    // Settle cue: the box does a quick fade/shift as the draft clears (class re-trigger,
    // not a re-mount — the textarea keeps focus for the next message).
    const el = composerBoxRef.current;
    if (el) {
      el.classList.remove("composer-send-settle");
      void el.offsetWidth;
      el.classList.add("composer-send-settle");
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter(Boolean) as File[];
    if (imgs.length) {
      e.preventDefault();
      addFiles(imgs);
    }
  };

  const toggleDictation = async () => {
    if (!isTauri() || dictationBusy) return;
    setDictationError(null);
    try {
      if (dictation?.recording) {
        setDictationBusy("正在转写…");
        const transcript = await stopDictation();
        if (transcript === null) throw new Error("无法转写这段录音。");
        if (transcript.trim()) {
          const cleanTranscript = transcript.trim();
          // Draft inserted — never auto-sent (§37).
          setText((draft) => (draft.trim() ? `${draft.trimEnd()} ${cleanTranscript}` : cleanTranscript));
        }
        setDictation(await getDictationStatus());
        textareaRef.current?.focus();
        return;
      }

      const status = dictation || (await getDictationStatus());
      if (!status) throw new Error("语音输入不可用。");
      if (!status.supported || !status.model_verified || !status.test_passed) {
        props.onConfigureVoiceInput();
        return;
      }
      setDictationBusy("正在启动麦克风…");
      const recording = await startDictation();
      if (!recording?.recording) throw new Error("无法启动麦克风。");
      setDictation(recording);
    } catch (error) {
      setDictationError(error instanceof Error ? error.message : "语音输入不可用。");
      const status = await getDictationStatus();
      if (status) setDictation(status);
    } finally {
      setDictationBusy(null);
    }
  };

  const modelsLoaded = props.models.length > 0;
  const modelOptions = Array.from(new Set([props.model, ...props.models].filter(Boolean)));
  const iconBtn =
    "grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink";
  // The send button is accent only when there's something to send.
  const hasContent = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className="px-6 pb-5 pt-2">
      {dictationError && (
        <div className="mx-auto mb-2 max-w-3xl px-1 text-[12px] text-danger" role="alert">
          {dictationError}
        </div>
      )}

      {/* 附件被拒通知（PDF 超过上限）。 */}
      {attachNotice && (
        <div
          data-testid="attach-notice"
          className="mx-auto mb-1.5 flex max-w-3xl items-center gap-2 rounded-lg border border-warnInk/30 bg-warnSoft px-3 py-1.5 text-[12.5px] text-warnInk"
        >
          <span className="flex-1">{attachNotice}</span>
          <button
            type="button"
            className="shrink-0 opacity-60 hover:opacity-100"
            onClick={() => setAttachNotice(null)}
            title="关闭"
          >
            ✕
          </button>
        </div>
      )}

      {/* 附件预览条（输入框上方）。 */}
      {attachments.length > 0 && (
        <div className="mx-auto mb-1.5 flex max-w-3xl flex-wrap gap-2">
          {attachments.map((a, i) => (
            <AttachChip
              key={i}
              a={a}
              onRemove={() => setAttachments((all) => all.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      <div
        ref={composerBoxRef}
        className={`mx-auto max-w-3xl rounded-2xl border bg-panel shadow-sm transition-colors ${
          dragging ? "border-accent" : "border-line"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
      >
        <textarea
          ref={textareaRef}
          className="block w-full bg-transparent px-3.5 pb-1.5 pt-3.5 text-[14.5px] placeholder:text-faint focus:outline-none"
          placeholder={props.placeholder || "给助手发消息…"}
          title="可拖入或粘贴文件作为附件"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          rows={1}
        />

        {/* 控制行：+ 附件 · 模式 ▾ …（右侧）… 用量/模型 · 麦克风 · 发送 */}
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
          <div className="relative">
            <button
              type="button"
              className={iconBtn + (attachMenuOpen ? " bg-paper text-ink" : "")}
              title="添加附件"
              aria-label="添加附件"
              onClick={() => setAttachMenuOpen((v) => !v)}
            >
              <Icon name="plus" size={17} />
            </button>
            {attachMenuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setAttachMenuOpen(false)} />
                <div className="absolute bottom-full left-0 z-40 mb-1 min-w-[160px] rounded-xl border border-line bg-panel py-1.5 shadow-2xl">
                  {attachItem("image", "照片或图片", () => pickFiles("image/*"))}
                  {attachItem("file", "PDF", () => pickFiles("application/pdf,.pdf"))}
                  {attachItem(
                    "fileCode",
                    "其他文件",
                    () => pickFiles("text/*,.md,.csv,.json,.yaml,.yml,.log,.py,.ts,.tsx,.js,.rs,.go,.toml"),
                  )}
                </div>
              </>
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {/* 录音中：中间控制换成实时波形 + 计时（§37）。 */}
          {dictation?.recording ? (
            <div className="ml-1 flex flex-1 items-center gap-2" aria-hidden="true">
              <span className="h-px flex-1 border-t border-dashed border-line" />
              <span className="voice-wave-bars">
                {Array.from({ length: 14 }, (_, index) => {
                  const level = levels[levels.length - 14 + index] ?? 0;
                  return <i key={index} style={{ height: Math.round(4 + level * 24) }} />;
                })}
              </span>
              <span className="text-[12px] tabular-nums text-muted">{recordingTime}</span>
            </div>
          ) : (
            <ModeMenu
              mode={props.mode}
              onModeChange={props.onModeChange}
              unattended={props.unattended}
              onUnattendedChange={props.onUnattendedChange}
            />
          )}

          {dictationBusy === "正在转写…" && (
            <span className="text-[11.5px] text-accent" role="status">
              正在转写…
            </span>
          )}

          <span className="ml-auto" />

          {/* 无人值守标记 */}
          {!dictation?.recording && props.unattended && (
            <span
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-accent/30 bg-accentSoft px-1.5 py-0.5 text-[11px] font-medium text-accent"
              title="审批与问题将发送到收件箱"
            >
              ● 无人值守
            </span>
          )}

          {/* 模型选择 */}
          {!dictation?.recording &&
            (modelsLoaded ? (
              <ModelMenu
                model={props.model}
                options={modelOptions}
                labels={props.modelLabels}
                onChange={props.onModelChange}
              />
            ) : (
              <button
                type="button"
                className="shrink-0 cursor-default whitespace-nowrap rounded-lg px-2 py-1 text-[12px] text-faint"
                disabled
                data-testid="models-loading"
                title="正在从服务器获取模型列表"
              >
                加载模型…
              </button>
            ))}

          {/* 麦克风 — 紧挨发送键；仅桌面端。 */}
          {isTauri() && (
            <button
              type="button"
              className={
                iconBtn +
                (dictation?.recording ? " bg-dangerSoft text-danger hover:bg-dangerSoft" : "") +
                (dictationBusy ? " opacity-60" : "") +
                (!voiceReady && !dictation?.recording ? " opacity-40" : "")
              }
              onClick={() => void toggleDictation()}
              disabled={!!dictationBusy}
              title={
                dictationBusy ||
                (dictation?.recording
                  ? "停止录音并转写"
                  : voiceReady
                    ? "开始本地语音输入"
                    : "在设置中配置语音输入")
              }
              aria-label={dictation?.recording ? "停止语音输入" : voiceReady ? "开始语音输入" : "在设置中配置语音输入"}
              aria-disabled={!voiceReady && !dictation?.recording}
            >
              <Icon name={dictation?.recording ? "stop" : "mic"} size={16} />
            </button>
          )}

          {/* 发送 / 停止 */}
          {props.running ? (
            <button
              type="button"
              className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-dangerSoft px-2.5 text-[12px] font-medium text-danger hover:brightness-95"
              onClick={props.onInterrupt}
              title="停止当前回合"
            >
              <Icon name="stop" size={11} />
              停止
            </button>
          ) : (
            <button
              type="button"
              className={
                "grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors " +
                (hasContent && props.connected && !dictation?.recording && !dictationBusy
                  ? "bg-accent text-white hover:brightness-105"
                  : "border border-line bg-paper text-faint")
              }
              onClick={submit}
              disabled={!props.connected || !!dictation?.recording || !!dictationBusy}
              aria-label="发送"
            >
              <Icon name="send" size={14} />
            </button>
          )}
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {dictation?.recording ? `正在聆听，${recordingTime}` : dictationBusy || ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模式菜单（含无人值守开关）
// ---------------------------------------------------------------------------

function ModeMenu({
  mode,
  onModeChange,
  unattended,
  onUnattendedChange,
}: {
  mode: string;
  onModeChange: (mode: string) => void;
  unattended?: boolean;
  onUnattendedChange?: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = PERMISSION_OPTIONS.find((o) => o.value === mode);
  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] text-muted hover:bg-paper hover:text-ink"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="权限模式"
        title={`权限模式：${current?.label || mode}` + (unattended ? " · 审批发往收件箱" : "")}
      >
        {current?.label || mode}
        <Icon name="chevronDown" size={11} className="text-faint" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full left-0 z-40 mb-1 w-[248px] rounded-xl border border-line bg-panel p-1.5 shadow-2xl"
            role="menu"
            data-testid="mode-menu"
          >
            {PERMISSION_OPTIONS.map((o) => (
              <button
                type="button"
                key={o.value}
                className="flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left hover:bg-paper"
                onClick={() => {
                  onModeChange(o.value);
                  setOpen(false);
                }}
              >
                <span className={"text-[13px] " + (o.value === mode ? "font-medium text-accent" : "text-ink")}>
                  {o.label}
                  {o.value === mode && <span className="ml-1.5">✓</span>}
                </span>
                <span className="text-[11px] leading-snug text-faint">{o.description}</span>
              </button>
            ))}
            {onUnattendedChange && (
              <>
                <div className="my-1 border-t border-line" />
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-ink">无人值守</span>
                    <span className="block text-[11px] leading-snug text-faint">
                      审批与问题发到收件箱，助手继续工作。
                    </span>
                  </span>
                  <Toggle checked={!!unattended} onChange={onUnattendedChange} title="无人值守" />
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 模型菜单
// ---------------------------------------------------------------------------

function ModelMenu({
  model,
  options,
  labels,
  onChange,
}: {
  model: string;
  options: string[];
  labels?: Record<string, string>;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = (m: string) => labels?.[m]?.split(" · ")[0] || shortModel(m);
  return (
    <div className="relative">
      <button
        type="button"
        className="inline-flex min-w-0 max-w-[180px] items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[12px] text-muted hover:bg-paper hover:text-ink"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="模型"
        title={model}
        data-testid="model-menu-button"
      >
        <span className="truncate">{label(model)}</span>
        <Icon name="chevronDown" size={11} className="shrink-0 text-faint" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full right-0 z-40 mb-1 max-h-[320px] w-[240px] overflow-y-auto rounded-xl border border-line bg-panel p-1.5 shadow-2xl"
            role="menu"
            data-testid="model-menu"
          >
            {options.map((m) => (
              <button
                type="button"
                key={m}
                className="w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-paper"
                title={m}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
              >
                <span className={"block truncate text-[13px] " + (m === model ? "font-medium text-accent" : "text-ink")}>
                  {label(m)}
                  {m === model && <span className="ml-1.5">✓</span>}
                </span>
                {labels?.[m] && <span className="block truncate text-[11px] text-faint">{shortModel(m)}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// A quiet switch (设置风格的 toggle)。
function Toggle({
  checked,
  onChange,
  title,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-[30px] shrink-0 rounded-full transition-colors ${
        checked ? "bg-accent" : "bg-lineStrong"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow transition-all ${
          checked ? "left-[14px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}

function attachItem(icon: "image" | "file" | "fileCode", label: string, onClick: () => void) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-paper"
      onClick={onClick}
    >
      <Icon name={icon} size={15} className="shrink-0 text-muted" /> {label}
    </button>
  );
}

function AttachChip({ a, onRemove }: { a: Attachment; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-1.5 py-1 text-[12px] text-muted">
      {a.kind === "image" ? (
        <img src={a.data_url} alt={a.name} className="h-7 w-7 rounded object-cover" />
      ) : (
        <>
          <Icon name="file" size={13} />
          <span className="max-w-[160px] truncate">{a.name}</span>
        </>
      )}
      <button type="button" className="text-faint hover:text-ink" onClick={onRemove} title="移除">
        ✕
      </button>
    </div>
  );
}
