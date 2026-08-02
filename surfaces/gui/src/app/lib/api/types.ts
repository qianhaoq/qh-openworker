// Authoritative TypeScript contract for the sidecar API (coworker/server/app.py) and its
// WebSocket streams (coworker/events.py + the extra server-side frames). Shapes were
// harvested from the backend models and verified against the routes they ride on.

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export interface Health {
  status: string;
  // Absent when the request carries no/invalid launch token (the tokenless probe answer).
  default_workspace?: string | null;
  model?: string;
}

// "always_task" persists to the owning automation's task record (standing scoped approval) —
// offered only on automation-run approval cards.
export type ApprovalDecision = "once" | "deny" | "always_tool" | "always_command" | "always_task";

export type PermissionMode = "discuss" | "plan" | "interactive" | "auto" | "custom" | string;

// ---------------------------------------------------------------------------
// Sessions / transcript
// ---------------------------------------------------------------------------

export interface Session {
  session_id: string;
  title?: string;
  workspace: string;
  agent: string;
  model: string;
  mode: string;
  updated_at: string | null;
  messages: number;
  pinned?: boolean;
  archived?: boolean;
  // Inbox items awaiting this session (the attention count that bubbles up the sidebar).
  attention?: number;
  // working = in-flight turn; sleeping = a self-wake is pending; idle = neither.
  liveness?: "working" | "sleeping" | "idle";
  // Channels this session listens to (inbound subscriptions).
  subscriptions?: string[];
  // Set when the session was spawned by a platform mention: machine key ("slack") + label.
  origin?: string;
  origin_label?: string;
}

// Attachments (images, PDFs, text files) sent with a user message.
export interface Attachment {
  kind: "image" | "text" | "pdf";
  name: string;
  mime?: string;
  data_url?: string; // images + PDFs
  text?: string; // text files
}

// A structured connector-delivered inbound message, attached to the user message it framed —
// display-only; the model still sees the framed `content`.
export interface MessageSource {
  connector: string; // platform id, e.g. "slack"
  kind: "channel" | "dm";
  channel_id: string;
  channel_name: string; // resolved; may equal the id
  sender_id: string;
  sender_name: string;
  ts: number; // epoch seconds
  text: string; // the RAW message
}

// Per-round-trip token counts, attached by the server to assistant messages and the
// assistant_message event ({model, input, output, cache_read, cache_write}).
export interface UsageInfo {
  model?: string | null;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

// Per-session accumulation, keyed by model id. `context` = the latest round-trip's
// prompt-side total — what currently occupies the active model's context window.
export interface SessionUsage {
  byModel: Record<string, UsageInfo>;
  context: number;
}

// A transcript message from GET /v1/sessions/{id}/messages. Kept permissive (open shape)
// because readers consume several role-specific fields; `source` is the connector sidecar.
export interface Message {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  source?: MessageSource;
  usage?: UsageInfo;
  ts?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Workspaces / roots / artifacts
// ---------------------------------------------------------------------------

export interface RecentWorkspace {
  path: string;
  name: string;
  exists: boolean;
}

export interface WorkspaceCommandTrust {
  workspace: string;
  requested_commands: string[];
  trusted: boolean;
  required: boolean;
  exists?: boolean;
}

export interface OpenWorkspaceResult {
  ok: boolean;
  path: string;
  error?: string;
  git_branch?: string | null;
  command_trust?: WorkspaceCommandTrust;
}

// Session roots (scratch + user-granted folders the agent may touch).
export interface RootEntry {
  path: string;
  writable: boolean;
  label: string;
  primary: boolean;
  exists: boolean;
}

export interface Artifact {
  path: string; // workspace-relative (the display/API identifier)
  abs_path?: string; // absolute — what "Copy path" copies
  name: string;
  kind: "markdown" | "html" | "image" | "code" | "text" | string;
  size: number;
  modified_at: number;
}

export interface ArtifactContent {
  ok: boolean;
  error?: string;
  path: string;
  kind: string;
  content?: string;
  data_url?: string;
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Per-session connections (Sources drawer)
// ---------------------------------------------------------------------------

export interface SessionConnectedConnector {
  connector: string;
  enabled: boolean; // effective state (session override / persona default)
  detail: string; // short human detail, e.g. "#ocw-test · DMs"
}

export interface SessionRecommendedConnector {
  connector: string;
  reason: string;
  tier: string;
  connected: boolean;
}

export interface SessionConnections {
  connected: SessionConnectedConnector[];
  recommended: SessionRecommendedConnector[];
  attention: number; // recommended connectors not yet connected
}

// ---------------------------------------------------------------------------
// Inbox (cross-session human-attention queue)
// ---------------------------------------------------------------------------

export type InboxItemKind = "approval" | "question" | "notification" | "directory" | "plan";
export type InboxItemState = "pending" | "resolved";
export type InboxVisibility = "inline" | "inbox";

export interface InboxItem {
  id: string;
  session_id: string;
  kind: InboxItemKind;
  title: string;
  body: string;
  state: InboxItemState;
  // approval: "allow"/"deny"/"always"; question: the answer text; directory/plan: JSON.
  resolution: string | null;
  inbox: string; // named inbox / delivery binding
  created_at: string;
  resolved_at: string | null;
  visibility?: InboxVisibility;
  tool_call_id?: string | null;
  // Question metadata (ask_user): quick-reply choices + a free-text escape.
  options?: string[];
  allow_text?: boolean;
  multi?: boolean;
  // Kind-specific payload (directory: {path, writable}; plan: the plan text; …).
  data?: Record<string, unknown>;
  // Originating-session context (server-joined) so the Inbox is self-contained.
  session_title?: string;
  session_agent?: string | null;
  session_workspace?: string | null;
  session_exists?: boolean;
}

export interface InboxReconcile {
  pending: InboxItem[];
  recap: InboxItem[];
}

export interface Subscription {
  session_id: string;
  session_title: string;
  agent: string;
  channel: string;
  channel_name?: string | null; // resolved display name; the address stays the identifier
  routing_target: string | null;
  collision: boolean; // inbound subscription == outbound Inbox routing on the same channel
}

export interface RecentChannel {
  channel: string;
  name?: string | null;
  last_from: string | null;
  last_text: string | null;
}

export interface UnroutedItem {
  source: string;
  sender: string;
  text: string;
  reason: string;
  ts: number;
}

// Inbox routing binding: where Unattended approvals/questions get mirrored.
export interface InboxBinding {
  name: string;
  channel: string | null; // platform, e.g. "slack" (null = in-app Inbox only)
  target: string; // chat_id
}

// ---------------------------------------------------------------------------
// Agent profiles / permissions (multi-agent control plane)
// ---------------------------------------------------------------------------

export type AgentRole = "main" | "explorer" | "executor" | "reviewer" | "gui";
export type Transport = "acp_stdio" | "jsonl_rpc" | "embedded";

// Probe-reported capability map (transport-specific; ACP reports protocol features).
export type AgentCapabilities = Record<string, unknown>;

export interface AgentProfile {
  id: string;
  role: AgentRole;
  transport: Transport;
  command: string;
  args: string[];
  model_profile?: string | null;
  workspace_policy: string;
  permission_policy: string;
  secret_refs: string[];
  limits: Record<string, unknown>;
  enabled: boolean;
  capabilities: AgentCapabilities;
  capability_probe_fingerprint?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AgentMainProfile {
  workspace: string;
  main_profile_id: string;
  profile: AgentProfile;
}

export interface AgentPermissionOption {
  optionId?: string;
  option_id?: string;
  id?: string;
  name?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface AgentPermission {
  permission_id: string;
  profile_id?: string;
  role?: string;
  session_id?: string;
  tool_call?: Record<string, unknown>;
  options?: AgentPermissionOption[];
  status: string; // "pending" | "resolved" | "denied" | "expired"
  created_at?: number;
  selected_option_id?: string | null;
}

// ---------------------------------------------------------------------------
// Team tasks (delegated agent work)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "PLANNING"
  | "AWAITING_CONFIRMATION"
  | "QUEUED"
  | "IMPLEMENTING"
  | "VERIFYING"
  | "REVIEWING"
  | "APPROVED"
  | "DONE"
  | "CHANGES_REQUESTED"
  | "REWORK"
  | "BLOCKED"
  | "CANCELLED";

export interface TeamTask {
  id?: string;
  task_id: string;
  conversation_id?: string;
  state: string;
  status?: string;
  title?: string;
  task_spec?: Record<string, unknown>;
  max_rework_rounds?: number;
  target_profile_id?: string | null;
  target_session_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface TeamAttempt {
  id: string;
  task_id: string;
  agent_profile_id: string;
  role: AgentRole;
  status: string;
  agent_session_id?: string | null;
  worktree?: string | null;
  rework_round?: number;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface TeamArtifact {
  id: string;
  task_id: string;
  attempt_id?: string | null;
  kind: string;
  uri?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  [key: string]: unknown;
}

export interface ReviewFinding {
  id?: string;
  severity?: string;
  path?: string;
  line?: number | null;
  title?: string;
  evidence?: string;
  suggested_fix?: string;
  [key: string]: unknown;
}

export interface TeamReview {
  id?: string;
  task_id?: string;
  reviewer_attempt_id?: string | null;
  artifact_id?: string;
  verdict: "pass" | "request_changes" | "block" | string;
  findings?: ReviewFinding[];
  test_gaps?: string[];
  confidence?: number | string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface TeamTaskResult extends TeamTask {
  attempts: TeamAttempt[];
  artifacts: TeamArtifact[];
  reviews: TeamReview[];
  messages?: unknown[];
}

// ---------------------------------------------------------------------------
// Missions (a projection over the Task aggregate)
// ---------------------------------------------------------------------------

export type MissionState = TaskStatus;

export type MissionPlanStatus = "draft" | "proposed" | "confirmed" | "rejected";

// One planned seat in a Mission team (MissionMember.to_dict() — `id` and `seat_id`
// are the same value; `depends_on` and `dependencies` likewise).
export interface PlanMember {
  id: string;
  seat_id: string;
  role: AgentRole;
  profile_id: string;
  objective: string;
  depends_on: string[];
  dependencies: string[];
  attempt_id?: string | null;
  agent_session_id?: string | null;
  status?: string;
}

export interface MissionPlan {
  version: number;
  status: MissionPlanStatus;
  goal: string;
  summary?: string;
  proposed_by_profile_id?: string | null;
  members: PlanMember[];
  max_rework_rounds: number;
  created_at?: string;
  updated_at?: string;
}

export interface MissionTimelineEvent {
  event_id: string;
  event_type: string;
  aggregate_type?: string;
  aggregate_id?: string;
  payload: Record<string, unknown>;
  created_at: string;
}

// The mission view returned by create/get/list/plan-patch/confirm/cancel — the backend
// serves the get_mission projection; the client normalizer also tolerates a {mission: …}
// wrapper and a bare Task aggregate (older servers).
export interface Mission extends TeamTaskResult {
  mission_id: string;
  state: MissionState;
  workspace?: string | null;
  goal?: string;
  plan?: MissionPlan | null;
  plan_proposal?: {
    source?: "main_agent" | "control_plane_fallback" | "control_plane" | string;
    agent_session_id?: string | null;
    fallback_reason?: string | null;
  };
  members: PlanMember[];
  timeline: MissionTimelineEvent[];
  permissions: AgentPermission[];
  needs_user_action: boolean;
  planning_error?: { code: string; message: string; retryable: boolean } | null;
  fallback_used: boolean;
  last_cursor?: string | null;
}

// A ledger event on the cursor-resumable stream (REST /v1/missions/{id}/events and the
// matching WS): the timeline entry plus its resume cursor.
export interface MissionEvent extends MissionTimelineEvent {
  cursor?: string | null;
  mission_id?: string;
}

export interface MissionEventsPage {
  events: MissionEvent[];
  last_cursor?: string | null;
}

export type MessageTarget = { kind: "main" } | { kind: "attempt"; attempt_id: string };

export interface MissionCreateInput {
  goal: string;
  title?: string;
  workspace: string;
  conversation_id?: string;
  max_rework_rounds?: number;
  planning_mode?: string;
  plan?: Partial<MissionPlan>;
}

// One-shot Mission planning stream (/ws/missions/create). The socket accepts one
// {type:"create", data:MissionCreateInput} command and never reconnects: Mission state
// is durable server-side, while the stream only supplies live planning text to the drawer.
export type MissionPlanningStreamMessage =
  | { type: "ready"; data: Record<string, never> }
  | { type: "mission_created"; data: { mission: unknown } }
  | {
      type: "planning_delta";
      data: { text: string; agent_session_id?: string; profile_id?: string | null };
    }
  | { type: "mission_complete"; data: { mission: unknown } }
  | { type: "error"; data: { code?: string; error?: string } };

// Envelope of one frame on the mission events WebSocket (/v1/missions/{id}/events).
export type MissionStreamMessage =
  | { type: string; event: MissionEvent; cursor: string }
  | {
      type: "mission.snapshot";
      cursor?: string | null;
      event_id?: string | null;
      payload: { mission: unknown };
    }
  | { type: "pong"; data: { last_cursor?: string | null } };

// ---------------------------------------------------------------------------
// Connectors (Slack / GitHub / Gmail / …) + MCP
// ---------------------------------------------------------------------------

export interface ConnectorField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help: string;
  placeholder: string;
}

export interface ConnectorTool {
  name: string;
  label: string;
  kind: "read" | "write" | string;
  description: string;
  enabled: boolean;
  requires_approval: boolean;
}

// A message from a sender not (yet) on the allow-list — parked instead of dropped.
export interface ParkedMessage {
  id: string;
  platform: string;
  chat_id: string;
  chat_name: string | null;
  user_id: string;
  user_name: string | null;
  chat_type: string;
  text: string;
  ts: number;
  team_id?: string | null; // workspace (managed Slack relay); null on manual Socket Mode
}

export interface RecentSender {
  user_id: string;
  user_name: string | null;
  chat_id: string;
  chat_type: string;
  target: string;
  authorized: boolean;
  team_id?: string | null;
}

// One connected Slack workspace (managed relay is multi-workspace; each carries its OWN
// allow-list).
export interface SlackWorkspace {
  team_id: string;
  account: string;
  domain?: string;
  allowed_users: string[];
  allow_all: boolean;
  allowed_user_names?: Record<string, string | null>;
  approval_owner_ids?: string[];
  approval_owner_names?: Record<string, string | null>;
  installer_user_id?: string;
  installer_name?: string;
}

// One connected GitHub App installation (managed relay is multi-installation).
export interface GithubInstallation {
  installation_id: string;
  account_login: string;
  account_type: string; // "Organization" | "User"
  repo_selection: string; // "all" | "selected"
  github_login: string;
  allowed_users: string[];
  allow_all: boolean;
}

export interface HubSpotPortal {
  hub_id: string;
  name: string;
  sandbox: boolean;
  default: boolean;
  managed: boolean;
  access: "read" | "write" | ""; // consent tier granted ("" = manual token, unknown)
}

// One connected Google account (same shape for gmail and google_calendar).
export interface GmailAccount {
  email: string;
  default: boolean;
  managed: boolean;
  scopes: string;
  needs_reauth: boolean;
}

// "Never show agents" — enforced locally; agents see silent omissions.
export interface GmailFilters {
  senders: string[];
  labels: string[];
}

// One account of a generic multi-account connector (notion, attio, posthog, …).
export interface AccountRow {
  account_id: string;
  name: string;
  default: boolean;
  managed: boolean;
}

export interface Connector {
  name: string;
  title: string;
  icon: string;
  blurb: string;
  about?: string;
  access?: string[];
  auth: string;
  two_way: boolean;
  channels: boolean; // chat-platform capability: sessions can subscribe to channels
  available: boolean;
  fields: ConnectorField[];
  instructions: string[];
  connected: boolean;
  account: string | null;
  enabled: boolean;
  brand_color: string;
  logo: string;
  aliases?: string[];
  mcp?: boolean; // MCP-backed one-click (vendor-hosted MCP + local OAuth)
  allowed_users: string[];
  allowed_user_names?: Record<string, string | null>;
  approval_owner_ids?: string[];
  approval_owner_names?: Record<string, string | null>;
  recent?: RecentSender[];
  unauthorized?: ParkedMessage[];
  tools: ConnectorTool[];
  managed: boolean; // one-click managed OAuth available (needs cloud sign-in)
  managed_paused?: boolean;
  managed_profile: boolean;
  mode?: string; // "relay" for the managed cloud path; "" for manual/token connect
  workspaces?: SlackWorkspace[]; // Slack only
  accounts?: GmailAccount[] | AccountRow[]; // Gmail/Calendar or generic account connectors
  filters?: GmailFilters; // Gmail only
  portals?: HubSpotPortal[]; // HubSpot only
  hidden_fields?: string[]; // HubSpot only
  installations?: GithubInstallation[]; // GitHub only
}

// Slack health, three layers: relay socket / cloud sign-in / per-team tokens.
export interface SlackStatus {
  mode: string; // "relay" | "" (manual/off)
  relay: {
    state: "live" | "reconnecting" | "offline";
    reconnects: number;
    last_event_at: number | null;
    last_error: string;
  };
  signed_in: boolean;
  teams: Record<string, { token_ok: boolean }>;
}

// GitHub relay health: shared relay socket / cloud sign-in / per-installation tokens.
export interface GithubStatus {
  ok: boolean;
  mode: string;
  relay: {
    state: string;
    reconnects: number;
    last_event_at: number | null;
    last_error: string;
  };
  signed_in: boolean;
  installs: Record<string, { token_ok: boolean }>;
  missed: Record<string, number>;
}

// One workspace member from the roster (people picker).
export interface SlackMember {
  id: string;
  name: string;
  handle: string;
  guest: boolean;
}

// One channel from the workspace roster (private channels only where the bot is a member).
export interface SlackChannelEntry {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
}

export interface McpServer {
  name: string;
  enabled: boolean;
  transport: string;
  requires_approval: boolean;
  // "connected" | "configured" | "disabled" | and for auth:"oauth" servers:
  // "needs_auth" (no tokens yet) | "authorizing" (browser sign-in in flight)
  status: string;
  auth?: "oauth" | null;
  last_error?: string | null;
  tool_count: number | null;
  config: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: number;
  timestamp: string;
  session_id: string;
  agent: string;
  workspace: string;
  connector: string;
  tool: string;
  stage: string;
  status: string;
  approval: string;
  args: Record<string, unknown>;
  result_preview: string;
  reason: string;
  resource: string;
}

// ---------------------------------------------------------------------------
// Automations (scheduled tasks)
// ---------------------------------------------------------------------------

export interface Automation {
  id: string;
  title: string;
  instructions: string;
  schedule: string;
  schedule_raw?: { kind: string; cron?: string | null; fire_at?: string | null; timezone?: string };
  workspace: string;
  agent: string;
  enabled: boolean;
  next_run: number | null;
  last_run: number | null;
  last_status: string | null;
  run_count: number;
  notify_on_completion: boolean;
  // Runs started since the user last opened this automation's detail; `unseen_failed`
  // = the newest unseen run errored.
  unseen_runs?: number;
  unseen_failed?: boolean;
  seen_runs_at?: number;
  // Standing scoped approvals: target-bound rules this automation may exercise without
  // asking. `entry` is the raw record entry — the revoke handle.
  always_allowed: { entry: string; tool: string; target: string | null }[];
}

export interface AutomationRun {
  run_id: string;
  task_id: string;
  session_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  result_text: string | null;
  artifacts: string[];
  error: string | null;
  trigger: string;
}

export interface AutomationCreateInput {
  title: string;
  instructions: string;
  cron?: string;
  fire_at?: string;
  timezone?: string;
  // Standing grants (the creating surface rendered them; submit IS the consent).
  permissions?: { tool: string; target: string; access: "read" | "write" }[];
}

// A prepared live manual run: the GUI opens the returned session and drives it.
export interface PreparedRun {
  ok: boolean;
  error?: string;
  run_id: string;
  session_id: string;
  workspace: string;
  agent: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Settings / providers / memory / personas / web search
// ---------------------------------------------------------------------------

export interface SurfaceVisibility {
  cowork: boolean; // always true
  chat: boolean;
  code: boolean;
}

export interface Settings {
  provider: string;
  model: string;
  models: string[];
  has_key: boolean;
  model_ready: boolean;
  source: "env" | "store" | null;
  credential_source?: "env" | "store" | "mixed" | null;
  onboarded: boolean;
  surfaces: SurfaceVisibility;
  scratch_base: string;
  secrets_path: string;
  nav_layout?: "flat" | "grouped";
  sessions_peek?: number;
  context_bar?: boolean;
  model_labels?: Record<string, string>;
  model_context_windows?: Record<string, number>;
  pdf_fallback?: "text" | "images";
  pdf_max_pages?: number;
  pdf_max_mb?: number;
  compaction_threshold_pct?: number;
  compaction_cap_tokens?: number;
  compaction_model?: string;
}

export interface PdfSettings {
  pdf_fallback: "text" | "images";
  pdf_max_pages: number;
  pdf_max_mb: number;
}

export interface CompactionSettings {
  compaction_threshold_pct: number;
  compaction_cap_tokens: number;
  compaction_model: string;
}

export interface ProviderField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help: string;
  placeholder: string;
  default?: string;
  // Non-empty → segmented choice, not a text input. tag = badge; desc = one-liner;
  // command = copyable terminal command.
  choices?: { value: string; label: string; tag?: string; desc?: string; command?: string }[];
  show_when?: Record<string, string> | null;
}

export interface ProviderInfo {
  name: string;
  title: string;
  needs_key: boolean;
  fields: ProviderField[];
  configured: boolean;
  values: Record<string, string>; // non-secret stored values, for prefilling
  suggested_models: string[];
  recommended_model: string | null;
  blurb?: string;
  key_set_at?: string | null;
  last_used_at?: number | null;
  credential_source?: "env" | "store" | "mixed" | null;
  source?: "env" | "store" | "mixed" | null;
}

export type MemoryScope = "global" | "workspace" | "session";

// The list/add payloads serve the lean row ({id, scope, content}); the store has more
// fields (workspace/session_id/created_at) but does not currently expose them here.
export interface MemoryItem {
  id: number;
  scope: MemoryScope;
  content: string;
}

export interface Persona {
  id: string;
  name: string;
  icon: string;
  tagline: string;
  needs_workspace: boolean;
  builtin: boolean;
  family: string;
  workspace: string; // "git" | "project" | "deliverable" | "none"
  tools: string[];
  enabled: boolean;
  surfaced: boolean;
  default: boolean;
}

export interface PersonaConsent {
  id: string;
  name: string;
  description: string;
  tools: string[];
  risk: string[];
  connectors: boolean;
  mcp: string[];
  messaging: boolean;
  recommended_mode: string;
  recommended_models: string[];
  source: string | null;
  builtin: boolean;
}

// A persona's declared recommendation (manifest `recommends`), annotated server-side with
// the live connect state.
export interface PersonaRecommendation {
  kind: string; // "connector" | "mcp" | …
  ref: string;
  reason: string;
  tier: string; // "core" | "optional"
  connected: boolean;
}

// A persona-default connection: for a connected connector, whether new sessions of this
// persona get it enabled by default.
export interface PersonaDefaultConnection {
  connector: string;
  enabled: boolean;
  connected: boolean;
}

export interface PersonaDetail {
  id: string;
  name: string;
  icon: string;
  tagline: string;
  description: string;
  enabled: boolean;
  tools: string[];
  recommended_models: string[];
  default_permission_mode: string;
  workspace: string;
  recommends: PersonaRecommendation[];
  default_connections: PersonaDefaultConnection[];
}

export interface WebSearchSettings {
  provider: string;
  has_key: boolean;
  providers: string[];
}

// ---------------------------------------------------------------------------
// WebSocket protocol (/ws/session/{id})
// ---------------------------------------------------------------------------

// Server → client. The engine events come from coworker/events.py; "ready", "model_changed",
// "input_rejected" and "turn_done" are extra frames the server itself emits on the socket.
export type WsEvent =
  | {
      type: "ready";
      data: {
        session_id: string;
        agent: string;
        model: string;
        mode?: string;
        workspace: string | null;
        command_trust?: WorkspaceCommandTrust;
        // ACP runtime variant:
        runtime?: string;
        agent_session_id?: string;
        profile_id?: string;
      };
    }
  | { type: "turn_start"; data: { input: string } }
  | { type: "assistant_delta"; data: { text: string } }
  | { type: "reasoning_delta"; data: { text: string } }
  | {
      type: "assistant_message";
      data: {
        text: string | null;
        tool_calls: string[];
        reasoning?: string;
        usage?: UsageInfo;
        // ACP runtime variant:
        stop_reason?: string;
        agent_session_id?: string;
        profile_id?: string;
      };
    }
  | { type: "tool_proposed"; data: { name: string; arguments: Record<string, unknown> } }
  | {
      type: "permission_required";
      data: {
        name: string;
        arguments: Record<string, unknown>;
        reason: string;
        category?: string;
        // The exact target a standing rule could pin (server-computed), when eligible.
        standing_target?: string | null;
      };
    }
  | {
      type: "directory_requested";
      data: { reason: string; path?: string; writable?: boolean };
    }
  | {
      type: "question_requested";
      data: {
        question: string;
        options?: string[];
        allow_text?: boolean;
        multi?: boolean;
        header?: string;
      };
    }
  | { type: "plan_proposed"; data: { plan: string } }
  | { type: "tool_started"; data: { name: string } }
  | {
      type: "tool_finished";
      data: {
        name: string;
        status: string;
        result_preview?: string;
        reason?: string;
        display?: Record<string, unknown>;
        standing_rule?: string;
      };
    }
  | { type: "iteration_end"; data: { iteration: number } }
  | { type: "turn_end"; data: { status: string; iterations: number } }
  | { type: "error"; data: { error: string; error_type?: string; raw?: string } }
  | { type: "interrupted"; data: { iterations: number } }
  | { type: "compacting"; data: Record<string, never> }
  | { type: "compacted"; data: { text: string } }
  | { type: "model_changed"; data: { model: string; text: string } }
  | { type: "input_rejected"; data: { error: string } }
  | { type: "turn_done"; data: Record<string, never> };

// Client → server. Unknown/extra keys are rejected server-side with input_rejected.
export type WsCommand =
  | { type: "user_message"; text: string; model?: string; attachments?: Attachment[] }
  | { type: "approval"; decision: ApprovalDecision | string }
  | { type: "directory_response"; granted: boolean; path?: string; writable: boolean }
  | { type: "plan_response"; approved: boolean; mode?: string; feedback?: string }
  | { type: "question_response"; answer: string }
  | { type: "interrupt" }
  | { type: "retry" }
  | { type: "set_mode"; mode: PermissionMode }
  | { type: "set_model"; model: string };

// App-wide event stream (/ws/events): session-independent server pushes —
// automation_run_started (toast), agent_permission, agent_event, …
export interface AppEvent {
  type: string;
  data?: Record<string, unknown>;
}
