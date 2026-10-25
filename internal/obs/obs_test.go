package obs

import (
	"context"
	"testing"
	"time"

	"rlgw/internal/errors"
)

func TestNoOpRecorder(t *testing.T) {
	ctx := context.Background()
	noop := NewNoOpRecorder()
	noop.RecordDecision(ctx, DecisionRecord{
		PolicyID: "pol-1",
		Tenant:   "tenant-a",
		Scope:    "client",
		Allowed:  true,
		Cost:     1,
		Latency:  50 * time.Microsecond,
	})
	noop.RecordResolution(ctx, "api_key", true, 20*time.Nanosecond)
	noop.RecordStoreOp(ctx, "decide", true, 100*time.Nanosecond)
	noop.RecordError(ctx, errors.ErrCodeStoreUnavailable)
}

func TestTestRecorder(t *testing.T) {
	ctx := context.Background()
	rec := NewTestRecorder()

	rec.RecordDecision(ctx, DecisionRecord{
		PolicyID: "pol-1",
		Allowed:  true,
	})
	rec.RecordDecision(ctx, DecisionRecord{
		PolicyID: "pol-2",
		Allowed:  false,
	})
	rec.RecordResolution(ctx, "api_key", true, 10*time.Nanosecond)
	rec.RecordStoreOp(ctx, "peek", true, 25*time.Nanosecond)
	rec.RecordError(ctx, errors.ErrCodeMissingDimension)

	if rec.DecisionsCount.Load() != 2 {
		t.Fatalf("expected 2 decisions, got %d", rec.DecisionsCount.Load())
	}
	if rec.AllowedCount.Load() != 1 {
		t.Fatalf("expected 1 allowed, got %d", rec.AllowedCount.Load())
	}
	if rec.DeniedCount.Load() != 1 {
		t.Fatalf("expected 1 denied, got %d", rec.DeniedCount.Load())
	}
	if rec.ResolutionCount.Load() != 1 {
		t.Fatalf("expected 1 resolution, got %d", rec.ResolutionCount.Load())
	}
	if rec.StoreOpCount.Load() != 1 {
		t.Fatalf("expected 1 store op, got %d", rec.StoreOpCount.Load())
	}
	if rec.ErrorsCount.Load() != 1 {
		t.Fatalf("expected 1 error, got %d", rec.ErrorsCount.Load())
	}
}
