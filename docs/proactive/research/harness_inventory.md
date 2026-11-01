# Proactive-agent building blocks in our harness (codebase inventory)

All citations are `path:line` in E:/github_repos/AI-Projects/agent-harness-web (read at commit e0b178d, 2026-11-01). Nothing was modified.

## Scheduling: is there a schedule tool, cron, timers, scheduled runs? Where do they execute and how are results surfaced?

### Takeaway
There is already a complete server-side scheduler (5-field cron, one-time runs, secret-URL triggers, multi-server leases, plugin-aware skipping) plus an agent-facing `schedule` tool and a REST API. What is thin is the result side: a run is recorded only as "started"; the actual outcome lives in the target session's transcript, and the desktop shows a one-line toast.

### Cited Findings
- `Schedule` record: id, owner, title, prompt, `cron` (5-field, server time zone), `at` (one-time), target `sessionId` OR `newSession {model, runtime, mode}`, `enabled`, `triggerHash`, `nextRun/lastRun/lastResult/runs`, `plugin` — [src/core/scheduler.ts:13-35](src/core/scheduler.ts)
- Own cron parser (`parseCron`, `nextCron`, minute resolution, searches about a year ahead); no cron library — [src/core/scheduler.ts:43-82](src/core/scheduler.ts)
- Persisted to `<dataDir>/schedules.json` under a file lock with atomic writes; a cap of `HARNESS_MAX_SCHEDULES` (default 50) per owner — [src/core/scheduler.ts:40,134-169,202](src/core/scheduler.ts)
- Timer: `setInterval` every 30 s (unref'd) and one tick at start. Runs missed while the server was down fire once on start — [src/core/scheduler.ts:171-176](src/core/scheduler.ts)
- `tick()` claims each due run on disk first (moves `nextRun`, or disables a one-time schedule), then launches it. This makes it fire-once across several servers. Only the holder of the `scheduler` lease ticks — [src/core/scheduler.ts:272-313](src/core/scheduler.ts); [src/kernel/harness.ts:940](src/kernel/harness.ts)
- Pre-run gates in `launch()`: the owner's account is disabled, the owner is over the concurrency limit (`mayRun`), or the plugin is switched off (`pluginOff`). Each produces a `lastResult` string instead of a run — [src/core/scheduler.ts:125-132](src/core/scheduler.ts); wired at [src/server/app.ts:210,226](src/server/app.ts) and [src/kernel/harness.ts:946-949](src/kernel/harness.ts)
- Where a run executes: the runner in `createHarness` either sends into the existing session (skipped if the session is busy or its lease is held elsewhere) or creates a new session titled `Scheduled: <title>` with mode `dontAsk` by default. It then calls `session.send("(Scheduled task "<title>", run N.)\n\n<prompt>")`. It returns `{result:'started'}` immediately, not the turn's outcome — [src/kernel/harness.ts:911-936](src/kernel/harness.ts)
- Agent tool `schedule` (create/list/delete; `in_minutes`, ISO `at`, or `cron`). It is limited to the agent's own session (`sessionId: this.meta.id`). `kind: 'external'` means it is confirmed like an action on another system, and `persists` on create means it is confirmed after untrusted content — [src/tools/schedule.ts:10-52](src/tools/schedule.ts); services wiring in [src/core/session.ts:1055-1059](src/core/session.ts) (main agent only; sub-agents/scripts get "Scheduling is not available here", [src/tools/schedule.ts:35](src/tools/schedule.ts))
- REST: `GET/POST /api/schedules`, `DELETE /api/schedules/:id`, `POST …/run|enable|disable`. A `newSession` outside a docker sandbox is admin-only, local paths must sit under `HARNESS_LOCAL_ROOTS`, and the default mode is `dontAsk` — [src/server/app.ts:1241-1285](src/server/app.ts)
- Results surfacing: `Scheduler.onEvent` sends `fired`/`changed` to the EventHub `schedules` topic (with `lastResult`, `sessionId`) — [src/kernel/events.ts:107](src/kernel/events.ts), [src/kernel/harness.ts:944](src/kernel/harness.ts). The desktop reacts only with a toast `Scheduled: <title> ran` — [apps/desktop/renderer/src/state/data.ts:213](apps/desktop/renderer/src/state/data.ts)
- Desktop UI: Settings > Schedules (account scope) lists schedules with an enable switch, Run now and Delete, and has a "New schedule" form (title, prompt, cron or in-minutes) — [apps/desktop/renderer/src/builtins/core.settings/server-sections.tsx:311-341](apps/desktop/renderer/src/builtins/core.settings/server-sections.tsx); manifest entry [core.settings/manifest.ts:20](apps/desktop/renderer/src/builtins/core.settings/manifest.ts)
- The desktop "New schedule" form posts only `{title, prompt, cron|inMinutes}`, with no `sessionId` or `newSession` — [server-sections.tsx:338](apps/desktop/renderer/src/builtins/core.settings/server-sections.tsx). The client type has no `newSession` field — [packages/client/src/http.ts:330](packages/client/src/http.ts). `Scheduler.create` throws `a schedule goes to a session, or makes a new one` when both are missing — [src/core/scheduler.ts:193](src/core/scheduler.ts)
- A second, independent scheduler exists for data/dashboards: `DataService.start()` runs a 15 s `setInterval` for dataset/doc refreshes (interval or cron), measure alerts and cron subscriptions (exports or notify). It holds the `data-schedule` lease — [src/data/service.ts:401-446](src/data/service.ts); started in [src/kernel/harness.ts:978-984](src/kernel/harness.ts)
- Data alerts: after a refresh, `checkAlerts` evaluates `doc.alerts` thresholds. On a state change it records a run (`kind:'alert'`) in `runs.jsonl` and emits a `data` event — [src/data/service.ts:377-395](src/data/service.ts)
- The `~/.harness/data/data/operator/` folder (oplog.jsonl, runs.jsonl, state.json, usage.json) is the data service's per-owner home. `operator` is the name used when no account owns it. `oplog.jsonl` holds dashboard/catalog edit ops, `runs.jsonl` holds refresh/alert/subscription runs, `state.json` holds dataset and doc refresh/alert state, and `usage.json` holds view counts — [src/data/home.ts:39,95-121,27-30](src/data/home.ts). It is not an agent-run log.

### Inferences
- Core scheduling infrastructure (persistence, cron, leases, catch-up, concurrency gating) is production-grade. A proactive feature does not need a new scheduler. It needs richer run records (outcome, cost, summary) and a review surface.
- The desktop Schedules form appears unable to create a working schedule, because it supplies neither a target session nor a new-session spec. I did not run it to confirm. The error-to-HTTP mapping for `ScheduleError` was not traced.
- "Catch-up" fires only once per missed schedule. There is no misfire policy (skip, run all, coalesce) and no jitter.

### Gaps
- No per-run history for agent schedules (only `lastRun/lastResult/runs` counters). There is no runs list, cost per run, or link to the outcome other than `sessionId`.
- No time-zone field (server time only), no quiet hours, and no "run only when the app is open" vs "always" distinction.
- The Desktop Schedules UI cannot pick a target session, model, runtime or mode, and cannot create triggers.

## Event triggers: webhooks, file watchers, git/CI events, inbound messages, integrations, MCP notifications, companion, linked sessions

### Takeaway
Generic inbound events exist as secret-URL triggers (any webhook, Slack slash command, curl). Plugins can also subscribe to the harness event bus and start sessions (integrations does this for chat "investigate", aiops for alerts). There is no file-system watcher, git/CI watcher, MCP-notification handling, or declarative "on event X run agent Y" rule engine in the core.

### Cited Findings
- Triggers: `createTrigger` returns an `hwt_…` token once and stores a SHA-256 hash. `fireTrigger` does a timing-safe compare, then launches with the caller's body as `outside` text (capped at 20k) — [src/core/scheduler.ts:215-243](src/core/scheduler.ts)
- `POST /api/triggers/:token` is rate-limited per IP and accepts JSON `{text}`, a Slack form `text=`, or plain text (64 KB max). It returns 202 with `{ok, result, session}` — [src/server/app.ts:722-738](src/server/app.ts)
- Trigger payloads are fenced in `<trigger_payload>` and tag-neutralised, and the session is `markUntrusted()` — [src/kernel/harness.ts:925-928](src/kernel/harness.ts)
- EventHub: an in-memory ring of 1000 (`HARNESS_EVENTS_RING`) across topics `sessions, session, approvals, schedules, plugins, notices, proposals, linked, artifacts, chapters, client, data`. It is served as SSE at `GET /api/events` with Last-Event-ID replay. Numbering restarts with each server start — [src/kernel/events.ts:5-54](src/kernel/events.ts), [src/server/app.ts:640,773](src/server/app.ts)
- Plugin API for event-driven work: `api.events.subscribe`, `api.sessions.start/send({untrusted})/respond/get`, `api.lease(name)` for server loops, and `api.signal(name)` for badges — [src/plugins/api.ts:118,154,206-218](src/plugins/api.ts) (signal/lease docs around lines 100-160)
- Integrations plugin (built-in): two-way Slack/Teams, PagerDuty/Opsgenie, Jira/ServiceNow. Approval/permission requests are posted with buttons and decided from chat via `api.sessions.respond`. The chat command "investigate <text>" starts a session with the text fenced as untrusted, and progress and summary are posted back to the thread — [plugins/integrations/lib/hub.mjs:1-10,456,475-497](plugins/integrations/lib/hub.mjs); [plugins/integrations/index.mjs:1-20,79](plugins/integrations/index.mjs)
- Operations solution (aiops): Alertmanager, Grafana, PagerDuty V3 and Datadog webhooks feed alert grouping into incidents. An investigation is a session running the incident-response workflow with alerts and recent changes as fenced, untrusted input — [solutions/operations/plugins/aiops/lib/alerts.mjs:3,20-21,113-170](solutions/operations/plugins/aiops/lib/alerts.mjs)
- aiops model-free watch loop: rules are evaluated on a `setInterval` (`HARNESS_OPS_WATCH_SECONDS`, default 60) under the `ops-watch` lease. A model runs only when an incident opens or escalates. It replaced an every-5-minute agent workflow (288 runs a day). It uses no vault credentials because nobody is there to approve — [solutions/operations/plugins/aiops/lib/watch.mjs:1-15,66,99-102](solutions/operations/plugins/aiops/lib/watch.mjs)
- Data service event-driven refresh: a doc with `refresh {mode:'event', event:'topic[:type]'}` refreshes on matching EventHub events — [src/data/service.ts:407-408,458-468](src/data/service.ts)
- File changes: `FileChanged` hooks fire on agent writes ([src/core/agent.ts:832-835](src/core/agent.ts)) and on user edits made through the app (`userChangedFiles`), which queues a reminder for the agent's next step — [src/core/session.ts:2640-2652](src/core/session.ts). The only `fs.watch` uses are desktop dev tooling (plugin dev reload, renderer reload) — [apps/desktop/electron/dev-watch.ts:48](apps/desktop/electron/dev-watch.ts), [apps/desktop/electron/main.ts:367](apps/desktop/electron/main.ts)
- MCP client: it sends `notifications/initialized` and `notifications/cancelled` only. There is no handling of server-initiated notifications (`resources/updated`, `list_changed`) — [src/mcp/client.ts:163,179](src/mcp/client.ts)
- Companion: an outbound long-poll process that runs tool calls in a local folder for a server session. It is a remote executor, not an event source — [src/runtime/companion.ts:1-10](src/runtime/companion.ts), [src/companion/main.ts:1-4](src/companion/main.ts)
- Linked sessions: a child reports to its parent at the end of each turn and may auto-wake an idle parent. This is limited by `linkedSessions.autoContinue` / `maxAutoContinues` (`HARNESS_LINKED_MAX_AUTO`, default 5), concurrency, and the daily spend cap — [src/core/linked.ts:12-23](src/core/linked.ts), [src/core/session.ts:1262-1274](src/core/session.ts)

### Inferences
- Event-triggered agents are possible today in two ways. Any system that can POST can use a trigger URL. Code-level triggers need a plugin (`api.events.subscribe` + `api.sessions.start`). There is no user-facing way to declare an event → agent rule.
- The aiops watch loop is the clearest in-repo pattern for cheap proactive monitoring: deterministic detection, with a model only on state change. A core proactive design should generalise it.

### Gaps
- Not found: workspace file watcher, git hooks/poller, CI-status watcher, email/IMAP or calendar sources, MCP notification subscriptions, and a generic "watch" primitive in core.
- EventHub is in memory only, so events are lost on restart. There is no durable event log or at-least-once delivery for triggers.

## Initiative and approval: proposals, ask_user, permission modes, hooks, progress reviews, pending cards

### Takeaway
The harness already encodes a three-level initiative model for spawning work (`user_asked` runs now; `offer` and `own_initiative` become a proposal the person starts or dismisses). It also has a rich approval stack: modes, rules, a taint guard, hooks, plan mode, ask_user, and progress reviews. There is no initiative policy for unattended runs beyond `dontAsk` (refuse anything that would ask).

### Cited Findings
- `Initiation = 'user_asked' | 'offer' | 'own_initiative'`. `offer` and `own_initiative` become a `Proposal` (open/started/dismissed/expired, `PROPOSAL_DAYS = 7`, max 20 open per session) and nothing runs until the person acts. Linked depth is 2, and at most `HARNESS_LINKED_MAX` (default 4) children work at once — [src/core/linked.ts:12-35,149-212,245-250](src/core/linked.ts)
- Proposal API: `POST /api/proposals/:id/start|dismiss` (owner only), `GET /api/sessions/:id/proposals` — [src/server/app.ts:1415-1426,1563](src/server/app.ts). Tools `start_session`, `dismiss_proposal`, `hand_off` — [src/tools/sessions.ts:32,79,94](src/tools/sessions.ts)
- Desktop: proposal cards in the transcript, the Agents panel/page, and the Agents home "proposals waiting" — [apps/desktop/renderer/src/builtins/core.agents/manifest.ts:3-25](apps/desktop/renderer/src/builtins/core.agents/manifest.ts), [core.agents/proposals.ts:1-5](apps/desktop/renderer/src/builtins/core.agents/proposals.ts)
- Permission modes: `'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'plan' | 'bypass'` — [src/core/types.ts:65](src/core/types.ts). `dontAsk` turns every "ask" into a deny with "add an allow rule for it" — [src/core/permissions.ts:182-185](src/core/permissions.ts). Scheduled and new sessions default to `dontAsk` — [src/kernel/harness.ts:922](src/kernel/harness.ts), [src/server/app.ts:1266](src/server/app.ts)
- `ask_user`, `enter_plan_mode`, `exit_plan_mode` tools — [src/tools/meta.ts:15,83,100](src/tools/meta.ts). Pending request kinds collected for the inbox: `permission_request, question, plan_proposed, approval_request` — [src/kernel/events.ts:20-22](src/kernel/events.ts)
- Background work's questions outlive the turn (`background` flag on pending requests) — [src/core/session.ts:2460-2470](src/core/session.ts)
- Hooks (Claude-Code compatible): `SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Notification, SubagentStart, SubagentStop, PreCompact, PostCompact, Stop, StopFailure, InstructionsLoaded, ConfigChange, FileChanged, WorktreeCreate, WorktreeRemove, TaskCreated, TaskCompleted` — [src/core/settings.ts:15-19](src/core/settings.ts)
- Progress review at the step budget: cheap signals each step, then extend by a block, ask a small reviewer model, refresh from a handoff, or stop. There are hard ceilings (extensions, refreshes, absolute cap) and a false-"done" check. Env `HARNESS_PROGRESS_*` — [src/core/progress.ts:4-48,384-413](src/core/progress.ts); runtime in [src/core/agent.ts:279-299,413-447](src/core/agent.ts)
- Workflow graphs include `approval` nodes (human gate with approve/reject branches) — example at [src/graph/format.ts:13](src/graph/format.ts)

### Inferences
- The proposal mechanism is the natural "suggest" tier of a proactive agent. It already persists, expires, is owner-scoped, and has UI. But it is tied to a parent session and only creates sessions. A proactive agent would need proposals with no parent conversation and other action types (draft, message, change).
- An unattended run can either act within allow rules or be refused (`dontAsk`). There is no "park the request in the inbox and wait for the person" mode for scheduled runs, although the machinery exists: pending requests with a background flag, plus the inbox.

### Gaps
- Not found: any notify/ask/act policy keyed on confidence, impact, reversibility or user preference. Also not found: per-schedule permission profiles (beyond mode) and interruption budgets or quiet hours.

## Background execution: shells, sub-agents, monitor/task_output, workflows, survival across restarts

### Takeaway
In-session background work is mature (Claude-Code-style tasks, monitor, background workflows) but lives in server memory. On restart the task list is forgotten, interrupted turns are closed out, and they resume only with `HARNESS_AUTO_RESUME=1`. An idle session is not woken by finished background work unless `HARNESS_BACKGROUND_WAKE=1`.

### Cited Findings
- Tasks: `task_list`, `task_output`, `task_stop`, `monitor` (regex wait without model calls; up to 600 s foreground, or a background reminder up to an hour), `send_message`. The registry is in memory, so "a restart forgets it; shells keep running" — [src/tools/tasks.ts:1-5,154-287](src/tools/tasks.ts), [src/tools/tasks.ts:230-245](src/tools/tasks.ts); [src/core/session.ts:392-393](src/core/session.ts); README "Scheduled work and sub-agents" — [README.md:1242-1262](README.md)
- `workflow` tool with `run_in_background` returns a run id. The outcome arrives as a reminder — [src/tools/schedule.ts:54-100](src/tools/schedule.ts)
- Delivery: background results are queued as a fenced `<background_output>` reminder. If idle, the session shows a notice and fires `Notification` hooks. It auto-starts a turn only with `HARNESS_BACKGROUND_WAKE=1` — [src/core/session.ts:1795-1814](src/core/session.ts); env table [README.md:1505](README.md)
- Restart: `SessionManager.load` calls `recoverInterrupted()` (dangling tool calls get "Not run: the server restarted…", plus a notice to send "continue") and `recoverRuns()`. It auto-continues only with `HARNESS_AUTO_RESUME=1` — [src/core/manager.ts:30-45](src/core/manager.ts), [src/core/session.ts:714-722](src/core/session.ts), [README.md:1418](README.md)
- Workflow runs paused because a plugin is off are persisted (`PausedRuns`) and continue when it is switched back on — [src/graph/paused.ts:3-15](src/graph/paused.ts); [README.md:361-365](README.md)
- Multi-server: session leases mean only the lease holder drives a session. A server that takes over closes out the turn — [src/core/session.ts:548-590](src/core/session.ts), [src/core/manager.ts:54-56](src/core/manager.ts)
- Desktop lifecycle: the engine runs inside the Electron app. Closing the window quits the app unless "Keep running in the tray" (`keepInTray`, default false) is on — [apps/desktop/shared/prefs.ts:30,75](apps/desktop/shared/prefs.ts), [apps/desktop/electron/main.ts:207,294-297,376](apps/desktop/electron/main.ts), [apps/desktop/renderer/src/builtins/core.settings/app-sections.tsx:101](apps/desktop/renderer/src/builtins/core.settings/app-sections.tsx)

### Inferences
- On the desktop, schedules fire only while the app (or its tray icon) is running. Missed runs fire once at next start. With the tray off by default, a "proactive desktop agent" stops when the window closes. An OS-level launcher (login item / Task Scheduler) is not present.
- Durable background jobs that survive restart (a persisted task registry) would be needed for long-running proactive work.

### Gaps
- Not found: login-item/auto-start, OS scheduler integration, or a persisted task registry.

## Notifications and surfaces in the desktop app

### Takeaway
There is an "Inbox" (Waiting for you) for pending requests across all conversations, with a sidebar badge, a status-bar item and OS notifications. An Agents home/page shows work in progress and proposals. There is no inbox for proactive results (findings, reports, digests, suggestions): a scheduled run's output is just another conversation plus a toast.

### Cited Findings
- `core.inbox` builtin: the "Waiting for you" page groups pending approvals, questions, plans and workflow approvals by session. It has a nav badge `core.inbox.pending` and a status item "{n} waiting" — [apps/desktop/renderer/src/builtins/small.tsx:6,208-272](apps/desktop/renderer/src/builtins/small.tsx). Server feed `GET /api/approvals` — [src/server/app.ts:774-782](src/server/app.ts)
- OS notifications: IPC `notify:show` shows an Electron `Notification` only when the window is not focused (unless forced) and prefs allow, flashes the frame, and routes the click to a view — [apps/desktop/electron/ipc.ts:129-140](apps/desktop/electron/ipc.ts). Fired for approvals still pending after `NOTIFY_AFTER_MS` — [apps/desktop/renderer/src/state/data.ts:194-208](apps/desktop/renderer/src/state/data.ts). Preference "Notify me" — [core.settings/app-sections.tsx:86](apps/desktop/renderer/src/builtins/core.settings/app-sections.tsx)
- Global-stream toasts: only `warn`/`error` notices are toasted, and schedule `fired` gives an info toast — [apps/desktop/renderer/src/state/data.ts:212-213](apps/desktop/renderer/src/state/data.ts)
- Agent tools: `notify_user` emits a session `notice` (info) and fires `Notification` hooks (chat, phone) — [src/tools/schedule.ts:103-118](src/tools/schedule.ts), [src/core/session.ts:1077-1080](src/core/session.ts). `desktop_notify` is forwarded to the attached desktop client only — [src/tools/desktop.ts:88-98](src/tools/desktop.ts)
- Agents home: KPIs ("waiting for you" links to the inbox), work in progress, proposals waiting, and recent artifacts — [apps/desktop/renderer/src/builtins/core.agents/Home.tsx:1-5,29,48](apps/desktop/renderer/src/builtins/core.agents/Home.tsx); "Working now" nav badge `core.agents.working` — [core.agents/manifest.ts:13](apps/desktop/renderer/src/builtins/core.agents/manifest.ts)
- Plugin badge sources: polled routes (at least 15 s) or `api.signal` push — [apps/desktop/renderer/src/state/badges.ts:1-30](apps/desktop/renderer/src/state/badges.ts)
- Tray exists (`createTray`) — [apps/desktop/electron/main.ts:294-351](apps/desktop/electron/main.ts)
- The design doc planned `core.scheduled` and `core.activity` (background tasks and runs) builtins and an event stream that "drives the tray, badges and the inbox" — [docs/desktop/DESIGN.md:181-203,226,248](docs/desktop/DESIGN.md). Only `core.inbox` exists in `builtins/` today. Schedules live in Settings.

### Inferences
- An `info` notice from `notify_user` in a background or scheduled session does not appear to produce a desktop toast or OS notification (only warn/error notices are toasted, and OS notifications fire for approvals). A scheduled agent's "I found X" may go unseen unless a Notification hook is configured. This should be verified in a running app.
- The existing Inbox (data model `ApprovalItem`, badge, grouping, respond actions, Slack/Teams mirroring via integrations) is the obvious base for an agent inbox. It needs new item kinds: result, suggestion, digest, with read/unread, snooze and dismiss state.

### Gaps
- Not found: a persisted inbox or notification history, read/unread state, digest/batching, or the planned `core.scheduled` / `core.activity` views.

## Memory and user model; learning from accept/dismiss

### Takeaway
There is an agent-maintained Markdown memory (user and project scopes) with guards. Nothing learns from proposal accept/dismiss or approval decisions.

### Cited Findings
- Memory store: `/memories/user` (every project) and `/memories/project` (keyed by git remote or folder). Paths are confined, sizes capped, secret-looking text refused, changes logged, and the content is loaded as fenced notes rather than instructions — [src/memory/store.ts:1-16](src/memory/store.ts); tool `memory` — [src/tools/memory.ts:14-28](src/tools/memory.ts)
- Writing memory after untrusted content needs confirmation (`persists`) — [src/core/permissions.ts:167-170](src/core/permissions.ts)
- Proposal dismissal only records `status:'dismissed', resolvedAt` and emits `proposal_resolved` — [src/core/linked.ts:189-197](src/core/linked.ts)

### Inferences
- The proposal store (status, resolvedAt, initiation) and approvals (decision, feedback) already capture the raw signal needed for learning. Nothing aggregates it.

### Gaps
- Not found: preference learning, per-suggestion-type acceptance rates, feedback-driven thresholds, or a user model beyond free-form memory files.

## Cost controls for background runs

### Takeaway
Three layers already apply to scheduled and background runs: a per-conversation `maxCostUsd`, a per-account daily cap, and per-account concurrency limits. There is no per-schedule budget or monthly cap for proactive work.

### Cited Findings
- Per-conversation cap `maxCostUsd` (`HARNESS_MAX_COST_USD`, default 5; 0 means no limit) stops the turn — [src/core/settings.ts:160](src/core/settings.ts), [src/core/session.ts:1562-1563](src/core/session.ts)
- Per-account daily cap: `SpendLedger` (`spend.json`, `HARNESS_USER_DAILY_USD`, resets at midnight UTC) — [src/server/users.ts:222-278](src/server/users.ts), [src/server/main.ts:46](src/server/main.ts). Checked on typed messages ([src/server/app.ts:1497](src/server/app.ts)) and on linked auto-wake ([src/core/session.ts:1268](src/core/session.ts)). Charges are added per call ([src/core/session.ts:1083,1546](src/core/session.ts))
- Scheduler pre-run gate is concurrency only (`running` / `sandboxes` limits) — [src/server/app.ts:223-226](src/server/app.ts)
- Delegation cap for other-model agents (`delegation.maxCostUsd`) — [src/core/settings.ts:129-138](src/core/settings.ts), [src/core/session.ts:1278-1281](src/core/session.ts)
- Workflow tool reports run cost — [src/tools/schedule.ts:96](src/tools/schedule.ts)

### Inferences
- The scheduler's `mayRun` does not call `spend.over()`. A scheduled run over the daily cap starts and is presumably stopped later by in-session checks. I did not trace whether `session.send` itself enforces the daily cap.
- A new-session-per-run schedule gets a fresh per-conversation `maxCostUsd` each run. Over time only the daily cap bounds it.

### Gaps
- Not found: per-schedule or per-trigger budget, monthly cap, cost reporting per schedule, or a model-free pre-check pattern in core (it exists only in aiops watch).

## Safety: untrusted-content guard, sandboxing, network policy, vault

### Takeaway
Safety is a strong existing base for unattended agents. Inputs from triggers are fenced and taint the session. After taint, any persisting or data-exfiltrating call needs a human (never auto mode's model). Runtimes are sandboxed with a network policy. Secrets come from a vault and are redacted.

### Cited Findings
- Invisible-character stripping, tag neutralising and `fenceOutside` — [src/core/untrusted.ts:1-62](src/core/untrusted.ts)
- Taint guard: after untrusted content, only operator allow rules hold. Persisting or `sendsOut` calls are asked with `guard: true` (only a person or operator hooks may answer, never the auto-mode checker). Vault-secret commands are asked. `HARNESS_TAINT_GUARD=off` disables it — [src/core/permissions.ts:21-35,128-179](src/core/permissions.ts). The session's untrusted flag is kept across restarts — [src/core/session.ts:120,632](src/core/session.ts)
- In `dontAsk`, guarded asks become denies — [src/core/permissions.ts:183-184](src/core/permissions.ts)
- Scheduled new sessions: non-docker is admin-only; network `none | allowlist | full`, default `none` — [src/server/app.ts:1254-1266](src/server/app.ts). Runtimes: docker, local OS sandbox, egress proxy — [src/runtime/](src/runtime/) (docker.ts, os-sandbox.ts, egress-proxy.mjs)
- Vault with operator, user and session scopes, audit actor, and redaction — [src/vault/store.ts:279-372](src/vault/store.ts), [src/vault/redact.ts](src/vault/redact.ts)
- Trigger and plugin-started sessions mark content untrusted — [src/kernel/harness.ts:925-928](src/kernel/harness.ts); [src/plugins/api.ts:41](src/plugins/api.ts)

### Inferences
- For scheduled/event agents, the main safety gap is not the guard itself. The gap is that guarded asks in `dontAsk` are dropped rather than parked for review. That makes "act within allow rules, ask for the rest later" impossible today.

### Gaps
- None found beyond the inferences above.

## Docs and plans already written

### Takeaway
No design doc in the repo addresses proactive, ambient or initiative behaviour as a feature. Related material is scattered across the README (scheduling, triggers, background work), docs/desktop/DESIGN.md (planned Scheduled/Activity/Inbox builtins, proposals), and the Operations solution (model-free watch loop).

### Cited Findings
- `docs/harnessing/HARNESSING.md` does not exist in the repo (no `HARNESSING.md` anywhere outside node_modules). The `docs/` folder holds: `Agent harnesses and Claude Code.md`, `BUILD-A-PLUGIN.md`, `HANDOFF.md`, `desktop/DESIGN.md`, `plugin-sdk/README.md`
- README sections "Scheduled work and sub-agents" and the env table (`HARNESS_AUTO_RESUME`, `HARNESS_BACKGROUND_WAKE`) — [README.md:1242-1262,1418,1505](README.md). API table row `/api/schedules`, `/api/triggers/:token` — [README.md:1138](README.md)
- DESIGN.md: planned builtins `core.scheduled`, `core.inbox`, `core.activity`, and an event stream driving tray/badges/inbox; linked sessions with `user_asked|offer|own_initiative` — [docs/desktop/DESIGN.md:36,181-203,226,248,302-325](docs/desktop/DESIGN.md)
- Operations: README describes scheduled watching with the `ops-watch` workflow vs the default model-free loop — [README.md:627,675](README.md); `solutions/operations/docs/OPERATIONS.md` (plan on hold per user memory) contains no proactive/ambient/initiative keywords. `AIOps market research.md` and `STUDIO.md` mention them only in passing (keyword hit, not reviewed in detail)

### Inferences
- A proactive-agent design would be greenfield as a document but brownfield as code.

### Gaps
- `AIOps market research.md` and `STUDIO.md` keyword hits for "proactive/initiative" were not read in detail.

## Summary: what exists, what is partial, what is missing

### Takeaway
(a) Scheduled agents: mostly built. (b) Event-triggered agents: partial (URL triggers and plugin API, no core rules or watchers). (c) Agent inbox: partial (approvals inbox only). (d) Initiative policy: partial (proposals plus permission modes, no unattended policy). (e) Learning from feedback: missing.

### Cited Findings
- **(a) Scheduled agents.**
  - Exists: Scheduler (cron, one-time, catch-up, leases, plugin-off skip, concurrency gate) [src/core/scheduler.ts](src/core/scheduler.ts); `schedule` tool [src/tools/schedule.ts:10](src/tools/schedule.ts); REST [src/server/app.ts:1241](src/server/app.ts); runner [src/kernel/harness.ts:911](src/kernel/harness.ts); Settings > Schedules UI.
  - Partial: run results (only "started"); the desktop form (no target session or newSession, so likely rejected at [src/core/scheduler.ts:193](src/core/scheduler.ts)); runs only while the desktop app or tray is alive.
  - Missing: per-run history and outcome summaries, per-schedule budget, time zone, OS-level wake.
- **(b) Event-triggered agents.**
  - Exists: secret-URL triggers with fenced payloads [src/core/scheduler.ts:215](src/core/scheduler.ts); EventHub [src/kernel/events.ts](src/kernel/events.ts); plugin `events.subscribe` + `sessions.start` [src/plugins/api.ts:206](src/plugins/api.ts); integrations "investigate" [plugins/integrations/lib/hub.mjs:475](plugins/integrations/lib/hub.mjs); aiops webhooks and watch loop [solutions/operations/plugins/aiops/lib/watch.mjs](solutions/operations/plugins/aiops/lib/watch.mjs); FileChanged hooks.
  - Missing: core declarative event → agent rules, file/git/CI/email watchers, MCP notification subscriptions, a durable event log.
- **(c) Agent inbox / review queue.**
  - Exists: `core.inbox` for pending requests [apps/desktop/renderer/src/builtins/small.tsx:208](apps/desktop/renderer/src/builtins/small.tsx); `/api/approvals`; OS notifications; badges; proposals in Agents home; Slack/Teams mirroring of approvals.
  - Missing: result/suggestion items, read/unread, persistence of notifications, digest, planned `core.scheduled`/`core.activity` views [docs/desktop/DESIGN.md:181](docs/desktop/DESIGN.md).
- **(d) Initiative policy.**
  - Exists: `user_asked/offer/own_initiative` [src/core/linked.ts:25](src/core/linked.ts); permission modes, including `dontAsk` for unattended runs [src/core/permissions.ts:182](src/core/permissions.ts); taint guard; progress review; workflow approval nodes; `notify_user`.
  - Missing: a notify/ask/act decision policy, parking asks from unattended runs for later review (today they are denied), quiet hours and interruption budgets.
- **(e) Learning from feedback.**
  - Exists: raw signals (proposal status, approval decisions with feedback) and free-form memory [src/memory/store.ts](src/memory/store.ts).
  - Missing: any aggregation or learning loop.

### Inferences
- The cheapest high-value core additions appear to be:
  1. Per-run records for schedules and triggers (outcome summary, cost, session link), plus fixing the desktop schedule form.
  2. An "inbox item" type for agent results and suggestions on top of the existing approvals inbox and EventHub.
  3. A "park instead of deny" mode for unattended runs.
  4. Generalising aiops' model-free watch-then-wake pattern into a core watcher API.

### Gaps
- Not verified at runtime. All findings come from reading the code. The desktop schedule-form failure and the missing visibility of `notify_user` info notices should be confirmed by running the app.
