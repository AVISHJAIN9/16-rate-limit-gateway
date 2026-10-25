# Rate-Limit Gateway — ULTIMATE 150 (rlgw)

[![CI](https://github.com/AVISHJAIN9/rate-limit-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/AVISHJAIN9/rate-limit-gateway/actions/workflows/ci.yml)
[![Go Report Card](https://goreportcard.com/badge/github.com/AVISHJAIN9/rate-limit-gateway)](https://goreportcard.com/report/github.com/AVISHJAIN9/rate-limit-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Industrial-grade, high-throughput Distributed Rate-Limiting API Gateway built in **Go 1.22+** with Redis 7 cluster-aware data planes, zero-allocation hot paths, monotonic injectable clocks, and mathematically rigorous admission control.

---

## 1. System Architecture Diagram

```
                             [ CLIENT TRAFFIC ]
                                     |
                                     v
                 +---------------------------------------+
                 |       rlgw Ingress HTTP Listener      |
                 |          (port :8080 by default)      |
                 +---------------------------------------+
                                     |
                                     v
                 +---------------------------------------+
                 |       Request Identity Resolver       |
                 |  Stage 1: Header API Key (rlk_...)    |
                 |  Stage 2: JWT Claims Extraction (S6)  |
                 |  Stage 3: mTLS Client Cert (S6)       |
                 |  Stage 4: IP Fallback (RemoteAddr)    |
                 |     (IPv4/IPv6 /64 Normalized)        |
                 +---------------------------------------+
                                     |
                                     | Identity (Tenant, Client, IP, Route...)
                                     v
    +-------------------+    +--------------------+    +--------------------+
    |   Policy Engine   |--->|    Scope Keyer     |<---|   Clock Provider   |
    |  - TokenBucket    |    |  - Global (F9)     |    |  - RealClock       |
    |  - LeakyBucket    |    |  - Client (F10)    |    |  - FakeClock       |
    |  - FixedWindow    |    |  - User (F11, F5)  |    |  (Monotonic nanosec|
    |  - SlidingLog     |    |  - IP (F12, F6)    |    |   zero drift)      |
    |  - SlidingCounter |    |  - Route (F13, F7) |    +--------------------+
    |  - GCRA (F1)      |    |  - Tenant (F14)    |
    +-------------------+    |  - Group (F15)     |
              |              +--------------------+
              |                        |
              v                        v
       Validated Policy      Resolved Dimension
              |                        |
              +-----------+------------+
                          |
                          v
         +----------------------------------+
         |      Canonical KeyBuilder        |
         |  - Collision-Free Binary (F3)    |
         |    (WireVer | LenPrefixed dims)  |
         |  - Redis Hash-Tag String         |
         |    "rl:{tenant:subject}:..."     |
         +----------------------------------+
                          |
                          v
         +----------------------------------+
         |        Store Data Plane          |
         |  - In-Memory Bucket Store (S1)   |
         |  - Redis Single/Sentinel/Cluster |
         |    (Decide / Peek / Refund)      |
         +----------------------------------+
              /                        \
      [ ALLOWED ]                  [ 429 REJECTED ]
           |                               |
           v                               v
    Proxy Upstream                IETF RateLimit Headers
    (X-Forwarded-*)               Retry-After Calculation
                                  Custom JSON Error Payload

+-------------------------------------------------------------------------+
|                       rlgw Admin & Control Plane                        |
|                         (port :8081 by default)                         |
|  - /healthz: Readiness and uptime status                                |
|  - /admin/policies: Dynamic Policy CRUD and canonical JSON ETag hashes  |
+-------------------------------------------------------------------------+
```

---

## 2. Key Engineering Guarantees

1. **Hot-Path Zero Allocations**:
   - Identity resolution: `0 B/op`, `0 allocs/op`, ~280 ns steady state.
   - Key builder: `0 B/op`, `0 allocs/op`, ~25 ns steady state with caller buffer.
2. **Deterministic Time**:
   - `clock.Clock` interface injected everywhere. Zero calls to `time.Now()` inside admission logic.
   - Tests run with `FakeClock` without thread sleeps.
3. **Integer Arithmetic**:
   - Refill and token rates use scaled fixed-point nanosecond math (`scaleFactor = 10^9`). Zero float accumulation drift.
4. **Collision-Free Keys**:
   - Binary keys use explicit wire-versioning and `uint16` big-endian length prefixing per dimension, eliminating delimiter attacks.
   - Redis keys use `{tenant:subject}` hash-tags so all counters for the same subject reside on the same Redis Cluster slot.
5. **Fail-Safe Policy Validation**:
   - Returns all validation errors with field paths (never terminates early).
   - Validation passes in ≤ 35 ns.
   - Canonical JSON and SHA-256 content hashes ensure bit-for-bit idempotency.

---

## 3. Build & Test Commands

```bash
# Verify code formatting and linting
make fmt-check
make vet

# Run all unit and integration tests with race detector
make test-race

# Run performance benchmarks with allocation counts
make bench

# Run fuzz testing suite (30s)
make fuzz

# Build gateway binary
make build
```
