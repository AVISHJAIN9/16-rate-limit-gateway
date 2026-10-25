import { z } from 'zod';
import fs from 'node:fs';
import yaml from 'yaml';
export const ListenerConfigSchema = z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string().default('0.0.0.0'),
    headersTimeout: z.number().int().default(5000),
    requestTimeout: z.number().int().default(15000),
    keepAliveTimeout: z.number().int().default(60000),
    maxHeaderSize: z.number().int().default(16384),
    maxRequestsPerSocket: z.number().int().default(1000),
    http2: z.boolean().default(false),
    tls: z
        .object({
        cert: z.string(),
        key: z.string()
    })
        .optional(),
    maxConnectionsPerIp: z.number().int().default(50).optional(),
    minBodyTransferRateBytesPerSec: z.number().int().default(1024).optional()
});
export const UpstreamTargetSchema = z.object({
    url: z.string().url(),
    weight: z.number().int().positive().default(1)
});
export const UpstreamRouteSchema = z.object({
    pathPrefix: z.string().min(1),
    stripPrefix: z.string().optional(),
    targets: z.array(UpstreamTargetSchema).min(1),
    timeoutMs: z.number().int().default(5000),
    strategy: z.enum(['round-robin', 'least-connections']).default('round-robin').optional(),
    healthCheck: z
        .object({
        path: z.string().default('/healthz'),
        intervalMs: z.number().int().positive().default(5000),
        timeoutMs: z.number().int().positive().default(1000),
        unhealthyThreshold: z.number().int().positive().default(3),
        healthyThreshold: z.number().int().positive().default(2)
    })
        .optional(),
    circuitBreaker: z
        .object({
        failureThresholdRatio: z.number().min(0).max(1).default(0.5),
        minimumRequests: z.number().int().default(10),
        openDurationMs: z.number().int().default(10000),
        halfOpenProbes: z.number().int().default(3)
    })
        .optional()
});
export const StoreConfigSchema = z.object({
    type: z.enum(['memory', 'redis']),
    redis: z
        .object({
        url: z.string().default('redis://127.0.0.1:6379'),
        cluster: z.boolean().default(false),
        connectTimeoutMs: z.number().int().default(2000),
        commandTimeoutMs: z.number().int().default(500)
    })
        .optional(),
    memory: z
        .object({
        maxKeys: z.number().int().default(100000),
        ttlMs: z.number().int().default(3600000)
    })
        .optional()
});
export const PolicySourceConfigSchema = z.object({
    type: z.enum(['file', 'mongo', 'memory']),
    filePath: z.string().optional(),
    watch: z.boolean().default(false),
    mongoUri: z.string().optional()
});
export const TrustConfigSchema = z.object({
    trustedProxies: z.array(z.string()).default(['127.0.0.1', '::1']),
    trustForwardedHeaders: z.boolean().default(false),
    clientIpHeader: z.string().default('X-Forwarded-For')
});
export const AdminAuthConfigSchema = z.object({
    type: z.enum(['static_token', 'jwt', 'none']).default('static_token'),
    staticToken: z.string().optional(),
    jwtSecret: z.string().optional()
});
export const ObservabilityConfigSchema = z.object({
    metricsPort: z.number().int().optional(),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    decisionLogBufferCapacity: z.number().int().default(10000),
    sampleRate: z.number().min(0).max(1).default(1.0)
});
export const GatewayConfigSchema = z.object({
    version: z.string().default('1.0'),
    dataListener: ListenerConfigSchema,
    adminListener: ListenerConfigSchema,
    upstreams: z.array(UpstreamRouteSchema).default([]),
    store: StoreConfigSchema,
    policySource: PolicySourceConfigSchema,
    failMode: z.enum(['fail_open', 'fail_closed', 'degrade_local']).default('fail_open'),
    trust: TrustConfigSchema.default({
        trustedProxies: ['127.0.0.1', '::1'],
        trustForwardedHeaders: false,
        clientIpHeader: 'X-Forwarded-For'
    }),
    adminAuth: AdminAuthConfigSchema.default({
        type: 'static_token'
    }),
    observability: ObservabilityConfigSchema.default({
        logLevel: 'info',
        decisionLogBufferCapacity: 10000,
        sampleRate: 1.0
    })
});
export class GatewayConfigValidator {
    static validate(raw) {
        const result = GatewayConfigSchema.safeParse(raw);
        if (result.success) {
            return { valid: true, config: result.data };
        }
        const issues = result.error.issues ?? result.error.errors ?? [];
        const errors = issues.map((err) => `${err.path ? err.path.join('.') : 'field'}: ${err.message}`);
        return { valid: false, errors };
    }
    static loadFromFile(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Configuration file does not exist: ${filePath}`);
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = yaml.parse(content);
        const { valid, config, errors } = GatewayConfigValidator.validate(parsed);
        if (!valid || !config) {
            throw new Error(`Invalid gateway configuration:\n  - ${errors?.join('\n  - ')}`);
        }
        return config;
    }
}
