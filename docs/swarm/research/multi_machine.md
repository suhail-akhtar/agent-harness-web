# A swarm across the person's computers: remote workers, consent and containment, failure, result integrity

Notes current to 2026-11-02, for [SWARM.md](../SWARM.md) phase 7 ("a swarm across the person's computers") and for the parts of phase 1c (the swarm governor) that reach other machines. Labels: **(vendor claim)** is a vendor's own statement; **[older: YEAR]** is material from before 2025; **(secondary)** means the primary source could not be reached; **(unverified)** means it was not checked against any primary source. The scope is consent-based and defensive. Incidents are described by what happened and what defended against them, with no attack procedures.

Related notes: [control.md](control.md) holds the governor's rules, and this note uses its numbers: rule 2 the kill switch, 3 no self-persistence, 7 leases, 8 kinds of work compiled to capability, 15 taint, 19 machines only by consent. [security.md](security.md) covers sandboxes and egress for security work. [reliability_verification.md](reliability_verification.md) covers verifier error rates. Acceptance as built is described in [COORDINATION.md](../../agents-mcp/COORDINATION.md) and implemented in `src/agents/acceptance.ts`.

---

## 0. The companion as built: the baseline every recommendation maps onto

I read the code on 2026-11-02 (`src/runtime/companion.ts`, `src/companion/{main,handler,desktop}.ts`, `src/server/app.ts`, `src/runtime/os-sandbox.ts`, `src/agents/acceptance.ts`, `src/core/permissions.ts`).

**Transport**
- The companion makes an outbound HTTPS long-poll to `/api/companion/poll`; the server holds each poll for up to 25 s.
- Results go to `/api/companion/result`, capped at 48 MB.
- Each poll reply carries one job. The companion polls again at once and runs jobs concurrently, with no cap.

**Identity**
- The companion holds a bearer token, `hwc_…`. The server stores its SHA-256.
- A token lives 30 days. After half its life, a poll's reply carries a fresh one, and the previous token stays valid for 60 minutes.
- Removing a companion revokes its token at once.
- The token is kept in `~/.harness-companion/<hash>.token` with mode 0600. It may also be passed as `--token`, which shows in the process list.

**Local policy, fixed when the companion starts**
- `--dir` sets the folder.
- `--sandbox` is `auto`, `bwrap`, `seatbelt`, `docker` or `off`. On Windows there is no OS sandbox, so `auto` means Docker if it is present and `off` otherwise.
- `--network` is `none` or `full`, default `full`. The companion has no allowlist mode, although sandboxes on the server sit behind the egress proxy.
- `--allow-hooks` permits `exec` jobs, which is how `run` checks are executed.
- `--trust-project` lets project MCP servers start without a sandbox.
- `--allow-desktop` gives access to the real screen, outside any sandbox.

The server cannot widen these flags. That is the right instinct, and the recommendations below extend it.

**Where trust sits**
- The server trusts what the machine says about itself. The poll reports platform, sandbox and network, and `host.sandboxed` is taken from that report. A host reported as sandboxed has its commands allowed without asking (`permissions.ts`: "runs in the sandbox").
- The server keeps everything else: permission decisions, hooks, the agent loop, model calls, provider keys and the transcript.
- Vault secrets are refused for companions.
- The mirror copied for server-side tools skips `.git`, `node_modules` and secret-looking files (`MIRROR_SKIP_FILE`).

**Failure handling**
- A companion is offline after 60 s without a poll, and `dispatch` then fails at once.
- Jobs and pending results live only in server memory.
- A tool job times out after 15 minutes; an `exec` job after its own timeout plus 30 s.
- **There is no cancel job.** An abort on the server drops the pending promise, but the tool on the machine keeps running. Its `ToolContext.signal` is a fresh signal that is never aborted, so it runs until the bash tool's own limit (120 s by default, 600 s at most).
- A result for a job the server no longer knows, for example after a restart, gets a 404 and is dropped. The agent then sees "did not answer in time" and may retry a call that already took effect.
- The companion keeps running jobs while it cannot reach the server.
- Inference from `src/tools/exec.ts`: `run_in_background` detaches with `setsid`/`nohup`. On a companion without a sandbox, nothing ties that process's lifetime to the job or to the companion.

**Acceptance on a companion**
- `run` checks execute on the worker's own machine, and only with `--allow-hooks`.
- `file`, `unchanged`, `absent` and test protection come back "not run", which counts as a fail.
- The change set is unavailable.
- Today, then, a companion's work is checked only by commands run on that same machine, using the exit codes it reports.

**Two problems found while reading**
1. The OS sandboxes hide the usual credential folders (`SECRET_DIRS`: `.ssh`, `.aws`, `.gnupg`, …) but not `~/.harness-companion`. A sandboxed command on Linux or macOS can therefore read the companion's own token, and with the default `--network full` send it anywhere. Whoever holds the token can poll as that machine, receive its jobs and return forged results.
2. The companion script is served unsigned by the harness server itself (`/companion.mjs`).

**Something that helps:** `edit` refuses to write when the file's mtime or size has changed since it was read (`src/tools/files.ts`). This is a compare-and-swap precondition, though only on metadata, and its stamps live in the companion's memory.

---

## 1. Prior art: distributed agent execution and remote workers

### Takeaway
Every mature system that runs work on machines it does not control has converged on the companion's shape: a worker dials out, claims work under a lease that each poll renews, runs it in a folder and posts the result. This holds for GitHub and Buildkite runners, Temporal workers, Claude Code self-hosted environments, Managed Agents self-hosted sandboxes, Cursor's self-hosted workers, Devin Outposts and Copilot's `--environment-host`.

The careful systems are separated from the rest by five things:
1. **Credentials split by purpose and lifetime**: registration, the machine's session and each job. The machine's own key never leaves it (GitHub's runner key pair; Buildkite's three tokens).
2. **A trust root the control plane does not hold**: Buildkite signed pipelines, BOINC's offline code-signing key, Tailscale Tailnet Lock.
3. **"Unreachable" as a state of its own.** The worker fences itself (Nomad `stop_on_client_after`), and work is re-placed only when it is idempotent.
4. **Single-use workspaces**, because a persistent worker carries one job's leftovers into the next. GitHub itself warns about this.
5. **The loop and the keys stay with the vendor; the machine only executes.** Managed Agents tells users to keep the API key "off the worker host".

The harness's tool-call remoting already has the Managed Agents shape, which keeps provider keys, policy and the kill switch on the server. It lacks the first four.

### Cited Findings

**CI runners**

GitHub Actions self-hosted runners:
- **Connection.** Outbound HTTPS only. The runner "uses an HTTP(S) long poll that opens a connection to GitHub for 50 seconds" [older: 2024, GHES 3.13] ([GitHub](https://docs.github.com/en/enterprise-server@3.13/actions/concepts/runners/communicating-with-self-hosted-runners)).
- **Queueing.** "If the runner doesn't pick up the assigned job within 60 seconds, the job is re-queued." A job queued for more than 24 h fails ([GitHub](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)).
- **Registration.** Registration tokens expire after one hour ([REST](https://docs.github.com/en/rest/actions/self-hosted-runners)).
- **Machine key.** Configuring a runner generates an RSA key pair. The private key stays on the machine, under DPAPI on Windows. The runner gets short-lived OAuth tokens by signing requests with that key. Job messages are encrypted to the runner's public key, and the job token lives at most the job timeout plus 10 minutes [older: undated design doc] ([actions/runner](https://github.com/actions/runner/blob/main/docs/design/auth.md)).
- **Ephemeral runners.** Ephemeral and JIT runners take one job, then de-register. Inactive runners are removed after 14 days, ephemeral ones after 1 day ([GitHub](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/remove-runners)).
- **GitHub's warnings.** Self-hosted runners "should almost never be used for public repositories" and "can be persistently compromised by untrusted code in a workflow". JIT runners are the recommended mitigation ([GitHub](https://docs.github.com/en/actions/reference/security/secure-use)).
- **Lost runners.** A runner lost mid-job fails the job ("lost communication with the server"); the job is not moved to another runner (secondary: [ARC issue](https://github.com/actions-runner-controller/actions-runner-controller/issues/466)).

Buildkite agents:
- **Three credentials.**
  - The agent token is long-lived and used only to register.
  - The session token lasts until the agent disconnects.
  - The job token, `BUILDKITE_AGENT_ACCESS_TOKEN`, is created when the job starts and expires when it finishes ([Buildkite](https://buildkite.com/docs/agent/v3/self-hosted/tokens)).
  - Per-job OIDC tokens default to a 5-minute `exp`, with a `sub` naming the pipeline, commit and step ([Buildkite](https://buildkite.com/docs/agent/cli/reference/oidc)).
- **Signed pipelines.** Steps are signed with JWS (EdDSA by default). The private JWKS sits only on the agents that upload pipelines, or in KMS; running agents hold only the public key. What is signed: commands, environment, plugins, the matrix and **the repository**, so a step cannot be replayed elsewhere. `verification-failure-behavior` defaults to `block` ([Buildkite](https://buildkite.com/docs/agent/v3/self-hosted/security/signed-pipelines)).
- **Lockdown on the machine.** `no-command-eval`, `no-plugins`, `no-local-hooks`, and regex allowlists `allowed-repositories` and `allowed-plugins`. The agent "refuses to run the job" on a mismatch ([Buildkite](https://buildkite.com/docs/agent/v3/self-hosted/security)).
- **Lost agents and cancellation.** An agent with no heartbeat for three consecutive minutes is marked lost within the next 60 s. Cancelling sends SIGTERM, then SIGKILL after `cancel-signal-timeout` (10 s) ([Buildkite](https://buildkite.com/docs/agent/lifecycle)).
- **Retries.** `retry.automatic` with `exit_status: -1` retries "when an agent is lost". The limit defaults to 2, maximum 10, and a cancelled job is never retried ([Buildkite](https://buildkite.com/docs/pipelines/configure/retry)).

**Orchestrators**

Nomad:
- **Heartbeats.** `heartbeat_grace` 10 s and `min_heartbeat_ttl` 10 s ([Nomad](https://developer.hashicorp.com/nomad/docs/configuration/server)).
- **The `disconnect` block** (1.8+) ([Nomad](https://developer.hashicorp.com/nomad/docs/job-specification/disconnect)):
  - `lost_after` makes a missed-heartbeat node's allocations **unknown**, not lost, so they may still be running.
  - `replace` (default true) places a replacement elsewhere.
  - `stop_on_client_after` makes the client stop its own allocations, a form of self-fencing. Because of clock drift, a replacement can start before the client has stopped.
  - `reconcile` chooses `best_score`, `keep_original`, `keep_replacement` or `longest_running` when the node returns.
- **Placement.** `constraint` is a hard rule; `affinity` is soft, with weight −100 to 100 ([Nomad](https://developer.hashicorp.com/nomad/docs/job-specification/affinity)). Node pools keep work off nodes in a way constraints cannot ([Nomad](https://developer.hashicorp.com/nomad/docs/concepts/node-pools)).
- **Workload identity.** Each task gets a JWT signed by the leader, renewed at about half its TTL ([Nomad](https://developer.hashicorp.com/nomad/docs/concepts/workload-identity)).

Kubernetes:
- **Node leases.** Leases are renewed every 10 s; `nodeLeaseDurationSeconds` is 40 ([kubelet](https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/)). `--node-monitor-grace-period` is 50 s in current docs and 40 s in older ones ([controller-manager](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-controller-manager/)).
- **Eviction.** Pods tolerate `unreachable` and `not-ready` for 300 s. On a partitioned node, "the pods that are scheduled for deletion may continue to run" ([K8s](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)).
- **At most one.** For StatefulSets, force-deleting a pod on an unreachable node risks two pods with one identity ([K8s](https://kubernetes.io/docs/tasks/run-application/force-delete-stateful-set-pod/)). The `out-of-service` taint is added by a person who has checked that the node is really off ([K8s](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/)).
- **Jobs.** "The same program may sometimes be started twice" even with parallelism 1. `podFailurePolicy` separates disruptions, which are not counted, from task failures, which are ([K8s](https://kubernetes.io/docs/concepts/workloads/controllers/job/)).

Ray:
- **Retries.** Tasks retry by default (`max_retries` 3) ([Ray](https://docs.ray.io/en/latest/ray-core/fault_tolerance/tasks.html)). Actor calls are at-most-once by default (`max_task_retries` 0), and the error "may be thrown even though the task did indeed execute successfully" ([Ray](https://docs.ray.io/en/latest/ray-core/fault_tolerance/actors.html)).
- **Security model.** "Anybody who can access the associated ports can execute arbitrary code" ([Ray](https://docs.ray.io/en/latest/ray-security/index.html)). Token authentication arrived only in 2.52, became the default in 2.59 (local clusters) and 2.61 (all clusters), and uses one shared token per cluster that never expires and travels in plaintext over http ([Ray](https://docs.ray.io/en/latest/ray-security/token-auth.html)).
- **ShadowRay 2.0** (Nov 2025, vendor research). Attackers used the unauthenticated Jobs API and `NodeAffinitySchedulingStrategy` to pin a job onto **every node**, spreading from cluster to cluster, with a cron job re-fetching the payload every 15 minutes ([Oligo](https://www.oligo.security/blog/shadowray-2-0-attackers-turn-ai-against-itself-in-global-campaign-that-hijacks-ai-into-self-propagating-botnet)). The first ShadowRay campaign [older: 2024] ran unnoticed for at least 7 months ([Oligo](https://www.oligo.security/blog/shadowray-attack-ai-workloads-actively-exploited-in-the-wild)).

HTCondor [older concept, current docs]:
- Matching is two-sided: the job's `Requirements` and the machine's `Requirements` must both hold.
- The machine's owner sets policy: `START`, `SUSPEND` and `PREEMPT` on `KeyboardIdle` and `LoadAvg`, with `MaxJobRetirementTime` as grace ([HTCondor](https://htcondor.readthedocs.io/en/latest/admin-manual/ep-policy-configuration.html)).

**Durable execution**

Temporal:
- **Polling.** Workers poll task queues outbound, "without needing to open exposed ports", and "the Temporal Service … doesn't execute any of your code" ([Temporal](https://docs.temporal.io/task-queue)).
- **Separate clocks.** schedule-to-start ("nobody picked it up"), start-to-close, heartbeat timeout and schedule-to-close. Heartbeats can carry progress for the next attempt, and **cancellation arrives only through heartbeats** ([Temporal](https://docs.temporal.io/encyclopedia/detecting-activity-failures)).
- **At-least-once.** Activities "may be executed multiple times and may even partially complete more than once". Use "Workflow Run ID and the Activity ID as an idempotency key" ([Temporal](https://docs.temporal.io/activity-definition)).
- **History limits.** 51,200 events or 50 MB ([Temporal](https://docs.temporal.io/workflow-execution/limits)).
- **Worker versioning.** Pins a running workflow to the build it started on ([Temporal](https://docs.temporal.io/worker-versioning)).
- **Payload codec.** Encrypts in the workers, so "the Temporal Service never has access to your encryption keys" ([Temporal](https://docs.temporal.io/codec-server)).

**Remote development runners**
- **Coder.** External provisioners run on the customer's hosts to "keep Coder unaware of cloud secrets", with scoped, tagged keys ([Coder](https://coder.com/docs/admin/provisioners)). An external workspace attaches an existing Windows or macOS machine with an agent token, and "Coder does not monitor the health of the external infrastructure" ([Coder](https://coder.com/docs/admin/templates/managing-templates/external-workspaces)).
- **Ona (formerly Gitpod).** "Source code, credentials, and build artifacts are handled by runners. They never reach the management plane", and each task gets its own VM (vendor claim) ([Ona](https://ona.com/docs/ona/understanding/how-ona-works)).

**Agent products that run work on machines they do not own**

Claude Code self-hosted environments (public beta, Team/Enterprise):
- **Polling and leases.** A runner polls `api.anthropic.com`, and "Anthropic never connects into your network". Each poll "refreshes the lease and doubles as the heartbeat". A lease lapses about 60 s after polling stops, and requeueing "can take a few minutes and sometimes longer". Each poll gets 10 s, and the backoff on errors rises to 20 s.
- **One owner per runner.** A runner locks to one owner on its first claim, so checked-out code never mixes between owners. With `--drain-grace-sec` at its default of 0, the runner exits when its sessions finish so it can restart on a fresh disk. `--retire-at` releases sessions before a known kill time.
- **What stays where.** The conversation and tool results go to Anthropic; checkouts, artifacts and secrets stay on the host ([Claude docs](https://code.claude.com/docs/en/self-hosted-environments)).
- **Session token.** An ES256 JWT, 4 h by default and 8 h at most, with an RFC 8693 `act` chain (user → runner → environment).
  - It does **not** prove "which process on the runner host presents it", since any code the session runs can read it.
  - "Anthropic doesn't publish a revocation feed for session tokens".
  - Every runner shares one environment secret ([Claude docs](https://code.claude.com/docs/en/self-hosted-environments-identity)).

Claude Managed Agents self-hosted sandboxes:
- The environment is a work queue. A worker claims items and runs `bash`, `read`, `write`, `edit`, `glob` and `grep` locally; "Tool inputs and outputs still flow to Anthropic's control plane".
- The API key: "Keep it off the worker host, where agent tool calls could read it" ([Claude docs](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)).
- Each poll waits up to 999 ms. `reclaim_older_than_ms` re-claims items that were claimed but never acknowledged, and each work item carries a per-session secret.
- The folder limit "is a guardrail for the file tools only, not a sandbox. It does not constrain `bash`" ([reference](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-reference)).
- **Closest prior art.** This protocol is the closest to the companion's: the agent loop runs on the vendor's side and tools run on the machine.

Claude Remote Control and Projects:
- **Remote Control.** The local machine makes "outbound HTTPS requests only", using "multiple short-lived credentials, each scoped to a single purpose". Server mode gives up after about 10 minutes offline ([Claude docs](https://code.claude.com/docs/en/remote-control)).
- **"Run a thread on your own computer".** Shows a card, "Allow Claude to work in a folder on your device", with a **Worktree** toggle and an **Allow once** button ([Claude docs](https://code.claude.com/docs/en/claude-projects)). This is consent per folder and per thread.

Claude Code sandboxing (Oct 2025):
- Bash can write only to the working folder, and network traffic leaves through "a proxy server running outside the sandbox". Both kinds of isolation are needed: without network isolation a compromised agent can exfiltrate SSH keys, and without filesystem isolation it can escape to reach the network.
- Prompts fell 84% in internal use (vendor claim) ([Anthropic](https://www.anthropic.com/engineering/claude-code-sandboxing)).
- In cloud sessions, git credentials stay outside the VM behind a proxy that checks a scoped credential. Current docs say the proxy "doesn't limit which branches a push can update", which conflicts with the 2025 post's "only to the configured branch" ([Claude docs](https://code.claude.com/docs/en/cloud-environments)).

OpenAI Codex:
- **Cloud.** Setup scripts run with internet access, and the agent phase has internet "off by default". Secrets are "only available to setup scripts" ([legacy page](https://learn.chatgpt.com/docs/environments/cloud-environment)). The current page describes a VM per task and "network secrets" substituted by a proxy ([OpenAI](https://learn.chatgpt.com/docs/environments/cloud-environments)). The two pages conflict: container versus VM.
- **Internet access.** The docs recommend allowing only GET, HEAD and OPTIONS, and give an example of a POST that leaks a commit ([OpenAI](https://learn.chatgpt.com/docs/cloud/internet-access)).
- **Local vs cloud.** A task cannot switch from local to cloud mid-turn ([OpenAI](https://learn.chatgpt.com/docs/remote-connections)).

GitHub Copilot coding agent:
- **Limits on what it can push and run.** It pushes only to its `copilot/` branch, cannot approve or merge, and workflows wait for "Approve and run workflows" ([GitHub](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations)).
- **Firewall.** It covers only processes the Bash tool starts, and "is not compatible with self-hosted runners" ([GitHub](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall); [GitHub](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment)).
- **Since 2026-10-28.** Sessions run in a cloud sandbox by default, with "no one-hour limit" and a snapshot when the sandbox stops. `--environment-host` registers "your own computer or VM" ([changelog](https://github.blog/changelog/2026-10-28-work-from-anywhere-with-a-new-connected-copilot-cloud-experience/)).
- **Local sandbox.** Uses Seatbelt, bubblewrap or MXC, and `sandbox.failIfUnavailable` makes it fail closed ([GitHub](https://docs.github.com/en/copilot/concepts/about-cloud-and-local-sandboxes)).

Cursor:
- **Self-hosted workers.** `agent worker start` holds an outbound HTTPS connection over which "Cursor sends agent tool calls". No sandbox is described: tasks run as the worker's OS user, and once a worker claims a chat, everything in that chat goes to it.
- **Limits.** 200 workers per user and 1,000 per team. Pool workers need a service-account key ([Cursor](https://cursor.com/docs/cloud-agent/bring-your-own-machine)).
- **Cloud agents.** They auto-run commands with internet on by default, and Cursor's own warning is that this "introduces data exfiltration risk" through prompt injection ([Cursor](https://cursor.com/docs/cloud-agent/security-network)).

Devin, OpenHands and frameworks:
- **Devin Outposts.** `devin worker start` dials out, and "N workers serve N concurrent sessions". Passwordless sudo is allowed only "when the machine is dedicated to Devin and recycled after each session" ([Devin](https://docs.devin.ai/cloud/outposts/overview)).
- **OpenHands.** The agent server starts with **no authentication** when no `X-Session-API-Key` is configured ([OpenHands](https://docs.openhands.dev/sdk/arch/agent-server)).
- **AutoGen.** The gRPC distributed runtime is "experimental", and its docs describe neither authentication nor failure recovery ([AutoGen](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/framework/distributed-agent-runtime.html)).
- **Dapr.** DurableAgents persist every LLM and tool call so a restarted agent can resume ([Dapr](https://docs.dapr.io/developing-ai/dapr-agents/dapr-agents-why/)).
- **A2A 1.0.** Requires TLS, allows JWS-signed Agent Cards, and asks for idempotent processing of push notifications ([A2A](https://a2a-protocol.org/latest/specification/)).

Windows 11 agentic features:
- Agents get their own accounts and an agent workspace in a separate Windows session. Access to known folders can be set per agent: Allow Always, Ask every time, or Never.
- Microsoft's own warning: "malicious content embedded in UI elements or documents can override agent instructions" ([Microsoft](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features); [Windows blog](https://blogs.windows.com/windowsexperience/2025/10/16/securing-ai-agents-on-windows/)).
- MCP servers in the on-device registry run under an agent account, but file access is granted "for the host and not per server" ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/ai/mcp/servers/mcp-containment)).

**Sandbox platforms (for what isolation on a personal machine should match)**
- **E2B.** Firecracker microVMs. Egress rules by IP, CIDR or domain, though "blocked TCP connections may appear successful from inside the sandbox". Pausing takes about 4 s per GiB and resuming about 1 s ([E2B](https://docs.e2b.dev/sandbox/internet-access); [E2B](https://docs.e2b.dev/sandbox/persistence)).
- **Modal.** gVisor by default, with `block_network` and domain allowlists, TLS on 443 only, in beta ([Modal](https://modal.com/docs/guide/sandbox-networking)).
- **Vercel Sandbox.** "Credentials brokering": the firewall injects headers, so "secrets never enter the sandbox". The docs warn about domain fronting and DNS exfiltration ([Vercel](https://vercel.com/docs/sandbox/concepts/firewall)).
- **Docker Sandboxes.** A microVM per sandbox, with a proxy on the host. The agent sees a placeholder secret, and outbound TCP is blocked unless a rule allows it. Two warnings: local MCP servers run on the host with host permissions, and git hooks do not show in `git diff` ([Docker](https://docs.docker.com/ai/sandboxes/architecture/); [Docker](https://docs.docker.com/ai/sandboxes/security/)).
- **exo** (distributed inference on home devices). Peers on a LAN discover each other with no authentication between nodes. That is fine for inference and wrong for tool execution ([exo](https://github.com/exo-explore/exo)).

| System | How work reaches the machine | Machine credential | Liveness, and what happens when the machine is lost | Placement | Isolation on the machine |
|---|---|---|---|---|---|
| Companion today | long-poll, 25 s | 30-day bearer, rotated | offline at 60 s; `dispatch` fails; no cancel | the session names one machine | bwrap, Seatbelt, Docker or none |
| GitHub runner | long-poll, 50 s | its own RSA key; job token | not picked up in 60 s: re-queued; lost mid-job: job fails | labels and groups | none (ephemeral/JIT advised) |
| Buildkite | poll and stream | agent / session / job tokens | lost after 3 min + 60 s; retry on −1 | queue and tags | hooks and allowlists on the agent; signed steps |
| Nomad | RPC | node secret; per-task JWT | `unknown` → `lost`; `stop_on_client_after` | constraint, affinity, pool | task drivers |
| Temporal | poll task queues | mTLS / API keys | heartbeat timeout → retry (at-least-once) | task queue | the worker's own |
| Claude self-hosted env. | poll = lease, 10 s | one shared environment secret; ES256 session JWT 4-8 h | lease lapses about 60 s; requeue in minutes | environment; owner lock | the runner image's |
| Managed Agents self-hosted | poll ≤999 ms; claim → ack | environment key; per-session secret | reclaim if not acknowledged | environment | none built in ("not a sandbox") |
| Cursor workers | long-lived HTTPS | personal login / service key | "Worker offline" | My Machines / pools | none described |

### Inferences
- **Keep tool-call remoting.** The harness's model is the Managed Agents model: the loop runs on the server and tools run on the machine. It is the right one for a swarm across personal machines.
  - Provider keys never reach the machines.
  - The governor sees every step.
  - The kill switch acts first at the server.
  - The agent's state, the transcript and each tool result, is already on the server. A worker that drops loses only the folder's state, which a git worktree and a shipped patch can carry.
  - Running the whole loop on the machine (Claude Code self-hosted, Cursor workers) would put keys or a key-holding proxy on every machine and blind the governor.
  - The cost is a network round trip per tool call: at 100 ms RTT, 300 calls add about 30 s, which is acceptable.
- **The poll is already the heartbeat.** It should also become the lease renewal for every job the machine runs (Claude's design), with a claim → acknowledge → heartbeat → result → stop protocol (Managed Agents) and a short "claimed but not acknowledged" re-queue (GitHub's 60 s).
- **"Allow once, in this folder, in a worktree"** (Claude Projects) and **per-agent folder access** (Windows) are the consent shapes products have shipped. A swarm needs the same shape for each run's charter, not one switch per machine.
- **Every product that moved work onto users' machines shipped without a sandbox on the machine** (Cursor workers, Managed Agents' worker, Devin Outposts, the GitHub runner) and pushed isolation onto the user. On a person's own laptop, "the user handles isolation" means none.

### Gaps
- None of these systems documents what happens to a command still running on a machine whose lease lapsed. Nomad's `stop_on_client_after` is the only explicit self-fence found.
- Not published: GitHub's server-side timeout before a lost runner's job fails; Buildkite's heartbeat interval; Claude Remote Control's poll and lease values.
- No product publishes measured rates of lost or duplicated work per machine.

---

## 2. Consent, containment and security on the person's computers

### Takeaway
In nearly every incident below, **whoever controlled the channel controlled every machine on it**: the Codecov uploader, runners turned into backdoors (PyTorch, Shai-Hulud 2.0), ShadowRay's job API, an agent-control token (OpenClaw). Today the harness server makes the permission decisions *and* serves the companion script. A compromised server, or a stolen administrator session, could therefore run commands as the person on every connected machine, and on a Windows machine without Docker the sandbox is `off`.

The defences that held in practice share three features:
1. **Trust lives in keys the server does not hold**: Buildkite signed pipelines, Tailnet Lock, BOINC's offline signing key, TUF.
2. **The machine keeps its own policy, and the server can only narrow it.**
3. **Credentials are short-lived and bound to the device** (DPoP, TPM or Secure Enclave keys, Chrome DBSC).

Prompt injection moving between agents is measured in labs at high rates (65–97% inside multi-agent frameworks). I found no confirmed in-the-wild case of it moving between a person's machines. The realistic paths are artefacts rather than a channel: git remotes, synced folders and project config files.

### Threat model: one server, many personal machines

| # | Threat | How it would happen with the companion today | Blast radius today | Control that held elsewhere |
|---|---|---|---|---|
| T1 | A compromised server, or a stolen admin or person session, pushes commands | The server can send `tool` jobs (bash, write, edit) to any online companion. Permission prompts run on the server, so it can skip them. It also serves `/companion.mjs` | Code execution as the person, with the folder's rights where sandboxed, or the user's full rights with `--sandbox off` (Windows without Docker). It can also copy the whole folder | Person-held signing key that the machine verifies (Buildkite, Tailnet Lock); signed releases with an offline key (BOINC, TUF); machine-local policy; fail closed |
| T2 | A stolen companion token | `~/.harness-companion/*.token` can be read by sandboxed commands, and network defaults to full | The attacker polls as that machine: it receives jobs, which carry file contents and commands, and returns forged results | A key that cannot be exported (GitHub runner RSA, TPM, Secure Enclave); sender-constrained tokens (DPoP); per-job tokens that die with the job (Buildkite) |
| T3 | A compromised machine forges results or attacks the server | It sends forged exit codes for `run` checks, fake mirror contents, or hostile payloads (the 48 MB cap and `mirrorPath` checks exist) | Work is wrongly accepted, and its outputs are injected into the lead's context | Re-run checks in another trust domain (section 4); treat every output as untrusted data; validate each field (mcp-remote, OpenClaw) |
| T4 | Prompt injection spreads from one machine to others | Paths: the machine's output reaches the lead, which writes briefs for agents on other machines; a shared git remote (AgentHopper); synced folders; project config files (`.vscode/tasks.json`, `.mcp.json`, `.harness/`) | Every machine that pulls the artefact or receives the brief | Taint follows the tree (control.md rule 15); no machine-to-machine channel; protected config paths; refuse synced folders; push only through a server outbox to work branches |
| T5 | Lateral movement and persistence | Credentials in the folder; processes that outlive a job (`setsid`/`nohup`); autostart locations and rc files when unsandboxed; registering new runners or companions | Everything the person's account can reach | A fresh sandbox per job with the whole process tree killed (Job Objects, cgroups); writes to autostart locations denied; agents cannot mint tokens (control.md rule 3) |
| T6 | Destructive fallback | Shai-Hulud 2.0's wipe when it could not spread; the Amazon Q wiper prompt | The writable scope: the folder, or the whole home with `off` | Worktree or snapshot per attempt; checkpoints before edits (already done for companion edits); writes denied outside the folder |
| T7 | Runaway placement | A "run on every machine" primitive (ShadowRay 2.0's NodeAffinity on every node) | All machines | Per-run machine list in the charter; caps per machine; no broadcast primitive |

### Cited Findings

**Incidents: CI runners and supply chains that made machines remote-controlled**
- **PyTorch self-hosted runners** (reported 2023, published Jan 2024) [older: 2024].
  - A contributor's fork PR ran on non-ephemeral self-hosted runners.
  - The researchers kept access by registering a second, genuine runner agent to their own organisation. Because it was the genuine runner binary, it passed EDR and firewalls.
  - They obtained tokens reaching more than 93 repositories and AWS keys to the release buckets.
  - Fixes: approval for outside contributors, and ephemeral runners ([Stawinski](https://johnstawinski.com/2024/01/11/playing-with-fire-how-we-executed-a-critical-supply-chain-attack-on-pytorch/)).
- **tj-actions/changed-files** (CVE-2025-30066, Mar 2025).
  - A chain of leaked PATs let the attacker rewrite every tag of an action used by more than 23,000 repositories, so that it printed CI secrets to logs. Tag pushes were missing from the free-tier audit log.
  - Fixes: pin to commit SHAs, and use no long-lived PATs ([Unit 42](https://unit42.paloaltonetworks.com/github-actions-supply-chain-attack/); [CISA](https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-github-action-cve-2025-30066)).
- **Ultralytics** (Dec 2024) [older: 2024]. Actions injection and cache poisoning, then a leftover API token that had never been revoked. Trusted publishing made the attack auditable but did not stop it ([PyPI](https://blog.pypi.org/posts/2024-12-11-ultralytics-attack-analysis/)).
- **Nx "s1ngularity"** (Aug 2025). A postinstall script ran the developer's **own locally installed AI CLIs** with their permission-skipping flags to inventory secrets, then published the results to repositories on the victim's own GitHub account. Wiz counted more than 1,000 valid GitHub tokens in phase 1 and more than 5,500 private repositories made public in phase 2 ([Nx advisory](https://github.com/nrwl/nx/security/advisories/GHSA-cxm3-wv7p-598c); [Wiz](https://www.wiz.io/blog/s1ngularity-supply-chain-attack)).
  - Lesson: an agent tool on a machine is a capability that anything running as the person can use.
- **Shai-Hulud 2.0** (Nov 2025).
  - It registered each infected machine as a self-hosted runner named `SHA1HULUD`, plus a workflow that ran the body of any GitHub Discussion as a command. All its control traffic went to github.com.
  - `RUNNER_TRACKING_ID: 0` kept child processes alive after job cleanup, and it used the Docker socket to gain root.
  - Wiz validated the backdoor but did not see it used ([Wiz](https://www.wiz.io/blog/shai-hulud-2-0-ongoing-supply-chain-attack); [Sysdig](https://www.sysdig.com/blog/how-threat-actors-are-using-self-hosted-github-actions-runners-as-backdoors)).
  - A home-directory wipe when it could not spread is reported by secondary sources ([mnemonic](https://www.mnemonic.io/resources/blog/advisory-shai-hulud-2.0-supply-chain-campaign-rapidly-spreading-through-npm-packages-and-github/)).
  - Lesson: registering a remote worker is itself the persistence mechanism.
- **Amazon Q Developer 1.84.0** (CVE-2025-8217, Jul 2025). An over-scoped token let an attacker commit a wiper prompt into a shipped extension. AWS says it "failed to run because of a syntax error" (vendor claim) ([AWS](https://aws.amazon.com/security/security-bulletins/AWS-2025-015/)).
- **Cline** (Jan–Feb 2026).
  - An AI issue-triage workflow ran `claude-code-action` with Bash access and could be triggered by any GitHub user.
  - A crafted issue title gave shell access on the runner. A cache shared with the release workflow then exposed the npm token.
  - The team "deleted the wrong token": the org-level page showed none, but the exposed token stayed active until `cline@2.3.0` was published about 8 hours later. That package installed an unrelated open-source tool on postinstall, and the post-mortem says no malicious code was delivered.
  - Fixes: no shell in AI automation, no cache in credential-handling workflows, OIDC publishing, and checking revocation against the actual credential ([Cline](https://cline.bot/blog/post-mortem-unauthorized-cline-cli-npm)).
- **Gheist** (Sep–Oct 2026).
  - Stolen tokens from more than 850 accounts planted more than 13,500 branches carrying a workflow that base32-encoded the secrets context to get past log masking. The run was then deleted seconds later.
  - From 19 Oct it swept self-hosted runners: credential files, `/proc` environments, a host-root mount through the Docker socket, instance metadata.
  - GitHub's approval hold for suspicious runs, in place since 28 Jul 2026, stopped it in public repositories but does not apply to private repositories or GHES.
  - Wiz advises running self-hosted runners as ephemeral hosts without the Docker socket or unrestricted metadata access ([Wiz](https://www.wiz.io/blog/gheist-attempted-scaled-abuse-of-stolen-github-tokens-stumbles)).
- **TeamPCP / Trivy** (Mar 2026). 75 of 76 action tags were rewritten, and the payload read secrets from runner process memory through `/proc/<pid>/mem`, bypassing log masking (secondary: [CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-teampcp-supply-chain-ci-cd-20260324-csa-st/)).
- **Older**:
  - CircleCI: malware on an engineer's laptop stole an SSO session that had passed 2FA, which then reached customer secrets [older: 2023] ([CircleCI](https://circleci.com/blog/jan-4-2023-incident-report)).
  - Codecov: a modified `curl | bash` uploader ran for two months, until a customer compared the script's hash with the one on GitHub [older: 2021] ([Codecov](https://about.codecov.io/security-update/)). This maps directly onto `/companion.mjs` being served by the server.
  - xz-utils: a backdoor present only in release tarballs [older: 2024] ([oss-security](https://www.openwall.com/lists/oss-security/2024/03/29/4)).

**Agents escalating through their own configuration, and propagation between agents**
- **Copilot CVE-2025-53773.** Injected text made the agent write `"chat.tools.autoApprove": true` into the workspace settings. The researcher's rule: an agent must not be able to change its own security settings ([Embrace the Red](https://embracethered.com/blog/posts/2025/github-copilot-remote-code-execution-via-prompt-injection)).
- **Cursor CVE-2025-54135** (creating a new `.cursor/mcp.json` needed no approval) and **CVE-2025-54136** (an approved MCP entry's command could be swapped later). The lesson is to bind approval to a hash of the exact command ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2025-54135); [THN](https://thehackernews.com/2025/08/cursor-ai-code-editor-vulnerability.html)).
- **Claude Code project-file CVEs** (Check Point; fixed in 2.0.65).
  - Repository hooks.
  - MCP consent bypass (CVE-2025-59536).
  - `ANTHROPIC_BASE_URL` in project settings sending the key before the trust dialog (CVE-2026-21852) (secondary: [The Register](https://www.theregister.com/2026/02/26/clade_code_cves/)).
- **mcp-remote CVE-2025-6514.** A malicious server's `authorization_endpoint` gave command injection on the client. This is the shape of a hostile server attacking its own client ([CVE](https://www.cvelogic.com/cve/CVE-2025-6514)).
- **OpenClaw CVE-2026-25253.** The control UI trusted a `gatewayUrl` parameter and sent its gateway token there, and that token could switch off execution approvals (secondary: [THN](https://thehackernews.com/2026/02/openclaw-bug-enables-one-click-remote.html)). Lesson: a single agent-control token is a remote shell.
- **Invariant Labs, GitHub MCP** (May 2025). A public issue led an agent to copy private-repository data into a public PR. Mitigation: one repository per session, enforced at runtime ([Invariant](https://invariantlabs.ai/blog/mcp-github-vulnerability)).
- **"Comment and Control"** (2026). PR titles and comments hijacked AI review actions into leaking Actions secrets ([Guan](https://oddguan.com/blog/comment-and-control/)).
- **Propagation results, all from labs:**
  - Magentic-One on GPT-4o ran arbitrary code 97% of the time after reading a malicious local file ([Triedman et al., COLM 2025](https://arxiv.org/abs/2503.12188)).
  - Prompt Infection: LLM-to-LLM self-replication reached agents that never saw external input [older: 2024] ([arXiv 2410.07283](https://arxiv.org/abs/2410.07283)).
  - AgentHopper: a proof of concept that infected repositories and pushed them with the developer's existing git credentials, so the next agent to pull them was infected ([Embrace the Red](https://embracethered.com/blog/posts/2025/agenthopper-a-poc-ai-virus)).
  - GitInject: every one of 4 providers was vulnerable in its default CI configuration, and the critical flaws were structural (credentials, config files) (unverified: [arXiv 2606.09935](https://arxiv.org/abs/2606.09935)).

**Containment per OS (state in late 2026)**

Windows:
- **MXC (Microsoft Execution Containers).** Process isolation on Windows 11 24H2 build 26100.9278 and 25H2 build 26200.9278 or later. It needs no administrator setup, no extra accounts and no firewall rules, and "remaining child processes stop when the foreground command exits".
  - Codex's fallbacks: "elevated" (dedicated lower-privilege sandbox users, ACLs, firewall rules; needs administrator setup) and "unelevated" (a restricted token derived from the user, ACLs, and "weaker network isolation").
  - Deny-read globs are evaluated when the process starts ([Codex](https://learn.chatgpt.com/docs/windows/windows-sandbox)).
  - Microsoft's announcement: [Windows blog](https://blogs.windows.com/windowsdeveloper/2026/06/02/windows-platform-security-for-ai-agents/). General availability is reported for Oct 2026 by secondary sources only ([eSecurity Planet](https://www.esecurityplanet.com/endpoint-security/news-microsoft-execution-containers-for-ai-agents-reach-ga/)).
- **srt on Windows** (alpha). A dedicated `srt-sandbox` account, a WFP egress fence keyed on its SID, and a write-restricted token. Documented gaps: DNS through Dnscache, SMB and WSL traffic, some impersonation paths ([srt](https://github.com/anthropic-experimental/sandbox-runtime)).
- **Windows Sandbox.** A disposable Hyper-V VM, on Pro, Enterprise and Education only, one at a time. Networking, vGPU and clipboard are on by default. Writes to a writable mapped folder persist. `.wsb` keys: `Networking`, `MappedFolder/ReadOnly`, `ProtectedClient` ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)).
- **WSL2 is not a boundary by default.** `[automount]` mounts every fixed drive, and `[interop]` launches Windows processes as the user. `/etc/wsl.conf` lives inside the distribution, so root there can undo any hardening ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)).
- **Docker Desktop ECI.** Blocks `docker.sock` mounts and maps container root to an unprivileged user, but bind-mounted host folders stay exposed ([Docker](https://docs.docker.com/enterprise/security/hardened-desktop/enhanced-container-isolation/)).
- **AppContainer.** Capability-based network and file isolation ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)).

macOS:
- **Seatbelt** (`sandbox-exec`) is deprecated but used by Codex, srt and this harness. Its profile language is undocumented, and Codex issue #10390 reported its network setting having no effect ([Codex](https://github.com/openai/codex/issues/10390)).
- **Apple `container`** (WWDC 2025) runs a lightweight VM per Linux container, on Apple silicon with macOS 26 only ([Apple](https://github.com/apple/container)).

Linux:
- **bubblewrap and AppArmor.** On Ubuntu 23.10 and later, AppArmor restricts unprivileged user namespaces, which breaks bubblewrap unless a profile allows it. The blunt workaround, `kernel.apparmor_restrict_unprivileged_userns=0`, weakens every application on the machine ([Ubuntu](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)). Qualys found three bypasses of the restriction [older: Mar 2025] ([Qualys](https://www.qualys.com/2025/three-bypasses-of-Ubuntu-unprivileged-user-namespace-restrictions.txt)).
- **Landlock** network rules match ports only, not hosts, so Landlock cannot implement a domain allowlist ([kernel docs](https://docs.kernel.org/userspace-api/landlock.html)).

Egress and secrets:
- **srt's protected write paths.** Writes are always denied to shell rc files, `.gitconfig`, `.git/hooks`, `.git/config`, `.vscode/`, `.mcp.json`, `.claude/commands` and `.claude/agents`.
- **srt's read and DNS caveats.** Reads are open unless denied. DNS through the system resolver is not fenced on macOS or Windows. srt must be installed outside every writable path, or a sandboxed command can rewrite the sandbox it runs in ([srt](https://github.com/anthropic-experimental/sandbox-runtime)).
- **CVE-2025-66479.** sandbox-runtime before 0.0.16 "did not properly enforce a network sandbox if the sandbox policy did not configure any allowed domains". It failed open on exactly the no-network case ([GitLab advisory](https://advisories.gitlab.com/npm/@anthropic-ai/sandbox-runtime/CVE-2025-66479/)).
- **Brokered secrets.** Secrets injected outside the boundary, as placeholders swapped by a proxy, are now standard: Vercel, Docker Sandboxes, Codex and Claude cloud sessions (sources above).

**Trust against a compromised control plane**
- **Tailnet Lock.** The coordination server cannot add a node unless the node key is signed by a lock key held on the person's own devices (2 to 20 signing nodes). It offers ten one-time disablement secrets and a per-node `local-disable` as a last resort ([Tailscale](https://tailscale.com/kb/1226/tailnet-lock)).
- **BOINC code signing.** The goal is "to prevent hackers - even if they've broken into your server - from using your project to distribute malware". The private key lives on a machine that is never networked, and each old key signs its successor ([BOINC](https://github.com/BOINC/boinc/wiki/Code-signing)).
- **TUF.** Threshold-signed roles, an offline root, and expiring timestamps against rollback and freeze attacks ([TUF](https://theupdateframework.io/security/)). **Sigstore** adds a transparency log ([Sigstore](https://docs.sigstore.dev/signing/overview/)).
- **Bound tokens.** Sender-constrained tokens through DPoP ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)) or mTLS ([RFC 8705](https://www.rfc-editor.org/rfc/rfc8705)). Non-exportable keys in the TPM or Secure Enclave ([Apple](https://developer.apple.com/documentation/security/protecting-keys-with-the-secure-enclave)). Chrome DBSC binds sessions to a TPM key and became generally available for Workspace in May 2026 ([Google](https://workspaceupdates.googleblog.com/2026/05/prevent-account-takeovers-with-DBSC-now-generally-available-in-the-Chrome-browser-for-Windows.html)). CircleCI shows what a bearer session allows: a stolen one got past 2FA.
- **Enrolling a headless machine with the OAuth device grant** ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628#section-5.4)) is phishable: Storm-2372 has used it in campaigns since 2024 ([Microsoft](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/)). The approval page must show the machine's name, OS and key fingerprint.
- **Tamper-evident logs.** Hash chains and Merkle trees ([Crosby & Wallach](https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf) [older: 2009]; [RFC 9162](https://www.rfc-editor.org/rfc/rfc9162)). Attackers delete evidence (Gheist deleted its runs; tj-actions' tag pushes went unlogged), so a copy of the log belongs off the server.

### Inferences
- **The server-side permission model protects the person from the agent, not from the server.** Phase 7 multiplies what the server can reach. So the machine needs a policy of its own: which folder, which kinds of work, sandbox required, network allowlist, capacity and hours. The server may narrow that policy, never widen it. For swarm work, the machine should also need a consent grant signed by a key the person holds on a trusted device, not by the server. This is the Buildkite and Tailnet Lock pattern applied to the charter. With it, a compromised server can deny service or run work inside what the person signed, and nothing more.
- **For swarm work, "sandbox off" means no swarm.** Windows is the gap: MXC where the build supports it, then a separate sandbox account in the srt or Codex "elevated" style, then Docker. Otherwise the machine is refused for swarm work. The person's own conversation on that machine can keep today's asking.
- **The companion's token is its weakest point.** It should be hidden from sandboxed commands now, and replaced by a key generated on the machine, so that stealing the file does not hand over the identity.
- **Consent must be per machine, per kind of work, per run and revocable.** Read-only, writing and network work compile to capability (control.md rule 8). Revocation must work in two places: the server stops dispatching and revokes the lease, and the companion stops by itself when its lease is not renewed. Neither may depend on the other.
- **SWARM.md's "nothing leaves a machine except the results and their evidence" needs restating.** With tool-call remoting, whatever a tool reads (file contents, command output) goes to the server and to the model provider. The honest version: *nothing leaves except what the agent's tools read and return. Files matching the machine's read-deny list never do, and neither do secrets.* The read-deny list must apply to tool reads on the companion, not only to the mirror.

### Gaps
- No primary Microsoft documentation of MXC's isolation mechanism was reached: process-level or hypervisor-backed? Editions? General availability?
- No measured cross-machine propagation of prompt injection between a person's devices.
- Docker ECI licensing; the current state of Seatbelt network settings on macOS 26/27; whether the companion's `docker` mode exposes metadata endpoints. None was verified.

---

## 3. Scheduling and failure

### Takeaway
You cannot tell a slow machine from a dead one, and you cannot get exactly-once side effects in the outside world. Systems that work accept both facts:
- **Leases with fencing.** Every attempt carries an epoch, and the server rejects writes and results from a stale one. Kleppmann shows why a lease alone is not enough.
- **The worker fences itself.** It stops when it cannot renew its lease (Nomad `stop_on_client_after`). The server waits for TTL plus a margin before re-placing.
- **"Unknown" as a state of its own**, before "lost".
- **At-least-once with idempotency keys** for retryable steps, **at-most-once** for side effects that cannot be made idempotent, and a person for indeterminate outcomes (Stripe, Brandur).
- **Durable execution that journals each LLM output and tool result**, so a resumed run replays them and does not re-call (Temporal, DBOS, Restate, Inngest, LangGraph).

The harness's agent loop already lives on the server, so the journal is close to the transcript. What a machine failure loses is the folder's state. Placement should treat data locality as a hard constraint: a laptop's files cannot be re-placed. Capability, idle state and power are soft.

### Cited Findings

**Leases and fencing**
- **Leases** (Gray & Cheriton, SOSP 1989) [older: 1989]. A server that cannot reach a lease holder must wait for the lease to expire before granting a conflicting one. Safety needs bounded clock drift ([ACM](https://dl.acm.org/doi/10.1145/74850.74870)).
- **Fencing tokens** (Kleppmann 2016) [older: 2016].
  - A process paused by GC, SIGSTOP or starvation can act after its lease expired. Checking expiry just before writing does not help.
  - The fix is a strictly increasing **fencing token**, which the *resource* checks: a write carrying token 33 is rejected after token 34 has written ([Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)).
  - Fencing works only where the resource checks tokens. A stale write that lands *first* still takes effect ([analysis, 2025](https://surfingcomplexity.blog/2025/03/03/locks-leases-fencing-tokens-fizzbee/)).
- **Chubby** [older: 2006] had both mechanisms: sequencers that servers validate, and a lock-delay for servers that cannot ([USENIX](https://www.usenix.org/legacy/events/osdi06/tech/burrows.html)).

**Failure detectors**
- **Detectors are unreliable in principle** in an asynchronous system, which is why they trade completeness against accuracy [older: 1996] ([Chandra & Toueg](https://cs.nyu.edu/~apanda/classes/sp25/papers/chandra-toueg.pdf)).
- **Phi accrual** outputs a suspicion level rather than a verdict: φ = −log10(1 − F(time since the last heartbeat)). Akka uses a threshold of 8 with 1 s heartbeats ([Akka](https://doc.akka.io/libraries/akka-core/current/typed/failure-detector.html)).
- **SWIM** adds a *Suspect* state with incarnation numbers before *Confirm*, so a slow node can refute the suspicion [older: 2002] ([SWIM](https://courses.grainger.illinois.edu/cs425/fa2022/dsn02-SWIM.pdf)).
- For a star topology like the companion's, gossip is unnecessary. What carries over: a timeout that adapts to each machine (laptops sleep, Wi-Fi drops) and an explicit suspect state.

**Delivery semantics and side effects**
- **Exactly-once delivery is impossible**, because a lost message cannot be told from a lost acknowledgement. "Exactly once" in practice means at-least-once plus deduplication [older: 2015] ([Brave New Geek](https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/)).
- **Stripe idempotency keys.** The first response is saved, even a 500, and replayed for retries. A reused key with different parameters is an error, and keys are pruned after at least 24 h ([Stripe](https://docs.stripe.com/api/idempotent_requests)).
- **Brandur's design.** Atomic phases with recovery points between "foreign state mutations". A non-idempotent foreign call whose outcome is unknown is recorded as a permanent failure, not retried [older: 2017] ([Brandur](https://brandur.org/idempotency-keys)).
- **Transactional outbox.** The message is written in the same transaction as the state, and the relay may publish twice ([microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)).
- **Sagas.** Compensations are semantic undo: a sent email stays sent [older: 1987] ([SIGMOD 1987](https://bibtex.github.io/SIGMOD-1987-Garcia-MolinaS.html)).
- **Git as a precondition.** `git push --force-with-lease=<ref>:<expect>` is a compare-and-swap on a remote ref ([git](https://git-scm.com/docs/git-push)).

**Durable execution for agents (2025-26)**
- **Temporal with the OpenAI Agents SDK** (generally available Mar 2026).
  - Each model call becomes an Activity, and the loop runs in the deterministic Workflow.
  - On replay, Activity results are reused, so a completed LLM call is not repeated.
  - I/O tools must be wrapped (`activity_as_tool`) ([Temporal](https://temporal.io/blog/announcing-openai-agents-sdk-integration); [docs](https://docs.temporal.io/develop/python/integrations/openai-agents)).
- **Pydantic AI** (Temporal, DBOS, Prefect, Restate). Completed calls are replayed from the journal; the one in flight is **retried** ([Pydantic](https://pydantic.dev/docs/ai/integrations/durable_execution/overview/)).
- **DBOS.** A step that was running at the moment of a crash is retried, so steps must be idempotent ([DBOS](https://docs.dbos.dev/architecture)).
- **Inngest.** Refunds must be idempotent "because a refund can succeed before Inngest saves the step result" ([Inngest](https://www.inngest.com/docs/durable-execution/durable-workflows)).
- **Restate** claims "side effects are executed exactly once" (vendor claim). That conflicts with the in-flight retry every other engine admits ([Restate](https://docs.restate.dev/ai/patterns/durable-agents.md)).
- **LangGraph.** After `interrupt()`, "the runtime restarts the entire node from the beginning" ([LangGraph](https://docs.langchain.com/oss/python/langgraph/interrupts)).
- **Claude Agent SDK.** A session persists the conversation, not the filesystem, and is "same machine only" unless a `SessionStore` adapter is used ([Claude docs](https://code.claude.com/docs/en/agent-sdk/sessions)).

**Placement**
- **Two-sided matching.** HTCondor ClassAds [older] ([HTCondor](https://htcondor.org/classad/refman.V2.2/refman.pdf)).
- **Hard and soft rules.** Nomad constraint and affinity; Kubernetes required versus preferred affinity, taints and tolerations ([K8s](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)).
- **Ray.** Custom resources are hard constraints. Tasks prefer the node holding the most bytes of their arguments ([Ray](https://docs.ray.io/en/latest/ray-core/scheduling/index.html)).
- **Dask** minimizes queue time plus transfer time ([Dask](https://distributed.dask.org/en/stable/scheduling-policies.html)).
- **Spark** waits `spark.locality.wait` (3 s per level) for a local slot before falling back ([secondary](https://www.waitingforcode.com/apache-spark/spark-data-locality/read)).

**Partitions**
- **Kubernetes.** For StatefulSets, a person confirms the node is off before the `out-of-service` taint lets a replacement start (see section 1).
- **Nomad** offers a choice when the node returns: `keep_original`, `keep_replacement`, `best_score` or `longest_running`.

### Inferences
**1. Map onto the companion.**
- **Server-issued attempt epochs.** Each delegation placed on a machine gets an attempt id and an epoch, and every job carries them. The server drops any result whose epoch is not current, and so stops the stale case it can mediate. Today `complete` checks only the job id.
- **Lease renewal on the poll, plus a self-fence on the companion.** Every poll renews the leases of the machine's running jobs. When the companion has not renewed for TTL minus a margin, it stops starting tool calls and kills the running process trees. The server waits TTL plus a margin before re-placing (control.md rule 7 suggests a companion TTL of 120 s).
- **A `cancel` job kind, and a real abort signal in `ToolContext`.** This is the gap the governor's kill switch most needs closed (control.md rule 2's companion target of 10 s or less).

**2. Delivery semantics per tool.**
- **Reads** (read, glob, grep, a read-only command) are retryable.
- **`write` and `edit`** become idempotent with a content-hash precondition: "replace when the file's hash is H". That is stronger than today's mtime and size.
- **`bash`** is at-most-once by default. A result that was lost is reported to the agent as *indeterminate* ("may have run"), never silently retried, unless the call declares itself idempotent.
- **External effects** (push, PR, publish, send) never run on the machine in swarm work. They go to a server-side outbox, executed only after acceptance, with idempotency keys or `--force-with-lease`, and with the person's approval where control.md rule 11 requires it.

**3. Checkpoint and re-placement.**
- In a git folder each attempt works in its own worktree on a base commit.
- The checkpoint is the transcript position plus a patch against the base, pulled every N steps and at the end.
- Re-placement applies the patch to the same base commit on another allowed machine and continues the transcript.
- Work that depends on data only that machine has is pinned. It waits in *unknown*, then is abandoned with a partial report; it is never re-placed to a machine without the data.
- On reconnect the replacement is kept and the stale worktree is discarded. A replacement is never merged blindly.

**4. Placement is two-sided.**
- The job's requirements: OS, tools, repository at the base commit, GPU, kind of work.
- The machine's policy: what the person allows, capacity, hours, idle or on mains power, à la HTCondor.
- Data locality is hard; preferences are soft. Wait briefly for the best machine, then fall back.
- Placement is decided when a task starts, never mid-turn (Codex).
- One owner per machine (Claude's owner lock): in a shared deployment, a machine serves only its owner's runs.

### Gaps
- No measured data was found on how often personal machines drop mid-task (sleep, Wi-Fi, reboots). The TTL must be tuned on the person's own machines.
- No agent framework documents fencing for a tool process that is still running after its lease lapsed. Nomad's self-stop is the only explicit design.

---

## 4. Result integrity: trusting what a machine reports

### Takeaway
A result from a machine is a claim. Today the harness checks a companion's work only by running commands *on that same machine* and believing the exit codes it reports, so a compromised machine, or a misbehaving agent there, can forge acceptance. The evidence gives a clear ladder of defences:
1. **Separate the work from the judgment.** The machine returns an artefact: a patch on a base commit, plus its logs. The harness applies the patch to a clean checkout in *another trust domain* (the server's sandbox, or a second machine the harness picks) and runs the checks there. This is SLSA L3's isolation and reproducible builds' independent re-execution, applied to agent output.
2. **Never send hidden checks to the worker's machine.** These are ringers (Golle & Mironov): checks the worker cannot tell from real work.
3. **Sign and hash the evidence** for attribution and tamper-evidence, not for truth.
4. **At low stakes, spot-check with a floor rate and backtracking.** BOINC's trust that decays as 1/CV suits hardware faults, not adversaries.

Verifiable computation is about a million times too slow for arbitrary shell commands. Attestation on consumer PCs can prove a key is bound to a TPM, and so resist cheap re-enrolment. It cannot prove that the agent did not rewrite the test.

### Cited Findings

**Volunteer computing**
- **BOINC replication.** Each job runs on two unrelated hosts, with a third when they disagree. `min_quorum`, `max_error_instances` and `max_success_instances` set the rules, and a strict majority of equivalent results picks the canonical one.
- **Homogeneous redundancy.** Later replicas go only to hosts of the same platform class, because numeric results differ across platforms.
- **BOINC's own warning.** When an app usually returns one answer, cheaters return that answer. The fix is output that depends on intermediate results [older: 2019] ([Anderson](https://arxiv.org/abs/1903.01699)).
- **Adaptive replication.** A host is trusted with probability 1 − 1/CV once it has at least 10 consecutive validated results ([BOINC](https://github.com/BOINC/boinc/wiki/Adaptive-Replication)).
- **Kondo et al.** found error rates not stationary and not correlated between hosts, which argues against trusting a reputation for long [older: 2007] ([HAL](https://hal-univ-tlse3.archives-ouvertes.fr/INRIA/inria-00102840)).

**Ringers and spot-checking**
- **Golle & Mironov.** Hidden inputs whose answers the supervisor knows. "Bogus ringers" make the coverage exponentially close to 1 [older: 2001] ([paper](https://crypto.stanford.edu/~mironov/papers/dist.pdf)).
- **Sarmenta.** Voting error is about (c·f)^m, with c between 1.7 and 4. With spot-checking at rate q plus blacklisting and backtracking, the error is about (f/(1−f))/(q·n·e). Without blacklisting, a saboteur who rejoins after l results drives it to about f/(q·l) [older: 2001-02] ([paper](https://groups.csail.mit.edu/cag/bayanihan/papers/ic2001/ic2001.pdf)).
- **Du et al.** The participant commits to all its results with a Merkle root before the supervisor samples, so it cannot choose afterwards which results to fake [older: 2004] ([Syracuse](https://surface.syr.edu/eecs/26)).

**Verifiable computation is impractical here**
- zkVM proving is up to about a million times native cost ([Berkeley EECS-2025-215](https://www2.eecs.berkeley.edu/Pubs/TechRpts/2025/EECS-2025-215.html)).
- Truebit's verification game needs a deterministic VM and estimates a 500–5000% tax [older: 2019] ([arXiv 1908.04756](https://arxiv.org/abs/1908.04756)).
- `npm test` on a laptop touches the network, the clock and nondeterministic runners.

**Attestation proves identity, not correctness**
- **TPM quotes** attest what was measured at load time ([arXiv 1603.01244](https://arxiv.org/abs/1603.01244) [older: 2016]). Keylime finds direct PCR matching useful only "when the boot chain does not change often" ([Keylime](https://keylime.readthedocs.io/en/latest/)).
- **Windows 11 requires TPM 2.0** ([Microsoft](https://learn.microsoft.com/en-us/windows/whats-new/windows-11-requirements)). Azure Attestation checks boot logs against a policy ([Microsoft](https://learn.microsoft.com/en-us/azure/attestation/workflow)).
- **AMD fTPMs** were broken with a glitch rig costing about $200 [older: 2023] ([faulTPM](https://arxiv.org/abs/2304.14717)).
- **Apple App Attest on the Mac.** Unavailable until 2026. Reported for macOS 27 for apps in a user context only, not daemons (secondary forum reports: [Apple forums](https://developer.apple.com/forums/thread/836329)).
- **Intel TDX and AMD SEV-SNP** are server parts ([Red Hat](https://www.redhat.com/en/blog/confidential-computing-platform-specific-details)).
- **Agent attestation research.**
  - Proof-of-Guardrail measured about 34% more latency and about 18.5× the instance cost for an attested wrapper, and says it "should not be interpreted or advertised as proof of safety" ([arXiv 2603.05786](https://arxiv.org/abs/2603.05786)).
  - VET proposes TEE proofs and notarized-TLS proofs for agents ([arXiv 2512.15892](https://arxiv.org/abs/2512.15892)).
  - Signed tool-call receipts show "agent X signed intent to call tool Y", not that the call happened or was correct (vendor claim: [ArkForge](https://arkforge.tech/en/blog/mcp-cryptographic-receipts/)).

**Provenance as the model for "results carry their proofs"**
- **SLSA Build L3** requires that it "MUST NOT be possible for one build to persist or influence the build environment of a subsequent build", and that signing secrets stay out of reach of user-defined steps ([SLSA](https://slsa.dev/spec/v1.0/requirements); [levels](https://slsa.dev/spec/v1.1/levels)).
- **GitHub artifact attestations** give L2, or L3 with reusable workflows, and are "*not* a guarantee that an artifact is secure" ([GitHub](https://docs.github.com/en/actions/concepts/security/artifact-attestations)).
- **Inference: a persistent runner on a PC fails L3's isolation.** GitHub recommends ephemeral runners ([GitHub](https://docs.github.com/en/enterprise-server@3.17/actions/reference/runners/self-hosted-runners)).
- **Reproducible builds:** "any party can recreate bit-by-bit identical copies" ([reproducible-builds.org](https://reproducible-builds.org/docs/definition/)).
- **in-toto** statements, made of a subject plus a predicate ([in-toto](https://github.com/in-toto/attestation/blob/main/spec/README.md)).
- **Certificate Transparency** Merkle logs with inclusion and consistency proofs ([RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.html)).

### Inferences: how "checks run where the work ran" should change

**1. Two places, two purposes.**
- **The worker's machine** runs the *visible* checks as feedback. They are cheap and fast, and they drive fix rounds.
- **A judge domain** decides acceptance: the server's Docker or OS sandbox with a clean checkout plus the patch, or a second allowed machine with the same platform when the check needs it (homogeneous redundancy for Windows-only or macOS-only tests). It re-runs the `run` checks and all `file`, `unchanged`, `absent` and protection checks. It computes the change set itself and runs the verifier on that change set, never on the worker's own account of it.
- This also closes today's hole, where non-`run` checks are "not run" on a companion.
- Re-running checks costs little next to the agent's model calls. Replicating the whole *work* costs at least 2×, which is what critical stakes already buys.

**2. Rules by stakes.**

| Stakes | Visible checks on the worker | Re-run in the judge domain | Hidden checks | Verifier | Replicas |
|---|---|---|---|---|---|
| normal | yes (feedback) | all checks, when the judge domain can run them; otherwise the report says "checked only on the worker's machine" | judge domain only | as asked | no |
| high | yes | **always**; a check that can run only on the worker's platform goes to a second machine of that platform, else the result is UNVERIFIED | judge domain only | other provider, on the judge's change set | no |
| critical | yes | always | judge domain only | other provider | on **two different machines** as well as two providers, so a machine fault is not a common mode |

**3. Hidden checks never leave the judge domain.**
- When a cheat breaks a fraction f of the requirements and r independent hidden checks each probe a random requirement, it escapes with probability (1 − f)^r. At f = 0.2: r = 5 gives 0.33, r = 10 gives 0.11, r = 20 gives 0.012.
- Seeds and property-test inputs chosen at verification time are ringers a worker cannot fit.

**4. If any work is ever accepted without a re-run, use spot-check arithmetic.**
- Each result is re-checked independently with probability p. A machine that forges m results is caught with probability 1 − (1 − p)^m.
  - p = 0.1, m = 5: 41%.
  - p = 0.1, m = 20: 88%.
  - 95% confidence needs m ≥ ln 20 / p, which is 29 at p = 0.1 and 59 at p = 0.05.
- **A single forged result is caught with probability exactly p.** Spot-checking bounds the *rate* of forgery; it never protects one important result. That is why high stakes re-runs everything.
- Auditing k of n without replacement: escape = C(n−m, k)/C(n, k). For n = 100, m = 10, k = 10 that is about 0.33.

**5. Reputation needs a floor and backtracking.**
- BOINC's 1/CV checks a host with CV = 100 only 1% of the time, so a strategic cheater expects about 99 accepted forgeries before the first catch.
- Use a floor (p ≥ 0.1) and, on a catch, re-audit that machine's accepted history (Sarmenta's backtracking).
- Identity matters. With f = 0.2, q = 0.1 and n = 50 under blacklisting, the error is about 1.8%. If a caught machine can rejoin after l = 10 results, it is about 20%. So enrolment needs the person and a key the machine cannot cheaply re-mint, which is where a TPM-bound key helps.

**6. Signed evidence gives attribution, not truth.**
- The companion signs (run, attempt, epoch, job, input hash, output hash) with its machine key. The server appends these records to a hash-chained run log with signed heads, and keeps a copy on the machine.
- This gives non-repudiation ("this machine claimed this") and tamper-evidence. It is the run recorder of SWARM.md phase 6, started for machines.
- The signing key must be unreadable by the agent's tool calls: kept outside the sandbox, or in the TPM or Keychain.

**7. Capability claims are claims.** What a machine reports about itself (OS, sandbox, network) decides placement and the machine's own containment. It never decides acceptance.

### Gaps
- No 2025-26 measurement was found of spot-check efficacy against LLM agents that game checks. The arithmetic above assumes the worker cannot tell hidden checks from real ones, which is exactly what keeping them off the machine buys.
- Apple App Attest support for background processes on macOS 27 is unverified.
- No source states outright that self-hosted runners cannot meet SLSA L3; that is inferred from the requirements.

---

## 5. Recommendations, ranked

I ranked these by harm prevented and phase 7 enabled, divided by cost to build. Each maps onto three parts of the harness:
- **Companion**: `src/runtime/companion.ts`, `src/companion/*`, `src/server/app.ts`.
- **Governor**: phase 1c, with control.md's rule numbers.
- **Acceptance**: `done_when`, the verifier and stakes in `src/agents/acceptance.ts`.

Tests follow the proof standard: deterministic scenarios assert on harness events and the companion's process table, never on an agent's report; live runs use real machines.

**1. Stop means stop on every machine: leases, epochs, cancellation and self-fencing.**
- **What to build:**
  - Every swarm job carries (run, attempt, epoch, lease TTL).
  - The poll renews the leases of the machine's running jobs.
  - A `cancel` job kind, and a real abort signal in the companion's `ToolContext`, so the bash tool kills its whole process tree (process group or cgroup on Linux and macOS, a Job Object with kill-on-close on Windows).
  - The companion fences itself: without a renewal for TTL minus a margin, it stops starting calls and kills what is running.
  - Results with a stale epoch are refused.
  - Detached background commands are refused in swarm work, or tied to the lease.
  - A local stop works without the server (Ctrl+C or `harness-companion stop`).
- **Maps onto:**
  - Companion: `dispatch`, `complete`, `poll`; the handler's `ToolContext`.
  - Governor: rules 2 and 7 (companion TTL 120 s; kill within 10 s or the TTL); scenarios 14-16 in control.md.
  - Acceptance: a cancelled attempt is never accepted.
- **Deterministic tests:**
  - A kill during a running `sleep` on a companion: the process is gone in 10 s or less.
  - A kill while the companion is offline: it stops by the TTL with no word from the server.
  - A result posted with an old epoch after re-placement is refused.
  - A server restart: no lease renews, and the companion stops by the TTL.
  - A wall-clock jump on the companion: the lease still expires, on monotonic time.
  - A `run_in_background` call in swarm work is refused.
  - Two cancels are idempotent.
- **Live tests:**
  - This Windows machine plus a Linux companion (a container or WSL). Kill a swarm with shells running on both and measure the time until no process remains.
  - Pull the network cable or block it with a firewall rule mid-command.

**2. Consent the machine enforces: a local policy the server can only narrow.**
- **What to build:**
  - A policy file on the machine, outside `--dir` and unwritable by the sandbox, set only through the companion's own command line or interface. It states:
    - whether swarm work is allowed at all (default no);
    - the kinds allowed (read, write, network);
    - folders;
    - sandbox required for swarm work;
    - network allowlist;
    - capacity (concurrent jobs);
    - hours, idle only, and mains power only.
  - The companion refuses any job outside it, whatever the server says, and reports that the refusal was by policy.
  - The server shows each machine's policy as "what this machine allows". Server-side settings can only narrow it.
  - Revocation is both local (edit the policy; it takes effect at the next job) and remote (remove the machine).
- **Maps onto:**
  - Companion: extends today's start flags (`--allow-hooks`, `--trust-project`, `--allow-desktop`) into a policy; adds the capacity cap the companion lacks.
  - Governor: rules 8 and 19 (the charter's `machines` and `kinds` are checked against each machine's policy at grant time, and checked again on the machine).
  - Acceptance: none.
- **Deterministic tests:**
  - The server sends a write job to a machine that allows only reading: refused on the machine.
  - The server claims the machine allows more than it does: the machine still refuses.
  - Policy edited mid-run: the next job is refused and the governor hears why.
  - The capacity cap holds under 20 jobs sent at once.
  - Swarm work on a machine whose sandbox is `off`: refused.
  - Outside the allowed hours: queued, not run.
- **Live tests:** revoke consent on one machine during a two-machine run. Work there stops within the TTL, and the run reports which shards were lost.

**3. Accept work off the machine that did it.**
- **What to build:**
  - In a git folder, each attempt works in a worktree on a recorded base commit and returns the patch plus logs.
  - The judge domain applies the patch to a clean checkout and runs every check there, including the hidden ones. That domain is the server sandbox, or a second allowed machine of the platform a check needs.
  - The judge computes the change set, and the verifier sees that change set.
  - The worker's machine runs only the visible checks, as feedback.
  - Outside git, the server mirror is the fallback, with its contents hashed: it is the companion's own report, so it counts as normal stakes only.
  - The stakes rules in section 4's table: at high stakes, a check that ran only on the worker's machine leaves the work UNVERIFIED. At critical stakes, replicas go to two different machines as well as two providers.
- **Maps onto:**
  - Acceptance: `runChecks` and `changeSet`, which today say "not run" and "not available" for companions; `finalVerdict`; the replica placement.
  - Companion: a `patch` job (`git diff` against the base, run by the harness's safe-git settings on the machine).
  - Governor: none.
- **Deterministic tests:**
  - A fake companion reports exit 0 for a failing test: rejected by the judge's re-run.
  - A forged mirror: the patch-based change set differs, and the work is rejected.
  - A hidden check's command never appears in any job sent to the worker.
  - At high stakes, a Windows-only check with no second Windows machine: UNVERIFIED.
  - Critical replicas never share a machine.
  - A worker that edits tests on its machine: protection fails in the judge domain.
  - A patch touching `.git/config` or hooks: refused, using today's safe-git rules.
- **Live tests:** DeepSeek and Haiku workers on a companion, with the mutants from phase 1b planted through a doctored companion. The planted cheats must all fail. Compare acceptance precision with checks on the machine against checks in the judge domain.

**4. A containment floor for swarm work on personal machines.**
- **What to build:**
  - Swarm work needs a sandbox, and fails closed when none is available. On Windows the order is MXC, then a separate sandbox account (srt or Codex "elevated" style), then Docker without the socket; otherwise refuse.
  - An egress allowlist on companions, porting the server's `startLocalEgress` proxy. Network defaults to `none` for swarm work.
  - Hide `~/.harness-companion` from sandboxed commands now (add it to the hidden folders).
  - Deny writes to agent and project control paths in the folder: `.harness/` settings, agents, skills and workflows; `.mcp.json`; `.claude/`; `.vscode/`; CI configuration; the git hooks and config already protected. Also deny writes to autostart locations.
  - No desktop control and no `--trust-project` MCP servers in swarm work.
  - Refuse a folder that is synced (OneDrive, Dropbox, iCloud), or that contains the companion script itself.
- **Maps onto:**
  - Companion: `sandboxedFolderHost`, `os-sandbox.ts` (SECRET_DIRS and the hidden folders), the handler's desktop and MCP branches.
  - Governor: rules 3 and 8.
  - Acceptance: the judge domain from recommendation 3 makes a contained worker's lies harmless.
- **Deterministic tests:**
  - A sandboxed command reads the token file: empty.
  - It reaches a host not on the list: blocked, and the proxy records the attempt.
  - It writes to `.vscode/tasks.json`, `.mcp.json` or a LaunchAgent: denied.
  - The allowlist has no entries: no network at all (CVE-2025-66479's fail-open, reproduced and shown closed).
  - A synced folder: refused at start.
  - A desktop request in swarm work: refused.
- **Live tests:** each OS's sandbox on a real machine (Windows with MXC or a fallback, Linux bwrap on Ubuntu 24.04 with AppArmor's userns restriction, and macOS Seatbelt when a Mac is available). Run the same escape list on each and record which tier was in force.

**5. Machine identity: a key that never leaves the machine, short-lived job credentials, signed releases.**
- **What to build:**
  - At enrolment the companion generates a key pair, non-exportable in the TPM, Secure Enclave or Keychain where possible, otherwise in a file the sandbox cannot read. The server stores the public key.
  - Polls and results are signed (DPoP-style proof of possession). The bearer token becomes a short-lived access token bound to that key.
  - Each job carries a token that dies with the job.
  - Enrolment shows the machine's name, OS and key fingerprint on a trusted device. It is never a bare device code.
  - Companion releases are signed with an offline key whose public half is pinned in the companion. It updates only to signed versions, and the hash is published outside the server.
- **Maps onto:**
  - Companion: `CompanionHub.create`, `authenticateToken` and `renew`; `main.ts` (`adopt`, the token file); `/companion.mjs`.
  - Governor: rule 2 (per-run credentials revoked with the lease).
  - Acceptance: results signed for the run log.
- **Deterministic tests:**
  - A copied token without the key: refused.
  - A replayed poll or result (same nonce): refused.
  - A tampered companion script: fails its signature and does not start.
  - A key revoked on the server: refused at the next request.
  - Rotation continues to work across lost replies, as tested today.
- **Live tests:** enrol two machines. Copy one machine's state to a third and confirm the copy cannot act as the original when the key is hardware-bound.

**6. Consent signed by the person, not the server: the defence against a compromised server.**
- **What to build:**
  - Swarm work on a machine needs a grant signed by a key the person holds on a trusted device (a passkey or WebAuthn credential, or an enrolled phone or desktop). The grant names the run, the machines, the kinds of work, the folder, an expiry and the charter's hash.
  - The companion verifies the grant against a public key pinned at enrolment, which the server cannot replace.
  - Jobs outside a valid grant are refused.
  - Ten one-time recovery codes for when that device is lost, as in Tailnet Lock.
- **Maps onto:**
  - Governor: rule 10. A proposal for "another machine" becomes a signed grant.
  - Companion: policy checks (recommendation 2).
  - Server: approval cards.
- **Deterministic tests:**
  - A job with no grant, an expired grant, a grant for another run, or a grant signed by the server's own key: all refused.
  - A grant replayed on another machine: refused.
  - A charter changed after signing (hash mismatch): refused.
- **Live tests:** sign a grant on a phone or a second browser, then simulate a server that forges a grant. The machines refuse it.

**7. Durable steps and side effects done once.**
- **What to build:**
  - Journal each tool call by (run, attempt, step) with its result on the server. On resume, recorded results are replayed, not re-run.
  - `write` and `edit` carry a content-hash precondition.
  - A `bash` call whose result was lost is reported as "may have run", unless it is declared idempotent.
  - Every external effect goes through a server-side outbox after acceptance, with idempotency keys and `--force-with-lease`.
  - Pending jobs and results survive a server restart, using the shared-file and lease machinery that already exists for clusters.
- **Maps onto:**
  - Companion: the job queue and `complete`; the file tools' `FileStamp`.
  - Governor: rule 11 (external actions need the person).
  - Acceptance: the outbox runs only after acceptance.
- **Deterministic tests:**
  - The result of an `edit` is lost and the edit retried: applied once.
  - The server restarts mid-job: the result is matched to its job when the server comes back, or reported as indeterminate. It is never silently dropped (today it is a 404).
  - A lost `bash` result: the agent sees "may have run".
  - A push requested by an agent on a machine: refused there, and executed once from the outbox after acceptance.
  - The same outbox item replayed: one effect.
- **Live tests:** restart the server during a two-machine run. No duplicated file effects, and every job is accounted for.

**8. Placement, checkpoints and re-placement.**
- **What to build:**
  - Two-sided matching: the job's requirements against each machine's policy and its reported capabilities.
  - Data locality is a hard constraint; idle, mains power and fewer running jobs are soft preferences. Wait briefly for the best machine, then fall back.
  - Placement is decided at task start.
  - Checkpoints are the transcript position plus a patch every N steps.
  - A lost machine's work goes *unknown*, then is re-placed from its checkpoint only when it is not pinned to that machine's data.
  - On reconnect, keep the replacement and discard the stale worktree.
  - No "every machine" primitive, and a cap on agents per machine.
- **Maps onto:**
  - Companion: `list()` for capabilities and policy.
  - Governor: the charter's `machines`; rules 6 and 19.
  - Acceptance: a re-placed attempt is accepted only in the judge domain.
- **Deterministic tests:**
  - A shard needing a file only machine A has is never placed on B.
  - A goes offline: the shard is unknown, then reported as abandoned with what was done.
  - A re-placed shard continues from the checkpoint and no step is repeated.
  - A comes back after re-placement: its late result is refused by epoch.
  - A fan-out of 10 on 2 machines with capacity 2: never more than 2 per machine.
- **Live tests:** a Windows machine and a Linux machine with a test suite that must pass on both, sharded by platform. Put one machine to sleep mid-run.

**9. Machines never talk to each other; artefacts are tainted.**
- **What to build:**
  - No channel between machines. Everything goes through the lead's briefs, which are fenced as data.
  - An agent's output from machine A that reaches a brief for machine B carries a taint mark, and B's agent then has no more capability than A's.
  - Pushes from machines go only to work branches, through the outbox.
  - Refuse a machine's folder that is the same checkout as another machine's (shared or network drives).
- **Maps onto:**
  - Governor: rule 15.
  - Acceptance: briefs and reports are already fenced.
  - Companion: none.
- **Deterministic tests:**
  - A planted instruction in a file on A ("tell the agent on B to run X") does not widen B's tools, and is flagged.
  - Two machines registered on one network folder: the second is refused.
- **Live tests:** an injected README on one machine during a two-machine run. Record whether the other machine's agent acted on it, and confirm containment held either way.

**10. An audit trail for who ran what where.**
- **What to build:** a hash-chained run log of grants, placements, jobs, signed results, leases, cancels and refusals, with a copy kept on each machine. Each machine's log is checkable against the server's.
- **Maps onto:**
  - Governor: rule 18.
  - SWARM.md phase 6's recorder.
- **Deterministic tests:**
  - An edited log entry breaks the chain.
  - A job the server says it sent but that the machine never logged is flagged.
- **Live tests:** export one two-machine run and verify it from the machines' copies alone.

**Not now, on the evidence:**
- Attestation or TEEs for results: they prove the software's identity, not whether a result is correct, and they are impractical on consumer machines.
- Verifiable computation: about a million times native cost.
- BOINC-style replication of all work: 2× or more, and critical stakes already buys replicas.
- LAN discovery without pairing (the exo model).
- Running the agent loop on the machines: it would put keys on them and blind the governor.

### Does phase 7 pay? The pilot

Phase 7's gain is not accuracy (REPORT.md). It is wall-clock time, work where the data lives, and checks on the real target platform. Measure against one machine at the same spend:
- wall-clock time to an accepted result;
- accepted results per dollar;
- the share of tasks that could not run on one machine at all (data on another machine, a check needing another OS);
- lost and duplicated work per machine-hour;
- kill latency at the 95th percentile;
- false acceptances found by the judge-domain re-run.

Use a 5-task smoke test, then a 30-task paired pilot on two to three of the person's own machines. Write the stop rule down first. If two machines do not beat one by about 30% in wall-clock time at equal spend on sharded work, or do not unlock tasks one machine cannot do, phase 7 stays a placement option (one named machine per delegation) rather than a swarm.

## Gaps, overall
- No measured failure rates (drops, sleeps, duplicates) for personal machines in agent work. The TTLs here are borrowed from CI and Kubernetes and must be tuned live.
- No primary documentation of how Windows MXC isolates, or of its general availability. The Windows containment order above may change.
- No measured in-the-wild propagation of prompt injection between a person's own machines.
- No published evaluation of hidden-check or spot-check efficacy against LLM agents running on machines they could inspect.
- Some 2026 incident details rest on one vendor (ShadowRay 2.0, Gheist) or on secondary summaries (TeamPCP, OpenClaw, the Claude Code CVEs).
