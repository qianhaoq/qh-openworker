import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile } from "../../lib/api/types";
import { AgentEditor } from "./AgentEditor";

const draft: AgentProfile = {
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
  enabled: false,
  capabilities: {},
  capability_probe_fingerprint: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AgentEditor", () => {
  it("saves a disabled draft before activation and keeps it unavailable when activation fails", async () => {
    const save = vi.fn(async () => ({ ok: true }));
    const activate = vi.fn(async () => ({ ok: false, error: "spawn kimi failed" }));

    render(
      <AgentEditor
        initial={draft}
        originalId={null}
        current={null}
        existingIds={new Set()}
        mainProfileId={null}
        probing={false}
        busy={false}
        onSave={save}
        onActivate={activate}
        onSetEnabled={vi.fn(async () => ({ ok: true }))}
        onSetMain={vi.fn(async () => ({ ok: true }))}
        onDelete={vi.fn(async () => ({ ok: true }))}
        onSaved={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("添加并测试"));

    await waitFor(() => expect(activate).toHaveBeenCalledWith("kimi-main"));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "kimi-main", enabled: false }));
    expect(screen.getByRole("alert").textContent).toContain("spawn kimi failed");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });
});
