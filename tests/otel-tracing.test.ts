import { describe, it, expect } from 'vitest';
import {
  GatewayTracer,
  InMemorySpanExporter,
  W3CTraceContextPropagator
} from '../packages/obs/src/tracer.js';

describe('F125: OpenTelemetry Distributed Tracing', () => {
  it('creates root and child spans with parent-child linkage', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new GatewayTracer(exporter);

    // Root span
    const rootSpan = tracer.startSpan('rlgw.request', {
      attributes: { 'http.method': 'POST', 'http.target': '/api/v1/orders' }
    });

    // Child span 1: identity
    const identitySpan = tracer.startSpan('rlgw.identity', {
      parentSpan: rootSpan,
      attributes: { 'identity.tenant': 'acme', 'identity.client_id': 'client-42' }
    });
    identitySpan.end();

    // Child span 2: store decide
    const storeSpan = tracer.startSpan('rlgw.store_decide', {
      parentSpan: rootSpan,
      attributes: { 'algorithm': 'token_bucket', 'cost': 1 }
    });
    storeSpan.setStatus('OK');
    storeSpan.end();

    // Child span 3: upstream
    const upstreamSpan = tracer.startSpan('rlgw.upstream', {
      parentSpan: rootSpan,
      attributes: { 'upstream.target': 'http://upstream-srv:8080' }
    });
    upstreamSpan.setStatus('OK');
    upstreamSpan.end();

    rootSpan.setStatus('OK');
    rootSpan.end();

    const finished = exporter.getFinishedSpans();
    expect(finished.length).toBe(4);

    const root = finished.find((s) => s.name === 'rlgw.request')!;
    expect(root).toBeDefined();
    expect(root.parentSpanId).toBeUndefined();

    const children = finished.filter((s) => s.name !== 'rlgw.request');
    for (const child of children) {
      expect(child.context.traceId).toBe(root.context.traceId);
      expect(child.parentSpanId).toBe(root.context.spanId);
    }
  });

  it('redacts sensitive attributes from spans', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new GatewayTracer(exporter);

    const span = tracer.startSpan('rlgw.auth', {
      attributes: {
        'user.id': 'usr-123',
        'x-api-key': 'secret-key-xyz-9876',
        'authorization': 'Bearer token-abcdef'
      }
    });
    span.end();

    const finished = exporter.getFinishedSpans();
    expect(finished[0].attributes['user.id']).toBe('usr-123');
    expect(finished[0].attributes['x-api-key']).toBe('[REDACTED]');
    expect(finished[0].attributes['authorization']).toBe('[REDACTED]');
  });

  it('injects and extracts W3C traceparent headers', () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new GatewayTracer(exporter);

    const rootSpan = tracer.startSpan('rlgw.test');
    const carrier: Record<string, string> = {};

    W3CTraceContextPropagator.inject(rootSpan.context, carrier);
    expect(carrier['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const extracted = W3CTraceContextPropagator.extract(carrier);
    expect(extracted).not.toBeNull();
    expect(extracted?.traceId).toBe(rootSpan.context.traceId);
    expect(extracted?.spanId).toBe(rootSpan.context.spanId);
    expect(extracted?.traceFlags).toBe(1);
  });
});
