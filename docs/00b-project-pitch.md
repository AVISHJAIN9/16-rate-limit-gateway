# Project Pitch: Distributed Rate-Limiting API Gateway

## 30-Second Elevator Pitch
> "I built an enterprise-grade distributed rate-limiting API gateway in TypeScript and Redis that protects downstream microservices from traffic surges, brute-force attacks, and noisy tenants. It supports five distinct rate-limiting algorithms—including Token Bucket and Sliding Window Counter—executed via atomic Redis Lua scripts to eliminate race conditions. If Redis fails, the gateway gracefully degrades to an in-memory fallback without blocking traffic, and a React dashboard visualizes live quota consumption and anomaly alerts."

---

## 2-Minute Technical Interview Pitch
> "When microservices experience traffic spikes or DDoS attacks, traditional application-level rate limiting either fails due to distributed race conditions or causes cascading database failures.
>
> To solve this, I designed and built **16-Rate-Limit-Gateway**, a high-performance distributed gateway control plane.
>
> At its core, the gateway implements five industry-standard rate limiting algorithms in `src/algorithms/`: Token Bucket, Leaky Bucket, Fixed Window, Sliding Window Log, and Sliding Window Counter.
>
> To guarantee atomicity across clustered servers, I wrote specialized Redis Lua scripts in `packages/store-redis/`. A single atomic Redis evaluation fetches current bucket counts, computes token replenishment, deducts the request cost, and sets TTL expiration in one round-trip. This completely eliminates the classic check-then-set race condition where concurrent requests exceed quota limits.
>
> For resilience, I implemented a Circuit Breaker pattern on the Redis storage layer. If Redis latency spikes or the cluster partitions, the gateway transitions within 50 milliseconds to an in-memory lock-free store, logging a degraded warning while ensuring zero dropped traffic for legitimate callers.
>
> The gateway includes a dynamic Policy Matcher in `src/policy/` supporting weighted route costs, header-based quota overrides, and CIDR subnet blocking. The administrative dashboard is built in React 19 and Vite, streaming live throttling metrics. The system is hardened by 25 Vitest integration suites and property-based tests using `fast-check`."
