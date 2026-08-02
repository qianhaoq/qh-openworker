// The four inline prompt cards, rendered in the timeline where they were raised and
// answered over the session socket. Each reflects its resolved state after the user acts
// (optimistic local resolve; the server parks the same item in the Inbox as the durable
// copy, so an answer from any surface wins).

import { useState } from "react";
import type { ApprovalDecision } from "../../lib/api/types";
import { chooseFolder } from "../../../tauri";
import { Icon } from "../../components/Icon";
import { Markdown } from "../../components/Markdown";
import { humanizeApprovalTitle, scopeNote, shortArgs, type HumanLine } from "./humanize";
import type { ApprovalItem, DirReqItem, PlanReqItem, QuestionItem } from "./timeline";

function TitleText({ line }: { line: HumanLine }) {
  return (
    <span className="text-[13.5px] font-medium">
      {line.pre}
      {line.obj && <b className="font-semibold">{line.obj}</b>}
      {line.post}
    </span>
  );
}

// The proposed content/command, clamped by lines AND characters with a 展开 toggle.
const PREVIEW_LINES = 5;
const PREVIEW_CHARS = 420;

export function PreviewBlock({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const clipped = lines.length > PREVIEW_LINES || text.length > PREVIEW_CHARS;
  let shown = text;
  if (!all && clipped) {
    shown = lines.slice(0, PREVIEW_LINES).join("\n");
    if (shown.length > PREVIEW_CHARS) shown = shown.slice(0, PREVIEW_CHARS).trimEnd() + "…";
  }
  return (
    <div className="rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-muted whitespace-pre-wrap break-words">
      {shown}
      {clipped && (
        <button
          type="button"
          className="ml-1.5 text-accent hover:underline"
          onClick={() => setAll((v) => !v)}
        >
          {all ? "收起" : lines.length > PREVIEW_LINES ? `展开全部 ${lines.length} 行` : "展开全文"}
        </button>
      )}
    </div>
  );
}

const cardShell =
  "rounded-xl2 border border-line bg-panel px-3.5 py-3 shadow-sm shadow-black/[0.02]";

// ---------------------------------------------------------------------------
// 权限审批 (permission_required)
// ---------------------------------------------------------------------------

const DECISION_LABEL: Record<string, string> = {
  once: "允许一次",
  always_tool: "始终允许",
  always_command: "始终允许此命令",
  deny: "拒绝",
};

export function ApprovalCard({
  item,
  onApprove,
}: {
  item: ApprovalItem;
  onApprove: (decision: ApprovalDecision) => void;
}) {
  const title = humanizeApprovalTitle(item.name, item.args);
  const scope = scopeNote(item.name, item.args, item.category);
  // "requires approval" is the engine's default boilerplate — only surface a real reason.
  const reason = item.reason && item.reason !== "requires approval" ? item.reason : "";
  const content = typeof item.args?.content === "string" ? item.args.content : "";

  return (
    <div
      className={`${cardShell} ${scope.external ? "border-warnInk/30" : ""} ${
        item.resolved ? "" : "prompt-card-pending"
      }`}
      data-testid="approval-card"
    >
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accentSoft text-accent">
          <Icon name="shield" size={14} />
        </span>
        <TitleText line={title} />
        <span
          className={`ml-auto shrink-0 text-[11px] ${scope.external ? "text-warnInk" : "text-faint"}`}
        >
          {scope.text}
        </span>
      </div>

      <div className="mt-2 space-y-2">
        {item.name === "run_shell" && !!item.args?.command && (
          <PreviewBlock text={String(item.args.command)} />
        )}
        {item.name !== "run_shell" && content && <PreviewBlock text={content} />}
        {!!item.args?.text && (item.name === "send_message") && (
          <PreviewBlock text={String(item.args.text)} />
        )}
        {!content && !item.args?.command && !item.args?.text && shortArgs(item.args) && (
          <div className="font-mono text-[11.5px] text-faint break-all">{shortArgs(item.args)}</div>
        )}
        {reason && <div className="text-[12px] text-muted">原因：{reason}</div>}
      </div>

      {item.resolved ? (
        <div
          className={`mt-2.5 flex items-center gap-1.5 text-[12px] ${
            item.resolved === "deny" ? "text-danger" : "text-ok"
          }`}
          data-testid="approval-resolved"
        >
          <Icon name={item.resolved === "deny" ? "close" : "brand"} size={12} />
          {item.resolved === "deny" ? "已拒绝" : `已批准 · ${DECISION_LABEL[item.resolved] ?? item.resolved}`}
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105"
            onClick={() => onApprove("once")}
          >
            允许一次
          </button>
          {item.name === "run_shell" ? (
            <button
              type="button"
              className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] text-ink hover:border-lineStrong"
              onClick={() => onApprove("always_command")}
            >
              始终允许此命令
            </button>
          ) : item.category !== "connector" ? (
            <button
              type="button"
              className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] text-ink hover:border-lineStrong"
              onClick={() => onApprove("always_tool")}
            >
              始终允许
            </button>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-[12.5px] text-danger hover:bg-dangerSoft"
            onClick={() => onApprove("deny")}
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 提问 (question_requested / ask_user)
// ---------------------------------------------------------------------------

export function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const multi = !!item.multi;

  const togglePick = (option: string) => {
    if (!multi) {
      onAnswer(option);
      return;
    }
    setPicked((cur) =>
      cur.includes(option) ? cur.filter((o) => o !== option) : [...cur, option],
    );
  };

  return (
    <div
      className={`${cardShell} ${item.resolved !== undefined ? "" : "prompt-card-pending"}`}
      data-testid="question-card"
    >
      <div className="flex items-start gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accentSoft text-accent">
          <Icon name="help" size={14} />
        </span>
        <div className="min-w-0 flex-1 text-[13.5px] leading-relaxed">{item.question}</div>
      </div>

      {item.resolved !== undefined ? (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-ok" data-testid="question-resolved">
          <Icon name="brand" size={12} />
          已回答：{item.resolved}
        </div>
      ) : (
        <div className="mt-2.5 space-y-2">
          {!!item.options?.length && (
            <div className="flex flex-wrap gap-1.5">
              {item.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => togglePick(option)}
                  className={`rounded-lg border px-2.5 py-1 text-[12.5px] ${
                    multi && picked.includes(option)
                      ? "border-accent bg-accentSoft text-accent"
                      : "border-line bg-panel text-ink hover:border-lineStrong"
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {multi && !!item.options?.length && (
            <button
              type="button"
              disabled={!picked.length}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
              onClick={() => onAnswer(picked.join(", "))}
            >
              提交选择
            </button>
          )}
          {item.allow_text !== false && (
            <div className="flex gap-1.5">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && text.trim()) onAnswer(text.trim());
                }}
                placeholder="输入回答…"
                className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12.5px] placeholder:text-faint focus:border-lineStrong"
              />
              <button
                type="button"
                disabled={!text.trim()}
                className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
                onClick={() => onAnswer(text.trim())}
              >
                回答
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 计划 (plan_proposed)
// ---------------------------------------------------------------------------

export function PlanCard({
  item,
  onRespond,
}: {
  item: PlanReqItem;
  onRespond: (approved: boolean, mode?: string, feedback?: string) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <div className={`${cardShell} ${item.resolved ? "" : "prompt-card-pending"}`} data-testid="plan-card">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accentSoft text-accent">
          <Icon name="sparkle" size={14} />
        </span>
        <span className="text-[13.5px] font-medium">助手提出了一份计划</span>
      </div>
      <div className="mt-2 rounded-lg border border-line bg-paper px-3 py-2 text-[13px]">
        <Markdown text={item.plan} />
      </div>

      {item.resolved ? (
        <div
          className={`mt-2.5 flex items-center gap-1.5 text-[12px] ${
            item.resolved === "approved" ? "text-ok" : "text-warnInk"
          }`}
          data-testid="plan-resolved"
        >
          <Icon name={item.resolved === "approved" ? "brand" : "close"} size={12} />
          {item.resolved === "approved" ? "计划已通过" : "已退回并附上修改意见"}
        </div>
      ) : rejecting ? (
        <div className="mt-2.5 flex items-center gap-1.5">
          <input
            value={feedback}
            autoFocus
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && feedback.trim()) onRespond(false, undefined, feedback.trim());
            }}
            placeholder="计划需要改什么？"
            className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12.5px] placeholder:text-faint focus:border-lineStrong"
          />
          <button
            type="button"
            className="shrink-0 rounded-lg px-3 py-1.5 text-[12.5px] text-muted hover:bg-paper"
            onClick={() => setRejecting(false)}
          >
            返回
          </button>
          <button
            type="button"
            disabled={!feedback.trim()}
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
            onClick={() => onRespond(false, undefined, feedback.trim())}
          >
            发送反馈
          </button>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105"
            onClick={() => onRespond(true, "auto")}
          >
            批准并执行
          </button>
          <button
            type="button"
            className="rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] text-ink hover:border-lineStrong"
            onClick={() => onRespond(true, "interactive")}
          >
            批准 · 逐步确认
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-[12.5px] text-muted hover:bg-paper"
            onClick={() => setRejecting(true)}
          >
            退回修改
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 文件夹授权 (directory_requested)
// ---------------------------------------------------------------------------

export function DirectoryCard({
  item,
  onRespond,
}: {
  item: DirReqItem;
  onRespond: (granted: boolean, path?: string, writable?: boolean) => void;
}) {
  const [path, setPath] = useState(item.path || "");
  const [writable, setWritable] = useState(!!item.writable);

  const browse = async () => {
    const picked = await chooseFolder();
    if (picked) setPath(picked);
  };

  return (
    <div className={`${cardShell} ${item.resolved ? "" : "prompt-card-pending"}`} data-testid="directory-card">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accentSoft text-accent">
          <Icon name="folderPlus" size={14} />
        </span>
        <span className="text-[13.5px] font-medium">助手请求访问一个文件夹</span>
      </div>
      {item.reason && <div className="mt-1.5 text-[12.5px] text-muted">“{item.reason}”</div>}

      {item.resolved ? (
        <div
          className={`mt-2.5 flex items-center gap-1.5 text-[12px] ${
            item.resolved === "granted" ? "text-ok" : "text-danger"
          }`}
          data-testid="directory-resolved"
        >
          <Icon name={item.resolved === "granted" ? "brand" : "close"} size={12} />
          {item.resolved === "granted" ? "已授予文件夹访问权限" : "已拒绝文件夹访问"}
        </div>
      ) : (
        <>
          <div className="mt-2.5 flex gap-1.5">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="选择或粘贴文件夹路径…"
              className="min-w-0 flex-1 rounded-lg border border-line bg-paper px-2.5 py-1.5 font-mono text-[12px] placeholder:font-sans placeholder:text-faint focus:border-lineStrong"
            />
            <button
              type="button"
              onClick={() => void browse()}
              title="选择文件夹"
              aria-label="选择文件夹"
              className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg border border-line bg-panel text-muted hover:border-lineStrong hover:text-ink"
            >
              <Icon name="folder" size={15} />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-muted">
              <input
                type="checkbox"
                checked={writable}
                onChange={(e) => setWritable(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              允许写入（读写）
            </label>
            <span className="flex-1" />
            <button
              type="button"
              className="rounded-lg px-3 py-1.5 text-[12.5px] text-danger hover:bg-dangerSoft"
              onClick={() => onRespond(false)}
            >
              拒绝
            </button>
            <button
              type="button"
              disabled={!path.trim()}
              className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
              onClick={() => onRespond(true, path.trim(), writable)}
            >
              授予访问
            </button>
          </div>
        </>
      )}
    </div>
  );
}
