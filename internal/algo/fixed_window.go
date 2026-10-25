package algo

import (
	"time"
)

// FixedWindowState tracks aligned window counters.
type FixedWindowState struct {
	Count    int64 // Requests consumed in current window
	WindowID int64 // floor(now / window)
}

// FixedWindowStep evaluates aligned fixed window rate limits (F18).
func FixedWindowStep(st FixedWindowState, p Params, cost int64, nowNs int64) (FixedWindowState, Decision) {
	windowNs := p.Window.Nanoseconds()
	if windowNs <= 0 {
		windowNs = int64(time.Second)
	}

	windowID := nowNs / windowNs
	windowEnd := (windowID + 1) * windowNs

	// Check window rollover (F27)
	if windowID != st.WindowID {
		st.Count = 0
		st.WindowID = windowID
	}

	burst := p.Burst
	if burst <= 0 {
		burst = p.Limit
	}

	valid, permReject, reason := ValidateCost(cost, burst, p.AllowZeroCost)
	if !valid {
		dec := Decision{
			Allowed:      false,
			Remaining:    p.Limit - st.Count,
			ResetAfter:   time.Duration(windowEnd - nowNs),
			CurrentUsage: st.Count,
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       reason,
		}
		if permReject && reason == ReasonCostExceedsBurst {
			dec.RetryAfter = time.Duration(-1)
		}
		return st, dec
	}

	timeRemaining := time.Duration(windowEnd - nowNs)
	if timeRemaining < 0 {
		timeRemaining = 0
	}

	if st.Count+cost <= p.Limit {
		st.Count += cost
		return st, Decision{
			Allowed:      true,
			Remaining:    p.Limit - st.Count,
			ResetAfter:   timeRemaining,
			RetryAfter:   0,
			CurrentUsage: st.Count,
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       ReasonAllowed,
		}
	}

	return st, Decision{
		Allowed:      false,
		Remaining:    0,
		ResetAfter:   timeRemaining,
		RetryAfter:   timeRemaining,
		CurrentUsage: st.Count,
		Limit:        p.Limit,
		Burst:        burst,
		Reason:       ReasonQuotaExceeded,
	}
}

// FixedWindowRefund refunds tokens in current window.
func FixedWindowRefund(st FixedWindowState, amount int64) FixedWindowState {
	if amount <= 0 {
		return st
	}
	st.Count -= amount
	if st.Count < 0 {
		st.Count = 0
	}
	return st
}
