# Security Architecture & Threat Mitigation Matrix

This document catalogs threat vectors, mitigations, and test suites across the RLGW distributed rate-limiting gateway.

---

## Threat Matrix

| Threat Vector | Attack Mechanism | Gateway Mitigation | Verification Test |
|---|---|---|---|
| **Timing Attacks on API Keys** | Measuring response latency variances during string comparison of secret keys | Constant-time HMAC-SHA-256 verification using `crypto.timingSafeEqual` with secret server pepper | `tests/security-suite.test.ts` (`Constant-time API key verification`) |
| **Request Tampering** | Manipulating headers, query strings, or body payloads in flight | Canonical request signing (`method \n path \n query \n timestamp \n nonce \n bodySha256`) and constant-time HMAC signature verification | `tests/security-suite.test.ts` (`HMAC API signature request signing`) |
| **JWT Algorithm Confusion** | Submitting forged JWT tokens signed with `alg: none` or public key confusion | Strict algorithm allowlist, mandatory alg check, rejection of `none`, verification via `jose` | `tests/security-suite.test.ts` (`JWT validation, alg=none rejection`) |
| **IP Spoofing via X-Forwarded-For** | Forging `X-Forwarded-For` headers from untrusted clients to bypass IP throttles | CIDR-trie hop verification, right-to-left traversal stopping at first untrusted hop, stripping untrusted forwarding headers | `tests/security-suite.test.ts` (`50-case CIDR spoofing matrix`) |
| **Persistent Abusive Flooding** | Repeated volumetric rate quota violations by bad actors | Graduated Jail Manager (`warn -> tighten 50% -> temp ban`) with exponential backoff escalation and decay | `tests/security-suite.test.ts` (`Graduated Jail Manager`) |
| **Path Traversal & Smuggling** | Encoded `..%2f`, NUL bytes (`%00`), CRLF injection, and conflicting `Content-Length`/`Transfer-Encoding` | Route normalizer with strict decoding, double-encoding rejection, CRLF validation, and conflicting header rejection | `tests/security-suite.test.ts` (`Path traversal & smuggling rejection`) |
| **Replay Attacks** | Capturing and resending valid signed requests | Timestamp skew window (±5 min) combined with bounded, TTL-backed nonce deduplication cache | `tests/security-suite.test.ts` (`Replay attack windows`) |
| **Volumetric DDoS Surges** | Rapid burst traffic exhausting network bandwidth or gateway resources | Online EWMA rate tracking + robust z-score anomaly detector triggering automatic jail | `tests/security-suite.test.ts` (`DDoS volumetric surge detector`) |
| **Slowloris Attacks** | Holding HTTP connections open by sending headers/body bytes extremely slowly | Enforced Node.js `headersTimeout`, `requestTimeout`, and `keepAliveTimeout` on data listener | `apps/gateway/src/server.ts`, `tests/p1-gateway-e2e.test.ts` |
| **CORS Exploitation** | Cross-origin credential theft via wildcard origins | Origin validation against per-tenant allowlist, rejection of `Access-Control-Allow-Origin: *` when credentials requested | `tests/security-suite.test.ts` (`CORS origin policy validation`) |
| **Canary Secret Leakage** | Leaking credentials, tokens, or session cookies in debug logs, error responses, or traces | Central `SensitiveRedactor` that scrubs all known credential keys and redacts `rlk_<keyid>_***REDACTED***` | `tests/security-suite.test.ts` (`Canary-secret redaction test`) |
| **Token Exhaustion Attacks** | Requesting exorbitant costs (e.g. `Cost: 1000000`) to monopolize rate limiters | Cost capping (`maxCost`), immediate rejection of `cost > burst`, and cost integer clamping | `packages/core/src/cost.ts`, `tests/p0-property-algorithms.test.ts` |
| **Cross-Tenant Data Leakage** | Querying or modifying policies and quotas belonging to another tenant | Cryptographic and key-level namespacing in `KeyBuilder`, tenant isolation wall in policy service | `tests/policy-engine.test.ts` (`Cross-tenant policy isolation`) |
| **Audit Log Tampering** | Malicious insider editing or deleting past administrative events | Cryptographic hash chaining (`prevHash` SHA-256) where any modification breaks the verification chain | `tests/security-suite.test.ts` (`Cryptographic hash-chained audit log`) |
| **Privilege Escalation** | Low-privilege users performing administrative operations | Deny-by-default RBAC (`viewer`, `operator`, `policy-admin`, `tenant-admin`, `super-admin`) with tenant boundary checks | `tests/security-suite.test.ts` (`RBAC permission table`) |
