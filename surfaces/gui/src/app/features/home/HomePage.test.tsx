import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateAgentProfile, detectAgentCommands, upsertAgentProfile } from "../../lib/api/agents";
import type { Readiness } from "../../lib/api/types";
import { HomePage } from "./HomePage";

const readiness = (patch: Partial<Readiness>): Readiness => ({
  model_ready: false,
  workspace: "/repo",
  workspace_valid: true,
  main_agent: "ready",
  main_profile: null,
  can_create_mission: true,
  next_action: "create_mission",
  ...patch,
});

let readinessValue = readiness({});

vi.mock("../../lib/api/agents", () => ({
  listAgentPermissions: vi.fn(async () => []),
  listAgentProfiles: vi.fn(async () => []),
  detectAgentCommands: vi.fn(async () => ({ results: { kimi: true } })),
  upsertAgentProfile: vi.fn(async () => ({ ok: true })),
  activateAgentProfile: vi.fn(async () => ({ ok: true })),
  setWorkspaceMainAgent: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../lib/api/automations", () => ({
  getAutomations: vi.fn(async () => []),
}));

vi.mock("../../lib/api/inbox", () => ({
  getInbox: vi.fn(async () => []),
}));

vi.mock("../../lib/api/missions", () => ({
  listMissions: vi.fn(async () => []),
}));

vi.mock("../../lib/api/sessions", () => ({
  getSessions: vi.fn(async () => []),
  openWorkspace: vi.fn(async (path: string) => ({ ok: true, path })),
  pickFolderViaServer: vi.fn(async () => "/repo"),
}));

vi.mock("../../lib/api/settings", () => ({
  getReadiness: vi.fn(async () => readinessValue),
  getSettings: vi.fn(async () => ({ onboarded: false })),
  setOnboarded: vi.fn(async () => ({ ok: true, onboarded: true })),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  readinessValue = readiness({});
});

describe("HomePage readiness", () => {
  it("shows only one setup next_action before the workspace is ready", async () => {
    readinessValue = readiness({
      workspace: "",
      workspace_valid: false,
      main_agent: "missing",
      can_create_mission: false,
      next_action: "choose_workspace",
    });
    render(<HomePage sessions={[]} />);
    await waitFor(() => expect(screen.getByTestId("home-next-action")).toBeTruthy());
    expect(screen.getAllByText("添加 workspace")).toHaveLength(2);
    expect(screen.queryByTestId("home-card-missions")).toBeNull();
    expect(screen.queryByText("开始新会话")).toBeNull();
  });

  it("does not treat model_ready=false as blocking ACP mission readiness", async () => {
    readinessValue = readiness({ model_ready: false, can_create_mission: true });
    render(<HomePage sessions={[]} />);
    await waitFor(() => expect(screen.queryByTestId("home-next-action")).toBeNull());
    expect(screen.getByTestId("home-card-missions")).toBeTruthy();
    expect(screen.getByText("创建 Mission")).toBeTruthy();
    expect(screen.getByText("配置快速对话模型")).toBeTruthy();
  });

  it("persists an explicit later choice without pretending Mission is ready", async () => {
    readinessValue = readiness({
      workspace: "",
      workspace_valid: false,
      main_agent: "missing",
      can_create_mission: false,
      next_action: "choose_workspace",
    });
    render(<HomePage sessions={[]} />);
    await waitFor(() => expect(screen.getByTestId("home-next-action")).toBeTruthy());
    fireEvent.click(screen.getByText("稍后"));
    await waitFor(() => expect(screen.queryByTestId("home-next-action")).toBeNull());
    expect(screen.getByText(/Mission 尚未就绪/)).toBeTruthy();
    expect(screen.getByTestId("home-card-missions")).toBeTruthy();
  });

  it("activates the already-bound main profile without replacing it with Kimi", async () => {
    readinessValue = readiness({
      main_agent: "unverified",
      can_create_mission: false,
      next_action: "activate_main_agent",
      main_profile: {
        id: "existing-main",
        role: "main",
        transport: "acp_stdio",
        command: "opencode",
        args: ["acp"],
        workspace_policy: "worktree",
        permission_policy: "coding-default",
        secret_refs: [],
        limits: {},
        enabled: false,
        capabilities: {},
      },
    });
    render(<HomePage sessions={[]} />);
    const action = await screen.findByRole("button", { name: "添加并激活 main Agent" });
    fireEvent.click(action);
    await waitFor(() =>
      expect(activateAgentProfile).toHaveBeenCalledWith("existing-main", "/repo"),
    );
    expect(detectAgentCommands).not.toHaveBeenCalled();
    expect(upsertAgentProfile).not.toHaveBeenCalled();
  });
});
