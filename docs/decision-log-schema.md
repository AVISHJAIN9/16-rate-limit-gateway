# RLGW Decision Log Schema (v1)

This specification defines the versioned JSON/NDJSON schema for rate-limiting decision logs. It serves as the primary forensic record and training dataset input for Phase P8 ML anomaly detection and abuse classification.

---

## 1. Schema Specification

Each log record is formatted as a single JSON line (NDJSON) matching this schema:

| Field | Type | Description |
|---|---|---|
| `version` | Integer (`1`) | Schema version indicator |
| `ts` | Integer (Epoch ms) | Timestamp when the rate limit decision occurred |
| `request_id` | String | Unique request trace ID (from `X-Request-Id` or generated UUID) |
| `trace_id` | String (optional) | Distributed OpenTelemetry trace ID (`W3C TraceContext`) |
| `tenant` | String | Authenticated or resolved tenant identifier |
| `client_id` | String | Client identifier (API key ID, user ID, or client IP) |
| `route` | String | Canonical URL path route |
| `policy_id` | String | Rate limit policy ID that evaluated the decision |
| `algorithm` | String | Algorithm name (`token_bucket`, `fixed_window`, `gcra`, etc.) |
| `cost` | Number | Cost units assessed for this request |
| `decision` | String (`allowed` \| `denied`) | Enforcement outcome |
| `reason` | String (optional) | Reason code if denied or modified (`limit`, `jail`, etc.) |
| `remaining` | Number | Remaining quota units after decision |
| `reset_ms` | Integer (Epoch ms) | Timestamp when the quota completely resets or refills |
| `latency_us` | Number | Decision evaluation latency in microseconds |

---

## 2. Example Record

```json
{
  "version": 1,
  "ts": 1730000000000,
  "request_id": "c1f7b8e2-04e2-45e6-993d-d1e9f4567890",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "tenant": "acme_corp",
  "client_id": "client_987",
  "route": "/v1/orders",
  "policy_id": "order_burst_limit",
  "algorithm": "token_bucket",
  "cost": 1,
  "decision": "denied",
  "reason": "limit",
  "remaining": 0,
  "reset_ms": 1730000001000,
  "latency_us": 45
}
```
