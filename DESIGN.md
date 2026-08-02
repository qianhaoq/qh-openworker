# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-03
- Primary product surfaces: QH 助理 desktop Home, Missions, Mission detail, Agents, Approvals, quick chat, and secondary settings surfaces.
- Evidence reviewed: `surfaces/gui/src/app/App.tsx`, `design.css`, `theme.ts`, `components/Icon.tsx`, `Sidebar.tsx`, `features/home/HomePage.tsx`, `features/agents/AgentsPage.tsx`, `features/missions/MissionsPage.tsx`, `features/assistant/TimelineView.tsx`, Tauri icon assets/config, `docs/acp-first-personal-agent.md`, and the 2026-08-03 Kimi Code read-only brand audit.

## Brand
- Personality: calm, capable, private, and operational; a trusted desktop colleague rather than an IDE clone or chatbot toy.
- Trust signals: local workspace visibility, explicit Agent identity and role, inspectable plans, scoped permissions, durable progress, test/review evidence, and clear recovery state.
- Display name: `QH 助理`; the in-product assistant is `Q`. Technical repository name, bundle identifier, data directories, and updater identity remain qh-openworker compatible.
- Brand mark: “空盔与一缕在场” — a front-facing rounded empty helmet, pill-shaped negative-space visor, and one neck wisp. The 16px mark omits the wisp; 20–32px may show it; App/Dock art uses the full composition; the macOS tray stays monochrome.
- Avoid: AI-purple gradients, marketing hero layouts, hidden automation, unexplained autonomous actions, emoji as product icons, dense terminal dashboards, decorative status noise, cat ears, yellow-black palettes, scythes, motorcycles, or a recognizable borrowed helmet silhouette.

## Product goals
- Goals: make Missions the primary work unit; lead a new user through workspace → verified main Agent → first Mission; let a configurable main Agent propose and coordinate a local team; make Agent status, permissions, artifacts, verification, and review legible in one place; show streamed work from its first meaningful delta.
- Non-goals: peer-to-peer Agent mesh, A2A federation, a Codex/Claude CLI compatibility shell, a new transcription engine, or screen-driving GUI automation in this milestone.
- Success signals: a clean-state user can select a workspace, add and genuinely handshake with Kimi or another installed local Agent, create a Mission without a model API key, see every response delta immediately, resume after restart, and understand every requested permission without opening developer tooling.

## Personas and jobs
- Primary personas: a single local power user/developer managing personal repositories, files, notes, and audio-derived memory.
- User jobs: ask the assistant to complete a coding goal; approve or adjust its proposed team; route follow-ups to the manager or a specialist; inspect code/test/review artifacts; register and probe local Agents; resolve sensitive actions safely.
- Key contexts of use: long-running desktop sessions, multiple local workspaces, intermittent Agent processes, offline or degraded model/provider connectivity, and tasks resumed after app restart.

## Information architecture
- Primary navigation: 首页, Missions, Agents, 审批. No configuration or protocol page competes with these four entries.
- Core routes/screens: Home/readiness, Mission list, Mission detail with its conversation, Agents registry/editor, Approvals inbox, quick chat on Home, and secondary settings surfaces. The legacy assistant route redirects to Home unless it names an existing quick-chat session.
- Content hierarchy: user attention first; active Missions second; completed/recent work third; system configuration last.
- Conversation is a thread within a Mission, not the top-level navigation model.
- First-run hierarchy: show exactly one next action from live readiness — choose workspace, add and test a main Agent, or create the first Mission. `onboarded` never substitutes for this computation.

## Design principles
- Mission before chat: every material coding action belongs to a durable Mission with state, team, artifacts, and evidence.
- Propose before acting: the main Agent produces a structured team plan; no write attempt starts before confirmation.
- One amber focus: amber is reserved for the single class of state that needs the user now. Background activity stays neutral or blue.
- Explicit routing: every composer shows whether a message targets the main Agent or a named attempt.
- Progressive operational detail: Home is calm; Mission detail reveals timeline, seats, permissions, artifacts, and review depth as needed.
- Preserve durable truth: UI state is projected from API/ledger data and never invents execution status locally.
- Reveal work immediately: body deltas are visible from the first non-empty event; reasoning and tool execution remain separate, inspectable streams. RequestAnimationFrame may batch paint, never semantic event order.

## Visual language
- Color: warm-neutral paper and panels; deep ink text; indigo/cobalt accent; amber only for attention; red for blocker/failure; green for verified success. All colors come from semantic CSS tokens and support light/dark themes.
- Typography: system sans for UI, existing self-hosted Manrope for the wordmark, monospace only for code, commands, IDs, and paths.
- Spacing/layout rhythm: 4px base with 8, 12, 16, 20, 24, and 32px steps. Home favors breathing room; Mission detail may be denser.
- Shape/radius/elevation: restrained 8-12px radii, hairline borders, low elevation; overlays and approvals use stronger elevation only when modal attention is required.
- Motion: <=200ms for navigation/drawers/status transitions; the helmet wisp is the only ambient brand motion and only while work is running; it disappears when disconnected and becomes fully static under `prefers-reduced-motion`.
- Imagery/iconography: custom line icons on a 24x24 viewBox with rounded caps/joins. Main/navigation actions use 2px stroke; compact inline icons use 1.5px. Render at 12, 14, 16, 20, or 24px only. No emoji/Unicode function glyphs. Provider logos remain vendor assets.
- Brand assets: one 1024 SVG master drives App/Dock/installer assets; a separate smoke-free 16px-class favicon and monochrome macOS tray master protect small-size legibility; Windows keeps a platform fallback.

## Components
- Existing components to reuse: Composer input/attachments/voice, Transcript streaming and thinking blocks, PlanCard confirmation semantics, ApprovalCard, ArtifactViewer/RightRail internals, theme support, workspace/session transport primitives.
- New/changed components: AppShell/NavRail, HomePage readiness step, MissionList, MissionDetail, MissionPlanCard, MissionTimeline, AgentSeatBoard, MessageTargetPicker, Agents registry/editor, AddAndTest flow, ApprovalInbox, shared Drawer/Dialog, ArtifactDrawer, MemoryDigest, AudioDigest.
- Variants and states: plan proposed/confirmed/rejected; Agent idle/running/waiting/blocked/done/disconnected; Mission planning/awaiting confirmation/queued/implementing/verifying/reviewing/approved/done/blocked/cancelled; permission pending/allowed/denied/expired.
- Token/component ownership: Kimi owns presentational components, CSS, icon SVGs, and visual tests. Codex owns API/controller/view-model types, orchestration behavior, Tauri wiring, persistence, permissions, and integration tests.

## Accessibility
- Target standard: WCAG 2.2 AA for desktop webview behavior.
- Keyboard/focus behavior: all primary flows work without a pointer; drawers/dialogs set initial focus, trap and restore focus, expose `aria-modal`, close from Escape or backdrop, and confirm before discarding dirty drafts. A focused text/recording control consumes Escape before an enclosing overlay. Agent seats and Mission rows expose clear focus rings.
- Contrast/readability: semantic tokens must meet AA contrast; state is communicated by icon and text, never color alone; long paths retain a readable name plus copy/full-title affordance.
- Screen-reader semantics: streaming uses `aria-live="polite"`; urgent permission/blocker states use assertive announcements; plan and approval groups use labelled regions; icon-only buttons have localized accessible names.
- Reduced motion and sensory considerations: disable pulsing and animated transitions under reduced motion; avoid continuous spinners when progress text is available.

## Responsive behavior
- Supported breakpoints/devices: native desktop first at 1440x900 and 1100x720; usable down to 1024px wide.
- Layout adaptations: Mission team/artifact rails collapse into drawers below 1180px; Home and list pages remain single-scroll-column; navigation can collapse without hiding the current page title.
- Touch/hover differences: no hover-only critical action; row actions remain keyboard accessible and appear on focus.

## Interaction states
- Loading: preserve shell and show scoped skeletons/status text; never blank the whole desktop after boot.
- Empty: explain the next useful action, such as creating a Mission or registering an Agent; do not display marketing copy.
- Error: identify the failed Agent/API/session in Chinese, retain recoverable input, and offer a structured repair/retry action without hiding partial artifacts. Unknown internal events are logged, not surfaced verbatim as toasts.
- Success: summarize outcome, changed files, tests, review verdict, and known gaps.
- Disabled: state why an Agent/action is unavailable, especially failed capability probe or immutable reviewer policy.
- Offline/slow network: keep durable Mission history readable with a visible stale-cache label, show a single offline banner, remove the brand wisp, and queue only operations whose idempotency contract is known.

## Content voice
- Tone: concise, calm, direct, and evidence-led.
- Terminology: user-facing surfaces use `Q`, `Mission`, `Agent`, `审批`, and `产物`. ACP, transport, profile IDs, raw capability names, and protocol role identifiers appear only in advanced configuration or diagnostics.
- Microcopy rules: lead with what needs attention; avoid anthropomorphic promises; distinguish planned, running, verified, blocked, and unknown delivery states.

## Implementation constraints
- Framework/styling system: React 18, TypeScript, Vite, existing CSS/Tailwind surfaces, and Tauri 2. Do not add a new state-management or icon dependency.
- Design-token constraints: extend existing semantic CSS variables; do not hard-code business colors inside SVGs or components.
- Performance constraints: Mission timelines must render incrementally and deduplicate by ledger cursor/event ID; inactive drawers should not trigger polling loops.
- Compatibility constraints: preserve existing bundle ID, updater/data paths, session APIs, `/v1/team/*` compatibility, theme preference, voice input, artifact previews, and provider logos.
- Security constraints: command and args stay separate; secrets remain references; reviewer is immutable read-only. ACP is a host-to-Agent protocol and permission-policy boundary, not an operating-system sandbox; unsafe host access still requires explicit product policy and user approval. Kimi Code's visual pass is read-only; Codex owns implementation and verification.
- Test/screenshot expectations: Vitest and Python contract tests, hermetic Playwright Mission flow, 1440x900 and 1100x720 screenshots in light/dark where supported, icon asset validation, fresh Tauri smoke, and a Kimi screenshot review using synthetic data only.

## Open questions
- [ ] Native fresh-build environment / Codex / install or otherwise provide CMake before final Tauri acceptance.
- [ ] Legacy Workspace removal timing / product owner / remove only after the new Mission shell passes one stable release cycle.
