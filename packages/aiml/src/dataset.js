import crypto from 'node:crypto';
export class AnomalyDatasetPipeline {
    pepperSalt;
    constructor(pepperSalt = 'rlgw_dataset_pepper_salt') {
        this.pepperSalt = pepperSalt;
    }
    pseudonymize(id) {
        return crypto.createHmac('sha256', this.pepperSalt).update(id).digest('hex').slice(0, 16);
    }
    extractFeatures(logs, windowMs = 60000) {
        const groups = new Map();
        for (const log of logs) {
            const windowStart = Math.floor(log.ts / windowMs) * windowMs;
            const key = `${log.tenant}:${log.client_id}:${windowStart}`;
            let list = groups.get(key);
            if (!list) {
                list = [];
                groups.set(key, list);
            }
            list.push(log);
        }
        const featureRows = [];
        for (const [key, entries] of groups.entries()) {
            const [, clientId, windowStr] = key.split(':');
            const windowStart = Number.parseInt(windowStr, 10);
            const total = entries.length;
            const rejects = entries.filter((e) => e.decision === 'denied').length;
            const routes = new Set(entries.map((e) => e.route)).size;
            const costSum = entries.reduce((acc, curr) => acc + curr.cost, 0);
            // Compute interarrival times
            let meanInterarrival = 1000;
            let burstiness = 0;
            if (entries.length > 1) {
                const sorted = [...entries].sort((a, b) => a.ts - b.ts);
                const intervals = [];
                for (let i = 1; i < sorted.length; i++) {
                    intervals.push(sorted[i].ts - sorted[i - 1].ts);
                }
                meanInterarrival = intervals.reduce((a, b) => a + b, 0) / intervals.length;
                const variance = intervals.reduce((a, b) => a + (b - meanInterarrival) ** 2, 0) / intervals.length;
                burstiness = Math.sqrt(variance) / (meanInterarrival + 1);
            }
            const rejectRatio = total > 0 ? rejects / total : 0;
            const requestRate = total / (windowMs / 1000);
            // Rule-based synthetic label assignment for baseline training
            let label = 'benign';
            if (rejectRatio > 0.8 && routes > 3) {
                label = 'credential_stuffing';
            }
            else if (routes > 10 && requestRate > 5) {
                label = 'scraper';
            }
            else if (requestRate > 20) {
                label = 'attack_burst';
            }
            else if (requestRate < 1 && burstiness < 0.1) {
                label = 'slow_and_low';
            }
            const vector = [
                requestRate,
                rejectRatio,
                routes,
                costSum,
                meanInterarrival,
                burstiness
            ];
            featureRows.push({
                subjectId: this.pseudonymize(clientId),
                windowStartMs: windowStart,
                requestRate,
                rejectRatio,
                uniqueRoutes: routes,
                costSum,
                meanInterarrivalMs: meanInterarrival,
                burstiness,
                label,
                features: vector
            });
        }
        return featureRows;
    }
    split(rows, seed = 42) {
        // Deterministic shuffle using seed
        const shuffled = [...rows];
        let s = seed;
        const lcg = () => {
            s = (s * 1664525 + 1013904223) % 4294967296;
            return s / 4294967296;
        };
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(lcg() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const n = shuffled.length;
        const trainEnd = Math.floor(n * 0.7);
        const valEnd = Math.floor(n * 0.85);
        const train = shuffled.slice(0, trainEnd);
        const validation = shuffled.slice(trainEnd, valEnd);
        const test = shuffled.slice(valEnd);
        return {
            train,
            validation,
            test,
            manifest: {
                schemaVersion: 1,
                seed,
                totalRecords: n,
                trainCount: train.length,
                validationCount: validation.length,
                testCount: test.length
            }
        };
    }
}
