# Changelog

## Unreleased

- **A swarm across the person's computers** (docs/swarm/SWARM.md, phase 7; live in docs/swarm/EVAL-MACHINES.md):
  - **Stop means stop on the machine**: a cancel job kills a job's processes there. A job the server no longer
    waits for is stopped at the next poll. With no word from the server for its lease (120 s), the companion stops
    everything itself and takes no work until it hears the server again.
  - **The machine decides**: a policy file on the machine (`harness-companion policy --swarm on --kinds
    read,edit,exec --max-jobs 2`) says what swarm agents may do there. The server can only narrow it. Without one,
    swarm agents may only read. Beyond reading, swarm work runs only in a sandbox unless the owner says otherwise.
  - **Placement**: the agent tool's `machine` and `machines` put work on the person's computers, and the agent is
    told where it is.
  - **Acceptance and audit**: at stakes, checks that ran only on the worker's machine do not accept its work. Each
    machine keeps its own audit log.
  - **Live**: 11 of 11 with two real companions.
- **Fixed on Windows**: a stopped command that ran through `timeout`, `exec` or a nested shell (Git Bash) kept running
  (seen live: a build finished after Stop all). Every command now carries a tag, and a stop finds and kills all it
  started, and each command runs in a Windows Job Object of its own: a stop terminates the job, everything it
  started included.
- **Each companion has its own key**: made on the machine, pinned by the server on first contact. Results must be
  signed with it, and so is the policy the machine reports. A stolen token alone cannot forge a result or pass for
  the machine.
- **Re-placement**: a fan-out item whose computer is offline or drops goes to the next computer of the fan-out.
- **Security review: variant analysis** (`fix_variants`): the places that still look like code a past security fix
  removed.
- **Research: a crawl frontier** (`crawl`): links followed to primary sources, robots.txt honoured, rate-limited,
  each page archived with its SHA-256.
- **Done once across a computer dropping**: an agent's call that changes something is journaled on the companion
  until the server has its result. Repeated meanwhile, it is not run twice.
- **Files between computers** (`copy_file`): through the harness, hashed, and held to the receiving computer's policy.
- **Work on a person's computer, checked on the server**: file checks read the server's copy of the folder (before,
  they failed every check there). At stakes, the checks run again on the server in a sandbox, and a machine that lies
  about its checks is caught.
- **Security review: code scanning** (`scan_code`, Semgrep or built-in rules) and **isolated runs** of reproducers and
  fix tests (a container with no network).
- **Signed run records**: exported bundles carry the server's signature; GET /api/record-key gives its public key.
- **Desktop: the run record beside a conversation** (Agents > Run record): whether it verifies, its steps, Export.
- **Answers over the person's own data** (phase 2; live in docs/swarm/EVAL-DATA-ANSWERS.md): the data-answers
  plugin.
  - **What it checks**: read-only SQL, each result kept as a cell the agent cannot edit, with the database's own
    checks after every query (join fan-out, repeated groups, a date window the data does not cover). Every number in
    the answer traces to a cell. An agent of another family recomputes the figures from the question alone.
  - **Live**: 10 of 10 right on Haiku and Sonnet, recomputed on Grok 4.7.
- **Security review of the person's own code, gated by an oracle** (phase 4; the security-review plugin; live in
  docs/swarm/EVAL-SECURITY.md):
  - **A finding counts only when its reproducer fires.** The harness runs the reproducer and keeps every run in
    its own ledger, outside the workspace.
  - **A fix counts only when the reproducer stops firing and the tests pass.**
  - **The report is held to the ledger**, and must cover every file on the plan.
  - **The mandate** (scope, who authorized it, dates) is written by the person, and agents cannot write it.
- **A forecasting ledger** (phase 5; the forecasting plugin): live questions only.
  - **Forecasters** on several models, Claude Sonnet, Haiku and Grok 4.7 by default, each starting from the outside
    view.
  - **The aggregate, computed in code**: a trimmed mean in log-odds, extremized, capped.
  - **Scoring**: Brier and log scores and calibration once questions resolve, with the extremizing factor refitted
    from them.
- **The run recorder** (phase 6): with `"record": true` in the settings or `HARNESS_RECORD=on`, a session's
  requests, calls, results, answers and decisions are content-hashed into a hash-chained log.
  `GET /api/sessions/:id/record` exports it as a bundle that verifies on its own, with `?view=verify` and
  `?view=replay` (the steps as they happened; nothing runs again).
- **Investigations as co-pilot work** (phase 6; the investigations plugin):
  - **Leads**: kept with their evidence in a ranked queue, and decided only by the person; refused where nobody
    can be asked.
  - **A coverage checklist** gate, and a mandate the person writes.
- **The swarm charter gains `maxChildren`** (8): one sub-agent cannot spend the whole run.
- **Deep research, end to end** (phase 3): live on Haiku with Grok 4.7 judging (docs/swarm/EVAL-DEEP-RESEARCH.md).
  - **The ledger decides the end**: the workflow now ends through the claim ledger, because a fact-checker had
    approved a report that still had unsupported claims.
  - **New steps**: a counter-evidence search, and two independent sites for claims at high stakes.
  - **The ledger itself**: 100 claims a run; abbreviations and sites in the prose no longer split sentences; a
    quote may join parts of two cited pages.
- **The claim ledger** (docs/swarm/SWARM.md, phase 3; live in docs/swarm/EVAL-CLAIMS.md):
  - **Every cited sentence is judged against the pages it cites.** The judge is a model of another family than the
    conversation's, with no tools, and it sees only the sentence and the best passages of each page. A "supported"
    must quote the page word for word, and the harness checks the quote itself.
  - **Statuses**: supported, partial, unsupported, contradicted or unverifiable, each with the count of independent
    sites behind it.
  - **The research plugin (1.1.0)** gains the `verify_claims` tool, which writes research/claims.md, and the `claims`
    gate. deep-research runs the gate after the citation check, with a fix round.
  - **Live**: 20 claims on real pages, judged by nine models across Anthropic, DeepSeek, OpenAI, Kimi, GLM and xAI.
    On the final code, 180 of 180 judgements were right, and a planted "reply supported" was refused by all nine.
- **Fixed, found by the live runs:**
  - A cited URL with parentheses (a Wikipedia page) was read as never fetched.
  - Quotes failed against pages whose text keeps link targets after the link words.
  - Sentences with decimals were dropped.
  - Requests to xAI from an agent with no tools were refused, because they carried a `tool_choice` with no tools.
  - Swarm agents could not write a workflow's own state under .harness, which broke long-task. The rule now protects
    only the project's definitions there (agents, workflows, skills, styles, plugins, commands, hooks, settings, the
    setup script) and .claude.
- **Swarms under the person's control** (docs/swarm/SWARM.md, phase 1c; research in docs/swarm/research/control.md):
  - **Every agent is granted by a governor** under the run's charter: 16 agents a run by default, at most 30 started
    a minute, a spend and a time limit when set, three levels at most. Past the number, the person is asked once for
    the rest of a fan-out; where nobody can be asked, it is refused. A swarm never goes past its charter by itself.
  - **Loops and bursts are refused**: an agent that hands its own brief down unchanged is told to do the work or split
    it.
  - **One kill switch**: Stop all in the Agents panel, or POST /api/sessions/:id/stop_agents. Every agent of the run
    stops at once and no more start in that run; the conversation goes on.
  - **Nothing that outlives the run**: swarm agents never get `schedule`, `vault` or `publish_branch`, whatever
    their definition lists, and only read memory. They cannot write the project's `.harness` or `.claude` files (new agents,
    workflows, skills or settings), even in bypass mode.
  - **The fan-out**: the agent tool takes `items` and `fields`. One brief runs over up to 100 items, one agent each,
    and comes back as one table. Each item is governed, checked and verified on its own.
  - **The swarm as a tree** in the Agents panel, each agent under the one that started it.
  - **Fixed**: an agent whose run ended in an error never ended for the app, which showed it at work forever.
- **The verifier measured at scale** (scripts/verifier-calibration.mjs, docs/swarm/CALIBRATION.md): mutants of known-good
  changes plant one kind of problem each, kept only when the visible tests pass and a hidden truth check fails. On 52
  such problems and 18 checks of good changes, neither DeepSeek Flash, Claude Haiku 5.5 nor Claude Sonnet 5.5 passed a
  planted problem. Scorecards with honest bounds; at stakes the harness picks the verifier with the best record.
- **Proof-carrying swarms, phase 1** (docs/swarm/SWARM.md; research in docs/swarm/research/):
  - **Stakes on a delegation.** `stakes: "high"` always verifies the work, with a verifier from another provider
    than the worker's (the first allowed in the order Sonnet, gpt-6-luna, Kimi K3.1 Pro, GLM 5.3, ...). Another
    family's verifier passes fewer of the worker's mistakes. `stakes: "critical"` also runs two independent replicas
    on two providers, each in its own worktree and each verified, then a comparator with a clean context. It isn't
    told which model did which. Agreement means corroborated; anything else comes back UNKNOWN with both results,
    never a silent pick.
  - **Oracle-grade checks.** A `run` check can require an exit code, or "nonzero" (it must fail), and output that
    must not appear (`expect_not`). For example: "the proof of the crash no longer fires".
  - **Per-requirement verdicts.** The verifier lists each requirement as met, unmet or unverifiable. A pass with an
    unmet one is a fail. At high stakes, a pass with an unverifiable one is UNVERIFIED.
  - **Visible budgets.** At stakes, or under a spend limit, an agent sees its remaining steps and spend with each
    step.
  - **Shown in the app.** The verifier's model, the requirements and the replicas appear on the card, and
    "corroborated" or "not corroborated" on the agent's card.
- Fixed: the Dashboards end-to-end test opened the app on the person's screen, focused, in the taskbar; it now runs
  off-screen like every desktop test. A Noticing test counted a banner before the Inbox had read its new state.
- **Delegated work is accepted by the harness, not on the agent's word** (docs/agents-mcp/COORDINATION.md, steps 1
  and 5). The agent tool takes `done_when`: checks the harness runs itself when the agent says it is done (a command
  that must pass, a file that must exist, files that must stay as they were, a pattern that must be absent), with the
  delegating agent's permissions. What fails goes back to the agent with the exact output, for at most 2 fix rounds
  (`max_fix_rounds`). The agent's report says what passed, and "NOT ACCEPTED" when the work isn't done.
  - **A verifier** (`verify`) checks the work after its checks pass, with a clean context. It sees the task, the
    harness's results, the actual diff and the report as a claim, never the worker's transcript. It is a team's
    reviewer or a built-in verifier, never the worker. Its verdict is pass, fail or unknown ("unverified", never a
    pass). A pass is overruled when a check failed or when the verifier changed files itself. A verdict planted in
    the code does not count, and a reply with no verdict is asked again once.
  - **Existing tests are protected by default** whenever a check runs a command. A changed or removed test line, a
    new conftest.py or runner config, a changed test script, or an added skip or early exit fails the check; new
    tests are fine. `may_change_tests` lifts it when the task is the tests.
  - **A way out**: an agent that finds a criterion wrong or impossible ends with `BLOCKED: <why>`. No fix round is
    spent; the lead decides.
  - **Held-out checks** (`"hidden": true`): the agent never sees what they are or what they print.
  - **The fix rounds stop early** when the same failures come twice.
  - **Lines that can game a check** (an added skip, focus, early exit, or a turned-off type or lint check) are pointed
    out to the verifier and the lead.
  - **Constraints only tighten down a chain**: an agent's sub-agents keep what it must keep unchanged.
  - **Agents in the same folder are held only to their own changes**: another agent's write is reported, never sent
    back to be undone.
  - **A team with a reviewer cannot end a turn with unverified changes**: its reviewer checks them first. **Check each
    turn's changes** (Settings > Permissions, off by default) does the same in any conversation, so the
    orchestrator's own edits are checked too, not only what it delegates. In the live run, the orchestrator fixed a
    bug itself and the tests passed, but the case the README names gave NaN.
  - **Seen**: a card per delegation in the conversation (checks with their output, the verdict with its issues,
    BLOCKED), and badges on the agent's card in the Agents panel ("checks 3/4", "verified", "unverified", "blocked").
  - **Safer git**: a worker's own `.git/config` or `.gitattributes` can no longer make the harness run a command
    (fsmonitor, clean filters, external diff and textconv are off for the harness's git on a workspace).
  - Tested: 43 deterministic scenarios (test/acceptance.test.ts), the desktop end to end, and live on real models
    (scripts/live-acceptance-eval.mjs, docs/agents-mcp/EVAL-ACCEPTANCE.md).
- **Fixed: saving Settings > Permissions erased your other settings** (the models your agents may use, linked-session
  choices): the page sent only rules and limits, and the server keeps only what it is sent.
- **A live evaluation of agents and MCP** (`scripts/live-agents-eval.mjs`, report in docs/agents-mcp/EVAL.md): a
  provider added in the app and a custom agent on its model, the orchestrator routing a mixed request to specialists
  on different models, one agent against a team (writing and reading), a custom MCP server built from a database and
  a data agent, an agent out of steps, an MCP server crashing mid-run, background agents. What it found is fixed:
  - **Your own agents are used for their kind of work.** The orchestrator did small jobs itself even when you had an
    agent for them (fixing tests, querying your database). The agent tool now marks your agents "(yours)" and says to
    give their kind of work to them; rerun, it routed each part to the right specialist, in parallel, on its model.
  - **An agent that runs out of steps still reports**: one last call without tools for what it did and found and what
    is left (its partial work used to be lost).
  - **Teams split only when it pays**: the lead's procedure says every member starts from nothing, so small parts go
    together; a team of three small modules went from 8 agent runs to 5.
  - **A team lead must name the member it hands work to**: a call without one fell back to an agent outside the team,
    or sent a review to a developer; it is now refused and says which members there are.
- **Choosing an agent's model is easier**: the builder lists each model with its provider, and when the model is not
  yet allowed for agents (delegation) it says so, with "Allow it".
- Research on agent coordination (docs/agents-mcp/research/) and a design for it (docs/agents-mcp/COORDINATION.md).
- Agents and MCP, gaps closed: a team the orchestrator delegates to now leads its members (it had no agent tool
  past the default nesting depth); Generate drafts teams from your agents; a `.mcpb` can be one of your own servers
  (administrators; secrets as vault references); runs from other apps can wait for your approval in the app
  (mode `ask`); the installed app can pack `.mcpb` bundles (esbuild ships with it). DuckDB and command servers,
  a member's sandboxed run, and real public servers (DeepWiki, Linear's OAuth discovery) are tested.
- **Teams** (docs/agents-mcp/PLAN.md, phase 5): an agent can lead a team (the builder's Team part: its members and
  a reviewer). It hands work only to its members, starts independent parts at once so they run in parallel, gives
  each a complete brief, keeps writers off each other's files, has its reviewer check the result, and its spend
  limit covers the whole team. Teams run as conversations, as delegated agents, and from other apps over MCP.
- **Your agents in other apps** (docs/agents-mcp/PLAN.md, phase 4): the harness is an MCP server.
  - `POST /mcp` (streamable HTTP, a bearer token only): each of your agents is a tool (`agent_<name>`), with
    `run_agent`, `list_agents` and `get_result`. A run is a conversation as that agent that never waits for you;
    a long one goes on after the call and its answer is fetched later.
  - `src/mcp/bridge.ts`: the same over stdio, for apps that start a command.
  - Desktop: Settings > Use your agents elsewhere (off until you turn it on): a token of its own, kept encrypted,
    and the configs to copy for Claude Desktop, Claude Code, Cursor and VS Code (they find the app's engine
    themselves, and need no Node.js).
- **Build an MCP server** (docs/agents-mcp/PLAN.md, phase 3): Settings > MCP servers > Build a server.
  - From a description (a model drafts a few workflow tools), an OpenAPI document (a tool per operation, its key as
    a secret setting), a SQLite or DuckDB database (its tables, a find tool each, read-only SQL), or a command (its
    `--help` read). You review the tools and settings.
  - Built on the official SDK (both protocol eras, stdio and streamable HTTP) from a spec the harness checks, then
    checked by the harness's own client: each read-only tool is called with an example, a bad call must come back
    as an error, both eras and both transports must answer.
  - Then add it to your servers, download it as a `.mcpb` for Claude Desktop, or copy its config for Claude Code,
    Cursor or VS Code. It also carries a registry `server.json`, a README and a `package.json`.
  - Building runs code on the server's computer: administrators only.
  - `/api/me/mcp-builds` (draft, build, pack, bundle, file, register, remove).
- **Your own MCP servers** (docs/agents-mcp/PLAN.md, phase 2): Settings > MCP servers.
  - Connect a service by its address (or, for an administrator, a command), sign in through the browser (OAuth 2.1,
    PKCE, dynamic registration, refresh; tokens sealed), or import the servers from a Claude Desktop, Claude Code,
    Cursor or VS Code config. Keys are `${vault:name}` references; a key pasted into a config moves to one.
  - Each tool is approved: its definition is pinned, and a server that later changes a tool or adds one gets nothing
    past you until you approve it again (a changed tool is refused at once, even in a running conversation). Each
    tool can be allowed, asked about or blocked.
  - Their tools, documents and prompts reach your conversations and your agents (and only yours).
  - A member's servers are public `https://` addresses only; commands are for administrators.
  - The MCP client now runs on the official SDK (`@modelcontextprotocol/client` 2.4): the 2026-07-28 protocol first,
    the 2025 handshake when a server only has that; resources, prompts, progress, cancellation, change notices.
  - `/api/me/mcp` (add, edit, test, approve, tool policies, sign in and out, import), an `mcp` event topic.
- A tool can be refused before anyone is asked to allow it (`Tool.refuse`).
- **Scheduled work you can see** (proactive work, phases 0 and 1; plan in docs/proactive/PLAN.md):
  - The desktop's New schedule form made no schedule (it sent no target): it now says where each run happens,
    a new conversation each time (its model and folder) or the same one.
  - Scheduled, triggered and plugin-started runs respect the daily spend limit (they checked concurrency only).
  - `notify_user` reaches the person: a toast and a system notification with the conversation's title (it stayed
    inside its conversation).
  - Every run is written down: how it ended (completed, failed, stopped, skipped, interrupted), when, how long, its
    cost, a line of what it said, its tool calls and actions, whether it told the person, whether it found nothing
    (`[nothing to report]`), and its conversation. `GET /api/schedules/:id/runs`, `GET /api/schedule-runs`; the
    `schedules` events say when a run starts and ends.
  - A Scheduled page (every schedule and trigger, next run, last result, each run's record; New, Edit, Run now,
    on/off, Delete), the same list in Settings > Schedules, and the latest runs on Activity. A finished run says
    what it found in a toast; one that found nothing stays quiet.
  - Schedules: a time zone for the cron (daylight saving: a skipped time does not run, a repeated one runs once),
    a missed run runs once or is skipped (`misfire`), at most one run every 5 minutes
    (`HARNESS_SCHEDULE_MIN_MINUTES`), a spend limit per run (`maxCostUsd`), and `PATCH /api/schedules/:id`. A run
    cut off by a shutdown is interrupted, not "stopped by the person". A trigger's hash no longer leaves the server.
  - The app says schedules stop when the window closes (unless it keeps running in the tray) and when the computer
    restarts (unless it starts at login), with a button for each.
- **The agent inbox** (proactive work, phase 2): the Inbox has Updates under "Waiting for you": a scheduled run's
  result when it found something (failed or stopped ones as warnings), what an agent told the person (`notify_user`,
  from any conversation), and work an agent offered during a scheduled run (a suggestion: Start or Dismiss). Each is
  opened, marked read or unread, snoozed (an hour, until tomorrow) or dismissed with a reason (not useful, wrong, bad
  timing, other); every response goes to `inbox-feedback.jsonl`. `GET /api/inbox`, `POST /api/inbox/:id`,
  `POST /api/inbox/read-all`, an `inbox` event topic; the sidebar badge counts what waits and what is new. A run that
  already told the person or offered work has no second update.
- **Unattended runs wait instead of refusing**: a schedule can ask in the Inbox (edits allowed, or nothing allowed
  without asking); a request then waits there for the hours it says (`askTimeoutMinutes`, default 8 hours), then gets
  the safe answer (no) and the run goes on. Its record counts what it asked. A schedule's own conversations have
  linked sessions, so work an agent offers there reaches the Inbox.
- Settings and the Scheduled page say what the server refused inside the form, not in a toast that stays and covers
  other dialogs.
- **Setting proactive work up, made easy** (for the person, and by agents):
  - A new schedule dialog: start from a template (Morning briefing, Watch the tests, Weekly report, Check back later);
    say what it runs (a prompt, or a workflow with its inputs), when in plain choices (once, every few minutes, hourly,
    daily, weekdays, weekly on chosen days, monthly, or a cron), shown in words with its next three runs before it is
    made; where (a new conversation each time in a folder, or the same one); and what happens when it needs approval
    (never stop to ask, a checker decides, edits are fine, ask me for everything; how long to wait). Limits under
    More options; what is still needed is said next to the button, which is always in view.
  - The Scheduled page: each schedule in plain words ("Every weekday at 09:00 (Asia/Tokyo)"), when it runs next
    ("in 3 h"), what it runs and how it asks, its last result as an icon and a word (why a run failed or stopped
    under it), Run now, on/off, and a menu (Edit, Show its runs, Delete after a confirmation). An empty page offers
    the templates and "Ask an agent to set it up".
  - Agents set it up: the `schedule` tool makes a routine in a new conversation each time (`new_conversation`, like
    the agent's own conversation; `asks: inbox`), in a time zone, or one that runs a workflow, then tries it with
    `run_now`; the desktop's `core.scheduled:new` command opens the dialog filled in with what an agent proposes, for
    the person to confirm.
  - Schedules and triggers can run a workflow (`workflow: {name, input}`): its run is followed to its end, its approval
    steps wait in the Inbox. `GET /api/workflows?path=` lists the workflows a folder offers; `POST /api/schedules/preview`
    says what a timing means; schedules carry `when` (in words) and `upcoming` (their next runs).
- **Watches** (proactive work, phase 3): a schedule can run when something changes instead of at a time. A check with
  no model every few minutes - a command's output and exit code, files in the folder (paths or globs), new commits on a
  branch, a web page or API (its status and body, or what a regular expression matches) - and a run only on a change,
  with what changed (files added, changed, removed; the new commits; before and now) fenced as data, the conversation
  counting as having read outside content. Changes in a row can wait until it is quiet and run once, batched; an
  "only when" filter lets a small model with no tools skip changes that do not matter (a skipped run with why). What a
  watch saw is kept across restarts, so a change made while the app was closed runs at the next check; a change met by
  a busy conversation waits for the next check; a failed check says why on its row; Check now looks at once (and waits
  for a check already under way rather than running twice). Folder watches are for administrators, on this computer.
  `watch` on schedules, `POST /api/schedules/:id/check`, the schedule tool's `watch`; the dialog's "When something
  changes", and two watch templates (Watch the tests, Review new commits).
- **When proactive work may interrupt you** (proactive work, phase 4): every update lands in the Inbox; whether it
  also interrupts (a toast, a system notification) is decided in one place, by its schedule's "Tell me" (every time,
  only when it matters - failures, messages, offers -, in my daily digest, or not at all: only its run history) and by
  the person's limits (quiet hours when nothing interrupts, not even errors; a most a day, past which only errors do;
  a daily digest of what waited). An update says why it waited ("in your quiet hours", "past your daily most"...).
  Unattended work interrupts only through the Inbox (no second toast from a scheduled run's own warnings).
  `GET/PUT /api/inbox/settings`, `notify` on schedules, a `digest` update kind. How useful each schedule has been (the
  last 30 days: runs, what they found, updates opened, dismissed as not useful or left unread, cost:
  `GET /api/schedules/stats`) is shown with its runs; a schedule whose updates are mostly unwanted offers to be quieter
  (one click: only when it matters, the digest, or nothing) - it is never made louder, and never changed by itself.
- **A blocked run never reads as "nothing to report"** (found by a live run on Claude Sonnet 5.5): a scheduled run
  whose steps were refused is recorded as blocked (`refused` on its record; "completed, but a step was refused"), and its
  update is a warning that says what stopped it, even if the agent ended with [nothing to report]. The run's prompt asks
  the agent to say what stopped it rather than report nothing. Routines an agent sets up, and the dialog's default, now
  let a checker approve their steps (the rest wait in the Inbox) instead of refusing everything; the schedule tool says
  that `asks` is about approvals, not notifications (the model had read "only tell me if it matters" as "never ask").
- While a dialog is open, toasts sit under its backdrop (seen, dimmed), so they never cover its buttons.
- **Noticing: what the harness notices by itself** (proactive work, phase 5; design and evidence in
  docs/proactive/NOTICING.md): without anything set up, four fixed detectors notice what needs the person. A long
  conversation that stopped on an error or a limit while nobody had it open (to the Inbox, as a warning). A schedule
  that keeps failing, being skipped or hitting its spend limit, or a watch that cannot check. The same command failing
  the same way 3 times over more than one turn, with no edits in between (one quiet line by that conversation's message
  box; "Find the cause" sends its own message, as the person's). A task asked for on 3 days in 14 (a schedule offered
  in the person's own words, at their usual time, in that folder; "Set it up…" opens the schedule dialog filled in).
  - No model watches: every session's events are counted into `activity.jsonl` as fingerprints (a command's and an
    error's hash, whether it passed, a prompt's word hashes), never their text, kept 14 days. Scheduled, triggered,
    plugin and sub-agent work is not observed.
  - Gates before anything is shown: muted by a dismissal, a 72-hour cooldown, already in the Inbox, held back to
    measure (10%, `HARNESS_NOTICE_HOLDOUT`), at most 3 a day (more are dropped, not queued) and at most 1 interruption a
    day; findings are their own Inbox kind (`noticed`), in the digest unless a warning.
  - It starts in practice: findings are written down, not shown; after 7 days (`HARNESS_NOTICE_PRACTICE_DAYS`) the
    Inbox offers a review of what it would have said. Off, practice or on, and each detector on or off, in the Noticing
    panel (the eye in the Inbox's Updates), with each detector's measures and what it observed (and Forget).
  - Dismissals only make it quieter ("wrong" mutes that finding for good, "not useful" that detector in that folder for
    30 days, "bad timing" a day); a detector whose findings are mostly unwanted moves to the digest, then turns itself
    off and says so; only the person turns it on again. The feedback log says which detector.
  - `GET/PUT /api/noticing`, `POST /api/noticing/clear`, `POST /api/noticing/check`, `POST /api/inbox/:id` with
    `accept`, a `noticing` event topic.
- **A design system for the desktop app** (docs/desktop/DESIGN-SYSTEM.md): one kit, one set of tokens, every page.
  - Type: nine roles (`text-micro` to `text-display`), each a share of the Text size setting, which now scales all
    text (it changed almost nothing: 842 fixed pixel sizes in 18 values). Markdown follows it too.
  - Colour: a fill and a border token for each status tone (`bg-hx-danger-soft`, `border-hx-warning-border`), in
    place of opacities made up page by page; seven tints that drew nothing (`accent-soft/50`) now draw. One map from
    a status to a tone (`statusTone`): working is accent, waiting is warning, failed is danger.
  - The kit's blocks: `Card` (padding, interactive, selected, tone, muted), `StatCard`/`StatGrid`, `Callout` (inline
    or a banner with actions; `InfoNote` is one), `ChoiceGroup` (chips or segmented, arrow keys), `OptionCards`,
    `CheckboxGroup`, `Meta`, `StatusDot`, `IconTile`, `PageHeader` (with an icon for a module's home), `Section`
    (description, count, actions, dense), `EmptyState` variants (page, section, inline). All in the gallery.
  - Pages: one content width for every page of lists, cards and settings (moving between them no longer moves the
    edge); page buttons in the header; the pages' own copies of a section heading (9), a stat tile (2), a choice row
    and hand-made error notes replaced by the kit's. Inbox, Scheduled, Your agents and the agent builder, the
    schedule dialog, Noticing, Agents and Dashboards homes, module homes, Plugins and Settings use it.
  - Disabled primary buttons are grey (they read as a broken pink); the confirm dialog uses the kit's buttons; at most
    three toasts, a repeat replaces the one on screen, and a schedule's time is shown on the person's clock, not as
    an ISO string.
  - `test/ui-standards.test.ts` fails a pixel text size, an opacity on a tone, or a page's own section, stat tile or
    choice row.
- Fixed: the command palette showed at most 60 entries with nothing typed, so the last plugins' pages and commands
  were dropped without a word.
- **Custom agents** (docs/agents-mcp/PLAN.md, phase 1): a person's own agents, made in the app (Agents > Your agents),
  drafted from a description (Generate: instructions with a role, procedure, checks, limits and report, the fewest
  tools, autonomy; what the server does not have is left out and said; nothing is saved until the person saves),
  imported from an agent file, or opened in the builder filled in by an agent (`core.agents:new`). Each is versioned
  (a stale save is refused; earlier versions come back as new ones), on or off, and chatted with directly.
  - Claude Code's agent file fields (`tools`, `disallowedTools`, `model` and its aliases, `effort`, `permissionMode`,
    `maxTurns`, `skills`, `mcpServers`, `isolation`, `background`, `color`), GitHub Copilot's (`mcp-servers`, its tool
    aliases and `server/tool` names, `disable-model-invocation`, `user-invocable`) and Cursor's (`readonly`,
    `is_background`) are read; an agent is written back as a Claude Code file.
  - Enforced where it runs: its tools and deny list (globs), only its MCP servers' tools (inline, or behind its own
    tool_search), only its skills (their instructions loaded up front), its autonomy never looser than the
    conversation's, `maxTurns` a wall (the progress review no longer extends past it), a spend limit per run, a
    worktree of its own, background by default, and whether the orchestrator may use it.
  - A conversation can run as an agent (`POST /api/sessions` with `agent`): its instructions in the system prompt,
    its tools, skills, mode and model.
  - Fixed: an agent definition's own model reached another company without the person's allowed-models check; a
    person's or a repository's agent now runs on the conversation's model (and says so) unless that model is allowed.
  - The orchestrator lists the person's agents (long descriptions and tool lists cut, more so past 15 agents); a
    step that runs a named agent says which.
  - `GET /api/agents`, `GET /api/agents/options`, `/api/me/agents` (create, read, new version, delete, versions,
    restore, export, import, generate).
- **"The same error" is the error, not the bash tool's lines**: a failure's gist skipped nothing, so every failed command
  with output on stderr read as `exit code: # stderr:`, and the progress review counted different failures as "the same
  error N times" (a signal towards stopping or restarting a run). It now reads the error past those lines.

- **run_script works in the desktop app**: it started its helper with the app's own executable, which opened a
  second app (refused by the single-instance lock, exit 0) instead of running Node, so every call failed with
  "the script process exited (0)". The same was true of plugin review's type check, .mcpb Node servers and the
  network-allowlist proxy. They now ask Electron for Node mode (`nodeEnv()`).
- **A task card and a live activity line in the conversation**: the agent's task list (todo_write) shows as a card
  under the transcript while the turn runs or while some of it is open, and the line under it says what is
  happening now ("Showing all result JSON files", "Waiting for shell-85yenz", "Thinking") and how long the turn has
  run, instead of a bare "Working...". todo_write takes an `activeForm` ("Running the tests") for the step in
  progress, and its description asks for a list on any task of three or more steps.
- **bash**: `cmd | tee run.log` keeps a log again; tee and echo/printf are refused only when they write source or
  documents (as `> run.log` was always allowed).
- **Export**: an exported or copied conversation has the person's words only, without the context the harness adds
  to the first message (environment, memory, skills) or reminders.

## 0.2.5

- **Every solution apart from the core**: Engineering (`solutions/engineering`: sdlc 1.2.0), DevOps
  (`solutions/devops`: devops 1.1.0) and Operations (`solutions/operations`: aiops 1.2.0) join Studio, each with its
  own version, tests (test kit only), eval pack, docs and changelog. Each installs into the harness app as one
  signed file (Plugins > Install from a file) or becomes an app of its own (`--solution engineering|devops|operations`).
  The core is the engine, the SDK, the desktop app and its built-in plugins (visual, documents, research,
  computer, integrations, quality-gates, plugin-dev); its installer ships just those.
- **Your messages**: copy, edit and send again, send again from here, branch a new conversation from here (under
  each message, and on a right-click). Editing goes back to that message: what came after it is removed from
  the conversation (files the agent changed stay as they are); a conversation that changed since it was shown
  is not cut (POST /api/sessions/:id/cut).
- **Export a conversation**: as Markdown or text (a save dialog), or copy it as Markdown, from the
  conversation's header and its row in the sidebar.
- **Workflow cards** fold once the run is done (Show graph opens them again), and sit where the run started in
  the conversation, not after everything, when it is opened again.
- **The context meter** measures against the compaction point, not the model's whole window.
- **Studio: playing a web game**: studio_template play and Builds > Play in the browser serve the build on this
  computer (a module game does not run from file://); a game opened from its file says how to play it.

## 0.2.4

- **Install from a file** (Plugins page): a plugin's file, or a whole solution's in one file (Studio: its five
  plugins, signed each, installed in order, all or none; again: nothing changes; a newer one updates), into
  the app as it was, after showing what is in it and who signed it. `npm run plugin -- solution <dir>`; the
  desktop build writes `<solution>-<version>.tgz` beside the plugins' files.
- **Any solution as an app of its own, the harness desktop app as its base**: `npm run desktop:build --
  --solution studio` builds Harness Studio (solutions/studio/package.json "harness.app": its name, app id,
  tagline, the plugin it opens on), with every feature of the harness, Studio inside and installed, the window
  focused on Studio, and its own home folder (~/.harness-studio) so both apps run side by side.
  `npm run desktop:dev -- --solution studio` runs it from the checkout. The core's installer ships the core.
- An official plugin installed from a file has its own group in the sidebar, as when it ships (others: Custom).

## 0.2.3

- **Solutions apart from the core**: a complete product on the core lives in `solutions/<name>` with its own
  version, plugins, tests, evals, docs and changelog. Studio is the first (`solutions/studio`, Studio 1.1.0:
  games3d and the Blender, Godot, Unity and Unreal engines); its changes are in solutions/studio/CHANGELOG.md.
  The core finds every solution's plugins in the checkout; `npm test -- --core` or `--solution=studio` runs
  one part's tests.
- **The plugin test kit** covers what a plugin's or solution's tests need (`@harness/plugin-sdk/testing`:
  createHarness, pluginDir, hosts, gates, skills, workflows, evals, fixtures; `/testing/desktop`: how the
  desktop app shows a plugin), so they never import the harness's own files; the core's suite checks that no
  solution does. `@harness/plugin-sdk/runtime` has HARNESS_VERSION and version ranges (`satisfies`).
- **Official and verified**: plugins signed with an official publisher's key (the desktop product's
  `trustedKeys`: Suhail Akhtar's) are Official and Verified on the Plugins page; a signed plugin changed
  afterwards says its signature does not match; a person's own plugins load as before. The desktop build
  signs every bundle with the publisher's key when there is one (HARNESS_PUBLISHER_KEY).

## 0.2.2

- **Questions from the agent**: suggested answers with what each does and the recommended one marked; a form's
  choices as tick boxes, suggestions as chips; a note with the answer, a reply in your own words, a review of
  what is sent, Skip (the agent decides and says what it assumed). Send works in the conversation as in the
  Inbox; a form question can be skipped or answered in words.
- **Run a workflow**: what a workflow is, workflows searched and grouped by plugin, how the chosen one runs
  (steps, who does each, where it waits for you, what repeats), what it needs, what happens when you start it.
- **Right-click menus** everywhere: what is under the pointer (a conversation, a project, a plugin, a reply),
  spelling, copy and quote, links and images, code blocks, and the editing commands in text fields.
- **Working animation**: the jump-to-latest button shows it while the agent works (the arrow on hover); six
  styles in Settings > Appearance.
- **Administrator commands**: bash with elevated: true, asked every time, then by the operating system (UAC,
  sudo or the system's password dialog); never with a password the app sees; only on this computer.
- **Plugins as separate installables**: npm run plugins:bundles, and the desktop build writes every plugin's
  bundle and an index beside the installer.
- A page that cannot be shown says why (its plugin switched off, with Switch it on), never blank.
- **Too large for the provider (413)**: a request carries the newest images up to a budget (older ones become a note);
  a 413 is sent again without images, then after compacting; past that it says what to do. Long screenshot-heavy
  conversations go on instead of stopping.

## 0.2.1

- Published by Suhail Akhtar under the MIT licence (LICENSE): every shipped plugin says so on its card, and the packages declare it.
- The installed desktop app's engine carries its dependencies (the installer is made from the unpacked app after they are copied in).

## 0.2.0 — the platform release

The core is complete and everything else is a plugin built on it: the core never needs a solution, and
any mix of solutions runs on top of it. This is the base for new end-to-end plugins.

### Core and solutions
- The core: chat, projects, agents, dashboards, documents, research, quality gates, integrations and the
  desktop app; always there.
- **Solutions** are standalone plugins installed one by one, in any mix (Plugins > Catalogue > Solutions):
  **Studio** (games and 3D, with its Blender, Godot, Unity and Unreal engines), **Operations**,
  **Engineering** and **DevOps**. Installing one installs what it requires; removing one keeps its data.
  A setup in use before keeps every solution; a new one starts with the core (or `HARNESS_SOLUTIONS`).

### The plugin SDK
- `@harness/plugin-sdk` (types), `/runtime` (the harness's abilities: tools, paths, files, programs,
  browsers, libraries), `/testing` (the test kit: a real harness, tools, routes, scripted conversations)
  and `/ui` (pages built from the app's own kit).
- `npm run plugin -- new | test | check --deep | pack | sign | verify | index`; agents have the same
  through plugin-dev (`plugin_new`, `plugin_test`, `plugin_review`) and the build-a-plugin skill.
- Live reload, versioned plugin data with migrations (`api.store`), clear errors for every refused call.
- Portable plugins: other plugins' modules by name (`@harness/plugins/<name>/...`), never by relative
  path, so a packed plugin works on any server. Two tiers, official and custom, both with the whole API.
- The full guide: `docs/plugin-sdk` and the build-a-plugin skill's references; a complete example,
  `examples/plugins/customer-desk`.

### Plugins as bundles
- Each plugin carries a display name, icon, tags, category, publisher, author, licence, links and a
  changelog, shown on its card; its tests in its own `test/` folder.
- `engines.harness`: a plugin made for other harness versions is not loaded, and says what to do. Within
  a major version the SDK and runtime only grow, so an update of the harness keeps plugins working.
- Updates (the plugin's `updates.url`, then the catalogue), the version before kept, roll back to any of
  the last five; a version that fails to load leaves the one before running.
- Export a plugin as a `.tgz`; import it on another computer (reviewed, then *Open as app*) or server
  (signed with a trusted key).

### Trust and safety
- A plugin is reviewed before it loads in the desktop app (score, findings, what to do), and on demand.
- The review checks the manifest, tools, routes, pages, permissions against the code (network, secrets,
  the vault, sessions, routes, programs on the server), secrets in files, portability, the bundle and the
  plugin's own tests (quick ones; integration tests run with `plugin test`).
- Plugin code reviewed and tested without the server's credentials; `permissions.processes` declares
  programs started on the server, shown before a plugin is added.

### Desktop
- A plugin opens as its own app (a window focused on it, a desktop shortcut); plugins the person added sit
  under Custom; every tool parameter of the shipped plugins described for agents.

## 0.1.0

- The agent harness, its server and the desktop app.
