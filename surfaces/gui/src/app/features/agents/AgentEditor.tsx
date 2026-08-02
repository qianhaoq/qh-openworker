// The agent profile editor: a right-side sheet over the list. The flow follows the
// backend contract — 保存(始终存为禁用)→ 探测(spawn runtime, negotiate capabilities)
// → 启用 — plus 设为主 agent and an inline-confirm delete.

import { useMemo, useState, type ReactNode } from "react";
import type { AgentProfile, AgentRole, Transport } from "../../lib/api/types";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";
import {
  PERMISSION_POLICIES,
  PROBE_VIEW_LABEL,
  ROLE_ORDER,
  TRANSPORT_LABEL,
  WORKSPACE_POLICIES,
  agentInfoLine,
  applyRoleToDraft,
  canEnable,
  canSetMain,
  capabilityBadges,
  formatSecretRefs,
  isReadOnlyRole,
  parseArgsJson,
  parseSecretRefs,
  probeView,
  roleMeta,
  validateProfile,
} from "./agentLogic";
import type { ActionResult } from "./useAgentProfiles";

const GRP =
  "overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]";
const GRP_H = "mb-1.5 mt-5 px-1 text-[12px] font-semibold text-muted";
const FIELD =
  "w-full rounded-md border border-line bg-paper px-2 py-1 text-[12.5px] text-ink outline-none focus:border-lineStrong disabled:opacity-50";
const BTN =
  "rounded-lg border border-line bg-paper px-3 py-1.5 text-[12.5px] text-ink hover:border-lineStrong disabled:opacity-40";
const BTN_ACCENT = "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40";
const BTN_DANGER = "rounded-lg border border-danger/30 bg-paper px-3 py-1.5 text-[12.5px] text-danger disabled:opacity-40";

export interface AgentEditorProps {
  /** The draft to start from (preset/blank for new, the stored profile for edits). */
  initial: AgentProfile;
  /** null = unsaved new profile; otherwise the id this draft edits. */
  originalId: string | null;
  /** The live list entry for originalId (post-save/probe state), when present. */
  current: AgentProfile | null;
  existingIds: ReadonlySet<string>;
  mainProfileId: string | null;
  probing: boolean;
  probeError?: string;
  busy: boolean;
  onSave: (profile: AgentProfile) => Promise<ActionResult>;
  onProbe: (profileId: string) => Promise<ActionResult>;
  onSetEnabled: (profile: AgentProfile, enabled: boolean) => Promise<ActionResult>;
  onSetMain: (profileId: string) => Promise<ActionResult>;
  onDelete: (profileId: string) => Promise<ActionResult>;
  onSaved: (profileId: string) => void;
  onClose: () => void;
}

function Field({
  label,
  hint,
  stack,
  children,
}: {
  label: string;
  hint?: string;
  stack?: boolean;
  children: ReactNode;
}) {
  if (stack) {
    return (
      <div className="px-4 py-2.5">
        <div className="text-[13px]">{label}</div>
        <div className="mt-1.5">{children}</div>
        {hint && <div className="mt-1 text-[11px] text-faint">{hint}</div>}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="shrink-0 text-[13px]">{label}</span>
      <span className="w-[230px]">
        {children}
        {hint && <span className="mt-1 block text-[11px] leading-snug text-faint">{hint}</span>}
      </span>
    </div>
  );
}

export function AgentEditor({
  initial,
  originalId,
  current,
  existingIds,
  mainProfileId,
  probing,
  probeError,
  busy,
  onSave,
  onProbe,
  onSetEnabled,
  onSetMain,
  onDelete,
  onSaved,
  onClose,
}: AgentEditorProps) {
  const [draft, setDraft] = useState<AgentProfile>(initial);
  const [argsText, setArgsText] = useState(() => JSON.stringify(initial.args ?? []));
  const [secretText, setSecretText] = useState(() => formatSecretRefs(initial.secret_refs ?? []));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const isNew = originalId === null;
  const saved = current; // the server's version, once persisted
  const view = useMemo(
    () => (saved ? probeView(saved, probing, probeError) : probing ? "probing" : "unprobed"),
    [saved, probing, probeError],
  );
  const argsError = useMemo(() => {
    const parsed = parseArgsJson(argsText);
    return parsed.ok ? null : parsed.error;
  }, [argsText]);
  const badges = saved ? capabilityBadges(saved.capabilities ?? {}) : [];
  const infoLine = saved ? agentInfoLine(saved.capabilities ?? {}) : null;

  const flash = (result: ActionResult, okText: string): boolean => {
    if (result.ok) {
      setError(null);
      setNotice(okText);
    } else {
      setNotice(null);
      setError(result.error || "操作失败");
    }
    return result.ok;
  };

  const save = async () => {
    const args = parseArgsJson(argsText);
    if (!args.ok) {
      setError(args.error);
      return;
    }
    const next: AgentProfile = {
      ...draft,
      id: draft.id.trim(),
      command: draft.command.trim(),
      args: args.args,
      model_profile: draft.model_profile?.trim() || null,
      secret_refs: parseSecretRefs(secretText),
      // Backend semantics: every save persists disabled; identity changes also clear the
      // stored probe server-side. 启用 happens explicitly after a fresh probe.
      enabled: false,
      capabilities: saved?.capabilities ?? {},
      capability_probe_fingerprint: saved?.capability_probe_fingerprint ?? null,
    };
    const invalid = validateProfile(next, existingIds, originalId);
    if (invalid) {
      setError(invalid);
      return;
    }
    const result = await onSave(next);
    if (flash(result, isNew ? "已保存（禁用）。下一步：探测。" : "已保存。身份字段变化后需重新探测再启用。")) {
      if (isNew) onSaved(next.id);
    }
  };

  const probe = async () => {
    if (!saved) return;
    const result = await onProbe(saved.id);
    flash(result, result.ok ? "探测成功，能力已记录。" : "");
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (!saved) return;
    const result = await onSetEnabled(saved, enabled);
    flash(result, enabled ? "已启用。" : "已停用。");
  };

  const setMain = async () => {
    if (!saved) return;
    const result = await onSetMain(saved.id);
    flash(result, "已设为当前 workspace 的主 Agent。");
  };

  const remove = async () => {
    if (!saved) return;
    const result = await onDelete(saved.id);
    if (result.ok) onClose();
    else flash(result, "");
  };

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} aria-hidden="true" />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-[440px] max-w-full flex-col border-l border-line bg-paper shadow-2xl"
        role="dialog"
        aria-label={isNew ? "招募 Agent" : `编辑 ${originalId}`}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-line bg-panel px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className={`grid h-7 w-7 place-items-center rounded-lg text-[12px] font-semibold ${roleMeta(draft.role).tint}`}>
              {roleMeta(draft.role).label}
            </span>
            <div className="text-[13.5px] font-semibold tracking-tight">
              {isNew ? "招募 Agent" : draft.id}
            </div>
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

        {/* body */}
        <div className="hairline-scroll flex-1 overflow-y-auto px-4 pb-4">
          <div className={GRP_H}>基本信息</div>
          <div className={`${GRP} divide-y divide-line`}>
            <Field label="Profile ID">
              <input
                className={`${FIELD} font-mono`}
                value={draft.id}
                disabled={!isNew}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder="kimi-main"
              />
            </Field>
            <Field label="角色">
              <select
                className={FIELD}
                value={draft.role}
                onChange={(e) => setDraft(applyRoleToDraft(draft, e.target.value as AgentRole))}
              >
                {ROLE_ORDER.map((role) => (
                  <option key={role} value={role}>
                    {roleMeta(role).label} · {roleMeta(role).description}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Transport">
              <select
                className={FIELD}
                value={draft.transport}
                onChange={(e) => setDraft({ ...draft, transport: e.target.value as Transport })}
              >
                {(Object.keys(TRANSPORT_LABEL) as Transport[]).map((transport) => (
                  <option key={transport} value={transport}>
                    {TRANSPORT_LABEL[transport]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Command">
              <input
                className={`${FIELD} font-mono`}
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                placeholder="kimi"
              />
            </Field>
            <Field
              stack
              label="Args"
              hint="JSON 字符串数组，例如 [&quot;acp&quot;] 或 [&quot;--mode&quot;, &quot;rpc&quot;]"
            >
              <textarea
                className={`${FIELD} min-h-[56px] font-mono`}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                spellCheck={false}
              />
              {argsError && <div className="mt-1 text-[11px] text-danger">{argsError}</div>}
            </Field>
            <Field label="Model profile">
              <input
                className={`${FIELD} font-mono`}
                value={draft.model_profile ?? ""}
                onChange={(e) => setDraft({ ...draft, model_profile: e.target.value })}
                placeholder="可选"
              />
            </Field>
          </div>

          <div className={GRP_H}>权限与密钥</div>
          <p className="mb-1 px-1 text-[11px] leading-snug text-faint">
            这些是宿主强制的 ACP 权限策略；Agent 二进制是受信本地代码，不等同 OS sandbox。
          </p>
          <div className={`${GRP} divide-y divide-line`}>
            <Field label="Workspace">
              <select
                className={FIELD}
                value={draft.workspace_policy}
                disabled={isReadOnlyRole(draft.role)}
                onChange={(e) => setDraft({ ...draft, workspace_policy: e.target.value })}
              >
                {WORKSPACE_POLICIES.map((policy) => (
                  <option key={policy.value} value={policy.value}>
                    {policy.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="权限策略">
              <select
                className={FIELD}
                value={draft.permission_policy}
                disabled={isReadOnlyRole(draft.role)}
                onChange={(e) => setDraft({ ...draft, permission_policy: e.target.value })}
              >
                {PERMISSION_POLICIES.map((policy) => (
                  <option key={policy.value} value={policy.value}>
                    {policy.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Secret 引用"
              hint={draft.role === "reviewer" ? "审查角色不能引用 secret" : "本地密钥名，逗号分隔；只存引用，不存值"}
            >
              <input
                className={`${FIELD} font-mono`}
                value={secretText}
                disabled={draft.role === "reviewer"}
                onChange={(e) => setSecretText(e.target.value)}
                placeholder="KIMI_API_KEY"
              />
            </Field>
          </div>

          {/* status / lifecycle */}
          <div className={GRP_H}>状态</div>
          <div className={`${GRP} divide-y divide-line`}>
            <div className="flex items-center gap-2.5 px-4 py-2.5">
              <span className="text-[13px]">探测</span>
              <span className="ml-auto flex items-center gap-1.5 text-[12px]">
                {view === "probing" && <span className="spinner" />}
                <span
                  className={
                    view === "probed"
                      ? "text-ok"
                      : view === "failed"
                        ? "text-danger"
                        : view === "probing"
                          ? "text-accent"
                          : "text-faint"
                  }
                >
                  {PROBE_VIEW_LABEL[view]}
                </span>
              </span>
            </div>
            {(badges.length > 0 || infoLine) && (
              <div className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  {badges.map((badge) => (
                    <span key={badge} className="rounded bg-solid px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-onSolid">
                      {badge}
                    </span>
                  ))}
                </div>
                {infoLine && <div className="mt-1.5 text-[11px] text-faint">{infoLine}</div>}
              </div>
            )}
            {view === "failed" && probeError && (
              <div className="px-4 py-2.5">
                <pre className="whitespace-pre-wrap break-all rounded-lg bg-dangerSoft px-2.5 py-2 font-mono text-[11px] leading-relaxed text-danger">
                  {probeError}
                </pre>
              </div>
            )}
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="text-[13px]">启用</span>
              <Switch
                checked={saved?.enabled ?? false}
                disabled={busy || !saved || (!saved.enabled && !canEnable(saved, view))}
                title={
                  !saved
                    ? "先保存再探测"
                    : !saved.enabled && !canEnable(saved, view)
                      ? "探测通过后才能启用"
                      : undefined
                }
                onChange={(enabled) => void toggleEnabled(enabled)}
              />
            </div>
            <div className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="text-[13px]">主 Agent</span>
              {saved && mainProfileId === saved.id ? (
                <span className="rounded bg-accentSoft px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">
                  当前主 Agent
                </span>
              ) : (
                <button
                  type="button"
                  className={BTN}
                  disabled={busy || !saved || !canSetMain(saved)}
                  title={!saved || !canSetMain(saved) ? "需要已启用的主角色 profile" : undefined}
                  onClick={() => void setMain()}
                >
                  设为主 Agent
                </button>
              )}
            </div>
          </div>

          {error && (
            <p className="mt-3 text-[12px] text-danger" role="alert">
              {error}
            </p>
          )}
          {notice && <p className="mt-3 text-[12px] text-ok">{notice}</p>}
        </div>

        {/* footer */}
        <div className="border-t border-line bg-panel px-4 py-3">
          <div className="mb-2 text-[11px] leading-relaxed text-faint">
            保存后 profile 处于禁用状态；探测通过后才能启用。
          </div>
          <div className="flex items-center gap-2">
            {!isNew &&
              (confirmingDelete ? (
                <span className="flex items-center gap-1.5">
                  <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => void remove()}>
                    确认删除
                  </button>
                  <button type="button" className={BTN} onClick={() => setConfirmingDelete(false)}>
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={BTN_DANGER}
                  disabled={busy}
                  onClick={() => setConfirmingDelete(true)}
                >
                  删除
                </button>
              ))}
            <span className="flex-1" />
            <button
              type="button"
              className={BTN}
              disabled={busy || !saved || probing}
              title={!saved ? "先保存再探测" : undefined}
              onClick={() => void probe()}
            >
              {probing ? (
                <span className="flex items-center gap-1.5">
                  <span className="spinner" /> 探测中
                </span>
              ) : (
                "探测"
              )}
            </button>
            <button type="button" className={BTN_ACCENT} disabled={busy || !!argsError} onClick={() => void save()}>
              保存
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
