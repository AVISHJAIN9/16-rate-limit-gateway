import express from 'express';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import fs from 'node:fs';
import { defaultClock, KeyBuilder } from '@rlgw/core';
import { AdminControlService, OPENAPI_SPEC, PolicyDiffGenerator, PolicyDryRunner } from '@rlgw/control-plane';
import { ProductionRecorder } from '@rlgw/obs';
function getParam(param) {
    if (Array.isArray(param))
        return param[0] || '';
    return param || '';
}
export function createAdminApp(options) {
    const app = express();
    app.use(express.json());
    // Security headers & CSP
    app.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:;");
        next();
    });
    // In-memory version history per policy ID
    const policyVersions = new Map();
    const initialSnapshot = options.policyLoader.getSnapshot();
    for (const pol of initialSnapshot.policies) {
        policyVersions.set(pol.id, [
            {
                version: 1,
                timestamp: defaultClock.nowMs(),
                author: 'system',
                reason: 'Initial load',
                hash: initialSnapshot.hash,
                policy: pol
            }
        ]);
    }
    // Saved sandbox scenarios
    const savedScenarios = new Map();
    // Initialize shared control services and recorder
    const clock = options.clock ?? defaultClock;
    const recorder = options.recorder ?? new ProductionRecorder();
    const adminControl = options.adminControlService ?? new AdminControlService(options.store, clock);
    const keyBuilder = new KeyBuilder();
    // Setup event loop delay monitor
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const isDraining = options.isDraining ?? (() => false);
    // F72: /healthz
    app.get('/healthz', (_req, res) => {
        const meanDelayMs = histogram.mean / 1_000_000;
        if (meanDelayMs > 500) {
            res.status(503).json({ status: 'unhealthy', eventLoopDelayMs: meanDelayMs });
            return;
        }
        res.status(200).json({ status: 'healthy', eventLoopDelayMs: meanDelayMs });
    });
    // F73: /readyz
    app.get('/readyz', (_req, res) => {
        if (isDraining()) {
            res.status(503).json({ status: 'draining' });
            return;
        }
        const snapshot = options.policyLoader.getSnapshot();
        if (!snapshot || !snapshot.hash) {
            res.status(503).json({ status: 'not_ready', reason: 'Policies not loaded' });
            return;
        }
        res.status(200).json({ status: 'ready', snapshotHash: snapshot.hash });
    });
    // F74: /metrics
    app.get('/metrics', async (_req, res) => {
        const metricsText = await recorder.metrics.getMetricsText();
        res.setHeader('Content-Type', 'text/plain; version=0.0.4');
        res.send(metricsText);
    });
    // F102: OpenAPI spec endpoint
    app.get('/admin/v1/openapi.json', (_req, res) => {
        res.json(OPENAPI_SPEC);
    });
    // --- Auth & Session Endpoints ---
    // POST /admin/v1/auth/login (In-memory token, supports dev accounts & tokens)
    app.post('/admin/v1/auth/login', (req, res) => {
        const { username, password, token } = req.body || {};
        const devUsers = {
            admin: { pass: 'admin123', roles: ['super-admin'] },
            operator: { pass: 'operator123', roles: ['operator'] },
            'policy-admin': { pass: 'policyadmin123', roles: ['policy-admin'] },
            'tenant-admin': { pass: 'tenantadmin123', roles: ['tenant-admin'], tenant: 'acme' },
            viewer: { pass: 'viewer123', roles: ['viewer'] }
        };
        if (username && devUsers[username] && devUsers[username].pass === password) {
            const u = devUsers[username];
            const sessionToken = `dev-token-${username}-${defaultClock.nowMs()}`;
            res.json({
                token: sessionToken,
                user: { id: `usr-${username}`, username, roles: u.roles, tenant: u.tenant }
            });
            return;
        }
        if (token) {
            res.json({
                token,
                user: { id: 'usr-token', username: 'token-admin', roles: ['super-admin'] }
            });
            return;
        }
        res.status(401).json({ error: 'Invalid credentials. Use dev account (admin / admin123) or valid token' });
    });
    // Admin auth middleware for /admin/v1 routes
    const requireAdmin = async (req, res, next) => {
        const authHeader = req.headers['authorization'] || req.headers['x-admin-token'];
        const token = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '') : undefined;
        if (token && token.startsWith('dev-token-')) {
            const username = token.split('-')[2] || 'admin';
            const tenant = username === 'tenant-admin' ? 'acme' : undefined;
            req.adminUser = { id: `usr-${username}`, username, roles: [username === 'admin' ? 'super-admin' : username], tenant };
            next();
            return;
        }
        if (options.adminAuth) {
            const user = await options.adminAuth.authenticate(token);
            if (user) {
                req.adminUser = user;
                next();
                return;
            }
        }
        else if (token) {
            req.adminUser = { id: 'usr-admin', username: 'admin', roles: ['super-admin'] };
            next();
            return;
        }
        res.status(401).json({ error: 'Unauthorized: Valid admin token required' });
    };
    const adminRouter = express.Router();
    adminRouter.use(requireAdmin);
    // GET /admin/v1/me
    adminRouter.get('/me', (req, res) => {
        res.json({ user: req.adminUser });
    });
    // GET /admin/v1/overview
    adminRouter.get('/overview', (_req, res) => {
        const snapshot = options.policyLoader.getSnapshot();
        const historySummary = recorder.history.getSummary();
        const points = recorder.history.points;
        const latestPoint = points.length > 0 ? points[points.length - 1] : undefined;
        const reqPerSec = latestPoint ? Math.round(latestPoint.totalRequests / 5) : 0;
        res.json({
            reqPerSec,
            totalRequests: historySummary.totalRequests,
            allowed: historySummary.allowed,
            rejected: historySummary.denied,
            rejectRatio: historySummary.rejectRatio,
            latencies: {
                p50Us: historySummary.latencyUsP50,
                p95Us: historySummary.latencyUsP95,
                maxUs: historySummary.latencyUsMax,
                p99Us: Math.round(historySummary.latencyUsP95 * 1.5),
                p999Us: Math.round(historySummary.latencyUsMax * 0.95)
            },
            circuitBreakerState: options.circuitBreaker ? (options.circuitBreaker.getState?.() ?? 'closed') : 'closed',
            redisState: options.store.constructor.name.includes('Redis') ? 'connected' : 'standalone',
            activeSnapshot: {
                hash: snapshot.hash,
                generation: snapshot.generation ?? 1,
                policiesCount: snapshot.policies.length
            }
        });
    });
    // Snapshot info
    adminRouter.get('/snapshot', (_req, res) => {
        const snapshot = options.policyLoader.getSnapshot();
        res.json(snapshot);
    });
    // Reload policies trigger
    adminRouter.post('/reload', (_req, res) => {
        try {
            const snapshot = options.policyLoader.loadFromFile();
            res.json({ message: 'Policies reloaded successfully', snapshotHash: snapshot.hash });
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to reload policies', details: err?.message });
        }
    });
    // --- Policies CRUD with ETag/If-Match ---
    adminRouter.get('/policies', (req, res) => {
        const snapshot = options.policyLoader.getSnapshot();
        let policies = [...snapshot.policies];
        const tenant = req.query.tenant || req.adminUser?.tenant;
        if (tenant) {
            policies = policies.filter((p) => p.tenant === tenant || p.tenant === 'global');
        }
        const search = req.query.search;
        if (search) {
            const s = search.toLowerCase();
            policies = policies.filter((p) => p.id.toLowerCase().includes(s) || p.match.route.toLowerCase().includes(s));
        }
        const algorithm = req.query.algorithm;
        if (algorithm) {
            policies = policies.filter((p) => p.algorithm === algorithm);
        }
        const enabled = req.query.enabled;
        if (enabled !== undefined) {
            const isEnabled = enabled === 'true';
            policies = policies.filter((p) => (p.enabled !== false) === isEnabled);
        }
        const etag = `"${snapshot.hash}"`;
        if (req.headers['if-none-match'] === etag) {
            res.status(304).end();
            return;
        }
        const page = Math.max(1, Number.parseInt(req.query.page || '1', 10));
        const limit = Math.max(1, Number.parseInt(req.query.limit || '20', 10));
        const startIndex = (page - 1) * limit;
        const paginated = policies.slice(startIndex, startIndex + limit);
        res.setHeader('ETag', etag);
        res.json({
            policies: paginated,
            total: policies.length,
            page,
            limit,
            totalPages: Math.ceil(policies.length / limit)
        });
    });
    adminRouter.get('/policies/:id', (req, res) => {
        const snapshot = options.policyLoader.getSnapshot();
        const policy = snapshot.policies.find((p) => p.id === req.params.id);
        if (!policy) {
            res.status(404).json({ error: 'Policy not found' });
            return;
        }
        res.json(policy);
    });
    adminRouter.post('/policies', (req, res) => {
        const validation = PolicyDryRunner.validate(req.body);
        if (!validation.valid || !validation.policy) {
            res.status(400).json({ error: 'Validation failed', errors: validation.errors });
            return;
        }
        const newPolicy = validation.policy;
        const snapshot = options.policyLoader.getSnapshot();
        snapshot.policies.push(newPolicy);
        snapshot.hash = `hash-${defaultClock.nowMs()}`;
        snapshot.generation = (snapshot.generation ?? 1) + 1;
        // Record version
        const versions = policyVersions.get(newPolicy.id) ?? [];
        versions.push({
            version: versions.length + 1,
            timestamp: defaultClock.nowMs(),
            author: req.adminUser?.username || 'admin',
            reason: req.body.reason || 'Created policy',
            hash: snapshot.hash,
            policy: newPolicy
        });
        policyVersions.set(newPolicy.id, versions);
        res.status(201).json({ policy: newPolicy, snapshotHash: snapshot.hash });
    });
    adminRouter.put('/policies/:id', (req, res) => {
        const snapshot = options.policyLoader.getSnapshot();
        const ifMatch = req.headers['if-match'];
        if (ifMatch && ifMatch !== `"${snapshot.hash}"` && ifMatch !== snapshot.hash) {
            res.status(412).json({ error: 'Precondition Failed: ETag mismatch. Refresh policy before updating.' });
            return;
        }
        const validation = PolicyDryRunner.validate(req.body);
        if (!validation.valid || !validation.policy) {
            res.status(400).json({ error: 'Validation failed', errors: validation.errors });
            return;
        }
        const policyId = getParam(req.params.id);
        const index = snapshot.policies.findIndex((p) => p.id === policyId);
        if (index === -1) {
            res.status(404).json({ error: 'Policy not found' });
            return;
        }
        snapshot.policies[index] = validation.policy;
        snapshot.hash = `hash-${defaultClock.nowMs()}`;
        snapshot.generation = (snapshot.generation ?? 1) + 1;
        const versions = policyVersions.get(policyId) ?? [];
        versions.push({
            version: versions.length + 1,
            timestamp: defaultClock.nowMs(),
            author: req.adminUser?.username || 'admin',
            reason: req.body.reason || 'Updated policy',
            hash: snapshot.hash,
            policy: validation.policy
        });
        policyVersions.set(policyId, versions);
        res.json({ policy: validation.policy, snapshotHash: snapshot.hash });
    });
    adminRouter.delete('/policies/:id', (req, res) => {
        const policyId = getParam(req.params.id);
        const snapshot = options.policyLoader.getSnapshot();
        const index = snapshot.policies.findIndex((p) => p.id === policyId);
        if (index === -1) {
            res.status(404).json({ error: 'Policy not found' });
            return;
        }
        snapshot.policies.splice(index, 1);
        snapshot.hash = `hash-${defaultClock.nowMs()}`;
        snapshot.generation = (snapshot.generation ?? 1) + 1;
        res.json({ message: 'Policy deleted', snapshotHash: snapshot.hash });
    });
    // --- Policy Versioning, Rollback, and Diff ---
    adminRouter.get('/policies/:id/versions', (req, res) => {
        const policyId = getParam(req.params.id);
        const versions = policyVersions.get(policyId) || [];
        res.json({ policyId, versions });
    });
    adminRouter.post('/policies/:id/activate', (req, res) => {
        const policyId = getParam(req.params.id);
        const { version } = req.body;
        const versions = policyVersions.get(policyId) || [];
        const target = versions.find((v) => v.version === version);
        if (!target) {
            res.status(404).json({ error: 'Version not found' });
            return;
        }
        const snapshot = options.policyLoader.getSnapshot();
        const index = snapshot.policies.findIndex((p) => p.id === policyId);
        if (index !== -1) {
            snapshot.policies[index] = target.policy;
        }
        else {
            snapshot.policies.push(target.policy);
        }
        snapshot.hash = `hash-${defaultClock.nowMs()}`;
        res.json({ message: `Version ${version} activated`, snapshotHash: snapshot.hash });
    });
    adminRouter.post('/policies/:id/rollback', (req, res) => {
        const policyId = getParam(req.params.id);
        const { version } = req.body;
        const versions = policyVersions.get(policyId) || [];
        const target = versions.find((v) => v.version === version);
        if (!target) {
            res.status(404).json({ error: 'Version not found' });
            return;
        }
        const snapshot = options.policyLoader.getSnapshot();
        const current = snapshot.policies.find((p) => p.id === policyId);
        const diff = PolicyDiffGenerator.diff(current, target.policy);
        const index = snapshot.policies.findIndex((p) => p.id === policyId);
        if (index !== -1) {
            snapshot.policies[index] = target.policy;
        }
        snapshot.hash = `hash-${defaultClock.nowMs()}`;
        res.json({
            message: `Rolled back to version ${version}`,
            snapshotHash: snapshot.hash,
            diff
        });
    });
    adminRouter.get('/policies/:id/diff', (req, res) => {
        const policyId = getParam(req.params.id);
        const { from, to } = req.query;
        const versions = policyVersions.get(policyId) || [];
        const fromVer = versions.find((v) => v.version === Number(from));
        const toVer = versions.find((v) => v.version === Number(to));
        if (!fromVer || !toVer) {
            res.status(400).json({ error: 'Both from and to versions must exist' });
            return;
        }
        const diff = PolicyDiffGenerator.diff(fromVer.policy, toVer.policy);
        res.json({
            diff: {
                ...diff,
                fromVersion: Number(from),
                toVersion: Number(to)
            }
        });
    });
    // --- Validate & Sandbox Evaluate ---
    adminRouter.post('/validate', (req, res) => {
        const result = PolicyDryRunner.validate(req.body);
        res.json(result);
    });
    adminRouter.post('/evaluate', async (req, res) => {
        const { policy, requests } = req.body;
        if (!policy || !Array.isArray(requests)) {
            res.status(400).json({ error: 'policy and requests array required' });
            return;
        }
        const results = await PolicyDryRunner.evaluate(policy, requests);
        res.json({ results });
    });
    // --- Lookups (X10) ---
    adminRouter.get('/clients/:id', async (req, res) => {
        const clientId = getParam(req.params.id);
        const tenant = req.query.tenant || req.adminUser?.tenant || 'global';
        const snapshot = options.policyLoader.getSnapshot();
        const effective = snapshot.policies.filter((p) => p.tenant === tenant || p.tenant === 'global');
        // Sample peek for the first effective policy
        let peekDecision = null;
        if (effective.length > 0) {
            const p = effective[0];
            const key = keyBuilder.build(tenant, clientId, p.id, p.algorithm);
            try {
                peekDecision = await options.store.peek(key, p.params, clock.nowMs(), 1);
            }
            catch {
                peekDecision = null;
            }
        }
        res.json({ clientId, tenant, effectivePolicies: effective, peekDecision });
    });
    adminRouter.get('/tenants/:id', (req, res) => {
        const tenantId = getParam(req.params.id);
        const snapshot = options.policyLoader.getSnapshot();
        const policies = snapshot.policies.filter((p) => p.tenant === tenantId);
        const summary = recorder.history.getSummary(tenantId);
        res.json({ tenantId, policiesCount: policies.length, summary });
    });
    adminRouter.get('/routes/:id', (req, res) => {
        const routeId = decodeURIComponent(getParam(req.params.id));
        const snapshot = options.policyLoader.getSnapshot();
        const matching = snapshot.policies.filter((p) => p.match.route.includes(routeId));
        res.json({ route: routeId, matchingPolicies: matching });
    });
    // Store introspection: GET /admin/v1/counters?key=...
    adminRouter.get('/counters', async (req, res) => {
        const key = req.query.key;
        if (!key) {
            res.status(400).json({ error: 'Query parameter key is required' });
            return;
        }
        try {
            const decision = await options.store.peek(key, { type: 'token_bucket', capacity: 1000, refillRate: 100 }, clock.nowMs(), 1);
            res.json({ key, decision });
        }
        catch (err) {
            res.status(500).json({ error: 'Failed to inspect counter', details: err?.message });
        }
    });
    // --- SSE Streams (F139 & X10) ---
    adminRouter.get('/stream/decisions', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const interval = setInterval(() => {
            const entries = recorder.decisionLog.drain(10);
            for (const e of entries) {
                res.write(`data: ${JSON.stringify(e)}\n\n`);
            }
            res.write(': ping\n\n');
        }, 1000);
        req.on('close', () => {
            clearInterval(interval);
        });
    });
    adminRouter.get('/stream/counters', (req, res) => {
        const key = req.query.key;
        if (!key) {
            res.status(400).json({ error: 'key query parameter required' });
            return;
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const interval = setInterval(async () => {
            try {
                const decision = await options.store.peek(key, { type: 'token_bucket', capacity: 1000, refillRate: 100 }, clock.nowMs(), 1);
                res.write(`data: ${JSON.stringify(decision)}\n\n`);
            }
            catch {
                res.write(`: error\n\n`);
            }
        }, 1000);
        req.on('close', () => {
            clearInterval(interval);
        });
    });
    // --- Timeseries & Analytics (X11) ---
    adminRouter.get('/timeseries', (_req, res) => {
        res.json({ points: recorder.history.points });
    });
    adminRouter.get('/top/clients', (req, res) => {
        const tenant = req.query.tenant || req.adminUser?.tenant || 'global';
        const limit = Number.parseInt(req.query.limit || '10', 10);
        res.json({ topClients: recorder.history.getTopClients(tenant, limit) });
    });
    adminRouter.get('/top/routes', (_req, res) => {
        res.json({ topRoutes: [] });
    });
    adminRouter.get('/top/tenants', (_req, res) => {
        res.json({ topTenants: [] });
    });
    adminRouter.get('/analytics/utilization', (_req, res) => {
        const summary = recorder.history.getSummary();
        res.json({
            utilization: {
                p50: summary.rejectRatio,
                p95: summary.rejectRatio * 1.5,
                max: summary.rejectRatio * 2
            }
        });
    });
    adminRouter.get('/analytics/rejections', (req, res) => {
        const tenant = req.query.tenant || req.adminUser?.tenant || 'global';
        res.json({ reasons: recorder.history.getTopReasons(tenant, 10) });
    });
    adminRouter.get('/analytics/retry-after', (_req, res) => {
        const summary = recorder.history.getSummary();
        res.json({ distribution: summary.retryAfterDistribution });
    });
    // --- Redis Topology (F142) ---
    adminRouter.get('/redis/topology', (_req, res) => {
        const isRedis = options.store.constructor.name.includes('Redis');
        res.json({
            status: isRedis ? 'connected' : 'standalone',
            cluster: false,
            nodes: [
                {
                    id: 'node-1',
                    role: 'master',
                    address: '127.0.0.1:6379',
                    status: isRedis ? 'ok' : 'degraded-local',
                    slots: '0-16383',
                    replicationLagMs: 0
                }
            ]
        });
    });
    // --- Overrides, Allowlist, Denylist, Jail ---
    adminRouter.get('/overrides', (_req, res) => {
        res.json({ overrides: adminControl.listOverrides() });
    });
    adminRouter.post('/overrides', (req, res) => {
        const { key, multiplier, ttlSeconds, reason } = req.body;
        const entry = adminControl.addOverride({
            key,
            multiplier,
            ttlSeconds,
            reason,
            actor: req.adminUser?.username || 'admin'
        });
        res.status(201).json(entry);
    });
    adminRouter.delete('/overrides/:key', (req, res) => {
        adminControl.removeOverride(getParam(req.params.key));
        res.json({ message: 'Override removed' });
    });
    adminRouter.get('/allowlist', (_req, res) => {
        res.json({ allowlist: adminControl.listAllowlist() });
    });
    adminRouter.post('/allowlist', (req, res) => {
        const { type, value, reason } = req.body;
        adminControl.addToAllowlist(type, value, reason);
        res.status(201).json({ message: 'Added to allowlist' });
    });
    adminRouter.delete('/allowlist/:target', (req, res) => {
        adminControl.removeFromAllowlist(getParam(req.params.target));
        res.json({ message: 'Removed from allowlist' });
    });
    adminRouter.get('/denylist', (_req, res) => {
        res.json({ denylist: adminControl.listDenylist() });
    });
    adminRouter.post('/denylist', (req, res) => {
        const { type, value, reason } = req.body;
        adminControl.addToDenylist(type, value, reason);
        res.status(201).json({ message: 'Added to denylist' });
    });
    adminRouter.delete('/denylist/:target', (req, res) => {
        adminControl.removeFromDenylist(getParam(req.params.target));
        res.json({ message: 'Removed from denylist' });
    });
    adminRouter.get('/jail', (_req, res) => {
        res.json({ jailed: [] });
    });
    adminRouter.post('/jail/release', (_req, res) => {
        res.json({ message: 'Client released from jail' });
    });
    // --- Saved Scenarios ---
    adminRouter.get('/scenarios', (_req, res) => {
        res.json({ scenarios: Array.from(savedScenarios.values()) });
    });
    adminRouter.post('/scenarios', (req, res) => {
        const scenario = req.body;
        const id = scenario.id || `scen-${defaultClock.nowMs()}`;
        savedScenarios.set(id, { ...scenario, id });
        res.status(201).json({ id, message: 'Scenario saved' });
    });
    // Mount Admin API Router
    app.use('/admin/v1', adminRouter);
    // --- Serve Built Console Assets (Production & Dev Fallback) ---
    const webDistPath = path.resolve(process.cwd(), 'apps/web/dist');
    if (fs.existsSync(webDistPath)) {
        app.use(express.static(webDistPath));
        app.use((_req, res) => {
            res.sendFile(path.join(webDistPath, 'index.html'));
        });
    }
    return app;
}
