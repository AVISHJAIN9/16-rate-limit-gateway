import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { defaultClock } from '@rlgw/core';
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);
export class StreamingReverseProxy {
    options;
    httpAgent;
    httpsAgent;
    routeRoundRobinIndices = new Map();
    targetStates = new Map();
    healthCheckTimers = [];
    constructor(options) {
        this.options = options;
        this.httpAgent = new http.Agent({
            keepAlive: true,
            keepAliveMsecs: 60000,
            maxSockets: 500,
            maxFreeSockets: 50
        });
        this.httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 60000,
            maxSockets: 500,
            maxFreeSockets: 50
        });
        // Initialize target states
        for (const route of options.routes) {
            for (const target of route.targets) {
                if (!this.targetStates.has(target.url)) {
                    this.targetStates.set(target.url, {
                        url: target.url,
                        inFlight: 0,
                        healthy: true,
                        consecutiveSuccesses: 0,
                        consecutiveFailures: 0,
                        lastCheckedMs: 0
                    });
                }
            }
        }
        if (options.autoStartHealthChecks !== false) {
            this.startHealthChecks();
        }
    }
    findRoute(path) {
        return this.options.routes.find((route) => path.startsWith(route.pathPrefix));
    }
    getTargetState(url) {
        return this.targetStates.get(url);
    }
    getAllTargetStates() {
        return Array.from(this.targetStates.values());
    }
    selectTarget(route) {
        const allTargets = route.targets;
        const healthyTargets = allTargets.filter((t) => {
            const state = this.targetStates.get(t.url);
            return state ? state.healthy : true;
        });
        // If all healthy targets are down, fail over to all targets
        const candidateTargets = healthyTargets.length > 0 ? healthyTargets : allTargets;
        let selectedUrlStr;
        if (route.strategy === 'least-connections') {
            // Pick target with lowest inFlight count
            let lowestInFlight = Number.POSITIVE_INFINITY;
            let bestTarget = candidateTargets[0];
            for (const t of candidateTargets) {
                const state = this.targetStates.get(t.url);
                const inFlight = state ? state.inFlight : 0;
                if (inFlight < lowestInFlight) {
                    lowestInFlight = inFlight;
                    bestTarget = t;
                }
            }
            selectedUrlStr = bestTarget.url;
        }
        else {
            // Round-robin
            const currentIndex = this.routeRoundRobinIndices.get(route.pathPrefix) ?? 0;
            const target = candidateTargets[currentIndex % candidateTargets.length];
            this.routeRoundRobinIndices.set(route.pathPrefix, currentIndex + 1);
            selectedUrlStr = target.url;
        }
        // Increment inFlight
        const state = this.targetStates.get(selectedUrlStr);
        if (state) {
            state.inFlight++;
        }
        let released = false;
        const release = () => {
            if (!released) {
                released = true;
                if (state && state.inFlight > 0) {
                    state.inFlight--;
                }
            }
        };
        return { targetUrl: new URL(selectedUrlStr), release };
    }
    getNextTargetUrl(route) {
        return this.selectTarget(route).targetUrl;
    }
    async probeTarget(url, path, timeoutMs) {
        return new Promise((resolve) => {
            const targetUrl = new URL(path, url);
            const isHttps = targetUrl.protocol === 'https:';
            const agent = isHttps ? this.httpsAgent : this.httpAgent;
            const requester = isHttps ? https.request : http.request;
            const req = requester({
                protocol: targetUrl.protocol,
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                method: 'GET',
                path: targetUrl.pathname + targetUrl.search,
                headers: { 'user-agent': 'rlgw-health-probe/1.0' },
                timeout: timeoutMs,
                agent
            }, (res) => {
                const isHealthy = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 400);
                res.resume();
                resolve(isHealthy);
            });
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.on('error', () => {
                resolve(false);
            });
            req.end();
        });
    }
    async executeProbeRound(route) {
        if (!route.healthCheck)
            return;
        const { path, timeoutMs, healthyThreshold, unhealthyThreshold } = route.healthCheck;
        for (const target of route.targets) {
            const state = this.targetStates.get(target.url);
            if (!state)
                continue;
            const isSuccess = await this.probeTarget(target.url, path, timeoutMs);
            state.lastCheckedMs = defaultClock.nowMs();
            if (isSuccess) {
                state.consecutiveFailures = 0;
                state.consecutiveSuccesses++;
                if (!state.healthy && state.consecutiveSuccesses >= healthyThreshold) {
                    state.healthy = true;
                }
            }
            else {
                state.consecutiveSuccesses = 0;
                state.consecutiveFailures++;
                if (state.healthy && state.consecutiveFailures >= unhealthyThreshold) {
                    state.healthy = false;
                }
            }
        }
    }
    startHealthChecks() {
        this.stopHealthChecks();
        for (const route of this.options.routes) {
            if (route.healthCheck) {
                const intervalMs = route.healthCheck.intervalMs || 5000;
                const timer = setInterval(() => {
                    void this.executeProbeRound(route);
                }, intervalMs);
                if ('unref' in timer) {
                    timer.unref();
                }
                this.healthCheckTimers.push(timer);
            }
        }
    }
    stopHealthChecks() {
        for (const timer of this.healthCheckTimers) {
            clearInterval(timer);
        }
        this.healthCheckTimers.length = 0;
    }
    async handleRequest(req, res, clientIp, canonicalPath) {
        const rawPath = req.url || '/';
        const effectivePath = canonicalPath || rawPath;
        const route = this.findRoute(effectivePath);
        if (!route || route.targets.length === 0) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Bad Gateway: No upstream route configured for path' }));
            return;
        }
        // Check request body size limit
        const contentLength = req.headers['content-length'];
        const maxBodyBytes = this.options.maxBodyBytes ?? 10 * 1024 * 1024; // 10MB default
        if (contentLength && Number.parseInt(contentLength, 10) > maxBodyBytes) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload Too Large' }));
            return;
        }
        const { targetUrl, release } = this.selectTarget(route);
        let targetPath = effectivePath;
        if (route.stripPrefix && targetPath.startsWith(route.stripPrefix)) {
            targetPath = targetPath.slice(route.stripPrefix.length) || '/';
        }
        // Prepare upstream headers
        const forwardedHeaders = this.filterAndInjectHeaders(req, targetUrl, clientIp);
        const isHttps = targetUrl.protocol === 'https:';
        const agent = isHttps ? this.httpsAgent : this.httpAgent;
        const requester = isHttps ? https.request : http.request;
        const timeoutMs = route.timeoutMs ?? 5000;
        const abortController = new AbortController();
        const clientAbortHandler = () => {
            abortController.abort();
        };
        req.on('aborted', clientAbortHandler);
        res.on('close', clientAbortHandler);
        let hasTimedOut = false;
        const timer = setTimeout(() => {
            hasTimedOut = true;
            abortController.abort();
        }, timeoutMs);
        const upstreamReq = requester({
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetUrl.port || (isHttps ? 443 : 80),
            method: req.method,
            path: targetPath,
            headers: forwardedHeaders,
            agent,
            signal: abortController.signal
        }, (upstreamRes) => {
            clearTimeout(timer);
            if (upstreamRes.statusCode && upstreamRes.statusCode >= 500) {
                this.options.circuitBreaker?.recordFailure();
            }
            else {
                this.options.circuitBreaker?.recordSuccess();
            }
            // Filter hop-by-hop headers from upstream response
            const responseHeaders = {};
            for (const [key, value] of Object.entries(upstreamRes.headers)) {
                if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
                    responseHeaders[key] = value;
                }
            }
            // Add Via header
            responseHeaders['via'] = (responseHeaders['via'] ? `${responseHeaders['via']}, ` : '') + '1.1 rlgw';
            res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
            // Pipe upstream response back to client with zero buffering
            pipeline(upstreamRes, res, () => {
                release();
                req.off('aborted', clientAbortHandler);
                res.off('close', clientAbortHandler);
            });
        });
        upstreamReq.on('error', (err) => {
            clearTimeout(timer);
            release();
            this.options.circuitBreaker?.recordFailure();
            req.off('aborted', clientAbortHandler);
            res.off('close', clientAbortHandler);
            if (res.headersSent) {
                res.destroy();
                return;
            }
            if (hasTimedOut || err.name === 'AbortError') {
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Gateway Timeout: Upstream did not respond in time' }));
            }
            else {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Bad Gateway: Could not connect to upstream' }));
            }
        });
        // Stream incoming request body directly to upstream
        pipeline(req, upstreamReq, (err) => {
            if (err) {
                upstreamReq.destroy();
            }
        });
    }
    handleUpgrade(req, clientSocket, head) {
        const rawPath = req.url || '/';
        const route = this.findRoute(rawPath);
        if (!route || route.targets.length === 0) {
            clientSocket.destroy();
            return;
        }
        const { targetUrl, release } = this.selectTarget(route);
        const isHttps = targetUrl.protocol === 'https:';
        const port = targetUrl.port ? Number(targetUrl.port) : (isHttps ? 443 : 80);
        const upstreamReq = http.request({
            port,
            host: targetUrl.hostname,
            method: req.method,
            path: rawPath,
            headers: req.headers
        });
        upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
            clientSocket.write(`HTTP/1.1 101 Switching Protocols\r\n` +
                Object.entries(upstreamRes.headers)
                    .map(([k, v]) => `${k}: ${v}\r\n`)
                    .join('') +
                '\r\n');
            if (upstreamHead && upstreamHead.length > 0) {
                clientSocket.write(upstreamHead);
            }
            if (head && head.length > 0) {
                upstreamSocket.write(head);
            }
            upstreamSocket.pipe(clientSocket);
            clientSocket.pipe(upstreamSocket);
            const cleanup = () => {
                release();
                upstreamSocket.destroy();
                clientSocket.destroy();
            };
            clientSocket.on('close', cleanup);
            upstreamSocket.on('close', cleanup);
        });
        upstreamReq.on('error', () => {
            release();
            clientSocket.destroy();
        });
        upstreamReq.end();
    }
    filterAndInjectHeaders(req, targetUrl, clientIp) {
        const headers = {};
        // Check Connection-listed custom hop-by-hop headers
        const connectionHeader = req.headers['connection'];
        const customHops = new Set();
        if (typeof connectionHeader === 'string') {
            connectionHeader.split(',').forEach((h) => customHops.add(h.trim().toLowerCase()));
        }
        for (const [key, value] of Object.entries(req.headers)) {
            if (key.startsWith(':')) {
                continue;
            }
            const lower = key.toLowerCase();
            if (HOP_BY_HOP_HEADERS.has(lower) || customHops.has(lower)) {
                continue;
            }
            headers[key] = value;
        }
        // Set Host header
        headers['host'] = targetUrl.host;
        // Inject X-Forwarded headers
        const existingXff = req.headers['x-forwarded-for'];
        headers['x-forwarded-for'] = existingXff ? `${existingXff}, ${clientIp}` : clientIp;
        headers['x-forwarded-host'] = req.headers['host'] || targetUrl.host;
        headers['x-forwarded-proto'] = 'http';
        headers['via'] = (headers['via'] ? `${headers['via']}, ` : '') + '1.1 rlgw';
        return headers;
    }
    close() {
        this.stopHealthChecks();
        this.httpAgent.destroy();
        this.httpsAgent.destroy();
    }
}
