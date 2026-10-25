import client from 'prom-client';

export interface CardinalityOptions {
  maxSeriesPerFamily?: number;
}

export class MetricsRegistry {
  readonly registry: client.Registry;
  private readonly maxSeriesPerFamily: number;
  private readonly activeSeries = new Set<string>();
  private seriesDroppedCount = 0;

  // Metric Collectors
  readonly decisionsTotal: client.Counter;
  readonly decisionDuration: client.Histogram;
  readonly droppedRequestsTotal: client.Counter;
  readonly storeOperationDuration: client.Histogram;
  readonly redisCommandDuration: client.Histogram;
  readonly breakerState: client.Gauge;
  readonly stageDuration: client.Histogram;
  readonly gatewayInfo: client.Gauge;
  readonly seriesDroppedGauge: client.Gauge;
  readonly redisPoolInUse: client.Gauge;
  readonly redisPoolWaiting: client.Gauge;
  readonly redisPoolWaitDuration: client.Histogram;
  readonly upstreamErrorsTotal: client.Counter;
  readonly upstreamRequestDuration: client.Histogram;
  readonly processUpGauge: client.Gauge;

  constructor(options: CardinalityOptions = {}) {
    this.registry = new client.Registry();
    this.maxSeriesPerFamily = options.maxSeriesPerFamily ?? 1000;

    this.decisionsTotal = new client.Counter({
      name: 'rlgw_decisions_total',
      help: 'Total rate limit decisions evaluated by the gateway',
      labelNames: ['tenant', 'policy_id', 'decision', 'reason'],
      registers: [this.registry]
    });

    this.decisionDuration = new client.Histogram({
      name: 'rlgw_decision_duration_seconds',
      help: 'Rate limit decision latency in seconds with microsecond resolution',
      labelNames: ['algorithm', 'decision'],
      buckets: [0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1],
      registers: [this.registry]
    });

    this.droppedRequestsTotal = new client.Counter({
      name: 'rlgw_dropped_requests_total',
      help: 'Total requests dropped by the gateway',
      labelNames: ['reason'],
      registers: [this.registry]
    });

    this.storeOperationDuration = new client.Histogram({
      name: 'rlgw_store_operation_duration_seconds',
      help: 'Storage backend operation latency',
      labelNames: ['backend', 'operation'],
      buckets: [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1],
      registers: [this.registry]
    });

    this.redisCommandDuration = new client.Histogram({
      name: 'rlgw_redis_command_duration_seconds',
      help: 'Redis command duration in seconds',
      labelNames: ['command', 'status'],
      buckets: [0.0001, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.05],
      registers: [this.registry]
    });

    this.breakerState = new client.Gauge({
      name: 'rlgw_circuit_breaker_state',
      help: 'Circuit breaker state (0 = closed, 1 = half_open, 2 = open)',
      labelNames: ['upstream_id'],
      registers: [this.registry]
    });

    this.stageDuration = new client.Histogram({
      name: 'rlgw_pipeline_stage_duration_seconds',
      help: 'Latency of gateway pipeline stages in seconds',
      labelNames: ['stage'],
      buckets: [0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01],
      registers: [this.registry]
    });

    this.gatewayInfo = new client.Gauge({
      name: 'rlgw_gateway_info',
      help: 'Metadata info on gateway version, commit, and snapshot',
      labelNames: ['version', 'node_version'],
      registers: [this.registry]
    });
    this.gatewayInfo.set({ version: '1.0.0', node_version: process.version }, 1);

    this.processUpGauge = new client.Gauge({
      name: 'rlgw_process_up',
      help: 'Process liveness indicator',
      registers: [this.registry]
    });
    this.processUpGauge.set(1);

    this.seriesDroppedGauge = new client.Gauge({
      name: 'rlgw_metrics_series_dropped_total',
      help: 'Total metric series dropped or grouped due to cardinality guard budget',
      registers: [this.registry]
    });

    this.redisPoolInUse = new client.Gauge({
      name: 'rlgw_redis_pool_in_use_connections',
      help: 'Current active connections in use by the Redis pool',
      registers: [this.registry]
    });

    this.redisPoolWaiting = new client.Gauge({
      name: 'rlgw_redis_pool_waiting_requests',
      help: 'Current requests queued waiting for a free Redis connection',
      registers: [this.registry]
    });

    this.redisPoolWaitDuration = new client.Histogram({
      name: 'rlgw_redis_pool_wait_duration_seconds',
      help: 'Time spent waiting for a Redis connection from the pool in seconds',
      buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
      registers: [this.registry]
    });

    this.upstreamErrorsTotal = new client.Counter({
      name: 'rlgw_upstream_errors_total',
      help: 'Total errors encountered when contacting upstreams',
      labelNames: ['target', 'error_class'],
      registers: [this.registry]
    });

    this.upstreamRequestDuration = new client.Histogram({
      name: 'rlgw_upstream_request_duration_seconds',
      help: 'Latency of requests forwarded to upstreams in seconds',
      labelNames: ['target', 'status_class'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry]
    });
  }

  /**
   * Cardinality Guard: sanitizes labels and prevents unbounded time-series explosion.
   */
  filterCardinality(family: string, labelKey: string, rawVal: string): string {
    const key = `${family}:${labelKey}:${rawVal}`;
    if (this.activeSeries.has(key)) {
      return rawVal;
    }
    if (this.activeSeries.size >= this.maxSeriesPerFamily) {
      this.seriesDroppedCount++;
      this.seriesDroppedGauge.set(this.seriesDroppedCount);
      return 'other';
    }
    this.activeSeries.add(key);
    return rawVal;
  }

  recordDecision(params: {
    tenant: string;
    policyId: string;
    allowed: boolean;
    reason: string;
    algorithm?: string;
    durationMs: number;
  }): void {
    const decisionStr = params.allowed ? 'allowed' : 'denied';
    const safeTenant = this.filterCardinality('decisions', 'tenant', params.tenant);
    const safeReason = this.filterCardinality('decisions', 'reason', params.reason);

    this.decisionsTotal.inc({
      tenant: safeTenant,
      policy_id: params.policyId,
      decision: decisionStr,
      reason: safeReason
    });

    this.decisionDuration.observe(
      {
        algorithm: params.algorithm ?? 'token_bucket',
        decision: decisionStr
      },
      params.durationMs / 1000
    );
  }

  recordStoreLatency(backend: string, operation: string, durationMs: number): void {
    this.storeOperationDuration.observe(
      { backend, operation },
      durationMs / 1000
    );
  }

  recordRedisCmd(command: string, durationMs: number, err?: Error): void {
    const status = err ? 'error' : 'ok';
    this.redisCommandDuration.observe(
      { command, status },
      durationMs / 1000
    );
  }

  recordBreakerState(upstreamId: string, state: 'closed' | 'open' | 'half_open'): void {
    const stateVal = state === 'closed' ? 0 : state === 'half_open' ? 1 : 2;
    this.breakerState.set({ upstream_id: upstreamId }, stateVal);
  }

  recordStageLatency(stage: string, durationMs: number): void {
    this.stageDuration.observe({ stage }, durationMs / 1000);
  }

  recordDropped(reason: string): void {
    this.droppedRequestsTotal.inc({ reason });
  }

  recordRedisPoolSaturation(inUse: number, waiting: number, waitDurationMs?: number): void {
    this.redisPoolInUse.set(inUse);
    this.redisPoolWaiting.set(waiting);
    if (waitDurationMs !== undefined) {
      this.redisPoolWaitDuration.observe(waitDurationMs / 1000);
    }
  }

  recordUpstreamRequest(target: string, statusCode: number, durationMs: number): void {
    const statusClass = `${Math.floor(statusCode / 100)}xx`;
    this.upstreamRequestDuration.observe({ target, status_class: statusClass }, durationMs / 1000);
  }

  recordUpstreamError(target: string, errorClass: string): void {
    this.upstreamErrorsTotal.inc({ target, error_class: errorClass });
  }

  async getMetricsText(): Promise<string> {
    return this.registry.metrics();
  }

  get activeSeriesCount(): number {
    return this.activeSeries.size;
  }

  get droppedSeriesCount(): number {
    return this.seriesDroppedCount;
  }
}
