// Tiny hash router — no dependencies. Routes look like "#/missions" with at most one
// dynamic segment per pattern ("#/missions/:missionId"); anything unrecognized falls
// back to the assistant. Kept deliberately small: pattern table + parse + a hook.

import { useEffect, useState } from "react";

export type RouteName =
  | "assistant"
  | "agents"
  | "missions"
  | "inbox"
  | "automations"
  | "integrations"
  | "settings";

export interface Route {
  name: RouteName;
  /** Captured dynamic segments, e.g. { missionId: "m-1" } for "#/missions/m-1". */
  params: Record<string, string>;
}

interface RoutePattern {
  name: RouteName;
  /** Literal segments, or ":param" to capture a single segment. */
  segments: readonly string[];
}

// The route table — the app's seven top-level pages plus the two detail routes.
export const ROUTES: readonly RoutePattern[] = [
  { name: "assistant", segments: ["assistant", ":sessionId"] },
  { name: "assistant", segments: ["assistant"] },
  { name: "agents", segments: ["agents"] },
  { name: "missions", segments: ["missions", ":missionId"] },
  { name: "missions", segments: ["missions"] },
  { name: "inbox", segments: ["inbox"] },
  { name: "automations", segments: ["automations"] },
  { name: "integrations", segments: ["integrations"] },
  { name: "settings", segments: ["settings"] },
];

export const DEFAULT_ROUTE: Route = { name: "assistant", params: {} };

const splitPath = (path: string): string[] => path.split("/").filter(Boolean);

// A malformed percent-escape (e.g. "#/missions/%") must not take the router down.
const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Match already-split path segments against the route table (null = no match). */
export function matchSegments(segments: readonly string[]): Route | null {
  for (const pattern of ROUTES) {
    if (pattern.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < segments.length; i += 1) {
      const want = pattern.segments[i];
      if (want.startsWith(":")) {
        params[want.slice(1)] = decode(segments[i]);
      } else if (want !== segments[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { name: pattern.name, params };
  }
  return null;
}

/** Parse a location.hash value ("#/missions/m-1") into a Route; falls back to the default. */
export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\//, "");
  return matchSegments(splitPath(path)) ?? DEFAULT_ROUTE;
}

/** Navigate to a path — "missions/m-1", "/missions/m-1", and "#/missions/m-1" all work. */
export function navigate(path: string): void {
  const normalized = path.replace(/^#/, "").replace(/^\//, "");
  window.location.hash = `#/${normalized}`;
}

/** The current route; re-renders the subscriber on every hashchange. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return route;
}
