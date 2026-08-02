import { describe, expect, it } from "vitest";
import { humanizeErrorText } from "./errorText";

describe("humanizeErrorText", () => {
  it("maps mission readiness gate codes to repair-focused copy", () => {
    expect(humanizeErrorText('{"code":"WORKSPACE_REQUIRED","message":"Mission creation requires a workspace."}')).toBe(
      "需要先选择一个可用 workspace。请返回首页添加 workspace。",
    );
    expect(humanizeErrorText('{"code":"MAIN_AGENT_MISSING","message":"Mission creation requires a workspace main Agent."}')).toBe(
      "当前 workspace 缺少 main Agent。请返回首页添加并激活 main Agent。",
    );
    expect(humanizeErrorText('{"code":"MAIN_AGENT_UNVERIFIED","message":"The workspace main Agent profile must be activated first."}')).toBe(
      "当前 workspace 的 main Agent 还未激活。请返回首页添加并测试 main Agent。",
    );
  });

  it("maps the mission-create executor 400", () => {
    expect(humanizeErrorText("confirmed coding missions require an executor profile")).toBe(
      "需要先在 Agents 页招募并启用一个「执行」角色的 agent",
    );
  });

  it("maps the confirm 409 and interpolates the seat profile id", () => {
    expect(humanizeErrorText("unknown or disabled mission profile: opencode-executor")).toBe(
      "席位 opencode-executor 的 agent 未启用或未探测",
    );
  });

  it("maps the cancelled-mission message 409", () => {
    expect(humanizeErrorText("cancelled tasks cannot be reopened")).toBe(
      "已取消的任务不能重新开始",
    );
  });

  it("maps '<X> is not connected.' with the connector name", () => {
    expect(humanizeErrorText("Slack is not connected.")).toBe(
      "Slack 未连接 —— 请先在「集成 → 连接器」中完成连接。",
    );
    expect(humanizeErrorText("Telegram is not connected")).toBe(
      "Telegram 未连接 —— 请先在「集成 → 连接器」中完成连接。",
    );
  });

  it("maps the missing model API key text embedded in a longer message", () => {
    expect(
      humanizeErrorText(
        "No model API key configured. Set OPENAI_API_KEY in the environment, or add your key in Manage → Settings.",
      ),
    ).toBe("未配置模型 API 密钥。请在 设置 → 模型 中添加,或设置环境变量。");
  });

  it("maps the probe PATH failure with the command name", () => {
    expect(humanizeErrorText("agent command not found on PATH: agent")).toBe(
      "在 PATH 中找不到命令:agent",
    );
  });

  it("maps whitespace model-id rejections", () => {
    expect(humanizeErrorText("model id must not contain whitespace")).toBe(
      "模型 ID 不能包含空格或空白字符",
    );
  });

  it("maps absolute-path rejections", () => {
    expect(humanizeErrorText("scratch_base must be an absolute path")).toBe(
      "请输入绝对路径(以 / 或 ~/ 开头)",
    );
  });

  it("maps a bare 'Not Found' connector error", () => {
    expect(humanizeErrorText("Not Found")).toBe(
      "无法连接:远端返回 404 Not Found —— 请检查令牌或配置是否正确。",
    );
  });

  it("passes unmatched text through untouched", () => {
    expect(humanizeErrorText("Request failed with status 500")).toBe(
      "Request failed with status 500",
    );
    expect(humanizeErrorText("Invalid API key.")).toBe("Invalid API key.");
    expect(humanizeErrorText("频道不存在")).toBe("频道不存在");
  });

  it("tolerates empty input", () => {
    expect(humanizeErrorText("")).toBe("");
    expect(humanizeErrorText(null)).toBe("");
    expect(humanizeErrorText(undefined)).toBe("");
  });
});
