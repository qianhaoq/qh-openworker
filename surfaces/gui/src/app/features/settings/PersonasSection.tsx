// Personas:启用/停用、从 Git URL 或本地目录安装(安装后为停用态,附 consent 摘要)、
// 非内置 persona 的删除(两段确认),以及右侧抽屉里的简版详情(描述 + 推荐连接)。
// 停用会在服务端归档该 persona 的会话 —— 列表下方有说明。

import { useEffect, useState } from "react";
import {
  deletePersona,
  getPersonaDetail,
  getPersonas,
  installPersona,
  setPersonaEnabled,
} from "../../lib/api/settings";
import type { Persona, PersonaConsent, PersonaDetail } from "../../lib/api/types";
import { Drawer } from "../../components/Drawer";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";
import { BTN, BTN_ACCENT, GRP, GRP_H, GRP_NOTE, INPUT, SectionHeader, TAG } from "./controls";
import {
  apiErrorMessage,
  personaInstallBody,
  personaInstallMessage,
} from "./settingsLogic";

function PersonaDetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [detail, setDetail] = useState<PersonaDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getPersonaDetail(id)
      .then((d) => active && setDetail(d))
      .catch((err) => active && setError(apiErrorMessage(err, "详情加载失败")));
    return () => {
      active = false;
    };
  }, [id]);

  return (
    <Drawer title={detail?.name || "Persona 详情"} onClose={onClose}>
        <div className="p-4">
          {error ? (
            <p className="text-[12.5px] text-danger" role="alert">
              {error}
            </p>
          ) : !detail ? (
            <div className="flex items-center gap-2 py-6 text-[13px] text-faint">
              <span className="spinner" /> 加载中
            </div>
          ) : (
            <>
              <p className="text-[13px] leading-relaxed text-ink">{detail.description}</p>
              <p className="mt-1.5 text-[12px] text-muted">{detail.tagline}</p>

              {detail.recommended_models.length > 0 && (
                <>
                  <div className={GRP_H}>推荐模型</div>
                  <div className={GRP + " divide-y divide-line"}>
                    {detail.recommended_models.map((model) => (
                      <div key={model} className="px-4 py-2 font-mono text-[12px]">
                        {model}
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className={GRP_H}>推荐连接</div>
              {detail.recommends.length === 0 ? (
                <div className={GRP + " px-4 py-3 text-[12.5px] text-faint"}>
                  该 persona 没有声明推荐连接。
                </div>
              ) : (
                <div className={GRP + " divide-y divide-line"}>
                  {detail.recommends.map((rec, i) => (
                    <div key={`${rec.ref}-${i}`} className="flex items-start gap-3 px-4 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{rec.ref}</span>
                        {rec.reason && (
                          <span className="mt-0.5 block text-[11.5px] text-muted">{rec.reason}</span>
                        )}
                      </span>
                      {rec.tier === "core" && (
                        <span className={`${TAG} shrink-0 bg-accentSoft text-accent`}>核心</span>
                      )}
                      <span
                        className={`${TAG} shrink-0 ${
                          rec.connected ? "bg-okSoft text-ok" : "bg-solid text-muted"
                        }`}
                      >
                        {rec.connected ? "已连接" : "未连接"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className={GRP_NOTE}>在「集成」页连接后,该 persona 的新会话即可使用。</p>
            </>
          )}
        </div>
    </Drawer>
  );
}

export function PersonasSection() {
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [mode, setMode] = useState<"git" | "dir">("git");
  const [src, setSrc] = useState("");
  const [busy, setBusy] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [consent, setConsent] = useState<PersonaConsent[] | null>(null);

  const reload = async () => {
    try {
      setPersonas(await getPersonas());
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, "Persona 加载失败"));
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const toggle = async (persona: Persona, enabled: boolean) => {
    setActionError(null);
    try {
      const res = await setPersonaEnabled(persona.id, enabled);
      if (!res.ok) {
        setActionError(res.error || "更新失败");
        return;
      }
      if (res.personas) setPersonas(res.personas);
      else await reload();
    } catch (err) {
      setActionError(apiErrorMessage(err));
    }
  };

  const remove = async (persona: Persona) => {
    setConfirmDelete(null);
    setActionError(null);
    try {
      const res = await deletePersona(persona.id);
      if (!res.ok) {
        setActionError(res.error || "删除失败");
        return;
      }
      if (res.personas) setPersonas(res.personas);
      else await reload();
    } catch (err) {
      setActionError(apiErrorMessage(err));
    }
  };

  const install = async () => {
    const body = personaInstallBody(mode, src);
    if (!body) return;
    setBusy(true);
    setInstallMsg(null);
    setConsent(null);
    try {
      const res = await installPersona(body);
      if (!res.ok) {
        setInstallMsg(res.error || "安装失败");
        return;
      }
      setConsent(res.consent || []);
      if (res.personas) setPersonas(res.personas);
      setInstallMsg(personaInstallMessage((res.consent || []).length));
      setSrc("");
    } catch (err) {
      setInstallMsg(apiErrorMessage(err, "安装失败"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Personas"
        sub="启用哪些 coworker,以及安装新的 persona 包。安装只是把文件快照到受管目录,不会运行任何代码。"
      />

      {actionError && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {actionError}
        </p>
      )}

      <div className={GRP_H}>已安装{personas ? `(${personas.length})` : ""}</div>
      {loadError ? (
        <div className="py-8 text-center">
          <p className="text-[13px] text-danger">{loadError}</p>
          <button type="button" className={BTN_ACCENT + " mt-3"} onClick={() => void reload()}>
            重试
          </button>
        </div>
      ) : !personas ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-faint">
          <span className="spinner" /> 加载中
        </div>
      ) : (
        <div className={GRP + " divide-y divide-line"}>
          {personas.map((persona) => (
            <div key={persona.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => setDetailId(persona.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDetailId(persona.id);
                  }
                }}
                className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left hover:bg-paper/50"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium">{persona.name}</span>
                    {persona.default && (
                      <span className={`${TAG} bg-accentSoft text-accent`}>默认</span>
                    )}
                    {persona.builtin && (
                      <span className={`${TAG} bg-solid text-muted`}>内置</span>
                    )}
                    {persona.family && (
                      <span className={`${TAG} bg-tealSoft text-tealInk`}>{persona.family}</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-muted">
                    {persona.tagline}
                  </span>
                </span>
                <Switch
                  checked={persona.enabled}
                  title={persona.enabled ? "停用" : "启用"}
                  onChange={(enabled) => void toggle(persona, enabled)}
                />
                {!persona.builtin &&
                  (confirmDelete === persona.id ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className="rounded-lg bg-danger px-2.5 py-1 text-[12px] font-medium text-white"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(persona);
                      }}
                    >
                      删除
                    </button>
                    <button
                      type="button"
                      className={BTN + " px-2.5 py-1 text-[12px]"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(null);
                      }}
                    >
                      保留
                    </button>
                  </span>
                  ) : (
                  <button
                    type="button"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded text-faint hover:bg-paper hover:text-danger"
                    title={`删除 ${persona.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmDelete(persona.id);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                  ))}
                <Icon name="chevronRight" size={14} className="shrink-0 text-faint" />
              </div>
            </div>
          ))}
        </div>
      )}
      <p className={GRP_NOTE}>停用 persona 会在服务端归档其会话(仍可在归档中查看)。</p>

      <div className={GRP_H}>安装 persona</div>
      <div className={GRP + " divide-y divide-line"}>
        <div className="flex items-center gap-2 px-4 py-2.5">
          <select
            className={INPUT + " w-[130px] shrink-0"}
            value={mode}
            onChange={(e) => setMode(e.target.value as "git" | "dir")}
          >
            <option value="git">Git URL</option>
            <option value="dir">本地目录</option>
          </select>
          <input
            className={INPUT}
            placeholder={mode === "git" ? "https://github.com/acme/ops-persona" : "/path/to/personas"}
            value={src}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setSrc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void install()}
          />
          <button
            type="button"
            className={BTN_ACCENT + " shrink-0"}
            disabled={busy || !src.trim()}
            onClick={() => void install()}
          >
            {busy ? "安装中…" : "安装"}
          </button>
        </div>
      </div>
      {installMsg && <p className={GRP_NOTE}>{installMsg}</p>}

      {consent && consent.length > 0 && (
        <div className="mt-3 space-y-2">
          {consent.map((c) => (
            <div key={c.id} className={GRP + " px-4 py-3"}>
              <div className="text-[13px] font-semibold">{c.name}</div>
              <div className="mt-0.5 text-[12px] text-muted">{c.description}</div>
              <div className="mt-1.5 text-[12px] text-ink">
                工具:{c.tools.join(", ") || "—"}
              </div>
              <div className="text-[12px] text-ink">
                权限:{c.risk.join(", ") || "只读"}
                {c.connectors ? " · 连接器" : ""}
                {c.messaging ? " · 消息" : ""}
                {c.mcp.length ? ` · MCP: ${c.mcp.join(", ")}` : ""}
              </div>
              <div className="mt-1 text-[11.5px] text-faint">
                建议模式:{c.recommended_mode}。安装后为停用状态,请在上方启用。
              </div>
            </div>
          ))}
        </div>
      )}

      {detailId && <PersonaDetailDrawer id={detailId} onClose={() => setDetailId(null)} />}
    </section>
  );
}
