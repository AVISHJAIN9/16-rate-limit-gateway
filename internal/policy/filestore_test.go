package policy

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"rlgw/internal/errors"
)

func TestFilePolicyStoreWALAndSnapshot(t *testing.T) {
	dir := t.TempDir()
	cfg := FileStoreConfig{
		Dir:            dir,
		Fsync:          FsyncAlways,
		SnapshotEveryN: 3, // Auto-snapshot after 3 mutations
	}

	fs, err := NewFilePolicyStore(cfg)
	if err != nil {
		t.Fatalf("failed to create FilePolicyStore: %v", err)
	}
	defer fs.Close()

	ctx := context.Background()

	p1 := PolicyRecord{
		Policy: Policy{
			ID:        "pol-1",
			Name:      "Policy 1",
			Tenant:    "tenant-a",
			Algorithm: AlgorithmTokenBucket,
			Scope:     ScopeClient,
			Limit:     100,
			Burst:     100,
			Window:    time.Minute,
			Enabled:   true,
		},
		Revision: 0,
	}

	if err := fs.SavePolicy(ctx, "tenant-a", p1); err != nil {
		t.Fatalf("save policy 1 failed: %v", err)
	}

	p2 := PolicyRecord{
		Policy: Policy{
			ID:        "pol-2",
			Name:      "Policy 2",
			Tenant:    "tenant-a",
			Algorithm: AlgorithmFixedWindow,
			Scope:     ScopeIP,
			Limit:     50,
			Burst:     50,
			Window:    time.Second,
			Enabled:   true,
		},
		Revision: 0,
	}

	if err := fs.SavePolicy(ctx, "tenant-a", p2); err != nil {
		t.Fatalf("save policy 2 failed: %v", err)
	}

	// 3rd mutation triggers snapshot
	p1Updated := p1
	p1Updated.Revision = 1
	p1Updated.Policy.Limit = 150
	if err := fs.SavePolicy(ctx, "tenant-a", p1Updated); err != nil {
		t.Fatalf("save policy 1 updated failed: %v", err)
	}

	// Close first instance
	if err := fs.Close(); err != nil {
		t.Fatalf("failed to close store: %v", err)
	}

	// Reopen second instance and verify recovery
	fs2, err := NewFilePolicyStore(cfg)
	if err != nil {
		t.Fatalf("failed to reopen FilePolicyStore: %v", err)
	}
	defer fs2.Close()

	rec, err := fs2.GetPolicy(ctx, "tenant-a", "pol-1")
	if err != nil {
		t.Fatalf("failed to get policy 1 after recovery: %v", err)
	}
	if rec.Policy.Limit != 150 {
		t.Fatalf("expected limit 150 from recovered store, got %d", rec.Policy.Limit)
	}

	rec2, err := fs2.GetPolicy(ctx, "tenant-a", "pol-2")
	if err != nil {
		t.Fatalf("failed to get policy 2 after recovery: %v", err)
	}
	if rec2.Policy.Limit != 50 {
		t.Fatalf("expected limit 50, got %d", rec2.Policy.Limit)
	}
}

func TestFilePolicyStoreCrashRecoveryTruncatedRecord(t *testing.T) {
	dir := t.TempDir()
	cfg := FileStoreConfig{
		Dir:   dir,
		Fsync: FsyncAlways,
	}

	fs, err := NewFilePolicyStore(cfg)
	if err != nil {
		t.Fatalf("failed to create FilePolicyStore: %v", err)
	}

	ctx := context.Background()

	p1 := PolicyRecord{
		Policy: Policy{
			ID:        "pol-valid",
			Name:      "Valid Policy",
			Tenant:    "tenant-crash",
			Algorithm: AlgorithmTokenBucket,
			Scope:     ScopeClient,
			Limit:     100,
			Burst:     100,
			Window:    time.Minute,
			Enabled:   true,
		},
		Revision: 0,
	}

	if err := fs.SavePolicy(ctx, "tenant-crash", p1); err != nil {
		t.Fatalf("save policy failed: %v", err)
	}
	_ = fs.Close()

	// Simulate crash: append a truncated / corrupt JSON record to wal.jsonl
	walPath := filepath.Join(dir, "wal.jsonl")
	f, err := os.OpenFile(walPath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("failed to open wal file: %v", err)
	}
	// Incomplete truncated json record line
	_, _ = f.WriteString(`{"ts":123456789,"tenant":"tenant-crash","action":"save_policy","payload":{"policy":{"id":"pol-corrupt",` + "\n")
	_ = f.Close()

	// Reopen store -> should recover the valid record and cleanly truncate the corrupt line
	fsRecovered, err := NewFilePolicyStore(cfg)
	if err != nil {
		t.Fatalf("failed to recover store with truncated record: %v", err)
	}
	defer fsRecovered.Close()

	// Valid policy must exist
	rec, err := fsRecovered.GetPolicy(ctx, "tenant-crash", "pol-valid")
	if err != nil {
		t.Fatalf("expected valid policy to be recovered, got err: %v", err)
	}
	if rec.Policy.ID != "pol-valid" {
		t.Fatalf("expected pol-valid, got %s", rec.Policy.ID)
	}

	// Corrupt policy must NOT exist
	_, err = fsRecovered.GetPolicy(ctx, "tenant-crash", "pol-corrupt")
	if err == nil || !errors.IsCode(err, errors.ErrCodeNotFound) {
		t.Fatalf("expected corrupt policy to not exist, got: %v", err)
	}

	// Appending new mutations should continue working cleanly
	p2 := PolicyRecord{
		Policy: Policy{
			ID:        "pol-after-recovery",
			Name:      "After Recovery",
			Tenant:    "tenant-crash",
			Algorithm: AlgorithmGCRA,
			Scope:     ScopeIP,
			Limit:     20,
			Burst:     20,
			Window:    time.Second,
			Enabled:   true,
		},
	}
	if err := fsRecovered.SavePolicy(ctx, "tenant-crash", p2); err != nil {
		t.Fatalf("failed to save policy after recovery: %v", err)
	}

	rec2, err := fsRecovered.GetPolicy(ctx, "tenant-crash", "pol-after-recovery")
	if err != nil {
		t.Fatalf("failed to retrieve policy saved after recovery: %v", err)
	}
	if rec2.Policy.ID != "pol-after-recovery" {
		t.Fatalf("unexpected policy ID: %s", rec2.Policy.ID)
	}
}
