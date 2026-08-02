import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./lib/ws", () => ({
  connectEvents: vi.fn(() => () => {}),
}));

vi.mock("./lib/api/inbox", () => ({
  getInbox: vi.fn(async () => []),
}));

vi.mock("./lib/api/agents", () => ({
  listAgentPermissions: vi.fn(async () => []),
}));

vi.mock("./features/home/HomePage", () => ({
  HomePage: () => <div>Home mock</div>,
}));

vi.mock("./features/assistant/AssistantPage", () => ({
  AssistantPage: () => <div>Assistant mock</div>,
}));

vi.mock("./features/agents/AgentsPage", () => ({
  AgentsPage: () => <div>Agents mock</div>,
}));

vi.mock("./features/missions/MissionsPage", () => ({
  MissionsPage: () => <div>Missions mock</div>,
}));

vi.mock("./features/inbox/InboxPage", () => ({
  InboxPage: () => <div>Inbox mock</div>,
}));

vi.mock("./features/automations/AutomationsPage", () => ({
  AutomationsPage: () => <div>Automations mock</div>,
}));

vi.mock("./features/integrations/IntegrationsPage", () => ({
  IntegrationsPage: () => <div>Integrations mock</div>,
}));

vi.mock("./features/settings/SettingsPage", () => ({
  SettingsPage: () => <div>Settings mock</div>,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = "";
});

describe("App shell", () => {
  it("persists the sidebar collapsed preference", async () => {
    render(<App />);
    expect(screen.getByText("Home mock")).toBeTruthy();
    fireEvent.click(screen.getByTitle("收起侧栏"));
    await waitFor(() => expect(localStorage.getItem("ocw.sidebar.collapsed")).toBe("true"));
  });
});
