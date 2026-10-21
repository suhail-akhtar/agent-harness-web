---
name: ops-inventory
description: The ops inventory format (.harness/ops/inventory.yaml) - hosts with vault credentials, services with health URLs, metrics jobs, log sources and SLOs, environments, maintenance windows and alert rules. Use when writing or fixing an inventory, or before the AIOps tools exist in a session.
---
# The ops inventory

The AIOps tools (ops_inventory, prometheus_query, logs_search, probe, host_stats, docker_status, ssh_exec, service_control, ops_check, slo_status, capacity_forecast, incident, runbook) appear in sessions whose workspace has `.harness/ops/inventory.yaml` (or `.yml` / `.json`), or when the operator sets `HARNESS_OPS_INVENTORY`. After creating the file, start a new session to get them. Check it with `ops_inventory validate` or the `inventory-valid` gate.

The operator's file (HARNESS_OPS_INVENTORY) is trusted. When it exists, hosts and monitoring endpoints come only from it; the workspace file can add services, alerts, SLOs and maintenance windows (its services may run on the operator's hosts).

Credentials (`credential`, `prometheus_credential`, `loki_credential`) count only in the operator's file. In a workspace file they are ignored with a warning: a workspace may name a host or an endpoint, never a vault entry to send to it. So ssh (ssh_exec, host_stats, logs over ssh) and authenticated Prometheus/Loki need the operator's inventory. Every tool call that uses a credential is asked about (the vault permission rules, e.g. `vault(ops-web-1-key)`), and a call uses only the credentials attached to what it names: a workspace service on an operator host reaches it only when the call names the host (`logs_search` with `host` and `container` or `file`). Quality gates never use credentials.

**Least privilege: a read-only account per host.** In the operator's file a host can also name a read-only account: `readUser` (an OS user the operator restricted - no sudo, only read-only groups, no write access to the data) and `readCredential` (its vault name, `ops-*`). `ssh_exec` and `host_stats` then run as that account by default (`as: "reader"`): the host itself refuses its changes, so these calls are not asked about (they are still audited, their output is still untrusted, and the credential still goes through the vault rules). `ssh_exec` with `as: "operator"` uses `user` and `credential` and is asked about as before - for approved changes only. A workspace file cannot declare a reader (ignored with a warning): otherwise a repository could make commands run unasked. The operator makes sure the account really is read-only: no sudo, not in the data owner's group, no docker group (docker is root), and, where exfiltration from the host matters, restricted outbound network (a reader command that names a network client such as curl or ssh is still confirmed after untrusted content, but that is a hint, not a boundary).

A service may say what it needs with `depends_on` (host or service names: its database host, a shared volume's host) and free-text `notes`; investigations look there too.

An entry with an error is left out until it is fixed (its error is reported). The server's own Docker engine (`host: local` services, `docker_status` without a host) is off unless the operator sets `HARNESS_OPS_LOCAL_DOCKER=1` and lists the containers in `HARNESS_OPS_LOCAL_DOCKER_ALLOW`.

## Format

```yaml
monitoring:
  prometheus: http://prometheus.internal:9090   # or HARNESS_OPS_PROMETHEUS_URL
  loki: http://loki.internal:3100               # optional; else docker logs / files over ssh
  scrape_interval: 15s
  # prometheus_credential: ops-prometheus-token # optional bearer token, a vault name (operator's file only)

environments: [prod, staging]

hosts:
  - name: web-1                 # letters, digits, . _ - ; "local" is the harness's own machine
    address: 10.0.0.5           # what ssh connects to
    port: 22
    user: ops
    credential: ops-web-1-key   # a Key Vault name (ops-*): a private key or a password, never the value (operator's file only)
    readUser: ops-reader        # optional, operator's file only: a read-only OS account (no sudo, cannot write)
    readCredential: ops-web-1-reader-key  # its vault name; investigation runs as it without asking
    role: web
    env: prod
    tags: [web, linux]

services:
  - name: shop-api
    host: web-1                 # or local (the harness's Docker engine, when the operator allows the container)
    env: prod
    container: shop-api         # a docker container (logs, restarts), or
    # unit: shop-api.service    # a systemd unit on the host
    health: https://shop.example.com/healthz
    tls: https://shop.example.com            # or host:port; probed for expiry
    metrics_job: shop-api       # the Prometheus job label
    logs: { docker: shop-api }  # or { loki: '{app="shop-api"}' } or { file: /var/log/shop/api.log }
    owner: team-shop
    depends_on: [db-1]          # optional: hosts or services it needs (where to look when it is slow)
    notes: "orders database on db-1 (Postgres 16, port 5432)"
    slos:
      - name: availability
        objective: 99.9         # percent
        window: 30d
        errors: sum(rate(http_requests_total{job="shop-api",code=~"5.."}[{{window}}]))
        total: sum(rate(http_requests_total{job="shop-api"}[{{window}}]))

maintenance:
  - name: weekly-prod
    env: prod                   # or hosts: [web-1] / services: [shop-api]
    cron: "0 2 * * 0"           # starts (server time), five fields
    duration: 2h
  # - name: one-off
  #   start: 2026-11-01T22:00:00Z
  #   end: 2026-11-02T01:00:00Z

alerts:
  - name: ShopApiLatencyHigh
    expr: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="shop-api"}[5m]))) > 0.5
    for: 5m
    severity: critical          # critical | warning | info
    service: shop-api
    summary: p95 latency over 500 ms
  - name: ShopHomepage
    probe: { type: http, url: https://shop.example.com/, expect_status: 200 }
    severity: critical
  - name: ShopApiErrors
    logs: { service: shop-api, pattern: "ERROR|Exception", window: 5m, threshold: 10 }
    severity: warning
```

## Rules the validator applies
- Names are unique per kind; every `host`, `service` and `env` reference exists.
- URLs are http(s); durations look like `30s`, `5m`, `2h`, `30d`; cron has five fields.
- `credential` is a vault name the plugin may read (`ops-*`), in the operator's file. Values never go in the inventory or the workspace.
- `readUser` and `readCredential` come together, in the operator's file, with a valid user name and an `ops-*` vault name; a `readUser` equal to `user` is no read-only account (warned and ignored).
- `depends_on` names hosts or services (an unknown name is a warning).
- User names, addresses, container and unit names and log file paths are checked strictly (no leading `-`, no spaces or shell characters).
- An alert has exactly one of `expr`, `probe`, `logs`; PromQL is parsed by Prometheus in the `alerts-valid` gate.
- Implicit alerts: every service `health` URL must answer (critical) and every `tls` endpoint must have 21+ days left (warning) - ops_check evaluates them without a rule.
- A service with neither `health` nor `metrics_job` is reported: nothing would notice it failing.
