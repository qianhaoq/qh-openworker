// 后端英文错误串 → 中文展示文案。这些是后端稳定的错误契约(orchestrator.py、
// server/app.py、providers/*),按模式匹配;匹配不到的一律原样透传。
// 集中在这里,免得每个页面各自拼正则 —— 全部函数由 errorText.test.ts 覆盖。

interface ErrorMapping {
  re: RegExp;
  /** 固定文案,或拿到正则命中后的构造函数($1… 为捕获组)。 */
  text: string | ((match: RegExpMatchArray) => string);
}

// 顺序即优先级:更具体的模式放前面。
const MAPPINGS: readonly ErrorMapping[] = [
  {
    re: /"code"\s*:\s*"MAIN_AGENT_MISSING"|Mission creation requires a workspace main Agent/,
    text: "当前 workspace 缺少 main Agent。请返回首页添加并激活 main Agent。",
  },
  {
    re: /"code"\s*:\s*"MAIN_AGENT_UNVERIFIED"|main Agent profile must be activated first/,
    text: "当前 workspace 的 main Agent 还未激活。请返回首页添加并测试 main Agent。",
  },
  {
    re: /"code"\s*:\s*"MAIN_AGENT_UNAVAILABLE"|main Agent profile is disabled|not an ACP runtime/,
    text: "当前 workspace 的 main Agent 不可用。请到 Agents 修复或重新添加。",
  },
  {
    re: /"code"\s*:\s*"WORKSPACE_REQUIRED"|Mission creation requires a workspace\.|Mission workspace must be an existing directory/,
    text: "需要先选择一个可用 workspace。请返回首页添加 workspace。",
  },
  {
    // POST /v1/missions 400 — 没有可用「执行」profile(orchestrator.py)。
    re: /confirmed coding missions require an executor profile/,
    text: "需要先在 Agents 页招募并启用一个「执行」角色的 agent",
  },
  {
    // POST /v1/missions/{id}/confirm 409 — 席位 profile 未知/未启用(orchestrator.py)。
    re: /^unknown or disabled mission profile:\s*(.+?)\s*$/,
    text: (m) => `席位 ${m[1]} 的 agent 未启用或未探测`,
  },
  {
    // POST /v1/missions/{id}/messages 409 — 已取消的任务。
    re: /cancelled tasks cannot be reopened/,
    text: "已取消的任务不能重新开始",
  },
  {
    // 路由绑定等接口 — "<Name> is not connected."(server/app.py 各 connector 检查)。
    re: /^([A-Za-z][\w .-]*?) is not connected\.?$/,
    text: (m) => `${m[1]} 未连接 —— 请先在「集成 → 连接器」中完成连接。`,
  },
  {
    // 模型密钥缺失(providers/openai_provider.py 等,旧文案指向已不存在的 "Manage → Settings")。
    re: /No model API key configured/i,
    text: "未配置模型 API 密钥。请在 设置 → 模型 中添加,或设置环境变量。",
  },
  {
    // agent profile 探测 400 — 命令不在 PATH(server/app.py probe 路由)。
    re: /agent command not found on PATH:\s*(.+?)\s*$/,
    text: (m) => `在 PATH 中找不到命令:${m[1]}`,
  },
  {
    // 模型 ID 含空白字符(server 端 models/add 校验)。
    re: /model[^\n]*\b(whitespace|white space|spaces)\b/i,
    text: "模型 ID 不能包含空格或空白字符",
  },
  {
    // scratch-base 必须是绝对路径(server 端 scratch-base 校验)。
    re: /\bmust be an absolute path\b|\babsolute path\b/i,
    text: "请输入绝对路径(以 / 或 ~/ 开头)",
  },
  {
    // 连接器把远端的原始 404 透传了出来(如 Telegram 无效 bot token)。
    re: /^Not Found$/,
    text: "无法连接:远端返回 404 Not Found —— 请检查令牌或配置是否正确。",
  },
];

/** 已知后端错误串翻成中文;未知文本原样返回。null/空串也安全透传。 */
export function humanizeErrorText(text: string | null | undefined): string {
  if (!text) return text ?? "";
  const trimmed = text.trim();
  for (const { re, text: to } of MAPPINGS) {
    const match = trimmed.match(re);
    if (match) return typeof to === "string" ? to : to(match);
  }
  return text;
}
