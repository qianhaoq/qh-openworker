// 团队面板 — 任务详情页右侧:每个计划席位一张卡片(状态、用时、返修轮次),带操作:
// 发消息(指向该席位的 attempt)、查看产物(list → 读预览 drawer)、查看审查(findings)。
// 产物/审查 drawer 也在这里,与卡片共用一套数据派生(missionLogic)。

import { useState, type FormEvent } from "react";
import { Drawer } from "../../components/Drawer";
import { Icon } from "../../components/Icon";
import { Markdown } from "../../components/Markdown";
import type { MessageTarget, Mission, PlanMember, TeamArtifact } from "../../lib/api/types";
import { roleMeta } from "../agents/agentLogic";
import {
  artifactIcon,
  artifactName,
  artifactPreviewText,
  artifactsForAttempt,
  attemptsForMember,
  findingLocation,
  formatDuration,
  formatTime,
  memberStatusMeta,
  reviewVerdictMeta,
  severityMeta,
} from "./missionLogic";

const TAG = "rounded px-1.5 py-0.5 text-[10.5px] font-semibold";

function MemberCard({
  mission,
  member,
  mutating,
  onSend,
  onOpenArtifacts,
  onOpenReviews,
}: {
  mission: Mission;
  member: PlanMember;
  mutating: boolean;
  onSend: (text: string, target: MessageTarget) => Promise<boolean>;
  onOpenArtifacts: (attemptId: string | null) => void;
  onOpenReviews: () => void;
}) {
  const meta = roleMeta(member.role);
  const status = memberStatusMeta(member.status);
  const attempts = attemptsForMember(mission, member);
  const latest = attempts[attempts.length - 1] ?? null;
  const artifactCount = member.attempt_id
    ? artifactsForAttempt(mission, member.attempt_id).length
    : mission.artifacts.filter((artifact) => !artifact.attempt_id).length;
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !member.attempt_id) return;
    const ok = await onSend(trimmed, { kind: "attempt", attempt_id: member.attempt_id });
    if (ok) {
      setText("");
      setComposing(false);
    }
  };

  return (
    <article className="rounded-xl bg-panel px-3.5 py-3 shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]">
      <header className="flex items-center gap-2">
        <span className={`grid h-7 w-10 shrink-0 place-items-center rounded-md text-[11px] font-semibold ${meta.tint}`}>
          {meta.label}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11.5px]">{member.profile_id || "未分配"}</span>
        </span>
        <span className={`${TAG} ${status.tint}`}>{status.label}</span>
      </header>

      {member.objective && (
        <p className="mt-2 text-[12px] leading-snug text-muted">{member.objective}</p>
      )}

      {latest && (
        <div className="mt-2 space-y-0.5 text-[11px] text-faint">
          <div>
            用时 {formatDuration(latest.created_at, latest.updated_at) || "—"}
            {latest.rework_round ? ` · 第 ${latest.rework_round} 轮返修` : ""}
            {attempts.length > 1 ? ` · 共 ${attempts.length} 次尝试` : ""}
          </div>
          {latest.worktree && (
            <div className="truncate font-mono" title={latest.worktree}>
              {latest.worktree}
            </div>
          )}
        </div>
      )}

      {member.attempt_id && (
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-line pt-2.5">
          <button
            type="button"
            onClick={() => setComposing((value) => !value)}
            className="flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] text-muted hover:border-lineStrong hover:text-ink"
          >
            <Icon name="send" size={12} />
            发消息
          </button>
          <button
            type="button"
            onClick={() => onOpenArtifacts(member.attempt_id ?? null)}
            className="flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] text-muted hover:border-lineStrong hover:text-ink"
          >
            <Icon name="file" size={12} />
            产物{artifactCount ? ` (${artifactCount})` : ""}
          </button>
          <button
            type="button"
            onClick={onOpenReviews}
            className="flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] text-muted hover:border-lineStrong hover:text-ink"
          >
            <Icon name="shield" size={12} />
            审查{mission.reviews.length ? ` (${mission.reviews.length})` : ""}
          </button>
        </div>
      )}

      {composing && member.attempt_id && (
        <form onSubmit={(event) => void send(event)} className="mt-2">
          <label className="sr-only" htmlFor={`member-message-${member.id}`}>
            发给 {meta.label} 的消息
          </label>
          <textarea
            id={`member-message-${member.id}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={2}
            autoFocus
            placeholder={`发给${meta.label}(${member.profile_id}),例如:请修复审查提出的问题`}
            className="w-full resize-none rounded-lg border border-line bg-paper px-2.5 py-1.5 text-[12px] leading-relaxed outline-none placeholder:text-faint focus:border-lineStrong"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setComposing(false)}
              className="rounded-md border border-line bg-panel px-2.5 py-1 text-[11.5px] hover:border-lineStrong"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!text.trim() || mutating}
              className="rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white hover:brightness-105 disabled:opacity-40"
            >
              发送
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

export function TeamPanel({
  mission,
  mutating,
  onSend,
  onOpenArtifacts,
  onOpenReviews,
}: {
  mission: Mission;
  mutating: boolean;
  onSend: (text: string, target: MessageTarget) => Promise<boolean>;
  onOpenArtifacts: (attemptId: string | null) => void;
  onOpenReviews: () => void;
}) {
  return (
    <section>
      <h2 className="mb-2 px-1 text-[12px] font-semibold text-muted">团队({mission.members.length})</h2>
      {mission.members.length === 0 ? (
        <p className="rounded-xl bg-panel px-3.5 py-4 text-[12.5px] text-faint shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]">
          计划确认后,团队席位会出现在这里。
        </p>
      ) : (
        <div className="space-y-2">
          {mission.members.map((member) => (
            <MemberCard
              key={member.id || `${member.role}-${member.profile_id}`}
              mission={mission}
              member={member}
              mutating={mutating}
              onSend={onSend}
              onOpenArtifacts={onOpenArtifacts}
              onOpenReviews={onOpenReviews}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 产物 drawer(list → 读预览,与 assistant 右栏同一种交互)
// ---------------------------------------------------------------------------

function ArtifactPreview({ artifact, onBack }: { artifact: TeamArtifact; onBack: () => void }) {
  const preview = artifactPreviewText(artifact);
  const metadata = artifact.metadata ?? {};
  const isMarkdown = artifact.kind === "markdown" || artifact.kind === "report";
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-panel px-3 py-2">
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
          onClick={onBack}
          aria-label="返回产物列表"
          title="返回"
        >
          <Icon name="arrowLeft" size={15} />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{artifactName(artifact)}</span>
          <span className="block truncate font-mono text-[10.5px] text-faint">{artifact.uri}</span>
        </span>
        <button
          type="button"
          className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-paper hover:text-ink"
          onClick={() => navigator.clipboard?.writeText(String(artifact.uri ?? ""))}
          aria-label="复制地址"
          title="复制地址"
        >
          <Icon name="copy" size={14} />
        </button>
      </div>
      <div className="hairline-scroll min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mb-2 text-[11px] text-faint">
          {artifact.kind || "file"} · {formatTime(artifact.created_at)}
        </div>
        {preview ? (
          isMarkdown ? (
            <Markdown text={preview} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted">
              {preview}
            </pre>
          )
        ) : Object.keys(metadata).length > 0 ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-muted">
            {JSON.stringify(metadata, null, 2)}
          </pre>
        ) : (
          <div className="py-8 text-center text-[12.5px] text-faint">该工件没有可预览的内容。</div>
        )}
      </div>
    </div>
  );
}

export function ArtifactsDrawer({
  mission,
  attemptId,
  onClose,
}: {
  mission: Mission;
  attemptId: string | null;
  onClose: () => void;
}) {
  const artifacts = artifactsForAttempt(mission, attemptId);
  const [selected, setSelected] = useState<TeamArtifact | null>(null);
  return (
    <Drawer
      title={selected ? artifactName(selected) : `产物(${artifacts.length})`}
      initialFocus={selected ? "[aria-label='返回产物列表']" : "[data-artifact-open]"}
      onClose={onClose}
      icon={<Icon name="file" size={15} className="text-muted" />}
    >
      {selected ? (
        <ArtifactPreview artifact={selected} onBack={() => setSelected(null)} />
      ) : (
        <div className="px-3 py-3">
          {artifacts.length === 0 ? (
            <div className="py-8 text-center text-[12.5px] text-faint">
              暂无工件。diff、测试日志和报告会出现在这里。
            </div>
          ) : (
            <div className="space-y-0.5">
              {artifacts.map((artifact) => (
                <button
                  key={artifact.id}
                  type="button"
                  data-artifact-open
                  onClick={() => setSelected(artifact)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-panel"
                >
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-panel text-muted"
                    title={artifact.kind}
                  >
                    <Icon name={artifactIcon(artifact.kind)} size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{artifactName(artifact)}</span>
                    <span className="block text-[11px] text-faint">
                      {artifact.kind || "file"} · {formatTime(artifact.created_at)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-faint">打开</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// 审查 drawer(verdict + findings)
// ---------------------------------------------------------------------------

export function ReviewsDrawer({ mission, onClose }: { mission: Mission; onClose: () => void }) {
  return (
    <Drawer
      title={`审查(${mission.reviews.length})`}
      onClose={onClose}
      icon={<Icon name="shield" size={15} className="text-muted" />}
    >
        <div className="px-3 py-3">
          {mission.reviews.length === 0 ? (
            <div className="py-8 text-center text-[12.5px] text-faint">
              等待 Reviewer。审查只读查看固定的 diff / 测试工件。
            </div>
          ) : (
            <div className="space-y-2.5">
              {mission.reviews.map((review, index) => {
                const verdict = reviewVerdictMeta(review.verdict);
                return (
                  <article
                    key={review.id || index}
                    className="rounded-lg border border-line bg-panel px-3 py-2.5"
                  >
                    <header className="flex items-center gap-2">
                      <span className={`${TAG} ${verdict.tint}`}>{verdict.label}</span>
                      <span className="text-[11px] text-faint">
                        置信度 {review.confidence ?? "n/a"}
                        {review.created_at ? ` · ${formatTime(review.created_at)}` : ""}
                      </span>
                    </header>
                    {(review.findings ?? []).length > 0 && (
                      <ul className="mt-2 space-y-1.5">
                        {(review.findings ?? []).map((finding, findingIndex) => {
                          const severity = severityMeta(finding.severity);
                          const location = findingLocation(finding);
                          return (
                            <li key={finding.id || findingIndex} className="text-[12px] leading-snug">
                              <span className={`${TAG} ${severity.tint}`}>{severity.label}</span>{" "}
                              <span className="font-medium">{finding.title || location || "未命名问题"}</span>
                              {location && finding.title && (
                                <span className="ml-1 font-mono text-[10.5px] text-faint">{location}</span>
                              )}
                              {finding.evidence && (
                                <span className="mt-0.5 block text-muted">{finding.evidence}</span>
                              )}
                              {finding.suggested_fix && (
                                <span className="mt-0.5 block text-faint">建议:{finding.suggested_fix}</span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {(review.test_gaps ?? []).length > 0 && (
                      <div className="mt-2 border-t border-line pt-2">
                        <div className="text-[11px] font-semibold text-muted">测试缺口</div>
                        <ul className="mt-1 space-y-0.5">
                          {(review.test_gaps ?? []).map((gap, gapIndex) => (
                            <li key={gapIndex} className="text-[11.5px] text-muted">
                              · {gap}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
    </Drawer>
  );
}
