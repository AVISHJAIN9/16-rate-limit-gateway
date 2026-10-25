import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import {
  SensitiveRedactor,
  ConstantTimeKeyVerifier,
  HMACRequestSigner,
  JWTValidator,
  TrustedProxyVerifier,
  JailManager,
  SecuritySanitizer,
  ReplayNonceStore,
  DDoSVolumetricDetector,
  CORSValidator,
  HashChainedAuditLogger,
  RBACAuthorizer,
  AccessListManager
} from '@rlgw/security';

describe('P3: Security & Abuse Prevention Suite (F76–F90 + X1–X3)', () => {
  it('F76: Constant-time API key verification, HMAC pepper, revocation, and tenant binding', () => {
    const verifier = new ConstantTimeKeyVerifier('my_secret_server_pepper_123');
    const secret = 'sec9876543210';
    const keyRecord = {
      keyId: 'client-1',
      hashedSecret: verifier.hashSecret(secret),
      tenant: 'finance',
      clientId: 'fin-client',
      scopes: ['read', 'write'],
      expiresAtMs: Date.now() + 100_000,
      revoked: false,
    };

    // 1. Valid key verification
    const resValid = verifier.verifyKey('rlk_client-1_sec9876543210', keyRecord, Date.now(), 'finance', 'read');
    expect(resValid.valid).toBe(true);

    // 2. Wrong secret
    const resBadSecret = verifier.verifyKey('rlk_client-1_wrongsecret', keyRecord);
    expect(resBadSecret.valid).toBe(false);
    expect(resBadSecret.reason).toBe('secret_mismatch');

    // 3. Tenant mismatch
    const resWrongTenant = verifier.verifyKey('rlk_client-1_sec9876543210', keyRecord, Date.now(), 'marketing');
    expect(resWrongTenant.valid).toBe(false);
    expect(resWrongTenant.reason).toBe('tenant_mismatch');

    // 4. Revocation
    keyRecord.revoked = true;
    const resRevoked = verifier.verifyKey('rlk_client-1_sec9876543210', keyRecord);
    expect(resRevoked.valid).toBe(false);
    expect(resRevoked.reason).toBe('key_revoked');
  });

  it('F77: HMAC API signature request signing and verification with skew tolerance', () => {
    const secret = 'hmac_signing_secret_key';
    const now = 1700000000000;
    const req = {
      method: 'POST',
      path: '/api/v1/transfer',
      query: { account: '1234', currency: 'USD' },
      body: JSON.stringify({ amount: 500 }),
      timestamp: now,
      nonce: 'nonce_abc123',
    };

    const signature = HMACRequestSigner.sign(req, secret);
    expect(signature.length).toBe(64); // SHA-256 hex length

    // 1. Valid verification within skew tolerance
    const resValid = HMACRequestSigner.verify(req, signature, secret, now + 10_000);
    expect(resValid.valid).toBe(true);

    // 2. Clock skew violation (> 5 min)
    const resSkew = HMACRequestSigner.verify(req, signature, secret, now + 400_000);
    expect(resSkew.valid).toBe(false);
    expect(resSkew.reason).toBe('timestamp_out_of_window');

    // 3. Tampered body
    const tamperedReq = { ...req, body: JSON.stringify({ amount: 500000 }) };
    const resTampered = HMACRequestSigner.verify(tamperedReq, signature, secret, now);
    expect(resTampered.valid).toBe(false);
    expect(resTampered.reason).toBe('signature_mismatch');
  });

  it('F78: JWT validation, algorithm allowlist, claims mapping, and alg=none rejection', async () => {
    const secret = new TextEncoder().encode('super_secret_jwt_hmac_key_min_32_bytes_long!');
    const validator = new JWTValidator({ allowedAlgorithms: ['HS256'] });

    // 1. Create valid JWT
    const jwt = await new jose.SignJWT({
      client_id: 'client-jwt-1',
      tenant: 'engineering',
      roles: ['developer'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('usr_123')
      .setExpirationTime('2h')
      .sign(secret);

    const claims = await validator.verifyJWT(jwt, secret);
    expect(claims.sub).toBe('usr_123');
    expect(claims.clientId).toBe('client-jwt-1');
    expect(claims.tenant).toBe('engineering');

    // 2. Reject alg=none attack
    const unverifiedHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const unverifiedPayload = Buffer.from(JSON.stringify({ sub: 'admin', client_id: 'attacker' })).toString('base64url');
    const forgedNoneJWT = `${unverifiedHeader}.${unverifiedPayload}.`;

    await expect(validator.verifyJWT(forgedNoneJWT, secret)).rejects.toThrow(/Unauthorized or forbidden/);
  });

  it('F80: Trusted proxy 50-case CIDR spoofing matrix and right-to-left traversal', () => {
    const verifier = new TrustedProxyVerifier(['10.0.0.0/8', '172.16.0.0/12']);

    // Case 1: Direct untrusted caller attempting to spoof XFF
    const resDirectUntrusted = verifier.verifyForwardedHeader('198.51.100.1', '203.0.113.195');
    expect(resDirectUntrusted.clientIP).toBe('198.51.100.1'); // Untrusted XFF ignored
    expect(resDirectUntrusted.spoofAttemptDetected).toBe(true);

    // Case 2: Trusted intermediate proxy forwarding single client
    const resTrustedHop = verifier.verifyForwardedHeader('10.0.0.1', '203.0.113.195');
    expect(resTrustedHop.clientIP).toBe('203.0.113.195');

    // Case 3: Multiple trusted proxy hops (CDN -> Internal LB -> Gateway)
    const resMultiTrusted = verifier.verifyForwardedHeader('10.0.0.1', '198.51.100.5, 172.16.0.2, 10.0.0.2');
    expect(resMultiTrusted.clientIP).toBe('198.51.100.5');

    // Case 4: Header stripping for untrusted callers
    const rawHeaders = {
      'x-forwarded-for': 'spoofed_ip',
      'x-real-ip': 'spoofed_real_ip',
      'user-agent': 'curl',
    };
    const stripped = verifier.stripUntrustedHeaders('198.51.100.1', rawHeaders);
    expect(stripped['x-forwarded-for']).toBeUndefined();
    expect(stripped['x-real-ip']).toBeUndefined();
    expect(stripped['user-agent']).toBe('curl');

    // 50-case spoofing loop: simulate adversarial combinations of internal vs external IPs
    for (let i = 1; i <= 50; i++) {
      const spoofedClient = `192.0.2.${i}`;
      const untrustedProxy = `198.51.100.${i}`;
      const headerVal = `${spoofedClient}, ${untrustedProxy}`;
      const check = verifier.verifyForwardedHeader(untrustedProxy, headerVal);
      // Because direct caller untrustedProxy is NOT in trusted CIDRs, caller IP is always preserved
      expect(check.clientIP).toBe(untrustedProxy);
    }
  });

  it('F81: Graduated Jail Manager (warn -> tighten -> temp ban with decay)', () => {
    const jail = new JailManager({ baseBanDurationMs: 1000, maxBanDurationMs: 5000 });
    const subject = 'abusive_ip_1.2.3.4';
    const now = 10000;

    // Violation 1: Warn
    const e1 = jail.recordViolation(subject, 'excess_burst', now);
    expect(e1.state).toBe('warn');
    const s1 = jail.checkStatus(subject, now);
    expect(s1.banned).toBe(false);
    expect(s1.tightenFactor).toBe(1.0);

    // Violation 2: Tighten (50% quota)
    const e2 = jail.recordViolation(subject, 'excess_burst', now);
    expect(e2.state).toBe('tighten');
    const s2 = jail.checkStatus(subject, now);
    expect(s2.banned).toBe(false);
    expect(s2.tightenFactor).toBe(0.5);

    // Violation 3: Temp ban
    const e3 = jail.recordViolation(subject, 'excess_burst', now);
    expect(e3.state).toBe('banned');
    const s3 = jail.checkStatus(subject, now);
    expect(s3.banned).toBe(true);

    // Expiry decay back to tighten
    const sDecayed = jail.checkStatus(subject, now + 1500);
    expect(sDecayed.banned).toBe(false);
    expect(sDecayed.state).toBe('tighten');
  });

  it('F82: Path traversal, double encoding, NUL byte, CRLF injection, and smuggling rejection', () => {
    // 1. NUL byte
    expect(() => SecuritySanitizer.sanitizePath('/api/v1/\0users')).toThrow(/NUL byte/);
    expect(() => SecuritySanitizer.sanitizePath('/api/v1/%00users')).toThrow(/NUL byte/);

    // 2. CRLF injection
    expect(() => SecuritySanitizer.sanitizePath('/api/v1/users\r\nX-Injected: true')).toThrow(/CRLF injection/);
    expect(() => SecuritySanitizer.sanitizePath('/api/v1/users%0d%0aInjected')).toThrow(/CRLF injection/);

    // 3. Path traversal & double encoding
    expect(() => SecuritySanitizer.sanitizePath('/api/v1/../../etc/passwd')).toThrow(/Path traversal/);
    expect(() => SecuritySanitizer.sanitizePath('/api/v1/%2e%2e%2fetc/passwd')).toThrow(/Path traversal/);
    expect(() => SecuritySanitizer.sanitizePath('/api/v1/%252e%252e%252fetc/passwd')).toThrow(/Path traversal/);

    // 4. Conflicting Content-Length and Transfer-Encoding (smuggling)
    expect(() => {
      SecuritySanitizer.validateHeaders({
        'content-length': '15',
        'transfer-encoding': 'chunked',
      });
    }).toThrow(/Conflicting Content-Length and Transfer-Encoding/);
  });

  it('F83: Replay attack windows and nonce uniqueness', () => {
    const replay = new ReplayNonceStore(300_000);
    const key = 'api_client_1';
    const now = 1000000;

    // First use: passes
    expect(replay.checkAndStore(key, 'nonce_1', now, now)).toBe(true);

    // Replay with identical nonce: rejected
    expect(replay.checkAndStore(key, 'nonce_1', now, now + 1000)).toBe(false);

    // Stale timestamp outside window: rejected
    expect(replay.checkAndStore(key, 'nonce_2', now - 400_000, now)).toBe(false);
  });

  it('F84: DDoS volumetric surge detector with EWMA and robust z-score', () => {
    const detector = new DDoSVolumetricDetector(0.3, 3.0);
    const subject = 'attacker_ip_9.9.9.9';
    let time = 1000;

    // Simulate steady background traffic
    for (let i = 0; i < 15; i++) {
      time += 1000;
      detector.recordRequest(subject, false, time);
    }

    // Sudden volumetric spike: 50 requests in 100ms
    let detectedSurge = false;
    for (let i = 0; i < 50; i++) {
      time += 2;
      const res = detector.recordRequest(subject, true, time);
      if (res.isSurge) {
        detectedSurge = true;
        break;
      }
    }

    expect(detectedSurge).toBe(true);
  });

  it('F86: CORS origin policy validation and wildcard with credentials rejection', () => {
    // 1. Wildcard without credentials: OK
    const resWildcard = CORSValidator.evaluate('https://example.com', 'GET', {
      allowedOrigins: ['*'],
      allowCredentials: false,
    });
    expect(resWildcard.allowed).toBe(true);
    expect(resWildcard.headers['Access-Control-Allow-Origin']).toBe('*');

    // 2. Wildcard WITH credentials: VIOLATION REJECTED
    const resForbidden = CORSValidator.evaluate('https://example.com', 'GET', {
      allowedOrigins: ['*'],
      allowCredentials: true,
    });
    expect(resForbidden.allowed).toBe(false);

    // 3. Explicit origin with credentials: OK
    const resExplicit = CORSValidator.evaluate('https://app.example.com', 'POST', {
      allowedOrigins: ['https://app.example.com'],
      allowCredentials: true,
    });
    expect(resExplicit.allowed).toBe(true);
    expect(resExplicit.headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(resExplicit.headers['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('F87: Sensitive header masking and canary-secret redaction test', () => {
    const rawHeaders = {
      'authorization': 'Bearer rlk_key123_secCanarySecret9999',
      'x-api-key': 'rlk_user456_secCanarySecret8888',
      'cookie': 'session=canary_session_secret; token=abc',
      'content-type': 'application/json',
    };

    const redacted = SensitiveRedactor.redactHeaders(rawHeaders);

    // Assert zero canary secrets leaked
    const jsonStr = JSON.stringify(redacted);
    expect(jsonStr).not.toContain('secCanarySecret9999');
    expect(jsonStr).not.toContain('secCanarySecret8888');
    expect(jsonStr).not.toContain('canary_session_secret');

    expect(redacted['authorization']).toBe('Bearer rlk_key123_***REDACTED***');
    expect(redacted['x-api-key']).toBe('rlk_user456_***REDACTED***');
    expect(redacted['content-type']).toBe('application/json');
  });

  it('F90: Cryptographic hash-chained security audit event log and tamper detection', () => {
    const audit = new HashChainedAuditLogger();

    // 1. Log sequential actions
    audit.log({
      actor: 'admin_alice',
      tenant: 'finance',
      action: 'policy:create',
      resourceId: 'pol-payments',
    });
    audit.log({
      actor: 'ops_bob',
      tenant: 'finance',
      action: 'policy:rollback',
      resourceId: 'pol-payments',
      diff: { from: 2, to: 1 },
    });
    audit.log({
      actor: 'sec_charlie',
      tenant: 'global',
      action: 'jail:ban',
      resourceId: '198.51.100.99',
    });

    const records = audit.getRecords();
    expect(records.length).toBe(3);

    // 2. Validate chain integrity
    const initialCheck = HashChainedAuditLogger.verifyChain(records);
    expect(initialCheck.valid).toBe(true);

    // 3. Tamper with middle record -> must detect broken chain
    const tamperedRecords = JSON.parse(JSON.stringify(records));
    tamperedRecords[1].action = 'policy:delete'; // unauthorized tamper

    const tamperedCheck = HashChainedAuditLogger.verifyChain(tamperedRecords);
    expect(tamperedCheck.valid).toBe(false);
    expect(tamperedCheck.brokenIndex).toBe(1);
    expect(tamperedCheck.reason).toContain('hash tampering detected');
  });

  it('X1: RBAC permission table and tenant boundary isolation', () => {
    // 1. Viewer can read but not write
    expect(RBACAuthorizer.isAuthorized(['viewer'], 'policy:read')).toBe(true);
    expect(RBACAuthorizer.isAuthorized(['viewer'], 'policy:write')).toBe(false);

    // 2. Policy-admin can write and rollback
    expect(RBACAuthorizer.isAuthorized(['policy-admin'], 'policy:rollback')).toBe(true);

    // 3. Cross-tenant boundaries
    // tenant-admin for "finance" cannot modify policies for "marketing"
    expect(RBACAuthorizer.isAuthorized(['tenant-admin'], 'policy:write', 'finance', 'marketing')).toBe(false);
    expect(RBACAuthorizer.isAuthorized(['tenant-admin'], 'policy:write', 'finance', 'finance')).toBe(true);

    // super-admin can cross tenant boundaries
    expect(RBACAuthorizer.isAuthorized(['super-admin'], 'policy:write', 'finance', 'marketing')).toBe(true);
  });

  it('X3: Multi-dimensional Allow/Denylist (CIDR, key, client, tenant)', () => {
    const acl = new AccessListManager();

    acl.addToDenylist({ type: 'cidr', value: '198.51.100.0/24', reason: 'malicious_botnet' });
    acl.addToDenylist({ type: 'client', value: 'blocked_client', reason: 'unpaid_invoice' });
    acl.addToAllowlist({ type: 'key', value: 'vip_key_1' });

    // 1. IP in denied CIDR is denied
    expect(acl.isDenied({ ip: '198.51.100.42' }).denied).toBe(true);
    expect(acl.isDenied({ ip: '203.0.113.1' }).denied).toBe(false);

    // 2. Blocked client is denied
    expect(acl.isDenied({ clientId: 'blocked_client' }).denied).toBe(true);

    // 3. Allowlisted key
    expect(acl.isAllowlisted({ keyId: 'vip_key_1' })).toBe(true);
  });
});
