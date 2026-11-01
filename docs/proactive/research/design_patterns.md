# Architecture and design patterns for proactive agents and proactive agentic workflows

Scope note: research done 2026-11-01 with a 15-call budget. Sources fetched directly in this session are marked as such implicitly by their citation. A few items come from secondary coverage or prior knowledge and are flagged inline. Vendor docs for Claude Code (scheduled tasks / routines, Agent SDK hooks) were fetched live and reflect their late-2026 state.

## 1. Trigger layer: schedules, events/webhooks, watchers, listeners, polling vs push, debounce and dedup

### Takeaway
A proactive agent is a normal agent loop behind an event-ingestion layer; the ingestion layer must normalize schedule, webhook/API, and repo/CI events into one event type, filter early (cheap predicates before any model call), and apply flow control (debounce, throttle, rate-limit, batch, supersede) keyed per entity, because each fired event typically costs a full agent session.

### Cited Findings
- Claude Code cloud "scheduled tasks" (formerly "routines", research preview) package "a prompt, one or more repositories, and a set of connectors" and support three trigger kinds that can be combined on one task: Schedule (recurring or one-off), API (HTTP POST to a per-task endpoint with a bearer token), and GitHub (repository events such as PRs or releases). A task needs no schedule; API-only or GitHub-only tasks are valid. — [Claude Code docs: Automate work with scheduled tasks](https://code.claude.com/docs/en/routines)
- Schedule details: cron expressions are allowed via a Custom option, but "Expressions that run more often than once per hour are rejected"; five-field crons are interpreted in UTC unless prefixed `CRON_TZ=`; runs scheduled exactly on the hour "can start several minutes late", so the docs advise e.g. 9:07 instead of 9:00. One-off runs count against the same hourly limit. — [Claude Code docs](https://code.claude.com/docs/en/routines)
- GitHub trigger: "Claude Code doesn't reuse sessions across events, so two PR updates produce two independent sessions." Webhook events "are subject to per-task and per-account hourly caps. Events beyond the limit are dropped until the window resets." PR filters (base branch, head branch, labels, title, etc.) all must match; operators are equals, contains, starts with, is one of, is not one of, matches regex (regex matches the whole field). — [Claude Code docs](https://code.claude.com/docs/en/routines)
- API trigger: POST to `/fire` with optional freeform `text` (e.g. alert body, failing log) passed alongside the saved prompt; it is not parsed even if JSON. The saved prompt must explicitly opt in to acting on the fire text ("Investigate the alert described in the routine-fire-payload block"), otherwise "the routine treats the text as inert context"; the wrapper labels fire text as untrusted data because anyone with a leaked token could send it. Endpoint is behind beta header `experimental-cc-routine-2026-04-01`. — [Claude Code docs](https://code.claude.com/docs/en/routines)
- Inngest flow-control semantics (useful vocabulary for any trigger layer): **debounce** waits for a quiet period (1s to 7d), each matching event restarts the wait, an optional CEL **key** gives each entity its own debounce window, an optional **timeout** caps how long events can keep extending the wait, and the function runs with the **last** event of the burst; **throttling** queues excess runs (use when every event must be processed); **rate limiting** skips events beyond the limit and "does not wait for a quiet period"; **batching** collects many events into one run; debounce cannot be combined with batching. — [Inngest docs: Debounce](https://www.inngest.com/docs/guides/debounce)
- Inngest `cancelOn` cancels an older run when a newer related event arrives (supersede pattern). — [Inngest event coordination pattern](https://www.inngest.com/docs/patterns/events/event-coordination-for-lost-customers) (via search snippet)
- LangGraph Platform ships built-in cron jobs "for agents that check for events on a schedule" (i.e. polling as a first-class trigger). LangChain first tried Slack as the human channel and abandoned it because notifications piled up. — [LangChain: Introducing ambient agents (Jan 14 2025)](https://www.langchain.com/blog/introducing-ambient-agents)
- Claude Agent SDK exposes in-process event hooks relevant to local watchers: `FileChanged` ("A watched file is modified, created, or deleted"), `CwdChanged`, `ConfigChange`, `SessionStart`, `Notification`, `TaskCreated`, `TaskCompleted` (TypeScript only for most of these). — [Claude Agent SDK hooks docs](https://code.claude.com/docs/en/agent-sdk/hooks)
- If the GitHub connection is missing when a scheduled run is due, the task skips runs for up to 72 hours, then turns itself off. — [Claude Code docs](https://code.claude.com/docs/en/routines)

### Inferences
- Design decisions the trigger layer forces: (a) push (webhook/API) vs pull (cron polling of inbox/CI/issue tracker); push is cheaper and lower latency but needs a public endpoint, signature verification, and replay protection; polling needs a durable cursor ("since last run") and is what a desktop harness without a public endpoint can always do. (b) Session-per-event (Claude Code's choice) vs session-per-entity (thread keyed by PR/issue/email-thread id); per-event is simpler and isolates injection blast radius, per-entity saves tokens and preserves context. (c) Flow-control per entity key: debounce for "settle then act" (e.g. many pushes to one PR), throttle for "must process all", rate-limit for "drop excess", batch for digests, supersede/cancel for "only the newest matters".
- Deduplicate before the model: idempotency key = (source, entity id, event type, content hash or delivery id). Hard caps that drop events (as Claude Code does) need a visible "dropped N events" record or users will assume coverage that does not exist.
- Treat trigger payloads as untrusted data by default and require the stored prompt to opt in to using them (the Claude Code `/fire` design is a good template for a harness).
- A minimum interval (Claude Code rejects sub-hourly cron) is a sensible default guard against runaway cost.

### Gaps
- Did not fetch Trigger.dev, AWS EventBridge/Bedrock Agents, or Azure (Logic Apps / Durable Functions agent) trigger docs; no vendor-specific citations for those.
- Exact numeric values of Claude Code's per-task/per-account webhook hourly caps are not stated on the page fetched.
- Inngest idempotency/concurrency/singleton semantics were not on the fetched page.

## 2. Ambient agents, human-in-the-loop patterns, Agent Inbox, durable execution and equivalents

### Takeaway
"Ambient agent" (LangChain, Jan 2025) = an agent triggered by an event stream rather than a chat message, with explicit notify / question / review touchpoints surfaced in an inbox UI; the enabling infrastructure is durable execution (checkpointed state, interrupt-and-resume with zero compute while waiting, timeouts), which LangGraph, Temporal, Inngest and the Claude Agent SDK (`defer`) each provide in different forms.

### Cited Findings
- Definition: "Ambient agents listen to an event stream and act on it accordingly, potentially acting on multiple events at a time." They are not triggered only by human messages, multiple can run at once, and they are "not necessarily fully autonomous." — [LangChain blog, Harrison Chase, Jan 14 2025](https://www.langchain.com/blog/introducing-ambient-agents)
- Three HITL patterns: **Notify** (flag an important event without acting, e.g. a DocuSign the agent cannot sign); **Question** (ask for information when unsure rather than guess, e.g. whether to attend a conference); **Review** (user approves, edits or gives feedback on a proposed action such as an outbound email; the post suggests hard-coding review for "dangerous" actions). Stated benefits: lowers the stakes of shipping, mirrors human communication and builds trust, enables long-term memory from feedback. — [LangChain blog](https://www.langchain.com/blog/introducing-ambient-agents)
- Agent Inbox: standalone UI modeled on an email inbox crossed with a support ticketing system; shows all open lines of communication between user and agents; sorted by time, with priority sorting and per-user assignment planned. — [LangChain blog](https://www.langchain.com/blog/introducing-ambient-agents)
- LangGraph primitives: persistence layer saving state between nodes so the agent can pause for feedback; a built-in `interrupt`; long-term memory as a namespaced KV store with semantic search; cron jobs. Reference implementation: open-source `executive-ai-assistant` email assistant. — [LangChain blog](https://www.langchain.com/blog/introducing-ambient-agents)
- Inngest HITL: `step.waitForEvent()` pauses for sign-off (example: post to Slack, wait for `agent/approval.response` matched on `approvalId`, timeout 24h or 4h); timeout returns null so the flow can end or escalate to a second reviewer; can gate only dangerous tools inside the tool loop; waiting consumes no compute. — [Inngest HITL docs](https://www.inngest.com/docs-markdown/ai-patterns/human-in-the-loop), [Inngest durable agents HITL](https://www.inngest.com/docs/durable-execution/durable-agents/human-in-the-loop.md)
- Temporal + OpenAI Agents SDK: public preview July 30 2025; GA for the Python SDK as of March 23 2026. Temporal provides the durable wrapper; the body is ordinary Agents SDK code, with LLM calls and tool calls run as durable steps so agents survive failures such as rate-limited LLM calls. Reported adopters include OpenAI (Codex on the web), Replit, Lovable (case-study claim). — [Temporal blog](https://temporal.io/blog/announcing-openai-agents-sdk-integration), [temporalio-openai-agents on PyPI](https://pypi.org/project/temporalio-openai-agents/), [ZenML case study](https://www.zenml.io/llmops-database/building-reliable-production-ai-agents-with-durable-execution-infrastructure)
- Claude Agent SDK: a `PreToolUse` hook can return `permissionDecision: "defer"`, ending the turn with `stop_reason: "tool_deferred"` so the call can be resumed later (an interrupt-and-resume primitive). Decision precedence across hooks: deny > defer > ask > allow. `Notification` hooks fire `permission_prompt` once a permission request has waited about six seconds, intended for forwarding to Slack/PagerDuty. — [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- Claude Code scheduled tasks: each run opens as a full session (history list, Succeeded/Failed/Cancelled); when a run hits an approval it waits in that session until someone answers. Run status reflects how the session ended, "not whether Claude completed the work your prompt describes". — [Claude Code docs](https://code.claude.com/docs/en/routines)

### Inferences
- The minimum durable-execution contract for a proactive harness: (1) checkpoint after every model/tool step; (2) an interrupt primitive that persists a pending request (notify/question/review) with a correlation id and timeout; (3) resume from an external event (user answer) with no compute held; (4) timeout policy per request type (expire, escalate, or take the safe default); (5) supersede/cancel when a newer event obsoletes a pending request.
- The inbox is the core UX artifact: one queue of pending notify/question/review items across all background agents, each item linking to its run transcript. Chat channels (Slack) are a delivery channel, not the system of record (LangChain's own experience).
- "Succeeded" at the session level is not task success; a proactive system needs a separate outcome field (did it do anything? was it accepted?).

### Gaps
- Temporal's own HITL mechanism (signals/updates) not fetched; no citation for Temporal-specific interrupt patterns.
- OpenAI Agents SDK native HITL / approval primitives, AWS Bedrock AgentCore, Azure AI Foundry agent event triggers and Trigger.dev waitpoints not fetched.
- No newer (2026) LangChain material on Agent Inbox status was retrieved.

## 3. Initiative policy: act vs ask vs notify vs silent; thresholds; expected utility; interruption budgets; digests; quiet hours

### Takeaway
The canonical framing is Horvitz's mixed-initiative expected-utility model (1999): given P(user goal | evidence) and the costs of false positives, false negatives and interruption, two probability thresholds split the space into do-nothing / ask (dialog) / act; modern proactive-agent work operationalizes the same thing as a learned "will the user accept this?" predictor and optimizes acceptance while penalizing false alarms.

### Cited Findings
- Horvitz, "Principles of Mixed-Initiative User Interfaces" (CHI 1999, DOI 10.1145/302979.303030): automated actions should be guided by the expected value of acting, weighed against the context-dependent costs of assisting versus disturbing the user; use dialogue to resolve uncertainty while weighing the cost of bothering the user. Tested in LookOut, an email assistant that decided when to offer meeting scheduling. — [Horvitz, erichorvitz.com/uiact.htm](https://erichorvitz.com/uiact.htm); [Horvitz CHI99 PDF](https://www.interruptions.net/literature/Horvitz-CHI99-p159-horvitz.pdf)
- Course summaries of Horvitz: the decision space divides into autonomous action, dialog, or inaction based on two threshold probabilities; asking has lower risk but lower utility, forming an "ask zone" between act and inaction; the approach fails when P(goal) or utilities are poorly estimated. — [Stanford CS376 AI+HCI slides](https://hci.stanford.edu/courses/cs376/2018/slides/10-ai+hci.pdf); [UW-Madison CS639 proactivity-timing lecture](https://wisc-hci.github.io/cs639-s26/lectures/w09-1-proactivity-timing.pdf) (search snippets)
- "Proactive Agent: Shifting LLM Agents from Reactive Responses to Active Assistance" (arXiv 2410.12361): objective is to maximize the user's acceptance rate of proposed tasks; ProactiveBench covers coding, writing and daily-life settings (6,790 train / 233 test entries in the agent-model subset); a reward model (LLaMA-3.1-8B-Instruct trained on 1,640 annotated entries) mimics human accept/reject, with 100% agreement on false-alarm scenarios and 91.80% F1 overall; fine-tuned Qwen2-7B reached 66.47% F1; base LLaMA-3.1-8B-Instruct F1 is reported as 55.06% in one version and 44.78% in v1 (versions conflict). — [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3)
- LangChain: use Question rather than guessing when unsure; hard-code Review for dangerous actions; Notify when the agent cannot act. — [LangChain blog](https://www.langchain.com/blog/introducing-ambient-agents)
- Knight/UW framework: "Time consultations carefully. Consulting too early or too late can reduce the quality of user feedback." — [Feng, McDonald, Zhang, Knight First Amendment Institute, July 28 2025](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1)
- Rate limiting of the agent itself: Claude Code drops webhook events over hourly caps and rejects sub-hourly crons. — [Claude Code docs](https://code.claude.com/docs/en/routines)

### Inferences
- Practical policy engine (synthesis, not from a single source): compute for each candidate action a tuple (confidence, reversibility, blast radius, user-attention cost, time sensitivity). Rules: irreversible or external-communication actions always Review regardless of confidence; reversible, in-sandbox actions may Act above a high threshold; mid-confidence goes to Question; low-confidence-but-important becomes Notify; everything else is Silent (logged only).
- Interruption budget: cap interrupt-level items per user per day; overflow and low-urgency items go to a digest (daily/weekly), delivered at a configured time; quiet hours suppress non-urgent items with an urgency override list. Batching (Inngest-style) is the implementation primitive for digests.
- Thresholds should be per action type and adapted from accept/dismiss history (see section 5), not one global confidence number; LLM self-reported confidence is poorly calibrated, so a separate scorer (reward-model style, as in arXiv 2410.12361) or rule-based features are preferable.

### Gaps
- No vendor documentation found specifying quiet hours, interruption budgets or digest policies for agents; these are design recommendations rather than cited practice.
- No 2025-2026 empirical study on optimal interruption rates for LLM agents was found in this pass.

## 4. Autonomy levels and permissions: graded frameworks, least privilege, approval gates, scoped credentials, budget caps

### Takeaway
Autonomy should be a deliberate, per-agent (ideally per-action-class) setting separate from capability; the Knight/UW five-level framework (operator, collaborator, consultant, approver, observer) maps cleanly to proactive modes, and concrete enforcement lives in tool permission layers (allow/ask/deny/defer hooks, classifier-gated auto modes, scoped tokens, protected branches, connector minimization).

### Cited Findings
- Five levels defined by the user's role: L1 Operator (agent suggests, no action without approval); L2 Collaborator (joint planning/execution, user can take over); L3 Consultant (agent drives, user gives feedback/preferences); L4 Approver (agent runs independently, involves user only for blockers like missing credentials or consequential sign-offs); L5 Observer (fully autonomous, logs plus an emergency off-switch only). — [Knight First Amendment Institute, Feng/McDonald/Zhang, July 28 2025](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1)
- Same source: treat autonomy as separate from capability; match level to stakes; keep approvals meaningful (rubber-stamping weakens oversight); watch for approval-based escalation; provide monitoring and shutdown at high autonomy; proposes "autonomy certificates" issued by a third party, invalidated by model/tool/environment changes; "assisted evaluations" measure the minimum user involvement needed for success. — [Knight](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1)
- Claude Code scheduled tasks start in "auto mode", where "a classifier model allows or blocks actions that would otherwise wait for your approval"; ask rules still prompt; repeated blocks past thresholds raise a permission prompt that waits for a human. The trigger "attests only that the prompt was stored ahead of time by an authorized session"; "The fired prompt is therefore not live user input and can't act as approval or consent for actions during the run." — [Claude Code docs](https://code.claude.com/docs/en/routines)
- Least-privilege controls in Claude Code tasks: all connectors are included by default and the docs say to remove unneeded ones because Claude "can use an included connector during a run, including writes"; pushes go to `claude/`-prefixed branches; use GitHub branch protection/rulesets to control pushable branches; default cloud environment has "Trusted" network access limited to an allowlist; per-task API tokens scoped to triggering one task, rotatable/revocable instantly; actions appear under the user's own identity (GitHub, Slack, Linear). Org owners can disable scheduled tasks org-wide. — [Claude Code docs](https://code.claude.com/docs/en/routines)
- Agent SDK permission hooks: `PreToolUse` returns allow/deny/ask/defer plus `updatedInput` (e.g. rewrite paths into a sandbox); the most restrictive decision across parallel hooks wins; a timed-out `PreToolUse` hook blocks the call; matchers match tool names only (filter arguments in code); a Write|Edit matcher does not cover Bash writes, so use the sandbox for those. — [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- Inngest pattern: gate only dangerous tools with approval; safe reads run freely. — [Inngest HITL docs](https://www.inngest.com/docs-markdown/ai-patterns/human-in-the-loop)

### Inferences
- Map proactive modes to levels: Notify-only watcher = L1; drafts awaiting review = L4 for low-risk, L1-L2 for high-risk; sandboxed auto-fix PRs on a `claude/` branch = L4 (merge still human); L5 only for reversible, internal, budget-capped housekeeping.
- Key design rule from the routines doc worth copying: a stored trigger prompt is never consent for irreversible actions during the run; approvals must come from a live human channel.
- Budget caps (tokens/USD per run, per day, per agent) belong in the same policy object as tool permissions; a run that hits its cap should stop with a Notify rather than silently truncate.
- Fail closed: hook/approval timeouts should deny (as Agent SDK `PreToolUse` timeouts do).

### Gaps
- SAE-style autonomy analogies and other arXiv autonomy-level papers (e.g. Morris et al. "Levels of AGI", other "levels of autonomy" proposals) were not fetched in this pass.
- No source fetched for per-run token/USD budget-cap features in specific vendors (OpenAI, LangGraph, Inngest).

## 5. User model and memory: learning from accept/dismiss, preference memory, context gathering

### Takeaway
Feedback on proactive items (accept, edit, dismiss, ignore) is the main learning signal; LangGraph explicitly ties HITL to long-term memory, and the proactive-agent literature trains a reward model on accept/reject to predict acceptance before surfacing anything.

### Cited Findings
- LangChain names "supports long-term memory and learning from user feedback" as a benefit of HITL; LangGraph offers a namespaced KV store with semantic search so agents update memory after interactions. — [LangChain blog](https://www.langchain.com/blog/introducing-ambient-agents)
- arXiv 2410.12361 trains a reward model on human accept/reject judgments of proposed tasks and uses it both to evaluate and to drive data for fine-tuning, with the objective of maximizing acceptance rate. — [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3)
- Horvitz LookOut inferred user goals from email content and context to decide whether to offer help. — [Horvitz 1999](https://erichorvitz.com/uiact.htm)
- Knight framework warns of "approval-based escalation" where agents gain autonomy as users disengage. — [Knight](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1)

### Inferences
- Store feedback as structured events (item type, source, features, decision, edit diff, latency to decision) and derive: per-type acceptance rate, per-type thresholds, and explicit preference rules ("never draft replies to X", "always batch dependency bumps"). Edits to drafts are the richest signal (LangChain-style "review with edit").
- Ignored items are weak negatives; explicit dismiss with a reason ("not useful / wrong / bad timing") is a strong negative and lets the policy separate content errors from timing errors.
- Guard against autonomy creep: raising an action class from Review to Act should be an explicit user-confirmed promotion, not an automatic consequence of high acceptance.
- Memory written from untrusted event content is an injection persistence vector (see section 6); memory writes from background runs should be provenance-tagged.

### Gaps
- No vendor documentation found describing a production accept/dismiss learning loop for agents (e.g. how GitHub Copilot, Gmail, or LangChain's assistant adapt thresholds); this remains a design recommendation.

## 6. Safety: prompt injection without a user present, lethal trifecta, Rule of Two, sandboxing, audit, kill switches

### Takeaway
Proactive agents are the worst case for prompt injection: they read attacker-reachable content (emails, issues, webhooks) with no human watching; the defensible architecture is structural (never combine untrusted input + sensitive access + external communication/state change in one unsupervised session), not filter-based, since adaptive attacks break published defenses at >90% rates.

### Cited Findings
- Lethal trifecta: (1) access to private data, (2) exposure to untrusted content, (3) ability to communicate externally; examples include an email assistant reading attacker mail and a GitHub MCP server that read public issues, accessed private repos and leaked via PRs; incidents at Microsoft 365 Copilot, GitLab Duo, ChatGPT Operator. Mitigation: avoid the combination; prompt instructions are unreliable; treat guardrail products claiming e.g. "95%" detection with deep suspicion ("a failing grade in web application security"). — [Simon Willison, June 16 2025](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- Meta "Agents Rule of Two" (Oct 31 2025): within a session satisfy no more than two of [A] processes untrustworthy inputs, [B] access to sensitive systems or private data, [C] can change state or communicate externally; if all three are needed without a fresh context window, the agent must not run autonomously and needs HITL approval or another reliable validation. Willison calls it the best practical advice available. — [Simon Willison on new prompt injection papers, Nov 2 2025](https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/); [Databricks applying Rule of Two](https://www.databricks.com/blog/mitigating-risk-prompt-injection-ai-agents-databricks)
- Critique: individually Rule-of-Two-compliant agents can still create cascading harm in interconnected systems. — [Ken Huang Substack](https://kenhuangus.substack.com/p/the-rule-of-two-vs-reality-why-metas)
- "The Attacker Moves Second" (14 authors incl. OpenAI, Anthropic, Google DeepMind researchers): 12 published defenses bypassed by adaptive attacks at >90% success for most, despite originally reporting near-zero; human red-teaming reached 100%. — [Willison summary](https://simonwillison.net/2025/Nov/2/new-prompt-injection-papers/)
- "Design Patterns for Securing LLM Agents against Prompt Injections" (Beurer-Kellner et al., arXiv 2506.08837, June 2025) proposes principled patterns with provable resistance. — [arXiv 2506.08837](https://arxiv.org/abs/2506.08837). The pattern names (Action-Selector, Plan-Then-Execute, LLM Map-Reduce, Dual LLM, Code-Then-Execute, Context-Minimization) are from prior knowledge of the paper and Willison's June 2025 write-up, not re-verified in this session. Willison also points to CaMeL as promising. — [Willison lethal trifecta post](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)
- Claude Code mitigations in the trigger path: API fire text is wrapped and labeled untrusted; stored prompts must opt in; trigger cannot grant consent; network allowlist; branch prefix; per-task tokens; org kill switch (toggle stops existing tasks); a 72-hour auth-loss auto-disable. — [Claude Code docs](https://code.claude.com/docs/en/routines)
- Agent SDK supports audit via `PostToolUse` logging (async hooks for non-blocking logging), `PreCompact` to archive full transcripts, `InstructionsLoaded` to audit which instruction files load, `PermissionDenied` to log denials. — [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- Knight framework: L5 agents need usable logs and a reliable off-switch. — [Knight](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1)

### Inferences
- Concrete split for a harness: a "triage/reader" agent that sees untrusted content but has no sensitive tools and no external send (output = structured classification/summary in a constrained schema), and an "actor" agent with tools that receives only the structured output, never raw content (Dual-LLM / action-selector style). Any action that needs all three properties routes to the inbox for Review.
- Egress control (network allowlist, no arbitrary URL fetch with data in query strings, no rendering of attacker-controlled image URLs) closes the most common exfiltration channel.
- Kill switches at three scopes: per-run cancel, per-agent pause, global disable; plus auto-pause on anomaly (N denials, budget spike, repeated failures).
- Audit log must be append-only and include trigger payload hash, prompt version, model, tools called, approvals (who/when), and cost.

### Gaps
- Meta's original Rule of Two post was not fetched; details come via Willison and Databricks.
- No fetched source on CaMeL internals or on Anthropic/OpenAI official guidance specific to background-agent injection defenses.

## 7. Cost and observability: token budgets, run history, evaluating proactive suggestions

### Takeaway
Every trigger is a billable session, so cost control is mostly a trigger-layer problem (filters, debounce, caps, minimum intervals), and evaluation of proactivity needs outcome metrics beyond run success: acceptance rate/precision of surfaced items, false-alarm rate, and missed-opportunity recall.

### Cited Findings
- Claude Code scheduled-task runs "count against your account's usage and limits"; webhook events over hourly caps are dropped; crons more frequent than hourly are rejected; each run is a full inspectable session with Succeeded/Failed/Cancelled status, which does not indicate task success; `/schedule why did my nightly review do nothing this morning?` reads run logs, tool errors and permission denials. — [Claude Code docs](https://code.claude.com/docs/en/routines)
- ProactiveBench evaluates proactive suggestions with F1 against human accept/reject labels, including dedicated false-alarm scenarios; acceptance rate is the stated objective. — [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3)
- Durable execution avoids re-running completed LLM steps after failures (Temporal's motivation for the OpenAI Agents SDK integration). — [Temporal blog](https://temporal.io/blog/announcing-openai-agents-sdk-integration). A third-party claim of 35-75% wasted token budget without durability is unsourced and should not be used. — [growwstacks blog (unreliable)](https://growwstacks.com/blog/temporal-openai-agents-sdk-reliability/)
- Inngest waiting on human approval consumes no compute. — [Inngest durable agents HITL](https://www.inngest.com/docs/durable-execution/durable-agents/human-in-the-loop.md)

### Inferences
- Metrics to log per proactive item: surfaced (y/n), channel (interrupt/digest/silent), user decision (accept/edit/dismiss/ignore/expire), time-to-decision, tokens and USD, and downstream outcome (PR merged, email sent unedited). Derived KPIs: precision = accepted / surfaced; edit rate; false-alarm rate; interrupts per user per day; cost per accepted item; "no-op run" rate (runs that produced nothing, which signals over-triggering).
- Budget hierarchy: per-run token/USD ceiling, per-agent daily cap, global monthly cap, with cheap-model triage ahead of an expensive model for the actual work.
- Offline eval: replay historical event streams against a new policy/prompt version and score with labeled accept/reject data (ProactiveBench-style) before rollout.

### Gaps
- No vendor-published acceptance-rate benchmarks from production proactive agents were found.
- LangSmith/OpenTelemetry GenAI conventions for background agents were not fetched.

## 8. Concrete reference architectures

### Takeaway
The vendor material converges on one shape: triggers -> filter/flow-control -> durable agent run (checkpointed, sandboxed, least-privilege tools behind permission hooks) -> HITL interrupts surfaced in an inbox -> feedback into memory/policy, with audit logging and budgets around the whole thing.

### Cited Findings
- LangChain ambient agent stack: event stream / cron -> LangGraph agent with persistence and `interrupt` -> Agent Inbox (notify/question/review) -> long-term memory store. — [LangChain blog](https://www.langchain.com/blog/introducing-ambient-agents)
- Claude Code scheduled tasks: saved config (prompt + repos + connectors + cloud environment with setup script and network allowlist) <- triggers (schedule/API/GitHub with filters) -> new cloud session per event in auto mode (classifier-gated permissions, ask rules) -> output as `claude/` branch / PR / connector actions under user identity -> run history and per-run session for review. Example workloads in the docs: nightly backlog triage posting a Slack summary; on merged-PR event, port a change to a sibling SDK and open a PR. — [Claude Code docs](https://code.claude.com/docs/en/routines)
- Inngest durable agent: event -> function with flow control (debounce/throttle/rate-limit/batch, cancelOn) -> agent tool loop where dangerous tools call `step.waitForEvent` for approval with timeout/escalation. — [Inngest debounce](https://www.inngest.com/docs/guides/debounce), [Inngest HITL](https://www.inngest.com/docs-markdown/ai-patterns/human-in-the-loop)
- Temporal + OpenAI Agents SDK: Temporal workflow wraps the agent; model and tool calls are durable activities. — [Temporal blog](https://temporal.io/blog/announcing-openai-agents-sdk-integration)
- Claude Agent SDK as the in-process policy layer: PreToolUse (allow/deny/ask/defer, rewrite inputs), PostToolUse (audit, rewrite output), Notification (forward approvals to external channels), Stop/SessionEnd (persist state). — [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)

### Inferences
Synthesized reference architecture for a desktop/cloud harness (not from a single source):

```
[Sources] cron | webhook/API (signed, token-scoped) | repo/CI events | inbox/Slack poll (cursor) | file watcher
     |
[Ingest] normalize -> Event{source, entity_key, type, payload(untrusted), delivery_id}
     |   dedup (idempotency key) -> cheap rule filters -> flow control per entity_key
     |   (debounce | throttle | rate-limit | batch-to-digest | supersede) -> drop log
     |
[Triage] cheap model, NO sensitive tools, NO egress -> structured verdict
     |   {relevance, proposed_action, confidence, reversibility, urgency}
     |
[Initiative policy] thresholds per action class + learned acceptance score
     |   -> SILENT (log) | NOTIFY | QUESTION | REVIEW(draft) | ACT
     |   interruption budget, quiet hours, digest batching
     |
[Actor run] durable, checkpointed session; sandbox; least-privilege connectors;
     |   PreToolUse policy hooks; budget caps; irreversible/external => interrupt(REVIEW)
     |
[Inbox] pending notify/question/review items, timeouts/escalation, links to transcripts
     |
[Feedback & memory] accept/edit/dismiss/ignore -> preference store, threshold tuning
[Cross-cutting] append-only audit log, run history, cost meter, kill switches (run/agent/global)
```

- The triage/actor split is how the Rule of Two is satisfied in practice: triage has [A] only; the actor has [B]+[C] but sees only structured triage output; anything needing raw untrusted content plus [B]+[C] requires Review.

### Gaps
- No Microsoft or Google official proactive-agent reference diagrams were fetched in this pass (Azure Durable Functions / AI Foundry, Google ADK / Agentspace); the coordinator may want a separate check.
- Anthropic's "Building effective agents" (Dec 2024, https://www.anthropic.com/engineering/building-effective-agents) was not fetched this session, so its workflow/agent distinction is not cited here.
