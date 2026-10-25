import { PolicySchema, KeyBuilder } from '@rlgw/core';
import { MemoryLimiterStore } from '@rlgw/store-memory';
export class PolicyDryRunner {
    /**
     * F115 Syntax validation: Validates a raw policy object against PolicySchema.
     */
    static validate(rawPolicy) {
        const result = PolicySchema.safeParse(rawPolicy);
        if (!result.success) {
            const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
            return { valid: false, errors };
        }
        return { valid: true, policy: result.data };
    }
    /**
     * F115 Semantic evaluation dry-run: Runs a sequence of simulated requests against a virtual
     * clock and isolated in-memory store. Provably cannot mutate production Redis or state.
     */
    static async evaluate(policy, requests) {
        // Isolated in-memory store and manual virtual clock
        const isolatedStore = new MemoryLimiterStore();
        const keyBuilder = new KeyBuilder();
        const results = [];
        for (const req of requests) {
            const tenant = req.tenantId || policy.tenant || 'global';
            const cost = req.cost ?? 1;
            const key = keyBuilder.build(tenant, req.clientId, policy.id, policy.algorithm);
            const decision = await isolatedStore.decide(key, policy.params, cost, req.timestampMs);
            results.push({
                request: req,
                decision
            });
        }
        return results;
    }
}
