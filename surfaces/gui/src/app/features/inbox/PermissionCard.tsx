// ACP 权限请求卡片:本地 agent(executor/reviewer 等)挂起的工具调用授权。
// 每个 option 一个按钮(标签经 inboxLogic 中文化,拒绝类选项低调标红);仅当 options
// 里没有拒绝类选项时才补一个显式「拒绝」(option_id = null),避免两个「拒绝」并排。
// 契约:/v1/agent-permissions(app.py:1455-1470),resolve 后服务端标记 resolved/denied。

import { Icon } from "../../components/Icon";
import type { AgentPermission } from "../../lib/api/types";
import {
  permissionOptionId,
  permissionOptionIsDeny,
  permissionOptionLabel,
  permissionToolDetail,
  permissionToolName,
} from "./inboxLogic";

const BTN_PRIMARY =
  "rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-105 disabled:opacity-40 disabled:hover:brightness-100";
const BTN_BORDERED =
  "rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:border-lineStrong disabled:opacity-40";
const BTN_DENY = "px-3 py-1.5 text-[12.5px] text-faint hover:text-danger disabled:opacity-40";

export function PermissionCard({
  permission,
  busy,
  onResolve,
}: {
  permission: AgentPermission;
  busy: boolean;
  onResolve: (permissionId: string, optionId: string | null) => void;
}) {
  const toolName = permissionToolName(permission);
  const detail = permissionToolDetail(permission);
  const options = permission.options ?? [];
  const requester = permission.profile_id || permission.role || "agent";
  // options 里已有拒绝类选项时不再画额外的「拒绝」,避免 "Reject" 与「拒绝」并排。
  const hasDenyOption = options.some(
    (option) => permissionOptionId(option) && permissionOptionIsDeny(option),
  );

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-lg bg-warnSoft text-warnInk">
          <Icon name="shield" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-snug">
            {requester} 请求调用 {toolName}
          </div>
          <div className="mt-0.5 text-[11.5px] text-faint">ACP 权限请求</div>
        </div>
      </div>
      {detail && (
        <div className="mt-2 truncate font-mono text-[11.5px] text-muted" title={detail}>
          {detail}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {options.map((option) => {
          const id = permissionOptionId(option);
          if (!id) return null;
          const deny = permissionOptionIsDeny(option);
          return (
            <button
              key={id}
              type="button"
              className={deny ? BTN_DENY : options[0] === option ? BTN_PRIMARY : BTN_BORDERED}
              disabled={busy}
              onClick={() => onResolve(permission.permission_id, id)}
            >
              {permissionOptionLabel(option)}
            </button>
          );
        })}
        {!hasDenyOption && (
          <button
            type="button"
            className={options.length > 0 ? BTN_DENY : BTN_BORDERED}
            disabled={busy}
            onClick={() => onResolve(permission.permission_id, null)}
          >
            拒绝
          </button>
        )}
      </div>
    </div>
  );
}
