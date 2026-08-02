import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  apiToken,
  httpBase,
  request,
  resolveEndpoint,
  resolveToken,
  wsBase,
} from "./client";
import { getHealth } from "./sessions";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("endpoint resolution", () => {
  it("falls back to the 127.0.0.1:8765 dev default", () => {
    expect(httpBase()).toBe("http://127.0.0.1:8765");
    expect(wsBase()).toBe("ws://127.0.0.1:8765");
  });

  it("prefers the runtime-injected globals", () => {
    vi.stubGlobal("__COWORKER_HTTP__", "http://tauri.test");
    vi.stubGlobal("__COWORKER_WS__", "ws://tauri.test");

    expect(httpBase()).toBe("http://tauri.test");
    expect(wsBase()).toBe("ws://tauri.test");
  });

  it("orders the chain global → Vite env → default", () => {
    expect(resolveEndpoint("http://tauri.test", "http://env.test", "http://default.test")).toBe(
      "http://tauri.test",
    );
    expect(resolveEndpoint("", "http://env.test", "http://default.test")).toBe("http://env.test");
    expect(resolveEndpoint("", undefined, "http://default.test")).toBe("http://default.test");
  });
});

describe("token chain", () => {
  it("orders the chain launch token → dev define → env", () => {
    expect(resolveToken("launch", "dev", "env")).toBe("launch");
    expect(resolveToken("", "dev", "env")).toBe("dev");
    expect(resolveToken("", "", "env")).toBe("env");
    expect(resolveToken("", "", undefined)).toBe("");
  });

  it("sends the launch token as X-OpenWorker-Token", async () => {
    vi.stubGlobal("__COWORKER_API_TOKEN__", "launch-token");
    const request_ = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-OpenWorker-Token")).toBe("launch-token");
      return { ok: true, status: 200, text: async () => '{"status":"ok"}' } as Response;
    });
    vi.stubGlobal("fetch", request_);

    expect(apiToken()).toBe("launch-token");
    await getHealth();
    expect(request_).toHaveBeenCalledOnce();
  });

  it("sends no header when there is no token", async () => {
    const withoutToken = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-OpenWorker-Token")).toBeNull();
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    });
    vi.stubGlobal("fetch", withoutToken);

    expect(apiToken()).toBe("");
    await getHealth();
  });
});

describe("request error normalization", () => {
  const stubResponse = (res: Partial<Response>) =>
    vi.stubGlobal("fetch", vi.fn(async () => res as Response));

  it("throws ApiError with the FastAPI detail message and status", async () => {
    stubResponse({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ detail: "plan is already confirmed" }),
    });

    const failure = (await request("/v1/missions/task-1/confirm", { method: "POST" }).catch(
      (e) => e,
    )) as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(409);
    expect(failure.message).toBe("plan is already confirmed");
  });

  it("reads the sidecar's {error} envelope (e.g. the 401 auth gate)", async () => {
    stubResponse({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "missing or invalid OpenWorker sidecar token" }),
    });

    await expect(api.get("/v1/sessions")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      message: "missing or invalid OpenWorker sidecar token",
    });
  });

  it("stringifies structured detail (FastAPI 422 validation arrays)", async () => {
    stubResponse({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ detail: [{ loc: ["body", "name"], msg: "field required" }] }),
    });

    const failure = (await api.post("/v1/mcp", {}).catch((e) => e)) as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(422);
    expect(failure.message).toContain("field required");
  });

  it("falls back to a status message for non-JSON bodies", async () => {
    stubResponse({ ok: false, status: 502, text: async () => "<html>bad gateway</html>" });

    await expect(api.get("/v1/health")).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      message: "Request failed with status 502",
    });
  });

  it("wraps network failures as ApiError with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(api.get("/v1/health")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      message: "fetch failed",
    });
  });

  it("passes {ok:false} domain envelopes through without throwing", async () => {
    stubResponse({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, error: "name and config required" }),
    });

    await expect(api.post("/v1/mcp", {})).resolves.toEqual({
      ok: false,
      error: "name and config required",
    });
  });

  it("builds query strings, repeating array values", async () => {
    const request_ = vi.fn(
      async (_url: string) =>
        ({ ok: true, status: 200, text: async () => '{"missions":[]}' }) as Response,
    );
    vi.stubGlobal("fetch", request_);
    vi.stubGlobal("__COWORKER_HTTP__", "http://sidecar.test");

    await api.get("/v1/missions", { state: ["QUEUED", "BLOCKED"], limit: 5, after: undefined });

    expect(request_).toHaveBeenCalledWith(
      "http://sidecar.test/v1/missions?state=QUEUED&state=BLOCKED&limit=5",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
