# Project Structure & Dependency Map

## File Hierarchy

```
16-rate-limit-gateway/
├── apps/
│   ├── gateway/                # Node.js Express 5 Gateway Entrypoint
│   └── web/                    # React 19 Vite Admin Monitoring Console
├── packages/
│   ├── core/                   # Core types, interfaces, and clock abstractions
│   ├── aiml/                   # DDoS & anomaly detection model wrappers
│   ├── control-plane/          # Admin configuration & dynamic policy endpoints
│   ├── obs/                    # OpenTelemetry metrics & structured logging
│   ├── oracle/                 # Anomaly scoring & adaptive threshold oracle
│   ├── security/               # API key validation, JWT inspection, CIDR filtering
│   ├── store-memory/           # Lock-free in-memory bucket store (fallback)
│   ├── store-redis/            # Atomic Redis Lua script engine & connection pool
│   └── testutil/               # Mock clocks, synthetic traffic generators
├── src/                        # Core TypeScript engine (algorithms, identity, policy)
│   ├── algorithms/             # Token bucket, leaky bucket, sliding window
│   ├── gateway/                # Express middleware & rate limiter handler
│   ├── identity/               # Client key extraction & fingerprinting
│   ├── policy/                 # Rule engine & route cost resolver
│   └── store/                  # Storage contract & memory/redis adapters
├── tests/                      # 25 Vitest test suites (P0 core, resilience, security)
├── package.json                # Monorepo workspaces configuration
└── docker-compose.yml          # Gateway, Redis, and Prometheus stack
```

---

## Tech Stack & Runtime Dependencies

| Tier | Technology | Version | Purpose |
| :--- | :--- | :--- | :--- |
| **Runtime** | Node.js | v22+ | Non-blocking event-driven JavaScript runtime |
| **Language** | TypeScript | 5.8.3 | End-to-end static typing across monorepo |
| **HTTP Framework** | Express | 5.3.0 | Modern async-native HTTP routing engine |
| **Storage Engine** | Redis / ioredis | 5.6.1 | Atomic distributed counters via Lua scripting |
| **Validation** | Zod | 4.6.7 | Strict runtime schema parsing for policy configs |
| **Property Testing** | Fast-Check | 4.10.2 | Property-based fuzzing of rate-limit window boundaries |
| **Test Runner** | Vitest | 2.1.8 | High-speed ESM unit and integration test runner |
