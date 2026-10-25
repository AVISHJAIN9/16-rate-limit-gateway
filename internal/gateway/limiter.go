package gateway

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/identity"
	"rlgw/internal/obs"
	"rlgw/internal/policy"
	"rlgw/internal/store"
)

type contextKey string

const (
	contextKeyIdentity contextKey = "rlgw.identity"
	contextKeyOutcome  contextKey = "rlgw.outcome"
	contextKeyRefundFn contextKey = "rlgw.refund"
)

// LimiterOptions configures the rate limiter engine and middleware.
type LimiterOptions struct {
	Store            store.Store
	SnapshotProvider func() *policy.PolicySnapshot
	Clock            clock.Clock
	Recorder         *obs.PrometheusRegistry
	HeaderParser     *HeaderParser
	HeaderEmitter    *HeaderEmitter
	TemplateRegistry *TemplateRegistry
	DefaultFailMode  string // "fail_closed", "fail_open", "degrade_local"
}

// LogRateLimiter limits warning logs on store errors to prevent disk/CPU exhaustion.
type LogRateLimiter struct {
	mu         sync.Mutex
	lastRefill time.Time
	tokens     float64
	rate       float64 // tokens per second
	burst      float64
	suppressed atomic.Int64
}

// NewLogRateLimiter creates a LogRateLimiter.
func NewLogRateLimiter(rate, burst float64) *LogRateLimiter {
	return &LogRateLimiter{
		lastRefill: time.Now(),
		tokens:     burst,
		rate:       rate,
		burst:      burst,
	}
}

// Allow reports whether a log entry should be emitted.
func (l *LogRateLimiter) Allow() (bool, int64) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(l.lastRefill).Seconds()
	l.lastRefill = now
	l.tokens = math.Min(l.burst, l.tokens+elapsed*l.rate)

	if l.tokens >= 1.0 {
		l.tokens -= 1.0
		sup := l.suppressed.Swap(0)
		return true, sup
	}

	l.suppressed.Add(1)
	return false, 0
}

// RateLimiter implements multi-policy request interception with two-phase decide.
type RateLimiter struct {
	opts       LimiterOptions
	logLimiter *LogRateLimiter

	// Local fallback map for degrade_local mode
	fallbackMu sync.Mutex
	fallback   map[string]*localBucket
}

type localBucket struct {
	lastRefill time.Time
	tokens     float64
}

// NewRateLimiter creates an initialized RateLimiter.
func NewRateLimiter(opts LimiterOptions) *RateLimiter {
	if opts.Clock == nil {
		opts.Clock = clock.NewRealClock()
	}
	if opts.DefaultFailMode == "" {
		opts.DefaultFailMode = "fail_closed"
	}
	if opts.HeaderEmitter == nil {
		opts.HeaderEmitter = NewHeaderEmitter(HeaderFormatBoth, opts.Clock)
	}
	if opts.TemplateRegistry == nil {
		opts.TemplateRegistry = NewTemplateRegistry()
	}

	return &RateLimiter{
		opts:       opts,
		logLimiter: NewLogRateLimiter(1.0, 5.0), // Max 1 log/sec, burst 5
		fallback:   make(map[string]*localBucket),
	}
}

// Intercept executes two-phase decide across all matching policies for req.
// Returns (allowed bool, outcome *PolicyDecisionOutcome, refundFunc func()).
func (rl *RateLimiter) Intercept(ctx context.Context, req *http.Request, id *identity.Identity) (bool, *PolicyDecisionOutcome, func(), error) {
	snap := rl.opts.SnapshotProvider()
	if snap == nil {
		// No policies loaded: allow through
		return true, nil, nil, nil
	}

	// 1. Build route request
	routeReq := policy.RouteRequest{
		Method:  req.Method,
		Path:    req.URL.Path,
		Host:    req.Host,
		Headers: make(map[string]string, len(req.Header)),
	}
	for k, v := range req.Header {
		if len(v) > 0 {
			routeReq.Headers[k] = v[0]
		}
	}

	// 2. Resolve matching policies ordered by priority (F55, F63)
	resolved, err := snap.Resolve(routeReq, id.ToRequestIdentity())
	if err != nil {
		return false, nil, nil, err
	}
	if len(resolved) == 0 {
		// No matching policies: allow
		return true, nil, nil, nil
	}

	now := rl.opts.Clock.Now()

	// Filter active policies and check for terminal denies
	var active []policy.ResolvedPolicy
	for _, rp := range resolved {
		if rp.Deny {
			// Terminal short-circuit deny
			outcome := &PolicyDecisionOutcome{
				PolicyID: rp.Policy.ID,
				Tenant:   rp.Policy.Tenant,
				Limit:    rp.Policy.Limit,
				Window:   rp.Policy.Window,
				Decision: store.Decision{
					Allowed:        false,
					ViolatedPolicy: rp.Policy.ID,
				},
				RetryAfter: rp.Policy.Window,
			}
			return false, outcome, nil, nil
		}
		if !rp.Skip {
			active = append(active, rp)
		}
	}

	if len(active) == 0 {
		return true, nil, nil, nil
	}

	outcomes := make([]PolicyDecisionOutcome, len(active))

	// -------------------------------------------------------------------------
	// PHASE 1: PEEK ALL MATCHING POLICIES (Zero Quota Consumption)
	// Guarantees that if policy B rejects, policy A's counter is never touched!
	// -------------------------------------------------------------------------
	for i, rp := range active {
		spec := store.AlgoSpec{
			Algorithm: string(rp.Policy.Algorithm),
			Limit:     rp.Policy.Limit,
			Window:    rp.Policy.Window,
			Burst:     rp.Policy.Burst,
		}

		peekDec, err := rl.opts.Store.Peek(ctx, rp.BinaryKey, spec, now)
		if err != nil {
			// Store error: apply policy FailMode
			allowed, dec := rl.handleStoreError(ctx, rp.Policy, err)
			peekDec = dec
			if !allowed {
				outcomes[i] = PolicyDecisionOutcome{
					PolicyID:   rp.Policy.ID,
					Tenant:     rp.Policy.Tenant,
					Limit:      rp.Policy.Limit,
					Window:     rp.Policy.Window,
					Decision:   peekDec,
					RetryAfter: peekDec.RetryAfter,
				}
				return false, &outcomes[i], nil, nil
			}
		}

		retryAfter := peekDec.RetryAfter
		if retryAfter <= 0 && !peekDec.Allowed {
			if peekDec.ResetAfter > 0 {
				retryAfter = peekDec.ResetAfter
			} else {
				retryAfter = rp.Policy.Window
			}
		}

		outcomes[i] = PolicyDecisionOutcome{
			PolicyID:   rp.Policy.ID,
			Tenant:     rp.Policy.Tenant,
			Limit:      rp.Policy.Limit,
			Window:     rp.Policy.Window,
			Decision:   peekDec,
			RetryAfter: retryAfter,
		}

		if !peekDec.Allowed {
			// Rejection in Phase 1: Halt immediately. No counters have been debited!
			rl.recordDecision(ctx, rp.Policy, false, rp.Cost)
			return false, &outcomes[i], nil, nil
		}
	}

	// -------------------------------------------------------------------------
	// PHASE 2: COMMIT SEQUENTIALLY WITH REFUND ROLLBACK ON RACE
	// -------------------------------------------------------------------------
	committed := make([]committedPolicy, 0, len(active))

	for i, rp := range active {
		spec := store.AlgoSpec{
			Algorithm: string(rp.Policy.Algorithm),
			Limit:     rp.Policy.Limit,
			Window:    rp.Policy.Window,
			Burst:     rp.Policy.Burst,
		}

		dec, err := rl.opts.Store.Decide(ctx, rp.BinaryKey, spec, rp.Cost, now)
		if err != nil {
			allowed, fallbackDec := rl.handleStoreError(ctx, rp.Policy, err)
			dec = fallbackDec
			if !allowed {
				// Rollback previously committed policies
				rl.rollbackCommitted(ctx, committed, now)
				outcomes[i].Decision = dec
				outcomes[i].RetryAfter = dec.RetryAfter
				return false, &outcomes[i], nil, nil
			}
		}

		outcomes[i].Decision = dec
		outcomes[i].RetryAfter = dec.RetryAfter

		if !dec.Allowed {
			// Concurrent race: quota depleted between Peek and Decide!
			// Rollback all previously committed policies so counters don't leak!
			rl.rollbackCommitted(ctx, committed, now)
			rl.recordDecision(ctx, rp.Policy, false, rp.Cost)
			return false, &outcomes[i], nil, nil
		}

		committed = append(committed, committedPolicy{
			key:  rp.BinaryKey,
			spec: spec,
			cost: rp.Cost,
		})
		rl.recordDecision(ctx, rp.Policy, true, rp.Cost)
	}

	// Construct refund function if circuit breaker or downstream trips
	refundFunc := func() {
		rl.rollbackCommitted(context.Background(), committed, rl.opts.Clock.Now())
	}

	// Select most constraining outcome to report in response headers
	mostConstraining := SelectMostConstraining(outcomes)
	return true, mostConstraining, refundFunc, nil
}

type committedPolicy struct {
	key  []byte
	spec store.AlgoSpec
	cost int64
}

func (rl *RateLimiter) rollbackCommitted(ctx context.Context, committed []committedPolicy, now time.Time) {
	for _, c := range committed {
		_ = rl.opts.Store.Refund(ctx, c.key, c.spec, c.cost, now)
	}
}

// handleStoreError handles fail_open, fail_closed, and degrade_local semantics.
func (rl *RateLimiter) handleStoreError(ctx context.Context, p policy.Policy, err error) (bool, store.Decision) {
	mode := p.FailMode
	if mode == "" {
		mode = rl.opts.DefaultFailMode
	}

	switch mode {
	case "fail_open":
		// Log at WARN with log rate-limiting to prevent log spamming
		if allow, suppressed := rl.logLimiter.Allow(); allow {
			if suppressed > 0 {
				slog.Warn("Rate limiter store error, failing open (rate-limited log)", "policy", p.ID, "tenant", p.Tenant, "error", err, "suppressed_logs", suppressed)
			} else {
				slog.Warn("Rate limiter store error, failing open", "policy", p.ID, "tenant", p.Tenant, "error", err)
			}
		}
		if rl.opts.Recorder != nil {
			rl.opts.Recorder.RecordFailOpen(p.ID)
		}
		return true, store.Decision{
			Allowed:   true,
			Remaining: 1,
		}

	case "degrade_local":
		// Degrade to local approximate in-memory token bucket
		return rl.degradeLocal(p)

	default: // "fail_closed"
		slog.Error("Rate limiter store error, failing closed", "policy", p.ID, "error", err)
		return false, store.Decision{
			Allowed:        false,
			ViolatedPolicy: p.ID,
			RetryAfter:     5 * time.Second,
		}
	}
}

func (rl *RateLimiter) degradeLocal(p policy.Policy) (bool, store.Decision) {
	rl.fallbackMu.Lock()
	defer rl.fallbackMu.Unlock()

	now := rl.opts.Clock.Now()
	b, ok := rl.fallback[p.ID]
	if !ok {
		b = &localBucket{
			lastRefill: now,
			tokens:     float64(p.Limit),
		}
		rl.fallback[p.ID] = b
	}

	fillRate := float64(p.Limit) / p.Window.Seconds()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.lastRefill = now
	b.tokens = math.Min(float64(p.Limit), b.tokens+elapsed*fillRate)

	if b.tokens >= 1.0 {
		b.tokens -= 1.0
		return true, store.Decision{
			Allowed:   true,
			Remaining: int64(b.tokens),
		}
	}

	return false, store.Decision{
		Allowed:        false,
		ViolatedPolicy: p.ID,
		RetryAfter:     time.Duration(1.0/fillRate) * time.Second,
	}
}

func (rl *RateLimiter) recordDecision(ctx context.Context, p policy.Policy, allowed bool, cost int64) {
	if rl.opts.Recorder != nil {
		rl.opts.Recorder.RecordDecision(ctx, obs.DecisionRecord{
			PolicyID: p.ID,
			Tenant:   p.Tenant,
			Scope:    string(p.Scope),
			Allowed:  allowed,
			Cost:     cost,
		})
	}
}

// ServeHTTPOrDeny evaluates the rate limit and either forwards to next handler or writes rejection.
func (rl *RateLimiter) ServeHTTPOrDeny(w http.ResponseWriter, req *http.Request, id *identity.Identity, next http.Handler) {
	allowed, outcome, refundFunc, err := rl.Intercept(req.Context(), req, id)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"internal_error","message":%q}`, err.Error())))
		return
	}

	if !allowed {
		// Rate limit exhausted (429) or terminal deny
		rl.opts.HeaderEmitter.WriteResponseHeaders(w, id.Tenant, outcome)

		// Render custom rejection body
		vars := TemplateVariables{
			RetryAfter: int64(math.Ceil(outcome.RetryAfter.Seconds())),
			Limit:      outcome.Limit,
			Remaining:  outcome.Decision.Remaining,
			Reset:      int64(math.Ceil(outcome.Decision.ResetAfter.Seconds())),
			Policy:     outcome.PolicyID,
			RequestID:  req.Header.Get("X-Request-Id"),
			ClientID:   id.ClientID,
			Tenant:     id.Tenant,
		}

		bodyTemplateID := ""
		// If policy specified a custom template, use it
		snap := rl.opts.SnapshotProvider()
		if snap != nil {
			if ep, ok := snap.EffectivePolicies[outcome.PolicyID]; ok {
				bodyTemplateID = ep.Policy.OnReject.BodyTemplateID
			}
		}

		body, ctype := rl.opts.TemplateRegistry.RenderNegotiated(bodyTemplateID, req.Header.Get("Accept"), vars)
		w.Header().Set("Content-Type", ctype)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write(body)
		return
	}

	// Allowed: Write rate limit headers on response
	if outcome != nil {
		rl.opts.HeaderEmitter.WriteResponseHeaders(w, id.Tenant, outcome)
	}

	// Store refundFunc in request context if needed by circuit breaker/proxy
	ctx := context.WithValue(req.Context(), contextKeyRefundFn, refundFunc)
	next.ServeHTTP(w, req.WithContext(ctx))
}
