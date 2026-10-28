# AIOps and AI-SRE market research, and a gap analysis of our AIOps pack

Date: 2026-10-22. Scope: the leading AIOps platforms and "AI SRE agent" products as of late 2026, a capability map, and a gap analysis against `plugins/aiops` and `plugins/devops` in this repository.

How to read the citations: each link names the source and, where known, its publication date, followed by the date it was accessed. Most facts come from vendors' own docs, release notes and press releases. Vendor performance numbers (MTTR cuts, accuracy) are **vendor claims** unless stated otherwise. A fact marked **(unverified)** could not be confirmed from a primary source in this pass. A fact marked **(not re-checked)** is background knowledge that was not looked up again for this document.

---

## 1. Summary

- **The market has shifted from "AIOps" to "AI SRE agents".** Up to about 2024 the category was event correlation, noise reduction and anomaly detection (BigPanda, Moogsoft, PagerDuty AIOps, ServiceNow Event Management, Splunk ITSI). In 2025-2026 every major vendor shipped an LLM investigation agent that starts when an alert fires, forms hypotheses, queries telemetry, correlates recent changes, and writes a root-cause summary with evidence. Gartner published its first *Market Guide for AI SRE Tooling* on 2026-01-26. It forecasts 85% of enterprises using AI SRE tooling by 2029, up from under 5% in 2025 ([Cast AI summary of the Gartner guide](https://cast.ai/gartner-market-guide-for-ai-sre-tooling/), acc. 2026-10-22).
- **Most of these agents became GA in the first half of 2026:**
  - Datadog Bits AI SRE: GA reported with Q4 2025 results, 2026-02-10.
  - New Relic SRE Agent: launched 2026-02-24, since renamed Autopilot.
  - Azure SRE Agent: GA 2026-03-11.
  - AWS DevOps Agent: GA 2026-03-31.
  - Splunk AI SRE: GA June 2026.
  - Grafana Assistant Investigations: GA 2026-07-27.
  - IBM Instana Intelligent Incident Investigation: GA.
  - PagerDuty SRE Agent: features GA through 2026.

  Google is the outlier. Gemini Cloud Assist investigations is still preview, and since 2026-04-10 only Premium Support customers can run it. AWS is retiring DevOps Guru: no new customers from 2026-10-29, end of support on 2027-09-30, with customers pointed at CloudWatch and the DevOps Agent.
- **Consolidation is under way:**
  - Palo Alto Networks closed its $3.35B purchase of Chronosphere on 2026-01-29.
  - Elastic agreed to buy DeductiveAI for up to $85M (June 2026, per sources).
  - BigPanda bought Velocity (November 2025).
  - Dell absorbed Moogsoft as APEX AIOps (2023-2024).
  - NVIDIA bought Shoreline (2024).

  AI-SRE startups have raised large rounds. Resolve AI raised $125M at a $1B valuation in February 2026. Traversal is backed by Kleiner Perkins and Sequoia, and Amex Ventures invested in March 2026.
- **What best-in-class products have in common:**
  - An alert-triggered investigation agent.
  - A topology or dependency model, whether causal or learned.
  - Change correlation: deploys, commits and config changes.
  - Evidence-linked root cause analysis with a confidence level.
  - Integrations with incident platforms (PagerDuty, ServiceNow, Slack, Teams).
  - Memory of past incidents.
  - Graduated autonomy: read-only first, then recommendations, then approved actions, and finally autonomous handling of trusted runbooks.
  - MCP or agent-to-agent interfaces.

  The differentiators are a deterministic causal model or topology under the LLM (Dynatrace, Causely, Traversal), owning the telemetry (Datadog, Dynatrace, Grafana, Splunk), code-level fix PRs, and verified accuracy.
- **Trust is the binding constraint:**
  - A sponsored survey of 696 practitioners (The Register with NeuBird, April 2026) found 73% not using AIOps at all and 8% in production. 60% cited lack of trust as the top barrier.
  - An academic study of 1,675 agent runs on OpenRCA (February 2026) found hallucinated data interpretation and incomplete exploration were the most common failures for every model tier, and traced them to the agent architecture, not to model capability.
  - ClickHouse's own test (2025) concluded "Autonomous RCA is not there yet".

  This favours designs like ours: gated approvals, evidence, audit, and evals with hidden checks.
- **Our pack, in one line:** strong on governed action and safety (approvals proven by a gate, a vault, an audit log, hidden-check evals, self-hosted, model-agnostic, cheap models). Weak on the things that let an AI SRE sit inside an existing monitoring estate: alert ingestion, correlation and dedup, change intelligence, Kubernetes and trace signals, chat, paging and ticketing integrations, topology and anomaly detection.

**Top gaps, in priority order** (details in section 10):
1. Alert and webhook ingestion into incidents.
2. Deterministic dedup, grouping and correlation, plus a watch loop that runs no model calls when nothing changed.
3. A change-intelligence timeline.
4. Kubernetes signals inside aiops.
5. Two-way Slack and Teams, with approvals.
6. Paging and ticketing connectors.
7. Grafana integration.
8. OpenTelemetry traces and discovered topology.
9. Anomaly detection beyond thresholds.
10. Evidence-cited RCA with an adversarial check and incident-similarity memory.

---

## 2. Product by product

### 2.1 Compact table

| Product | Status (late 2026) | Core approach | Autonomy / safety model | Deployment | Pricing (public) |
|---|---|---|---|---|---|
| **Datadog** Watchdog, Event Management, Bits AI SRE | Bits AI SRE GA (Q4 FY25 report, 2026-02-10); MCP Server GA 2026-03-09 | Own telemetry. Watchdog ML anomaly detection, ML and pattern event correlation, plus an LLM investigation agent | Investigates and suggests actions and code fixes. No autonomous change documented | SaaS only; Bits not on US gov sites | AI Credits: $500 per 500 credits, $1.30 on demand (pricing tracker, June 2026). Earlier: $500 per 20 investigations |
| **Dynatrace** Davis, Grail, Smartscape, Dynatrace Intelligence | Dynatrace Intelligence launched 2026-01-29; agents "available now" | Deterministic causal AI (Davis) on a topology (Smartscape) and data lake (Grail), plus coordinated agents | Three-phase path: insights, then supervised, then autonomous with guardrails; policy controls and approvals | SaaS (Managed self-hosted exists; whether agents run there is unverified) | DPS consumption rate card; AI line items unclear (unverified) |
| **New Relic** SRE Agent, now Autopilot | SRE Agent 2026-02-24; Autopilot 2026-06-23; GA status unclear | LLM agent over NR telemetry, entity map, deploy events | Recommends only and does not act; 100 requests/hour/org | SaaS; not FedRAMP | Advanced Compute add-on |
| **Splunk / Cisco** Observability Cloud AI SRE, ITSI, AppDynamics | AI SRE GA June 2026; Claude-based remediation Alpha (2026-09-17) | AI detection, alert grouping, RCA with evidence chain; ITSI episodes and adaptive thresholds | Guided remediation plans with a validation step (Kubernetes alerts only); code fixes as PRs | SaaS (Observability Cloud); Splunk Enterprise/ITSI on-prem | Not public |
| **Elastic** AI Assistant, Agent Builder, Streams, ML | Agent Builder GA; Streams GA in 9.2; DeductiveAI deal agreed June 2026 | Search plus ML anomaly jobs, LLM assistant and agents, "significant events" in logs | Assistant and agents; Workflows (automation) tech preview | SaaS, serverless **and self-managed**; LM Studio documented for air-gapped use | Subscription tiers; managed LLM extra |
| **Grafana Labs** Assistant (Investigations, Automations, Watchers), Sift, Adaptive Telemetry, IRM | Assistant GA Oct 2025; Investigations, Automations, MCP server GA July 2026; Watchers public preview | Multi-agent LLM over Prometheus/Loki/Tempo/Pyroscope; Sift = ML detectors for K8s | Investigations report hypotheses; Watchers notify or start investigations; runs under the creator's identity | Grafana Cloud; Assistant for OSS/Enterprise since April 2026, but its **backend stays in Grafana Cloud** | Free tier; IRM per monthly active user |
| **PagerDuty** AIOps, SRE Agent, Advance | AIOps mature; SRE Agent features GA Jan-Jul 2026; "virtual responder" early access Q2 2026 | Event orchestration, alert grouping, probable origin; LLM agent pulls logs and runbooks | Recommends workflows; triggered by incident workflows; fully autonomous responder planned H2 2026 (unverified) | SaaS | AIOps by event consumption; Advance add-on |
| **ServiceNow** ITOM AIOps, Now Assist for ITOM | Agentic workflows in the Australia release (March 2026) | CMDB, Service Mapping, Event Management; agentic alert triage | "Manage alerts autonomously" with explanations of automated decisions; licensing-gated | SaaS (ServiceNow instance) | ITOM Prime / Pro Plus bundles, not public |
| **BigPanda** | Agentic ITOps (May 2025); bought Velocity (Nov 2025) | Event correlation plus IT Knowledge Graph (includes chat and bridge transcripts) | AI Detection and Response for L1; AI Incident Assistant | SaaS | Not public |
| **Moogsoft / Dell** APEX AIOps | Renamed APEX AIOps Incident Management (2024); no 2026 news found | Event correlation, "Probable Root Cause" (2025, per a third party) | Situation Room workflows | SaaS | Not public |
| **IBM** Instana, Cloud Pak for AIOps, watsonx | Instana Intelligent Incident Investigation GA | APM plus agentic, causal and LLM investigation; Cloud Pak does dedup, then alerts, then incidents | Generates remediation runbooks as Bash or Ansible for review, exported to Git | Instana SaaS and self-hosted; **Cloud Pak self-hosted**; summaries on the customer's own watsonx | Not public |
| **Microsoft** Azure SRE Agent | GA 2026-03-11 | LLM agent (OpenAI and Claude models), skills, sub-agents, Python tools, MCP, hooks | **Review** (default; an admin approves writes) or **Autonomous** per response plan; tool allow/ask/deny; managed identity and RBAC; VNet | Azure-hosted | 4 AAU per agent-hour always on, plus token-based AAUs; example rate $0.10/AAU; 30-day always-on waiver |
| **AWS** DevOps Agent, CloudWatch investigations, DevOps Guru | DevOps Agent GA 2026-03-31; CloudWatch investigations GA 2025-06-24; **DevOps Guru retiring** | Learned topology; correlates telemetry, code and deploys; mitigation plans | Mitigation plans plus "agent-ready" instructions for other agents; execution not documented | AWS-hosted; investigates AWS, Azure and on-prem | $0.0083 per agent-second (about $29.88 per agent-hour); 2-month trial |
| **Google Cloud** Gemini Cloud Assist investigations | Preview; Premium Support only since 2026-04-10; proactive agents private preview 2026-04-22 | Observations from logs, config and metrics, then ranked hypotheses | Read-only; can hand off to a support case | Google-hosted | Tied to Premium Support |
| **Resolve AI** | $125M Series A at $1B (Feb 2026) | Multi-agent AI SRE across the existing toolchain | Marketed as autonomous resolution with escalation; approval flow not documented | SaaS (unverified) | Not public |
| **Traversal** | Series A; Amex Ventures (Mar 2026) | "Production World Model" (causal map) plus parallel hypotheses | Read-only by default; "self-healing remediation" marketed | **BYOC and bring-your-own-model** | Not public |
| **Cleric** | Seed, $9.8M total | Self-learning agent; watches each change for 14 days | Read-only by default; fix PRs need approval; actions logged | SaaS | Not public |
| **Causely** | Active (2026 site) | Explicit causal model of services and failure paths; eBPF | "Act before humans are paged"; controls not documented | Hybrid SaaS or **BYOC** | Not public |
| **Komodor** Klaudia | Multi-agent framework 2026-03-18; Klaudia Memory 2026-07-21 | 50+ specialist agents (K8s, AWS, GPUs); MCP/OpenAPI extensions | Remediation described; approval levels not documented | SaaS plus in-cluster agent (not re-checked) | Not public |
| **HolmesGPT** (Robusta; open source) | CNCF Sandbox; about 3.7k stars; 0.35.0 dated 2026-07-01 (secondary source) | Agentic loop over about 40 toolsets; operator mode runs it 24/7 | Read-only by design; K8s remediation and GitHub PR toolsets are opt-in | Self-hosted; any LLM | Free (Apache-2.0); Robusta SaaS paid |
| **K8sGPT** (open source) | CNCF Sandbox since 2023-12-19; v0.4.41 | Rule-based analyzers, with an LLM to explain findings | Explains and recommends; operator for continuous scans | Self-hosted; local LLMs (Ollama, LocalAI); MCP server | Free (Apache-2.0) |
| **Rootly** AI SRE | Active | Investigations on Rootly On-Call and incident response | "Never auto-remediates without human sign-off"; bring your own AI key | SaaS | Not public on the AI page |
| **incident.io** AI SRE (Investigations, Nexus) | Active; 1,000+ customers (self-reported) | Hypotheses with evidence, plus an **adversarial agent that challenges conclusions** | Acts only through PRs a person merges | SaaS | Not public on the AI page |
| **Shoreline** | Bought by NVIDIA (agreed June 2024, about $100M per Bloomberg) | Runbook automation, "Op packs" (not re-checked) | n/a | Standalone availability today unverified | n/a |
| **Parity** | YC S24; 2026 status unverified | K8s AI SRE; triage and runbooks | Read-only VPC connections | SaaS | Not public |
| **Ciroos** | $21M (2025) | Multi-agent "SRE Teammate"; MCP and A2A | Not documented | SaaS | Not public |
| **Other 2026 entrants** | NeuBird Hawkeye/Falcon ($19.3M, Apr 2026, read-only); Metoro (K8s, eBPF); Better Stack AI SRE; Cast AI (Gartner representative vendor); DeductiveAI (going to Elastic) | | | | Metoro about $20/node/month; Better Stack about $29/responder/month (per a competitor's comparison) |

### 2.2 Notes per product

**Datadog.**
- Event Management ingests and normalises events from monitors, Watchdog, Error Tracking and integrations. It groups them with pattern-based correlation, or with ML-based "intelligent correlation" that needs no configuration ([Datadog docs: Events, Correlation](https://docs.datadoghq.com/events/correlation/), acc. 2026-10-22). Graph Insights and Watchdog Explains point at metrics that misbehaved at the same time ([Datadog docs: Graph insights](https://docs.datadoghq.com/dashboards/graph_insights.md), acc. 2026-10-22).
- Bits AI SRE "autonomously investigates" monitor alerts, "iteratively forms hypotheses", and learns from each investigation. It also offers suggested code fixes ([Datadog docs: Bits AI SRE](https://docs.datadoghq.com/bits_ai/bits_ai_sre/); [product page](https://www.datadoghq.com/product/ai/bits-ai-sre/), both acc. 2026-10-22).
- The GA of Bits AI SRE is reported in the [Q4 and FY2025 results, 2026-02-10](https://investors.datadoghq.com/news-releases/news-release-details/datadog-announces-fourth-quarter-and-fiscal-year-2025-financial) (acc. 2026-10-22). The [MCP Server reached GA on 2026-03-09](https://www.nasdaq.com/press-release/datadog-launches-mcp-server-provide-ai-agents-secure-real-time-access-unified) (acc. 2026-10-22). Q1-Q2 2026 added a Bits AI Security Agent, Bits Code/Chat and Agent Builder ([Q2 2026 results](https://investors.datadoghq.com/news-releases/news-release-details/datadog-announces-second-quarter-2026-financial-results), acc. 2026-10-22).
- Pricing moved from per-investigation ($500 per 20 "conclusive" investigations) to AI Credits in June 2026 ([Better Stack comparison](https://betterstack.com/community/comparisons/bits-ai-sre-alternatives/); [Datadog pricing](https://datadoghq.com/pricing), acc. 2026-10-22). An average of 6.5 credits per investigation is quoted by a weak source **(unverified)**.
- Datadog On-Call, Workflow Automation and Case Management round out the incident loop **(not re-checked)**.

**Dynatrace.**
- Dynatrace Intelligence was announced at Perform on 2026-01-29 as an "agentic operations system". It combines deterministic causal AI with agents: foundational (causal reasoning, prediction, oversight), domain (SRE/DevOps, business, security) and assist. It is built on Grail and Smartscape, with bidirectional integrations to ServiceNow, AWS, Azure, GCP, Atlassian, GitHub and Red Hat. Autonomy follows three phases: insights, then supervised automation, then autonomous with guardrails ([IT Brief, 2026-01-29](https://itbrief.co.uk/story/dynatrace-unveils-agentic-ai-system-for-autonomous-ops), acc. 2026-10-22).
- Dynatrace's benchmark claim is "up to 12x more often solved, 3x faster, half the cost" for an external SRE agent combined with its deterministic agents. This is a vendor claim.
- Futurum calls the launch an early attempt to anchor agents in topology and causal context ([Futurum](https://futurumgroup.com/?p=85633), acc. 2026-10-22).
- Pricing is the DPS consumption rate card, for example about $0.04 per host-hour for infrastructure monitoring ([Last9 guide](https://last9.io/blog/dynatrace-pricing/), third party, acc. 2026-10-22).
- ServiceNow's ITOM agents call a **Dynatrace MCP server** (see ServiceNow below), which shows Dynatrace is also positioned as a data source for other vendors' agents.

**New Relic.**
- New Relic launched an agentic platform with a no-code builder and an SRE Agent on 2026-02-24 ([press release](https://newrelic.com/press-release/20260224), acc. 2026-10-22). On 2026-06-23 it announced Autopilot, a managed SRE agent operated by New Relic, and Ground Truth, which gives customers' own agents API access to NR data ([press release](https://newrelic.com/press-release/20260623-2), acc. 2026-10-22).
- The docs now title the agent "Autopilot (formerly SRE Agent)". It uses metrics, traces, logs, errors, entity relationships and deployment events. It **recommends actions but does not take them** and writes to no external system. It is reachable from Slack, limited to 100 requests/hour/org, and not available for FedRAMP ([NR docs](https://docs.newrelic.com/docs/agentic-ai/sre-agent/overview/), acc. 2026-10-22).

**Splunk / Cisco.**
- The Q1 2026 update added a Troubleshooting Agent and the Splunk MCP Server ([Splunk blog](https://www.splunk.com/en_us/blog/observability/splunk-observability-ai-agent-monitoring-innovations.html), acc. 2026-10-22).
- AI SRE in Observability Cloud went GA in June 2026 ([Cisco Live post](https://www.splunk.com/en_us/blog/observability/splunk-observability-at-cisco-live.html), acc. 2026-10-22). It covers AI detection without hand-written detectors, alert grouping that explains why alerts were grouped, RCA with a confidence level and evidence chain, and staged remediation plans with a validation step.
- Remediation through a Claude Managed Agent in a network-isolated sandbox, which opens a PR, is **Alpha** ([Splunk blog, 2026-09-17](https://www.splunk.com/en_us/blog/observability/ai-sre-in-splunk-observability-cloud-can-remediate-incidents-with-claude-managed-agents.html), acc. 2026-10-22). Remediation plans cover only Kubernetes-related alerts so far ([Splunk docs](https://help.splunk.com/en/splunk-observability-cloud/create-alerts-detectors-and-service-level-objectives/create-alerts-and-detectors/ai-troubleshooting-agent-and-remediation-plan), acc. 2026-10-22).
- ITSI remains the event-analytics and KPI engine: episodes, adaptive thresholds, and entity-cohesion and trending anomaly detection ([Splunk ITSI](https://www.splunk.com/en_us/products/it-service-intelligence.html), acc. 2026-10-22).
- Splunk bought Galileo for agent observability (.conf26). AppDynamics' current AI features were not re-checked.

**Elastic.**
- Streams went GA in 9.2 (October 2025). It partitions and parses logs with AI and flags "significant events" such as OOMs and startup/shutdown errors ([Elastic Observability Labs](https://www.elastic.co/observability-labs/blog/elastic-observability-streams-ai-logs-investigations); [press release 2025-10-27](https://www.businesswire.com/news/home/20251027769990/en/Elastic-Redefines-Observability-with-AI-Powered-Streams), acc. 2026-10-22).
- Agent Builder is GA with a built-in observability RCA agent. Elastic Workflows is in tech preview ([Elastic blog](https://www.elastic.co/observability-labs/blog/beyond-the-dashboard-the-move-toward-agentic-troubleshooting), acc. 2026-10-22).
- The AI Assistant runs on Elastic Managed LLMs (extra cost) or on OpenAI, Azure or Bedrock connectors. LM Studio is the documented route for **air-gapped** use. The docs also warn that data sent to the assistant "is not anonymized" and is processed by the third-party provider ([Elastic docs](https://www.elastic.co/docs/solutions/observability/ai/observability-ai-assistant); [self-managed LLMs](https://www.elastic.co/docs/explore-analyze/ai-features/llm-guides/local-llms-overview), acc. 2026-10-22).
- Elastic agreed to buy DeductiveAI for up to $85M, according to an anonymous source ([TechCrunch, 2026-06-18](https://techcrunch.com/2026/06/18/source-elastic-agrees-to-buy-crv-backed-deductiveai-for-up-to-85m/), acc. 2026-10-22). Completion of the deal is unverified.

**Grafana Labs.**
- Assistant went GA and Investigations entered preview on 2025-10-08 ([press release](https://grafana.com/about/press/2025/10/08/grafana-labs-revolutionizes-ai-powered-observability-with-ga-of-grafana-assistant-and-introduces-assistant-investigations), acc. 2026-10-22).
- During AI Week (2026-07-27) six capabilities went GA: Investigations, Workspace, Automations (saved prompts run on a schedule, with results sent to Slack), the Cloud MCP server, the gcx CLI (dashboards and alerts as code, OSS included) and Agent Observability ([press release](https://grafana.com/press/2026/07/27/grafana-labs-ships-six-tools-that-power-agentic-operations-from-planning-to-production/), acc. 2026-10-22).
- **Watchers** entered public preview on 2026-07-29. They are always-on agents that check a scoped slice of Prometheus and Loki data on a schedule, stay quiet when it looks healthy, and notify Slack or a webhook or start an investigation when it does not. They are Cloud-only and run under the creator's identity ([what's new](https://grafana.com/whats-new/2026-07-29-introducing-assistant-watchers--agentic-alerting-for-grafana-cloud/); [docs](https://grafana.com/docs/grafana-cloud/machine-learning/assistant/platform/watchers/), acc. 2026-10-22). This is the closest incumbent equivalent to our `ops-watch`.
- SLO burn-rate alerts can start investigations (preview, 2026-05-20) ([what's new](https://grafana.com/whats-new/2026-05-20-grafana-slo-now-supports-assistant-investigations/), acc. 2026-10-22).
- **Sift** is separate: ML detectors for Kubernetes that need no prompt, free in Cloud ([docs](https://grafana.com/docs/grafana-cloud/machine-learning/assistant/investigations), acc. 2026-10-22).
- Assistant became available to OSS and Enterprise users in April 2026, but the backend, limits and billing stay in a connected Grafana Cloud stack ([what's new 2026-04-21](https://grafana.com/whats-new/2026-04-21-grafana-assistant-becomes-available-on-prem/), acc. 2026-10-22). Assistant appears to use Grafana's own model; whether you can bring your own LLM is **unverified**.
- Grafana OnCall OSS was archived on 2026-03-24, and IRM in Cloud is billed per monthly active user ([OnCall OSS docs](https://grafana.com/docs/oncall/latest/set-up/open-source/); [IRM pricing docs](https://grafana.com/docs/grafana-cloud/platform/pricing-and-usage/irm/), acc. 2026-10-22).
- Adaptive Metrics, Logs and Traces address cost (not re-checked for 2026).

**PagerDuty.**
- AIOps covers global, intelligent, content-based, unified and time-based alert grouping, auto-pause, suppression, Probable Origin, related, past and outlier incidents, **Recent Changes**, and global event orchestration. It is priced by event consumption ([PagerDuty docs](https://docs.pagerduty.com/ai-automation/aiops), acc. 2026-10-22).
- SRE Agent milestones:
  - Workflow integrations GA 2026-01-12: logs from Grafana, Datadog and CloudWatch; runbooks from Confluence and GitHub.
  - Recommended workflows GA 2026-06-03.
  - Triggering from incident workflows GA 2026-07-31.

  Sources: [changelog](https://support.pagerduty.com/main/changelog/sre-agent-workflow-integrations-are-generally-available), acc. 2026-10-22 (now redirects to docs.pagerduty.com release notes).
- The Spring 2026 release (2026-03-12) set a roadmap: SRE Agent as a "virtual responder" on escalation policies (early access Q2 2026), a fully autonomous responder (early access H2 2026), and agent-to-agent MCP with AWS DevOps Agent and the Azure SRE agent ([press release](https://pagerduty.com/newsroom/pagerduty-operations-cloud-spring-2026-release), acc. 2026-10-22). Whether these shipped is **unverified**.

**ServiceNow.**
- The Australia release notes (March 2026) cover the agentic workflows "manage alerts autonomously", "analyze alert impact" and "triage and analyze alerts". They add summaries that explain automated decisions such as auto-closing insignificant alerts, a Dynatrace MCP server agent, and Datadog and Gemini observability skills ([Now Assist for ITOM release notes](https://www.servicenow.com/docs/r/delta-yokohama-australia/australia-yokohama-nowassistforitoperationsmanagementitom-release-notes.html), acc. 2026-10-22).
- Models can be Now LLM, Azure OpenAI, Gemini or Claude on AWS. ITOM Prime bundles Discovery, Service Mapping, Event Management and the AI agents.
- "AIOps LEAP" is now the Learning-Enhanced Automation Platform.

**BigPanda.**
- BigPanda launched AI Detection and Response (L1) and AI Incident Assistant on an IT Knowledge Graph that includes chat and bridge-call transcripts ([Business Wire, 2025-05-28](https://www.businesswire.com/news/home/20250528507389/en/BigPanda-Launches-Agentic-IT-Operations-to-Bring-Intelligent-Automation-to-the-%24200-billion-ITOps-Market), acc. 2026-10-22). AI Incident Prevention followed ([blog](https://www.bigpanda.io/blog/gartner-hype-cycle-2025), acc. 2026-10-22).
- It bought Velocity, an AI SRE company, on 2025-11-10 ([press release](https://www.bigpanda.io/press-release/bigpanda-acquires-velocity/), acc. 2026-10-22).
- "Biggy" (BigPanda's AI assistant name) could not be confirmed **(unverified)**.

**Moogsoft / Dell.** Moogsoft was renamed APEX AIOps Incident Management in May 2024 ([Dell notice](https://www.delltechnologies.com/asset/en-us/solutions/apex/templates-forms/moogsoft-apex-aiops-rebranding-notice.pdf), acc. 2026-10-22). A third party reports Probable Root Cause shipped in 2025 ([rfp.wiki](https://www.rfp.wiki/vendors/moogsoft), acc. 2026-10-22). No 2026 agentic announcement was found.

**IBM.**
- Instana Intelligent Incident Investigation is "now generally available". It runs one-click agentic investigations that show their reasoning, correlate changes, and produce step-by-step remediation runbooks with generated Bash or Ansible that can be exported to GitHub or GitLab for review ([IBM product page](https://www.ibm.com/products/instana/intelligent-incident-investigation), acc. 2026-10-22). The earlier announcement said preview.
- Cloud Pak for AIOps (self-hosted) deduplicates events into alerts and groups alerts into incidents, adding probable cause and similar tickets. Its watsonx summaries run on the customer's own watsonx instance ([IBM community, 2025-10](https://community.ibm.com/community/user/blogs/neil-boyette/2025/10/01/how-agents-and-llms-are-accelerating-ops-teams), acc. 2026-10-22).

**Microsoft.**
- Azure SRE Agent went GA in March 2026, with OpenAI and Claude models, Python execution, memory and adjustable autonomy ([Azure update AZ558321](https://mc.merill.net/message/AZ558321), acc. 2026-10-22).
- The docs (2026-08-26) describe:
  - Incident intake from Azure Monitor alerts, PagerDuty and ServiceNow.
  - MCP connectors for Datadog, Splunk, New Relic, Dynatrace and Elasticsearch.
  - GitHub and Azure DevOps for deployment correlation, and Teams and Outlook for messages.
  - Scheduled tasks, skills, custom agents, Python tools and **hooks**.
  - Tool policies of allow, ask or deny; managed identity, RBAC and VNet isolation; an audit trail.

  Source: [Microsoft Learn overview](https://learn.microsoft.com/azure/sre-agent/overview), acc. 2026-10-22.
- Run modes are **Review** (the default; an SRE Agent Administrator approves Azure write actions) and **Autonomous**, set per response plan. Emails, Teams posts and external queries are not gated by approval ([run modes](https://learn.microsoft.com/azure/sre-agent/run-modes), acc. 2026-10-22).
- Pricing: 4 AAU per agent-hour always on, plus AAUs per million tokens by model. For example, Claude Opus 4.6 costs 100 AAU per million input tokens and 500 per million output tokens. The worked example uses $0.10/AAU. The 30-day always-on waiver is from 2026-08-26 ([pricing doc](https://sre.azure.com/docs/reference/pricing-billing), acc. 2026-10-22).
- Inference: always-on alone is about $0.40/hour, or about $290/month per agent at the example rate.
- Copilot in Azure was not re-checked.

**AWS.**
- DevOps Agent went GA on 2026-03-31, adding Azure and on-prem investigations, custom skills and reports ([What's New](https://aws.amazon.com/about-aws/whats-new/2026/03/aws-devops-agent-generally-available), acc. 2026-10-22).
- What it does:
  - Investigates automatically when an alert or ticket arrives.
  - Builds a continuously updated application topology.
  - Produces mitigation plans, plus "agent-ready" instructions for other agents (Kiro).
  - Prevents incidents proactively from historical patterns.
  - Routes findings to Slack, ServiceNow and PagerDuty.
  - Release-readiness review is in preview.
- Integrations: CloudWatch, Datadog, Dynatrace, New Relic, Splunk, Grafana, GitHub, GitLab, Azure DevOps, ServiceNow, PagerDuty and Slack, plus private MCP servers. It is callable over **MCP, ACP and A2A** ([user guide](https://docs.aws.amazon.com/devopsagent/latest/userguide/about-aws-devops-agent.html), acc. 2026-10-22).
- Pricing: $0.0083 per agent-second for investigations, evaluations and on-demand tasks, with idle time free. Queries to CloudWatch and other services are billed separately. There is a 2-month trial ([pricing](https://aws.amazon.com/devops-agent/pricing/), acc. 2026-10-22).
- CloudWatch investigations went GA on 2025-06-24 at no extra cost ([What's New](https://aws.amazon.com/about-aws/whats-new/2025/06/ga-accelerate-troubleshooting-amazon-cloudwatch-investigations/), acc. 2026-10-22).
- **DevOps Guru** takes no new customers from 2026-10-29 and reaches end of support on 2027-09-30. AWS recommends CloudWatch for anomaly detection and the DevOps Agent for investigation ([AWS docs](https://docs.aws.amazon.com/devops-guru/latest/userguide/devops-guru-end-of-support.html), acc. 2026-10-22).

**Google Cloud.**
- Investigations is an RCA agent that ranks "Observations" from logs, configuration and metrics into hypotheses. It starts from Logs Explorer, a Monitoring alert or chat, and can hand off to a support case ([Google Cloud blog, Aug 2025](https://cloud.google.com/blog/products/management-tools/gemini-cloud-assist-investigations-performs-root-cause-analysis), acc. 2026-10-22).
- Release notes from April 2026 onward:
  - 2026-04-10: creating or running investigations limited to Premium Support (or by request).
  - 2026-04-22: proactive agents in private preview. They investigate Cloud Alerting and cost anomalies in the background, change nothing, and deliver results via Eventarc.
  - 2026-04-22: MCP support in private preview.
  - No GA entry.

  Source: [release notes](https://docs.cloud.google.com/cloud-assist/release-notes), acc. 2026-10-22.

**Resolve AI.**
- An "AI SRE that goes on-call": triage, RCA, mitigation, and "Hivemind" tribal knowledge. Security features listed: audit logs, SSO, RBAC, redaction, and no training on customer data ([resolve.ai](https://resolve.ai/), acc. 2026-10-22).
- Funding: $125M Series A at a $1B valuation ([TechCrunch, 2026-02-04](https://techcrunch.com/2026/02/04/ai-sre-resolve-ai-confirms-125m-raise-unicorn-valuation/), acc. 2026-10-22). A further $40M at $1.5B in April 2026 is reported by aggregators **(unverified)**.

**Traversal.** Traversal offers a "Production World Model" (a causal map), triage, RCA, remediation, pre-deploy impact checks, BYOC/BYOM, and read-only, agentless operation by default ([traversal.com](https://traversal.com/), acc. 2026-10-22). Amex Ventures invested in March 2026 and American Express is deploying it ([Business Wire, 2026-03-04](https://www.businesswire.com/news/home/20260304551167/en), acc. 2026-10-22).

**Cleric.** Cleric watches each change for 14 days, closes false-positive alerts, opens fix PRs for approval and verifies the fix. It is read-only by default with every action logged ([cleric.ai](https://cleric.ai/), acc. 2026-10-22). It launched as a "self-learning AI SRE" on 2025-12-09 ([Business Wire](https://businesswire.com/news/home/20251209625361/en/Cleric-Launches-the-First-Self-Learning-AI-SRE), acc. 2026-10-22).

**Causely.** Causely builds a live causal model of services and failure paths and reports root cause, blast radius and owner. It reads OpenTelemetry, Prometheus, Datadog, Dynatrace, MySQL and Elasticsearch, and fills gaps with eBPF. It runs as hybrid SaaS or BYOC (receiving no customer data) and exposes an MCP server ([causely.ai](https://www.causely.ai/), acc. 2026-10-22). Its "zero hallucinations" and "100% fault accuracy" claims come from its own study.

**Komodor (Klaudia).**
- A multi-agent framework with 50+ agents across K8s, cloud, GPUs, network and storage, extensible through MCP and OpenAPI ([IT Brief, 2026-03-19](https://itbrief.co.uk/story/komodor-unveils-klaudia-ai-multi-agent-sre-platform), acc. 2026-10-22).
- Klaudia Memory (2026-07-21) reuses customer-specific past investigations without training on customer data ([Komodor blog](https://komodor.com/blog/klaudia-memory-launch/), acc. 2026-10-22).
- Komodor is a representative vendor in the Gartner guide ([GlobeNewswire, 2026-02-04](https://www.globenewswire.com/news-release/2026/02/04/3232144/0/en/Komodor-Named-a-Representative-Vendor-in-the-2026-Gartner-Market-Guide-for-AI-Site-Reliability-Engineering-Tooling.html), acc. 2026-10-22).

**HolmesGPT (open source).**
- About 40 built-in toolsets: Prometheus, Grafana, Datadog, New Relic, VictoriaMetrics, Loki, Tempo, Elasticsearch/OpenSearch, Splunk, Kubernetes, Helm, ArgoCD, AWS, Azure, GCP, SQL, MongoDB, Kafka, RabbitMQ, Jira, Confluence, ServiceNow, GitHub and others.
- Alertmanager via Robusta or the CLI; PagerDuty, Opsgenie and Jira via the CLI; Slack and Teams via Robusta.
- Read-only by design. The opt-in Kubernetes remediation toolset and GitHub PRs can make changes.
- CNCF Sandbox, Apache-2.0, any LLM provider; operator mode runs it 24/7 ([GitHub](https://github.com/HolmesGPT/holmesgpt), acc. 2026-10-22).
- A recent release fixed an auth bypass (CVE-2026-48710) ([newreleases](https://newreleases.io/project/github/HolmesGPT/holmesgpt/release/0.32.0-alpha), acc. 2026-10-22).
- This is **our closest open-source peer**.

**K8sGPT (open source).** About 14 default analyzers plus optional ones; an operator integrates with Prometheus and Alertmanager; backends include Ollama, LocalAI, LiteLLM and others; `k8sgpt serve --mcp` runs an MCP server ([GitHub](https://github.com/k8sgpt-ai/k8sgpt); [CNCF](https://cncf.io/projects/k8sgpt), acc. 2026-10-22).

**Rootly.** Parallel hypothesis checks across alerts, telemetry, deploys, commits and feature flags. It drafts rollback PRs, matches similar incidents, transcribes the incident bridge, drafts retrospectives, and offers an MCP server for IDEs. It "never auto-remediates without human sign-off" and supports bring-your-own AI key ([rootly.com/ai-sre](https://rootly.com/ai-sre), acc. 2026-10-22).

**incident.io.** Investigations start when an incident is declared. They give a confidence score and sources, use an **adversarial agent to challenge conclusions**, show a reasoning timeline, and propose fix PRs for human review. Nexus models systems, teams and history ([incident.io/ai-sre](https://incident.io/ai-sre), acc. 2026-10-22).

**Shoreline, Parity, Ciroos, NeuBird and other entrants.**
- NVIDIA agreed to buy Shoreline in June 2024 ([Bloomberg](https://www.bloomberg.com/news/articles/2024-06-18/nvidia-agrees-deal-to-buy-software-startup-shoreline), acc. 2026-10-22). Whether it is sold standalone today is **unverified**.
- Parity is a YC S24 K8s AI SRE with read-only VPC access ([YC launch](https://www.ycombinator.com/launches/Lbr-parity-the-world-s-first-ai-sre), acc. 2026-10-22). Its 2026 status is **unverified**.
- Ciroos raised $21M and supports MCP and A2A ([Constellation Research](https://www.constellationr.com/insights/news/ciroos-raises-21-million-heres-look-strategy-ceo-ronak-desai), acc. 2026-10-22).
- NeuBird raised $19.3M in April 2026; Hawkeye is read-only ([NeuBird](https://neubird.ai/news-and-press/neubird-ai-raises-19-3-million-to-scale-agentic-ai-across-enterprise-production-operations/), acc. 2026-10-22).
- Palo Alto Networks closed its $3.35B Chronosphere deal on 2026-01-29, to integrate with Cortex AgentiX ([PANW press release](https://paloaltonetworks.com/company/press/2026/palo-alto-networks-completes-chronosphere-acquisition--unifying-observability-and-security-for-the-ai-era), acc. 2026-10-22).

---

## 3. Capability map of a best-in-class 2026 platform

| Capability | Table stakes or differentiator (2026) | Who shows it best |
|---|---|---|
| Alert ingestion from many sources (webhooks, events API) | Table stakes | PagerDuty (700+ integrations), ServiceNow, BigPanda, Datadog Event Mgmt |
| Dedup, grouping and correlation (noise reduction) | Table stakes | PagerDuty AIOps, Datadog intelligent correlation, Splunk ITSI, BigPanda, IBM Cloud Pak |
| Explained grouping and auto-close | Becoming table stakes | Splunk AI SRE ("why grouped"), ServiceNow (explanations of auto-closures) |
| Anomaly detection (baselines, seasonality, ML) | Table stakes for telemetry owners | Datadog Watchdog, Dynatrace Davis, Splunk ITSI adaptive thresholds, Elastic ML, CloudWatch |
| Agentic "watchers" (natural-language health definitions) | Differentiator (new) | Grafana Watchers (preview), Google proactive agents (preview) |
| Topology and dependency mapping | Differentiator; decisive for RCA quality | Dynatrace Smartscape, AWS DevOps Agent topology, Causely, Traversal, ServiceNow Service Mapping |
| Change intelligence (deploys, commits, flags, config) | Table stakes in AI SRE | PagerDuty Recent Changes, Rootly, Cleric (14-day change watch), Azure SRE Agent (GitHub/ADO), IBM Instana |
| Alert-triggered investigation agent (hypotheses, evidence) | Table stakes (every major vendor GA in 2026) | Datadog, Azure, AWS, Grafana, Splunk, incident.io, Resolve |
| Causal / deterministic grounding under the LLM | Differentiator | Dynatrace, Causely, Traversal, IBM (causal plus LLM) |
| Evidence chain, confidence, visible reasoning | Table stakes for trust | Splunk, incident.io, Rootly, IBM Instana |
| Adversarial verification of the RCA | Differentiator | incident.io |
| Memory of past incidents and similar-incident retrieval | Table stakes | Komodor Memory, Azure retained context, PagerDuty Past Incidents, BigPanda knowledge graph |
| Runbook automation | Table stakes (ITOM) | ServiceNow, PagerDuty (Rundeck, not re-checked), Azure skills, IBM (Bash/Ansible) |
| Remediation with approval (human-in-the-loop) | Table stakes | Azure Review mode, Rootly, incident.io (PR only), Cleric |
| Graduated autonomy (trusted actions run unattended) | Differentiator | Azure Autonomous per response plan, Dynatrace phase 3, PagerDuty autonomous responder (planned) |
| Code-level fix PRs | Differentiator (spreading fast) | Splunk + Claude (alpha), Cleric, incident.io, Rootly, Datadog suggestions, AWS via Kiro |
| SLOs and error budgets | Table stakes | Datadog, Grafana SLO (start investigations from burn alerts), Dynatrace, NR |
| Forecasting and capacity | Table stakes for telemetry owners | Dynatrace prediction agent, Datadog forecasts, Grafana ML (not re-checked) |
| Cost (telemetry and cloud) | Differentiator | Grafana Adaptive Telemetry, Google cost-anomaly agents, Cast AI |
| Security signals in the same loop | Differentiator | Dynatrace security agents, Datadog Bits Security Agent, Palo Alto + Chronosphere |
| Chat-native incident loop (Slack/Teams) | Table stakes | incident.io, Rootly, PagerDuty, NR (Slack), Azure (Teams) |
| Ticketing and paging write-back | Table stakes | Azure (ServiceNow, PagerDuty tickets prefilled), AWS, ServiceNow |
| MCP server and agent-to-agent (A2A/ACP) | Table stakes in 2026 | Datadog MCP GA, Grafana MCP GA, AWS (MCP/ACP/A2A), PagerDuty A2A, Causely, K8sGPT |
| Postmortem / retrospective drafting | Table stakes | Rootly, incident.io, NR, PagerDuty Scribe |
| Agent observability (tokens, latency, evaluations) | Differentiator | Grafana Agent Observability, Splunk (Galileo), Elastic 9.5 OTel traces of agent runs |
| Self-hosted, BYOC, air-gapped, bring-your-own-model | Differentiator (rare) | Traversal BYOC/BYOM, Causely BYOC, Elastic self-managed + LM Studio, HolmesGPT, K8sGPT, IBM Cloud Pak |

---

## 4. Integrations

- **Alert in.** Incumbents receive alerts in three ways.
  - Their own detectors: Datadog monitors, Dynatrace problems, Splunk detectors.
  - Incident platforms: PagerDuty, ServiceNow and Azure Monitor alerts are the three intake paths for the Azure SRE Agent. AWS starts "when an alert or support ticket comes in".
  - Generic webhooks: Alertmanager into Robusta/HolmesGPT, the K8sGPT operator, Grafana Watchers posting to a webhook.

  Prometheus Alertmanager and Grafana Alerting webhooks are the de-facto standard for the Prometheus/Grafana world. PagerDuty's Events API and webhooks are the standard in enterprises.
- **Telemetry reads.** Vendors with their own data stores query them natively. Overlay agents use each tool's API, and in 2026 increasingly **MCP**:
  - Datadog MCP Server (GA March 2026).
  - Grafana Cloud MCP server (GA July 2026).
  - Splunk MCP Server.
  - Dynatrace MCP server (consumed by ServiceNow).
  - Causely MCP and K8sGPT MCP.

  Azure SRE Agent's partner connectors are MCP-based. AWS connects "private or remote MCP servers". Typical sources:
  - Metrics: Prometheus/PromQL, CloudWatch, Azure Monitor.
  - Logs: Loki, Elasticsearch/OpenSearch, Splunk, CloudWatch Logs.
  - Traces: Tempo, Jaeger, X-Ray, APM.
  - Kubernetes API.
  - Code and CI/CD: GitHub, GitLab, Azure DevOps.
  - Docs: Confluence.
- **OpenTelemetry** is the common ingestion format for the telemetry owners (Datadog OTLP ingestion, Grafana, Elastic, Splunk). Causely reads OTel directly. OTel also matters for agent observability: Elastic 9.5 records agent runs as OTel spans.
- **Out.** Slack and Teams are universal for findings, threads and approvals. ServiceNow and Jira tickets get prefilled investigation summaries (Azure, AWS). Paging goes through PagerDuty or Opsgenie (both read alerts and write back notes). Code work happens through PRs.
- **Agent-to-agent.** PagerDuty plans MCP collaboration with the AWS DevOps Agent and Azure SRE agent. AWS exposes MCP, ACP and A2A. Ciroos supports A2A. Expect "SRE agent federation": a paging platform's agent calling a cloud's agent.

---

## 5. Real time: how they watch

- **Streaming detection belongs to the telemetry owners.** Datadog, Dynatrace, Splunk and Elastic run detectors, ML baselines and correlation on their ingest pipelines. ITSI quotes about 100k events per minute ([Cisco Live deck](https://www.ciscolive.com/c/dam/r/ciscolive/emea/docs/2025/pdf/BRKOBS-1939.pdf), acc. 2026-10-22). PagerDuty can raise its events limit to 10,000 per minute per key.
- **No one runs an LLM on the raw stream.** Every LLM agent is **event-triggered** (an alert, an incident, a ticket, an SLO burn) and then **pulls** data on demand through queries.
- **Scheduled agent checks are the 2026 addition:** Grafana Watchers and Automations, Azure SRE Agent scheduled tasks, AWS "evaluations", Google proactive agents, HolmesGPT operator mode. These are polling at minutes-scale, much like our `ops-watch`.
- **Implication for us:** "real-time" does not mean building a streaming engine. It means:
  1. A push path: webhooks from Alertmanager, Grafana, PagerDuty and Datadog, answered within seconds.
  2. A cheap deterministic evaluation loop that calls a model only when state changes.
  3. Leaving high-rate detection to Prometheus and Alertmanager, which already do it.

---

## 6. Management scope

| Target | Who covers it well | Notes |
|---|---|---|
| Kubernetes | Komodor, Metoro, Sift, K8sGPT, HolmesGPT, Splunk (remediation plans K8s-only), Parity, Cast AI | Most AI-SRE startups are K8s-first |
| Cloud resources | AWS DevOps Agent (plus Azure and on-prem since GA), Azure SRE Agent (any Azure resource via RBAC and CLI), Gemini Cloud Assist | Hyperscaler agents act best on their own cloud |
| VMs, hosts, on-prem | Dynatrace (OneAgent), IBM, ServiceNow, Dell APEX AIOps, HolmesGPT (VMs) | Legacy ITOM strength |
| Databases | Causely (MySQL, Postgres-style RCA), HolmesGPT SQL/MongoDB toolsets, Komodor DB agents, Dynatrace | Usually diagnosis only |
| Messaging (Kafka, RabbitMQ) | HolmesGPT, Dynatrace, Datadog | |
| Application code | Cleric, incident.io, Rootly, Splunk + Claude, AWS + Kiro, Datadog | Changes arrive as PRs, never pushed directly |
| CI/CD and release | AWS release-readiness (preview), Cleric, Traversal pre-deploy checks | "Shift-left reliability" theme in the Gartner guide |

---

## 7. What these tools replace, and what they complement

**They replace or shrink:**
- Manual first-pass triage and evidence gathering: the first 15-30 minutes of an incident.
- Much of L1 and NOC "acknowledge, look, route" work. BigPanda sells "AI Detection and Response for L1", and PagerDuty's virtual responder sits on escalation policies.
- Static per-metric thresholds, replaced by baselines, AI detection and watchers.
- Writing status updates and first-draft postmortems.
- Some runbook automation, for well-understood actions in trusted modes.
- Some on-call toil. Cleric claims 58% of alerts closed without an engineer (vendor claim).

**They complement and do not replace:**
- Telemetry storage and query: Prometheus, Grafana, Loki, Tempo, Datadog, Elastic, Splunk. Every agent depends on it, and even the telemetry owners' agents only query it.
- Paging and on-call scheduling (PagerDuty, Opsgenie, Grafana IRM).
- Ticketing and change management (ServiceNow, Jira).
- CI/CD and IaC.
- Human incident command for novel failures.
- Accountability for production changes.

Gartner's guide, as summarised by Cast AI, stresses keeping humans in the loop to approve changes.

---

## 8. Known limitations and failure modes

- **Hallucinated or wrong RCA:**
  - On OpenRCA, the most common failures were "hallucinated data interpretation" and "incomplete exploration", across all models ([arXiv 2602.09937, 2026-02-10](https://www.arxiv.org/abs/2602.09937), acc. 2026-10-22).
  - SREGym (90 live problems) found up to 40% differences in end-to-end results across failure types ([arXiv 2605.07161](https://arxiv.org/abs/2605.07161), acc. 2026-10-22). A secondary summary quotes 38.1-72.6% diagnosis success **(unverified against the paper)**.
  - ClickHouse found no model reliably found root causes without guidance. Gemini 2.5 Pro "invented unsupported causes". Costs ranged from $0.10 to about $6 and times from 1 to 45 minutes per investigation ([InfoQ, 2025-09-27](https://infoq.com/news/2025/09/clickhouse-llm-sre-report), acc. 2026-10-22).
  - Rootly notes that output "reads just as confident either way" on novel failures ([Rootly blog](https://rootly.com/blog/do-ai-sre-agents-actually-work), acc. 2026-10-22).
- **Trust and adoption:**
  - 73% not using AIOps, 60% citing trust, 59% wanting near-perfect accuracy, 62% preferring a co-pilot ([NextPlatform, sponsored by NeuBird, 2026-07-15](https://nextplatform.com/control/2026/07/15/sres-to-ai-agents-prove-yourself-before-you-touch-production/5271533), acc. 2026-10-22).
  - A vendor essay lists automation bias, over-suppression hiding the signal, and unsafe actions as failure modes ([Traversal](https://www.traversal.com/blog/ai-in-incident-response-state-of-the-field-2026-sre), acc. 2026-10-22).
- **Alert noise:** faster grouping can add volume on top of fatigue (the same Traversal essay). Over-aggressive auto-close risks missed incidents, which is why ServiceNow added explanations for auto-closures.
- **Cost:** pricing is per investigation or per agent time.
  - Datadog: credits.
  - AWS: about $30 per agent-hour, plus the queries it runs.
  - Azure: always-on charge plus tokens.
  - Grafana Investigations had a soft limit of 50 per user per month during preview.

  Investigating every alert gets expensive. Telemetry queries the agent runs are billed too (AWS says so explicitly).
- **Data egress and residency:**
  - Elastic's assistant sends un-anonymised alerts, logs and queries to third-party LLMs.
  - Grafana Assistant "on-prem" still uses the Cloud backend.
  - Gemini investigations was unsupported inside VPC Service Controls for a period in 2026.
  - New Relic Autopilot is not FedRAMP; Datadog Bits AI SRE is not on the gov sites.
- **Access and churn:** previews with breaking changes (Watchers), alpha remediation (Splunk), features narrowed after preview (Gemini restricted to Premium Support), and renames (NR SRE Agent to Autopilot, Moogsoft to APEX AIOps). DevOps Guru's retirement shows ML-only AIOps products being replaced by agents.
- **Lock-in:** agents work best on their vendor's data. 52% of survey respondents would switch telemetry tools for AI that works across any back end (same sponsored survey). This is an opening for neutral overlays, and for us.
- **Unsafe actions:** approval gating is often partial. Azure documents that emails, Teams posts and external queries are not approval-gated. Several startups market autonomy without documenting their approval model (Resolve, Komodor, Causely).

---

## 9. Where we stand: what our pack has today

From `README.md` ("AIOps pack", "AIOps pack: DevOps", "Key Vault", "Scheduled work and sub-agents"), `plugins/aiops/harness-plugin.json`, `plugins/aiops/index.mjs`, `plugins/aiops/workflows/*.json`, `plugins/devops/index.mjs` and `docs/HANDOFF.md`:

- **aiops tools:**
  - `ops_inventory`: hosts, services, environments, maintenance windows, alert rules, SLOs, and static `depends_on` (`plugins/aiops/lib/inventory.mjs`).
  - `prometheus_query`.
  - `logs_search`: Loki, docker logs, or files over ssh.
  - `probe`: HTTP, TCP, DNS, TLS.
  - `host_stats`, `docker_status`.
  - `ssh_exec`: vault credentials, pinned host keys, a read-only allowlist.
  - `service_control`.
  - `ops_check`: PromQL, probe and log rules evaluated by the harness, with history showing flapping, noisy and always-firing rules.
  - `slo_status`: multi-window burn rates.
  - `capacity_forecast`: least squares and Holt.
  - `incident`: open, update, resolve, postmortem.
  - `runbook`.
- **aiops workflows:**
  - `incident-response`: triage, then four parallel `sre` evidence steps (metrics, logs, changes and deploys, hosts), hypotheses, RCA, a runbook, the `runbook-safe` gate, approval, execution, the `ops-healthy` verify gate, and a postmortem.
  - `ops-advisor`: read-only reliability, capacity, security and cost report.
  - `ops-watch`: one scheduled round of `ops_check`; opens or updates incidents and calls `notify_user`.
  - Six runbooks: restart-service, clear-disk, rotate-logs, os-updates, cert-check, backup-verify.
- **aiops agents and gates:** agents `sre`, `capacity-planner`, `security-auditor`, `cost-optimizer`; gates `inventory-valid`, `alerts-valid`, `runbook-safe`, `ops-healthy`.
- **devops tools:**
  - `iac`: plan, and apply by sha256 only.
  - `k8s`: validate, template, lint, diff, apply and wait, rollout-status and undo, get, describe, logs, events.
  - `ci`: GitHub Actions runs, logs, watch, rerun, dispatch, lint, run-local.
  - `container`: hadolint, trivy.
  - `deploy`: compose with health checks and automatic rollback; history in `.harness/devops/deploy/`.
- **devops workflows:** `ship-change`, `pipeline-fix`, `k8s-rollout`; eight gates.
- **Safety:**
  - Only the operator's inventory attaches credentials.
  - Every vault read is a permission decision.
  - Strict name validation and quoting.
  - The server's Docker engine is off by default.
  - Every system action goes to `audit.jsonl`.
  - A gate and a unit test check that every change goes through an approval edge and is followed by a verify step.
- **Harness:**
  - Model-agnostic: Claude, OpenAI, DeepSeek, and any OpenAI-compatible server including Ollama and vLLM. Tuned on Haiku 5.5, DeepSeek V4.1 Flash and GPT-6 Luna.
  - Self-hosted; Key Vault with HashiCorp, Azure and AWS backends.
  - Sub-agents, background tasks and `monitor`, the scheduler, secret-URL webhook triggers, MCP servers and bundles, `notify_user` and Notification hooks.
  - Evals with hidden checks: `evals/aiops` has 3 cases on a real compose stack, verified end to end with a scripted model.
- **Not yet done** (`docs/HANDOFF.md` item 6): operating the pack on a real estate. The README's "Measured" section has no live-model pass rates for the aiops evals yet.

---

## 10. Gap analysis

Legend: **Has** = implemented. **Partial** = some of it, or only via a generic mechanism. **Missing** = none. P0 = needed to be credible as an AI SRE inside an existing monitoring estate. P1 = needed to compete. P2 = nice to have, or later.

| # | Capability | Best-in-class examples | Ours | Priority, and why |
|---|---|---|---|---|
| 1 | Alert ingestion via webhook into incidents (Alertmanager, Grafana Alerting, PagerDuty v3, Datadog, generic JSON) | PagerDuty, Azure SRE Agent (PagerDuty/ServiceNow/Azure Monitor), AWS, HolmesGPT via Robusta | **Partial.** `POST /api/schedules {trigger:true}` starts a prompt with the body as untrusted data (`src/core/scheduler.ts`). No alert parsing, no mapping to inventory services, no incident upsert, one session per POST | **P0.** Without push ingestion we cannot sit behind the Prometheus/Alertmanager or PagerDuty stack users already have, and that is how every competitor starts |
| 2 | Dedup, grouping and correlation across alerts (fingerprint, time window, dependency-aware), with explanations | PagerDuty AIOps grouping, Datadog intelligent correlation, Splunk ("why grouped"), IBM Cloud Pak | **Partial.** `ops_check` history flags flapping, noisy and always-firing rules. `ops-watch` asks the model to find an open incident per service (LLM-driven, not deterministic) | **P0.** Each new alert must not open a new incident or wake a model. A deterministic grouper is cheap and auditable |
| 3 | Model-free watch loop (evaluate on a timer, call an agent only on state change) | Grafana Watchers (stay quiet when healthy), Google proactive agents, Prometheus itself | **Partial.** `ops-watch.json` runs an `sre` agent (up to 25 steps) every round, even when nothing fires. At `*/5` that is 288 agent runs a day | **P0.** Cost and latency: cheap models make this affordable, but zero calls is better, and it is the honest fix for our "polling" design |
| 4 | Change intelligence (one timeline of deploys, rollouts, Terraform applies, CI runs, commits, config and flag changes, correlated with incident start) | PagerDuty Recent Changes, Cleric, Rootly, Azure SRE Agent (GitHub/ADO), IBM Instana | **Partial.** The `incident-response` "recent changes" step reads whatever it can: `deploy` history, `ci runs`, `k8s` rollouts, git. No change-event store, no time-window correlation, `iac apply` not recorded as an event | **P0.** "Recent changes first" is in our own `aiops-triage` skill; deploys cause most incidents and we already have the change data in devops |
| 5 | Kubernetes signals inside aiops (cluster in the inventory, CrashLoop/OOMKilled/Pending/node-pressure checks in `ops_check`, k8s evidence in `incident-response`, restart and scale runbooks) | Komodor, Sift, K8sGPT analyzers, HolmesGPT, Splunk K8s remediation | **Partial.** `k8s` get, describe, logs, events and rollout-undo exist in `plugins/devops`. aiops inventory, `ops_check` and the incident workflow do not use them | **P0.** Most startups' first target. Mostly wiring existing tools together |
| 6 | Two-way chat (Slack/Teams incident thread, live updates, approve or deny from chat) | incident.io, Rootly, PagerDuty, NR (Slack), Azure (Teams) | **Partial.** Outbound via `notify_user` and Notification hooks; inbound Slack slash command via a trigger URL. No thread per incident, no approvals in chat | **P1.** Responders live in chat; approvals in chat make our approval model usable at 3 a.m. |
| 7 | Paging integration (PagerDuty/Opsgenie: receive, ack, add notes, resolve; escalate when the agent is unsure) | PagerDuty, Azure, AWS | **Missing** (beyond generic triggers and hooks) | **P1.** Enterprises route every alert through a pager; we must be a good citizen there (write findings back, never steal the page) |
| 8 | Ticketing (Jira, ServiceNow: create or update with the investigation summary, link the postmortem) | Azure (prefilled ServiceNow/PagerDuty tickets), AWS, ServiceNow | **Missing.** Incidents are files in `.harness/ops/incidents/` (`plugins/aiops/lib/incidents.mjs`) | **P1.** Change and incident records must land in the system of record; MCP servers can cover part of it |
| 9 | Grafana integration (Grafana Alerting webhook and rule reads, annotations for incidents and deploys, dashboard and Explore links in reports, Grafana datasource proxy as a query path) | Grafana Assistant, Grafana MCP server | **Missing** (we query Prometheus and Loki directly) | **P1.** Most self-hosted Prometheus users look at Grafana; annotations and links make our findings visible where people look |
| 10 | OpenTelemetry traces (Tempo/Jaeger queries, span errors and latency by service, trace exemplars) | Datadog APM, Dynatrace, Grafana Tempo, Causely (OTel), HolmesGPT (Tempo) | **Missing** | **P1.** Traces are the fastest way to locate a failing hop; also the source of a discovered service graph (row 11) |
| 11 | Topology / dependency graph (discovered from k8s objects, Prometheus labels, the traces service graph, the inventory) used in RCA and blast radius | Dynatrace Smartscape, AWS topology, Causely, Traversal, ServiceNow Service Mapping | **Partial.** Static `depends_on` in the inventory (`lib/inventory.mjs`), used by the hosts evidence step | **P1.** Topology is the main differentiator for RCA accuracy; start with inventory, k8s and the trace service graph |
| 12 | Anomaly detection beyond thresholds (seasonal baselines, MAD/z-score on PromQL ranges, "new error pattern" in logs) | Datadog Watchdog, Dynatrace Davis, Splunk ITSI, Elastic ML, Elastic significant events, CloudWatch | **Partial.** Static rules (`ops_check`), burn rates (`slo_status`), trend forecast (`capacity_forecast`) | **P1.** Reduces hand-written rules; a deterministic statistical detector fits our "no model in the loop" principle |
| 13 | Evidence-cited RCA with confidence and an adversarial check (every claim links to the query or command and its numbers; a second agent tries to refute it) | incident.io (adversarial agent), Splunk (evidence chain, confidence), IBM | **Partial.** The hypotheses state and `Root cause:` line exist; ops-advisor requires evidence. No refuter step, no confidence field | **P1.** The research shows hallucinated interpretation is the top failure; a refuter node and cited evidence are cheap in our workflow engine |
| 14 | Incident memory / similar past incidents | Komodor Memory, Azure retained context, PagerDuty Past Incidents, BigPanda | **Partial.** Incidents and postmortems on disk; harness memory across sessions; no similarity retrieval at triage | **P1.** Repeat incidents are common; retrieval over our own postmortems is cheap |
| 15 | Graduated autonomy (per-runbook "safe unattended" policy, budgets, blast-radius limits) | Azure Review/Autonomous per response plan, Dynatrace phases | **Partial.** Operator allow rules can pre-authorise exact actions (`service_control(shop-api restart)`); `runbook-safe` forces approval nodes; no declared "unattended-safe" runbook class | **P1.** Customers expect to automate the boring 20%; we can do it more safely than most |
| 16 | Cloud provider APIs, read-only (CloudWatch metrics and logs, Azure Monitor / Log Analytics, GCP Monitoring; resource health; recent cloud changes from CloudTrail and Activity Log) | AWS DevOps Agent, Azure SRE Agent, Gemini Cloud Assist | **Missing** (`iac` can plan and apply; no observability reads) | **P1.** Many estates are cloud-first; the vault already has AWS/Azure credentials and SigV4 code (`src/vault/sigv4.ts`) |
| 17 | Database diagnostics (Postgres/MySQL: sessions, locks, slow queries, replication lag, connection-pool saturation; read-only) | Causely, HolmesGPT SQL toolsets, Komodor DB agents | **Partial.** `ssh_exec` read-only commands on a DB host; the slow-endpoint eval finds a missing index through logs | **P1.** DBs are a top root cause (our own eval case is one); typed read-only tools beat ad-hoc ssh |
| 18 | Elasticsearch/OpenSearch and CloudWatch Logs as log backends | HolmesGPT, Elastic, AWS | **Missing** (Loki, docker, ssh files only) | **P2.** Covered partly by row 16; common in older estates |
| 19 | SLO-triggered investigations | Grafana SLO + Investigations (preview) | **Partial.** `slo_status` computes the multi-window burn alerts when called. `ops_check` (and so `ops-watch`) does not evaluate them, and nothing starts `incident-response` from a burn | **P1.** Small change (evaluate burn alerts in `ops_check`) that makes our best SLO feature part of the watch loop |
| 20 | Remediation with approvals and verification | Azure Review mode, Rootly, Cleric, IBM (runbooks for review) | **Has.** `incident-response` approval then execution then `ops-healthy`; `runbook-safe` gate; six runbooks; devops `ship-change`/`k8s-rollout` with plan hash and rollback; `audit.jsonl` | Keep. **P2:** more runbooks (k8s restart/scale, DB connection kill, cert renew via ACME) |
| 21 | Code-level fix PRs from an incident | Splunk + Claude (alpha), Cleric, incident.io, Rootly, AWS + Kiro | **Partial.** The SDLC pack and `publish_branch` exist; not wired into `incident-response` | **P2.** Differentiator, but our users' first need is infra; easy later via a sub-workflow |
| 22 | Postmortems | Rootly, incident.io, NR | **Has.** `incident postmortem`, `postmortem` skill | Keep |
| 23 | SLOs / error budgets | Datadog, Grafana, Dynatrace | **Has** (`slo_status`, multi-window burn rates) | Keep |
| 24 | Forecast / capacity | Dynatrace prediction, Datadog forecasts | **Has** (`capacity_forecast` linear and Holt) | **P2:** seasonal Holt-Winters |
| 25 | Cost | Grafana Adaptive Telemetry, Google cost anomalies, Cast AI | **Partial.** `cost-optimizer` agent in `ops-advisor` (idle and oversized from metrics); no billing data | **P2** |
| 26 | Security posture in ops | Dynatrace/Datadog security agents | **Partial.** `security-auditor` (certs, root containers, secrets in env, sshd, packages); devops trivy | **P2** |
| 27 | Real-time streaming | Telemetry owners' ingest pipelines | **Missing** by design (pull plus minutes-scale schedule) | **P2.** Not needed if rows 1-3 land; we should not store telemetry |
| 28 | MCP / A2A interfaces (expose our ops tools and incidents to other agents; consume Grafana/Datadog/K8sGPT MCP under our vault and approval rules) | Datadog/Grafana MCP GA, AWS MCP/ACP/A2A, PagerDuty A2A | **Partial.** The harness consumes MCP servers and bundles; we do not expose aiops as an MCP server; vault and approval coverage of third-party MCP tools not checked for this pack | **P1** (consume, governed) / **P2** (expose). Cheapest route to integration breadth |
| 29 | Operations console UI (incident list, timeline, alerts, approvals) | Every SaaS vendor | **Partial.** Session UI and workflow runs; incidents are Markdown and JSON | **P2.** Chat and ticketing integrations (rows 6-8) matter more |
| 30 | Published accuracy on live models (our evals plus public benchmarks such as OpenRCA and SREGym) | Rootly AI Labs benchmarks, Causely study, Dynatrace benchmark (all vendor-run) | **Partial.** 3 hidden-check cases verified with a scripted model; no live-model numbers in README "Measured" | **P1.** Our strongest trust argument, cheap to produce, and a gap no incumbent fills credibly |

### Top 10 gaps in priority order

1. **Alert ingestion** (row 1). `POST /api/ops/alerts` accepting Alertmanager, Grafana Alerting, PagerDuty v3 and generic payloads, mapped to inventory services, upserting incidents.
2. **Deterministic dedup, grouping and a model-free watch loop** (rows 2-3). Fingerprints, time windows, dependency-aware grouping with explanations. `ops_check` evaluated on a timer by the server; an agent starts only on a new or escalated group.
3. **Change-intelligence timeline** (row 4). Record `deploy`, `k8s apply`/`rollout-undo`, `iac apply`, CI runs and git commits as change events with time and target. Add a `changes {since, service}` tool and correlation by time and dependency.
4. **Kubernetes in aiops** (row 5). A cluster target in the inventory, K8s health rules in `ops_check`, a k8s evidence step in `incident-response`, and k8s runbooks.
5. **Two-way Slack/Teams with approvals** (row 6).
6. **Paging and ticketing connectors** (rows 7-8). PagerDuty/Opsgenie notes, ack and resolve; Jira/ServiceNow create and update. Possibly through governed MCP servers.
7. **Grafana integration** (row 9). Annotations, alert-rule reads, dashboard links in reports.
8. **OTel traces and discovered topology** (rows 10-11). Tempo/Jaeger queries; a service graph from traces, k8s and inventory used in RCA and blast radius.
9. **Anomaly detection beyond thresholds** (row 12). Seasonal baselines and robust z-scores over PromQL ranges; new log patterns.
10. **Evidence-cited RCA with an adversarial refuter and incident-similarity memory** (rows 13-14).

Next in line: cloud provider read APIs (row 16), database diagnostics (row 17), published live-model eval results (row 30), and graduated autonomy policy (row 15).

---

## 11. Where we could be stronger than incumbents, and where we are weaker

**Stronger, or able to be:**
- **Model-agnostic and bring-your-own-model by default.** Competitors are tied to fewer models:
  - Grafana Assistant uses Grafana's model and backend, even on-prem.
  - Azure SRE Agent offers OpenAI and Claude.
  - Datadog, NR and Splunk choose the model for you.

  Only Traversal (BYOM), Rootly (BYO key), HolmesGPT, K8sGPT and Elastic (connectors, LM Studio) come close. We run Claude, OpenAI, DeepSeek or any OpenAI-compatible local server.
- **Self-hosted and air-gap-capable,** with a local model via Ollama or vLLM. Telemetry never leaves the estate. Compare Elastic's warning that assistant data is not anonymised, Gemini's VPC-SC limits, Grafana's Cloud backend, and the gaps for FedRAMP and gov sites.
- **Cost.** We charge no per-investigation or per-agent-hour fee. With cheap models, an investigation costs cents in model calls (README: $0.10 for a full 25-check SDLC case on GPT-6 Luna; ops costs not yet measured). AWS charges about $30 per agent-hour, and Azure about $290 per month always-on per agent at the example rate. Rows 1-3 (no model calls when quiet) would make continuous watching nearly free.
- **Auditable, provable approvals.** A gate and a unit test prove every change step is behind an approval edge and followed by verification. `audit.jsonl` cannot be edited by agents, and evals check from that log that no change came before an approval. Plans are applied only by sha256. Most vendors describe approvals in a sentence; Azure documents that emails and Teams posts are not gated, and several startups do not document approvals at all.
- **Credential handling.** The Key Vault has per-call permission decisions and declared vault names. Values are redacted at every chokepoint. Only the operator's inventory attaches credentials, and host keys are pinned. This matches or beats managed identity plus RBAC for on-prem and hybrid estates.
- **Evals with hidden checks on a real stack.** They are reproducible, and run with a scripted model they cost no model spend. Few vendors publish verifiable accuracy; most numbers are vendor claims. Publishing live-model results (row 30) would be a real differentiator against the trust problem the surveys describe.
- **Open, inspectable workflows** (JSON graphs, skills, agents) that customers can change: governed DevOps (`iac`/`k8s`/`deploy`) and AIOps in one harness, with sub-agents, scheduler, triggers and MCP.

**Weaker, honestly:**
- **No telemetry platform of our own.** We have no data gravity, no long-history baselines, no eBPF or agent-built topology, and no streaming detection. Telemetry owners (Datadog, Dynatrace, Grafana, Splunk) will always have richer context for their agents.
- **Integration breadth.** We have Prometheus, Loki, docker, ssh, probes and GitHub. AWS lists 12+ integrations, PagerDuty 700+, HolmesGPT about 40 toolsets. We have no ticketing, paging, Grafana, traces or cloud observability.
- **No correlation, dedup, anomaly detection or topology discovery.** These are classic AIOps table stakes; we skipped the "AIOps" layer and went straight to agents.
- **Unproven in production.** No real estate has been operated yet (HANDOFF item 6). There are only 3 aiops eval cases, scripted-model verified, with no live-model pass rates. Incumbents have thousands of customers and feedback loops (incident.io reports 1M+ incidents handled).
- **No learning loop.** We do not learn from responder feedback, accepted or rejected RCAs, or merged fixes (Cleric, Komodor Memory, Splunk PR feedback do).
- **Cost of the current watch design.** One agent run per round; see row 3.
- **No enterprise packaging:** no SOC 2 or FedRAMP, no operations console, no SLA. On-call teams need a pager-grade, highly available ingestion path, and our server would become one.
- **Cheap models have less headroom on novel failures.** The OpenRCA study says architecture matters more than model tier, which supports our gated design, but it also shows every tier hallucinates interpretation. Our mitigation must be structural: cited evidence, a refuter, verify gates.

---

## 12. Recommended roadmap

**Phase 0: sit inside the existing stack (P0, about 3-5 weeks).**
1. An alert ingestion endpoint (Alertmanager, Grafana Alerting, PagerDuty v3, Datadog, generic). Authenticate with the existing trigger-URL secrets, treat the payload as untrusted data, map to inventory services, and upsert incidents.
2. A deterministic grouper: fingerprint, labels, a time window, and `depends_on` and topology-aware merging, with a stored "why grouped" explanation. Add a model-free `ops-watch` mode where the server evaluates `ops_check` on a timer and starts `incident-response` (or a short triage agent) only for new or escalated groups. Keep the current LLM `ops-watch` as an option.
3. A change-event store, written by `deploy`, `k8s apply`/`rollout-undo`, `iac apply` and `ci` (plus git commits). Add a `changes` tool and have `incident-response`'s change step rank changes by time and dependency proximity.
4. Kubernetes in aiops: a `clusters` inventory kind with a vault kubeconfig from the operator inventory only, K8s health rules, a k8s evidence node, and runbooks for k8s restart, scale and rollback through the existing `k8s` tool and approvals.
5. An eval for each: an alert storm that must produce one incident, a bad deploy that must be named as the cause, and a CrashLoop.

**Phase 1: compete on the incident loop (P1, about 6-10 weeks).**
- A Slack/Teams incident thread with approve and deny that maps onto existing approval nodes, operator-restricted.
- PagerDuty/Opsgenie and Jira/ServiceNow write-back, natively or through governed MCP servers (vault names declared, `sendsOut`, taint guard).
- Grafana: annotations for incidents and changes, alert-rule reads, links.
- Tempo/Jaeger traces and a service graph merged with inventory and k8s, used for blast radius and RCA ordering.
- A statistical anomaly detector in `ops_check` (seasonal baseline or robust z-score on PromQL ranges) and log-pattern novelty.
- An RCA "refuter" node and required evidence citations with a confidence field. Similar-incident retrieval over past postmortems at triage.
- Declared "unattended-safe" runbooks with limits (count per hour, scope), enforced by the `runbook-safe` gate and operator allow rules.
- Read-only cloud observability (CloudWatch, Azure Monitor, GCP Monitoring; CloudTrail and Activity Log as change events). Postgres and MySQL diagnostic tools.
- Run the aiops evals on Haiku, DeepSeek Flash and Luna, publish pass rates and cost, and add cases from the first real-estate incidents.

**Phase 2: differentiate (P2).**
- Incident-to-fix-PR sub-workflow (SDLC pack).
- Expose aiops as an MCP server, and A2A with PagerDuty, AWS and Azure agents.
- Holt-Winters forecasting; cost from billing exports.
- More runbooks; an Elasticsearch/OpenSearch and CloudWatch Logs backend.
- An incident console in the web UI.
- Run public benchmarks (OpenRCA, SREGym) against our harness with cheap models, which builds the same trust argument against vendors' self-reported numbers.

**What not to build:** a telemetry store, a streaming engine, or our own paging and on-call scheduling. Integrate with Prometheus, Grafana and PagerDuty instead; the market shows agents complement these, not replace them.
