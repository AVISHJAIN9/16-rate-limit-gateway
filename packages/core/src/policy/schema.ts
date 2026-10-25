import { z } from 'zod';

export const AlgorithmTypeSchema = z.enum([
  'token_bucket',
  'leaky_bucket',
  'fixed_window',
  'sliding_window_log',
  'sliding_window_counter',
  'gcra'
]);

export const TokenBucketParamsSchema = z.object({
  type: z.literal('token_bucket'),
  capacity: z.number().positive(),
  refillRate: z.number().nonnegative()
});

export const LeakyBucketParamsSchema = z.object({
  type: z.literal('leaky_bucket'),
  capacity: z.number().positive(),
  leakRate: z.number().positive(),
  variant: z.enum(['policing', 'shaping']).optional()
});

export const FixedWindowParamsSchema = z.object({
  type: z.literal('fixed_window'),
  limit: z.number().int().positive(),
  windowMs: z.number().int().positive()
});

export const SlidingWindowLogParamsSchema = z.object({
  type: z.literal('sliding_window_log'),
  limit: z.number().int().positive(),
  windowMs: z.number().int().positive(),
  maxEntries: z.number().int().positive().optional()
});

export const SlidingWindowCounterParamsSchema = z.object({
  type: z.literal('sliding_window_counter'),
  limit: z.number().int().positive(),
  windowMs: z.number().int().positive()
});

export const GCRAParamsSchema = z.object({
  type: z.literal('gcra'),
  capacity: z.number().int().positive(),
  ratePerSecond: z.number().positive()
});

export const AlgorithmSpecSchema = z.discriminatedUnion('type', [
  TokenBucketParamsSchema,
  LeakyBucketParamsSchema,
  FixedWindowParamsSchema,
  SlidingWindowLogParamsSchema,
  SlidingWindowCounterParamsSchema,
  GCRAParamsSchema
]);

export const FailModeSchema = z.enum(['fail_open', 'fail_closed', 'degrade_local']);

export const CostSpecSchema = z.object({
  static: z.number().int().positive().optional(),
  headerHint: z.string().optional(),
  bodySizeFactor: z.number().positive().optional(),
  routeMultiplier: z.record(z.string(), z.number().positive()).optional(),
  maxCost: z.number().int().positive().optional(),
  minCost: z.number().int().positive().optional()
});

export const RejectionTemplateSchema = z.object({
  status: z.number().int().min(400).max(599).optional(),
  contentType: z.enum(['application/json', 'application/problem+json', 'text/plain', 'text/html']).optional(),
  body: z.string().optional()
});

export const PolicyMatchSchema = z.object({
  methods: z.array(z.string()).optional(),
  route: z.string().min(1),
  host: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  identity: z.record(z.string(), z.string()).optional()
});

export const PolicySchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  env: z.string().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  match: PolicyMatchSchema,
  algorithm: AlgorithmTypeSchema,
  params: AlgorithmSpecSchema,
  priority: z.number().int().default(0),
  terminalDeny: z.boolean().optional(),
  failMode: FailModeSchema.default('fail_closed'),
  rejectionTemplate: RejectionTemplateSchema.optional(),
  cost: CostSpecSchema.optional(),
  enabled: z.boolean().default(true),
  parentId: z.string().optional()
});

export const PoliciesConfigSchema = z.object({
  version: z.string().optional(),
  policies: z.array(PolicySchema)
});

export type PolicyInput = z.input<typeof PolicySchema>;
export type PolicyOutput = z.output<typeof PolicySchema>;
