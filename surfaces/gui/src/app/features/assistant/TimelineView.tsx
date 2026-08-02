// The conversation renderer: user bubbles right, assistant markdown left, tool calls
// collapsed into quiet turn groups ("N 个步骤") with narration interleaved, pending prompt
// cards inline, notices as dividers/banners, and the streaming/waiting area at the tail.
// Grouping logic ports the old Transcript (§33): a turn = the maximal run of
// tool/assistant/resolved-approval items between breakers.

import { useState } from "react";
import type { ApprovalDecision, MessageSource } from "../../lib/api/types";
import { Icon } from "../../components/Icon";
import { Markdown } from "../../components/Markdown";
import { navigate } from "../../nav";
import { humanizeAsk, humanizeTool, shortArgs, type HumanLine } from "./humanize";
import {
  lastItemIsAssistant,
  retryAnchor,
  streamMode,
  type ApprovalItem,
  type AssistantItem,
  type TimelineItem,
  type ToolItem,
} from "./timeline";
import { ApprovalCard, DirectoryCard, PlanCard, QuestionCard } from "./PromptCards";

// ---------------------------------------------------------------------------
// The assistant's presence: a small round avatar chip aligned with the message top —
// Q's brand mark on the accent gradient, or an ACP agent's initial on a teal tint.
// ---------------------------------------------------------------------------

export interface TimelineAgent {
  kind: "q" | "acp";
  /** ACP display name (profile id / "ACP") — the chip shows its first character. */
  name?: string;
}

const DEFAULT_AGENT: TimelineAgent = { kind: "q" };

/** The label over an assistant bubble: Q, or the ACP agent's name. */
export const agentLabel = (agent: TimelineAgent): string =>
  agent.kind === "q" ? "Q" : agent.name || "ACP";

export function AssistantAvatar({ agent, live }: { agent: TimelineAgent; live?: boolean }) {
  const isQ = agent.kind === "q";
  return (
    <span
      className={`assistant-avatar ${isQ ? "assistant-avatar-q" : "assistant-avatar-acp"} ${
        live ? "assistant-avatar-live" : ""
      }`}
      title={agentLabel(agent)}
      data-testid="assistant-avatar"
    >
      {isQ ? <Icon name="brand" size={12} /> : (agent.name || "A").charAt(0).toUpperCase()}
    </span>
  );
}

// Long user pastes swallow the transcript: clamp with a 展开/收起 toggle.
const USER_CLAMP_CHARS = 1200;

/** 320 → "320ms", 1500 → "1.5s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ClampedUserText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (text.length <= USER_CLAMP_CHARS) return <>{text}</>;
  return (
    <>
      {open ? text : text.slice(0, USER_CLAMP_CHARS).trimEnd() + "…"}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="ml-2 text-[12.5px] font-medium opacity-75 hover:opacity-100"
      >
        {open ? "收起" : "展开"}
      </button>
    </>
  );
}

// Hover affordances for a message bubble: copy the raw text + the message's time, in a
// zero-height strip so revealing it never shifts the layout.
function BubbleMeta({ text, ts, align }: { text: string; ts?: number; align: "left" | "right" }) {
  const [copied, setCopied] = useState(false);
  const when = typeof ts === "number" ? new Date(ts * 1000) : null;
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };
  return (
    <div className="relative h-0 select-none">
      <div
        className={`absolute top-1 flex items-center gap-1.5 whitespace-nowrap text-[10.5px] leading-none text-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
          align === "right" ? "right-0" : "left-0"
        }`}
      >
        <button
          type="button"
          className="flex cursor-pointer items-center hover:text-muted"
          data-testid="bubble-copy"
          title="复制内容"
          onClick={copy}
        >
          {copied ? "已复制" : <Icon name="copy" size={11} />}
        </button>
        {when && (
          <span title={when.toLocaleString("zh-CN")}>
            {when.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
          </span>
        )}
      </div>
    </div>
  );
}

// Reasoning-model thinking text: a quiet disclosure — collapsed by default, the trace one
// click away. `live` = still streaming (pulsing label).
export function ThinkingBlock({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[12px] text-faint hover:text-muted"
        onClick={() => setOpen((v) => !v)}
        data-testid="thinking-toggle"
      >
        <Icon
          name="chevronRight"
          size={11}
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className={live ? "animate-pulse" : undefined}>
          {live ? "正在思考…" : "思考过程"}
        </span>
      </button>
      {open && (
        <div
          className="ml-4 mt-1 whitespace-pre-wrap border-l-2 border-line pl-2.5 text-[12.5px] leading-relaxed text-muted"
          data-testid="thinking-body"
        >
          {text}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Turn grouping (§33)
// ---------------------------------------------------------------------------

type TurnItem = ToolItem | ApprovalItem | AssistantItem;

type TurnRow =
  | { type: "narr"; text: string }
  | { type: "step"; tool: ToolItem; approval?: ApprovalItem }
  | { type: "ask"; approval: ApprovalItem };

function buildRows(items: TurnItem[]): TurnRow[] {
  const rows: TurnRow[] = items
    .filter((it): it is ToolItem | AssistantItem => it.kind !== "approval")
    .filter((it) => it.kind !== "assistant" || it.text)
    .map((it) =>
      it.kind === "assistant" ? { type: "narr" as const, text: it.text } : { type: "step" as const, tool: it },
    );
  // Pair each resolved approval with the nearest same-name tool that doesn't have one yet.
  const approvals = items.filter((it): it is ApprovalItem => it.kind === "approval");
  for (const ap of approvals) {
    const at = items.indexOf(ap);
    let bestRow: Extract<TurnRow, { type: "step" }> | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "tool" || it.name !== ap.name) continue;
      const row = rows.find((r) => r.type === "step" && r.tool === it) as
        | Extract<TurnRow, { type: "step" }>
        | undefined;
      if (!row || row.approval) continue;
      const dist = Math.abs(i - at);
      if (dist < bestDist) {
        bestRow = row;
        bestDist = dist;
      }
    }
    if (bestRow && ap.resolved !== "deny") bestRow.approval = ap;
    else {
      const after = items.slice(0, at).filter((it) => it.kind !== "approval").length;
      rows.splice(after, 0, { type: "ask", approval: ap });
    }
  }
  return rows;
}

function approvalChip(resolved: ApprovalDecision | undefined) {
  if (resolved === "deny")
    return (
      <span className="shrink-0 rounded-full bg-dangerSoft px-1.5 text-[10.5px] text-danger">
        ✕ 已拒绝
      </span>
    );
  return (
    <span
      className="shrink-0 rounded-full bg-okSoft px-1.5 text-[10.5px] text-ok"
      title={resolved ? `已批准 · ${DECISION_TEXT[resolved] ?? resolved}` : "已批准"}
    >
      ✓ 已批准
    </span>
  );
}

const DECISION_TEXT: Record<string, string> = {
  once: "一次",
  always_tool: "始终允许",
  always_command: "始终允许此命令",
  always_task: "此任务始终允许",
};

function LineText({ line }: { line: HumanLine }) {
  return (
    <span className="min-w-0 truncate text-[13px] leading-relaxed">
      <span className="text-muted">{line.pre}</span>
      {line.obj && <span className="text-ink">{line.obj}</span>}
      {line.post && <span className="text-muted">{line.post}</span>}
    </span>
  );
}

function StepRow({ tool, approval }: { tool: ToolItem; approval?: ApprovalItem }) {
  const [raw, setRaw] = useState(false);
  const running = tool.status === "…";
  const failed = tool.status !== "ok" && !running;
  return (
    <div>
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-lg px-2 py-0.5 text-left hover:bg-paper"
        onClick={() => setRaw((v) => !v)}
        data-testid="turn-step"
      >
        <span
          className={`w-3.5 shrink-0 text-center text-[10px] ${
            failed ? "text-danger" : running ? "text-accent" : "text-ok"
          }`}
        >
          {running ? <span className="spinner" data-testid="step-running" /> : "●"}
        </span>
        <LineText line={humanizeTool(tool.name, tool.args)} />
        {approval && approvalChip(approval.resolved)}
        {!!tool.standingRule && (
          <span
            className="shrink-0 rounded-full bg-tealSoft px-1.5 text-[10.5px] text-tealInk"
            title={`由自动化的长期授权自动允许：${tool.standingRule}`}
          >
            自动允许
          </span>
        )}
        {!!tool.hidden && (
          <span
            className="shrink-0 text-[11px] text-warnInk"
            title="这些内容在助手看到之前已被你的隐私过滤移除"
          >
            {tool.hidden} 条已隐藏
          </span>
        )}
        {failed && <span className="shrink-0 text-[11px] text-danger">{tool.status}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {typeof tool.durationMs === "number" && !running && (
            <span className="text-[10.5px] tabular-nums text-faint">{formatDuration(tool.durationMs)}</span>
          )}
          <Icon
            name="chevronRight"
            size={11}
            className={`text-faint transition-transform ${raw ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {raw && (
        <pre className="my-1 ml-8 mr-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-muted">
          {`${tool.name}  ${shortArgs(tool.args)}`}
          {tool.preview
            ? `\n→ ${tool.preview.length > 1500 ? tool.preview.slice(0, 1500) + "\n…" : tool.preview}`
            : ""}
        </pre>
      )}
    </div>
  );
}

function TurnGroup({
  items,
  live,
  streamingText,
}: {
  items: TurnItem[];
  live?: boolean;
  // Sub-threshold streamed text belongs to THIS group: collapsed → it rides the header as
  // the live line; expanded → the small quiet line under the steps.
  streamingText?: string;
}) {
  // Turns start COLLAPSED, running or not — the header's live line is the pulse.
  const rows = buildRows(items);
  const tools = items.filter((it): it is ToolItem => it.kind === "tool");
  const running = live || tools.some((t) => t.status === "…");
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const open = userToggle ?? false;
  const lastNarr = [...items].reverse().find((it): it is AssistantItem => it.kind === "assistant");
  const liveLine = streamingText || lastNarr?.text || "";

  const nSteps = rows.filter((r) => r.type !== "narr").length;
  const declined = items.filter((it) => it.kind === "approval" && it.resolved === "deny").length;
  const stepsLabel = `${nSteps} 个步骤`;

  return (
    <div>
      <button
        type="button"
        className="flex w-full cursor-pointer select-none items-center gap-2 py-0.5 text-left text-[12.5px] text-faint hover:text-muted"
        onClick={() => setUserToggle(!open)}
        data-testid="turn-group-head"
      >
        <Icon
          name="chevronRight"
          size={11}
          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="shrink-0">
          {running ? `正在运行 ${stepsLabel}…` : stepsLabel}
          {declined > 0 && <span className="text-danger"> · {declined} 个被拒绝</span>}
        </span>
        {running && !open && liveLine && (
          <span className="min-w-0 flex-1 truncate" data-testid="turn-live-line">
            · {liveLine}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-1.5 mt-1 flex flex-col gap-0.5 border-l-2 border-line pl-2">
          {rows.map((row, i) =>
            row.type === "narr" ? (
              <div className="max-w-[60ch] px-2 py-1 text-[13px] text-muted" key={i} data-testid="turn-narration">
                <Markdown text={row.text} />
              </div>
            ) : row.type === "ask" ? (
              <div className="flex items-baseline gap-2 px-2 py-0.5" key={i} data-testid="turn-ask">
                <span
                  className={`w-3.5 shrink-0 text-center text-[10px] ${
                    row.approval.resolved === "deny" ? "text-danger" : "text-ok"
                  }`}
                >
                  ●
                </span>
                <LineText line={humanizeAsk(row.approval.name, row.approval.args)} />
                {approvalChip(row.approval.resolved)}
              </div>
            ) : (
              <StepRow tool={row.tool} approval={row.approval} key={i} />
            ),
          )}
          {streamingText && (
            <div className="max-w-[60ch] px-2 py-1 text-[13px] text-muted" data-testid="turn-live-stream">
              <Markdown text={streamingText} />
              <span className="stream-cursor" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A connector-delivered inbound message: quiet structured card (sender · channel · time).
function ConnectorCard({ source }: { source: MessageSource }) {
  const when = new Date(source.ts * 1000);
  return (
    <article className="overflow-hidden rounded-xl2 border border-line bg-panel" data-testid="connector-card">
      <header className="flex items-center gap-2 border-b border-line bg-paper px-3.5 py-2">
        <span className="text-[12.5px] font-semibold">
          {source.kind === "dm" ? "私信" : source.channel_name || source.channel_id}
        </span>
        <span className="text-faint">·</span>
        <span className="text-[12.5px] font-medium">{source.sender_name}</span>
        <span className="text-[11px] text-faint">来自 {source.connector}</span>
        <span className="ml-auto text-[11px] text-faint">
          {when.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
        </span>
      </header>
      <div className="whitespace-pre-wrap px-3.5 py-2.5 text-[14.5px] leading-relaxed">
        {source.text}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

export interface TimelineProps {
  items: TimelineItem[];
  running: boolean;
  compacting: boolean;
  streaming: string;
  reasoning: string;
  /** Who is answering — drives the avatar chip + bubble label. Defaults to Q. */
  agent?: TimelineAgent;
  onRetry: () => void;
  onApprove: (decision: ApprovalDecision) => void;
  onRespondPlan: (approved: boolean, mode?: string, feedback?: string) => void;
  onRespondDirectory: (granted: boolean, path?: string, writable?: boolean) => void;
  onAnswerQuestion: (answer: string) => void;
}

export function Timeline({
  items,
  running,
  compacting,
  streaming,
  reasoning,
  agent = DEFAULT_AGENT,
  onRetry,
  onApprove,
  onRespondPlan,
  onRespondDirectory,
  onAnswerQuestion,
}: TimelineProps) {
  // §33 grouping: a turn = the maximal run of tool/assistant/resolved-approval items
  // between breakers. Trailing assistant texts are the ANSWER (bubbles after the group);
  // interior ones are narration and stay inside. Pending prompts break the run and render
  // as inline cards right where they were raised.
  const blocks: Array<{ turn: TurnItem[]; live?: boolean } | { item: TimelineItem; i: number }> = [];
  let run: TurnItem[] = [];
  const flush = (live = false) => {
    if (!run.length) return;
    const turn = [...run];
    run = [];
    const answers: AssistantItem[] = [];
    // A live run with tool activity keeps its trailing text inside as the status line;
    // a live run with NO activity is a plain streaming reply — bubbles, as ever.
    const keepTrailing = live && turn.some((it) => it.kind !== "assistant");
    if (!keepTrailing)
      while (turn.length && turn[turn.length - 1].kind === "assistant")
        answers.unshift(turn.pop() as AssistantItem);
    if (turn.some((it) => it.kind !== "assistant")) blocks.push({ turn, live });
    else turn.forEach((t) => blocks.push({ item: t, i: -1 }));
    answers.forEach((a) => blocks.push({ item: a, i: -1 }));
  };
  items.forEach((item, i) => {
    if (item.kind === "tool" || item.kind === "assistant" || (item.kind === "approval" && item.resolved)) {
      run.push(item);
    } else {
      flush();
      blocks.push({ item, i });
    }
  });
  flush(!!running);

  const lastTurnIndex = blocks.reduce((acc, b, i) => ("turn" in b ? i : acc), -1);
  const mode = streamMode(streaming, items, running);
  const showWaiting =
    running &&
    !compacting &&
    !reasoning &&
    (!streaming || mode === "hold") &&
    !lastItemIsAssistant(items);

  return (
    <div className="flex flex-col gap-5">
      {blocks.map((block, bi) => {
        if ("turn" in block)
          return (
            <TurnGroup
              items={block.turn}
              live={block.live}
              streamingText={block.live && bi === lastTurnIndex && mode === "quiet" ? streaming : undefined}
              key={bi}
            />
          );
        const { item } = block;
        switch (item.kind) {
          case "connector":
            return <ConnectorCard source={item.source} key={bi} />;
          case "user":
            return (
              <div className="group flex max-w-[78%] flex-col items-end self-end" key={bi}>
                <div className="whitespace-pre-wrap rounded-[14px_14px_4px_14px] bg-solid px-3.5 py-2.5 text-[14.5px] leading-relaxed text-onSolid">
                  {!!item.attachments?.length && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {item.attachments.map((a, i) =>
                        a.kind === "image" ? (
                          <img
                            key={i}
                            className="max-h-40 rounded-lg border border-line"
                            src={a.data_url}
                            alt={a.name}
                          />
                        ) : (
                          <span
                            key={i}
                            className="inline-flex items-center gap-1 rounded-md border border-line bg-panel/60 px-1.5 py-0.5 text-[11.5px]"
                          >
                            <Icon name="file" size={11} /> {a.name}
                          </span>
                        ),
                      )}
                    </div>
                  )}
                  <ClampedUserText text={item.text} />
                </div>
                <BubbleMeta text={item.text} ts={item.ts} align="right" />
              </div>
            );
          case "assistant":
            // Thinking-only item (stopped mid-reasoning): just the disclosure, no bubble.
            if (!item.text && item.reasoning)
              return <ThinkingBlock text={item.reasoning} key={bi} />;
            return (
              <div className="group flex items-start gap-2.5" key={bi}>
                <AssistantAvatar agent={agent} />
                <div className="min-w-0 flex-1">
                  <div
                    className={`mb-1 text-[11px] tracking-[0.06em] text-faint ${
                      agent.kind === "q" ? "uppercase" : ""
                    }`}
                  >
                    {agentLabel(agent)}
                  </div>
                  {item.reasoning && <ThinkingBlock text={item.reasoning} />}
                  <Markdown text={item.text} />
                  <BubbleMeta text={item.text} ts={item.ts} align="left" />
                </div>
              </div>
            );
          case "approval":
            return item.resolved ? null : (
              <ApprovalCard item={item} onApprove={onApprove} key={bi} />
            );
          case "question":
            return <QuestionCard item={item} onAnswer={onAnswerQuestion} key={bi} />;
          case "planreq":
            return <PlanCard item={item} onRespond={onRespondPlan} key={bi} />;
          case "dirreq":
            return <DirectoryCard item={item} onRespond={onRespondDirectory} key={bi} />;
          case "notice":
            // 信息类：细分隔线；警告/错误：内联横幅（错误可重试，仅限末尾）。
            if (item.tone === "info") {
              return (
                <div className="flex items-center gap-3 text-[11.5px] text-faint" key={bi} data-testid="notice-info">
                  <span className="h-px flex-1 bg-line" />
                  <span className="shrink-0">{item.text}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              );
            }
            return (
              <div
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] ${
                  item.tone === "error"
                    ? "border-danger/30 bg-dangerSoft text-danger"
                    : "border-warnInk/30 bg-warnSoft text-warnInk"
                }`}
                key={bi}
                role={item.tone === "error" ? "alert" : undefined}
              >
                <span className="min-w-0 flex-1 break-words">{item.text}</span>
                {/api key|api_key|OPENAI_API_KEY|ANTHROPIC_API_KEY|not configured|API 密钥/i.test(item.text) && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-current px-2 py-0.5 text-[11.5px] font-medium hover:opacity-80"
                    onClick={() => navigate("settings")}
                  >
                    前往设置
                  </button>
                )}
                {item.retriable && !running && block.i === retryAnchor(items) && (
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-current px-2 py-0.5 text-[11.5px] font-medium hover:opacity-80"
                    data-testid="notice-retry"
                    onClick={onRetry}
                  >
                    重试
                  </button>
                )}
              </div>
            );
          default:
            return null;
        }
      })}

      {/* Live thinking (reasoning models): streams for anyone who expands it; folds into
          the answer's disclosure when the message finalizes. */}
      {running && reasoning && !streaming && <ThinkingBlock text={reasoning} live />}

      {/* Compaction runs between provider turns (nothing streams during it). */}
      {running && compacting && <WaitingRow label="正在压缩上下文…" agent={agent} />}
      {showWaiting && <WaitingRow agent={agent} />}

      {/* The promoted streaming answer. */}
      {!!streaming && mode === "answer" && (
        <div className="flex items-start gap-2.5">
          <AssistantAvatar agent={agent} live />
          <div className="min-w-0 flex-1">
            <div
              className={`mb-1 text-[11px] tracking-[0.06em] text-faint ${
                agent.kind === "q" ? "uppercase" : ""
              }`}
            >
              {agentLabel(agent)}
            </div>
            <Markdown text={streaming} />
            <span className="stream-cursor" />
          </div>
        </div>
      )}
    </div>
  );
}

function WaitingRow({ label, agent }: { label?: string; agent: TimelineAgent }) {
  return (
    <div className="flex items-center gap-2.5" aria-live="polite" data-testid="waiting-row">
      <AssistantAvatar agent={agent} live />
      <span className="flex items-center gap-2 text-[12.5px] text-faint">
        <span className="breathing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>{label || "正在等待助手…"}</span>
      </span>
    </div>
  );
}
