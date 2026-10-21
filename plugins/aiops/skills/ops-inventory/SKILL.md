---
name: ops-inventory
description: The ops inventory format (.harness/ops/inventory.yaml) - hosts with vault credentials, services with health URLs, metrics jobs, log sources and SLOs, environments, maintenance windows and alert rules. Use when writing or fixing an inventory, or before the AIOps tools exist in a session.
---
# The ops inventory

The AIOps tools (ops_inventory, prometheus_query, logs_search, probe, host_stats, docker_status, ssh_exec, service_control, ops_check, slo_status, capacity_forecast, incident, runbook) appear in sessions whose workspace has `.harness/ops/inventory.yaml` (or `.yml` / `.json`), or when the operator sets `HARNESS_OPS_INVENTORY`. After creating the file, start a new session to get them. Check it with `ops_inventory validate` or the `inventory-valid` gate.

The operator's file (HARNESS_OPS_INVENTORY) is trusted. When it exists, hosts and monitoring endpoints come only from it; the workspace file can add services, alerts, SLOs and maintenance windows.

## Format

```yaml
monitoring:
  prometheus: http://prometheus.internal:9090   # or HARNESS_OPS_PROMETHEUS_URL
  loki: http://loki.internal:3100               # optional; else docker logs / files over ssh
  scrape_interval: 15s
  # prometheus_credential: ops-prometheus-token # optional bearer token, a vault name

environments: [prod, staging]

hosts:
  - name: web-1                 # letters, digits, . _ - ; "local" is the harness's own machine
    address: 10.0.0.5           # what ssh connects to
    port: 22
    user: ops
    credential: ops-web-1-key   # a Key Vault name (ops-*): a private key or a password, never the value
    role: web
    env: prod
    tags: [web, linux]

services:
  - name: shop-api
    host: web-1                 # or local (the harness's Docker engine)
    env: prod
    container: shop-api         # a docker container (logs, restarts), or
    # unit: shop-api.service    # a systemd unit on the host
    health: https://shop.example.com/healthz
    tls: https://shop.example.com            # or host:port; probed for expiry
    metrics_job: shop-api       # the Prometheus job label
    logs: { docker: shop-api }  # or { loki: '{app="shop-api"}' } or { file: /var/log/shop/api.log }
    owner: team-shop
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
- `credential` is a vault name the plugin may read (`ops-*`). Values never go in the inventory or the workspace.
- An alert has exactly one of `expr`, `probe`, `logs`; PromQL is parsed by Prometheus in the `alerts-valid` gate.
- Implicit alerts: every service `health` URL must answer (critical) and every `tls` endpoint must have 21+ days left (warning) - ops_check evaluates them without a rule.
- A service with neither `health` nor `metrics_job` is reported: nothing would notice it failing.
