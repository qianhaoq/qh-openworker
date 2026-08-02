// 消息路由 tab: who listens where. Three small groups — 频道订阅 (session ← channel,
// add/remove), 最近频道 (the inbound roster the picker reads), 收件箱路由 (named Inbox
// bindings: where unattended approvals/questions mirror) — plus the DM 默认会话行.
// Deliberately minimal: bindings have no delete endpoint, clearing one means
// channel=null (mirror to the in-app Inbox only).

import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../lib/api/types";
import { getSessions } from "../../lib/api/sessions";
import { bindingTargetLabel, channelLabel, splitChannel, truncate } from "./integrationLogic";
import { useRouting } from "./useRouting";
import { FOOT, GRP, GRP_H, INPUT, PILL_QUIET, ROW, TAG_QUIET, TAG_WARN, XBTN } from "./ui";

type Routing = ReturnType<typeof useRouting>;

export function RoutingView() {
  const routing = useRouting();
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    getSessions()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  if (routing.loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[13px] text-faint">
        <span className="spinner spinner-lg" /> 加载中
      </div>
    );
  }
  if (routing.loadError) {
    return (
      <div className="py-20 text-center">
        <p className="text-[13px] text-danger">{routing.loadError}</p>
        <button
          type="button"
          onClick={() => void routing.refresh().catch(() => {})}
          className="mt-3 rounded-lg border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:border-lineStrong"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div>
      <header>
        <h2 className="text-[22px] font-semibold tracking-tight">消息路由</h2>
        <p className="mt-1 text-[13px] text-muted">
          频道消息进入哪个会话、无人值守的审批镜像到哪里。
        </p>
      </header>

      {routing.actionError && (
        <p className="mt-3 text-[12px] text-danger" role="alert">
          {routing.actionError}
        </p>
      )}

      <SubscriptionsGroup routing={routing} sessions={sessions} />
      <RecentChannelsGroup routing={routing} />
      <BindingsGroup routing={routing} />
      <DmRouteGroup routing={routing} sessions={sessions} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 频道订阅
// ---------------------------------------------------------------------------

function SubscriptionsGroup({ routing, sessions }: { routing: Routing; sessions: Session[] }) {
  const [sessionId, setSessionId] = useState("");
  const [channel, setChannel] = useState("");

  const sessionOptions = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.session_id,
        label: s.title?.trim() || s.session_id,
      })),
    [sessions],
  );

  const canAdd = sessionId && channel;
  const add = async () => {
    const result = await routing.subscribe(sessionId, channel);
    if (result.ok) setChannel("");
  };

  return (
    <>
      <div className={GRP_H}>频道订阅</div>
      <div className={GRP} data-testid="subscriptions-group">
        {routing.subscriptions.length === 0 && (
          <div className={`${ROW} text-[12.5px] text-muted`}>
            还没有会话订阅频道 — 订阅后,频道新消息会进入该会话。
          </div>
        )}
        {routing.subscriptions.map((s) => {
          const { platform } = splitChannel(s.channel);
          return (
            <div key={`${s.session_id}:${s.channel}`} className={ROW}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[12.5px]">
                  <span className="truncate font-medium" title={s.session_id}>
                    {s.session_title || s.session_id}
                  </span>
                  <span className="text-faint">←</span>
                  <span className="truncate text-muted" title={s.channel}>
                    {channelLabel(s.channel, s.channel_name)}
                  </span>
                  {platform && <span className={TAG_QUIET}>{platform}</span>}
                  {s.collision && (
                    <span className={TAG_WARN} title="该频道同时是收件箱路由目标,消息可能重复">
                      与路由冲突
                    </span>
                  )}
                </span>
              </span>
              <button
                type="button"
                className={XBTN}
                title="取消订阅"
                onClick={() => void routing.unsubscribe(s.session_id, s.channel)}
              >
                ×
              </button>
            </div>
          );
        })}
        {/* 添加行:会话 + 频道(取自最近频道) */}
        <div className={ROW}>
          <select
            className={`${INPUT} !w-auto flex-1`}
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            data-testid="subscribe-session"
          >
            <option value="">选择会话…</option>
            {sessionOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className={`${INPUT} !w-auto flex-1`}
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            data-testid="subscribe-channel"
          >
            <option value="">选择频道…</option>
            {routing.recentChannels.map((ch) => (
              <option key={ch.channel} value={ch.channel}>
                {channelLabel(ch.channel, ch.name)}
              </option>
            ))}
          </select>
          <button type="button" className={PILL_QUIET} disabled={!canAdd} onClick={() => void add()}>
            添加
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 最近频道
// ---------------------------------------------------------------------------

function RecentChannelsGroup({ routing }: { routing: Routing }) {
  return (
    <>
      <div className={GRP_H}>最近频道</div>
      <div className={GRP} data-testid="recent-channels-group">
        {routing.recentChannels.length === 0 && (
          <div className={`${ROW} text-[12.5px] text-muted`}>
            还没有收到任何频道消息 — 连接 Slack 等聊天平台后,这里会列出有动静的频道。
          </div>
        )}
        {routing.recentChannels.map((ch) => {
          const { platform } = splitChannel(ch.channel);
          return (
            <div key={ch.channel} className={ROW} title={ch.channel}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">
                    {channelLabel(ch.channel, ch.name)}
                  </span>
                  {platform && <span className={TAG_QUIET}>{platform}</span>}
                </span>
                {(ch.last_from || ch.last_text) && (
                  <span className="mt-0.5 block truncate text-[12px] text-faint">
                    {ch.last_from ? `${ch.last_from}:` : ""} {truncate(ch.last_text ?? "", 60)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 收件箱路由绑定
// ---------------------------------------------------------------------------

function BindingsGroup({ routing }: { routing: Routing }) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("");
  const [target, setTarget] = useState("");

  const canAdd = name.trim() && target.trim();
  const add = async () => {
    const result = await routing.saveBinding(name.trim(), channel.trim() || null, target.trim());
    if (result.ok) {
      setName("");
      setChannel("");
      setTarget("");
    }
  };

  return (
    <>
      <div className={GRP_H}>收件箱路由</div>
      <div className={GRP} data-testid="bindings-group">
        {routing.bindings.length === 0 && (
          <div className={`${ROW} text-[12.5px] text-muted`}>
            无人值守时产生的审批与提问只进入应用内收件箱。
          </div>
        )}
        {routing.bindings.map((b) => (
          <div key={b.name} className={ROW}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{b.name}</span>
              <span className="mt-0.5 block truncate text-[12px] text-muted">
                {bindingTargetLabel(b)}
              </span>
            </span>
            {b.channel && (
              <button
                type="button"
                className="shrink-0 text-[12px] text-muted hover:text-ink"
                title="停止镜像到外部平台,只保留应用内收件箱"
                onClick={() => void routing.saveBinding(b.name, null, "")}
              >
                改为仅应用内
              </button>
            )}
          </div>
        ))}
        <div className={ROW}>
          <input
            className={`${INPUT} !w-auto flex-1`}
            placeholder="收件箱名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="binding-name"
          />
          <input
            className={`${INPUT} !w-24`}
            placeholder="平台,如 slack"
            value={channel}
            spellCheck={false}
            onChange={(e) => setChannel(e.target.value)}
          />
          <input
            className={`${INPUT} !w-auto flex-1 font-mono`}
            placeholder="目标,如 T0123/C0123"
            value={target}
            spellCheck={false}
            onChange={(e) => setTarget(e.target.value)}
          />
          <button type="button" className={PILL_QUIET} disabled={!canAdd} onClick={() => void add()}>
            添加
          </button>
        </div>
      </div>
      <p className={FOOT}>
        镜像到 Slack 前,需要先在 Slack 连接器里设置至少一位审批负责人。
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// 私聊(DM)默认会话
// ---------------------------------------------------------------------------

function DmRouteGroup({ routing, sessions }: { routing: Routing; sessions: Session[] }) {
  const [picked, setPicked] = useState("");
  const current = routing.dmRoute
    ? sessions.find((s) => s.session_id === routing.dmRoute)?.title || routing.dmRoute
    : null;

  return (
    <>
      <div className={GRP_H}>私聊(DM)</div>
      <div className={GRP} data-testid="dm-route-group">
        <div className={ROW}>
          <span className="min-w-0 flex-1 text-[12.5px] text-muted">
            {current ? (
              <>
                私聊消息默认进入会话 <span className="font-medium text-ink">{current}</span>
              </>
            ) : (
              "未指定默认会话 — 私聊消息会暂存为未路由。"
            )}
          </span>
          {routing.dmRoute && (
            <button
              type="button"
              className="shrink-0 text-[12px] text-muted hover:text-ink"
              onClick={() => void routing.setDm("")}
            >
              清除
            </button>
          )}
        </div>
        <div className={ROW}>
          <select
            className={`${INPUT} !w-auto flex-1`}
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
            data-testid="dm-route-session"
          >
            <option value="">选择会话…</option>
            {sessions.map((s) => (
              <option key={s.session_id} value={s.session_id}>
                {s.title?.trim() || s.session_id}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={PILL_QUIET}
            disabled={!picked}
            onClick={() => void routing.setDm(picked)}
          >
            设为默认
          </button>
        </div>
      </div>
      <p className={FOOT}>私聊没有频道上下文,需要一个明确的去向。</p>
    </>
  );
}
