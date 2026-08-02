// 时间线 — 任务 ledger 的实时事件流。事件由 useMissionDetail 维护(REST 全量 + WS 追加),
// 这里只负责把每条事件渲染成一行中文摘要(最新的在最上面),成员相关事件带上席位标签。

import { Icon } from "../../components/Icon";
import type { MissionEvent } from "../../lib/api/types";
import { formatTime, humanizeMissionEvent } from "./missionLogic";
import type { MissionConnection } from "./useMissionDetail";

const CONNECTION_LABEL: Record<MissionConnection, string> = {
  connecting: "连接中",
  connected: "实时",
  disconnected: "已断开",
};

export function Timeline({
  events,
  connection,
}: {
  events: MissionEvent[];
  connection: MissionConnection;
}) {
  // 最新在前:长任务下无需滚动管理,WS 追加的事件天然出现在顶部。
  const ordered = [...events].reverse();
  return (
    <section className="overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight">时间线</h2>
        <span className="flex items-center gap-1.5 text-[11px] text-faint">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connection === "connected"
                ? "bg-ok"
                : connection === "connecting"
                  ? "bg-warnInk"
                  : "bg-danger"
            }`}
          />
          {CONNECTION_LABEL[connection]} · {events.length} 条事件
        </span>
      </header>
      {ordered.length === 0 ? (
        <p className="px-4 py-6 text-[12.5px] text-faint">还没有事件,任务的每一步都会记录在这里。</p>
      ) : (
        <ol className="divide-y divide-line">
          {ordered.map((event, index) => {
            const line = humanizeMissionEvent(event);
            return (
              <li key={event.event_id || `${event.cursor}-${index}`} className="flex items-start gap-3 px-4 py-2.5">
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-paper text-muted">
                  <Icon name={line.icon} size={13} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[12.5px] font-medium">{line.title}</span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-faint">
                      {formatTime(event.created_at)}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-muted">{line.detail}</span>
                  {line.member && (
                    <span className="mt-1 inline-block rounded bg-paper px-1.5 py-0.5 font-mono text-[10.5px] text-faint">
                      {line.member}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
