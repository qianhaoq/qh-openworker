import { describe, expect, it } from "vitest";
import type { Connector, McpServer } from "../../lib/api/types";
import {
  accountCount,
  accountUnit,
  auditTone,
  bindingTargetLabel,
  brandStyles,
  channelLabel,
  configFromMcpForm,
  connectorStatus,
  editChangesFromMcpForm,
  enabledToolCount,
  formatAuditArgs,
  formatEpoch,
  formatTimestamp,
  githubHealthView,
  initials,
  monogram,
  mcpConfigSummary,
  mcpFormFromServer,
  mcpStatusView,
  needsReauth,
  parseArgsText,
  parseEnvLines,
  slackHealthView,
  splitChannel,
  truncate,
  blankMcpForm,
} from "./integrationLogic";

const baseConnector = (overrides: Partial<Connector> = {}): Connector => ({
  name: "slack",
  title: "Slack",
  icon: "#",
  blurb: "消息与频道",
  auth: "oauth",
  two_way: true,
  channels: true,
  available: true,
  fields: [],
  instructions: [],
  connected: false,
  account: null,
  enabled: true,
  brand_color: "#611f69",
  logo: "slack",
  allowed_users: [],
  tools: [],
  managed: false,
  managed_profile: false,
  ...overrides,
});

describe("brandStyles", () => {
  it("derives a soft badge tint from the brand color", () => {
    const { badge, dot } = brandStyles("#611f69");
    expect(badge.color).toBe("#611f69");
    expect(badge.background).toContain("#611f69");
    expect(dot.background).toBe("#611f69");
  });

  it("falls back to neutral gray for missing or invalid colors", () => {
    expect(brandStyles(undefined).badge.color).toBe("#6b7280");
    expect(brandStyles("not-a-color").badge.color).toBe("#6b7280");
    expect(brandStyles(" #ea4335 ").badge.color).toBe("#ea4335");
  });
});

describe("monogram", () => {
  it("uses the server icon glyph when short", () => {
    expect(monogram({ icon: "#", title: "Slack", name: "slack" })).toBe("#");
    expect(monogram({ icon: "✉", title: "Gmail", name: "gmail" })).toBe("✉");
  });

  it("falls back to the title's first letter, then ?", () => {
    expect(monogram({ icon: "", title: "HubSpot", name: "hubspot" })).toBe("H");
    expect(monogram({ icon: "", title: "", name: "" })).toBe("?");
  });
});

describe("accountUnit / accountCount", () => {
  it("picks the per-kind noun", () => {
    expect(accountUnit({ name: "slack" })).toBe("工作区");
    expect(accountUnit({ name: "github" })).toBe("安装");
    expect(accountUnit({ name: "hubspot" })).toBe("门户");
    expect(accountUnit({ name: "gmail" })).toBe("账户");
  });

  it("counts the per-kind collection, falling back to connected ? 1 : 0", () => {
    expect(
      accountCount(baseConnector({ workspaces: [{ team_id: "T1" }, { team_id: "T2" }] as never })),
    ).toBe(2);
    expect(
      accountCount(
        baseConnector({ name: "github", workspaces: undefined, installations: [{}] as never }),
      ),
    ).toBe(1);
    expect(accountCount(baseConnector({ connected: true }))).toBe(1);
    expect(accountCount(baseConnector())).toBe(0);
  });
});

describe("connectorStatus", () => {
  it("reports 不可用 when the connector is unavailable", () => {
    const s = connectorStatus(baseConnector({ available: false }));
    expect(s.label).toBe("不可用");
    expect(s.tone).toBe("off");
  });

  it("reports 未连接 when disconnected", () => {
    expect(connectorStatus(baseConnector()).label).toBe("未连接");
  });

  it("reports 已连接 with the per-kind account count", () => {
    const s = connectorStatus(
      baseConnector({
        connected: true,
        mode: "relay",
        workspaces: [{ team_id: "T1" }, { team_id: "T2" }] as never,
      }),
    );
    expect(s.label).toBe("已连接");
    expect(s.detail).toBe("2 个工作区 · 中继");
    expect(s.tone).toBe("ok");
  });

  it("flags 需要授权 when any account needs reauth", () => {
    const c = baseConnector({
      name: "gmail",
      connected: true,
      accounts: [{ email: "a@b.c", default: true, managed: true, scopes: "", needs_reauth: true }],
    });
    expect(needsReauth(c)).toBe(true);
    const s = connectorStatus(c);
    expect(s.label).toBe("需要授权");
    expect(s.tone).toBe("warn");
    expect(s.detail).toBe("1 个账户");
  });
});

describe("relay health views", () => {
  it("slack: sign-in layer wins over the socket layer", () => {
    expect(
      slackHealthView({
        mode: "relay",
        relay: { state: "live", reconnects: 0, last_event_at: null, last_error: "" },
        signed_in: false,
        teams: {},
      }).tone,
    ).toBe("warn");
    expect(slackHealthView(null).tone).toBe("ok");
    expect(
      slackHealthView({
        mode: "relay",
        relay: { state: "offline", reconnects: 3, last_event_at: null, last_error: "" },
        signed_in: true,
        teams: {},
      }).tone,
    ).toBe("off");
  });

  it("github: reconnecting surfaces as warn", () => {
    expect(
      githubHealthView({
        ok: true,
        mode: "relay",
        relay: { state: "reconnecting", reconnects: 1, last_event_at: null, last_error: "" },
        signed_in: true,
        installs: {},
        missed: {},
      }).tone,
    ).toBe("warn");
  });
});

describe("enabledToolCount", () => {
  it("counts enabled tools", () => {
    const c = baseConnector({
      tools: [
        { name: "a", label: "a", kind: "read", description: "", enabled: true, requires_approval: false },
        { name: "b", label: "b", kind: "write", description: "", enabled: false, requires_approval: true },
      ],
    });
    expect(enabledToolCount(c)).toEqual({ enabled: 1, total: 2 });
  });
});

describe("initials", () => {
  it("builds two-letter initials", () => {
    expect(initials("Rohit Prasad")).toBe("RP");
    expect(initials("madonna")).toBe("MA");
    expect(initials("  ")).toBe("?");
  });
});

describe("mcpStatusView", () => {
  const server = (overrides: Partial<McpServer>): McpServer => ({
    name: "x",
    enabled: true,
    transport: "stdio",
    requires_approval: false,
    status: "configured",
    tool_count: null,
    config: {},
    ...overrides,
  });

  it("maps the status enum", () => {
    expect(mcpStatusView(server({ status: "connected" }))).toEqual({ tone: "ok", label: "已连接" });
    expect(mcpStatusView(server({ status: "authorizing" })).tone).toBe("accent");
    expect(mcpStatusView(server({ status: "needs_auth" })).tone).toBe("warn");
    expect(mcpStatusView(server({ status: "configured" })).label).toBe("未连接");
    expect(mcpStatusView(server({ enabled: false, status: "connected" })).label).toBe("已停用");
    expect(mcpStatusView(server({ status: "disabled" })).label).toBe("已停用");
  });
});

describe("mcpConfigSummary", () => {
  it("joins command + args, or shows the url", () => {
    expect(mcpConfigSummary({ command: "npx", args: ["-y", "@mcp/fs"] })).toBe("npx -y @mcp/fs");
    expect(mcpConfigSummary({ command: "server" })).toBe("server");
    expect(mcpConfigSummary({ type: "http", url: "https://mcp.example.com/mcp" })).toBe(
      "https://mcp.example.com/mcp",
    );
    expect(mcpConfigSummary({})).toBe("");
  });
});

describe("parseArgsText", () => {
  it("treats empty input as no args", () => {
    expect(parseArgsText("")).toEqual({ ok: true, value: [] });
    expect(parseArgsText("  ")).toEqual({ ok: true, value: [] });
  });

  it("parses a JSON string array and rejects other shapes", () => {
    expect(parseArgsText('["-y","pkg"]')).toEqual({ ok: true, value: ["-y", "pkg"] });
    expect(parseArgsText("[oops]").ok).toBe(false);
    expect(parseArgsText("[1]").ok).toBe(false);
    expect(parseArgsText('{"a":1}').ok).toBe(false);
  });
});

describe("parseEnvLines", () => {
  it("parses KEY=VALUE lines, skipping blanks and keeping = in values", () => {
    expect(parseEnvLines("A=1\n\nB=x=y\n")).toEqual({ ok: true, value: { A: "1", B: "x=y" } });
    expect(parseEnvLines("")).toEqual({ ok: true, value: {} });
  });

  it("rejects malformed lines with a line number", () => {
    const result = parseEnvLines("A=1\nnope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("第 2 行");
  });
});

describe("configFromMcpForm", () => {
  it("builds a stdio config with args and env", () => {
    const result = configFromMcpForm({
      name: "fs",
      transport: "stdio",
      command: "npx",
      argsText: '["-y","@mcp/fs"]',
      envText: "ROOT=/tmp",
      url: "",
      oauth: false,
    });
    expect(result).toEqual({
      ok: true,
      value: { command: "npx", args: ["-y", "@mcp/fs"], env: { ROOT: "/tmp" } },
    });
  });

  it("builds an http config, adding auth only when oauth is checked", () => {
    expect(
      configFromMcpForm({ ...blankMcpForm(), name: "g", transport: "http", url: "https://mcp.x.ai/mcp", oauth: true }),
    ).toEqual({ ok: true, value: { type: "http", url: "https://mcp.x.ai/mcp", auth: "oauth" } });
    expect(
      configFromMcpForm({ ...blankMcpForm(), name: "g", transport: "http", url: "https://mcp.x.ai/mcp" }),
    ).toEqual({ ok: true, value: { type: "http", url: "https://mcp.x.ai/mcp" } });
  });

  it("validates required fields", () => {
    expect(configFromMcpForm(blankMcpForm()).ok).toBe(false);
    expect(configFromMcpForm({ ...blankMcpForm(), name: "x" }).ok).toBe(false);
    expect(configFromMcpForm({ ...blankMcpForm(), name: "x", transport: "http", url: "ftp://x" }).ok).toBe(false);
  });
});

describe("editChangesFromMcpForm", () => {
  it("patches stdio config top-level and nulls the http side", () => {
    const result = editChangesFromMcpForm(
      { ...blankMcpForm(), name: "fs", command: "npx", argsText: '["-y"]' },
      false,
    );
    expect(result).toEqual({
      ok: true,
      value: { command: "npx", args: ["-y"], type: null, url: null, auth: null, headers: null },
    });
  });

  it("patches http config top-level, clears oauth when unchecked, nulls stdio side", () => {
    expect(
      editChangesFromMcpForm(
        { ...blankMcpForm(), name: "g", transport: "http", url: "https://mcp.x.ai/mcp" },
        false,
      ),
    ).toEqual({
      ok: true,
      value: { type: "http", url: "https://mcp.x.ai/mcp", auth: null, command: null, args: null },
    });
  });

  it("omits env unless touched — the served config masks stored secrets", () => {
    const form = { ...blankMcpForm(), name: "fs", command: "s", envText: "KEY=***" };
    const untouched = editChangesFromMcpForm(form, false);
    expect(untouched.ok && !("env" in untouched.value)).toBe(true);
  });

  it("rejects a touched env that still carries the *** mask", () => {
    const result = editChangesFromMcpForm(
      { ...blankMcpForm(), name: "fs", command: "s", envText: "KEY=***\nNEW=1" },
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("***");
  });

  it("sends the full env map when touched and mask-free", () => {
    expect(
      editChangesFromMcpForm({ ...blankMcpForm(), name: "fs", command: "s", envText: "A=1" }, true),
    ).toMatchObject({ ok: true, value: { env: { A: "1" } } });
  });
});


describe("mcpFormFromServer", () => {
  it("round-trips a stdio server through the form", () => {
    const server: McpServer = {
      name: "fs",
      enabled: true,
      transport: "stdio",
      requires_approval: false,
      status: "connected",
      tool_count: 3,
      config: { command: "npx", args: ["-y", "@mcp/fs"], env: { ROOT: "/tmp" } },
    };
    const form = mcpFormFromServer(server);
    expect(form).toMatchObject({ name: "fs", transport: "stdio", command: "npx", envText: "ROOT=/tmp" });
    expect(configFromMcpForm(form)).toEqual({ ok: true, value: server.config });
  });

  it("round-trips an oauth http server", () => {
    const server: McpServer = {
      name: "granola",
      enabled: true,
      transport: "http",
      requires_approval: false,
      status: "needs_auth",
      auth: "oauth",
      tool_count: null,
      config: { type: "http", url: "https://mcp.granola.ai/mcp", auth: "oauth" },
    };
    const form = mcpFormFromServer(server);
    expect(form).toMatchObject({ transport: "http", url: "https://mcp.granola.ai/mcp", oauth: true });
    expect(configFromMcpForm(form)).toEqual({ ok: true, value: server.config });
  });
});

describe("splitChannel / channelLabel", () => {
  it("splits platform and target, preferring the resolved name", () => {
    expect(splitChannel("slack:T01/C02")).toEqual({ platform: "slack", target: "C02" });
    expect(splitChannel("github:owner/repo")).toEqual({ platform: "github", target: "repo" });
    expect(splitChannel("C02")).toEqual({ platform: "", target: "C02" });
    expect(channelLabel("slack:T01/C02", "ocw-test")).toBe("#ocw-test");
    expect(channelLabel("slack:T01/C02")).toBe("C02");
  });
});

describe("bindingTargetLabel", () => {
  it("labels platform targets and the in-app inbox", () => {
    expect(bindingTargetLabel({ name: "ops", channel: "slack", target: "C02" })).toBe("Slack · C02");
    expect(bindingTargetLabel({ name: "默认", channel: null, target: "" })).toBe("应用内收件箱");
  });
});

describe("auditTone", () => {
  it("maps statuses to tones", () => {
    expect(auditTone({ status: "error" })).toBe("danger");
    expect(auditTone({ status: "denied" })).toBe("warn");
    expect(auditTone({ status: "interrupted" })).toBe("warn");
    expect(auditTone({ status: "ok" })).toBe("ok");
    expect(auditTone({ status: "approved" })).toBe("ok");
    expect(auditTone({ status: "hidden" })).toBe("off");
    expect(auditTone({ status: "" })).toBe("off");
  });
});

describe("formatAuditArgs", () => {
  it("joins k=v pairs, JSON-encoding non-strings", () => {
    expect(formatAuditArgs({ channel: "C02", limit: 5 })).toBe("channel=C02  limit=5");
    expect(formatAuditArgs({})).toBe("");
  });
});

describe("time formatters", () => {
  it("formats ISO and epoch into MM-DD HH:mm", () => {
    expect(formatTimestamp("2026-08-02T14:33:00Z")).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatEpoch(1785000000)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatEpoch(0)).toBe("");
  });
});

describe("truncate", () => {
  it("clips long strings with an ellipsis", () => {
    expect(truncate("abc", 5)).toBe("abc");
    expect(truncate("abcdef", 5)).toBe("abcd…");
  });
});
