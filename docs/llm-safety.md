# RLGW LLM Safety & Prompt Hardening Guide

This document defines the safeguards protecting the Tier B forensic prompt engine and incident context builder from prompt injection, data poisoning, and credential leakage.

---

## 1. Redaction & Canary Protection

1. **Pre-Context Scrubbing**: All incident data assembled by `DiagnosticContextBuilder` passes through `SensitiveRedactor`. Authorization headers, Bearer tokens, cookies, API keys (`rlk_*`), and JWTs are replaced with `[REDACTED]`.
2. **Canary Secret Verification**: Automated regression tests inject unique canary strings (`canary_secret_xyz`) into all telemetry pathways and assert that zero canaries ever appear in the generated prompt context.

---

## 2. Prompt Injection Hardening

1. **Strict Data Delimitation**: User-derived telemetry and logs are encapsulated inside `<incident_data><![CDATA[ ... ]]></incident_data>` blocks. Any raw XML tags inside payloads are sanitized to prevent tag breakout.
2. **System Instruction Precedence**: System prompts instruct the LLM that content inside `<incident_data>` is untrusted data that must never be executed as instructions.
3. **Structured Schema Validation**: All model outputs are strictly parsed and validated against the Zod `ForensicReportSchema`. Any extraneous fields or conversational preamble are stripped. If the model fails or behaves adversarially, the system safely falls back to a deterministic heuristic template.
