import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Readiness } from "../../lib/api/types";
import { MissionsPage } from "./MissionsPage";

const ready: Readiness = {
  model_ready: false,
  workspace: "/repo",
  workspace_valid: true,
  main_agent: "ready",
  main_profile: null,
  can_create_mission: true,
  next_action: "create_mission",
};

let readinessValue = ready;
const create = vi.fn(async () => ({ mission_id: "m-1" }));

vi.mock("./useMissions", () => ({
  useMissions: () => ({
    missions: [],
    loading: false,
    loadError: null,
    creating: false,
    planningOutput: "",
    refresh: vi.fn(async () => {}),
    create,
  }),
}));

vi.mock("../../lib/api/sessions", () => ({
  getRecentWorkspaces: vi.fn(async () => [{ path: "/repo", name: "repo", exists: true }]),
  openWorkspace: vi.fn(async (path: string) => ({ ok: true, path })),
  pickFolderViaServer: vi.fn(async () => "/repo"),
}));

vi.mock("../../lib/api/settings", () => ({
  getReadiness: vi.fn(async () => readinessValue),
}));

afterEach(() => {
  cleanup();
  readinessValue = ready;
  create.mockClear();
  window.location.hash = "";
});

describe("MissionsPage create drawer", () => {
  it("uses the drawer dialog and allows creation when ACP readiness is true even if model_ready is false", async () => {
    render(<MissionsPage />);
    fireEvent.click(screen.getAllByText("新建 Mission")[0]);
    expect(screen.getByRole("dialog", { name: "新建 Mission" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("mission-readiness-notice")).toBeNull());
    fireEvent.change(screen.getByLabelText("目标"), { target: { value: "修复登录页" } });
    fireEvent.click(screen.getByText("创建 Mission"));
    await waitFor(() => expect(create).toHaveBeenCalledWith("修复登录页", "/repo"));
  });

  it("shows the unified main-Agent repair entry when readiness is blocked", async () => {
    readinessValue = {
      ...ready,
      main_agent: "missing",
      can_create_mission: false,
      next_action: "select_main_agent",
    };
    render(<MissionsPage />);
    fireEvent.click(screen.getAllByText("新建 Mission")[0]);
    await waitFor(() => expect(screen.getByTestId("mission-readiness-notice")).toBeTruthy());
    expect(screen.getByText("当前 workspace 缺少 main Agent。")).toBeTruthy();
    expect(screen.queryByText(/executor|ACP|transport/i)).toBeNull();
  });
});
