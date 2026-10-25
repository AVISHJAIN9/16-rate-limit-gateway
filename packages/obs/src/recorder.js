import { MetricsRegistry } from './metrics.js';
import { GatewayLogger } from './logger.js';
import { DecisionLogRingBuffer } from './decision_log.js';
import { HistoryStore } from './history_store.js';
export class ProductionRecorder {
    metrics;
    logger;
    decisionLog;
    history;
    constructor(options = {}) {
        this.metrics = options.metrics ?? new MetricsRegistry();
        this.logger = options.logger ?? new GatewayLogger('info');
        this.decisionLog = options.decisionLog ?? new DecisionLogRingBuffer();
        this.history = options.history ?? new HistoryStore();
    }
    onDecision(decision, ctx) {
        const durationMs = ctx.clock.nowMs() - ctx.startTimeMs;
        const durationUs = Math.floor(durationMs * 1000);
        const tenant = ctx.identity.tenant || 'global';
        const client = ctx.identity.clientId || 'unknown';
        const policyId = decision.policyId || 'unknown';
        const decisionStr = decision.allowed ? 'allowed' : 'denied';
        // 1. Prometheus Metrics
        this.metrics.recordDecision({
            tenant,
            policyId,
            allowed: decision.allowed,
            reason: decision.reason ?? 'limit',
            durationMs
        });
        // 2. Structured JSON Logger
        if (!decision.allowed) {
            this.logger.warn({
                msg: 'Rate limit rejected request',
                request_id: ctx.requestId,
                trace_id: ctx.traceId,
                tenant,
                client,
                route: ctx.path,
                policy_id: policyId,
                decision: decisionStr,
                latency_us: durationUs
            });
        }
        // 3. Ring-buffered Decision Log (for forensics & ML training)
        const logEntry = {
            version: 1,
            ts: ctx.clock.nowMs(),
            request_id: ctx.requestId,
            trace_id: ctx.traceId,
            tenant,
            client_id: client,
            route: ctx.path,
            policy_id: policyId,
            algorithm: 'rate_limiter',
            cost: decision.cost ?? 1,
            decision: decision.allowed ? 'allowed' : 'denied',
            reason: decision.reason,
            remaining: decision.remaining,
            reset_ms: decision.resetMs,
            latency_us: durationUs
        };
        this.decisionLog.push(logEntry);
        // 4. In-process History Store
        this.history.record({
            tenant,
            clientId: client,
            policyId,
            allowed: decision.allowed,
            reason: decision.reason,
            latencyUs: durationUs,
            retryAfterMs: decision.retryAfterMs,
            timestampMs: ctx.clock.nowMs()
        });
    }
    onStoreLatency(backend, operation, durationMs) {
        this.metrics.recordStoreLatency(backend, operation, durationMs);
    }
    onRedisCmd(command, durationMs, err) {
        this.metrics.recordRedisCmd(command, durationMs, err);
    }
    onBreakerState(upstreamId, state) {
        this.metrics.recordBreakerState(upstreamId, state);
    }
    onStageLatency(stage, durationMs) {
        this.metrics.recordStageLatency(stage, durationMs);
    }
    onFailOpen(policyId, error) {
        this.logger.warn({
            msg: 'Fail-open fallback triggered',
            policy_id: policyId,
            reason: error.message
        });
        this.metrics.recordDropped('fail_open_fallback');
    }
    onDropDecisionLog() {
        this.metrics.recordDropped('decision_log_ring_overflow');
    }
}
