// Agents page — ACP 本地 agent 的招募与管理. macOS System-Settings grammar: grouped
// inset lists on gray paper. Lifecycle is explicit per the backend contract:
// 保存(禁用)→ 探测(协商能力)→ 启用 → 可设为主 agent.

import { useEffect, useMemo, useState } from "react";
import { detectAgentCommands } from "../../lib/api/agents";
import type { AgentProfile } from "../../lib/api/types";
import { Drawer } from "../../components/Drawer";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";
import { AgentEditor } from "./AgentEditor";
import {
  AGENT_PRESETS,
  PROBE_VIEW_LABEL,
  blankProfile,
  canEnable,
  capabilityBadges,
  commandSummary,
  presetCommandName,
  probeView,
  profileFromPreset,
  roleMeta,
  transportLabel,
  type AgentPreset,
} from "./agentLogic";
import { useAgentProfiles } from "./useAgentProfiles";

const GRP =
  "overflow-hidden rounded-xl bg-panel shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]";
const GRP_H = "mb-1.5 mt-6 px-1 text-[12px] font-semibold text-muted";

type DrawerState =
  | { kind: "presets" }
  | { kind: "new"; draft: AgentProfile }
  | { kind: "edit"; profileId: string };

const TAG = "rounded px-1.5 py-0.5 text-[10.5px] font-semibold";

function ProbeState({ profile, probing, error }: { profile: AgentProfile; probing: boolean; error?: string }) {
  const view = probeView(profile, probing, error);
  return (
    <span className="flex items-center gap-1.5 text-[11.5px]">
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
  );
}

function AgentRow({
  profile,
  isMain,
  probing,
  probeError,
  busy,
  onOpen,
  onToggle,
}: {
  profile: AgentProfile;
  isMain: boolean;
  probing: boolean;
  probeError?: string;
  busy: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const meta = roleMeta(profile.role);
  const view = probeView(profile, probing, probeError);
  const badges = capabilityBadges(profile.capabilities ?? {});
  const enableable = canEnable(profile, view);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-paper/50"
    >
      <span className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg text-[12px] font-semibold ${meta.tint}`}>
        {meta.label}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{profile.id}</span>
          {isMain && <span className={`${TAG} bg-accentSoft text-accent`}>主 Agent</span>}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-faint">
          {commandSummary(profile)}
        </span>
        {(badges.length > 0 || view === "failed") && (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {badges.slice(0, 5).map((badge) => (
              <span key={badge} className={`${TAG} bg-solid font-mono font-medium text-onSolid`}>
                {badge}
              </span>
            ))}
            {view === "failed" && (
              <span className="max-w-[260px] truncate text-[11px] text-danger" title={probeError}>
                {probeError}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className={`${TAG} bg-solid text-muted`}>{transportLabel(profile.transport)}</span>
        <ProbeState profile={profile} probing={probing} error={probeError} />
        <Switch
          checked={profile.enabled}
          disabled={busy || (!profile.enabled && !enableable)}
          title={!profile.enabled && !enableable ? "探测通过后才能启用" : undefined}
          onChange={(enabled) => onToggle(enabled)}
        />
        <Icon name="chevronRight" size={14} className="text-faint" />
      </span>
    </div>
  );
}

function PresetCard({
  preset,
  installed,
  onPick,
}: {
  preset: AgentPreset;
  /** PATH detection result for the preset's command; undefined = not checked yet. */
  installed?: boolean;
  onPick: () => void;
}) {
  const meta = roleMeta(preset.role);
  return (
    <button
      type="button"
      onClick={onPick}
      className={`${GRP} p-3.5 text-left transition-shadow hover:shadow-[0_0_0_1px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">{preset.title}</span>
        <span className="flex shrink-0 gap-1">
          {installed === true && <span className={`${TAG} bg-okSoft text-ok`}>已安装</span>}
          {installed === false && <span className={`${TAG} bg-warnSoft text-warnInk`}>未安装</span>}
          {preset.experimental && <span className={`${TAG} bg-warnSoft text-warnInk`}>实验性</span>}
        </span>
      </span>
      <span className="mt-1 block text-[12px] leading-relaxed text-muted">{preset.description}</span>
      <code className="mt-2 block truncate font-mono text-[11px] text-faint">
        {preset.command} {preset.args.join(" ")}
      </code>
      <span className="mt-2 flex gap-1.5">
        <span className={`${TAG} ${meta.tagTint}`}>{meta.label}</span>
        <span className={`${TAG} bg-solid text-muted`}>{transportLabel(preset.transport)}</span>
      </span>
    </button>
  );
}

export function AgentsPage() {
  const {
    profiles,
    mainProfileId,
    loading,
    loadError,
    probingIds,
    probeErrors,
    busyIds,
    refresh,
    save,
    setEnabled,
    activate,
    remove,
    setMain,
  } = useAgentProfiles();
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // PATH detection for the preset drawer's 已安装/未安装 badges — one call per drawer
  // open, covering each preset's command word; informational only (never blocks 招募).
  const [detected, setDetected] = useState<Record<string, boolean> | null>(null);

  const detectablePresets = useMemo(
    () => AGENT_PRESETS.filter((preset) => preset.command !== "npx" && preset.key !== "custom"),
    [],
  );

  useEffect(() => {
    if (drawer?.kind !== "presets" && profiles.length > 0) return;
    let stale = false;
    setDetected(null);
    const commands = [...new Set(detectablePresets.map(presetCommandName))];
    detectAgentCommands(commands)
      .then((data) => {
        if (!stale) setDetected(data.results ?? {});
      })
      .catch(() => {
        if (!stale) setDetected({}); // offline — cards render without badges
      });
    return () => {
      stale = true;
    };
  }, [detectablePresets, drawer?.kind, profiles.length]);

  const existingIds = useMemo(() => new Set(profiles.map((profile) => profile.id)), [profiles]);

  const pickPreset = (preset: AgentPreset) =>
    setDrawer({ kind: "new", draft: profileFromPreset(preset, existingIds) });
  const pickBlank = () => setDrawer({ kind: "new", draft: blankProfile(existingIds) });

  const toggle = async (profile: AgentProfile, enabled: boolean) => {
    setActionError(null);
    const result = await setEnabled(profile, enabled);
    if (!result.ok) setActionError(result.error || "更新失败");
  };

  const editProfile =
    drawer?.kind === "edit" ? profiles.find((profile) => profile.id === drawer.profileId) ?? null : null;

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <header data-tauri-drag-region className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-[13px] text-muted">
            招募并管理本地 ACP agent：保存 → 探测 → 启用，再指定主 agent。
          </p>
        </div>
        {profiles.length > 0 && (
          <button
            type="button"
            onClick={() => setDrawer({ kind: "presets" })}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-white hover:brightness-105"
          >
            <Icon name="plus" size={14} />
            添加 Agent
          </button>
        )}
      </header>

      {actionError && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {actionError}
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-faint">
          <span className="spinner spinner-lg" /> 加载中
        </div>
      ) : loadError ? (
        <div className="py-20 text-center">
          <p className="text-[13px] text-danger">{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              void refresh();
            }}
            className="mt-3 rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
          >
            重试
          </button>
        </div>
      ) : profiles.length === 0 ? (
        /* 真空态:只展示本机直接检测到的 runtime。 */
        <div className="flex flex-col items-center py-16 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-xl2 bg-accentSoft text-accent">
            <Icon name="agents" size={20} />
          </div>
          <h2 className="mt-4 text-[15px] font-semibold tracking-tight">还没有 Agent</h2>
          <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted">
            这里只显示本机 PATH 能直接启动的 runtime。执行和审查角色会在 Mission 需要时再引导。
          </p>
          {detected === null ? (
            <div className="mt-6 flex items-center gap-2 text-[13px] text-faint">
              <span className="spinner" /> 检测本机 runtime
            </div>
          ) : detectablePresets.some((preset) => detected[presetCommandName(preset)] === true) ? (
            <div className="mt-6 grid w-full max-w-md grid-cols-2 gap-2.5 text-left">
              {detectablePresets
                .filter((preset) => detected[presetCommandName(preset)] === true)
                .map((preset) => (
                  <PresetCard key={preset.key} preset={preset} installed onPick={() => pickPreset(preset)} />
                ))}
            </div>
          ) : (
            <p className="mt-5 max-w-sm text-[12.5px] leading-relaxed text-faint">
              未检测到 Kimi、Gemini、OpenCode 或 Pi。你仍可手动填写本地 runtime 命令。
            </p>
          )}
          <button
            type="button"
            onClick={pickBlank}
            className="mt-4 text-[13px] text-accent hover:underline"
          >
            手动添加
          </button>
        </div>
      ) : (
        <>
          <div className={GRP_H}>已招募（{profiles.length}）</div>
          <div className={`${GRP} divide-y divide-line`}>
            {profiles.map((profile) => (
              <AgentRow
                key={profile.id}
                profile={profile}
                isMain={profile.id === mainProfileId}
                probing={probingIds.has(profile.id)}
                probeError={probeErrors[profile.id]}
                busy={busyIds.has(profile.id)}
                onOpen={() => setDrawer({ kind: "edit", profileId: profile.id })}
                onToggle={(enabled) => void toggle(profile, enabled)}
              />
            ))}
          </div>
          <p className="mt-2 px-1 text-[12px] text-faint">
            修改身份字段(角色、命令、参数、权限)会使已探测的能力失效,需要重新探测。
          </p>
        </>
      )}

      {/* 预设选择 drawer */}
      {drawer?.kind === "presets" && (
        <Drawer title="添加 Agent" onClose={() => setDrawer(null)}>
            <div className="p-4">
              <div className="grid grid-cols-2 gap-2.5">
                {detectablePresets
                  .filter((preset) => detected?.[presetCommandName(preset)] === true)
                  .map((preset) => (
                    <PresetCard
                      key={preset.key}
                      preset={preset}
                      installed
                      onPick={() => pickPreset(preset)}
                    />
                  ))}
              </div>
              {detected !== null && !detectablePresets.some((preset) => detected[presetCommandName(preset)] === true) && (
                <p className="text-[12.5px] leading-relaxed text-faint">
                  未检测到可直接启动的 runtime。不会用 npx 推断未安装的包。
                </p>
              )}
              <button
                type="button"
                onClick={pickBlank}
                className={`${GRP} mt-2.5 flex w-full items-center gap-3 p-3.5 text-left transition-shadow hover:shadow-[0_0_0_1px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]`}
              >
                <span className="grid h-[34px] w-[34px] place-items-center rounded-lg bg-solid text-onSolid">
                  <Icon name="plus" size={16} />
                </span>
                <span>
                  <span className="block text-[13px] font-semibold">空白自定义</span>
                  <span className="mt-0.5 block text-[12px] text-muted">
                    从零配置命令、角色与权限。
                  </span>
                </span>
              </button>
            </div>
        </Drawer>
      )}

      {/* 新建 / 编辑 drawer */}
      {drawer?.kind === "new" && (
        <AgentEditor
          key={`new:${drawer.draft.id}`}
          initial={drawer.draft}
          originalId={null}
          current={null}
          existingIds={existingIds}
          mainProfileId={mainProfileId}
          probing={probingIds.has(drawer.draft.id)}
          probeError={probeErrors[drawer.draft.id]}
          busy={busyIds.has(drawer.draft.id)}
          onSave={save}
          onActivate={activate}
          onSetEnabled={setEnabled}
          onSetMain={setMain}
          onDelete={remove}
          onSaved={(id) => setDrawer({ kind: "edit", profileId: id })}
          onClose={() => setDrawer(null)}
        />
      )}
      {drawer?.kind === "edit" && editProfile && (
        <AgentEditor
          key={editProfile.id}
          initial={editProfile}
          originalId={editProfile.id}
          current={editProfile}
          existingIds={existingIds}
          mainProfileId={mainProfileId}
          probing={probingIds.has(editProfile.id)}
          probeError={probeErrors[editProfile.id]}
          busy={busyIds.has(editProfile.id)}
          onSave={save}
          onActivate={activate}
          onSetEnabled={setEnabled}
          onSetMain={setMain}
          onDelete={remove}
          onSaved={() => {}}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}
