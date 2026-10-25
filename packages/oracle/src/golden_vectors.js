import { OracleTokenBucket, OracleFixedWindow, OracleGCRA } from './oracle_algorithms.js';
export class GoldenVectorGenerator {
    static generateTokenBucket(stepsCount = 1000) {
        const params = { type: 'token_bucket', capacity: 50, refillRate: 10 };
        const oracle = new OracleTokenBucket(params, 0);
        const steps = [];
        let currentMs = 0;
        for (let i = 0; i < stepsCount; i++) {
            currentMs += (i * 37) % 250; // pseudo-deterministic progression
            const cost = 1 + ((i * 17) % 15);
            const op = i % 10 === 0 ? 'peek' : i % 25 === 0 ? 'refund' : 'decide';
            if (op === 'refund') {
                oracle.refund(cost);
                steps.push({
                    operation: 'refund',
                    cost,
                    nowMs: currentMs,
                    expected: { cost }
                });
            }
            else {
                const decision = oracle.step(cost, currentMs, op === 'peek');
                steps.push({
                    operation: op,
                    cost,
                    nowMs: currentMs,
                    expected: {
                        allowed: decision.allowed,
                        remaining: decision.remaining,
                        retryAfterMs: decision.retryAfterMs,
                        reason: decision.reason
                    }
                });
            }
        }
        return { algorithm: 'token_bucket', params, steps };
    }
    static generateFixedWindow(stepsCount = 1000) {
        const params = { type: 'fixed_window', limit: 100, windowMs: 1000 };
        const oracle = new OracleFixedWindow(params);
        const steps = [];
        let currentMs = 0;
        for (let i = 0; i < stepsCount; i++) {
            currentMs += (i * 23) % 200;
            const cost = 1 + ((i * 13) % 20);
            const op = i % 12 === 0 ? 'peek' : i % 30 === 0 ? 'refund' : 'decide';
            if (op === 'refund') {
                oracle.refund(cost);
                steps.push({
                    operation: 'refund',
                    cost,
                    nowMs: currentMs,
                    expected: { cost }
                });
            }
            else {
                const decision = oracle.step(cost, currentMs, op === 'peek');
                steps.push({
                    operation: op,
                    cost,
                    nowMs: currentMs,
                    expected: {
                        allowed: decision.allowed,
                        remaining: decision.remaining,
                        retryAfterMs: decision.retryAfterMs,
                        reason: decision.reason
                    }
                });
            }
        }
        return { algorithm: 'fixed_window', params, steps };
    }
    static generateGCRA(stepsCount = 1000) {
        const params = { type: 'gcra', capacity: 50, ratePerSecond: 10 };
        const oracle = new OracleGCRA(params);
        const steps = [];
        let currentMs = 0;
        for (let i = 0; i < stepsCount; i++) {
            currentMs += (i * 31) % 250;
            const cost = 1 + ((i * 7) % 5);
            const op = i % 15 === 0 ? 'peek' : i % 35 === 0 ? 'refund' : 'decide';
            if (op === 'refund') {
                oracle.refund(cost);
                steps.push({
                    operation: 'refund',
                    cost,
                    nowMs: currentMs,
                    expected: { cost }
                });
            }
            else {
                const decision = oracle.step(cost, currentMs, op === 'peek');
                steps.push({
                    operation: op,
                    cost,
                    nowMs: currentMs,
                    expected: {
                        allowed: decision.allowed,
                        remaining: decision.remaining,
                        retryAfterMs: decision.retryAfterMs,
                        reason: decision.reason
                    }
                });
            }
        }
        return { algorithm: 'gcra', params, steps };
    }
}
