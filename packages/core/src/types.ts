import type { Clock } from './clock.js';

export interface Identity {
  tenant: string;
  clientId: string;
  userId?: string;
  apiKeyId?: string;
  ip: string;
  source: string;
  [key: string]: any;
}

export type AlgorithmType =
  | 'token_bucket'
  | 'leaky_bucket'
  | 'fixed_window'
  | 'sliding_window_log'
  | 'sliding_window_counter'
  | 'gcra';

export interface TokenBucketParams {
  type: 'token_bucket';
  capacity: number; // burst capacity
  refillRate: number; // tokens per second
}

export interface LeakyBucketParams {
  type: 'leaky_bucket';
  capacity: number; // bucket capacity
  leakRate: number; // leak rate per second
  variant?: 'policing' | 'shaping'; // policing drops, shaping computes delay
}

export interface FixedWindowParams {
  type: 'fixed_window';
  limit: number;
  windowMs: number;
}

export interface SlidingWindowLogParams {
  type: 'sliding_window_log';
  limit: number;
  windowMs: number;
  maxEntries?: number;
}

export interface SlidingWindowCounterParams {
  type: 'sliding_window_counter';
  limit: number;
  windowMs: number;
}

export interface GCRAParams {
  type: 'gcra';
  capacity: number;
  ratePerSecond: number;
}

export type AlgorithmSpec =
  | TokenBucketParams
  | LeakyBucketParams
  | FixedWindowParams
  | SlidingWindowLogParams
  | SlidingWindowCounterParams
  | GCRAParams;

export type FailMode = 'fail_open' | 'fail_closed' | 'degrade_local';

export interface CostSpec {
  static?: number;
  headerHint?: string;
  bodySizeFactor?: number;
  routeMultiplier?: Record<string, number>;
  maxCost?: number;
  minCost?: number;
}

export interface RejectionTemplate {
  status?: number;
  contentType?: 'application/json' | 'application/problem+json' | 'text/plain' | 'text/html';
  body?: string;
}

export interface PolicyMatch {
  methods?: string[];
  route: string; // route template, e.g. /api/v1/users/:id or /api/v1/search/*
  host?: string;
  headers?: Record<string, string>;
  identity?: Record<string, string>;
}

export interface Policy {
  id: string;
  tenant: string;
  env?: string;
  labels?: Record<string, string>;
  match: PolicyMatch;
  algorithm: AlgorithmType;
  params: AlgorithmSpec;
  priority: number; // higher integer = higher evaluation priority
  terminalDeny?: boolean; // if true, short-circuits further policy evaluation immediately on deny
  failMode: FailMode;
  rejectionTemplate?: RejectionTemplate;
  cost?: CostSpec;
  enabled: boolean;
  parentId?: string; // inheritance parent ID
}

export interface Decision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
  policyId: string;
  reason: string;
  cost: number;
  burst?: number;
}

export interface LimiterStore {
  decide(key: string, spec: AlgorithmSpec, cost: number, nowMs: number): Promise<Decision>;
  peek(key: string, spec: AlgorithmSpec, nowMs: number, cost?: number): Promise<Decision>;
  refund(key: string, spec: AlgorithmSpec, cost: number, nowMs: number): Promise<void>;
  commit(key: string, spec: AlgorithmSpec, cost: number, nowMs: number): Promise<Decision>;
}

export interface RequestContext {
  requestId: string;
  traceId?: string;
  identity: Identity;
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  startTimeMs: number;
  clock: Clock;
}

export interface Recorder {
  onDecision(decision: Decision, ctx: RequestContext): void;
  onStoreLatency(backend: string, operation: string, durationMs: number): void;
  onRedisCmd(command: string, durationMs: number, err?: Error): void;
  onBreakerState(upstreamId: string, state: 'closed' | 'open' | 'half_open'): void;
  onStageLatency(stage: string, durationMs: number): void;
  onFailOpen(policyId: string, error: Error): void;
  onDropDecisionLog?(): void;
}

export {
  KeyBuilder,
  type KeyBuilderConfig as KeyBuilderOptions,
  type KeyComponents,
  BinaryKeyWireVersion,
} from './identity/keybuilder.js';

export interface TrustedProxyChecker {
  isTrusted(ip: string): boolean;
}

export interface KeyLookup {
  lookup(keyId: string): Promise<any | null>;
}

export interface Authorizer {
  isAllowed(actor: any, action: string, resource: any): Promise<boolean>;
}

export interface AdminUser {
  id: string;
  username: string;
  roles: string[];
  tenant?: string;
}

export interface AdminAuthenticator {
  authenticate(authHeaderOrToken?: string): Promise<AdminUser | null>;
}
