# Step-by-Step Build Order

1. **Core Abstractions & Storage Contract**: Define `RateLimiterStore`, `RateLimitResult`, and `Clock` in `packages/core/`.
2. **In-Memory Store Implementation**: Build lock-free sliding window and token bucket maps in `packages/store-memory/`.
3. **Atomic Redis Lua Engine**: Write and test Lua scripts for sliding window counter and token bucket in `packages/store-redis/`.
4. **Rate Limiting Algorithms**: Implement mathematical formulas in `src/algorithms/`.
5. **Identity & Cost Resolver**: Build client fingerprinting and route normalization in `src/identity/`.
6. **Express 5 Gateway Middleware**: Construct non-blocking request interceptor in `src/gateway/`.
7. **React 19 Telemetry UI**: Build monitoring dashboard in `apps/web/`.
