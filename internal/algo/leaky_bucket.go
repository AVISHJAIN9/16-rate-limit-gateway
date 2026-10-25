package algo

import (
	"time"
)

// LeakyBucketState represents the state of a leaky bucket.
type LeakyBucketState struct {
	LevelNano   int64 // Current water/queue depth in NanoScale units
	LastDrainNs int64 // Monotonic timestamp of last drain
	Initialized bool
}

// LeakyBucketStep evaluates Leaky Bucket in meter mode with queue-depth reporting (F17).
func LeakyBucketStep(st LeakyBucketState, p Params, cost int64, nowNs int64) (LeakyBucketState, Decision) {
	burst := p.Burst
	if burst <= 0 {
		burst = p.Limit
	}
	capacityNano := burst * NanoScale
	windowNs := p.Window.Nanoseconds()

	if !st.Initialized {
		st.LevelNano = 0
		st.LastDrainNs = nowNs
		st.Initialized = true
	}

	valid, permReject, reason := ValidateCost(cost, burst, p.AllowZeroCost)
	if !valid {
		dec := Decision{
			Allowed:      false,
			Remaining:    (capacityNano - st.LevelNano) / NanoScale,
			ResetAfter:   time.Duration(st.LevelNano * windowNs / (p.Limit * NanoScale)),
			CurrentUsage: st.LevelNano / NanoScale,
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       reason,
			QueueDepth:   st.LevelNano / NanoScale,
		}
		if permReject && reason == ReasonCostExceedsBurst {
			dec.RetryAfter = time.Duration(-1)
		}
		return st, dec
	}

	// Drain bucket based on elapsed monotonic nanoseconds
	elapsedNs := nowNs - st.LastDrainNs
	if elapsedNs > 0 && windowNs > 0 {
		drainedNano := SafeRefillNano(elapsedNs, p.Limit, windowNs)
		st.LevelNano -= drainedNano
		if st.LevelNano < 0 {
			st.LevelNano = 0
		}
		st.LastDrainNs = nowNs
	} else if elapsedNs < 0 {
		st.LastDrainNs = nowNs
	}

	costNano := cost * NanoScale
	if st.LevelNano+costNano <= capacityNano {
		st.LevelNano += costNano
		timeToEmpty := time.Duration(st.LevelNano * windowNs / (p.Limit * NanoScale))
		rem := (capacityNano - st.LevelNano) / NanoScale
		return st, Decision{
			Allowed:      true,
			Remaining:    rem,
			ResetAfter:   timeToEmpty,
			RetryAfter:   0,
			CurrentUsage: st.LevelNano / NanoScale,
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       ReasonAllowed,
			QueueDepth:   st.LevelNano / NanoScale,
		}
	}

	// Overflow: reject and report time until enough water leaks to accommodate cost
	overflowNano := (st.LevelNano + costNano) - capacityNano
	retryNs := (overflowNano * windowNs) / (p.Limit * NanoScale)
	if retryNs == 0 {
		retryNs = 1
	}

	return st, Decision{
		Allowed:      false,
		Remaining:    (capacityNano - st.LevelNano) / NanoScale,
		ResetAfter:   time.Duration(st.LevelNano * windowNs / (p.Limit * NanoScale)),
		RetryAfter:   time.Duration(retryNs),
		CurrentUsage: st.LevelNano / NanoScale,
		Limit:        p.Limit,
		Burst:        burst,
		Reason:       ReasonQuotaExceeded,
		QueueDepth:   st.LevelNano / NanoScale,
	}
}

// LeakyBucketRefund reduces the water level by amount.
func LeakyBucketRefund(st LeakyBucketState, p Params, amount int64) LeakyBucketState {
	if amount <= 0 || !st.Initialized {
		return st
	}
	st.LevelNano -= amount * NanoScale
	if st.LevelNano < 0 {
		st.LevelNano = 0
	}
	return st
}
