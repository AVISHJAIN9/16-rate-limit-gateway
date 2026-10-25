import crypto from 'node:crypto';
import * as fs from 'node:fs';
import { defaultClock } from '@rlgw/core';
export class HashChainedAuditLogger {
    lastHash = '0000000000000000000000000000000000000000000000000000000000000000';
    records = [];
    logFilePath;
    clock;
    constructor(logFilePath, clock = defaultClock) {
        this.logFilePath = logFilePath;
        this.clock = clock;
    }
    log(event) {
        const timestampMs = this.clock.nowMs();
        const id = `audit_${timestampMs}_${crypto.randomBytes(4).toString('hex')}`;
        const prevHash = this.lastHash;
        const payloadToHash = JSON.stringify({
            id,
            timestampMs,
            actor: event.actor,
            tenant: event.tenant,
            action: event.action,
            resourceId: event.resourceId,
            diff: event.diff,
            sourceIp: event.sourceIp,
            prevHash,
        });
        const hash = crypto.createHash('sha256').update(payloadToHash).digest('hex');
        this.lastHash = hash;
        const fullRecord = {
            id,
            timestampMs,
            actor: event.actor,
            tenant: event.tenant,
            action: event.action,
            resourceId: event.resourceId,
            diff: event.diff,
            sourceIp: event.sourceIp,
            prevHash,
            hash,
        };
        this.records.push(fullRecord);
        if (this.logFilePath) {
            fs.appendFileSync(this.logFilePath, JSON.stringify(fullRecord) + '\n');
        }
        return fullRecord;
    }
    getRecords() {
        return [...this.records];
    }
    static verifyChain(records) {
        let prev = '0000000000000000000000000000000000000000000000000000000000000000';
        for (let i = 0; i < records.length; i++) {
            const rec = records[i];
            if (rec.prevHash !== prev) {
                return { valid: false, brokenIndex: i, reason: `prevHash mismatch at record ${i}` };
            }
            const payloadToHash = JSON.stringify({
                id: rec.id,
                timestampMs: rec.timestampMs,
                actor: rec.actor,
                tenant: rec.tenant,
                action: rec.action,
                resourceId: rec.resourceId,
                diff: rec.diff,
                sourceIp: rec.sourceIp,
                prevHash: rec.prevHash,
            });
            const calculated = crypto.createHash('sha256').update(payloadToHash).digest('hex');
            if (calculated !== rec.hash) {
                return { valid: false, brokenIndex: i, reason: `hash tampering detected at record ${i}` };
            }
            prev = rec.hash;
        }
        return { valid: true };
    }
}
