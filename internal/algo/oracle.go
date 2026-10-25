package algo

// RequestEvent logs an admitted or attempted request.
type RequestEvent struct {
	TimestampNs int64
	Cost        int64
	Allowed     bool
}

// NaiveOracle stores request history and provides an independent reference oracle for property tests.
type NaiveOracle struct {
	History []RequestEvent
	Params  Params

	// Independent reference state for token bucket
	tbCommittedTokens int64
	tbCommittedTimeNs int64
	tbInitialized     bool

	// Independent reference state for GCRA
	gcraCommittedTAT int64
	gcraInitialized  bool
}

// NewNaiveOracle creates a NaiveOracle with configured parameters.
func NewNaiveOracle(p Params) *NaiveOracle {
	burst := p.Burst
	if burst <= 0 {
		burst = p.Limit
	}
	return &NaiveOracle{
		History:           make([]RequestEvent, 0, 1024),
		Params:            p,
		tbCommittedTokens: burst * NanoScale,
	}
}

// DecideTokenBucket recomputes the token bucket balance independently.
func (o *NaiveOracle) DecideTokenBucket(nowNs int64, cost int64) bool {
	burst := o.Params.Burst
	if burst <= 0 {
		burst = o.Params.Limit
	}
	maxTokensNano := burst * NanoScale
	windowNs := o.Params.Window.Nanoseconds()

	valid, _, _ := ValidateCost(cost, burst, o.Params.AllowZeroCost)
	if !valid {
		return false
	}

	if !o.tbInitialized {
		o.tbCommittedTokens = maxTokensNano
		o.tbCommittedTimeNs = nowNs
		o.tbInitialized = true
	}

	tokens := o.tbCommittedTokens
	elapsed := nowNs - o.tbCommittedTimeNs
	if elapsed > 0 {
		tokens += SafeRefillNano(elapsed, o.Params.Limit, windowNs)
		if tokens > maxTokensNano {
			tokens = maxTokensNano
		}
	}

	return tokens >= cost*NanoScale
}

// DecideGCRA recomputes GCRA TAT independently.
func (o *NaiveOracle) DecideGCRA(nowNs int64, cost int64) bool {
	burst := o.Params.Burst
	if burst <= 0 {
		burst = o.Params.Limit
	}
	limit := o.Params.Limit
	if limit <= 0 {
		limit = 1
	}
	windowNs := o.Params.Window.Nanoseconds()
	T := windowNs / limit
	if T <= 0 {
		T = 1
	}
	Tau := burst * T

	valid, _, _ := ValidateCost(cost, burst, o.Params.AllowZeroCost)
	if !valid {
		return false
	}

	if !o.gcraInitialized {
		return true
	}

	tat := o.gcraCommittedTAT
	if nowNs > tat {
		tat = nowNs
	}

	return tat-Tau <= nowNs
}

// DecideFixedWindow counts admitted requests strictly in current window [floor(now/W)*W, nextW).
func (o *NaiveOracle) DecideFixedWindow(nowNs int64, cost int64) bool {
	windowNs := o.Params.Window.Nanoseconds()
	currWindowID := nowNs / windowNs
	windowStartNs := currWindowID * windowNs
	windowEndNs := (currWindowID + 1) * windowNs

	burst := o.Params.Burst
	if burst <= 0 {
		burst = o.Params.Limit
	}

	valid, _, _ := ValidateCost(cost, burst, o.Params.AllowZeroCost)
	if !valid {
		return false
	}

	var totalCostInWindow int64 = 0
	for i := len(o.History) - 1; i >= 0; i-- {
		ev := o.History[i]
		if ev.TimestampNs < windowStartNs {
			break
		}
		if ev.Allowed && ev.TimestampNs >= windowStartNs && ev.TimestampNs < windowEndNs {
			totalCostInWindow += ev.Cost
		}
	}

	return totalCostInWindow+cost <= o.Params.Limit
}

// DecideSlidingWindowLog counts admitted requests in strictly sliding window (nowNs - windowNs, nowNs].
func (o *NaiveOracle) DecideSlidingWindowLog(nowNs int64, cost int64) bool {
	windowNs := o.Params.Window.Nanoseconds()
	cutoffNs := nowNs - windowNs

	burst := o.Params.Burst
	if burst <= 0 {
		burst = o.Params.Limit
	}

	valid, _, _ := ValidateCost(cost, burst, o.Params.AllowZeroCost)
	if !valid {
		return false
	}

	var countInWindow int64 = 0
	for i := len(o.History) - 1; i >= 0; i-- {
		ev := o.History[i]
		if ev.TimestampNs <= cutoffNs {
			break
		}
		if ev.Allowed {
			countInWindow += ev.Cost
		}
	}

	return countInWindow+cost <= o.Params.Limit
}

// Record appends an evaluation event to the oracle's historical record and updates committed states.
func (o *NaiveOracle) Record(nowNs int64, cost int64, allowed bool) {
	o.History = append(o.History, RequestEvent{
		TimestampNs: nowNs,
		Cost:        cost,
		Allowed:     allowed,
	})

	if allowed {
		burst := o.Params.Burst
		if burst <= 0 {
			burst = o.Params.Limit
		}
		maxTokensNano := burst * NanoScale
		windowNs := o.Params.Window.Nanoseconds()

		// Commit Token Bucket
		if !o.tbInitialized {
			o.tbCommittedTokens = maxTokensNano
			o.tbCommittedTimeNs = nowNs
			o.tbInitialized = true
		}
		elapsed := nowNs - o.tbCommittedTimeNs
		if elapsed > 0 {
			o.tbCommittedTokens += SafeRefillNano(elapsed, o.Params.Limit, windowNs)
			if o.tbCommittedTokens > maxTokensNano {
				o.tbCommittedTokens = maxTokensNano
			}
			o.tbCommittedTimeNs = nowNs
		}
		o.tbCommittedTokens -= cost * NanoScale

		// Commit GCRA
		limit := o.Params.Limit
		if limit <= 0 {
			limit = 1
		}
		T := windowNs / limit
		if T <= 0 {
			T = 1
		}
		if !o.gcraInitialized {
			o.gcraCommittedTAT = nowNs + (cost * T)
			o.gcraInitialized = true
		} else {
			tat := o.gcraCommittedTAT
			if nowNs > tat {
				tat = nowNs
			}
			o.gcraCommittedTAT = tat + (cost * T)
		}
	}

	// Trim historical records older than 2 windows to keep memory constant O(1) in steady state
	windowNs := o.Params.Window.Nanoseconds()
	cutoffNs := nowNs - (2 * windowNs)
	if len(o.History) > 1000 && o.History[0].TimestampNs < cutoffNs {
		// Find first non-expired index
		idx := 0
		for idx < len(o.History) && o.History[idx].TimestampNs < cutoffNs {
			idx++
		}
		if idx > 0 {
			o.History = o.History[idx:]
		}
	}
}
