# Project Type Detection & Adaptation Track

## Step 0 Pre-Check: Architecture & Track Classification

This document records the formal codebase inspection and classification of `16-rate-limit-gateway`.

---

### Detection Evidence

A comprehensive inspection of the repository `/Users/avishjain/avishjain9-repos/16-rate-limit-gateway` was conducted:

| Artifact Checked | Findings / Content | Classification Evidence |
| :--- | :--- | :--- |
| **Directory Name** | `16-rate-limit-gateway` | Distributed multi-algorithm rate limiting API gateway. |
| **Monorepo Packages** | `packages/core/`, `packages/store-redis/`, `packages/oracle/`, `packages/security/` | TypeScript monorepo with Redis Lua atomic scripts and in-memory fallbacks. |
| **Gateway App** | `apps/gateway/src/main.ts`, `src/gateway/` | Node.js, Express 5, ioredis, fast-check, zod. |
| **Web Console** | `apps/web/` | React 19, Vite, Tailwind CSS, Recharts dashboard. |
| **Test Suite** | `tests/` (25 test suites) | Vitest integration test suite passing unit, property, and resilience tests. |

---

### Formal Classification
- **Primary Classification**: **Track A & C (Full Stack TypeScript & Distributed Systems Gateway)**
- **Sub-tracks**:
  - High-throughput API gateway middleware (Node.js, Express 5, Redis)
  - Algorithmic rate limiting engine (Token Bucket, Leaky Bucket, Sliding Window Counter, Sliding Window Log)
  - Real-time telemetry monitoring dashboard (React 19, Vite)

---

### Adaptation Rules for This Project
1. **Backend Focus**: Emphasize atomic Redis Lua script execution, memory leak prevention in sliding window data structures, route normalization, and graceful in-memory degradation under Redis partition.
2. **Algorithm Focus**: Detail the time and space complexity trade-offs between Token Bucket (low memory, burst-tolerant) vs Sliding Window Counter (accurate boundary limits) vs Sliding Window Log (zero boundary spikes, memory-heavy).
3. **Security Focus**: Map OWASP API Security Top 10: API4:2023 Unrestricted Resource Consumption, DoS mitigation, and header injection prevention.
