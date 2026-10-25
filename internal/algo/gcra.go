package algo

import (
	"time"
)

// GCRAState holds the Theoretical Arrival Time (TAT) in monotonic nanoseconds (F21).
type GCRAState struct {
	TATNs       int64 // Theoretical Arrival Time in nanoseconds
	Initialized bool
}

// GCRAStep evaluates the Generic Cell Rate Algorithm / Virtual Scheduling Algorithm (F21).
// Parameters:
// - Emission Interval T = window / limit
// - Burst Tolerance Tau = burst * T
// Invariants:
// - Decisions are mathematically exact.
// - Waiting exactly RetryAfter guarantees admission on retry; waiting less than RetryAfter guarantees rejection.
func GCRAStep(st GCRAState, p Params, cost int64, nowNs int64) (GCRAState, Decision) {
	burst := p.Burst
	if burst <= 0 {
		burst = p.Limit
	}
	limit := p.Limit
	if limit <= 0 {
		limit = 1
	}

	windowNs := p.Window.Nanoseconds()
	if windowNs <= 0 {
		windowNs = int64(time.Second)
	}

	// Emission interval T: time between individual requests under rate limit
	// Integer nanosecond precision:
	T := windowNs / limit
	if T <= 0 {
		T = 1
	}

	// Burst tolerance Tau: maximum burst accumulation time
	Tau := burst * T

	valid, permReject, reason := ValidateCost(cost, burst, p.AllowZeroCost)
	if !valid {
		dec := Decision{
			Allowed:      false,
			Remaining:    0,
			ResetAfter:   p.Window,
			CurrentUsage: 0,
			Limit:        limit,
			Burst:        burst,
			Reason:       reason,
		}
		if permReject && reason == ReasonCostExceedsBurst {
			dec.RetryAfter = time.Duration(-1)
		}
		return st, dec
	}

	// First cell initialization
	if !st.Initialized {
		st.TATNs = nowNs + (cost * T)
		st.Initialized = true
		return st, Decision{
			Allowed:      true,
			Remaining:    burst - cost,
			ResetAfter:   time.Duration(cost * T),
			RetryAfter:   0,
			CurrentUsage: cost,
			Limit:        limit,
			Burst:        burst,
			Reason:       ReasonAllowed,
		}
	}

	// Compute base arrival time
	tat := st.TATNs
	if nowNs > tat {
		tat = nowNs
	}

	increment := cost * T
	newTat := tat + increment

	// Admission test: if newTat - Tau <= nowNs + T (or tat - Tau <= nowNs)
	// Standard GCRA check: TAT - Tau <= nowNs
	if st.TATNs-Tau <= nowNs {
		st.TATNs = newTat

		// Remaining capacity in units: (nowNs - (newTat - Tau)) / T
		timeUntilFullBurst := st.TATNs - nowNs
		if timeUntilFullBurst < 0 {
			timeUntilFullBurst = 0
		}
		usedTokens := timeUntilFullBurst / T
		rem := burst - usedTokens
		if rem < 0 {
			rem = 0
		}

		return st, Decision{
			Allowed:      true,
			Remaining:    rem,
			ResetAfter:   time.Duration(timeUntilFullBurst),
			RetryAfter:   0,
			CurrentUsage: usedTokens,
			Limit:        limit,
			Burst:        burst,
			Reason:       ReasonAllowed,
		}
	}

	// Rate limit exceeded: calculate exact RetryAfter
	// The caller can be admitted as soon as: st.TATNs - Tau <= (nowNs + retryNs)
	retryNs := (st.TATNs - Tau) - nowNs
	if retryNs <= 0 {
		retryNs = 1
	}

	timeUntilReset := st.TATNs - nowNs
	if timeUntilReset < 0 {
		timeUntilReset = 0
	}

	return st, Decision{
		Allowed:      false,
		Remaining:    0,
		ResetAfter:   time.Duration(timeUntilReset),
		RetryAfter:   time.Duration(retryNs),
		CurrentUsage: burst,
		Limit:        limit,
		Burst:        burst,
		Reason:       ReasonQuotaExceeded,
	}
}

// GCRARefund rolls back TAT by (amount * T).
func GCRARefund(st GCRAState, p Params, amount int64) GCRAState {
	if amount <= 0 || !st.Initialized {
		return st
	}
	limit := p.Limit
	if limit <= 0 {
		limit = 1
	}
	T := p.Window.Nanoseconds() / limit
	if T <= 0 {
		T = 1
	}
	st.TATNs -= amount * T
	return st
}
