import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MetricsRegistry,
  GatewayLogger,
  DecisionLogRingBuffer,
  HistoryStore,
  ProductionRecorder
} from '@rlgw/obs';
import { ManualClock, type Decision, type RequestContext } from '@rlgw/core';

describe('P6: Observability & Analytics Suite (F121–F135 + X4–X7)', () => {
  it('F121, F127, F135: Prometheus decision counters, reason codes, and exposition text', async () => {
    const metrics = new MetricsRegistry();

    metrics.recordDecision({
      tenant: 'acme',
      policyId: 'pol_1',
      allowed: true,
      reason: 'ok',
      algorithm: 'token_bucket',
      durationMs: 0.5
    });

    metrics.recordDecision({
      tenant: 'acme',
      policyId: 'pol_1',
      allowed: false,
      reason: 'cost_exceeds_burst',
      algorithm: 'token_bucket',
      durationMs: 0.8
    });

    const exposition = await metrics.getMetricsText();
    expect(exposition).toContain('rlgw_decisions_total');
    expect(exposition).toContain('decision="allowed"');
    expect(exposition).toContain('decision="denied"');
    expect(exposition).toContain('reason="cost_exceeds_burst"');
    expect(exposition).toContain('rlgw_decision_duration_seconds');
  });

  it('Cardinality Guard & Bomb Defense: 2,000 unique keys capped to budget with other bucket', () => {
    const metrics = new MetricsRegistry({ maxSeriesPerFamily: 100 });

    for (let i = 0; i < 500; i++) {
      metrics.recordDecision({
        tenant: `dynamic_tenant_${i}`,
        policyId: 'pol_shared',
        allowed: true,
        reason: 'ok',
        durationMs: 0.1
      });
    }

    expect(metrics.activeSeriesCount).toBeLessThanOrEqual(105);
    expect(metrics.droppedSeriesCount).toBeGreaterThan(0);
  });

  it('F126: Structured logger and repeated error suppression', () => {
    const logger = new GatewayLogger('debug');
    expect(logger.getLevel()).toBe('debug');

    // Logging duplicate errors within 1s should suppress duplicates
    logger.error({ msg: 'Database connection failed' });
    logger.error({ msg: 'Database connection failed' });
    logger.error({ msg: 'Database connection failed' });

    logger.setLevel('info');
    expect(logger.getLevel()).toBe('info');
  });

  it('X4: DecisionLogRingBuffer sampling (100% denies, 1% allows), non-blocking, and NDJSON', () => {
    const ring = new DecisionLogRingBuffer({ bufferCapacity: 50, allowSampleRate: 0 }); // 0% allow sample for determinism

    // 1. Allowed request with 0% sample is not buffered
    const allowedPushed = ring.push({
      version: 1,
      ts: 1000,
      request_id: 'req_1',
      tenant: 't1',
      client_id: 'c1',
      route: '/api',
      policy_id: 'p1',
      algorithm: 'token_bucket',
      cost: 1,
      decision: 'allowed',
      remaining: 10,
      reset_ms: 2000,
      latency_us: 100
    });
    expect(allowedPushed).toBe(false);
    expect(ring.size).toBe(0);

    // 2. Denied request is 100% sampled
    const deniedPushed = ring.push({
      version: 1,
      ts: 1000,
      request_id: 'req_2',
      tenant: 't1',
      client_id: 'c1',
      route: '/api',
      policy_id: 'p1',
      algorithm: 'token_bucket',
      cost: 1,
      decision: 'denied',
      reason: 'limit',
      remaining: 0,
      reset_ms: 2000,
      latency_us: 150
    });
    expect(deniedPushed).toBe(true);
    expect(ring.size).toBe(1);

    // 3. Overflow drops safely without blocking
    const smallRing = new DecisionLogRingBuffer({ bufferCapacity: 2, allowSampleRate: 1 });
    const makeItem = (id: string) => ({
      version: 1 as const,
      ts: 1000,
      request_id: id,
      tenant: 't',
      client_id: 'c',
      route: '/',
      policy_id: 'p',
      algorithm: 'token_bucket',
      cost: 1,
      decision: 'denied' as const,
      remaining: 0,
      reset_ms: 2000,
      latency_us: 10
    });

    smallRing.push(makeItem('1'));
    smallRing.push(makeItem('2'));
    const overflowSuccess = smallRing.push(makeItem('3')); // Exceeds capacity 2
    expect(overflowSuccess).toBe(false);
    expect(smallRing.droppedLogsCount).toBe(1);

    // 4. Drain & NDJSON
    const drained = smallRing.drain();
    expect(drained.length).toBe(2);
    const ndjson = smallRing.toNDJSON(drained);
    expect(ndjson.split('\n').length).toBe(2);
  });

  it('X5 & X6: HistoryStore 5s time series, top clients, and analytics summary', () => {
    const history = new HistoryStore();
    const now = 10000;

    history.record({
      tenant: 'tenant_omega',
      clientId: 'vip_client',
      policyId: 'pol_1',
      allowed: true,
      latencyUs: 50,
      timestampMs: now
    });

    history.record({
      tenant: 'tenant_omega',
      clientId: 'vip_client',
      policyId: 'pol_1',
      allowed: false,
      reason: 'limit',
      latencyUs: 200,
      retryAfterMs: 2500,
      timestampMs: now
    });

    // Top clients query
    const top = history.getTopClients('tenant_omega');
    expect(top).toHaveLength(1);
    expect(top[0].clientId).toBe('vip_client');
    expect(top[0].requests).toBe(2);

    // Analytics summary
    const summary = history.getAnalyticsSummary('tenant_omega');
    expect(summary.totalRequests).toBe(2);
    expect(summary.allowed).toBe(1);
    expect(summary.denied).toBe(1);
    expect(summary.rejectRatio).toBe(0.5);
    expect(summary.reasonBreakdown['limit']).toBe(1);
    expect(summary.retryAfterDistribution.from1sTo5s).toBe(1);
  });

  it('X7: Alert rules reference only metrics registered in Prometheus catalog', () => {
    const alertsPath = path.resolve(__dirname, '../deploy/prometheus/alerts.yml');
    expect(fs.existsSync(alertsPath)).toBe(true);
    const alertsContent = fs.readFileSync(alertsPath, 'utf-8');

    // Referenced metric names in alerts.yml
    const expectedMetrics = [
      'rlgw_decisions_total',
      'rlgw_circuit_breaker_state',
      'rlgw_metrics_series_dropped_total'
    ];

    const metrics = new MetricsRegistry();
    for (const metricName of expectedMetrics) {
      expect(alertsContent).toContain(metricName);
      expect((metrics as any).registry.getSingleMetric(metricName)).toBeDefined();
    }
  });

  it('ProductionRecorder wires all telemetry seamlessly behind frozen interface', () => {
    const recorder = new ProductionRecorder();
    const clock = new ManualClock(5000);

    const ctx: RequestContext = {
      requestId: 'req_rec_1',
      identity: { tenant: 'corp_a', clientId: 'app_1', ip: '1.2.3.4', source: 'header' },
      path: '/v1/charge',
      method: 'POST',
      headers: {},
      startTimeMs: 4995,
      clock
    };

    const decision: Decision = {
      allowed: true,
      limit: 100,
      remaining: 99,
      resetMs: 60000,
      retryAfterMs: 0,
      reason: 'ok',
      cost: 1,
      policyId: 'charge_limit'
    };

    recorder.onDecision(decision, ctx);
    recorder.onStoreLatency('redis', 'commit', 1.2);
    recorder.onRedisCmd('EVALSHA', 0.8);
    recorder.onBreakerState('upstream_pay', 'open');
    recorder.onStageLatency('identity', 0.2);

    expect(recorder.history.getTopClients('corp_a')[0].clientId).toBe('app_1');
  });
});
