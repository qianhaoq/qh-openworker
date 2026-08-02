import { describe, expect, it } from "vitest";
import type { AgentPermission, InboxItem } from "../../lib/api/types";
import {
  argsPreview,
  approvalResolution,
  canAlwaysTask,
  directoryResolution,
  formatAge,
  itemSummary,
  kindMeta,
  pendingView,
  permissionOptionId,
  permissionOptionIsDeny,
  permissionOptionLabel,
  permissionToolDetail,
  permissionToolName,
  planResolution,
  questionResolution,
  resolutionText,
  resolvedView,
  sessionLabel,
} from "./inboxLogic";

const NOW = new Date("2026-08-01T12:00:00Z").getTime();

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "item-1",
    session_id: "sess-1",
    kind: "approval",
    title: "Run `run_shell`?",
    body: "",
    state: "pending",
    resolution: null,
    inbox: "default",
    created_at: "2026-08-01T11:00:00Z",
    resolved_at: null,
    ...overrides,
  };
}

describe("formatAge", () => {
  it("handles missing / invalid input", () => {
    expect(formatAge(null, NOW)).toBe("");
    expect(formatAge(undefined, NOW)).toBe("");
    expect(formatAge("not-a-date", NOW)).toBe("");
  });

  it("renders relative ages in Chinese", () => {
    expect(formatAge("2026-08-01T11:59:40Z", NOW)).toBe("刚刚");
    expect(formatAge("2026-08-01T11:45:00Z", NOW)).toBe("15 分钟前");
    expect(formatAge("2026-08-01T09:00:00Z", NOW)).toBe("3 小时前");
    expect(formatAge("2026-07-30T12:00:00Z", NOW)).toBe("2 天前");
  });

  it("falls back to a short date after a week", () => {
    // 绝对日期分支:与本地时区相关,所以用同一个 formatter 算期望值 —— 关键是它不再
    // 输出「N 天前」这种相对文案。
    const iso = "2026-07-01T12:00:00Z";
    const expected = new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso).getTime());
    expect(formatAge(iso, NOW)).toBe(expected);
    expect(formatAge(iso, NOW)).not.toContain("天前");
  });

  it("clamps future timestamps to 刚刚", () => {
    expect(formatAge("2026-08-02T12:00:00Z", NOW)).toBe("刚刚");
  });
});

describe("argsPreview", () => {
  it("joins k: v pairs with a middle dot and collapses whitespace", () => {
    expect(argsPreview({ command: "ls  -la\n/tmp", recursive: true })).toBe(
      "command: ls -la /tmp · recursive: true",
    );
  });

  it("truncates long values and the whole line", () => {
    const long = argsPreview({ content: "x".repeat(500) }, 120);
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
  });

  it("returns empty for non-objects", () => {
    expect(argsPreview(null)).toBe("");
    expect(argsPreview("run ls")).toBe("");
  });
});

describe("itemSummary", () => {
  it("summarizes approvals carrying data.tool + arguments", () => {
    const item = makeItem({
      data: { tool: "run_shell", arguments: { command: "git status" } },
    });
    expect(itemSummary(item)).toBe("run_shell · command: git status");
  });

  it("falls back to just the tool name without arguments", () => {
    expect(itemSummary(makeItem({ data: { tool: "read_file" } }))).toBe("read_file");
    expect(itemSummary(makeItem({ data: {} }))).toBe("");
  });

  it("summarizes directory requests with access level", () => {
    expect(
      itemSummary(makeItem({ kind: "directory", data: { path: "/tmp/docs", writable: true } })),
    ).toBe("/tmp/docs(读写)");
    expect(
      itemSummary(makeItem({ kind: "directory", data: { path: "/tmp/docs", writable: false } })),
    ).toBe("/tmp/docs(只读)");
    expect(itemSummary(makeItem({ kind: "directory", data: {} }))).toBe("");
  });

  it("leaves questions / plans / notifications to the body", () => {
    expect(itemSummary(makeItem({ kind: "question" }))).toBe("");
    expect(itemSummary(makeItem({ kind: "plan" }))).toBe("");
  });
});

describe("resolve payload builders", () => {
  it("approval resolutions are the backend vocabulary verbatim", () => {
    expect(approvalResolution("allow")).toBe("allow");
    expect(approvalResolution("deny")).toBe("deny");
    expect(approvalResolution("always_task")).toBe("always_task");
  });

  it("directory resolutions round-trip as {granted, path, writable}", () => {
    expect(JSON.parse(directoryResolution(true, "/tmp/docs", true))).toEqual({
      granted: true,
      path: "/tmp/docs",
      writable: true,
    });
    expect(JSON.parse(directoryResolution(true, "/tmp/docs"))).toEqual({
      granted: true,
      path: "/tmp/docs",
      writable: false,
    });
    expect(JSON.parse(directoryResolution(false))).toEqual({ granted: false });
  });

  it("plan resolutions round-trip as {approved, mode} / {approved, feedback}", () => {
    expect(JSON.parse(planResolution(true))).toEqual({ approved: true, mode: "interactive" });
    expect(JSON.parse(planResolution(false))).toEqual({ approved: false, feedback: "" });
  });

  it("question multi-select joins with a comma", () => {
    expect(questionResolution(["A", "B"])).toBe("A, B");
    expect(questionResolution([])).toBe("");
  });
});

describe("canAlwaysTask", () => {
  it("needs both task_id and standing_target", () => {
    expect(canAlwaysTask(makeItem({ data: { task_id: "t1", standing_target: "/x" } }))).toBe(true);
    expect(canAlwaysTask(makeItem({ data: { task_id: "t1" } }))).toBe(false);
    expect(canAlwaysTask(makeItem({ data: {} }))).toBe(false);
    expect(canAlwaysTask(makeItem())).toBe(false);
  });
});

describe("resolutionText", () => {
  it("labels approval decisions", () => {
    expect(resolutionText(makeItem({ state: "resolved", resolution: "allow" }))).toBe("已允许");
    expect(resolutionText(makeItem({ state: "resolved", resolution: "deny" }))).toBe("已拒绝");
    expect(resolutionText(makeItem({ state: "resolved", resolution: "always_task" }))).toBe(
      "始终允许(此任务)",
    );
    expect(resolutionText(makeItem({ state: "resolved", resolution: "always_tool" }))).toBe(
      "始终允许",
    );
  });

  it("echoes question answers (truncated)", () => {
    expect(
      resolutionText(makeItem({ kind: "question", state: "resolved", resolution: "用方案 B" })),
    ).toBe("已回答:用方案 B");
  });

  it("parses directory / plan JSON resolutions", () => {
    expect(
      resolutionText(
        makeItem({
          kind: "directory",
          state: "resolved",
          resolution: JSON.stringify({ granted: true, path: "/tmp/docs", writable: false }),
        }),
      ),
    ).toBe("已授权 /tmp/docs");
    expect(
      resolutionText(
        makeItem({ kind: "directory", state: "resolved", resolution: JSON.stringify({ granted: false }) }),
      ),
    ).toBe("已拒绝授权");
    expect(
      resolutionText(
        makeItem({ kind: "plan", state: "resolved", resolution: JSON.stringify({ approved: true, mode: "interactive" }) }),
      ),
    ).toBe("已批准计划");
    expect(
      resolutionText(
        makeItem({ kind: "plan", state: "resolved", resolution: JSON.stringify({ approved: false, feedback: "" }) }),
      ),
    ).toBe("已拒绝计划");
  });

  it("recognizes server-side closures and dismissals", () => {
    expect(resolutionText(makeItem({ state: "resolved", resolution: "session deleted" }))).toBe(
      "会话已删除",
    );
    expect(
      resolutionText(makeItem({ kind: "notification", state: "resolved", resolution: "seen" })),
    ).toBe("已知晓");
  });

  it("falls back gracefully for unknown resolutions", () => {
    expect(resolutionText(makeItem({ state: "resolved", resolution: null }))).toBe("已处理");
    expect(resolutionText(makeItem({ state: "resolved", resolution: "weird" }))).toBe("已处理:weird");
  });
});

describe("list views", () => {
  const older = makeItem({ id: "a", created_at: "2026-08-01T10:00:00Z" });
  const newer = makeItem({ id: "b", created_at: "2026-08-01T11:00:00Z" });

  it("pendingView keeps queue order (oldest first)", () => {
    expect(pendingView([newer, older]).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("resolvedView shows the newest resolutions first and caps the list", () => {
    const items = [older, { ...newer, resolved_at: "2026-08-01T11:30:00Z" }];
    expect(resolvedView(items).map((i) => i.id)).toEqual(["b", "a"]);
    const many = Array.from({ length: 60 }, (_, i) =>
      makeItem({ id: `i${i}`, resolved_at: `2026-08-01T11:${String(i).padStart(2, "0")}:00Z` }),
    );
    expect(resolvedView(many)).toHaveLength(50);
    expect(resolvedView(many, 5)).toHaveLength(5);
  });
});

describe("misc", () => {
  it("kindMeta covers every kind with a fallback", () => {
    expect(kindMeta("approval").label).toBe("审批");
    expect(kindMeta("question").label).toBe("提问");
    expect(kindMeta("directory").label).toBe("文件夹");
    expect(kindMeta("plan").label).toBe("计划");
    expect(kindMeta("notification").label).toBe("通知");
    expect(kindMeta("mystery").label).toBe("事项");
  });

  it("sessionLabel prefers the joined title", () => {
    expect(sessionLabel(makeItem({ session_title: "周报整理" }))).toBe("周报整理");
    expect(sessionLabel(makeItem())).toBe("sess-1");
  });
});

describe("agent permission helpers", () => {
  const permission: AgentPermission = {
    permission_id: "perm-1",
    profile_id: "opencode-executor",
    role: "executor",
    tool_call: { name: "write_file", arguments: { path: "/tmp/a.txt" } },
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { option_id: "allow_always", name: "Always allow", kind: "allow_always" },
      { id: "reject_once", name: "Reject", kind: "reject_once" },
    ],
    status: "pending",
  };

  it("reads option ids across the ACP naming variants", () => {
    const [once, always, reject] = permission.options ?? [];
    expect(permissionOptionId(once)).toBe("allow_once");
    expect(permissionOptionId(always)).toBe("allow_always");
    expect(permissionOptionId(reject)).toBe("reject_once");
    expect(permissionOptionId({})).toBe("");
  });

  it("maps the backend's English option labels to Chinese", () => {
    expect(permissionOptionLabel({ name: "Allow once" })).toBe("允许一次");
    expect(permissionOptionLabel({ name: "Always allow" })).toBe("始终允许");
    expect(permissionOptionLabel({ name: "always" })).toBe("始终允许");
    expect(permissionOptionLabel({ name: "Reject" })).toBe("拒绝");
    expect(permissionOptionLabel({ name: "Deny" })).toBe("拒绝");
  });

  it("passes unknown labels through; id fallback maps known ids too", () => {
    expect(permissionOptionLabel({ name: "Ask every time" })).toBe("Ask every time");
    expect(permissionOptionLabel({ optionId: "allow_once" })).toBe("允许一次");
    expect(permissionOptionLabel({ optionId: "custom_xyz" })).toBe("custom_xyz");
    expect(permissionOptionLabel({})).toBe("允许");
  });

  it("detects deny-like options", () => {
    const [once, , reject] = permission.options ?? [];
    expect(permissionOptionIsDeny(once)).toBe(false);
    expect(permissionOptionIsDeny(reject)).toBe(true);
    expect(permissionOptionIsDeny({ name: "拒绝" })).toBe(true);
  });

  it("names the tool call and compacts its JSON", () => {
    expect(permissionToolName(permission)).toBe("write_file");
    expect(permissionToolName({ permission_id: "p", tool_call: {}, status: "pending" })).toBe(
      "工具调用",
    );
    expect(permissionToolDetail(permission)).toBe(
      '{"name":"write_file","arguments":{"path":"/tmp/a.txt"}}',
    );
    expect(permissionToolDetail({ permission_id: "p", status: "pending" })).toBe("");
  });
});
