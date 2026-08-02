// Tool calls render as Chinese one-liners — the model emits name+args+result, no purpose,
// so the sentence is synthesized here from per-tool templates. `run_shell`'s optional
// `description` argument is model-written intent and is preferred when present.
// Fallback: "使用 <tool> — <short args>".

export interface HumanLine {
  pre: string;
  obj?: string;
  post?: string;
}

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

/** "k=v  k=v …" with per-value truncation — the raw-args one-liner. */
export function shortArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => {
      let s = typeof v === "string" ? v : JSON.stringify(v);
      if (s.length > 96) s = s.slice(0, 95) + "...";
      return `${k}=${s.replace(/\n/g, " ")}`;
    })
    .join("  ");
}

// send_message targets are "platform:chat" or "platform:chat:thread".
function messageTarget(target: string): { platform: string; tail: string } {
  const [platform, ...rest] = String(target).split(":");
  const chat = rest[0] || "";
  const tail = chat.includes("/") ? chat.split("/").pop() || chat : chat;
  const names: Record<string, string> = { slack: "Slack", telegram: "Telegram" };
  return { platform: names[platform] || platform, tail };
}

export function humanizeTool(name: string, args: unknown): HumanLine {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "run_shell": {
      const cmd = trunc(String(a.command ?? ""), 60);
      const desc = typeof a.description === "string" && a.description.trim() ? a.description.trim() : "";
      return {
        pre: a.run_in_background ? "后台运行 " : "运行 ",
        obj: cmd,
        ...(desc ? { post: ` — ${desc}` } : {}),
      };
    }
    case "shell_task_output":
      return { pre: "查看后台命令输出" };
    case "shell_task_kill":
      return { pre: "停止了后台命令" };
    case "read_file":
      return { pre: "读取 ", obj: baseName(String(a.path ?? "文件")) };
    case "write_file":
      return { pre: "写入 ", obj: baseName(String(a.path ?? "文件")) };
    case "replace_in_file":
    case "apply_patch":
    case "apply_unified_diff":
      return { pre: "编辑 ", obj: a.path ? baseName(String(a.path)) : "文件" };
    case "grep":
      return { pre: "在代码中搜索 ", obj: `“${trunc(String(a.pattern ?? ""), 40)}”` };
    case "git_log":
      return { pre: "查看最近的 git 历史" };
    case "todo_write": {
      const items = Array.isArray(a.todos) ? a.todos : Array.isArray(a.items) ? a.items : [];
      if (items.length === 1) {
        const it = (items[0] || {}) as Record<string, unknown>;
        const status = String(it.status || "").replace(/_/g, " ");
        return {
          pre: "更新计划 — ",
          obj: `“${trunc(String(it.content ?? ""), 70)}”`,
          ...(status ? { post: ` → ${status}` } : {}),
        };
      }
      return { pre: `更新计划 — ${items.length} 项` };
    }
    case "send_message": {
      const { platform, tail } = messageTarget(String(a.target ?? ""));
      if (!tail) return { pre: "发送消息" };
      return { pre: `发送 ${platform} 消息给 `, obj: tail };
    }
    case "web_search":
      return { pre: "搜索网页 — ", obj: `“${trunc(String(a.query ?? ""), 60)}”` };
    case "web_fetch": {
      let host = String(a.url ?? "");
      try {
        host = new URL(host).host || host;
      } catch {
        /* keep raw */
      }
      return { pre: "读取网页 — ", obj: trunc(host, 50) };
    }
    case "explore":
      return { pre: "派出子 Agent 探索 — ", obj: `“${trunc(String(a.task ?? a.prompt ?? ""), 60)}”` };
    case "ask_user":
      return { pre: "向你提问" };
    case "propose_plan":
      return { pre: "提出了计划" };
    case "request_directory":
      return { pre: "请求访问文件夹 — ", obj: String(a.path ?? "") };
    default: {
      const rest = trunc(shortArgs(a), 80);
      return { pre: `使用 ${name}`, ...(rest ? { post: ` — ${rest}` } : {}) };
    }
  }
}

/** The approval card's headline: the ask, phrased as the action being decided. */
export function humanizeApprovalTitle(name: string, args: unknown): HumanLine {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "write_file":
      return { pre: "写入 ", obj: baseName(String(a.path ?? "文件")) };
    case "replace_in_file":
    case "apply_patch":
    case "apply_unified_diff":
      return { pre: "编辑 ", obj: a.path ? baseName(String(a.path)) : "文件" };
    case "run_shell": {
      const desc = typeof a.description === "string" && a.description.trim() ? a.description.trim() : "";
      return { pre: "运行命令", ...(desc ? { post: ` — ${desc}` } : {}) };
    }
    case "send_message": {
      const { tail } = messageTarget(String(a.target ?? ""));
      return tail ? { pre: "发送消息给 ", obj: tail } : { pre: "发送消息" };
    }
    case "send_file": {
      const { tail } = messageTarget(String(a.target ?? ""));
      return tail ? { pre: "发送文件给 ", obj: tail } : { pre: "发送文件" };
    }
    case "create_scheduled_task":
      return a.title
        ? { pre: "创建自动化 ", obj: `“${trunc(String(a.title), 60)}”` }
        : { pre: "创建自动化任务" };
    default:
      return { pre: `使用 ${name}` };
  }
}

/** Plain-words scope note: where does this act? */
export function scopeNote(
  name: string,
  args: unknown,
  category?: string,
): { text: string; external: boolean } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (category === "connector") return { text: "作用于已连接的服务", external: true };
  if (name === "send_message" || name === "send_file") {
    const platform = String(a.target ?? "").split(":")[0];
    const names: Record<string, string> = { slack: "Slack", telegram: "Telegram" };
    return { text: `会发送出去 → ${names[platform] || platform || "已连接的聊天"}`, external: true };
  }
  const overwrite = name === "write_file" && a.overwrite;
  return { text: "仅在这台电脑上" + (overwrite ? " · 会覆盖已有文件" : ""), external: false };
}

// Approvals with no executed tool call (typically declined): the ask, phrased as intent.
export function humanizeAsk(name: string, args: unknown): HumanLine {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "run_shell":
      return { pre: "想运行 ", obj: trunc(String(a.command ?? ""), 60) };
    case "write_file":
      return { pre: "想写入 ", obj: baseName(String(a.path ?? "文件")) };
    case "replace_in_file":
    case "apply_patch":
    case "apply_unified_diff":
      return { pre: "想编辑 ", obj: a.path ? baseName(String(a.path)) : "文件" };
    case "send_message": {
      const { platform, tail } = messageTarget(String(a.target ?? ""));
      if (!tail) return { pre: "想发送消息" };
      return { pre: "想发消息给 ", obj: tail, post: `（${platform}）` };
    }
    default:
      return { pre: `想使用 ${name}` };
  }
}
