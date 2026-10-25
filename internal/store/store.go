package store

import (
	"context"
	"time"
)

// Decision represents the structured outcome of a rate limiting evaluation.
type Decision struct {
	Allowed        bool          `json:"allowed"`
	Remaining      int64         `json:"remaining"`
	ResetAfter     time.Duration `json:"reset_after"`
	RetryAfter     time.Duration `json:"retry_after"`
	ViolatedPolicy string        `json:"violated_policy,omitempty"`
	CurrentUsage   int64         `json:"current_usage"`
	Limit          int64         `json:"limit"`
}

// AlgoSpec defines the parameters needed by the storage layer to evaluate
// and mutate counter state under a given algorithm.
type AlgoSpec struct {
	Algorithm string        `json:"algorithm"`
	Limit     int64         `json:"limit"`
	Window    time.Duration `json:"window"`
	Burst     int64         `json:"burst"`
}

// Store defines the counter backend contract implemented by in-memory,
// single Redis, Redis Sentinel, and Redis Cluster data planes.
type Store interface {
	// Decide atomically checks and debits cost against the counter bucket at time now.
	Decide(ctx context.Context, key []byte, spec AlgoSpec, cost int64, now time.Time) (Decision, error)

	// Peek inspects the current counter status without debiting quota.
	Peek(ctx context.Context, key []byte, spec AlgoSpec, now time.Time) (Decision, error)

	// Refund credits amount back to the counter (e.g. on upstream cancellation or cached hits).
	Refund(ctx context.Context, key []byte, spec AlgoSpec, amount int64, now time.Time) error
}
