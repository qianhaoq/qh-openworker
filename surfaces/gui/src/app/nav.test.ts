import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTE, matchSegments, parseHash } from "./nav";

describe("parseHash", () => {
  it("defaults to the assistant route for empty hashes", () => {
    for (const hash of ["", "#", "#/"]) {
      expect(parseHash(hash)).toEqual(DEFAULT_ROUTE);
    }
  });

  it("matches every top-level route", () => {
    for (const name of [
      "assistant",
      "agents",
      "missions",
      "inbox",
      "automations",
      "integrations",
      "settings",
    ] as const) {
      expect(parseHash(`#/${name}`)).toEqual({ name, params: {} });
    }
  });

  it("captures dynamic segments", () => {
    expect(parseHash("#/missions/m-42")).toEqual({
      name: "missions",
      params: { missionId: "m-42" },
    });
    expect(parseHash("#/assistant/s-7")).toEqual({
      name: "assistant",
      params: { sessionId: "s-7" },
    });
  });

  it("decodes URI components in params", () => {
    const id = encodeURIComponent("任务 1");
    expect(parseHash(`#/missions/${id}`).params.missionId).toBe("任务 1");
  });

  it("tolerates malformed percent-escapes instead of throwing", () => {
    expect(parseHash("#/missions/%").params.missionId).toBe("%");
  });

  it("ignores trailing slashes", () => {
    expect(parseHash("#/inbox/")).toEqual({ name: "inbox", params: {} });
  });

  it("falls back to the default for unknown or over-long paths", () => {
    expect(parseHash("#/nope")).toEqual(DEFAULT_ROUTE);
    expect(parseHash("#/missions/a/b")).toEqual(DEFAULT_ROUTE);
  });
});

describe("matchSegments", () => {
  it("returns null when nothing matches", () => {
    expect(matchSegments(["settings", "extra"])).toBeNull();
    expect(matchSegments([])).toBeNull();
  });
});
