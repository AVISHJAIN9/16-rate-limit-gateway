package memory

import (
	"context"
	"testing"
	"time"

	"rlgw/internal/store"
)

func TestMemoryStoreFixedWindow(t *testing.T) {
	ctx := context.Background()
	m := NewMemoryStore(100)
	key := []byte("test:fixed:1")
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	spec := store.AlgoSpec{
		Algorithm: "fixed_window",
		Limit:     3,
		Window:    time.Second,
	}

	// Cost 1: allowed
	dec1, err := m.Decide(ctx, key, spec, 1, now)
	if err != nil || !dec1.Allowed || dec1.Remaining != 2 {
		t.Fatalf("first request failed: %+v, err: %v", dec1, err)
	}

	// Cost 2: allowed
	dec2, err := m.Decide(ctx, key, spec, 2, now)
	if err != nil || !dec2.Allowed || dec2.Remaining != 0 {
		t.Fatalf("second request failed: %+v, err: %v", dec2, err)
	}

	// Cost 1: denied
	dec3, err := m.Decide(ctx, key, spec, 1, now)
	if err != nil || dec3.Allowed {
		t.Fatalf("third request should be denied: %+v", dec3)
	}

	// Peek should report remaining = 0
	peekDec, err := m.Peek(ctx, key, spec, now)
	if err != nil || peekDec.Allowed || peekDec.Remaining != 0 {
		t.Fatalf("peek mismatch: %+v", peekDec)
	}

	// Advance beyond window
	nextWindow := now.Add(1500 * time.Millisecond)
	dec4, err := m.Decide(ctx, key, spec, 1, nextWindow)
	if err != nil || !dec4.Allowed || dec4.Remaining != 2 {
		t.Fatalf("fourth request in next window failed: %+v", dec4)
	}
}

func TestMemoryStoreTokenBucketRefillAndRefund(t *testing.T) {
	ctx := context.Background()
	m := NewMemoryStore(100)
	key := []byte("test:token:1")
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	spec := store.AlgoSpec{
		Algorithm: "token_bucket",
		Limit:     10, // 10 tokens per second
		Burst:     10,
		Window:    time.Second,
	}

	// Consume all 10 tokens
	dec, err := m.Decide(ctx, key, spec, 10, now)
	if err != nil || !dec.Allowed || dec.Remaining != 0 {
		t.Fatalf("expected all 10 consumed, got %+v, err: %v", dec, err)
	}

	// Denied immediately
	decDeny, err := m.Decide(ctx, key, spec, 1, now)
	if err != nil || decDeny.Allowed {
		t.Fatalf("expected denied, got %+v", decDeny)
	}

	// Refund 5 tokens
	err = m.Refund(ctx, key, spec, 5, now)
	if err != nil {
		t.Fatalf("refund error: %v", err)
	}

	// Should now allow 5 tokens
	decRefill, err := m.Decide(ctx, key, spec, 5, now)
	if err != nil || !decRefill.Allowed || decRefill.Remaining != 0 {
		t.Fatalf("expected 5 tokens allowed after refund, got %+v", decRefill)
	}

	// Advance 500ms (refills 5 tokens)
	later := now.Add(500 * time.Millisecond)
	decLater, err := m.Decide(ctx, key, spec, 5, later)
	if err != nil || !decLater.Allowed {
		t.Fatalf("expected refill allowed, got %+v", decLater)
	}
}

func TestMemoryStoreBoundedCapacityEviction(t *testing.T) {
	ctx := context.Background()
	m := NewMemoryStore(5) // Max 5 keys
	now := time.Now()
	spec := store.AlgoSpec{Algorithm: "fixed_window", Limit: 10, Window: time.Minute}

	for i := 0; i < 10; i++ {
		key := []byte(string(rune('a' + i)))
		_, err := m.Decide(ctx, key, spec, 1, now)
		if err != nil {
			t.Fatalf("decide error on key %s: %v", string(key), err)
		}
	}

	m.mu.Lock()
	count := len(m.entries)
	m.mu.Unlock()

	if count > 5 {
		t.Fatalf("expected map entries <= 5, got %d", count)
	}
}
