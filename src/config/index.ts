export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
export const DEFAULT_FAIL_POLICY = 'fail-open';
export const DEFAULT_IDENTITY_ORDER = ['client-certificate', 'api-key', 'verified-user', 'ip'] as const;

export type FailurePolicy = 'fail-open' | 'fail-closed';
