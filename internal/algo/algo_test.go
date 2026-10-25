package algo

import (
	"testing"
	"time"
)

func TestSafeRefillNanoExtremeValues(t *testing.T) {
	windowNs := int64(time.Second)

	// 1. Extreme elapsed time: 1 full year elapsed at rate 1e9 / s
	oneYearNs := int64(365 * 24 * 3600 * time.Second)
	rate1e9 := int64(1_000_000_000)

	refill := SafeRefillNano(oneYearNs, rate1e9, windowNs)
	if refill <= 0 {
		t.Fatalf("expected positive saturated refill, got %d", refill)
	}

	// 2. Zero / Negative edge cases
	if SafeRefillNano(0, rate1e9, windowNs) != 0 {
		t.Fatal("expected 0 refill for 0 elapsed")
	}
	if SafeRefillNano(oneYearNs, 0, windowNs) != 0 {
		t.Fatal("expected 0 refill for 0 limit")
	}
	if SafeRefillNano(oneYearNs, rate1e9, 0) != 0 {
		t.Fatal("expected 0 refill for 0 window")
	}
	if SafeRefillNano(-100, rate1e9, windowNs) != 0 {
		t.Fatal("expected 0 refill for negative elapsed")
	}

	// 3. Normal exact refill
	halfSecNs := int64(500 * time.Millisecond)
	limit := int64(10) // 10 tokens per second -> 5 tokens in 500ms -> 5 * 1e9 nano-tokens
	expectedNano := int64(5 * NanoScale)
	actualNano := SafeRefillNano(halfSecNs, limit, windowNs)
	if actualNano != expectedNano {
		t.Fatalf("expected %d, got %d", expectedNano, actualNano)
	}
}

func TestWeightedRequestCostInvariants(t *testing.T) {
	p := Params{
		Limit:         10,
		Burst:         10,
		Window:        time.Second,
		AllowZeroCost: false,
	}

	now := int64(1_000_000_000)

	// 1. Cost 0 rejected when AllowZeroCost = false
	_, dec := TokenBucketStep(TokenBucketState{}, p, 0, now)
	if dec.Allowed {
		t.Fatal("cost 0 must be rejected when AllowZeroCost is false")
	}

	// 2. Cost 0 allowed when AllowZeroCost = true
	p.AllowZeroCost = true
	_, decZero := TokenBucketStep(TokenBucketState{}, p, 0, now)
	if !decZero.Allowed {
		t.Fatal("cost 0 must be allowed when AllowZeroCost is true")
	}

	// 3. Cost > Burst must be permanently rejected with ReasonCostExceedsBurst
	_, decOver := TokenBucketStep(TokenBucketState{}, p, 15, now)
	if decOver.Allowed || decOver.Reason != ReasonCostExceedsBurst {
		t.Fatalf("expected permanent rejection with ReasonCostExceedsBurst, got %+v", decOver)
	}
}

func TestFixedWindowBoundaryRolloverAnd2xBurst(t *testing.T) {
	window := time.Second
	windowNs := window.Nanoseconds()
	p := Params{Limit: 5, Burst: 5, Window: window}

	var st FixedWindowState

	// Consume 5 requests at window boundary end (t = 999ms)
	tEnd := windowNs - 1
	for i := 0; i < 5; i++ {
		var dec Decision
		st, dec = FixedWindowStep(st, p, 1, tEnd)
		if !dec.Allowed {
			t.Fatalf("expected allowed at tEnd %d: %+v", i, dec)
		}
	}

	// Sixth request in same window denied
	_, decDenied := FixedWindowStep(st, p, 1, tEnd)
	if decDenied.Allowed {
		t.Fatal("expected sixth request in window 0 to be denied")
	}

	// Straddle boundary: at exactly t = 1000ms (next window start), 5 more requests MUST be admitted
	// Demonstrating the documented 2x burst behavior of fixed window rate limiting
	tStart := windowNs
	for i := 0; i < 5; i++ {
		var dec Decision
		st, dec = FixedWindowStep(st, p, 1, tStart)
		if !dec.Allowed {
			t.Fatalf("expected allowed across boundary at tStart %d: %+v", i, dec)
		}
	}

	if st.Count != 5 {
		t.Fatalf("expected new window count 5, got %d", st.Count)
	}
}

func TestLeakyBucketMeterAndQueueDepth(t *testing.T) {
	p := Params{Limit: 10, Burst: 10, Window: time.Second}
	var st LeakyBucketState
	now := int64(1_000_000_000)

	// Add 6 units of water
	var dec Decision
	st, dec = LeakyBucketStep(st, p, 6, now)
	if !dec.Allowed || dec.QueueDepth != 6 || dec.Remaining != 4 {
		t.Fatalf("unexpected step 1: %+v", dec)
	}

	// Add 4 units of water (bucket full: 10/10)
	st, dec = LeakyBucketStep(st, p, 4, now)
	if !dec.Allowed || dec.QueueDepth != 10 || dec.Remaining != 0 {
		t.Fatalf("unexpected step 2: %+v", dec)
	}

	// 1 extra unit overflows
	st, dec = LeakyBucketStep(st, p, 1, now)
	if dec.Allowed || dec.Reason != ReasonQuotaExceeded {
		t.Fatalf("expected overflow rejection: %+v", dec)
	}

	// Advance 500ms: drains 5 units
	nowLater := now + int64(500*time.Millisecond)
	st, dec = LeakyBucketStep(st, p, 3, nowLater)
	if !dec.Allowed || dec.QueueDepth != 8 { // (10 - 5) + 3 = 8
		t.Fatalf("expected allowed after drain: %+v", dec)
	}
}

func TestMonotonicRetryAfterCorrectness(t *testing.T) {
	// Exact test on GCRA and TokenBucket
	p := Params{Limit: 10, Burst: 10, Window: time.Second}
	now := int64(1_000_000_000)

	// Exhaust token bucket
	var tbSt TokenBucketState
	tbSt, dec := TokenBucketStep(tbSt, p, 10, now)
	if !dec.Allowed {
		t.Fatal("initial burst failed")
	}

	// Next request is denied, returns RetryAfter
	tbSt, decDeny := TokenBucketStep(tbSt, p, 1, now)
	if decDeny.Allowed || decDeny.RetryAfter <= 0 {
		t.Fatalf("expected retry after > 0: %+v", decDeny)
	}

	// Waiting less than RetryAfter MUST be denied
	retryNs := decDeny.RetryAfter.Nanoseconds()
	tbStUnder, decUnder := TokenBucketStep(tbSt, p, 1, now+retryNs-1)
	if decUnder.Allowed {
		t.Fatal("request before RetryAfter elapsed was unexpectedly allowed")
	}

	// Waiting exactly RetryAfter MUST be allowed!
	_, decAllowed := TokenBucketStep(tbStUnder, p, 1, now+retryNs)
	if !decAllowed.Allowed {
		t.Fatalf("request at exact RetryAfter was denied: %+v", decAllowed)
	}
}
