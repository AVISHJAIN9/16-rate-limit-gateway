package algo

import (
	"time"
)

// TokenBucketState represents the immutable state of a token bucket.
type TokenBucketState struct {
	TokensNano   int64 // Available tokens scaled by NanoScale (1e9)
	LastRefillNs int64 // Monotonic nanoseconds of last refill
	Initialized  bool  // Whether the state has been populated
}

// TokenBucketStep performs a pure state transition for the Token Bucket algorithm (F16).
// Zero heap allocations, purely deterministic arithmetic.
func TokenBucketStep(st TokenBucketState, p Params, cost int64, nowNs int64) (TokenBucketState, Decision) {
	burst := p.Burst
	if burst <= 0 {
		burst = p.Limit
	}
	maxTokensNano := burst * NanoScale
	windowNs := p.Window.Nanoseconds()

	// Initial bootstrap
	if !st.Initialized {
		st.TokensNano = maxTokensNano
		st.LastRefillNs = nowNs
		st.Initialized = true
	}

	// Validate cost invariants (F22)
	valid, permReject, reason := ValidateCost(cost, burst, p.AllowZeroCost)
	if !valid {
		dec := Decision{
			Allowed:      false,
			Remaining:    st.TokensNano / NanoScale,
			ResetAfter:   p.Window,
			CurrentUsage: (maxTokensNano - st.TokensNano) / NanoScale,
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       reason,
		}
		if permReject && reason == ReasonCostExceedsBurst {
			dec.RetryAfter = time.Duration(-1) // permanent rejection indicator
		}
		return st, dec
	}

	// Calculate refill using 128-bit overflow-safe math (F24)
	elapsedNs := nowNs - st.LastRefillNs
	if elapsedNs > 0 && windowNs > 0 {
		addedNano := SafeRefillNano(elapsedNs, p.Limit, windowNs)
		st.TokensNano += addedNano
		if st.TokensNano > maxTokensNano {
			st.TokensNano = maxTokensNano
		}
		st.LastRefillNs = nowNs
	} else if elapsedNs < 0 {
		// Clock skew occurred: keep tokens as-is, advance LastRefillNs to nowNs
		st.LastRefillNs = nowNs
	}

	costNano := cost * NanoScale
	if st.TokensNano >= costNano {
		st.TokensNano -= costNano
		rem := st.TokensNano / NanoScale
		return st, Decision{
			Allowed:      true,
			Remaining:    rem,
			ResetAfter:   time.Duration((maxTokensNano - st.TokensNano) * windowNs / (p.Limit * NanoScale)),
			RetryAfter:   0,
			CurrentUsage: (maxTokensNano - st.TokensNano) / NanoScale,
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       ReasonAllowed,
		}
	}

	// Insufficient tokens: calculate exact RetryAfter
	deficitNano := costNano - st.TokensNano
	retryNs := (deficitNano * windowNs) / (p.Limit * NanoScale)
	if retryNs == 0 {
		retryNs = 1
	}

	return st, Decision{
		Allowed:      false,
		Remaining:    st.TokensNano / NanoScale,
		ResetAfter:   time.Duration(maxTokensNano * windowNs / (p.Limit * NanoScale)),
		RetryAfter:   time.Duration(retryNs),
		CurrentUsage: (maxTokensNano - st.TokensNano) / NanoScale,
		Limit:        p.Limit,
		Burst:        burst,
		Reason:       ReasonQuotaExceeded,
	}
}

// TokenBucketRefund credits amount tokens back to the bucket state.
func TokenBucketRefund(st TokenBucketState, p Params, amount int64) TokenBucketState {
	if amount <= 0 || !st.Initialized {
		return st
	}
	burst := p.Burst
	if burst <= 0 {
		burst = p.Limit
	}
	maxTokensNano := burst * NanoScale
	st.TokensNano += amount * NanoScale
	if st.TokensNano > maxTokensNano {
		st.TokensNano = maxTokensNano
	}
	return st
}
