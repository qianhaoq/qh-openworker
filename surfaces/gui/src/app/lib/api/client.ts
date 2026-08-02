// Base HTTP/WS plumbing for the sidecar control plane. Every REST call and WebSocket
// in the new app goes through this module so launch authentication (the X-OpenWorker-Token
// header / the "openworker" subprotocol) is applied in exactly one place.

declare const __COWORKER_DEV_TOKEN__: string;

export const DEFAULT_HTTP_BASE = "http://127.0.0.1:8765";
export const DEFAULT_WS_BASE = "ws://127.0.0.1:8765";

const runtimeGlobal = (key: string): string => {
  const value = (globalThis as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

// Endpoint resolution order: runtime-injected globals (Tauri sets `window.__COWORKER_HTTP__`
// for its dynamically-chosen sidecar port) → Vite env → the 127.0.0.1:8765 dev default. This
// keeps a single codebase: browser `npm run dev` hits 8765; the desktop shell hits its sidecar.
// The pure resolvers are exported so the precedence chain is unit-testable (import.meta.env
// is per-module under vitest and can't be stubbed from a test file).
export const resolveEndpoint = (
  injected: string,
  env: string | undefined,
  fallback: string,
): string => injected || env || fallback;

export const resolveToken = (launch: string, dev: string, env: string | undefined): string =>
  launch || dev || env || "";

export const httpBase = (): string =>
  resolveEndpoint(
    runtimeGlobal("__COWORKER_HTTP__"),
    (import.meta as any).env?.VITE_COWORKER_HTTP,
    DEFAULT_HTTP_BASE,
  );

export const wsBase = (): string =>
  resolveEndpoint(
    runtimeGlobal("__COWORKER_WS__"),
    (import.meta as any).env?.VITE_COWORKER_WS,
    DEFAULT_WS_BASE,
  );

// Token chain: the launch token injected by the desktop shell → the dev token baked in by
// vite's `define` (read from the sidecar token file at dev-server start) → the env fallback.
export const apiToken = (): string =>
  resolveToken(
    runtimeGlobal("__COWORKER_API_TOKEN__"),
    typeof __COWORKER_DEV_TOKEN__ === "string" ? __COWORKER_DEV_TOKEN__ : "",
    (import.meta as any).env?.VITE_COWORKER_API_TOKEN,
  );

// Normalized transport failure. `status` is the HTTP status (0 for network errors);
// `message` prefers the backend's `detail` (FastAPI HTTPException) then `error`;
// `code` carries a machine-readable code when the server sends one (rare today).
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly payload: unknown;

  constructor(message: string, status: number, code: string | null = null, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

const errorMessage = (payload: unknown, status: number): string => {
  if (payload && typeof payload === "object") {
    const body = payload as Record<string, unknown>;
    const detail = body.detail ?? body.error ?? body.message;
    if (typeof detail === "string" && detail) return detail;
    if (detail != null) return JSON.stringify(detail);
  }
  // Non-JSON bodies (proxy HTML, empty 5xx pages) carry no usable message.
  return `Request failed with status ${status}`;
};

const errorCode = (payload: unknown): string | null => {
  if (payload && typeof payload === "object") {
    const code = (payload as Record<string, unknown>).code;
    if (typeof code === "string" && code) return code;
  }
  return null;
};

// Low-level fetch with the launch-auth header. Exported for the rare non-JSON call;
// prefer `request` below.
export const apiFetch = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  const token = apiToken();
  if (token) headers.set("X-OpenWorker-Token", token);
  return globalThis.fetch(input, { ...init, headers });
};

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly string[]>;

const buildUrl = (path: string, query?: Query): string => {
  const base = `${httpBase()}${path}`;
  if (!query) return base;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString();
  return suffix ? `${base}?${suffix}` : base;
};

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  query?: Query;
  body?: unknown;
}

// JSON-in/JSON-out request. Throws ApiError on a non-2xx status; `{ok:false, error}` bodies
// (the backend's domain-error envelope, always HTTP 200) pass through for the caller to read.
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", query, body } = options;
  let res: Response;
  try {
    res = await apiFetch(buildUrl(path, query), {
      method,
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
  } catch (cause) {
    throw new ApiError(cause instanceof Error ? cause.message : "Network request failed", 0);
  }
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    throw new ApiError(errorMessage(payload, res.status), res.status, errorCode(payload), payload);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: Query): Promise<T> => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown, query?: Query): Promise<T> =>
    request<T>(path, { method: "POST", body, query }),
  patch: <T>(path: string, body?: unknown, query?: Query): Promise<T> =>
    request<T>(path, { method: "PATCH", body, query }),
  delete: <T>(path: string, query?: Query): Promise<T> =>
    request<T>(path, { method: "DELETE", query }),
};

export const wsUrl = (path: string): string => `${wsBase()}${path}`;

// The token rides as a subprotocol (browsers can't set WS headers); the sidecar accepts
// when any offered protocol matches and answers "openworker" (see app.py's WS auth).
export const openWebSocket = (url: string): WebSocket => {
  const token = apiToken();
  return token ? new WebSocket(url, ["openworker", token]) : new WebSocket(url);
};
