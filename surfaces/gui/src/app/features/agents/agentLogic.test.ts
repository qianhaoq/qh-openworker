import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../../lib/api/types";
import {
  AGENT_PRESETS,
  agentInfoLine,
  applyRoleToDraft,
  blankProfile,
  canEnable,
  canSetMain,
  capabilityBadges,
  commandSummary,
  hasUsableExecutor,
  isProfileUsable,
  parseArgsJson,
  parseSecretRefs,
  presetCommandName,
  profileFromPreset,
  probeView,
  uniqueProfileId,
  unusableProfileIds,
  validateProfile,
} from "./agentLogic";

const preset = (key: string) => {
  const found = AGENT_PRESETS.find((p) => p.key === key);
  if (!found) throw new Error(`missing preset ${key}`);
  return found;
};

const probed = (profile: AgentProfile): AgentProfile => ({
  ...profile,
  capabilities: { agentCapabilities: { loadSession: true } },
  capability_probe_fingerprint: "abc123",
});

describe("parseArgsJson", () => {
  it("treats empty input as no args", () => {
    expect(parseArgsJson("")).toEqual({ ok: true, args: [] });
    expect(parseArgsJson("   ")).toEqual({ ok: true, args: [] });
  });

  it("parses a string array", () => {
    expect(parseArgsJson('["acp"]')).toEqual({ ok: true, args: ["acp"] });
    expect(parseArgsJson('["--mode", "rpc"]')).toEqual({ ok: true, args: ["--mode", "rpc"] });
  });

  it("rejects invalid JSON", () => {
    const result = parseArgsJson("[acp]");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("JSON");
  });

  it("rejects non-arrays and non-string items", () => {
    expect(parseArgsJson('{"a":1}').ok).toBe(false);
    expect(parseArgsJson('["acp", 1]').ok).toBe(false);
    expect(parseArgsJson('"acp"').ok).toBe(false);
  });
});

describe("parseSecretRefs", () => {
  it("splits on commas and whitespace, dropping empties", () => {
    expect(parseSecretRefs("KIMI_API_KEY, GITHUB_TOKEN")).toEqual(["KIMI_API_KEY", "GITHUB_TOKEN"]);
    expect(parseSecretRefs(" A  B\nC,,D ")).toEqual(["A", "B", "C", "D"]);
    expect(parseSecretRefs("")).toEqual([]);
  });
});

describe("uniqueProfileId", () => {
  it("keeps the base when free, suffixes when taken", () => {
    expect(uniqueProfileId("kimi-main", new Set())).toBe("kimi-main");
    expect(uniqueProfileId("kimi-main", new Set(["kimi-main"]))).toBe("kimi-main-2");
    expect(uniqueProfileId("kimi-main", new Set(["kimi-main", "kimi-main-2"]))).toBe("kimi-main-3");
  });

  it("falls back to a generic base for blank input", () => {
    expect(uniqueProfileId("  ", new Set())).toBe("agent");
  });
});

describe("profileFromPreset", () => {
  it("maps presets to disabled, unprobed drafts with preset command/args/role", () => {
    const profile = profileFromPreset(preset("opencode"), new Set());
    expect(profile).toMatchObject({
      id: "opencode-executor",
      role: "executor",
      transport: "acp_stdio",
      command: "opencode",
      args: ["acp"],
      enabled: false,
      capabilities: {},
      capability_probe_fingerprint: null,
    });
  });

  it("pins read-only policies for read-only preset roles", () => {
    const profile = profileFromPreset(preset("custom"), new Set()); // explorer
    expect(profile.workspace_policy).toBe("readonly");
    expect(profile.permission_policy).toBe("read-only");
  });

  it("marks the Pi preset experimental with the jsonl transport", () => {
    const pi = preset("pi");
    expect(pi.experimental).toBe(true);
    const profile = profileFromPreset(pi, new Set());
    expect(profile.transport).toBe("jsonl_rpc");
    expect(profile.args).toEqual(["--mode", "rpc"]);
  });

  it("avoids id collisions against the existing list", () => {
    const first = profileFromPreset(preset("kimi"), new Set(["kimi-main"]));
    expect(first.id).toBe("kimi-main-2");
  });

  it("does not share the preset's args array", () => {
    const opencode = preset("opencode");
    const profile = profileFromPreset(opencode, new Set());
    profile.args.push("mutated");
    expect(opencode.args).toEqual(["acp"]);
  });

  it("maps the Claude Code / Codex / Gemini subscription presets to main-role ACP drafts", () => {
    const claude = profileFromPreset(preset("claude-code"), new Set());
    expect(claude).toMatchObject({
      id: "claude-code-main",
      role: "main",
      transport: "acp_stdio",
      command: "npx",
      args: ["-y", "@zed-industries/claude-code-acp"],
      workspace_policy: "worktree",
      permission_policy: "coding-default",
      enabled: false,
    });

    const codex = profileFromPreset(preset("codex"), new Set());
    expect(codex).toMatchObject({
      id: "codex-main",
      command: "npx",
      args: ["-y", "@zed-industries/codex-acp", "-c", 'model="gpt-5.5"'],
    });

    const gemini = profileFromPreset(preset("gemini"), new Set());
    expect(gemini).toMatchObject({
      id: "gemini-main",
      command: "gemini",
      args: ["--experimental-acp"],
    });
  });
});

describe("presetCommandName", () => {
  it("takes the command's first word for PATH detection", () => {
    expect(presetCommandName(preset("claude-code"))).toBe("npx");
    expect(presetCommandName(preset("codex"))).toBe("npx");
    expect(presetCommandName(preset("gemini"))).toBe("gemini");
    expect(presetCommandName(preset("opencode"))).toBe("opencode");
  });
});

describe("applyRoleToDraft", () => {
  it("pins readonly policies and drops secrets for reviewer", () => {
    const draft = { ...blankProfile(new Set()), secret_refs: ["KEY"] };
    const next = applyRoleToDraft(draft, "reviewer");
    expect(next.workspace_policy).toBe("readonly");
    expect(next.permission_policy).toBe("read-only");
    expect(next.secret_refs).toEqual([]);
  });

  it("restores writable defaults when leaving a read-only role", () => {
    const readonly = applyRoleToDraft(blankProfile(new Set()), "explorer");
    const writable = applyRoleToDraft(readonly, "executor");
    expect(writable.workspace_policy).toBe("worktree");
    expect(writable.permission_policy).toBe("coding-default");
  });

  it("keeps an explicitly chosen writable policy when leaving a read-only role", () => {
    const readonly = applyRoleToDraft(blankProfile(new Set()), "explorer");
    const custom = { ...readonly, workspace_policy: "workspace" }; // can't happen via UI, but stay lossless
    expect(applyRoleToDraft(custom, "executor").workspace_policy).toBe("workspace");
  });
});

describe("validateProfile", () => {
  const draft = blankProfile(new Set());

  it("requires id and command", () => {
    expect(validateProfile({ ...draft, id: " " }, new Set(), null)).toContain("ID");
    expect(validateProfile({ ...draft, command: "" }, new Set(), null)).toContain("Command");
    expect(validateProfile({ ...draft, command: "kimi" }, new Set(), null)).toBeNull();
  });

  it("rejects duplicate ids except the profile being edited", () => {
    const existing = new Set(["kimi-main"]);
    expect(validateProfile({ ...draft, id: "kimi-main", command: "kimi" }, existing, null)).toContain("已存在");
    expect(validateProfile({ ...draft, id: "kimi-main", command: "kimi" }, existing, "kimi-main")).toBeNull();
  });

  it("enforces reviewer constraints the backend checks", () => {
    const reviewer = applyRoleToDraft({ ...draft, command: "kimi" }, "reviewer");
    expect(validateProfile(reviewer, new Set(), null)).toBeNull();
    expect(
      validateProfile({ ...reviewer, permission_policy: "coding-default" }, new Set(), null),
    ).toContain("只读");
    expect(validateProfile({ ...reviewer, secret_refs: ["KEY"] }, new Set(), null)).toContain("secret");
  });
});

describe("capabilityBadges", () => {
  it("derives badges from the ACP InitializeResponse shape", () => {
    const caps = {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
      },
      agentInfo: { name: "kimi", title: "Kimi CLI", version: "0.3.0" },
    };
    expect(capabilityBadges(caps)).toEqual(["loadSession", "image", "context", "MCP"]);
  });

  it("tolerates snake_case keys", () => {
    const caps = {
      agent_capabilities: { load_session: true, prompt_capabilities: { image: true } },
    };
    expect(capabilityBadges(caps)).toEqual(["loadSession", "image"]);
  });

  it("marks jsonl_rpc probes with the state badge", () => {
    expect(capabilityBadges({ transport: "jsonl_rpc", state: "ready" })).toEqual(["state"]);
  });

  it("returns no badges for empty or false-y capabilities", () => {
    expect(capabilityBadges({})).toEqual([]);
    expect(
      capabilityBadges({ agentCapabilities: { loadSession: false, promptCapabilities: { image: false } } }),
    ).toEqual([]);
  });
});

describe("agentInfoLine", () => {
  it("prefers title + version", () => {
    expect(
      agentInfoLine({ agentInfo: { name: "kimi", title: "Kimi CLI", version: "0.3.0" } }),
    ).toBe("Kimi CLI v0.3.0");
  });

  it("falls back to name, and null when absent", () => {
    expect(agentInfoLine({ agentInfo: { name: "pi" } })).toBe("pi");
    expect(agentInfoLine({})).toBeNull();
  });
});

describe("probeView / canEnable / canSetMain", () => {
  const draft = blankProfile(new Set());

  it("reports unprobed without a stored fingerprint", () => {
    expect(probeView(draft, false)).toBe("unprobed");
    expect(probeView({ ...draft, capability_probe_fingerprint: "x" }, false)).toBe("unprobed");
  });

  it("reports probed only with fingerprint and capabilities", () => {
    expect(probeView(probed(draft), false)).toBe("probed");
  });

  it("in-flight probing and failures win over the stored state", () => {
    expect(probeView(probed(draft), true)).toBe("probing");
    expect(probeView(probed(draft), false, "spawn failed")).toBe("failed");
  });

  it("gates enable on a current probe for disabled profiles", () => {
    expect(canEnable(probed(draft), "probed")).toBe(true);
    expect(canEnable(draft, "unprobed")).toBe(false);
    expect(canEnable({ ...probed(draft), enabled: true }, "probed")).toBe(false);
  });

  it("gates 设为主 on enabled role=main", () => {
    expect(canSetMain({ ...probed(draft), enabled: true })).toBe(true);
    expect(canSetMain(probed(draft))).toBe(false);
    expect(canSetMain({ ...probed(draft), enabled: true, role: "executor" })).toBe(false);
  });
});

describe("commandSummary", () => {
  it("joins command and args", () => {
    expect(commandSummary({ command: "kimi", args: ["acp"] })).toBe("kimi acp");
    expect(commandSummary({ command: "pi", args: [] })).toBe("pi");
  });
});

describe("isProfileUsable / hasUsableExecutor / unusableProfileIds", () => {
  const draft = blankProfile(new Set());
  const usable = { ...probed(draft), id: "opencode-executor", role: "executor" as const, enabled: true };

  it("requires enabled AND a current stored probe", () => {
    expect(isProfileUsable(usable)).toBe(true);
    expect(isProfileUsable({ ...usable, enabled: false })).toBe(false);
    expect(isProfileUsable({ ...usable, capability_probe_fingerprint: null })).toBe(false);
    expect(isProfileUsable({ ...usable, capabilities: {} })).toBe(false);
  });

  it("detects a usable executor seat", () => {
    expect(hasUsableExecutor([usable])).toBe(true);
    expect(hasUsableExecutor([{ ...usable, enabled: false }])).toBe(false);
    expect(hasUsableExecutor([{ ...usable, role: "reviewer" }])).toBe(false);
    expect(hasUsableExecutor([])).toBe(false);
  });

  it("lists unknown, disabled and unprobed seat profiles", () => {
    expect(unusableProfileIds(["opencode-executor", "ghost", "kimi-main"], [usable])).toEqual([
      "ghost",
      "kimi-main",
    ]);
    expect(unusableProfileIds([], [usable])).toEqual([]);
  });
});
