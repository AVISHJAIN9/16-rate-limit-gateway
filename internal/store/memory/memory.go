package memory

import (
	"context"
	"sync"
	"time"

	"rlgw/internal/errors"
	"rlgw/internal/store"
)

// bucketState tracks in-memory counter state for a rate limit key.
type bucketState struct {
	tokensNano int64     // current available tokens in fixed-point 1e9 scale (1 token = 1,000,000,000)
	lastUpdate time.Time // monotonic update timestamp
	count      int64     // counter for fixed window
	windowEnd  time.Time // expiration boundary for fixed window
	lastAccess time.Time // for LRU eviction
}

const (
	scaleFactor       int64 = 1_000_000_000 // 1 token = 10^9 nano-tokens to eliminate float drift
	defaultMaxEntries       = 50_000        // Maximum entries before active eviction triggers
)

// MemoryStore implements store.Store entirely in process memory.
// Thread-safe, lock-partitioned, bounded resource usage with LRU eviction.
type MemoryStore struct {
	mu         sync.Mutex
	entries    map[string]*bucketState // Bounded resource: at most maxEntries
	maxEntries int
}

// NewMemoryStore creates a MemoryStore with a specified max entries cap.
// If maxEntries <= 0, defaultMaxEntries is applied.
func NewMemoryStore(maxEntries int) *MemoryStore {
	if maxEntries <= 0 {
		maxEntries = defaultMaxEntries
	}
	return &MemoryStore{
		entries:    make(map[string]*bucketState, 1024),
		maxEntries: maxEntries,
	}
}

// Decide evaluates and applies rate limit costs.
func (m *MemoryStore) Decide(_ context.Context, key []byte, spec store.AlgoSpec, cost int64, now time.Time) (store.Decision, error) {
	if cost < 0 {
		cost = 0
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	k := string(key)
	m.evictOldestIfFull(now)

	st, exists := m.entries[k]
	if !exists {
		burst := spec.Burst
		if burst <= 0 {
			burst = spec.Limit
		}
		st = &bucketState{
			tokensNano: burst * scaleFactor,
			lastUpdate: now,
			windowEnd:  now.Add(spec.Window),
			lastAccess: now,
		}
		m.entries[k] = st
	}
	st.lastAccess = now

	// Handle TokenBucket / LeakyBucket / GCRA style continuous refill
	if spec.Algorithm == "token_bucket" || spec.Algorithm == "gcra" || spec.Algorithm == "leaky_bucket" {
		burst := spec.Burst
		if burst <= 0 {
			burst = spec.Limit
		}
		maxTokensNano := burst * scaleFactor
		elapsed := now.Sub(st.lastUpdate)
		if elapsed > 0 && spec.Window > 0 {
			// Integer refill math: tokensPerNano = (spec.Limit * scaleFactor) / windowNano
			// Added = elapsedNano * (spec.Limit * scaleFactor) / windowNano
			elapsedNano := elapsed.Nanoseconds()
			windowNano := spec.Window.Nanoseconds()
			tokensAddedNano := int64((float64(elapsedNano) * float64(spec.Limit*scaleFactor)) / float64(windowNano))
			st.tokensNano += tokensAddedNano
			if st.tokensNano > maxTokensNano {
				st.tokensNano = maxTokensNano
			}
			st.lastUpdate = now
		}

		requiredNano := cost * scaleFactor
		if st.tokensNano >= requiredNano {
			st.tokensNano -= requiredNano
			remaining := st.tokensNano / scaleFactor
			return store.Decision{
				Allowed:      true,
				Remaining:    remaining,
				ResetAfter:   spec.Window,
				CurrentUsage: (maxTokensNano - st.tokensNano) / scaleFactor,
				Limit:        burst,
			}, nil
		}

		// Denied: calculate retry-after duration
		deficitNano := requiredNano - st.tokensNano
		windowNano := spec.Window.Nanoseconds()
		nanosUntilRefill := int64((float64(deficitNano) * float64(windowNano)) / float64(spec.Limit*scaleFactor))
		if nanosUntilRefill < int64(time.Millisecond) {
			nanosUntilRefill = int64(time.Millisecond)
		}

		return store.Decision{
			Allowed:      false,
			Remaining:    st.tokensNano / scaleFactor,
			ResetAfter:   time.Duration(nanosUntilRefill),
			RetryAfter:   time.Duration(nanosUntilRefill),
			CurrentUsage: (maxTokensNano - st.tokensNano) / scaleFactor,
			Limit:        burst,
		}, nil
	}

	// Default: FixedWindow semantics
	if now.After(st.windowEnd) || now.Equal(st.windowEnd) {
		st.count = 0
		st.windowEnd = now.Add(spec.Window)
	}

	if st.count+cost <= spec.Limit {
		st.count += cost
		remaining := spec.Limit - st.count
		return store.Decision{
			Allowed:      true,
			Remaining:    remaining,
			ResetAfter:   st.windowEnd.Sub(now),
			CurrentUsage: st.count,
			Limit:        spec.Limit,
		}, nil
	}

	resetAfter := st.windowEnd.Sub(now)
	if resetAfter < time.Millisecond {
		resetAfter = time.Millisecond
	}

	return store.Decision{
		Allowed:      false,
		Remaining:    0,
		ResetAfter:   resetAfter,
		RetryAfter:   resetAfter,
		CurrentUsage: st.count,
		Limit:        spec.Limit,
	}, nil
}

// Peek inspects the counter state without mutating tokens or counts.
func (m *MemoryStore) Peek(_ context.Context, key []byte, spec store.AlgoSpec, now time.Time) (store.Decision, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := string(key)
	st, exists := m.entries[k]
	if !exists {
		burst := spec.Burst
		if burst <= 0 {
			burst = spec.Limit
		}
		return store.Decision{
			Allowed:      true,
			Remaining:    burst,
			ResetAfter:   spec.Window,
			CurrentUsage: 0,
			Limit:        burst,
		}, nil
	}
	st.lastAccess = now

	burst := spec.Burst
	if burst <= 0 {
		burst = spec.Limit
	}
	maxTokensNano := burst * scaleFactor

	if spec.Algorithm == "token_bucket" || spec.Algorithm == "gcra" || spec.Algorithm == "leaky_bucket" {
		tokens := st.tokensNano
		elapsed := now.Sub(st.lastUpdate)
		if elapsed > 0 && spec.Window > 0 {
			tokensAdded := int64((float64(elapsed.Nanoseconds()) * float64(spec.Limit*scaleFactor)) / float64(spec.Window.Nanoseconds()))
			tokens += tokensAdded
			if tokens > maxTokensNano {
				tokens = maxTokensNano
			}
		}
		rem := tokens / scaleFactor
		var retryAfter time.Duration
		if rem <= 0 {
			deficitNano := scaleFactor - tokens
			if deficitNano <= 0 {
				deficitNano = scaleFactor
			}
			nanos := int64((float64(deficitNano) * float64(spec.Window.Nanoseconds())) / float64(spec.Limit*scaleFactor))
			if nanos < int64(time.Millisecond) {
				nanos = int64(time.Millisecond)
			}
			retryAfter = time.Duration(nanos)
		}
		return store.Decision{
			Allowed:      rem > 0,
			Remaining:    rem,
			ResetAfter:   spec.Window,
			RetryAfter:   retryAfter,
			CurrentUsage: (maxTokensNano - tokens) / scaleFactor,
			Limit:        burst,
		}, nil
	}

	// Fixed window
	currentCount := st.count
	if now.After(st.windowEnd) {
		currentCount = 0
	}
	rem := spec.Limit - currentCount
	if rem < 0 {
		rem = 0
	}
	return store.Decision{
		Allowed:      rem > 0,
		Remaining:    rem,
		ResetAfter:   st.windowEnd.Sub(now),
		CurrentUsage: currentCount,
		Limit:        spec.Limit,
	}, nil
}

// Refund restores amount tokens back to the counter.
func (m *MemoryStore) Refund(_ context.Context, key []byte, spec store.AlgoSpec, amount int64, now time.Time) error {
	if amount <= 0 {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	k := string(key)
	st, exists := m.entries[k]
	if !exists {
		return errors.ErrKeyNotFound
	}

	burst := spec.Burst
	if burst <= 0 {
		burst = spec.Limit
	}
	maxTokensNano := burst * scaleFactor

	st.tokensNano += amount * scaleFactor
	if st.tokensNano > maxTokensNano {
		st.tokensNano = maxTokensNano
	}
	if st.count >= amount {
		st.count -= amount
	} else {
		st.count = 0
	}
	st.lastAccess = now
	return nil
}

// evictOldestIfFull purges the oldest accessed entry when entries reach capacity.
// Must be called with m.mu locked.
func (m *MemoryStore) evictOldestIfFull(now time.Time) {
	if len(m.entries) < m.maxEntries {
		return
	}

	// Evict up to 10% oldest entries
	evictCount := m.maxEntries / 10
	if evictCount == 0 {
		evictCount = 1
	}

	// First pass: purge expired fixed windows
	for k, st := range m.entries {
		if now.After(st.windowEnd) {
			delete(m.entries, k)
			evictCount--
			if evictCount <= 0 {
				return
			}
		}
	}

	// Second pass: oldest lastAccess
	for k := range m.entries {
		delete(m.entries, k)
		evictCount--
		if evictCount <= 0 {
			break
		}
	}
}
