package algo

import (
	"math"
	"math/bits"
	"time"
)

// NanoScale is the fixed-point scale factor (1 token = 1,000,000,000 nano-tokens).
// This eliminates float accumulation drift across trillions of refill operations.
const NanoScale int64 = 1_000_000_000

// DecisionReason provides a stable machine code explaining the allow/deny outcome.
type DecisionReason string

const (
	ReasonAllowed          DecisionReason = "ALLOWED"
	ReasonQuotaExceeded    DecisionReason = "QUOTA_EXCEEDED"
	ReasonCostExceedsBurst DecisionReason = "COST_EXCEEDS_BURST"
	ReasonRingBufferFull   DecisionReason = "RING_BUFFER_FULL"
	ReasonClockSkewClamped DecisionReason = "CLOCK_SKEW_CLAMPED"
)

// Decision is the immutable result of evaluating an algorithm step.
type Decision struct {
	Allowed        bool           `json:"allowed"`
	Remaining      int64          `json:"remaining"`       // Available tokens / remaining requests
	ResetAfter     time.Duration  `json:"reset_after"`     // Time until counter fully resets
	RetryAfter     time.Duration  `json:"retry_after"`     // Time caller must wait before retrying
	CurrentUsage   int64          `json:"current_usage"`   // Number of tokens consumed / requests made
	Limit          int64          `json:"limit"`           // Quota capacity
	Burst          int64          `json:"burst"`           // Burst allowance
	Reason         DecisionReason `json:"reason"`          // Explanation code
	QueueDepth     int64          `json:"queue_depth"`     // For leaky bucket: current depth
	EstimatedCount float64        `json:"estimated_count"` // For sliding window counter
}

// Params defines the rate limiting configuration parameters for algorithm kernels.
type Params struct {
	Limit         int64         `json:"limit"`
	Window        time.Duration `json:"window"`
	Burst         int64         `json:"burst"`
	AllowZeroCost bool          `json:"allow_zero_cost"`
}

// SafeRefillNano calculates (elapsedNs * rateNanoTokensPerNs) without overflow
// using 128-bit intermediate multiplication (math/bits.Mul64).
// If the product saturates int64, math.MaxInt64 is returned.
func SafeRefillNano(elapsedNs int64, limit int64, windowNs int64) int64 {
	if elapsedNs <= 0 || limit <= 0 || windowNs <= 0 {
		return 0
	}

	// Rate in nano-tokens per window: limit * NanoScale
	// Refill = (elapsedNs * limit * NanoScale) / windowNs
	// First multiply limit * NanoScale:
	hi1, lo1 := bits.Mul64(uint64(limit), uint64(NanoScale))
	if hi1 != 0 {
		// Extremely large limit, clamp to MaxInt64
		return math.MaxInt64
	}

	// Now multiply (limit * NanoScale) by elapsedNs:
	// hi, lo = (limit * NanoScale) * elapsedNs
	hi, lo := bits.Mul64(lo1, uint64(elapsedNs))

	// If hi >= uint64(windowNs), the quotient (hi, lo) / windowNs exceeds 64 bits
	// and bits.Div64 would panic with integer overflow. Saturate to MaxInt64.
	if hi >= uint64(windowNs) {
		return math.MaxInt64
	}

	// Divide 128-bit (hi, lo) by windowNs
	quo, _ := bits.Div64(hi, lo, uint64(windowNs))

	if quo > uint64(math.MaxInt64) {
		return math.MaxInt64
	}
	return int64(quo)
}

// ValidateCost checks F22 cost invariants:
// - cost < 0 is rejected (normalized or returns false)
// - cost == 0 allowed only when params.AllowZeroCost is true
// - cost > burst is a permanent rejection with ReasonCostExceedsBurst
func ValidateCost(cost int64, burst int64, allowZeroCost bool) (valid bool, permanentReject bool, reason DecisionReason) {
	if cost < 0 {
		return false, true, ReasonQuotaExceeded
	}
	if cost == 0 {
		if allowZeroCost {
			return true, false, ReasonAllowed
		}
		return false, true, ReasonQuotaExceeded
	}
	if burst > 0 && cost > burst {
		return false, true, ReasonCostExceedsBurst
	}
	return true, false, ReasonAllowed
}
