import crypto from 'node:crypto';
import { defaultClock } from '@rlgw/core';
export class InMemorySpanExporter {
    spans = [];
    export(span) {
        this.spans.push(span);
    }
    getFinishedSpans() {
        return [...this.spans];
    }
    reset() {
        this.spans = [];
    }
}
const REDACTED_KEYS = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'secret',
    'password',
    'token',
    'api_key'
]);
export class Span {
    onEnd;
    context;
    name;
    parentSpanId;
    startTimeMs;
    endTimeMs;
    attributes = {};
    status = { code: 'UNSET' };
    events = [];
    constructor(name, context, parentSpanId, initialAttributes = {}, onEnd) {
        this.onEnd = onEnd;
        this.name = name;
        this.context = context;
        this.parentSpanId = parentSpanId;
        this.startTimeMs = defaultClock.nowMs();
        this.setAttributes(initialAttributes);
    }
    setAttribute(key, value) {
        const lowerKey = key.toLowerCase();
        if (REDACTED_KEYS.has(lowerKey)) {
            this.attributes[key] = '[REDACTED]';
        }
        else {
            this.attributes[key] = value;
        }
        return this;
    }
    setAttributes(attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                this.setAttribute(k, v);
            }
        }
        return this;
    }
    addEvent(name, attributes) {
        this.events.push({
            name,
            timeMs: defaultClock.nowMs(),
            attributes
        });
        return this;
    }
    setStatus(code, message) {
        this.status = { code, message };
        return this;
    }
    end() {
        if (this.endTimeMs !== undefined)
            return;
        this.endTimeMs = defaultClock.nowMs();
        if (this.onEnd) {
            this.onEnd({
                name: this.name,
                context: this.context,
                parentSpanId: this.parentSpanId,
                startTimeMs: this.startTimeMs,
                endTimeMs: this.endTimeMs,
                attributes: { ...this.attributes },
                status: { ...this.status },
                events: [...this.events]
            });
        }
    }
}
export class W3CTraceContextPropagator {
    static inject(context, carrier) {
        const flagsStr = context.traceFlags.toString(16).padStart(2, '0');
        carrier['traceparent'] = `00-${context.traceId}-${context.spanId}-${flagsStr}`;
    }
    static extract(carrier) {
        const raw = carrier['traceparent'];
        const header = Array.isArray(raw) ? raw[0] : raw;
        if (!header || typeof header !== 'string')
            return null;
        const parts = header.trim().split('-');
        if (parts.length < 4 || parts[0] !== '00')
            return null;
        const traceId = parts[1];
        const spanId = parts[2];
        const traceFlags = Number.parseInt(parts[3], 16) || 0;
        if (traceId.length !== 32 || spanId.length !== 16)
            return null;
        return { traceId, spanId, traceFlags };
    }
}
export class GatewayTracer {
    exporter;
    constructor(exporter) {
        this.exporter = exporter;
    }
    startSpan(name, options = {}) {
        const parentContext = options.parentSpan ? options.parentSpan.context : options.parentContext;
        const traceId = parentContext ? parentContext.traceId : crypto.randomBytes(16).toString('hex');
        const parentSpanId = parentContext ? parentContext.spanId : undefined;
        const spanId = crypto.randomBytes(8).toString('hex');
        const traceFlags = options.sampled !== undefined ? (options.sampled ? 1 : 0) : (parentContext ? parentContext.traceFlags : 1);
        const spanContext = { traceId, spanId, traceFlags };
        return new Span(name, spanContext, parentSpanId, options.attributes ?? {}, (span) => this.exporter.export(span));
    }
    startRequestSpan(carrier, httpMethod, path) {
        const incomingContext = W3CTraceContextPropagator.extract(carrier);
        return this.startSpan('rlgw.request', {
            parentContext: incomingContext ?? undefined,
            attributes: {
                'http.method': httpMethod,
                'http.target': path,
                'component': 'rlgw'
            }
        });
    }
}
