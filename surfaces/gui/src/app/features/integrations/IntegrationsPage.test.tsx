// Smoke tests for the 集成 page wiring: sub-nav switching, the connectors list
// (groups, status tags, monograms), detail open/back, the connect sheet, MCP rows,
// routing groups, and the audit log. Data hooks are mocked; pure logic is covered
// in integrationLogic.test.ts.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connector } from "../../lib/api/types";
import { IntegrationsPage } from "./IntegrationsPage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseConnector = (overrides: Partial<Connector>): Connector => ({
  name: "x",
  title: "X",
  icon: "X",
  blurb: "简介",
  auth: "oauth",
  two_way: false,
  channels: false,
  available: true,
  fields: [],
  instructions: [],
  connected: false,
  account: null,
  enabled: true,
  brand_color: "#611f69",
  logo: "x",
  allowed_users: [],
  tools: [],
  managed: false,
  managed_profile: false,
  ...overrides,
});

const slackRelay = baseConnector({
  name: "slack",
  title: "Slack",
  icon: "#",
  connected: true,
  mode: "relay",
  workspaces: [
    {
      team_id: "T01",
      account: "deeplearning.ai",
      domain: "dlaicore",
      allowed_users: ["U1"],
      allow_all: false,
    },
    { team_id: "T02", account: "acme-partners", allowed_users: [], allow_all: false },
  ],
  tools: [
    {
      name: "slack_send",
      label: "发送消息",
      kind: "write",
      description: "向频道发送消息",
      enabled: true,
      requires_approval: true,
    },
    {
      name: "slack_read",
      label: "读取频道历史",
      kind: "read",
      description: "读取消息",
      enabled: false,
      requires_approval: false,
    },
  ],
});

const gmailReauth = baseConnector({
  name: "gmail",
  title: "Gmail",
  icon: "✉",
  brand_color: "#ea4335",
  connected: true,
  accounts: [
    { email: "team@dl.ai", default: true, managed: true, scopes: "", needs_reauth: true },
  ],
  filters: { senders: ["finance@dl.ai"], labels: [] },
});

const githubAvailable = baseConnector({
  name: "github",
  title: "GitHub",
  icon: "◆",
  brand_color: "#1f2328",
  blurb: "仓库、议题与 PR。",
  fields: [
    {
      key: "token",
      label: "Personal access token",
      secret: true,
      required: true,
      help: "repo + read:org 权限",
      placeholder: "ghp_…",
    },
  ],
  instructions: ["在 GitHub 设置里创建 PAT", "粘贴到下方"],
});

// ---------------------------------------------------------------------------
// Hook mocks
// ---------------------------------------------------------------------------

const connectorsController = (overrides: Record<string, unknown> = {}) => ({
  connectors: [],
  slackStatus: null,
  githubStatus: null,
  loading: false,
  loadError: null,
  actionError: null,
  pendingConnects: new Set<string>(),
  refresh: vi.fn(async () => []),
  connectFields: vi.fn(async () => ({ ok: true })),
  startMcpConnect: vi.fn(async () => ({ ok: true })),
  disconnect: vi.fn(async () => ({ ok: true })),
  disconnectEntry: vi.fn(async () => ({ ok: true })),
  setDefaultEntry: vi.fn(async () => ({ ok: true })),
  saveGmailFilters: vi.fn(async () => ({ ok: true })),
  saveHubSpotHiddenFields: vi.fn(async () => ({ ok: true })),
  toggleTool: vi.fn(async () => ({ ok: true })),
  clearActionError: vi.fn(),
  ...overrides,
});

const mcpController = (overrides: Record<string, unknown> = {}) => ({
  servers: [],
  loading: false,
  loadError: null,
  actionError: null,
  busyNames: new Set<string>(),
  toolsByName: {},
  refresh: vi.fn(async () => []),
  add: vi.fn(async () => ({ ok: true })),
  patch: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
  toggle: vi.fn(async () => ({ ok: true })),
  connect: vi.fn(async () => ({ ok: true })),
  signout: vi.fn(async () => ({ ok: true })),
  reload: vi.fn(async () => ({ ok: true })),
  toggleTools: vi.fn(async () => {}),
  clearActionError: vi.fn(),
  ...overrides,
});

const routingController = (overrides: Record<string, unknown> = {}) => ({
  subscriptions: [],
  recentChannels: [],
  bindings: [],
  dmRoute: null,
  loading: false,
  loadError: null,
  actionError: null,
  refresh: vi.fn(async () => {}),
  subscribe: vi.fn(async () => ({ ok: true })),
  unsubscribe: vi.fn(async () => ({ ok: true })),
  saveBinding: vi.fn(async () => ({ ok: true })),
  setDm: vi.fn(async () => ({ ok: true })),
  clearActionError: vi.fn(),
  ...overrides,
});

let connectorsMock = connectorsController();
let mcpMock = mcpController();
let routingMock = routingController();
let auditData: unknown[] = [];

vi.mock("./useConnectors", () => ({ useConnectors: () => connectorsMock }));
vi.mock("./useMcpServers", () => ({ useMcpServers: () => mcpMock }));
vi.mock("./useRouting", () => ({ useRouting: () => routingMock }));
vi.mock("../../lib/api/sessions", () => ({ getSessions: vi.fn(async () => []) }));
vi.mock("../../lib/api/connectors", () => ({
  getAudit: vi.fn(async () => auditData),
  getSlackChannels: vi.fn(async () => ({ ok: true, channels: [] })),
}));

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IntegrationsPage", () => {
  it("defaults to the 连接器 tab with 已连接 / 未连接 groups and status tags", () => {
    connectorsMock = connectorsController({ connectors: [slackRelay, gmailReauth, githubAvailable] });
    render(<IntegrationsPage />);
    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("未连接")).toBeTruthy();
    expect(screen.getByText("2 个工作区 · 中继")).toBeTruthy();
    expect(screen.getByText("需要授权")).toBeTruthy(); // gmail needs_reauth
    expect(screen.getByText("1 个账户")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
  });

  it("filters the list via the search box", () => {
    connectorsMock = connectorsController({ connectors: [slackRelay, githubAvailable] });
    render(<IntegrationsPage />);
    fireEvent.change(screen.getByPlaceholderText("搜索"), { target: { value: "slack" } });
    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
  });

  it("opens a connector detail with workspace groups and goes back", () => {
    connectorsMock = connectorsController({ connectors: [slackRelay] });
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByText("Slack"));
    expect(screen.getByText("deeplearning.ai")).toBeTruthy();
    expect(screen.getByText("acme-partners")).toBeTruthy();
    expect(screen.getAllByText("断开此工作区").length).toBe(2);
    // Relay workspaces are added via the cloud-managed flow — out of scope here.
    expect(screen.queryByText(/添加工作区/)).toBeNull();
    fireEvent.click(screen.getByText("‹ 连接器"));
    expect(screen.getByText("已连接")).toBeTruthy();
  });

  it("toggles a connector tool from the detail's 工具 disclosure", () => {
    const toggleTool = vi.fn(async () => ({ ok: true }));
    connectorsMock = connectorsController({ connectors: [slackRelay], toggleTool });
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByText("Slack"));
    // The disclosure content lives in the DOM even while collapsed.
    const checkbox = screen.getByTitle("slack_send — 向频道发送消息").querySelector("input");
    expect(checkbox).toBeTruthy();
    fireEvent.click(checkbox!);
    expect(toggleTool).toHaveBeenCalledWith("slack", "slack_send", false);
  });

  it("opens the connect sheet from an available row and submits manual fields", () => {
    const connectFields = vi.fn(async () => ({ ok: true }));
    connectorsMock = connectorsController({ connectors: [githubAvailable], connectFields });
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByText("连接"));
    const dialog = screen.getByRole("dialog", { name: "连接 GitHub" });
    fireEvent.change(within(dialog).getByPlaceholderText("ghp_…"), { target: { value: "ghp_secret" } });
    fireEvent.click(within(dialog).getByText("连接"));
    expect(connectFields).toHaveBeenCalledWith("github", { token: "ghp_secret" }, false);
  });

  it("shows Gmail privacy filters inside the detail", () => {
    connectorsMock = connectorsController({ connectors: [gmailReauth] });
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByText("Gmail"));
    expect(screen.getByText("team@dl.ai")).toBeTruthy();
    expect(screen.getByText("不对 Agent 展示")).toBeTruthy();
    expect(screen.getByText("finance@dl.ai")).toBeTruthy();
    expect(screen.getByText("需要重新授权")).toBeTruthy();
  });

  it("switches to the MCP tab, renders rows and starts OAuth connect", () => {
    const connect = vi.fn(async () => ({ ok: true }));
    mcpMock = mcpController({
      connect,
      servers: [
        {
          name: "granola",
          enabled: true,
          transport: "http",
          requires_approval: false,
          status: "needs_auth",
          auth: "oauth",
          tool_count: null,
          config: { type: "http", url: "https://mcp.granola.ai/mcp", auth: "oauth" },
        },
        {
          name: "fs",
          enabled: true,
          transport: "stdio",
          requires_approval: false,
          status: "connected",
          tool_count: 3,
          config: { command: "npx", args: ["-y", "@mcp/fs"] },
        },
      ],
    });
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByTestId("integrations-tab-mcp"));
    expect(screen.getByText("granola")).toBeTruthy();
    expect(screen.getByText("npx -y @mcp/fs")).toBeTruthy();
    expect(screen.getByText("3 工具")).toBeTruthy();
    expect(screen.getByText("已连接")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mcp-connect-granola"));
    expect(connect).toHaveBeenCalledWith("granola");
  });

  it("switches to 消息路由 and renders subscriptions, bindings and the DM row", () => {
    routingMock = routingController({
      subscriptions: [
        {
          session_id: "s1",
          session_title: "值班",
          agent: "main",
          channel: "slack:T01/C01",
          channel_name: "ocw-test",
          routing_target: null,
          collision: false,
        },
      ],
      recentChannels: [
        { channel: "slack:T01/C01", name: "ocw-test", last_from: "rohit", last_text: "hello" },
      ],
      bindings: [{ name: "默认", channel: "slack", target: "T01/C02" }],
    });
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByTestId("integrations-tab-routing"));
    expect(screen.getByText("值班")).toBeTruthy();
    expect(screen.getAllByText("#ocw-test").length).toBeGreaterThan(0);
    expect(screen.getByText("Slack · T01/C02")).toBeTruthy();
    expect(screen.getByText(/未指定默认会话/)).toBeTruthy();
  });

  it("opens the MCP editor from a server row and patches top-level changes", async () => {
    const patch = vi.fn(async () => ({ ok: true }));
    mcpMock = mcpController({
      patch,
      servers: [
        {
          name: "fs",
          enabled: true,
          transport: "stdio",
          requires_approval: false,
          status: "connected",
          tool_count: 3,
          config: { command: "npx", args: ["-y", "@mcp/fs"], env: { ROOT: "***" } },
        },
      ],
    });
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByTestId("integrations-tab-mcp"));
    fireEvent.click(screen.getByText("fs"));
    // Edit mode: the name is the record key and stays fixed.
    expect((screen.getByDisplayValue("fs") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    // Top-level merge keys — never a nested `config`; untouched masked env omitted.
    expect(patch).toHaveBeenCalledWith("fs", {
      command: "npx",
      args: ["-y", "@mcp/fs"],
      type: null,
      url: null,
      auth: null,
      headers: null,
    });
  });

  it("switches to 审计 and renders the log rows", async () => {
    auditData = [
      {
        id: 1,
        timestamp: "2026-08-02T14:33:00Z",
        session_id: "s1",
        agent: "main",
        workspace: "/w",
        connector: "slack",
        tool: "slack_send",
        stage: "finished",
        status: "ok",
        approval: "ask",
        args: { channel: "C01" },
        result_preview: "",
        reason: "",
        resource: "#ocw-test",
      },
    ];
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByTestId("integrations-tab-audit"));
    expect(await screen.findByText("slack_send")).toBeTruthy();
    expect(screen.getByText("#ocw-test")).toBeTruthy();
    expect(screen.getByText("ok")).toBeTruthy();
    auditData = [];
  });
});
