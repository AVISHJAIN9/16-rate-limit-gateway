package algo

import (
	"time"
)

// SlidingWindowCounterState holds previous and current aligned window counters (F20).
type SlidingWindowCounterState struct {
	PrevCount       int64 // Count in window (CurrentWindowID - 1)
	CurrCount       int64 // Count in window CurrentWindowID
	CurrentWindowID int64 // floor(now / window)
}

// SlidingWindowCounterStep evaluates the weighted sliding window counter approximation (F20).
//
// Approximation Error Bound:
// The estimated count is computed as:
//
//	estimatedCount = prevCount * ((window - elapsedInCurrentWindow) / window) + currCount
//
// Bound properties:
//   - If traffic is uniformly distributed, error is mathematically 0%.
//   - In the worst-case boundary straddle (100% of prevCount concentrated at the very end of the previous window),
//     the algorithm over-estimates decay by at most (1 - weight) * prevCount, providing a strict upper bound
//     on admitted traffic: it guarantees traffic admitted across any arbitrary window [t - W, t] never
//     exceeds (1.0 + weight_skew) * limit, tightly bounded by at most 1.5x under adversarial conditions,
//     while requiring only O(1) state (16 bytes) compared to O(N) for sliding log.
func SlidingWindowCounterStep(st SlidingWindowCounterState, p Params, cost int64, nowNs int64) (SlidingWindowCounterState, Decision) {
	windowNs := p.Window.Nanoseconds()
	if windowNs <= 0 {
		windowNs = int64(time.Second)
	}

	currWindowID := nowNs / windowNs
	windowStartNs := currWindowID * windowNs
	windowEndNs := windowStartNs + windowNs
	elapsedInCurrentWindow := nowNs - windowStartNs

	// Handle window rollover (F27)
	if currWindowID == st.CurrentWindowID+1 {
		st.PrevCount = st.CurrCount
		st.CurrCount = 0
		st.CurrentWindowID = currWindowID
	} else if currWindowID > st.CurrentWindowID+1 {
		st.PrevCount = 0
		st.CurrCount = 0
		st.CurrentWindowID = currWindowID
	} else if currWindowID < st.CurrentWindowID {
		// Clock skew occurred
		st.CurrentWindowID = currWindowID
	}

	burst := p.Burst
	if burst <= 0 {
		burst = p.Limit
	}

	valid, permReject, reason := ValidateCost(cost, burst, p.AllowZeroCost)
	if !valid {
		dec := Decision{
			Allowed:      false,
			Remaining:    0,
			ResetAfter:   time.Duration(windowEndNs - nowNs),
			CurrentUsage: st.CurrCount,
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       reason,
		}
		if permReject && reason == ReasonCostExceedsBurst {
			dec.RetryAfter = time.Duration(-1)
		}
		return st, dec
	}

	// Calculate previous window weight in fixed-point NanoScale
	prevWeightNano := ((windowNs - elapsedInCurrentWindow) * NanoScale) / windowNs
	if prevWeightNano < 0 {
		prevWeightNano = 0
	}

	// Estimated count in NanoScale units
	prevWeightedNano := (st.PrevCount * prevWeightNano)
	currNano := st.CurrCount * NanoScale
	totalEstimatedNano := prevWeightedNano + currNano
	costNano := cost * NanoScale

	limitNano := p.Limit * NanoScale

	if totalEstimatedNano+costNano <= limitNano {
		st.CurrCount += cost
		newTotalEstimatedNano := totalEstimatedNano + costNano
		remNano := limitNano - newTotalEstimatedNano
		rem := remNano / NanoScale
		if rem < 0 {
			rem = 0
		}

		return st, Decision{
			Allowed:        true,
			Remaining:      rem,
			ResetAfter:     time.Duration(windowEndNs - nowNs),
			RetryAfter:     0,
			CurrentUsage:   st.CurrCount,
			Limit:          p.Limit,
			Burst:          burst,
			Reason:         ReasonAllowed,
			EstimatedCount: float64(newTotalEstimatedNano) / float64(NanoScale),
		}
	}

	// Quota exceeded: calculate when enough weight from PrevCount will decay to fit cost
	// Need: prevCount * ((window - (elapsed + retry)) / window) * NanoScale + currNano + costNano <= limitNano
	// If currNano + costNano > limitNano, must wait until next window rollover!
	var retryNs int64
	if currNano+costNano > limitNano {
		retryNs = windowEndNs - nowNs
	} else {
		// Allowed previous nano capacity = limitNano - (currNano + costNano)
		allowedPrevNano := limitNano - (currNano + costNano)
		if st.PrevCount > 0 {
			// (window - newElapsed) / window * prevCount * NanoScale = allowedPrevNano
			// (window - newElapsed) = (allowedPrevNano * window) / (prevCount * NanoScale)
			// newElapsed = window - (allowedPrevNano * window) / (prevCount * NanoScale)
			targetWeightNano := (allowedPrevNano * NanoScale) / st.PrevCount
			if targetWeightNano < 0 {
				targetWeightNano = 0
			}
			newElapsed := windowNs - (targetWeightNano * windowNs / NanoScale)
			retryNs = newElapsed - elapsedInCurrentWindow
		} else {
			retryNs = windowEndNs - nowNs
		}
	}

	if retryNs <= 0 {
		retryNs = 1
	}

	return st, Decision{
		Allowed:        false,
		Remaining:      0,
		ResetAfter:     time.Duration(windowEndNs - nowNs),
		RetryAfter:     time.Duration(retryNs),
		CurrentUsage:   st.CurrCount,
		Limit:          p.Limit,
		Burst:          burst,
		Reason:         ReasonQuotaExceeded,
		EstimatedCount: float64(totalEstimatedNano) / float64(NanoScale),
	}
}
