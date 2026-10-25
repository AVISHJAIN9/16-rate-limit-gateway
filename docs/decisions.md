# Architecture Decision Records (ADRs)

## ADR-001: Hand-Rolled Streaming Reverse Proxy vs `http-proxy`

### Context
RLGW serves as a high-throughput, low-latency API gateway enforcing distributed rate limits before proxying requests upstream.

### Decision
We implement a hand-rolled streaming reverse proxy directly on Node.js `node:http.request` and `node:https.request` with pooled, keep-alive `Agent` instances instead of adopting external libraries such as `http-proxy` or `express-http-proxy`.

### Justification
1. **Zero-Buffering Streaming**: `stream.pipeline` guarantees backpressure-aware byte-for-byte forwarding without buffering request or response payloads in memory.
2. **Explicit Hop-by-Hop Stripping**: RFC 7230 requires stripping `Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding`, and `Upgrade`, plus any token listed in the incoming `Connection` header. Hand-rolled logic guarantees exact compliance.
3. **Deterministic Timeout & Abort Handling**: Full control over connect timeouts, response header timeouts, and client disconnects (`req.on('aborted')`) avoids socket and timer leaks.
4. **WebSocket & Protocol Upgrade**: Direct control over the `upgrade` event enables seamless bidirectional piping.

---

## ADR-002: Injectable Monotonic Clock vs Global Wall-Clock

### Context
Rate-limiting algorithms depend on time deltas for token refill and window alignment. Relying on `Date.now()` causes defects during NTP step adjustments and prevents deterministic testing.

### Decision
All algorithms and components accept an injectable `Clock` (`SystemClock`, `FakeClock`, `SkewedClock`). Direct calls to `Date.now()` are restricted exclusively to `packages/core/src/clock.ts`.

---

## ADR-003: Two-Phase Decide Semantics for Multi-Policy Evaluation

### Context
When requests match multiple policies (e.g. global IP throttle + route limit + tenant tier), committing intermediate counters before all checks complete leaks quota if a later policy rejects.

### Decision
RLGW executes an atomic two-phase check:
1. **Phase 1 (Peek)**: All matching policies are evaluated non-mutatively via `peek`. If any rejects, zero counters are touched.
2. **Phase 2 (Commit)**: If all allow, counters are committed sequentially.
3. **Rollback**: If a concurrent race condition causes a commit to fail, all earlier committed policies in the chain are refunded immediately via `refund`.

---

## ADR-004: Redis Cluster Hash-Tags `{tenant:subject}` for Counter Co-Location

### Context
In Redis Cluster, multi-key operations and multi-policy transactional scripts require that all involved keys hash to the identical 16,384 cluster slot.

### Decision
`KeyBuilder` generates all Redis counter keys with the hash-tag pattern `rl:{tenant:subject}:scope:policyId`.

### Consequence
All keys for the same tenant and subject (e.g. client ID or IP) co-locate in the exact same Redis node, enabling zero-cross-slot-error multi-policy evaluation and transactional atomic execution.

---

## ADR-005: Hot-Key Shielding & Micro-Batching with Local Degrade Fallback

### Context
High-frequency hot keys generate severe lock contention and connection saturation on Redis master nodes. In the event of network partition or Redis failure, service availability must be preserved.

### Decision
1. **Hot-Key Shielding**: `HotKeyShield` uses a Space-Saving Top-K heavy hitters sketch to detect hot keys and grant bounded local token leases, avoiding remote round-trips for the duration of the lease.
2. **Micro-Batching**: `PipelineBatcher` groups concurrent `peek` inspections into Redis pipelines within a bounded linger window (≤ 2 ms).
3. **Degrade-Local Fallback**: When Redis connectivity is interrupted, `RedisLimiterStore` automatically switches to `degraded_local` mode using `MemoryLimiterStore` to prevent cascading gateway timeouts.
