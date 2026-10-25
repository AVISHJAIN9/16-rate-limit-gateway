# RLGW Observability & Metrics Catalog

This document details all Prometheus metric series, log schemas, and distributed trace semantics emitted by the RLGW gateway.

---

## 1. Prometheus Metrics Catalog

| Metric Name | Type | Labels | Description |
|---|---|---|---|
| `rlgw_decisions_total` | Counter | `tenant`, `policy_id`, `decision`, `reason` | Total rate limit decisions evaluated by the gateway (`allowed` or `denied`) |
| `rlgw_decision_duration_seconds` | Histogram | `algorithm`, `decision` | Decision latency in seconds with sub-millisecond exponential buckets |
| `rlgw_dropped_requests_total` | Counter | `reason` | Total requests dropped due to queue overflow, load shedding, or circuit breaking |
| `rlgw_store_operation_duration_seconds`| Histogram | `backend`, `operation` | Latency of store backend operations (`peek`, `commit`, `refund`, `decide`) |
| `rlgw_redis_command_duration_seconds` | Histogram | `command`, `status` | Redis execution duration per command or Lua script (`ok` vs `error`) |
| `rlgw_circuit_breaker_state` | Gauge | `upstream_id` | Current circuit breaker state: `0` (closed), `1` (half_open), `2` (open) |
| `rlgw_pipeline_stage_duration_seconds` | Histogram | `stage` | Latency of internal pipeline stages (`normalize`, `identity`, `policy_match`) |
| `rlgw_gateway_info` | Gauge | `version`, `node_version` | Constant metadata gauge reporting active software release |
| `rlgw_metrics_series_dropped_total` | Gauge | — | Total cardinality overflow series grouped into fallback `other` label bucket |

---

## 2. Cardinality Protection Strategy

To prevent metric cardinality explosions from arbitrary high-cardinality client IDs or spoofed IPs:
1. Metric labels only use validated tenant IDs, policy IDs, and standard reason codes.
2. Route labels only use template route paths (e.g. `/users/:id`), never raw URLs with IDs.
3. If active series combinations exceed the configured `maxSeriesPerFamily` budget (default: 1,000), labels are automatically grouped into `'other'` and `rlgw_metrics_series_dropped_total` is incremented.
