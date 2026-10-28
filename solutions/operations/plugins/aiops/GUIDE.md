---
name: aiops-guide
description: Operations: alerts, incidents with evidence, root cause and postmortems, SLOs, monitoring, safe runbooks.
---

# Operations (aiops)

## What it is for

On-call and operations work on the hosts and services the ops inventory names: what is firing,
why, what changed, how much error budget is left, and what to do about it - with every claim tied
to evidence the harness recorded. Use it when the person mentions an alert, an outage, an incident,
latency or errors, an SLO, a deploy that went wrong, a host or a container, or asks for a
postmortem, a runbook or the state of their services.

Its tools appear in sessions whose workspace has `.harness/ops/inventory.yaml` (or when the
operator sets `HARNESS_OPS_INVENTORY`). The pages work without them: they read the server's alert
incidents and inventory.

## How work runs

- **Look before acting** (read-only, no approval): `alerts` (incidents the server opened from
  alerts), `ops_check`, `slo_status`, `prometheus_query`, `logs_search`, `traces`, `topology`,
  `change_timeline`, `anomalies`, `probe`, `host_stats`, `docker_status`, the `k8s_*` reads,
  `grafana`, `similar_incidents`. Each read gets an evidence id ("ev-xxxxxx"): cite it.
- **Record**: `incident` (open, update, timeline, resolve, postmortem), `evidence` (the ledger).
- **Change** (always asked about): `service_control`, `ssh_exec` as operator, `k8s_control`, a
  `runbook` run. Only for an approved runbook step; never on a hunch.
- **Workflows**: `incident-response` (and `-k8s`): evidence, root cause with confidence, an
  independent refuter, a runbook; `ops-advisor`; `ops-watch`; the `runbook-*` workflows.
- **Agents**: sre, refuter, capacity-planner, cost-optimizer, security-auditor.
- **Skills**: aiops-triage, kubernetes-triage, promql, ops-inventory, runbook-writing, postmortem.

## Pages and navigation

- Home: `desktop_open {"target":"view","id":"aiops"}`: on-call summary (open incidents, firing
  alerts, SLO error budgets, service health) and quick actions.
- Incidents: `aiops:incidents` (open and recent; params `{"id":"alr-..."|"inc-..."}` opens one with
  its timeline, evidence, root cause, refuter verdict, runbook and postmortem).
- Alerts: `aiops:alerts` (firing, grouped by service). Services: `aiops:services` (health and
  SLOs). Topology: `aiops:topology`. Changes: `aiops:changes` (deploys, applies, restarts...).
- Incident panel next to an investigation: `desktop_open {"target":"panel","id":"aiops:incident"}`.

## Commands you may run

- `desktop_command {"command":"aiops:open-incident","args":{"id":"alr-..."}}` shows an incident.
- `desktop_command {"command":"aiops:run-ops-check"}` evaluates every alert rule now and tells the
  person how many fire (no model, no credentials).

## Worked examples

**"What can Operations do, and show me the incidents"**: summarise from this guide (look, record,
change with approval; the pages), then `desktop_open {"target":"view","id":"aiops:incidents"}`.

**"Checkout is slow since the deploy"**: `change_timeline` around the time, `slo_status` and
`prometheus_query` for latency, `logs_search` for errors, `traces` for slow spans; open an incident
(`incident` open, sev by user impact) citing evidence ids; propose a runbook step and wait for the
person before any change.

**"Is anything firing?"**: `alerts {"action":"list"}` or `ops_check`; then open `aiops:alerts`.

**"Write the postmortem for inc-1234"**: load the postmortem skill, read the incident and its
evidence, `incident` postmortem; open it with `aiops:open-incident`.
<!-- generated -->
