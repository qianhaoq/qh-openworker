// Connectors (Slack / GitHub / Gmail / Calendar / HubSpot / generic accounts), MCP
// servers, and the audit log. Only routes verified against coworker/server/app.py are
// kept — the cloud sign-in / managed-OAuth / gallery surface is intentionally out of
// scope for the new app (the routes exist but the new UI does not ride them).

import { api } from "./client";
import type {
  AuditEntry,
  Connector,
  GithubStatus,
  GmailFilters,
  McpServer,
  McpTool,
  SlackChannelEntry,
  SlackMember,
  SlackStatus,
} from "./types";

// -- connectors (app.py:748-804, 1207-1254) ---------------------------------------
export async function getConnectors(): Promise<Connector[]> {
  const data = await api.get<{ connectors?: Connector[] }>("/v1/connectors");
  return data.connectors ?? [];
}

// Manual token-paste connect. `acknowledgeRisk` is required for experimental connectors.
export const connectConnector = (
  name: string,
  fields: Record<string, string>,
  options: { acknowledgeRisk?: boolean } = {},
): Promise<{ ok: boolean; account?: string; error?: string }> =>
  api.post(`/v1/connectors/${encodeURIComponent(name)}/connect`, {
    fields,
    ...(options.acknowledgeRisk ? { acknowledge_risk: true } : {}),
  });

/** One-click connect for an MCP-backed connector (local OAuth, browser flow): the sidecar
 * opens the vendor sign-in; poll getConnectors until the card flips to connected. */
export const connectMcpBacked = (
  name: string,
): Promise<{ ok: boolean; started?: boolean; error?: string }> =>
  api.post(`/v1/connectors/${encodeURIComponent(name)}/mcp-connect`);

export const disconnectConnector = (name: string): Promise<{ ok: boolean; error?: string }> =>
  api.post(`/v1/connectors/${encodeURIComponent(name)}/disconnect`);

export const updateConnectorTools = (
  name: string,
  enabled: Record<string, boolean>,
): Promise<{ ok: boolean; error?: string; tools?: Record<string, boolean> }> =>
  api.patch(`/v1/connectors/${encodeURIComponent(name)}/tools`, { enabled });

// `teamId` scopes the edit to one workspace (managed relay); absent → the flat list.
// `displayName` seeds the people directory so the chip is readable at once.
export const allowUser = (
  name: string,
  userId: string,
  teamId?: string | null,
  displayName?: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.post(`/v1/connectors/${encodeURIComponent(name)}/allow`, {
    user_id: userId,
    ...(teamId ? { team_id: teamId } : {}),
    ...(displayName ? { name: displayName } : {}),
  });

export const disallowUser = (
  name: string,
  userId: string,
  teamId?: string | null,
): Promise<{ ok: boolean; error?: string }> =>
  api.post(`/v1/connectors/${encodeURIComponent(name)}/disallow`, {
    user_id: userId,
    ...(teamId ? { team_id: teamId } : {}),
  });

/** Resolve a parked unauthorized message: dismiss / allow / allow_deliver (app.py:948). */
export const resolveUnauthorized = (
  name: string,
  itemId: string,
  action: "dismiss" | "allow" | "allow_deliver",
): Promise<{ ok: boolean; error?: string }> =>
  api.post(
    `/v1/connectors/${encodeURIComponent(name)}/unauthorized/${encodeURIComponent(itemId)}`,
    { action },
  );

// -- Slack (app.py:806-815, 1226-1248, 1256-1268) ----------------------------------
export const getSlackStatus = (): Promise<SlackStatus> =>
  api.get<SlackStatus>("/v1/connectors/slack/status");

/** Stop relaying one managed Slack workspace (the app stays installed in Slack). */
export const disconnectSlackWorkspace = (
  teamId: string,
): Promise<{ ok: boolean; error?: string; remaining_workspaces?: number }> =>
  api.post(`/v1/connectors/slack/workspaces/${encodeURIComponent(teamId)}/disconnect`);

/** Workspace member roster for the people picker (teamId "default" = manual Socket Mode). */
export const getSlackDirectory = (
  teamId: string,
  q = "",
  limit?: number,
): Promise<{ ok: boolean; error?: string; members?: SlackMember[] }> =>
  api.get(`/v1/connectors/slack/workspaces/${encodeURIComponent(teamId)}/directory`, {
    q,
    limit,
  });

/** Channel roster for the channel typeahead (name → id resolution). */
export const getSlackChannels = (
  teamId: string,
  q = "",
  limit?: number,
): Promise<{ ok: boolean; error?: string; channels?: SlackChannelEntry[] }> =>
  api.get(`/v1/connectors/slack/workspaces/${encodeURIComponent(teamId)}/channels`, {
    q,
    limit,
  });

export const addSlackApprovalOwner = (
  userId: string,
  displayName?: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.post("/v1/connectors/slack/approval-owners/add", {
    user_id: userId,
    ...(displayName ? { name: displayName } : {}),
  });

export const removeSlackApprovalOwner = (
  userId: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.post("/v1/connectors/slack/approval-owners/remove", { user_id: userId });

// -- GitHub (app.py:817-827) --------------------------------------------------------
export const getGithubStatus = (): Promise<GithubStatus> =>
  api.get<GithubStatus>("/v1/connectors/github/status");

/** Stop relaying ONE GitHub App installation to this computer. */
export const disconnectGithubInstallation = (
  installationId: string,
): Promise<{ ok: boolean; error?: string; remaining_installs?: number }> =>
  api.post(
    `/v1/connectors/github/installations/${encodeURIComponent(installationId)}/disconnect`,
  );

// -- Gmail / Google Calendar (app.py:829-888) ---------------------------------------
/** Drop ONE Gmail mailbox; the default pointer moves to the next account. */
export const disconnectGmailAccount = (
  email: string,
): Promise<{ ok: boolean; error?: string; remaining_accounts?: number }> =>
  api.post(`/v1/connectors/gmail/accounts/${encodeURIComponent(email)}/disconnect`);

export const setGmailDefaultAccount = (
  email: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.post(`/v1/connectors/gmail/accounts/${encodeURIComponent(email)}/default`);

/** Replace the "Never show agents" lists (senders and/or labels; omit to keep). */
export const setGmailFilters = (filters: {
  senders?: string[];
  labels?: string[];
}): Promise<{ ok: boolean; filters?: GmailFilters; error?: string }> =>
  api.patch("/v1/connectors/gmail/filters", filters);

/** Drop ONE Google Calendar account; the default pointer moves to the next one. */
export const disconnectGcalAccount = (
  email: string,
): Promise<{ ok: boolean; error?: string; remaining_accounts?: number }> =>
  api.post(`/v1/connectors/google_calendar/accounts/${encodeURIComponent(email)}/disconnect`);

export const setGcalDefaultAccount = (
  email: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.post(`/v1/connectors/google_calendar/accounts/${encodeURIComponent(email)}/default`);

// -- HubSpot (app.py:890-908, 937-946) ----------------------------------------------
/** Drop ONE HubSpot portal; the default pointer moves to the next portal. */
export const disconnectHubSpotPortal = (
  hubId: string,
): Promise<{ ok: boolean; error?: string; remaining_portals?: number }> =>
  api.post(`/v1/connectors/hubspot/portals/${encodeURIComponent(hubId)}/disconnect`);

export const setHubSpotDefaultPortal = (
  hubId: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.post(`/v1/connectors/hubspot/portals/${encodeURIComponent(hubId)}/default`);

/** Replace the hidden-fields denylist (properties stripped from agent reads). */
export const setHubSpotHiddenFields = (
  fields: string[],
): Promise<{ ok: boolean; hidden_fields?: string[]; error?: string }> =>
  api.patch("/v1/connectors/hubspot/hidden-fields", { hidden_fields: fields });

// -- generic multi-account connectors (app.py:910-935) ------------------------------
/** Drop ONE account of a generic multi-account connector (notion, attio, posthog, …). */
export const disconnectAccount = (
  connector: string,
  accountId: string,
): Promise<{ ok: boolean; error?: string; remaining_accounts?: number }> =>
  api.post(
    `/v1/connectors/${encodeURIComponent(connector)}/accounts/${encodeURIComponent(accountId)}/disconnect`,
  );

export const setDefaultAccount = (
  connector: string,
  accountId: string,
): Promise<{ ok: boolean; error?: string }> =>
  api.post(
    `/v1/connectors/${encodeURIComponent(connector)}/accounts/${encodeURIComponent(accountId)}/default`,
  );

// -- MCP servers (app.py:669-704, 743-745) ------------------------------------------
export async function getMcpServers(): Promise<McpServer[]> {
  const data = await api.get<{ servers?: McpServer[] }>("/v1/mcp");
  return data.servers ?? [];
}

export const addMcpServer = (
  name: string,
  config: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> => api.post("/v1/mcp", { name, config });

export const patchMcpServer = (
  name: string,
  changes: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> =>
  api.patch(`/v1/mcp/${encodeURIComponent(name)}`, changes);

export const deleteMcpServer = (name: string): Promise<{ ok: boolean; error?: string }> =>
  api.delete(`/v1/mcp/${encodeURIComponent(name)}`);

export const getMcpTools = (
  name: string,
): Promise<{ ok: boolean; error?: string; tools: McpTool[] }> =>
  api.get(`/v1/mcp/${encodeURIComponent(name)}/tools`);

/** Connect one MCP server now. For OAuth servers this opens the system browser;
 * poll getMcpServers() for the status flip (authorizing → connected / needs_auth). */
export const connectMcp = (name: string): Promise<{ ok: boolean; started?: boolean }> =>
  api.post(`/v1/mcp/${encodeURIComponent(name)}/connect`);

/** Drop the connection and forget the stored OAuth tokens. */
export const signoutMcp = (name: string): Promise<{ ok: boolean }> =>
  api.post(`/v1/mcp/${encodeURIComponent(name)}/signout`);

export const reloadMcp = (): Promise<{ ok: boolean; error?: string }> =>
  api.post("/v1/mcp/reload");

// -- audit (app.py:1271-1282) ---------------------------------------------------------
export async function getAudit(
  params: {
    limit?: number;
    session_id?: string;
    connector?: string;
    tool?: string;
  } = {},
): Promise<AuditEntry[]> {
  const data = await api.get<{ events?: AuditEntry[] }>("/v1/audit", params);
  return data.events ?? [];
}
