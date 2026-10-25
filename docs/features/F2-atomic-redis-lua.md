# F2: Atomic Redis Lua Script Engine

## Overview & Architecture
To guarantee race-condition-free quota tracking across distributed gateway instances, all state updates execute inside atomic Redis Lua scripts (`packages/store-redis/src/scripts/`).

```mermaid
flowchart LR
    NodeA[Gateway Node 1] -->|EVALSHA| Redis[Redis Master / Clustered Node]
    NodeB[Gateway Node 2] -->|EVALSHA| Redis
    NodeC[Gateway Node 3] -->|EVALSHA| Redis
    subgraph Redis Execution Context
        SingleThread[Single-Threaded Lua VM]
        SingleThread --> AtomicOp[Fetch Current + Compute Refill + Decrement + Set TTL]
    end
    Redis --> SingleThread
```

## Sequence Diagram
```mermaid
sequenceDiagram
    autonumber
    participant GW as Gateway Worker
    participant Redis as Redis Server
    GW->>Redis: SCRIPT LOAD (SHA-256 pre-compilation)
    Redis-->>GW: Cached SHA1 Digest
    GW->>Redis: EVALSHA sha1 1 {rl:tenant:client} capacity refill_rate now
    Note over Redis: Atomic Execution: Zero Race Conditions
    Redis-->>GW: [allowed, remaining, reset_seconds]
```

## Say It Out Loud
> "I designed the atomic Redis Lua script engine in `packages/store-redis/` to eliminate the distributed check-then-set race condition. In traditional implementations, a gateway node reads a counter from Redis, calculates tokens in Node.js, and writes the updated count back. Under concurrent load, multiple servers read the same count simultaneously, allowing users to dramatically exceed their limits.
> 
> My engine compiles Lua scripts into Redis SHA1 digests at startup. When a request hits the gateway, we dispatch a single `EVALSHA` command. The entire sequence—fetching the current token balance, computing time elapsed since the last request, adding replenished tokens, deducting request cost, and setting TTL expiration—runs atomically inside Redis's single-threaded event loop in under 0.5 milliseconds.
> 
> I chose Redis Lua scripts over distributed locks (Redlock) because distributed locks require multiple network round-trips and introduce severe lock contention, whereas Lua scripts execute atomically in one round-trip.
> 
> If a script fails or Redis runs out of memory, the gateway catches the Redis exception and falls back to a lock-free in-memory counter with an automatic circuit breaker.
> 
> A known limitation is that long-running Lua scripts block Redis, so our scripts are micro-optimized to execute in fewer than 20 bytecode instructions."
