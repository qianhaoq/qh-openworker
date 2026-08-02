// The connect sheet — the ONE place a connection gets added. Two panes, shown
// alone or behind a 一键连接 | 手动连接 switcher:
// - MCP-backed one-click (c.mcp): the sidecar runs a local OAuth flow and opens
//   the vendor sign-in in the system browser; we poll the list until connected.
// - Manual fields: the descriptor's `fields` + `instructions` (token paste).
// Experimental connectors bounce with "risk acknowledgment required" — the sheet
// then shows an acknowledge checkbox and retries with acknowledge_risk.

import { useEffect, useRef, useState } from "react";
import type { Connector } from "../../lib/api/types";
import { Icon } from "../../components/Icon";
import type { useConnectors } from "./useConnectors";
import { INPUT, PILL_ACCENT, PILL_LINE } from "./ui";
import { ConnectorBadge } from "./widgets";

type Connectors = ReturnType<typeof useConnectors>;

export function ConnectSheet({
  c,
  ctl,
  onClose,
}: {
  c: Connector;
  ctl: Connectors;
  onClose: () => void;
}) {
  const twoModes = !!c.mcp && c.fields.length > 0;
  const [pane, setPane] = useState<"one" | "manual">(c.mcp ? "one" : "manual");

  // Connect failures are sheet-local now — sweep any page-level alert a previous
  // flow left behind when the sheet goes away.
  const { clearActionError } = ctl;
  useEffect(() => () => clearActionError(), [clearActionError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-close only after an MCP-backed browser flow the sheet started (the poll
  // flips connected). Opening the sheet for an already-connected connector (添加账户)
  // must NOT close it — hence the was-waiting latch, not a plain connected check.
  const waiting = ctl.pendingConnects.has(c.name);
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useEffect(() => {
    if (wasWaiting.current && c.connected) onClose();
  }, [c.connected, onClose]);

  return (
    <div className="fixed inset-0 z-40" data-testid="connect-sheet">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden="true" />
      <div
        className="absolute left-1/2 top-[14%] w-[480px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-2xl border border-line bg-panel shadow-2xl"
        role="dialog"
        aria-label={`连接 ${c.title}`}
      >
        <div className="flex items-center gap-3 px-5 pt-5">
          <ConnectorBadge c={c} />
          <div className="flex-1 text-[16px] font-semibold tracking-tight">连接 {c.title}</div>
          <button
            type="button"
            className="grid h-6 w-6 place-items-center rounded text-faint hover:bg-paper hover:text-ink"
            title="关闭"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {twoModes && (
          <div className="px-5 pt-4">
            <div className="inline-flex rounded-full bg-paper p-0.5 text-[12.5px] font-medium">
              {(
                [
                  ["one", "一键连接"],
                  ["manual", "手动连接"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded-full px-3.5 py-1 ${
                    pane === key ? "border border-line bg-panel text-ink shadow-sm" : "text-muted"
                  }`}
                  onClick={() => setPane(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {pane === "one" && c.mcp ? (
          <McpOneClickPane c={c} ctl={ctl} />
        ) : (
          <ManualPane c={c} ctl={ctl} onConnected={onClose} />
        )}
      </div>
    </div>
  );
}

/** MCP-backed one-click: local OAuth against the vendor's hosted MCP — no tokens
 * typed, no cloud sign-in. The sidecar opens the browser; the hook polls. */
function McpOneClickPane({ c, ctl }: { c: Connector; ctl: Connectors }) {
  const [error, setError] = useState<string | null>(null);
  const waiting = ctl.pendingConnects.has(c.name);
  const go = async () => {
    setError(null);
    const result = await ctl.startMcpConnect(c.name);
    if (!result.ok) setError(result.error || "无法启动连接");
  };
  return (
    <div className="space-y-3 px-5 py-4" data-testid="connect-pane-mcp">
      <p className="text-[13px] text-muted">
        将在浏览器中打开 {c.title} 登录页,登录并授权即可。无需填写令牌,登录流程完全在这台电脑上完成。
      </p>
      <button
        type="button"
        className={`${PILL_ACCENT} w-full !py-2`}
        onClick={go}
        disabled={waiting}
      >
        {waiting ? "请在浏览器中完成授权…" : `连接 ${c.title}`}
      </button>
      {error && <div className="text-[12.5px] text-danger">{error}</div>}
      <p className="text-center text-[12px] text-faint">
        推荐 · 令牌只保存在这台电脑上
      </p>
    </div>
  );
}

/** Manual token paste, driven by the descriptor's fields + instructions. */
function ManualPane({
  c,
  ctl,
  onConnected,
}: {
  c: Connector;
  ctl: Connectors;
  onConnected: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [riskNotice, setRiskNotice] = useState<string | null>(null);

  const ready = c.fields.every((f) => !f.required || (values[f.key] ?? "").trim());
  const submit = async () => {
    setBusy(true);
    setError(null);
    const fields: Record<string, string> = {};
    for (const f of c.fields) {
      const v = (values[f.key] ?? "").trim();
      if (v) fields[f.key] = v;
    }
    const result = await ctl.connectFields(c.name, fields, acknowledge);
    setBusy(false);
    // A token-paste connect succeeds synchronously (the account list refresh rides
    // the hook); multi-account connectors were already connected, so close here.
    if (result.ok) {
      onConnected();
      return;
    }
    const text = result.error || "连接失败";
    if (text.includes("risk acknowledgment")) {
      setRiskNotice(text);
      setError(null);
    } else {
      setError(text);
    }
  };

  return (
    <div className="space-y-3 px-5 py-4" data-testid="connect-pane-manual">
      {c.instructions.length > 0 && (
        <ol className="list-decimal space-y-1 pl-4 text-[13px] text-muted">
          {c.instructions.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}
      {c.fields.map((f) => (
        <div key={f.key}>
          <input
            className={INPUT}
            type={f.secret ? "password" : "text"}
            placeholder={f.placeholder || f.label}
            title={f.help || f.label}
            value={values[f.key] ?? ""}
            spellCheck={false}
            onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
          />
          {f.help && <p className="mt-1 text-[11.5px] text-faint">{f.help}</p>}
        </div>
      ))}
      {riskNotice && (
        <label className="flex items-start gap-2 text-[12.5px] text-warnInk">
          <input
            type="checkbox"
            className="mt-0.5 h-[15px] w-[15px] accent-accent"
            checked={acknowledge}
            onChange={(e) => setAcknowledge(e.target.checked)}
          />
          这是实验性连接器,可能存在稳定性或安全风险。我已了解,仍要连接。
        </label>
      )}
      <button
        type="button"
        className={`${PILL_LINE} w-full !py-2`}
        onClick={submit}
        disabled={busy || !ready || (!!riskNotice && !acknowledge)}
      >
        {busy ? "验证中…" : "连接"}
      </button>
      {error && <div className="text-[12.5px] text-danger">{error}</div>}
      {c.name === "slack" && c.mode === "relay" && (
        <p className="text-center text-[12px] text-warnInk">
          一次只能使用一种模式 — 手动令牌会暂停所有中继工作区。
        </p>
      )}
    </div>
  );
}
