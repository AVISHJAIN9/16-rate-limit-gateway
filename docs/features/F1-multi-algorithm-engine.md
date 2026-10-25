# F1: Multi-Algorithm Rate Limiting Engine

## Overview & Architecture
The multi-algorithm rate limiting engine in `src/algorithms/` and `packages/core/` provides mathematically rigorous implementations of five foundational traffic regulation algorithms: Token Bucket, Leaky Bucket, Fixed Window, Sliding Window Log, and Sliding Window Counter.

```mermaid
flowchart TD
    Req[Incoming HTTP Request] --> Extractor[Client Identity Extractor]
    Extractor --> Matcher[Policy Matcher Rule Evaluator]
    Matcher --> SelectAlgo{Algorithm Selector}
    SelectAlgo -->|Token Bucket| TB[Token Bucket: Burst Tolerant]
    SelectAlgo -->|Sliding Window Counter| SWC[Sliding Counter: Memory Efficient]
    SelectAlgo -->|Sliding Window Log| SWL[Sliding Log: Zero Boundary Error]
    SelectAlgo -->|Leaky Bucket| LB[Leaky Bucket: Smooth Egress]
    SelectAlgo -->|GCRA| GCRA[GCRA: Cell Rate Algorithm]
    TB --> RedisLua[Atomic Redis Lua Script Evaluation]
    SWC --> RedisLua
    SWL --> RedisLua
    LB --> RedisLua
    GCRA --> RedisLua
    RedisLua --> CheckAllowed{Allowed?}
    CheckAllowed -->|Allowed| Proxy[Upstream Microservice Proxy]
    CheckAllowed -->|Rejected| 429[HTTP 429 with RateLimit Headers]
```

## Request Flow Sequence Diagram
```mermaid
sequenceDiagram
    autonumber
    actor Client
    participant GW as Gateway Proxy (server.ts)
    participant RateLimiter as RateLimiter Middleware
    participant Redis as Redis Cluster (Lua Engine)
    participant Upstream as Target Microservice

    Client->>GW: HTTP Request (Headers + Body)
    GW->>RateLimiter: evaluate(req, identity)
    RateLimiter->>Redis: EVALSHA token_bucket.lua (Key, Limit, RefillRate, Now)
    alt Under Quota
        Redis-->>RateLimiter: [1, Remaining=450, Reset=60, RetryAfter=0]
        RateLimiter-->>GW: RateLimitDecision.Allowed
        GW->>Upstream: Forward Request
        Upstream-->>GW: HTTP 200 OK
        GW-->>Client: HTTP 200 OK (RateLimit Headers Attached)
    else Quota Exceeded
        Redis-->>RateLimiter: [0, Remaining=0, Reset=15, RetryAfter=15]
        RateLimiter-->>GW: RateLimitDecision.Rejected
        GW-->>Client: HTTP 429 Too Many Requests (Retry-After: 15)
    end
```

## Failure Mode & Degradation Path
```mermaid
stateDiagram-v2
    [*] --> Healthy: Redis Connected
    Healthy --> Degraded: Redis Connection Timeout (50ms)
    Degraded --> FallbackMemory: Circuit Breaker Opens
    FallbackMemory --> ProbeRedis: Half-Open State (5s)
    ProbeRedis --> Healthy: Healthcheck OK
    ProbeRedis --> FallbackMemory: Probe Failed
```

## Say It Out Loud
> "I built the multi-algorithm rate limiting engine in `src/algorithms/` to regulate API traffic according to specific tenant contracts and endpoint workloads. Different APIs require fundamentally different traffic shapers: background bulk exports require Leaky Bucket for smooth steady-state drain; bursty web endpoints use Token Bucket to tolerate traffic surges; and expensive search queries use Sliding Window Counter to strictly prevent boundary-burst attacks.
> 
> When a request arrives at `apps/gateway/src/server.ts`, my middleware resolves the client's identity, queries the matching policy in `src/policy/rule.ts`, and executes an atomic Lua script in Redis. A single atomic operation calculates current token replenishment, decrements the bucket, updates the timestamp, and returns whether the request is allowed.
> 
> I chose to implement multiple specialized algorithms rather than forcing a single one-size-fits-all approach because burst-tolerant endpoints like search require different statistical guarantees than steady-rate payment processors.
> 
> If Redis becomes unresponsive or partitions, our storage layer circuit breaker trips within 50 milliseconds and transitions smoothly to an in-memory fallback store without dropping traffic.
> 
> One trade-off is that high-precision Sliding Window Log stores individual timestamps in a sorted set, which consumes significantly more memory than Sliding Window Counter, so we enforce memory limits on log-based policies."
