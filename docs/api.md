# RLGW API Reference

This document details the public data-plane and control-plane endpoints exposed by the Rate-Limit Gateway.

---

## 1. Data Plane Listener (Default Port: 8080)

All application traffic routes through the data-plane listener.

| Method | Path Pattern | Description | Headers & Semantics |
|---|---|---|---|
| `ANY` | `/*` (routes matching `upstreams`) | Reverse-proxied upstream request subject to rate limiting policies | **Headers In:** `X-Request-Id`, `X-Client-Id`, `X-Tenant-Id`, `Cost`<br>**Headers Out:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-Policy`, `X-RateLimit-*`, `X-Request-Id`, `Via` |
| `ANY` | Any rate-limited path | Denied when budget is exhausted | Returns **HTTP 429 Too Many Requests** with `Retry-After: <seconds>`, `Cache-Control: no-store`, and structured JSON or Problem+JSON body |
| `GET` | Upstream timeout | Triggered when upstream exceeds deadline | Returns **HTTP 504 Gateway Timeout** |
| `GET` | Upstream connection failure | Triggered on connection refused or reset | Returns **HTTP 502 Bad Gateway** |
| `UPGRADE` | `/*` | WebSocket / HTTP upgrade connection | Bi-directional streaming pipe with hop-by-hop handling |

---

## 2. Admin Plane Listener (Default Port: 8081)

All health probes, metrics, and administration APIs route through the admin-plane listener.

| Method | Path | Auth Required | Description | Status Codes |
|---|---|---|---|---|
| `GET` | `/healthz` | No | Process liveness & event loop lag probe (`monitorEventLoopDelay`) | `200 OK` (healthy), `503 Service Unavailable` (stalled loop) |
| `GET` | `/readyz` | No | Gateway readiness probe; returns 503 during graceful shutdown | `200 OK` (ready), `503 Service Unavailable` (draining/not ready) |
| `GET` | `/metrics` | No | Prometheus text exposition format metrics | `200 OK` (`text/plain; version=0.0.4`) |
| `GET` | `/admin/v1/snapshot` | Yes (Admin Token) | Returns active policy snapshot metadata and content hash | `200 OK`, `401 Unauthorized` |
| `POST` | `/admin/v1/reload` | Yes (Admin Token) | Triggers atomic reload of policies from storage | `200 OK`, `401 Unauthorized`, `500 Server Error` |
| `GET` | `/admin/v1/policies` | Yes (Admin Token) | Lists active policies with tenant filtering and ETag caching | `200 OK`, `304 Not Modified`, `401 Unauthorized` |
| `GET` | `/admin/v1/policies/:id` | Yes (Admin Token) | Fetches detail of an individual rate limiting policy | `200 OK`, `404 Not Found`, `401 Unauthorized` |
| `GET` | `/admin/v1/policies/:id/diff` | Yes (Admin Token) | Semantic field-level diff between policy versions with inheritance provenance | `200 OK`, `401 Unauthorized` |
| `GET` | `/admin/v1/counters?key=<key>`| Yes (Admin Token) | Store introspection: evaluates current budget via `peek` (strict tenant scope) | `200 OK`, `400 Bad Request`, `401 Unauthorized` |
| `GET` | `/admin/v1/upstreams` | Yes (Admin Token) | Circuit breaker and route health statuses | `200 OK`, `401 Unauthorized` |
| `POST` | `/admin/v1/evaluate` | Yes (Admin Token) | Semantic dry-run simulation against virtual clock & isolated in-memory store | `200 OK`, `401 Unauthorized` |
| `POST` | `/admin/v1/validate` | Yes (Admin Token) | Policy syntax & schema validation against Zod schema | `200 OK`, `400 Bad Request`, `401 Unauthorized` |
| `POST` | `/admin/v1/quotas/import` | Yes (Admin Token) | Bulk import tenant quotas with validation report | `200 OK`, `400 Bad Request`, `401 Unauthorized` |
| `GET` | `/admin/v1/quotas/export` | Yes (Admin Token) | Bulk export tenant quotas as JSON or CSV | `200 OK`, `401 Unauthorized` |
| `POST` | `/admin/v1/overrides` | Yes (Admin Token) | Dynamic quota override with TTL and relaxation guardrails | `200 OK`, `401 Unauthorized` |
| `POST` | `/admin/v1/allowlist` | Yes (Admin Token) | Temporary emergency allowlist with required reason and auto-expiry | `200 OK`, `400 Bad Request`, `401 Unauthorized` |
| `POST` | `/admin/v1/blacklist` | Yes (Admin Token) | Dynamic client/CIDR blacklist with pubsub propagation | `200 OK`, `401 Unauthorized` |
| `POST` | `/admin/v1/loglevel` | Yes (Admin Token) | Runtime log-level adjustment with auto-revert timer | `200 OK`, `401 Unauthorized` |
| `POST` | `/admin/v1/approvals` | Yes (Admin Token) | Propose policy change under two-person approval workflow | `200 OK`, `401 Unauthorized` |
| `PUT` | `/admin/v1/approvals/:id` | Yes (Admin Token) | Approve pending policy change (enforces distinct proposer/approver) | `200 OK`, `403 Forbidden`, `401 Unauthorized` |
