import http from 'node:http';
import http2 from 'node:http2';
import { PolicyLoader, PolicyMatcher, KeyBuilder, SystemClock, defaultClock } from '@rlgw/core';
import { MemoryLimiterStore } from '@rlgw/store-memory';
import { RedisLimiterStore } from '@rlgw/store-redis';
import { StreamingReverseProxy } from './proxy.js';
import { CircuitBreaker } from './circuit_breaker.js';
import { GatewayMiddlewareChain } from './middleware/chain.js';
import { createAdminApp } from './admin.js';
import { ProductionRecorder } from '@rlgw/obs';
export class GatewayServer {
    config;
    dataServer;
    adminServer;
    isDrainingState = false;
    openSockets = new Set();
    activeConnectionsPerIp = new Map();
    proxy;
    store;
    constructor(config) {
        this.config = config;
    }
    async start() {
        // 1. Initialize policy loader & matcher
        const policyLoader = new PolicyLoader(this.config.policySource.filePath);
        if (this.config.policySource.filePath) {
            policyLoader.loadFromFile();
        }
        else if (Array.isArray(this.config.policySource.policies)) {
            policyLoader.loadFromString(JSON.stringify({ policies: this.config.policySource.policies }));
        }
        const matcher = new PolicyMatcher(policyLoader.getSnapshot().policies);
        // 2. Initialize counter store
        if (this.config.store.type === 'redis') {
            this.store = new RedisLimiterStore({
                host: '127.0.0.1',
                port: 6379,
                ...this.config.store.redis
            });
        }
        else {
            this.store = new MemoryLimiterStore(this.config.store.memory);
        }
        // 3. Initialize proxy and circuit breaker
        const breakerConfig = this.config.upstreams?.[0]?.circuitBreaker;
        const circuitBreaker = new CircuitBreaker('default-upstream', breakerConfig);
        this.proxy = new StreamingReverseProxy({
            routes: this.config.upstreams,
            circuitBreaker
        });
        const recorder = new ProductionRecorder();
        // 4. Initialize middleware chain
        const chain = new GatewayMiddlewareChain({
            store: this.store,
            matcher,
            keyBuilder: new KeyBuilder(),
            clock: new SystemClock(),
            circuitBreaker,
            proxy: this.proxy,
            recorder
        });
        // 5. Setup tuned HTTP / HTTP2 Data Server
        const dataListenerConfig = this.config.dataListener;
        const requestHandler = (req, res) => {
            // Health and Readiness probes on data listener
            if (req.url === '/healthz' || req.url === '/readyz') {
                if (this.isDrainingState) {
                    res.statusCode = 503;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ status: 'draining' }));
                    return;
                }
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ status: 'ok' }));
                return;
            }
            // Slowloris body transfer rate monitor
            if (dataListenerConfig.minBodyTransferRateBytesPerSec && req.method !== 'GET' && req.method !== 'HEAD') {
                let bytesReceived = 0;
                const startTime = defaultClock.nowMs();
                const minRate = dataListenerConfig.minBodyTransferRateBytesPerSec;
                req.on('data', (chunk) => {
                    bytesReceived += chunk.length;
                    const elapsedSec = (defaultClock.nowMs() - startTime) / 1000;
                    if (elapsedSec > 2 && bytesReceived / elapsedSec < minRate) {
                        req.destroy(new Error('Slowloris: Transfer rate below minimum allowed threshold'));
                    }
                });
            }
            void chain.handle(req, res);
        };
        if (dataListenerConfig.http2) {
            if (dataListenerConfig.tls) {
                this.dataServer = http2.createSecureServer({
                    cert: dataListenerConfig.tls.cert,
                    key: dataListenerConfig.tls.key,
                    allowHTTP1: true,
                    maxHeaderListPairs: 128
                }, requestHandler);
            }
            else {
                this.dataServer = http2.createServer({}, requestHandler);
            }
        }
        else {
            this.dataServer = http.createServer({ maxHeaderSize: dataListenerConfig.maxHeaderSize }, requestHandler);
            this.tuneHttpServer(this.dataServer, dataListenerConfig);
        }
        // Handle WebSocket upgrade
        this.dataServer.on('upgrade', (req, socket, head) => {
            this.proxy?.handleUpgrade(req, socket, head);
        });
        // Track connections & enforce per-IP concurrency caps (Slowloris mitigation)
        const handleConnection = (socket) => {
            const clientIp = socket.remoteAddress || '127.0.0.1';
            const current = this.activeConnectionsPerIp.get(clientIp) ?? 0;
            const maxPerIp = dataListenerConfig.maxConnectionsPerIp ?? 50;
            if (current >= maxPerIp) {
                socket.destroy();
                return;
            }
            this.activeConnectionsPerIp.set(clientIp, current + 1);
            this.openSockets.add(socket);
            socket.on('close', () => {
                this.openSockets.delete(socket);
                const count = this.activeConnectionsPerIp.get(clientIp) ?? 1;
                if (count <= 1) {
                    this.activeConnectionsPerIp.delete(clientIp);
                }
                else {
                    this.activeConnectionsPerIp.set(clientIp, count - 1);
                }
            });
        };
        this.dataServer.on('connection', handleConnection);
        if ('secureConnection' in this.dataServer) {
            this.dataServer.on('secureConnection', handleConnection);
        }
        // 6. Setup Admin Authenticator & Admin Server
        const adminAuth = {
            authenticate: async (token) => {
                if (!token)
                    return null;
                if (this.config.adminAuth.staticToken && token === this.config.adminAuth.staticToken) {
                    return { id: 'admin-1', username: 'admin', roles: ['super-admin'] };
                }
                return null;
            }
        };
        const adminApp = createAdminApp({
            policyLoader,
            store: this.store,
            adminAuth,
            circuitBreaker,
            isDraining: () => this.isDrainingState,
            recorder
        });
        const adminListenerConfig = this.config.adminListener;
        this.adminServer = http.createServer(adminApp);
        this.tuneHttpServer(this.adminServer, adminListenerConfig);
        // Listen on configured ports
        const dataPort = await this.listenServer(this.dataServer, dataListenerConfig.port, dataListenerConfig.host);
        const adminPort = await this.listenServer(this.adminServer, adminListenerConfig.port, adminListenerConfig.host);
        return { dataPort, adminPort };
    }
    tuneHttpServer(server, cfg) {
        if (cfg.headersTimeout && 'headersTimeout' in server)
            server.headersTimeout = cfg.headersTimeout;
        if (cfg.requestTimeout && 'requestTimeout' in server)
            server.requestTimeout = cfg.requestTimeout;
        if (cfg.keepAliveTimeout && 'keepAliveTimeout' in server)
            server.keepAliveTimeout = cfg.keepAliveTimeout;
        if (cfg.maxRequestsPerSocket && 'maxRequestsPerSocket' in server) {
            server.maxRequestsPerSocket = cfg.maxRequestsPerSocket;
        }
    }
    listenServer(server, port, host) {
        return new Promise((resolve, reject) => {
            server.listen(port, host, () => {
                const addr = server.address();
                const actualPort = typeof addr === 'object' && addr ? addr.port : port;
                resolve(actualPort);
            });
            server.on('error', reject);
        });
    }
    async stop(deadlineMs = 5000) {
        this.isDrainingState = true;
        // Stop accepting new connections
        const closePromises = [];
        if (this.dataServer) {
            closePromises.push(new Promise((resolve) => this.dataServer?.close(() => resolve())));
        }
        if (this.adminServer) {
            closePromises.push(new Promise((resolve) => this.adminServer?.close(() => resolve())));
        }
        // Force close sockets after deadline
        const forceTimer = setTimeout(() => {
            for (const socket of this.openSockets) {
                socket.destroy();
            }
        }, deadlineMs);
        await Promise.all(closePromises);
        clearTimeout(forceTimer);
        this.proxy?.close();
    }
}
