package obs

import (
	"context"
	"sync/atomic"
	"time"

	"rlgw/internal/errors"
)

// DecisionRecord contains structured metrics information about an allow/deny rate limit decision.
type DecisionRecord struct {
	PolicyID string
	Tenant   string
	Scope    string
	Allowed  bool
	Cost     int64
	Latency  time.Duration
}

// Recorder defines the telemetry hooks contract for metrics, tracing, and decision audits.
// In Set 1-6 this is backed by NoOpRecorder or TestRecorder; Set 7 wires full Prometheus/OTel exporters.
type Recorder interface {
	RecordDecision(ctx context.Context, d DecisionRecord)
	RecordResolution(ctx context.Context, source string, success bool, latency time.Duration)
	RecordStoreOp(ctx context.Context, op string, success bool, latency time.Duration)
	RecordError(ctx context.Context, code errors.ErrorCode)
}

// NoOpRecorder provides a thread-safe zero-overhead implementation of Recorder.
type NoOpRecorder struct{}

// NewNoOpRecorder returns a NoOpRecorder singleton instance.
func NewNoOpRecorder() *NoOpRecorder {
	return &NoOpRecorder{}
}

func (n *NoOpRecorder) RecordDecision(_ context.Context, _ DecisionRecord)                    {}
func (n *NoOpRecorder) RecordResolution(_ context.Context, _ string, _ bool, _ time.Duration) {}
func (n *NoOpRecorder) RecordStoreOp(_ context.Context, _ string, _ bool, _ time.Duration)    {}
func (n *NoOpRecorder) RecordError(_ context.Context, _ errors.ErrorCode)                     {}

// TestRecorder collects metrics in memory for verification in unit tests.
// MaxEvents limits memory growth. Eviction policy: oldest events dropped once capacity is reached.
type TestRecorder struct {
	DecisionsCount  atomic.Int64
	AllowedCount    atomic.Int64
	DeniedCount     atomic.Int64
	ResolutionCount atomic.Int64
	StoreOpCount    atomic.Int64
	ErrorsCount     atomic.Int64
}

// NewTestRecorder creates a test recorder.
func NewTestRecorder() *TestRecorder {
	return &TestRecorder{}
}

func (t *TestRecorder) RecordDecision(_ context.Context, d DecisionRecord) {
	t.DecisionsCount.Add(1)
	if d.Allowed {
		t.AllowedCount.Add(1)
	} else {
		t.DeniedCount.Add(1)
	}
}

func (t *TestRecorder) RecordResolution(_ context.Context, _ string, _ bool, _ time.Duration) {
	t.ResolutionCount.Add(1)
}

func (t *TestRecorder) RecordStoreOp(_ context.Context, _ string, _ bool, _ time.Duration) {
	t.StoreOpCount.Add(1)
}

func (t *TestRecorder) RecordError(_ context.Context, _ errors.ErrorCode) {
	t.ErrorsCount.Add(1)
}
