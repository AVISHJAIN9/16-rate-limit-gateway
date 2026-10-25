package algo

import (
	"time"
)

// DefaultSlidingLogCap specifies the hard limit of timestamps tracked per key.
// Memory per key: 1024 * 8 bytes = 8,192 bytes (8 KB) for the ring buffer.
const DefaultSlidingLogCap = 1024

// SlidingWindowLogState holds an exact bounded ring buffer of request arrival timestamps.
type SlidingWindowLogState struct {
	Ring    []int64 // Ring buffer of monotonic nanosecond timestamps
	Head    int     // Oldest active entry index
	Tail    int     // Next insert position index
	Count   int     // Number of valid timestamps currently in ring
	HardCap int     // Explicit capacity limit
}

// NewSlidingWindowLogState creates an initialized state with an explicit hard cap.
func NewSlidingWindowLogState(capLimit int) SlidingWindowLogState {
	if capLimit <= 0 {
		capLimit = DefaultSlidingLogCap
	}
	return SlidingWindowLogState{
		Ring:    make([]int64, capLimit),
		HardCap: capLimit,
	}
}

// SlidingWindowLogStep performs an exact sliding window log check (F19).
// Purges timestamps older than (nowNs - windowNs).
// If (Count + cost) > HardCap, excess requests are rejected with ReasonRingBufferFull.
func SlidingWindowLogStep(st SlidingWindowLogState, p Params, cost int64, nowNs int64) (SlidingWindowLogState, Decision) {
	burst := p.Burst
	if burst <= 0 {
		burst = p.Limit
	}
	windowNs := p.Window.Nanoseconds()
	cutoffNs := nowNs - windowNs

	if len(st.Ring) == 0 {
		capLimit := int(p.Limit + burst)
		if capLimit > DefaultSlidingLogCap {
			capLimit = DefaultSlidingLogCap
		}
		st = NewSlidingWindowLogState(capLimit)
	}

	// 1. Purge expired entries older than cutoff
	for st.Count > 0 {
		if st.Ring[st.Head] <= cutoffNs {
			st.Head = (st.Head + 1) % st.HardCap
			st.Count--
		} else {
			break
		}
	}

	valid, permReject, reason := ValidateCost(cost, burst, p.AllowZeroCost)
	if !valid {
		dec := Decision{
			Allowed:      false,
			Remaining:    p.Limit - int64(st.Count),
			ResetAfter:   p.Window,
			CurrentUsage: int64(st.Count),
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       reason,
		}
		if permReject && reason == ReasonCostExceedsBurst {
			dec.RetryAfter = time.Duration(-1)
		}
		return st, dec
	}

	// 2. Check if ring buffer hard cap would be exceeded
	if st.Count+int(cost) > st.HardCap {
		return st, Decision{
			Allowed:      false,
			Remaining:    0,
			ResetAfter:   p.Window,
			RetryAfter:   p.Window,
			CurrentUsage: int64(st.Count),
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       ReasonRingBufferFull,
		}
	}

	// 3. Check rate limit
	if int64(st.Count)+cost <= p.Limit {
		// Append timestamps
		for i := 0; i < int(cost); i++ {
			st.Ring[st.Tail] = nowNs
			st.Tail = (st.Tail + 1) % st.HardCap
			st.Count++
		}

		timeToReset := p.Window
		if st.Count > 0 {
			oldest := st.Ring[st.Head]
			timeToReset = time.Duration(oldest + windowNs - nowNs)
			if timeToReset < 0 {
				timeToReset = 0
			}
		}

		return st, Decision{
			Allowed:      true,
			Remaining:    p.Limit - int64(st.Count),
			ResetAfter:   timeToReset,
			RetryAfter:   0,
			CurrentUsage: int64(st.Count),
			Limit:        p.Limit,
			Burst:        burst,
			Reason:       ReasonAllowed,
		}
	}

	// Rate limit exceeded: calculate exact RetryAfter based on the entry that must expire
	// To fit `cost`, we need current count + cost <= limit, which means we must drop:
	// dropCount = (current count + cost) - limit
	dropCount := (st.Count + int(cost)) - int(p.Limit)
	if dropCount > st.Count {
		dropCount = st.Count
	}

	targetIndex := (st.Head + dropCount - 1) % st.HardCap
	expireTimestamp := st.Ring[targetIndex]
	retryNs := expireTimestamp + windowNs - nowNs
	if retryNs <= 0 {
		retryNs = 1
	}

	return st, Decision{
		Allowed:      false,
		Remaining:    0,
		ResetAfter:   p.Window,
		RetryAfter:   time.Duration(retryNs),
		CurrentUsage: int64(st.Count),
		Limit:        p.Limit,
		Burst:        burst,
		Reason:       ReasonQuotaExceeded,
	}
}
