# Configuration

## Core defaults

- `REDIS_URL`: default `redis://127.0.0.1:6379`
- `RATE_LIMIT_FAIL_POLICY`: default `fail-open`
- `IDENTITY_RESOLUTION_ORDER`: `client-certificate > api-key > verified-user > ip`
- `HTTP_SERVER`: `node:http` only; no framework

## Failure policy

The default failure policy for a rule is `fail-open` so that transient store issues do not take the gateway completely offline. This can be overridden per rule with `failOpen: true|false` and must be documented when a policy opts into closed behavior.

## Redis requirements

- Redis 7.0+ is required.
- Lua scripts should use `PEXPIRE NX` and `TIME` semantics when available.
- The Redis client is `ioredis`.

## Batch 2 algorithm defaults

- All timing decisions use the injected `Clock` monotonic timeline, never wall-clock deltas.
- Token-bucket and leaky-bucket state uses integer millisecond arithmetic with capped refill values to avoid float drift.
- `GCRA` uses a capacity-based tolerance window that stays consistent with the token-bucket model on the same rate profile.

## Batch 4 scope semantics

- A request may match multiple scopes at once; all applicable budgets must pass before a request is admitted.
- The winning decision is the most restrictive budget, and the response records the exact scope and selector that caused the rejection.
- This implementation uses a two-phase check: it evaluates all applicable counters without mutating the store, commits only when every applicable scope passes, and rolls back any already-applied writes if a later check fails.
- Global budgets are shared by everyone, per-client/user/ip scopes are identity-specific, per-route checks normalize a request path into a method + route-template key, tenant budgets are separated per tenant, and endpoint groups share a single named bucket across routes in that group.
