import { DEFAULT_FAIL_POLICY, type FailurePolicy } from '../config/index.js';
import type { Decision } from '../algorithms/index.js';
import type { Identity, PolicyRule } from '../policy/rule.js';
import { type Clock, defaultClock } from '../time/clock.js';
import type { CounterStore, CounterEntry } from '../store/types.js';

export type ScopeKind = 'global' | 'client' | 'user' | 'ip' | 'route' | 'tenant' | 'endpoint-group';

export interface ScopeLimit {
  id: string;
  scope: ScopeKind;
  selector: string;
  limit: number;
  windowMs: number;
  algorithm?: 'fixed-window' | 'sliding-window' | 'token-bucket';
  failOpen?: boolean;
}

export interface ScopeRequest {
  rules?: ScopeLimit[];
  identity?: Identity;
  ip?: string;
  tenantId?: string;
  endpointGroup?: string;
  method?: string;
  route?: string;
  routeTemplate?: string;
  cost?: number;
  nowMs?: number;
}

export interface ScopeDecision extends Decision {
  scopeKey: string;
  selector: string;
  matchedScopes: string[];
  strictestScope: string;
}

function normalizeRouteTemplate(route: string): string {
  const sanitized = route.split('?')[0];
  const segments = sanitized.split('/').filter(Boolean);
  const normalized = segments.map((segment) => {
    if (segment === ':id' || segment.startsWith(':')) {
      return ':id';
    }
    if (/^\d+$/.test(segment) || /^[0-9a-fA-F-]{8,}$/.test(segment)) {
      return ':id';
    }
    return segment;
  });

  return normalized.length === 0 ? '/' : `/${normalized.join('/')}`;
}

function buildRouteScopeKey(method: string, route: string, routeTemplate?: string): string {
  const normalizedRoute = normalizeRouteTemplate(routeTemplate ?? route);
  return `route:${method.toUpperCase()}:${normalizedRoute}`;
}

function normalizeSelectorValue(value: string): string {
  return value.replace(/^.*:/, '').trim();
}

function matchesSelector(selector: string, value: string): boolean {
  if (!selector || !value) {
    return false;
  }

  const selectorValue = normalizeSelectorValue(selector);
  const valueTail = normalizeSelectorValue(value);

  return selector === value
    || selector === valueTail
    || value === selectorValue
    || selectorValue === valueTail
    || selectorValue === value
    || valueTail === selector;
}

function matchesRouteSelector(selector: string, method: string, route: string, routeTemplate?: string): boolean {
  if (!selector) {
    return false;
  }

  const normalizedRoute = normalizeRouteTemplate(routeTemplate ?? route);
  const normalized = buildRouteScopeKey(method, route, routeTemplate);
  const methodRouteSelector = `${method.toUpperCase()}:${normalizedRoute}`;
  const selectorKey = selector.startsWith('route:') ? selector : `route:${method.toUpperCase()}:${selector}`;
  return selector === normalized
    || selectorKey === normalized
    || selector === methodRouteSelector
    || selector === normalizedRoute
    || selector === `route:${methodRouteSelector}`;
}

function asCounterCount(value: CounterEntry | number | undefined): number {
  if (typeof value === 'number') {
    return value;
  }

  return value?.count ?? 0;
}

export class RateLimiter {
  public readonly store: CounterStore;
  private readonly defaultPolicy: FailurePolicy;

  constructor(store: CounterStore, defaultPolicy: FailurePolicy = DEFAULT_FAIL_POLICY) {
    this.store = store;
    this.defaultPolicy = defaultPolicy;
  }

  async check(
    key: string,
    cost: number,
    range: PolicyRule,
    clock: Clock,
    policyId = range.id,
    ruleId = range.id,
    scope = range.scope
  ): Promise<Decision> {
    const nowMs = clock.nowMs();
    const current = await this.store.get(key, nowMs);
    const count = typeof current === 'number' ? current : current?.count ?? 0;
    const remaining = Math.max(0, range.limit - (count + cost));
    const allowed = count + cost <= range.limit;

    if (allowed) {
      await this.store.increment(key, cost, nowMs);
    }

    return {
      allowed,
      limit: range.limit,
      remaining,
      resetMs: nowMs + range.windowMs,
      retryAfterMs: allowed ? 0 : Math.max(0, range.windowMs),
      policyId,
      ruleId,
      scope,
      reason: allowed ? 'within-limit' : 'limit-exceeded'
    };
  }
}

export class ScopeRateLimiter extends RateLimiter {
  constructor(store: CounterStore, clock?: Clock, defaultPolicy: FailurePolicy = DEFAULT_FAIL_POLICY) {
    super(store, defaultPolicy);
    this.clock = clock ?? defaultClock;
  }

  private readonly clock: Clock;

  private resolveScopeKey(rule: ScopeLimit, request: ScopeRequest): string {
    const { identity, ip, tenantId, endpointGroup, method = 'GET', route = '/', routeTemplate } = request;

    switch (rule.scope) {
      case 'global':
        return 'global';
      case 'client': {
        const candidate = identity?.kind === 'client-certificate' || identity?.kind === 'api-key'
          ? identity.value
          : identity?.namespace && identity.value
            ? `${identity.namespace}:${identity.value}`
            : rule.selector;
        return `client:${candidate}`.replace(/:$/, '');
      }
      case 'user': {
        const userValue = identity && (identity.kind === 'user' || identity.kind === 'verified-user') ? identity.value : undefined;
        return userValue ? `user:${userValue}` : `user:${rule.selector}`;
      }
      case 'ip': {
        const ipValue = ip ?? (identity?.kind === 'ip' ? identity.value : undefined) ?? 'anonymous';
        return `ip:${ipValue}`;
      }
      case 'route': {
        return buildRouteScopeKey(method, route, routeTemplate);
      }
      case 'tenant': {
        return tenantId ? `tenant:${tenantId}` : `tenant:${rule.selector}`;
      }
      case 'endpoint-group': {
        return endpointGroup ? `endpoint-group:${endpointGroup}` : `endpoint-group:${rule.selector}`;
      }
      default:
        return rule.selector;
    }
  }

  private collectApplicableRules(request: ScopeRequest): ScopeLimit[] {
    const { identity, ip, tenantId, endpointGroup, method = 'GET', route = '/', routeTemplate, rules = [] } = request;

    return rules.filter((rule) => {
      const selector = rule.selector ?? '';
      const normalizedValue = rule.scope === 'route' ? buildRouteScopeKey(method, route, routeTemplate) : undefined;

      switch (rule.scope) {
        case 'global':
          return selector === 'global' || selector === 'shared';
        case 'client': {
          if (!(identity && (identity.kind === 'client-certificate' || identity.kind === 'api-key'))) {
            return false;
          }
          const key = `client:${identity.value}`;
          return matchesSelector(selector, key) || selector === identity.value || matchesSelector(selector, `client:${identity.namespace ?? ''}:${identity.value}`);
        }
        case 'user': {
          if (!(identity && (identity.kind === 'user' || identity.kind === 'verified-user'))) {
            return false;
          }
          const key = `user:${identity.value}`;
          return matchesSelector(selector, key) || selector === identity.value;
        }
        case 'ip': {
          const ipValue = ip ?? (identity?.kind === 'ip' ? identity.value : undefined) ?? 'anonymous';
          const key = `ip:${ipValue}`;
          return matchesSelector(selector, key) || selector === ipValue;
        }
        case 'route': {
          return matchesRouteSelector(selector, method, route, routeTemplate) || selector === normalizedValue;
        }
        case 'tenant': {
          if (!tenantId) {
            return false;
          }
          return matchesSelector(selector, `tenant:${tenantId}`) || selector === tenantId;
        }
        case 'endpoint-group': {
          if (!endpointGroup) {
            return false;
          }
          return matchesSelector(selector, `endpoint-group:${endpointGroup}`) || selector === endpointGroup;
        }
        default:
          return false;
      }
    });
  }

  async checkScopes(request: ScopeRequest): Promise<ScopeDecision> {
    const { cost = 1, nowMs = this.clock.nowMs(), rules = [] } = request;
    const applicableRules = this.collectApplicableRules({ ...request, rules });

    if (applicableRules.length === 0) {
      return {
        allowed: true,
        limit: 0,
        remaining: 0,
        resetMs: nowMs,
        retryAfterMs: 0,
        policyId: 'none',
        ruleId: 'none',
        scope: 'global',
        scopeKey: 'none',
        selector: 'none',
        matchedScopes: [],
        strictestScope: 'none',
        reason: 'no-applicable-scope'
      };
    }

    const evaluated = await Promise.all(
      applicableRules.map(async (rule) => {
        const scopeKey = this.resolveScopeKey(rule, request);
        const current = await this.store.get(scopeKey, nowMs);
        const count = asCounterCount(current);
        const next = count + cost;
        const allowed = next <= rule.limit;

        return {
          rule,
          scopeKey,
          selector: rule.selector,
          current,
          count,
          next,
          allowed,
          remaining: Math.max(0, rule.limit - next),
          retryAfterMs: allowed ? 0 : Math.max(0, rule.windowMs),
          resetMs: nowMs + rule.windowMs,
          ratio: next / rule.limit
        };
      })
    );

    const priority = (scope: ScopeKind): number => ({
      global: 0,
      'endpoint-group': 1,
      tenant: 2,
      route: 3,
      ip: 4,
      client: 5,
      user: 6
    }[scope] ?? 0);

    const strictest = evaluated.reduce((best, current) => {
      if (current.ratio > best.ratio) {
        return current;
      }

      if (current.ratio === best.ratio && priority(current.rule.scope) > priority(best.rule.scope)) {
        return current;
      }

      return best;
    });

    if (!strictest.allowed) {
      return {
        allowed: false,
        limit: strictest.rule.limit,
        remaining: strictest.remaining,
        resetMs: strictest.resetMs,
        retryAfterMs: strictest.retryAfterMs,
        policyId: strictest.rule.id,
        ruleId: strictest.rule.id,
        scope: strictest.rule.scope,
        scopeKey: strictest.scopeKey,
        selector: strictest.selector,
        matchedScopes: evaluated.map((entry) => entry.scopeKey),
        strictestScope: strictest.rule.scope,
        reason: 'limit-exceeded'
      };
    }

    const pending = evaluated.map((entry) => ({
      key: entry.scopeKey,
      cost,
      nowMs
    }));

    try {
      await Promise.all(pending.map(async ({ key, cost: value, nowMs: when }) => {
        await this.store.increment(key, value, when);
      }));
    } catch (error) {
      await Promise.all(
        pending.map(async ({ key, cost: value, nowMs: when }) => {
          const previous = await this.store.get(key, when);
          const previousCount = asCounterCount(previous);
          if (previousCount >= value) {
            await this.store.increment(key, -value, when);
          }
        })
      );
      throw error;
    }

    return {
      allowed: true,
      limit: strictest.rule.limit,
      remaining: strictest.remaining,
      resetMs: strictest.resetMs,
      retryAfterMs: 0,
      policyId: strictest.rule.id,
      ruleId: strictest.rule.id,
      scope: strictest.rule.scope,
      scopeKey: strictest.scopeKey,
      selector: strictest.selector,
      matchedScopes: evaluated.map((entry) => entry.scopeKey),
      strictestScope: strictest.rule.scope,
      reason: 'within-limit'
    };
  }
}

