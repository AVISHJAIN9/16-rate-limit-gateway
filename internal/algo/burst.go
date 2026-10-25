package algo

import "rlgw/internal/policy"

// BurstSemantics documents the formal definition, state representation, and behavior
// of the "burst" parameter for each rate-limiting algorithm (F23).
type BurstSemantics struct {
	Algorithm       policy.Algorithm `json:"algorithm"`
	Name            string           `json:"name"`
	StateVariable   string           `json:"state_variable"`
	Meaning         string           `json:"meaning"`
	MinAllowedBurst int64            `json:"min_allowed_burst"`
	MaxAdmittedInW  string           `json:"max_admitted_in_w"`
}

// AlgorithmBurstTable provides the canonical reference definitions for burst semantics across all algorithms.
var AlgorithmBurstTable = map[policy.Algorithm]BurstSemantics{
	policy.AlgorithmTokenBucket: {
		Algorithm:       policy.AlgorithmTokenBucket,
		Name:            "Token Bucket",
		StateVariable:   "maxTokensNano = burst * 1e9",
		Meaning:         "Max bucket token capacity. Controls the maximum instantaneous burst of traffic that can be admitted when bucket is full.",
		MinAllowedBurst: 1,
		MaxAdmittedInW:  "burst + limit (if full at start of window and continuously refilled)",
	},
	policy.AlgorithmLeakyBucket: {
		Algorithm:       policy.AlgorithmLeakyBucket,
		Name:            "Leaky Bucket",
		StateVariable:   "capacityNano = burst * 1e9",
		Meaning:         "Maximum reservoir / queue depth before incoming requests overflow and are rejected. Drains at rate limit / window.",
		MinAllowedBurst: 1,
		MaxAdmittedInW:  "burst (maximum concurrent depth)",
	},
	policy.AlgorithmFixedWindow: {
		Algorithm:       policy.AlgorithmFixedWindow,
		Name:            "Fixed Window",
		StateVariable:   "capacity = max(limit, burst)",
		Meaning:         "Effective ceiling per aligned window. Across boundary transitions, fixed windows permit up to 2x burst.",
		MinAllowedBurst: 1,
		MaxAdmittedInW:  "2 * limit (straddling boundary)",
	},
	policy.AlgorithmSlidingWindowLog: {
		Algorithm:       policy.AlgorithmSlidingWindowLog,
		Name:            "Sliding Window Log",
		StateVariable:   "HardCap = min(limit + burst, RingCap)",
		Meaning:         "Exact quota and ring buffer upper bound. Strictly guarantees no more than limit requests in any sliding window.",
		MinAllowedBurst: 1,
		MaxAdmittedInW:  "limit (strictly enforced in any sliding window of duration W)",
	},
	policy.AlgorithmSlidingWindowCounter: {
		Algorithm:       policy.AlgorithmSlidingWindowCounter,
		Name:            "Sliding Window Counter",
		StateVariable:   "limitNano = limit * 1e9",
		Meaning:         "Weighted estimate ceiling across previous and current windows. Burst defines peak spike allowance.",
		MinAllowedBurst: 1,
		MaxAdmittedInW:  "1.0x to 1.5x limit (under worst-case adversarial boundary skew)",
	},
	policy.AlgorithmGCRA: {
		Algorithm:       policy.AlgorithmGCRA,
		Name:            "GCRA (Generic Cell Rate Algorithm)",
		StateVariable:   "Tau = burst * (window / limit)",
		Meaning:         "Burst tolerance Tau: maximum time accumulated ahead of theoretical arrival time before cells are rejected.",
		MinAllowedBurst: 1,
		MaxAdmittedInW:  "limit + burst",
	},
}
