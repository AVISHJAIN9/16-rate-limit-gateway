#!/usr/bin/env node
import { HashChainedAuditLogger } from '../packages/security/src/index.js';

console.log('=== RLGW Audit Chain Verifier ===');
const logger = new HashChainedAuditLogger();
logger.log({ action: 'policy:create', actor: 'admin1', tenant: 't1', resourceId: 'p1', diff: { created: true } });
logger.log({ action: 'policy:activate', actor: 'admin2', tenant: 't1', resourceId: 'p1', diff: { activeVersion: 1 } });
logger.log({ action: 'key:revoke', actor: 'sec-ops', tenant: 't1', resourceId: 'k1', diff: { status: 'revoked' } });

const records = logger.getRecords();
const verification = HashChainedAuditLogger.verifyChain(records);
console.log(`Verified ${records.length} audit records.`);
console.log(`Chain Integrity: ${verification.valid ? 'VALID (100% untampered)' : 'BROKEN at index ' + verification.brokenIndex}`);

if (!verification.valid) {
  process.exit(1);
}
console.log('=== Audit Verification Successful ===');
