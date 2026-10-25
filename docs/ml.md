# RLGW AI/ML Architecture & Anomaly Detection

This document specifies the dual-tier AI/ML architecture implemented in the Rate-Limit Gateway:

- **Tier A (Local, Real-Time)**: In-process feature extraction and Isolation Forest abuse classifier written in pure TypeScript.
- **Tier B (Offline/Forensic)**: LLM incident diagnostic context builder, injection-hardened prompt engine, and schema validator for explaining security events.

---

## 1. Safety Guarantees

1. **Local-First & Zero Leakage**: All Tier A feature extraction and inference runs purely locally within Node.js. Raw client IPs, tokens, and authorization credentials are salted and pseudonymized using HMAC-SHA-256 before model ingestion.
2. **Deterministic Reproducibility**: The Isolation Forest uses a deterministic seeded pseudo-random number generator (PRNG). Given the same seed and training dataset, the resulting decision trees and anomaly scores are 100% byte-for-byte reproducible.
3. **Bounded Overhead**: Inference runs via a worker queue with bounded capacity (`drop_oldest` policy) ensuring zero blocking impact on hot data-plane rate limiting decisions.
4. **Advisory Role**: The LLM forensic assistant can only explain what happened and propose actions to human operators; it cannot unilaterally mutate policies or apply bans.
