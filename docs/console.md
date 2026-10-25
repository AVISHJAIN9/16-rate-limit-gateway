# RLGW Admin Console — Feature & Screen Map

This document cross-references user interface panels and features to their canonical specifications in `STATUS.md`.

---

## 1. Feature Screen Mapping

| Screen / Component | Feature ID | Canonical Description |
|---|---|---|
| **Mission Control Dashboard Shell** | `F136` | Overview stat cards (req/s, 429 rejection ratio, circuit breaker health, snapshot generation), live refresh toggle |
| **Throughput Sparkline** | `F137` | Real-time SVG throughput sparkline with fixed-memory client ring buffer |
| **Quota Consumption Heatmap** | `F138` | Interactive policy × time matrix with keyboard navigation and accessible tooltips |
| **Throttled Request Live Feed** | `F139` | Live stream table showing real-time 429 rejections, client identities, reasons, and Retry-After headers |
| **Policy Simulation Sandbox** | `F140` | Interactive scenario simulator allowing operators to test policies against synthetic burst requests |
| **Policy Editor & Linter Modal** | `F141` | Schema-driven modal form with inline validation, audit reason requirement, and syntax guardrails |
| **Redis Cluster Health Topology** | `F142` | SVG diagram detailing master/replica nodes, slot distributions, and health statuses |
| **Latency Quantile Gauges** | `F143` | Gauges rendering p50, p90, p99, and p99.9 latency against target SLOs |
| **Active Policy Catalog** | `X8` | Policy search, tenant filtering, and active version management |
| **Algorithm Visual Explainer** | `X12` | Interactive visualizer demonstrating Token Bucket, Leaky Bucket, Fixed Window, and GCRA using `@rlgw/core` |
