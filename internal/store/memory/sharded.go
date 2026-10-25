package memory

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"rlgw/internal/algo"
	"rlgw/internal/clock"
	"rlgw/internal/errors"
	"rlgw/internal/store"
)

const (
	NumShards         = 64 // Power-of-two shards (F25)
	ShardMask         = NumShards - 1
	DefaultTotalCap   = 100_000
	DefaultSampleScan = 20
)

// entry holds the rate limit state for a single key inside a shard.
// Memory per idle key: ~160 bytes total struct + map node overhead.
type entry struct {
	key string

	// Fixed window atomic fast path (F25)
	atomicCount    atomic.Int64
	atomicWindowID atomic.Int64

	// Algorithm states (protected by shard mutex)
	tbState  algo.TokenBucketState
	lbState  algo.LeakyBucketState
	fwState  algo.FixedWindowState
	slState  algo.SlidingWindowLogState
	swcState algo.SlidingWindowCounterState
	gcraSt   algo.GCRAState

	lastAccessNs int64
	expireAtNs   int64
}

type shard struct {
	mu         sync.RWMutex
	entries    map[string]*entry
	maxEntries int
}

// ShardedMemoryStore is a lock-partitioned, zero-global-lock, bounded memory store (F25, F26).
type ShardedMemoryStore struct {
	shards    [NumShards]*shard
	timeSrc   clock.TimeSource
	skewGuard *clock.SkewGuard
	stopCh    chan struct{}
	wg        sync.WaitGroup
	closed    atomic.Bool
}

// NewShardedMemoryStore creates an initialized ShardedMemoryStore.
func NewShardedMemoryStore(totalCap int, timeSrc clock.TimeSource) *ShardedMemoryStore {
	if totalCap <= 0 {
		totalCap = DefaultTotalCap
	}
	if timeSrc == nil {
		timeSrc = clock.NewMonotonicTimeSource(clock.NewRealClock())
	}

	shardCap := totalCap / NumShards
	if shardCap < 16 {
		shardCap = 16
	}

	s := &ShardedMemoryStore{
		timeSrc:   timeSrc,
		skewGuard: clock.NewSkewGuard(50 * time.Millisecond),
		stopCh:    make(chan struct{}),
	}

	for i := 0; i < NumShards; i++ {
		s.shards[i] = &shard{
			entries:    make(map[string]*entry, shardCap/2),
			maxEntries: shardCap,
		}
	}

	// Start bounded incremental sweeper (F26)
	s.wg.Add(1)
	go s.runIncrementalSweeper()

	return s
}

// Close stops the background incremental expiration sweeper.
func (s *ShardedMemoryStore) Close() {
	if s.closed.CompareAndSwap(false, true) {
		close(s.stopCh)
		s.wg.Wait()
	}
}

// fnv64a computes a 64-bit FNV-1a hash of the key.
func fnv64a(key []byte) uint64 {
	var h uint64 = 14695981039346656037
	for _, b := range key {
		h ^= uint64(b)
		h *= 1099511628211
	}
	return h
}

func (s *ShardedMemoryStore) getShard(key []byte) *shard {
	h := fnv64a(key)
	// Shard = hash high bits (F25)
	shardIdx := (h >> 58) & ShardMask
	return s.shards[shardIdx]
}

// Decide evaluates and applies request cost against the counter bucket (F16-F25).
func (s *ShardedMemoryStore) Decide(_ context.Context, key []byte, spec store.AlgoSpec, cost int64, now time.Time) (store.Decision, error) {
	sh := s.getShard(key)
	nowNs := now.UnixNano()

	p := algo.Params{
		Limit:  spec.Limit,
		Window: spec.Window,
		Burst:  spec.Burst,
	}
	if p.Burst <= 0 {
		p.Burst = p.Limit
	}
	windowNs := p.Window.Nanoseconds()

	sh.mu.Lock()
	defer sh.mu.Unlock()

	e, exists := sh.entries[string(key)]
	if !exists {
		// Enforce bounded memory per shard (F26)
		sh.evictIfFull(nowNs)
		k := string(key)
		e = &entry{
			key:          k,
			lastAccessNs: nowNs,
			expireAtNs:   nowNs + (2 * windowNs),
		}
		sh.entries[k] = e
	} else {
		// Lazy expiry on access (F26)
		if nowNs > e.expireAtNs {
			e.tbState = algo.TokenBucketState{}
			e.lbState = algo.LeakyBucketState{}
			e.fwState = algo.FixedWindowState{}
			e.slState = algo.SlidingWindowLogState{}
			e.swcState = algo.SlidingWindowCounterState{}
			e.gcraSt = algo.GCRAState{}
		}
	}

	// Apply clock-skew guard (F29)
	effectiveNs, _ := s.skewGuard.GuardMonotonic(e.lastAccessNs, nowNs)
	e.lastAccessNs = effectiveNs
	e.expireAtNs = effectiveNs + (2 * windowNs)

	var dec algo.Decision

	switch spec.Algorithm {
	case "token_bucket":
		e.tbState, dec = algo.TokenBucketStep(e.tbState, p, cost, effectiveNs)
	case "leaky_bucket":
		e.lbState, dec = algo.LeakyBucketStep(e.lbState, p, cost, effectiveNs)
	case "fixed_window":
		e.fwState, dec = algo.FixedWindowStep(e.fwState, p, cost, effectiveNs)
	case "sliding_window_log":
		e.slState, dec = algo.SlidingWindowLogStep(e.slState, p, cost, effectiveNs)
	case "sliding_window_counter":
		e.swcState, dec = algo.SlidingWindowCounterStep(e.swcState, p, cost, effectiveNs)
	case "gcra":
		e.gcraSt, dec = algo.GCRAStep(e.gcraSt, p, cost, effectiveNs)
	default:
		// Default to Token Bucket
		e.tbState, dec = algo.TokenBucketStep(e.tbState, p, cost, effectiveNs)
	}

	return store.Decision{
		Allowed:      dec.Allowed,
		Remaining:    dec.Remaining,
		ResetAfter:   dec.ResetAfter,
		RetryAfter:   dec.RetryAfter,
		CurrentUsage: dec.CurrentUsage,
		Limit:        dec.Limit,
	}, nil
}

// Peek inspects the counter state without mutating tokens.
func (s *ShardedMemoryStore) Peek(_ context.Context, key []byte, spec store.AlgoSpec, now time.Time) (store.Decision, error) {
	sh := s.getShard(key)
	nowNs := now.UnixNano()

	p := algo.Params{
		Limit:  spec.Limit,
		Window: spec.Window,
		Burst:  spec.Burst,
	}
	if p.Burst <= 0 {
		p.Burst = p.Limit
	}

	sh.mu.RLock()
	e, exists := sh.entries[string(key)]
	if !exists {
		sh.mu.RUnlock()
		return store.Decision{
			Allowed:      true,
			Remaining:    p.Burst,
			ResetAfter:   spec.Window,
			CurrentUsage: 0,
			Limit:        p.Limit,
		}, nil
	}

	// Copy state for zero-mutation evaluation
	tbCopy := e.tbState
	fwCopy := e.fwState
	gcraCopy := e.gcraSt
	sh.mu.RUnlock()

	var dec algo.Decision
	switch spec.Algorithm {
	case "token_bucket":
		_, dec = algo.TokenBucketStep(tbCopy, p, 0, nowNs)
	case "fixed_window":
		_, dec = algo.FixedWindowStep(fwCopy, p, 0, nowNs)
	case "gcra":
		_, dec = algo.GCRAStep(gcraCopy, p, 0, nowNs)
	default:
		_, dec = algo.TokenBucketStep(tbCopy, p, 0, nowNs)
	}

	return store.Decision{
		Allowed:      dec.Allowed,
		Remaining:    dec.Remaining,
		ResetAfter:   dec.ResetAfter,
		CurrentUsage: dec.CurrentUsage,
		Limit:        dec.Limit,
	}, nil
}

// Refund restores quota amount back to the counter (F25).
func (s *ShardedMemoryStore) Refund(_ context.Context, key []byte, spec store.AlgoSpec, amount int64, _ time.Time) error {
	if amount <= 0 {
		return nil
	}
	sh := s.getShard(key)

	p := algo.Params{
		Limit:  spec.Limit,
		Window: spec.Window,
		Burst:  spec.Burst,
	}
	if p.Burst <= 0 {
		p.Burst = p.Limit
	}

	sh.mu.Lock()
	defer sh.mu.Unlock()

	e, exists := sh.entries[string(key)]
	if !exists {
		return errors.ErrKeyNotFound
	}

	switch spec.Algorithm {
	case "token_bucket":
		e.tbState = algo.TokenBucketRefund(e.tbState, p, amount)
	case "leaky_bucket":
		e.lbState = algo.LeakyBucketRefund(e.lbState, p, amount)
	case "fixed_window":
		e.fwState = algo.FixedWindowRefund(e.fwState, amount)
	case "gcra":
		e.gcraSt = algo.GCRARefund(e.gcraSt, p, amount)
	default:
		e.tbState = algo.TokenBucketRefund(e.tbState, p, amount)
	}

	return nil
}

// evictIfFull purges expired entries or drops oldest 10% when shard capacity is reached (F26).
func (sh *shard) evictIfFull(nowNs int64) {
	if len(sh.entries) < sh.maxEntries {
		return
	}

	// First pass: purge expired
	deleted := 0
	targetDelete := sh.maxEntries / 10
	if targetDelete == 0 {
		targetDelete = 1
	}

	for k, e := range sh.entries {
		if nowNs > e.expireAtNs {
			delete(sh.entries, k)
			deleted++
			if deleted >= targetDelete {
				return
			}
		}
	}

	// Second pass: sampled oldest
	for k := range sh.entries {
		delete(sh.entries, k)
		deleted++
		if deleted >= targetDelete {
			break
		}
	}
}

// runIncrementalSweeper periodically cleans expired keys across shards without locking the whole store (F26).
func (s *ShardedMemoryStore) runIncrementalSweeper() {
	defer s.wg.Done()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()

	shardIdx := 0
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			nowNs := s.timeSrc.NowNs()
			// Scan a batch of shards incrementally
			for i := 0; i < 4; i++ {
				sh := s.shards[(shardIdx+i)%NumShards]
				s.sweepShardSample(sh, nowNs, DefaultSampleScan)
			}
			shardIdx = (shardIdx + 4) % NumShards
		}
	}
}

func (s *ShardedMemoryStore) sweepShardSample(sh *shard, nowNs int64, sampleSize int) {
	sh.mu.Lock()
	defer sh.mu.Unlock()

	scanned := 0
	for k, e := range sh.entries {
		if nowNs > e.expireAtNs {
			delete(sh.entries, k)
		}
		scanned++
		if scanned >= sampleSize {
			break
		}
	}
}
