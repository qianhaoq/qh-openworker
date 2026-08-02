// The chat header's agent picker (replaces the old ACP boolean toggle): a pill showing
// the current selection — 内置助理 / ACP / a profile id — opening a dropdown with
// 内置助理 + every usable (enabled + probed) agent profile. Profiles are fetched on
// first open and cached for the mount; a failed fetch still leaves 内置助理 selectable.

import { useEffect, useRef, useState } from "react";
import { listAgentProfiles } from "../../lib/api/agents";
import type { AgentProfile } from "../../lib/api/types";
import { Icon } from "../../components/Icon";
import { navigate } from "../../nav";
import { roleMeta } from "../agents/agentLogic";
import { agentChoiceLabel, selectableProfiles, type AgentChoice } from "./agentChoice";

export interface AgentPickerProps {
  choice: AgentChoice;
  onSelect: (choice: AgentChoice) => void;
}

export function AgentPicker({ choice, onSelect }: AgentPickerProps) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const fetchedRef = useRef(false);

  // Lazy profile list: fetched on the first open, cached for the rest of the mount.
  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    let stale = false;
    listAgentProfiles()
      .then((list) => {
        if (!stale) setProfiles(list);
      })
      .catch(() => {
        if (!stale) setProfiles([]); // offline — the menu still offers 内置助理
      });
    return () => {
      stale = true;
    };
  }, [open]);

  const usable = selectableProfiles(profiles ?? []);
  // ACP/teal when an agent (workspace main or an explicit profile) is selected.
  const agentActive = choice !== "embedded";

  const pick = (next: AgentChoice) => {
    onSelect(next);
    setOpen(false);
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="选择 Agent"
        title={agentActive ? `当前：${agentChoiceLabel(choice)}（点击切换 Agent）` : "当前：内置助理（点击切换 Agent）"}
        data-testid="agent-picker"
        className={`inline-flex max-w-[200px] items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${
          agentActive
            ? "border-tealLine bg-tealSoft text-tealInk"
            : "border-line bg-panel text-faint hover:text-muted"
        }`}
      >
        <span className="truncate">{agentChoiceLabel(choice)}</span>
        <Icon name="chevronDown" size={10} className="shrink-0 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full z-40 mt-1 max-h-[320px] w-[240px] overflow-y-auto rounded-xl border border-line bg-panel p-1.5 shadow-2xl"
            role="menu"
            data-testid="agent-menu"
          >
            <button
              type="button"
              className="w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-paper"
              onClick={() => pick("embedded")}
            >
              <span
                className={
                  "block truncate text-[13px] " +
                  (choice === "embedded" ? "font-medium text-accent" : "text-ink")
                }
              >
                内置助理
                {choice === "embedded" && <span className="ml-1.5">✓</span>}
              </span>
              <span className="block truncate text-[11px] text-faint">内置引擎，无需本地 runtime</span>
            </button>
            {usable.map((profile) => {
              const meta = roleMeta(profile.role);
              const selected = choice === profile.id;
              return (
                <button
                  type="button"
                  key={profile.id}
                  className="w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-paper"
                  title={profile.id}
                  onClick={() => pick(profile.id)}
                >
                  <span className="flex items-center gap-1.5">
                    <span className={`rounded px-1 py-0.5 text-[10px] font-semibold ${meta.tagTint}`}>
                      {meta.label}
                    </span>
                    <span
                      className={
                        "min-w-0 truncate text-[13px] " +
                        (selected ? "font-medium text-accent" : "text-ink")
                      }
                    >
                      {profile.id}
                      {selected && <span className="ml-1.5">✓</span>}
                    </span>
                  </span>
                </button>
              );
            })}
            {profiles === null && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] text-faint">
                <span className="spinner" /> 加载 Agent 列表…
              </div>
            )}
            {profiles !== null && usable.length === 0 && (
              <button
                type="button"
                className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-faint hover:bg-paper hover:text-accent"
                data-testid="agent-menu-recruit"
                onClick={() => {
                  setOpen(false);
                  navigate("agents");
                }}
              >
                没有可用的 Agent — 去 Agents 页招募 →
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
