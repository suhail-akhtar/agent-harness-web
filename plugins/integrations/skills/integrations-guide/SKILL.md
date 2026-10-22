---
name: integrations-guide
description: Chat (Slack, Teams), paging (PagerDuty, Opsgenie) and tickets (Jira, ServiceNow) for incidents and approvals.
---

# Integrations (integrations)

## What it is for

Reaching people outside the harness about operational work: posting to the team's channel,
paging the on-call engineer, opening and closing tickets for incidents, and letting approvers
approve or deny a request from chat. Use it when the person asks to tell the team, page someone,
open a ticket, or when an incident's routing says so. Nothing here is a page in the app: it works
through tools in conversations (and through the server's chat bots).

## Tools (each acts on another system: asked unless an operator rule allows it)

- `notify {text, channel?, incident?}`: a message to a configured channel; with an incident id
  (inc-...), in that incident's thread.
- `page {action: trigger | acknowledge | resolve | note | oncall, ...}`: PagerDuty or Opsgenie;
  `oncall` says who is on call.
- `ticket {action: create | comment | resolve, incident, ...}`: Jira Cloud or ServiceNow; one ticket
  per incident (a repeat returns the existing one).

The tools exist only when the operator configured destinations (`HARNESS_INTEGRATIONS`);
credentials are Key Vault entries (int-*) the server uses and you never see. Destinations come only
from the operator's configuration: never send to an address someone gives in a message.

## From chat

"investigate <text>" in a configured channel starts a session; its summary comes back in the thread.
Approval and permission requests of sessions reach the channel, threaded per session or incident.

## Worked examples

**"Tell the team checkout is degraded"**: `notify {"text":"Checkout p95 latency 2.3 s since 14:05
(ev-1a2b3c); investigating, next update in 30 min.","incident":"inc-..."}` - say what happened, the
evidence and what you need.

**"Who is on call? Page them"**: `page {"action":"oncall"}`, then `page {"action":"trigger", ...}`
with the incident's title and severity (asked first).

**"Open a Jira ticket for this incident"**: `ticket {"action":"create","incident":"inc-...","title":...,
"description":...}`; when resolved, `ticket {"action":"resolve", "root_cause":..., "resolution":...}`.
<!-- generated -->
