# Architecture

## Decision model

The core rule and decision types are intentionally plain data objects. All decision logic is pure and free from I/O side effects.

```ts
export interface Identity {
  kind: 'client-certificate' | 'api-key' | 'user' | 'ip' | 'anonymous';
  value: string;
  namespace?: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  windowMs: number;
  limit: number;
  burst: number;
  cost: number;
  scope: string;
  selector: string;
  algorithm: 'fixed-window' | 'sliding-window' | 'token-bucket';
  failOpen: boolean;
}

export interface Decision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
  policyId: string;
  ruleId: string;
  scope: string;
  reason: string;
}
```

## Store contract

`CounterStore` holds all mutable state. Both `MemoryStore` and `RedisStore` implement the same contract and are validated by the same contract tests.

## Failure policy

Each rule documents whether the gateway should `fail-open` or `fail-closed` when the store is unavailable. The default is `fail-open`.

## Redis constraints

Redis 7+ is required. In any Redis-backed logic, prefer `PEXPIRE NX` and `TIME` semantics to keep precise expiry and reset alignment.

## Gateway implementation

The gateway uses the built-in `node:http` server; no web framework is used for this project.

## Batch map

- Batch 1: feature IDs 1-8
- Batch 2: 30,24,16,23,17,21
- Batch 3: 25,26,27,18,19,20,22,29,28
- Batch 4: 9-15
- Batch 5: 32,31,39,40,35,34,36
- Batch 6: 33,37,38,41-45
- Batch 7: 46-52
- Batch 8: 53-60
- Batch 9: 61,65,64,63,62,66,67,68
- Batch 10: 69-75
- Batch 11: 109,110,111,106,107,108,117
- Batch 12: 113,112,114,116,115,118,119,120
- Batch 13: 122,123,127,128,129,125,126
- Batch 14: 130,121,124,131,132,135,133,134
- P1: 15-19
- P2: 20-23
