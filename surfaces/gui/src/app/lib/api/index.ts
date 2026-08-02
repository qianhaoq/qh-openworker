// Public surface of the API layer: the transport client, every domain module, and the
// authoritative types. Import from "app/lib/api" (or the specific module) — never fetch
// the sidecar directly.

export * from "./client";
export * from "./sessions";
export * from "./attachments";
export * from "./agents";
export * from "./missions";
export * from "./inbox";
export * from "./connectors";
export * from "./automations";
export * from "./settings";
export type * from "./types";
