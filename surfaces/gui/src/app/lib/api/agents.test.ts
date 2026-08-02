import { afterEach, describe, expect, it, vi } from "vitest";
import { detectAgentCommands } from "./agents";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectAgentCommands", () => {
  it("calls the detect route with the comma-joined command list", async () => {
    vi.stubGlobal("__COWORKER_HTTP__", "http://sidecar.test");
    const request = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ results: { npx: true, gemini: false } }),
    }));
    vi.stubGlobal("fetch", request);

    const data = await detectAgentCommands(["npx", "gemini"]);
    expect(data.results).toEqual({ npx: true, gemini: false });

    const url = new URL(request.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/v1/agent-profiles/detect");
    expect(url.searchParams.get("commands")).toBe("npx,gemini");
  });

  it("propagates a server failure as an ApiError", async () => {
    vi.stubGlobal("__COWORKER_HTTP__", "http://sidecar.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ detail: "boom" }),
      })),
    );
    await expect(detectAgentCommands(["npx"])).rejects.toThrow("boom");
  });
});
