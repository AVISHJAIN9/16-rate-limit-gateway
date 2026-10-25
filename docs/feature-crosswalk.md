# Feature Crosswalk & Numbering Reconciliation

This document reconciles historical prompt set feature numbering (Sets 4, 6, 7, 8, 9) with the canonical ULTIMATE 150-table in `STATUS.md`.
All features from earlier sets that do not have a dedicated 1-150 row are tracked as extension items **X1–X12** so no functionality is lost.

---

## 1. Primary Mapping Table

| Historical Range / Concept | Canonical Range in `STATUS.md` | Primary Components / Packages |
|---|---|---|
| **Set 1 / Core Spec (F1–F15)** | **F1–F15** (Identity, KeyBuilder, Scope Keyers, IP Normalization, API Keys) | `packages/core/src/identity`, `packages/security` |
| **Set 2 / Algorithms (F16–F30)** | **F16–F30** (Token Bucket, Leaky, Fixed, Sliding Log, Sliding Counter, GCRA, Burst, Clocks) | `packages/core/src/algorithms`, `packages/core/src/clock.ts`, `packages/store-memory` |
| **Set 5 / Redis (F31–F45)** | **F31–F45** (Redis single-node, Sentinel, Cluster hash-tags, Atomic Lua, Pipelines, Trimming, Hot-keys) | `packages/store-redis` |
| **Set 3 / Policy Engine (F46–F60)** | **F46–F60** (Durable File Store, WAL/Snapshot, Rollback, Inheritance, Overrides, Radix, Priority, Isolation) | `packages/core/src/policy`, `packages/control-plane` |
| **Set 4 / Gateway & Backend (F61–F75)** | **F61–F75** (HTTP Gateway, Reverse Proxy, Load Balancing, Circuit Breakers, Streaming, Headers) | `apps/gateway` |
| **Set 6 / Security (F106–F120)** | **F76–F90, F114, F119, F120** + **X1–X3** | `packages/security`, `apps/gateway` |
| **Set 8 / Resilience & Perf (F121–F135)**| **F91–F105** + P4/P5 proof suite | `apps/gateway`, `packages/testutil`, `loadtest/` |
| **Set 3 / Admin & Config (F106–F120)** | **F106–F120** (Hot-reload, FS Watcher, Overrides, Policy CRUD, Dry-Run, Export, Diff) | `packages/control-plane`, `apps/gateway` |
| **Set 7 / Observability (F91–F105)** | **F121–F135** + **X4–X7** (Prometheus, OTel Tracing, Pino, Decision Logs, Metrics Server) | `packages/obs`, `apps/gateway` |
| **Set 9 / Console (F76–F90)** | **F136–F143** + **X8–X12** (React 18 Admin Console, Vite, Topology, Diff, Visual Explainer) | `apps/web` |
| **AI / ML Tiers (F144–F150)** | **F144–F150** (Anomaly Dataset, Isolation Forest, Heuristic vs ML, Realtime Worker, LLM Explainer) | `packages/ml` |

---

## 2. Granular Crosswalk for Reordered Sets

### Set 6 (Security) → Canonical
- Set 6 F106 (Constant-time secret key verification) $\to$ **Canonical F76**
- Set 6 F107 (HMAC API signature authentication) $\to$ **Canonical F77**
- Set 6 F108 (JWT validation and claims extraction) $\to$ **Canonical F78**
- Set 6 F109 (mTLS client certificate validation) $\to$ **Canonical F79**
- Set 6 F110 (Trusted proxy and CIDR hop verification) $\to$ **Canonical F80**
- Set 6 F111 (Automated IP ban and jail manager) $\to$ **Canonical F81**
- Set 6 F112 (Path traversal and injection sanitizer) $\to$ **Canonical F82**
- Set 6 F113 (Replay attack timestamp windows) $\to$ **Canonical F83**
- Set 6 F114 (Admin API key authentication) $\to$ **Canonical F114**
- Set 6 F115 (Volumetric DDoS surge detector) $\to$ **Canonical F84**
- Set 6 F116 (Slowloris connection timeout guards) $\to$ **Canonical F85**
- Set 6 F117 (CORS origin policy validation) $\to$ **Canonical F86**
- Set 6 F118 (Sensitive header masking and scrubbing) $\to$ **Canonical F87**
- Set 6 F119 (Emergency temporary allowlist API) $\to$ **Canonical F119**
- Set 6 F120 (Dynamic client blacklist API) $\to$ **Canonical F120**

### Set 7 (Observability) → Canonical
- Set 7 F91–F105 $\to$ **Canonical F121–F135**:
  - F91 Decision counters $\to$ **F121**
  - F92 Decision latency histogram $\to$ **F122**
  - F93 Dropped-request metric streams $\to$ **F123**
  - F94 Store operation latency $\to$ **F124**
  - F95 OpenTelemetry distributed tracing $\to$ **F125**
  - F96 Structured JSON logging (`pino`) $\to$ **F126**
  - F97 Throttled reason codes $\to$ **F127**
  - F98 Per-tenant quota consumption gauges $\to$ **F128**
  - F99 Hot-key frequency telemetry $\to$ **F129**
  - F100 Gateway resource gauges (heap, event-loop, handles) $\to$ **F130**
  - F101 Redis connection pool saturation metrics $\to$ **F131**
  - F102 Upstream error rate histograms $\to$ **F132**
  - F103 Circuit breaker state transition logs $\to$ **F133**
  - F104 Telemetry sample-rate governor $\to$ **F134**
  - F105 Prometheus exposition endpoint (`/metrics`) $\to$ **F135**

### Set 8 (Reliability & Performance) → Canonical
- Set 8 F121–F135 $\to$ **Canonical F91–F105**:
  - F121 Fail-open execution $\to$ **F91**
  - F122 Fail-closed execution $\to$ **F92**
  - F123 Degrade-local approximate engine $\to$ **F93**
  - F124 Store circuit breaker trip & reset $\to$ **F94**
  - F125 Exponential backoff store reconnect $\to$ **F95**
  - F126 Upstream request retries with jitter $\to$ **F96**
  - F127 Deadlock-free concurrency locking $\to$ **F97**
  - F128 Memory bounds & drop overflow $\to$ **F98**
  - F129 CPU starvation worker shedding $\to$ **F99**
  - F130 Async resource leak prevention (goroutine leak equivalent) $\to$ **F100**
  - F131 Cancellation propagation via `AbortSignal` $\to$ **F101**
  - F132 Upstream outlier ejection $\to$ **F102**
  - F133 Bulkhead tenant/upstream isolation $\to$ **F103**
  - F134 Overload load shedding (adaptive AIMD) $\to$ **F104**
  - F135 Fast diagnostic crash logging $\to$ **F105**

### Set 9 (Console & Web UI) → Canonical
- Set 9 F76–F83 $\to$ **Canonical F136–F143**:
  - F76 Dashboard shell & cards $\to$ **F136**
  - F77 Real-time SVG throughput sparkline $\to$ **F137**
  - F78 Quota-consumption heatmap $\to$ **F138**
  - F79 Throttled-request live feed (SSE) $\to$ **F139**
  - F80 Policy simulation sandbox (`/evaluate`) $\to$ **F140**
  - F81 Admin policy editor & linter modal $\to$ **F141**
  - F82 Redis cluster topology SVG $\to$ **F142**
  - F83 Latency quantile gauges $\to$ **F143**

---

## 3. Extension Items (X1–X12)
These items from historical sets are built as explicit extensions:
- **X1**: RBAC (viewer, operator, policy-admin, tenant-admin, super-admin) with permission tables and failed-auth rate limiting.
- **X2**: Two-person policy change approval workflow with pending state and expiry.
- **X3**: Multi-dimensional Allow/Denylist (CIDR, key, client, tenant) evaluated before counter increments.
- **X4**: Ring-buffered high-throughput Decision Logs with NDJSON streaming.
- **X5**: In-memory fixed-memory time-series rollup history store (5s x 1h, 1m x 24h).
- **X6**: Dedicated `/admin/v1/analytics/*` endpoints for utilization and 429 breakdowns.
- **X7**: Prometheus alerts rule definitions (`deploy/prometheus/alerts.yml`) & Grafana dashboard JSON.
- **X8**: Policy management console list with faceted search, pagination, and bulk toggle.
- **X9**: Semantic diff and inheritance provenance visualization UI.
- **X10**: Effective policy inspection and live key lookup view.
- **X11**: Advanced analytics charts with period-over-period trend analysis.
- **X12**: Algorithm visual explainer with animated interactive kernel simulations.
