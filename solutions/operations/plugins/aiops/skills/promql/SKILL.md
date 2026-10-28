---
name: promql
description: PromQL patterns and pitfalls - rate/irate/increase, aggregation order, histograms, missing data, gauges, node-exporter queries and multi-window multi-burn-rate SLO alerts. Use when writing queries for prometheus_query, alert rules or capacity_forecast.
---
# PromQL

## Counters
- `rate(x[5m])` - per-second average over the window. Use for alerts, dashboards, ratios.
- `irate(x[5m])` - last two samples only. Spiky; use only for fast-moving graphs, never in alerts.
- `increase(x[1h])` - total increase over the window (rate times window). Extrapolated, so it can be fractional.
- `rate`, `irate`, `increase`, `resets` only on counters (`_total`, `_count`, `_sum`, `_bucket`). On a gauge they return nonsense; use `deriv` or `delta`.
- Counter resets (process restart) are handled by `rate`/`increase`. `resets(x[1h])` counts them - a quick restart detector.
- Window at least 4x the scrape interval (15s scrape -> `[1m]` minimum, `[5m]` is the safe default). Too short a window returns no data when a scrape is missed.

## Aggregation order
Rate first, then sum: `sum by (service) (rate(http_requests_total[5m]))`.
Never `rate(sum(...))` - summing first hides counter resets and is not valid on an instant vector anyway.
Always say what to keep: `sum by (service, route)`. A bare `sum()` drops every label.

## Error ratios
```
sum by (service) (rate(http_requests_total{status=~"5.."}[5m]))
/
sum by (service) (rate(http_requests_total[5m]))
```
- Both sides aggregated by the same labels, or the division matches nothing.
- No traffic gives 0/0 = NaN or no result; an alert on the ratio then never fires. Guard with `and sum by (service) (rate(http_requests_total[5m])) > 0.1` or alert separately on low traffic.
- Division by zero in a gauge ratio: `x / (y > 0)` drops the series instead of returning +Inf.

## Histograms
`histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))`
- Keep `le` in the `by` clause or the result is empty/garbage.
- Never average quantiles: `avg(histogram_quantile(...))` per instance is not the fleet p95. Aggregate the buckets, then take the quantile.
- Accuracy depends on bucket boundaries; a p99 above the highest finite bucket returns that bucket's bound.
- Mean latency: `sum(rate(x_sum[5m])) / sum(rate(x_count[5m]))`.

## Missing targets and data
- `up == 0` - target scraped but down. Alert on it with `for: 2m`.
- `absent(up{job="api"})` - the job has disappeared entirely (no series at all). `up == 0` cannot catch that.
- `absent_over_time(x[10m])` - a metric stopped being reported.
- Staleness: a series is used for up to 5 minutes after its last sample (lookback delta). A dead exporter can look alive for 5 minutes; series that vanish are marked stale immediately.

## Alert rules
- `for: 5m` - condition must hold on every evaluation for 5 minutes before firing. Too short pages on blips; too long delays detection. Burn-rate alerts use short `for` (1-2m) because the windows already smooth.
- Use recording rules for expensive or repeated expressions: `record: job:http_errors:ratio_rate5m`. Naming: `level:metric:operations`.
- Severity in labels (`severity: page|ticket`), explanation in annotations.

## Cardinality
- Each unique label combination is a series. Never label by user ID, request ID, full URL, timestamp or error message.
- Find heavy metrics: `topk(10, count by (__name__) ({__name__=~".+"}))` (expensive; run rarely).
- In queries, `topk(5, ...)` keeps results readable: `topk(5, sum by (route) (rate(http_requests_total[5m])))`.

## Comparisons and trends
- Week-over-week: `sum(rate(http_requests_total[5m])) / sum(rate(http_requests_total[5m] offset 1w))`.
- Gauges: `deriv(node_filesystem_avail_bytes[6h])` (per-second slope), `predict_linear(node_filesystem_avail_bytes[6h], 4*3600) < 0` (full within 4h). For longer horizons and a fit-quality check use `capacity_forecast`.
- `delta(gauge[1h])` - change of a gauge over the window.

## Range queries
- Step: keep the result under about 300 points per series. 24h at `step=5m` = 288 points; 7d at `step=30m` = 336; 30d at `step=2h` = 360.
- Rate window at least the step, so no samples fall between steps: 7d at step 30m -> `rate(x[30m])`.
- `prometheus_query` summarises per series (min/max/avg/last, top-N); ask for a narrow label set rather than everything.

## node-exporter
- CPU busy: `1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))`
- CPU by mode: `sum by (mode) (rate(node_cpu_seconds_total{instance="h1:9100"}[5m]))` (high `iowait` -> disk, high `steal` -> noisy neighbour)
- Load per core: `node_load5 / count by (instance) (node_cpu_seconds_total{mode="idle"})`
- Memory available ratio: `node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes`
- Filesystem free ratio:
  `node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs",mountpoint!~"/run.*"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs",mountpoint!~"/run.*"}`
- Inodes: `node_filesystem_files_free / node_filesystem_files`
- Network: `rate(node_network_receive_bytes_total{device!~"lo|veth.*|docker.*"}[5m])`

## SLO burn-rate alerts
Error budget = 1 - SLO. For 99.9% over 30 days: budget 0.1% = 43.2 minutes of full outage, or 0.1% of requests.
Burn rate = observed error ratio / budget. Burn rate 1 spends exactly the budget in 30 days; 14.4 spends it in about 2 days.
Budget spent by an alert window = burn rate x window / period: 14.4 x 1h / 720h = 2%; 6 x 6h / 720h = 5%.

Multi-window, multi-burn-rate (long window detects, short window confirms it is still happening, so the alert resets fast):
```
# page: 2% of budget in 1h
(
  job:http_errors:ratio_rate1h{job="api"} > (14.4 * 0.001)
and
  job:http_errors:ratio_rate5m{job="api"} > (14.4 * 0.001)
)
or
# page: 5% of budget in 6h
(
  job:http_errors:ratio_rate6h{job="api"} > (6 * 0.001)
and
  job:http_errors:ratio_rate30m{job="api"} > (6 * 0.001)
)
```
Each `ratio_rateW` is the error ratio query above with window W, as a recording rule. Typical ticket tiers: 3x over 1d and 2h, 1x over 3d and 6h. `slo_status` computes budget remaining and burn rates for configured SLOs.

## Common mistakes
- `rate()` on a gauge; `sum` before `rate`; quantile without `le`; averaging percentiles.
- Ratio with mismatched labels on each side (use `on(...)`/`ignoring(...)` or aggregate both sides the same way).
- `[1m]` window with a 30s scrape - gaps and no data.
- Alert on a ratio that is NaN at low traffic and so never fires.
- Regex `=~"5.."` is anchored; `=~"5"` matches only the literal "5".
