# Policy & Gateway Configuration Reference

This document specifies the declarative policy format, schema contracts, inheritance semantics, dynamic reload pipeline, and configuration resolution hierarchy for the Rate-Limit Gateway (`rlgw`).

---

## 1. Declarative Policy Bundle Format

Policies are defined in YAML or JSON bundles adhering to `version: 1`. The bundle schema is strictly enforced at parse time: **any unknown or unrecognized fields are rejected with exact line and column numbers** to prevent misconfigurations from silently passing into production.

```yaml
version: 1
env: prod # active environment selector (e.g. dev, staging, prod)

includes:
  - "rate-limits/auth.yaml"
  - "rate-limits/checkout.yaml"

policies:
  - id: "pol-users-read"
    name: "User Profile Read Rate Limit"
    tenant: "acme"
    scope: "client"
    algorithm: "token_bucket"
    limit: 100
    burst: 120
    window: "1m" # human-friendly duration: 100ms, 1s, 1m, 1h, 1d
    priority: 100
    enabled: true
    match:
      route_pattern: "/api/v1/users/{id}"
      methods: ["GET", "HEAD"]
      env: "prod"
    cost_spec:
      mode: "static" # static, header, or route
      static_cost: 1
      default_cost: 1
      max_cost: 10
    on_reject:
      status: 429
      retry_after_mode: "seconds" # seconds, rfc1123, none
      body_template_id: "json-problem"
    on_missing_identity: "deny" # deny, skip, fallback_to_ip
    labels:
      tier: "gold"
      team: "identity"

templates:
  - id: "tmpl-tier-standard"
    name: "Standard Tier Blueprint"
    tenant: "acme"
    version: 1
    parameters:
      - name: "limit"
        type: "int"
        required: true
        description: "Allowed requests per window"
      - name: "burst"
        type: "int"
        required: true
      - name: "window"
        type: "duration"
        required: false
        default: "1m"
    body: |
      {
        "id": "pol-{{tenant}}-standard",
        "name": "{{tenant}} Standard Tier",
        "tenant": "{{tenant}}",
        "algorithm": "token_bucket",
        "scope": "client",
        "limit": {{limit}},
        "burst": {{burst}},
        "window": "{{window}}",
        "enabled": true
      }

overrides:
  - id: "ov-incident-402"
    tenant: "acme"
    policy_id: "pol-users-read"
    owner: "sre-lead"
    reason: "Mitigating upstream degradation"
    expires_at: "2026-10-23T23:59:59Z"
    limit: 180
    burst: 200
    force_relax: false
```

---

## 2. Policy Inheritance & Provenance

Policies support hierarchical composition along the precedence chain:

$$\text{Global} \longrightarrow \text{Tenant} \longrightarrow \text{Environment} \longrightarrow \text{Route Group} \longrightarrow \text{Route}$$

### Field-Presence Tracking
Child policies override specified fields only, using explicit field-presence tracking rather than zero-value defaults:
- If a child specifies `burst: 500` but leaves `window` unset, the parent's `window` is preserved.
- Circular inheritance (e.g. $A \to B \to A$) is detected at compile time and rejected with `ERR_POLICY_CYCLE`.
- Resolved policies produce an immutable `EffectivePolicy` containing a `ProvenanceMap` tracking which layer supplied each field (e.g., `"limit": "tenant:acme"`, `"algorithm": "global:base"`).

---

## 3. Incident Overrides & Relaxation Guardrails

Operational overrides permit temporary adjustments to rate limits during incidents or high-traffic events:
- **TTL-Bound Auto-Expiry**: Overrides enforce `expires_at` checked against the system clock (`clock.Clock`). Upon expiration, policies automatically revert without requiring manual redeployment.
- **Relaxation Protection (`maxRelaxFactor`)**: To prevent accidental overload of backend services, overrides cannot weaken limits beyond a configurable factor (default `2.0x`) unless explicitly authorized with `force_relax: true`. Attempts to relax beyond the threshold return `ERR_RELAXATION_EXCEEDED`.

---

## 4. Radix Route Matching & Ambiguity Resolution

Route patterns are compiled into a zero-allocation Radix Tree supporting parameters, single-segment wildcards, multi-segment wildcards, and suffix wildcards.

### Ambiguity Order
When multiple route rules could match an inbound request path, the radix router resolves matches by strict segment specificity:
1. **Exact Literal Segment**: `/users/profile` (Weight 1000)
2. **Single Parameter / Wildcard**: `/users/{id}` or `/users/*` (Weight 100)
3. **Suffix Wildcard**: `/static/*.png` (Weight 50)
4. **Multi-Segment Wildcard**: `/files/**` or `/files/{path...}` (Weight 1)

---

## 5. Strict Total Priority Order

When a request matches multiple policies, they are evaluated in a deterministic strict total order:
1. **Explicit Priority**: Higher `Policy.Priority` integer wins.
2. **Specificity**: Higher route pattern specificity score wins.
3. **Tenant Scope**: Tenant-specific policies win over global policies.
4. **Deterministic Tie-Breaker**: Lexicographical `Policy.ID` ascending, then `Policy.Version` descending.

---

## 6. Dynamic Reload & Zero-Downtime Pointer Swaps

The dynamic configuration pipeline guarantees zero dropped requests and no mixed state during updates:
```
File Watcher (fsnotify) / SIGHUP / Admin API
                  │
                  ▼
         Parse & Disallow Unknown Fields
                  │
                  ▼
    Validate All Policies & Detect Cycles
                  │
                  ▼
Compile Immutable PolicySnapshot (Radix + Index)
                  │
                  ▼
Atomic Pointer Swap (atomic.Pointer[PolicySnapshot])
```

- **In-Flight Isolation**: Requests in flight retain a reference to their active snapshot; concurrent swaps update future ingress traffic atomically.
- **Fail-Safe**: If a new configuration bundle has syntax or validation errors, the previous snapshot remains active and errors are reported via the API and Prometheus metrics.

---

## 7. 12-Factor Configuration & Secret References

Configuration parameters adhere to 12-factor precedence:
$$\text{Environment Variables } (RLGW\_*) > \text{Config File } > \text{Defaults}$$

### Environment Variables
- `RLGW_ENV`: Environment selector (`dev`, `staging`, `prod`).
- `RLGW_CONFIG_PATH`: Path to the root policy bundle.
- `RLGW_FSYNC`: Durability guarantee for the policy WAL (`always`, `periodic`, `never`).

### Secret References
Values in configurations support dynamic resolution:
- `env:VAR_NAME`: Reads from process environment.
- `file:/path/to/secret`: Reads from filesystem and trims trailing whitespace.
