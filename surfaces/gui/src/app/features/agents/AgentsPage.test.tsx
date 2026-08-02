// Smoke tests for the Agents page wiring: empty state → preset add, list rows (badges,
// probe states, main marker, enable gating), editor open, inline delete confirm. The
// data hook is mocked; the pure logic is covered in agentLogic.test.ts.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../../lib/api/types";
import { AgentsPage } from "./AgentsPage";

const base: AgentProfile = {
  id: "kimi-main",
  role: "main",
  transport: "acp_stdio",
  command: "kimi",
  args: ["acp"],
  model_profile: "kimi-code/k3",
  workspace_policy: "worktree",
  permission_policy: "coding-default",
  secret_refs: [],
  limits: {},
  enabled: true,
  capabilities: {
    agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
    agentInfo: { name: "kimi", title: "Kimi CLI", version: "0.3.0" },
  },
  capability_probe_fingerprint: "fp",
};

const unprobed: AgentProfile = {
  ...base,
  id: "pi-executor",
  role: "executor",
  transport: "jsonl_rpc",
  command: "pi",
  args: ["--mode", "rpc"],
  enabled: false,
  capabilities: {},
  capability_probe_fingerprint: null,
};

interface MockController {
  profiles: AgentProfile[];
  mainProfileId: string | null;
  loading: boolean;
  loadError: string | null;
  probingIds: ReadonlySet<string>;
  probeErrors: Record<string, string>;
  busyIds: ReadonlySet<string>;
  refresh: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  probe: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  setMain: ReturnType<typeof vi.fn>;
}

const controller = (overrides: Partial<MockController> = {}): MockController => ({
  profiles: [],
  mainProfileId: null,
  loading: false,
  loadError: null,
  probingIds: new Set(),
  probeErrors: {},
  busyIds: new Set(),
  refresh: vi.fn(async () => {}),
  save: vi.fn(async () => ({ ok: true })),
  probe: vi.fn(async () => ({ ok: true })),
  setEnabled: vi.fn(async () => ({ ok: true })),
  remove: vi.fn(async () => ({ ok: true })),
  setMain: vi.fn(async () => ({ ok: true })),
  ...overrides,
});

let mock = controller();

vi.mock("./useAgentProfiles", () => ({
  useAgentProfiles: () => mock,
}));

afterEach(cleanup);

describe("AgentsPage", () => {
  it("shows the recruit empty state with preset shortcuts when there are no profiles", () => {
    mock = controller();
    render(<AgentsPage />);
    expect(screen.getByText("招募你的第一个本地 agent")).toBeTruthy();
    expect(screen.getByText("OpenCode ACP")).toBeTruthy();
    expect(screen.getByText("Kimi ACP")).toBeTruthy();
    expect(screen.getByText("实验性")).toBeTruthy(); // Pi preset badge
  });

  it("renders rows with main marker, capability badges and probe states", () => {
    mock = controller({
      profiles: [base, unprobed],
      mainProfileId: "kimi-main",
      probeErrors: { "pi-executor": "spawn pi: command not found" },
    });
    render(<AgentsPage />);
    expect(screen.getByText("主 Agent")).toBeTruthy();
    expect(screen.getByText("loadSession")).toBeTruthy();
    expect(screen.getByText("kimi acp")).toBeTruthy();
    expect(screen.getByText("探测失败")).toBeTruthy();
    expect(screen.getByText("spawn pi: command not found")).toBeTruthy();
    // Enable gating: the unprobed profile's toggle is disabled, the probed+enabled one is on.
    const toggles = screen.getAllByRole("switch");
    expect(toggles.map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect((toggles[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the preset picker from the header action", () => {
    mock = controller({ profiles: [base], mainProfileId: "kimi-main" });
    render(<AgentsPage />);
    fireEvent.click(screen.getByText("招募 Agent"));
    expect(screen.getByText("空白自定义")).toBeTruthy();
    expect(screen.getByText("Custom ACP stdio")).toBeTruthy();
  });

  it("opens the editor on row click and confirms delete inline", () => {
    mock = controller({ profiles: [base], mainProfileId: "kimi-main" });
    render(<AgentsPage />);
    fireEvent.click(screen.getByText("kimi-main"));
    expect(screen.getByText("当前主 Agent")).toBeTruthy(); // already-main state
    expect(screen.getByText("Kimi CLI v0.3.0")).toBeTruthy(); // probed agentInfo
    fireEvent.click(screen.getByText("删除"));
    expect(screen.getByText("确认删除")).toBeTruthy();
  });

  it("surfaces a load error with a retry", () => {
    mock = controller({ loadError: "Network request failed" });
    render(<AgentsPage />);
    expect(screen.getByText("Network request failed")).toBeTruthy();
    fireEvent.click(screen.getByText("重试"));
    expect(mock.refresh).toHaveBeenCalled();
  });
});
