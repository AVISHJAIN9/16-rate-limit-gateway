# Go to TypeScript Port Map & Test Parity Matrix

This document maps all Go source packages and tests to their TypeScript counterparts in the MERN gateway codebase.

---

## 1. Feature Port Mapping (F1–F15: Identity, Key Building, Scoping)

| Feature | Go Source Component | Go Test Case | TypeScript Target | TypeScript Test File & Name |
|---|---|---|---|---|
| **F1** Policy Model & Schema | `internal/policy/policy.go` | `TestPolicyValidationMatrix40Cases` | `packages/core/src/policy/schema.ts` | `tests/p0-core-services.test.ts` (`Policy validation`) |
| **F2** Request Identity Resolution | `internal/identity/source.go` | `TestResolverPipelineStages` | `packages/core/src/identity/pipeline.ts` | `tests/identity-pipeline.test.ts` (`ResolverPipelineStages`) |
| **F3** Client Identity & KeyBuilder | `internal/identity/keybuilder.go` | `TestKeyBuilderBinaryAndRedisHashTag` | `packages/core/src/identity/keybuilder.ts` | `tests/identity-pipeline.test.ts` (`KeyBuilderBinaryAndRedisHashTag`) |
| **F4** API Key Parsing & Redaction | `internal/identity/apikey.go` | `TestAPIKeyParsingAndRedaction` | `packages/core/src/identity/apikey.ts` | `tests/identity-pipeline.test.ts` (`APIKeyParsingAndRedaction`) |
| **F5** User Identity | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F11_User_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / User`) |
| **F6** IP Identity & Normalization | `internal/identity/ip.go` | `TestIPNormalizationMatrix` | `packages/core/src/identity/ip.ts` | `tests/identity-pipeline.test.ts` (`IPNormalizationMatrix`) |
| **F7** Route Identity | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F13_Route_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / Route`) |
| **F8** Method-Aware Limits | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F8_Method_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / Method`) |
| **F9** Global Limits | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F9_Global_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / Global`) |
| **F10** Per-Client Limits | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F10_Client_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / Client`) |
| **F11** Per-User Limits | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F11_User_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / User`) |
| **F12** Per-IP Limits | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F12_IP_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / IP`) |
| **F13** Per-Route Limits | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F13_Route_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / Route`) |
| **F14** Tenant Limits | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F14_Tenant_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / Tenant`) |
| **F15** Endpoint-Group Limits | `internal/identity/scope.go` | `TestScopeKeyerMatrix/F15_Endpoint_group_*` | `packages/core/src/identity/scope.ts` | `tests/identity-pipeline.test.ts` (`ScopeKeyerMatrix / EndpointGroup`) |

---

## 2. Feature Port Mapping (F46–F60: Policy Management Engine)

| Feature | Go Source Component | Go Test Case | TypeScript Target | TypeScript Test File & Name |
|---|---|---|---|---|
| **F46** Durable File Store (WAL + Snapshot + Replay) | `internal/policy/filestore.go` | `TestFilePolicyStoreWALAndSnapshot`, `TestFilePolicyStoreCrashRecoveryTruncatedRecord` | `packages/core/src/policy/filestore.ts` | `tests/policy-filestore.test.ts` (`FileStoreWALAndSnapshot`, `CrashRecoveryTruncatedRecord`) |
| **F47** Policy Versioning & Retention | `internal/policy/service.go` | `TestPolicyVersioningRollbackAndDiff` | `packages/core/src/policy/service.ts` | `tests/policy-service.test.ts` (`PolicyVersioningAndRetention`) |
| **F48** Atomic & Scheduled Activation | `internal/policy/service.go` | `TestPolicyVersioningRollbackAndDiff` | `packages/core/src/policy/service.ts` | `tests/policy-service.test.ts` (`AtomicAndScheduledActivation`) |
| **F49** Rollback with Diff Preview | `internal/policy/service.go` | `TestPolicyVersioningRollbackAndDiff` | `packages/core/src/policy/service.ts` | `tests/policy-service.test.ts` (`RollbackWithDiffPreview`) |
| **F50** Inheritance & Field Provenance | `internal/policy/inheritance.go` | `TestPolicyInheritanceAndProvenance`, `TestPolicyInheritanceCycleDetection` | `packages/core/src/policy/inheritance.ts` | `tests/policy-inheritance.test.ts` (`InheritanceAndProvenance`, `CycleDetection`) |
| **F51** TTL Incident Overrides | `internal/policy/override.go` | `TestPolicyOverrideExpiryAndRevocation`, `TestPolicyOverrideRelaxationGuard` | `packages/core/src/policy/override.ts` | `tests/policy-override.test.ts` (`OverrideExpiryAndRevocation`, `RelaxationGuard`) |
| **F52** Parameterized Templates | `internal/policy/template.go` | `TestPolicyTemplateExpansionAndValidation` | `packages/core/src/policy/template.ts` | `tests/policy-template.test.ts` (`TemplateExpansionAndValidation`) |
| **F53** Radix Route Matching | `internal/policy/radix.go` | `TestRadixTreeBasicMatchingAndParamExtraction` | `packages/core/src/policy/radix.ts` | `tests/policy-radix.test.ts` (`RadixRouteMatchingAndParamExtraction`) |
| **F54** Wildcard Routes & Ambiguity | `internal/policy/radix.go` | `TestRadixTreeFuzzAgainstLinearOracle100k` | `packages/core/src/policy/radix.ts` | `tests/policy-radix.test.ts` (`WildcardAmbiguityAndPriority`) |
| **F55** Strict Total Priority Ordering | `internal/policy/priority.go` | `TestPriorityOrderingPrecedenceHierarchy`, `TestPriorityTotalOrderProperties` | `packages/core/src/policy/priority.ts` | `tests/policy-priority.test.ts` (`TotalPriorityOrderProperties`) |
| **F56** Tenant Isolation Security Wall | `internal/policy/isolation_test.go` | `TestCrossTenantIsolationMatrix` | `packages/core/src/policy/isolation.ts` | `tests/policy-isolation.test.ts` (`CrossTenantIsolationMatrix`) |
| **F57** Environment-Specific Policies | `internal/policy/config.go` | `TestExampleBundleFilesParseSuccessfully` | `packages/core/src/policy/bundle.ts` | `tests/policy-bundle.test.ts` (`EnvSpecificPolicies`) |
| **F58** Strict Bundle Parser & Includes | `internal/policy/config.go` | `TestBundleStrictSchemaUnknownFieldRejection`, `TestBundleIncludesAndCycleDetection` | `packages/core/src/policy/bundle.ts` | `tests/policy-bundle.test.ts` (`StrictBundleParserAndIncludes`) |
| **F59** 12-Factor Env & Secret Refs | `internal/policy/config.go` | `TestSecretResolutionAnd12FactorEnv` | `packages/core/src/policy/secrets.ts` | `tests/policy-bundle.test.ts` (`SecretResolutionAnd12FactorEnv`) |
| **F60** Zero-Downtime Hot Reload | `internal/policy/reloader.go` | `TestDynamicReloadAtomicityConcurrentResolvers` | `packages/core/src/policy/reloader.ts` | `tests/policy-reloader.test.ts` (`AtomicSnapshotSwapConcurrentResolvers`) |

---

## 3. Algorithm Kernels Parity (F16–F30)

| Feature | Go Reference | TypeScript Kernel | Parity Property Test |
|---|---|---|---|
| **F16** Token Bucket | `internal/algo/token_bucket.go` | `packages/core/src/algorithms/token_bucket.ts` | `tests/p0-property-algorithms.test.ts` (10,000 ops vs Oracle) |
| **F17** Leaky Bucket | `internal/algo/leaky_bucket.go` | `packages/core/src/algorithms/leaky_bucket.ts` | `tests/p0-property-algorithms.test.ts` (10,000 ops vs Oracle) |
| **F18** Fixed Window | `internal/algo/fixed_window.go` | `packages/core/src/algorithms/fixed_window.ts` | `tests/p0-property-algorithms.test.ts` (10,000 ops vs Oracle) |
| **F19** Sliding Window Log | `internal/algo/sliding_window_log.go` | `packages/core/src/algorithms/sliding_window_log.ts` | `tests/p0-property-algorithms.test.ts` (10,000 ops vs Oracle) |
| **F20** Sliding Window Counter | `internal/algo/sliding_window_counter.go` | `packages/core/src/algorithms/sliding_window_counter.ts` | `tests/p0-property-algorithms.test.ts` (10,000 ops vs Oracle) |
| **F21** GCRA | `internal/algo/gcra.go` | `packages/core/src/algorithms/gcra.ts` | `tests/p0-property-algorithms.test.ts` (10,000 ops vs Oracle) |
| **F22–F24** Costs & Bursts | `internal/algo/cost.go` | `packages/core/src/cost.ts` | `tests/p0-property-algorithms.test.ts` |
| **F25–F28** Stores | `internal/store/memory` | `packages/store-memory/src/index.ts` | `tests/p0-core-services.test.ts` |
| **F29–F30** Clock Skew & High-Res | `internal/clock/clock.go` | `packages/core/src/clock.ts` | `tests/p0-property-algorithms.test.ts` |
