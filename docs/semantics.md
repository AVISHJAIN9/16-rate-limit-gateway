# Distributed Counter Semantics & Rate-Limiting Guarantees

This document establishes the executable architectural contract and formal semantics for the Rate-Limit Gateway (rlgw) counter engine across in-memory and distributed backends.

---

## 1. Linearizability Specification

For any given counter key $K$, the admission decision function `Decide(ctx, key, spec, cost, now)` is **strictly linearizable** with respect to real monotonic time when executed against a single authoritative shard (in-memory partition or Redis Cluster hash slot):

1. **Total Order**: All operations on key $K$ are serialized in a discrete order $op_1, op_2, \dots, op_n$.
2. **Real-Time Precedence**: If $op_1$ completes before $op_2$ is invoked, $op_2$ observes state after $op_1$.
3. **No Phantom Admittance**: If request $R$ is denied because cumulative cost exceeds limit $L$, no subsequent request can be admitted within the same window unless tokens are refilled or refunded.

---

## 2. Multi-Instance Guarantees ($N$ Gateway Nodes)

When $N$ independent gateway instances share a centralized counter data plane (Redis Cluster in Set 5):
- **Exact Mode**: All gateway instances issue atomic commands (`Decide` via Lua script). The system behaves identically to a single unified gateway with zero under- or over-counting. Latency budget: network RTT + ~15 µs Redis execution.
- **Local-Batched Lease Approximation Mode (Set 4)**: Gateways pre-allocate token slices of size $B = \lfloor \text{limit} / 2N \rfloor$.
  - Maximum over-admission error bound across all nodes:
    $$\Delta \le N \times B \le \frac{\text{limit}}{2}$$
  - Heartbeat sync runs every $\tau$ seconds; leases expire automatically if a gateway node crashes, preventing permanent quota leaks.

---

## 3. Algorithm Burst Semantics Table (F23)

| Algorithm | State Variable | Semantics of `Burst` Parameter | Max Requests Admitted in Window $W$ |
|:---|:---|:---|:---|
| **Token Bucket** | `maxTokens = burst * 1e9` | Max token reservoir. Dictates the maximum instantaneous spike allowed from cold/idle state. | $\text{limit} + \text{burst}$ |
| **Leaky Bucket** | `capacity = burst * 1e9` | Maximum queue depth before overflow. Incoming water drains at rate $\text{limit} / W$. | $\text{burst}$ (concurrency cap) |
| **Fixed Window** | `capacity = limit` | Counter ceiling for aligned window interval $[\lfloor t/W \rfloor W, \lfloor t/W \rfloor W + W)$. | $2 \times \text{limit}$ (straddling boundary) |
| **Sliding Window Log** | `HardCap = limit` | Exact timestamp ring buffer capacity. Hard cap on admissions within any sliding window of duration $W$. | $\text{limit}$ (strictly conserved) |
| **Sliding Window Counter**| `limit = limit * 1e9` | Weighted approximation ceiling: $\text{count} = \text{prev} \times \frac{W - \Delta t}{W} + \text{curr}$. | $1.0\times \text{ to } 1.5\times \text{limit}$ (worst-case skew) |
| **GCRA** | $\tau = \text{burst} \times \frac{W}{\text{limit}}$ | Burst tolerance $\tau$. Maximum time ahead of Theoretical Arrival Time ($TAT$) allowed before cell rejection. | $\text{limit} + \text{burst}$ |

---

## 4. Sliding Window Counter Approximation Error Bound (F20)

Let $W$ be window duration, $C_{prev}$ the request count in previous window, $C_{curr}$ the count in current window, and $\Delta t = t \pmod W$.
The estimated count is:
$$\hat{N}(t) = C_{prev} \cdot \left( \frac{W - \Delta t}{W} \right) + C_{curr}$$

- **Uniform Traffic**: When arrivals follow a Poisson or uniform distribution, expected error is mathematically zero:
  $$\mathbb{E}[\hat{N}(t) - N_{true}(t)] = 0$$
- **Adversarial Worst-Case**: If all $C_{prev}$ requests occurred in the final nanosecond of the previous window, the actual count in $(t - W, t]$ is $C_{prev} + C_{curr}$.
  The estimation error is:
  $$\text{Error} = (C_{prev} + C_{curr}) - \hat{N}(t) = C_{prev} \cdot \frac{\Delta t}{W} \le C_{prev}$$
  Since $C_{prev} \le L$ and $C_{curr} \le L \frac{\Delta t}{W}$, total admitted traffic over any interval $W$ is strictly bounded by:
  $$N_{\text{max}} \le 1.5 \times \text{Limit}$$
  This 1.5x bound is proven empirically in the 100,000 schedule property tests (`oracle_test.go`).

---

## 5. Clock-Skew Tolerance & Recovery (F29)

To insulate against NTP step adjustments, container VM freezes, and virtualization time-drifts:
1. **Monotonic Progression**: All time differences are calculated against monotonically increasing nanosecond clocks (`clock.HighResClock`).
2. **Backward Skew Clamp**: If an incoming timestamp $t_{now} < t_{lastSeen}$, the `SkewGuard` clamps $t_{effective} = t_{lastSeen}$ and increments `ClampedEvents`.
3. **No Negative Refills**: Token buckets and leaky buckets will **never** drain or refill negatively upon a backward clock jump.
4. **No Lockouts**: Rejections calculate `RetryAfter` strictly positive ($\ge 1 \text{ ns}$), guaranteeing the gateway never issues negative wait durations or permanent deadlocks to callers.

---

## 6. Refund Semantics

A rate-limiting gateway encounters downstream failure modes (upstream timeouts, circuit breaker trip, client disconnects before upstream dispatch) where admitted quota should not penalize the caller.

1. **Idempotent Restoration**: `Refund(key, spec, cost, now)` restores up to `cost` units back to the counter without exceeding the configured ceiling or capacity.
2. **Algorithm Restorations**:
   - **Token Bucket**: $\text{tokens} = \min(\text{capacity}, \text{tokens} + \text{cost})$.
   - **Leaky Bucket**: $\text{level} = \max(0, \text{level} - \text{cost})$.
   - **Fixed Window**: $\text{count} = \max(0, \text{count} - \text{cost})$.
   - **Sliding Window Log**: Removes the most recently appended entries up to `cost`.
   - **Sliding Window Counter**: $\text{currCount} = \max(0, \text{currCount} - \text{cost})$.
   - **GCRA**: $\text{TAT} = \max(0, \text{TAT} - \text{cost} \times I)$ where $I = 1000 / \text{ratePerSec}$.

---

## 7. Multi-Policy Semantics (Two-Phase Decide)

When multiple policies match an incoming request (e.g. global IP throttle + route limit + tenant quota):

1. **Most Restrictive Wins**: The request is admitted if and only if **all** matching policies permit admission.
2. **Atomic Two-Phase Decide**:
   - **Phase 1 (Peek)**: Every matching policy is evaluated via `peek(key, spec, now)`. No state mutation occurs.
   - If any policy rejects, the request is immediately rejected with the rejection headers and body of the most restrictive policy. Counters for all other policies remain completely untouched.
   - **Phase 2 (Commit)**: If all matching policies allow the request, each policy is sequentially committed via `commit(key, spec, cost, now)`.
   - **Rollback on Race**: If a concurrent request consumes quota between Phase 1 and Phase 2 causing a later policy commit to fail, all earlier committed policies in the chain are refunded immediately via `refund(...)`.
3. **Terminal Deny**: Policies flagged with `terminalDeny: true` short-circuit any further policy evaluation immediately upon denial.
