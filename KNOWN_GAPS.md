# Known Gaps

This file is intentionally kept as a small, explicit ledger of unresolved items for the current scaffold.

- Batch 0 is the scaffold only; no feature implementation work is started in this branch.
- The spreadsheet metadata is copied into the repo under the required docs path, but the actual detailed workbook content is not yet parsed into a full feature implementation.
- Redis is not required for the scaffold and may remain unavailable without affecting batch-zero validation.
- Batch 2 adds the shared timing/refill primitives for token-bucket, leaky-bucket, and GCRA behavior. Redis-backed and windowed algorithms remain out of scope for this batch.
- Batch 4 introduces scope-aware enforcement for global, per-identity, per-route, tenant, and endpoint-group budgets with strictest-scope rejection and rollback semantics.
