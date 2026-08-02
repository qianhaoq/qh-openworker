import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../../lib/api/types";
import {
  agentChoiceKey,
  agentChoiceLabel,
  defaultAgentChoice,
  loadAgentChoice,
  resolveAgentChoice,
  saveAgentChoice,
  selectableProfiles,
} from "./agentChoice";

// Minimal Storage stand-in (jsdom's localStorage works too, but an in-memory map keeps
// each test hermetic without cleanup).
const fakeStorage = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
};

const usableProfile = (id: string): AgentProfile => ({
  id,
  role: "main",
  transport: "acp_stdio",
  command: "kimi",
  args: ["acp"],
  workspace_policy: "worktree",
  permission_policy: "coding-default",
  secret_refs: [],
  limits: {},
  enabled: true,
  capabilities: { agentCapabilities: { loadSession: true } },
  capability_probe_fingerprint: `fp-${id}`,
});

describe("loadAgentChoice", () => {
  it("returns null when nothing is stored", () => {
    expect(loadAgentChoice("s1", fakeStorage())).toBeNull();
  });

  it("reads the stored selection", () => {
    const storage = fakeStorage({ [agentChoiceKey("s1")]: "kimi-main" });
    expect(loadAgentChoice("s1", storage)).toBe("kimi-main");
  });

  it("migrates the legacy acp runtime key to the ACP workspace-main selection", () => {
    const storage = fakeStorage({ "assistant:runtime:s1": "acp" });
    expect(loadAgentChoice("s1", storage)).toBe("acp");
    // The old key is gone; the new key carries the migrated value.
    expect(storage.map.has("assistant:runtime:s1")).toBe(false);
    expect(storage.map.get(agentChoiceKey("s1"))).toBe("acp");
  });

  it("migrates the legacy embedded runtime key", () => {
    const storage = fakeStorage({ "assistant:runtime:s1": "embedded" });
    expect(loadAgentChoice("s1", storage)).toBe("embedded");
    expect(storage.map.has("assistant:runtime:s1")).toBe(false);
  });

  it("prefers the new key over a stale legacy key", () => {
    const storage = fakeStorage({
      [agentChoiceKey("s1")]: "kimi-main",
      "assistant:runtime:s1": "embedded",
    });
    expect(loadAgentChoice("s1", storage)).toBe("kimi-main");
  });

  it("round-trips a saved profile selection", () => {
    const storage = fakeStorage();
    saveAgentChoice("s1", "codex-main", storage);
    expect(loadAgentChoice("s1", storage)).toBe("codex-main");
  });
});

describe("defaultAgentChoice", () => {
  it("keeps the code agent on the ACP workspace main, others embedded", () => {
    expect(defaultAgentChoice("code")).toBe("acp");
    expect(defaultAgentChoice("cowork")).toBe("embedded");
  });
});

describe("resolveAgentChoice", () => {
  it("maps the selection onto socket options", () => {
    expect(resolveAgentChoice("embedded")).toEqual({ runtime: "embedded" });
    expect(resolveAgentChoice("acp")).toEqual({ runtime: "acp" });
    expect(resolveAgentChoice("kimi-main")).toEqual({ runtime: "acp", profileId: "kimi-main" });
  });
});

describe("agentChoiceLabel", () => {
  it("labels the pill", () => {
    expect(agentChoiceLabel("embedded")).toBe("内置助理");
    expect(agentChoiceLabel("acp")).toBe("ACP");
    expect(agentChoiceLabel("kimi-main")).toBe("kimi-main");
  });
});

describe("selectableProfiles", () => {
  it("keeps only enabled + currently-probed profiles", () => {
    const disabled = { ...usableProfile("disabled-main"), enabled: false };
    const unprobed = { ...usableProfile("unprobed-main"), capability_probe_fingerprint: null };
    const stale = { ...usableProfile("stale-main"), capabilities: {} };
    const list = selectableProfiles([usableProfile("kimi-main"), disabled, unprobed, stale]);
    expect(list.map((p) => p.id)).toEqual(["kimi-main"]);
  });

  it("returns an empty list when nothing is usable (the menu's recruit-link state)", () => {
    expect(selectableProfiles([])).toEqual([]);
    expect(selectableProfiles([{ ...usableProfile("x"), enabled: false }])).toEqual([]);
  });
});
