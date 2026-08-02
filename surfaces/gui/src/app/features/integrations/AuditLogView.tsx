// 审计 tab: the connector/tool call log. Compact grid rows (时间 · 会话/Agent ·
// 连接器/工具 · 目标 · 结果), each expandable to sanitized args + result preview.
// The API pages by `limit` only, so 加载更多 grows the window (+100) and refetches;
// connector/tool/session filters ride the endpoint's own params.

import { useCallback, useEffect, useState } from "react";
import { getAudit } from "../../lib/api/connectors";
import type { AuditEntry } from "../../lib/api/types";
import { auditTone, formatAuditArgs, formatTimestamp, truncate } from "./integrationLogic";
import { GRP, INPUT, PILL_LINE, ROW, TAG_QUIET, TAG_WARN } from "./ui";
import { Dot } from "./widgets";

const PAGE = 100;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function AuditLogView() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [connector, setConnector] = useState("");
  const [tool, setTool] = useState("");
  const [sessionId, setSessionId] = useState("");
  // Filters apply on 筛选 (a deliberate act), not on every keystroke.
  const [applied, setApplied] = useState({ connector: "", tool: "", sessionId: "" });

  const load = useCallback(async () => {
    setError(null);
    try {
      const events = await getAudit({
        limit,
        connector: applied.connector || undefined,
        tool: applied.tool || undefined,
        session_id: applied.sessionId || undefined,
      });
      setEntries(events);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, [limit, applied]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // A full page came back — there may be more behind the limit.
  const maybeMore = entries.length >= limit;

  return (
    <div>
      <header>
        <h2 className="text-[22px] font-semibold tracking-tight">审计</h2>
        <p className="mt-1 text-[13px] text-muted">
          连接器与工具的每次调用。参数在入库前已经脱敏。
        </p>
      </header>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          className={`${INPUT} !w-36`}
          placeholder="连接器"
          value={connector}
          onChange={(e) => setConnector(e.target.value)}
        />
        <input
          className={`${INPUT} !w-36`}
          placeholder="工具"
          value={tool}
          onChange={(e) => setTool(e.target.value)}
        />
        <input
          className={`${INPUT} !w-44 font-mono`}
          placeholder="会话 ID"
          value={sessionId}
          spellCheck={false}
          onChange={(e) => setSessionId(e.target.value)}
        />
        <button
          type="button"
          className={PILL_LINE}
          onClick={() =>
            setApplied({
              connector: connector.trim(),
              tool: tool.trim(),
              sessionId: sessionId.trim(),
            })
          }
        >
          筛选
        </button>
      </div>

      {error && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-faint">
          <span className="spinner spinner-lg" /> 加载中
        </div>
      ) : entries.length === 0 ? (
        <div className={`${GRP} mt-4`}>
          <div className={`${ROW} text-[12.5px] text-muted`}>还没有审计记录。</div>
        </div>
      ) : (
        <>
          <div className={`${GRP} mt-4 divide-y divide-line`} data-testid="audit-list">
            {entries.map((e) => (
              <AuditRow key={e.id} entry={e} />
            ))}
          </div>
          {maybeMore && (
            <div className="mt-3 text-center">
              <button type="button" className={PILL_LINE} onClick={() => setLimit((n) => n + PAGE)}>
                加载更多(已显示 {entries.length} 条)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AuditRow({ entry: e }: { entry: AuditEntry }) {
  const tone = auditTone(e);
  const actor = e.agent || e.session_id || "-";
  const action = e.tool || e.stage || "event";
  const statusLabel = e.status || e.stage || "—";
  const hasDetail =
    (e.args && Object.keys(e.args).length > 0) || e.result_preview || e.reason || e.workspace;

  return (
    <details className="group">
      <summary
        className={`${ROW} cursor-pointer list-none hover:bg-paper/50 [&::-webkit-details-marker]:hidden`}
      >
        <span className="w-[74px] shrink-0 font-mono text-[11px] text-faint" title={e.timestamp}>
          {formatTimestamp(e.timestamp)}
        </span>
        <span className="w-28 shrink-0 truncate text-[12px] text-muted" title={e.session_id}>
          {actor}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[12px] font-medium">{action}</span>
            {e.connector && <span className={TAG_QUIET}>{e.connector}</span>}
          </span>
          {e.resource && (
            <span className="mt-0.5 block truncate text-[11.5px] text-faint" title={e.resource}>
              {truncate(e.resource, 80)}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Dot tone={tone} />
          <span className={tone === "warn" ? TAG_WARN : TAG_QUIET}>{statusLabel}</span>
        </span>
        {hasDetail && (
          <span className="shrink-0 text-faint transition-transform group-open:rotate-90">›</span>
        )}
      </summary>
      {hasDetail && (
        <div className="space-y-1 border-t border-line bg-paper/40 px-4 py-2.5 text-[11.5px]">
          {e.args && Object.keys(e.args).length > 0 && (
            <div className="break-words font-mono text-muted">{formatAuditArgs(e.args)}</div>
          )}
          {e.workspace && <div className="text-faint">workspace: {e.workspace}</div>}
          {e.approval && <div className="text-faint">approval: {e.approval}</div>}
          {(e.reason || e.result_preview) && (
            <div className="text-faint">{e.reason || e.result_preview}</div>
          )}
        </div>
      )}
    </details>
  );
}
