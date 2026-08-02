// 语音:本地 Whisper 听写模型的下载/验证/删除 + 麦克风测试(§37 的三段式:兼容性 →
// 模型 → 测试)。仅桌面应用可用(Tauri IPC);浏览器显示温和的提示卡。状态变更时广播
// coworker:voice-input-changed —— 输入框麦克风按钮(assistant/Composer.tsx)靠它刷新。

import { useEffect, useState } from "react";
import {
  cancelDictationModelDownload,
  deleteDictationModel,
  downloadDictationModel,
  getDictationStatus,
  isTauri,
  listenDictationDownloadProgress,
  markDictationTestPassed,
  startDictation,
  stopDictation,
  verifyDictationModel,
  type DictationDownloadProgress,
  type DictationStatus,
} from "../../../tauri";
import { Icon } from "../../components/Icon";
import { BTN, BTN_ACCENT, GRP, SectionHeader, TAG } from "./controls";
import {
  dictationReady,
  downloadPercent,
  formatBytes,
  voiceErrorMessage,
} from "./settingsLogic";

type Phase = "idle" | "downloading" | "verifying" | "testing" | "transcribing";

const REQUIREMENTS: [string, string][] = [
  ["Mac", "macOS 12+ · Apple Silicon(M1 或更新)"],
  ["Windows", "Windows 10 22H2 或 11 · x64"],
  ["内存", "建议 8 GB"],
  ["处理器", "建议 4 核 CPU"],
];

function VoiceDesktop() {
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [progress, setProgress] = useState<DictationDownloadProgress | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const publish = (next: DictationStatus) => {
    setStatus(next);
    window.dispatchEvent(new CustomEvent("coworker:voice-input-changed", { detail: next }));
  };

  useEffect(() => {
    let active = true;
    let unlisten = () => {};
    void listenDictationDownloadProgress((next) => {
      if (active) setProgress(next);
    }).then((stop) => {
      unlisten = stop;
    });
    void getDictationStatus().then(async (initial) => {
      if (!active || !initial) return;
      publish(initial);
      // 一次性迁移:早期版本装的模型没有验证标记,打开本页时补做一次校验。
      if (initial.model_installed && !initial.model_verified) {
        setPhase("verifying");
        try {
          const verified = await verifyDictationModel();
          if (active) publish(verified);
        } catch (err) {
          if (active) setError(voiceErrorMessage(err));
        } finally {
          if (active) setPhase("idle");
        }
      }
    });
    return () => {
      active = false;
      unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async () => {
    setError(null);
    setConfirmDelete(false);
    setProgress({ downloaded_bytes: 0, total_bytes: status?.model_bytes || 0 });
    setPhase("downloading");
    try {
      publish(await downloadDictationModel());
    } catch (err) {
      setError(voiceErrorMessage(err));
      const latest = await getDictationStatus();
      if (latest) publish(latest);
    } finally {
      setPhase("idle");
    }
  };

  const repair = async () => {
    setError(null);
    try {
      publish(await deleteDictationModel());
      await download();
    } catch (err) {
      setError(voiceErrorMessage(err));
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setError(null);
    try {
      publish(await deleteDictationModel());
      setTranscript("");
      setProgress(null);
    } catch (err) {
      setError(voiceErrorMessage(err));
    }
  };

  const toggleTest = async () => {
    if (!status?.supported || !status.model_verified) return;
    setError(null);
    try {
      if (status.recording) {
        setPhase("transcribing");
        const text = (await stopDictation()).trim();
        setTranscript(text);
        if (!text) throw new Error("没有听到任何声音 —— 请再试一次,说话时间稍长一些。");
        publish(await markDictationTestPassed());
      } else {
        setTranscript("");
        setPhase("testing");
        publish(await startDictation());
      }
    } catch (err) {
      setError(voiceErrorMessage(err));
      const latest = await getDictationStatus();
      if (latest) publish(latest);
    } finally {
      setPhase("idle");
    }
  };

  const downloading = phase === "downloading" || !!status?.download_in_progress;
  const percent = downloadPercent(progress, status);
  const ready = dictationReady(status);
  const modelName = status?.model_name || "Whisper Base · English";

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-xl border border-okLine bg-okSoft px-4 py-3 text-[12.5px] text-ok">
        <span className="font-medium">隐私保障。</span>音频仅在录音时保留在内存中,转写在本机完成。
      </div>

      {/* 设备兼容性 */}
      <div className={GRP}>
        <div className="flex items-start gap-3 px-4 py-3">
          <Icon name="cpu" size={16} className="mt-0.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">本机</div>
            <div className="mt-0.5 text-[12px] text-muted">
              {status?.device_summary || "正在检查兼容性…"}
            </div>
            {status?.compatibility_reason && (
              <div className="mt-1 text-[12px] text-danger">{status.compatibility_reason}</div>
            )}
          </div>
          {status && (
            <span className={`${TAG} ${status.supported ? "bg-okSoft text-ok" : "bg-dangerSoft text-danger"}`}>
              {status.supported ? "兼容" : "不支持"}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 border-t border-line bg-paper/50 px-4 py-3 text-[12px] text-muted">
          {REQUIREMENTS.map(([label, text]) => (
            <div key={label}>
              <span className="block font-medium text-ink">{label}</span>
              {text}
            </div>
          ))}
        </div>
      </div>

      {/* 模型 */}
      <div className={GRP}>
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accentSoft text-[14px] font-semibold text-accent">
            W
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{modelName}</div>
            <div className="mt-0.5 text-[12px] text-muted">
              {status?.model_verified
                ? `已安装并验证 · ${formatBytes(status.model_bytes)}`
                : `本地语音模型 · ${formatBytes(status?.model_bytes || 147_964_211)}`}
            </div>
          </div>
          {status?.model_verified ? (
            <>
              <span className={`${TAG} bg-okSoft text-ok`}>已验证</span>
              <button type="button" className={BTN} onClick={() => void repair()}>
                修复
              </button>
              {confirmDelete ? (
                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="rounded-lg bg-danger px-2.5 py-1.5 text-[12px] font-medium text-white"
                    onClick={() => void remove()}
                  >
                    删除
                  </button>
                  <button type="button" className={BTN} onClick={() => setConfirmDelete(false)}>
                    保留
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="px-1 py-1.5 text-[12px] text-danger hover:underline"
                  onClick={() => setConfirmDelete(true)}
                >
                  删除模型
                </button>
              )}
            </>
          ) : downloading ? (
            <button
              type="button"
              className={BTN}
              onClick={() => void cancelDictationModelDownload().catch(() => undefined)}
            >
              取消
            </button>
          ) : phase === "verifying" ? (
            <span className="flex items-center gap-1.5 text-[12px] text-muted">
              <span className="spinner" /> 验证中…
            </span>
          ) : (
            <button
              type="button"
              className={BTN_ACCENT}
              disabled={!status?.supported}
              onClick={() => void download()}
            >
              下载模型
            </button>
          )}
        </div>
        {downloading && (
          <div className="border-t border-line px-4 py-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
            </div>
            <div className="mt-1.5 flex text-[11.5px] text-muted">
              <span>
                {formatBytes(progress?.downloaded_bytes || 0)} /{" "}
                {formatBytes(progress?.total_bytes || status?.model_bytes || 0)}
              </span>
              <span className="ml-auto">{percent}%</span>
            </div>
          </div>
        )}
      </div>

      {/* 麦克风测试 */}
      <div className={GRP}>
        <div className="flex items-center gap-3 px-4 py-3">
          <Icon name="mic" size={16} className={ready ? "shrink-0 text-ok" : "shrink-0 text-muted"} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">麦克风测试</div>
            <div className="mt-0.5 text-[12px] text-muted">
              {ready
                ? "麦克风与本地转写引擎工作正常。"
                : "模型下载并验证后,录一句短语来启用输入框的麦克风。"}
            </div>
          </div>
          {ready && <span className={`${TAG} bg-okSoft text-ok`}>已就绪</span>}
          <button
            type="button"
            className={BTN}
            disabled={!status?.supported || !status?.model_verified || phase === "transcribing"}
            onClick={() => void toggleTest()}
          >
            {status?.recording
              ? "停止并检查"
              : phase === "transcribing"
                ? "转写中…"
                : ready
                  ? "再测一次"
                  : "测试麦克风"}
          </button>
        </div>
        {status?.recording && (
          <div className="border-t border-line px-4 py-3 text-[12px] text-accent" role="status">
            ● 正在聆听…说一句短语,然后点击「停止并检查」。
          </div>
        )}
        {transcript && (
          <div className="border-t border-line bg-paper/50 px-4 py-3 text-[13px]">
            「{transcript}」
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-danger/30 bg-dangerSoft px-4 py-3 text-[12px] text-danger"
        >
          {error}
        </div>
      )}
    </div>
  );
}

export function VoiceSection() {
  return (
    <section>
      <SectionHeader
        title="语音"
        sub="在输入框中自然说话。录音与转写都在本机完成,不会发送到任何语音服务。"
      />
      {isTauri() ? (
        <VoiceDesktop />
      ) : (
        <div className={GRP + " mt-4 px-4 py-3.5 text-[13px] text-muted"}>
          语音输入仅在桌面应用中可用。打开桌面应用后,即可在此下载本地语音模型并测试麦克风。
        </div>
      )}
    </section>
  );
}
