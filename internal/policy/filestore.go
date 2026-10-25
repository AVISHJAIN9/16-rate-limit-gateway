package policy

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"rlgw/internal/errors"
)

// FsyncPolicy defines disk synchronization guarantees for the Write-Ahead Log.
type FsyncPolicy string

const (
	FsyncAlways   FsyncPolicy = "always"
	FsyncPeriodic FsyncPolicy = "periodic"
	FsyncNever    FsyncPolicy = "never"
)

// WALAction enumerates atomic mutations recorded in the write-ahead log.
type WALAction string

const (
	ActionSavePolicy     WALAction = "save_policy"
	ActionDeletePolicy   WALAction = "delete_policy"
	ActionSaveVersion    WALAction = "save_version"
	ActionPruneVersions  WALAction = "prune_versions"
	ActionSaveOverride   WALAction = "save_override"
	ActionRevokeOverride WALAction = "revoke_override"
	ActionSaveTemplate   WALAction = "save_template"
	ActionDeleteTemplate WALAction = "delete_template"
)

// WALRecord models a single serialized operation in the append-only JSONL log.
type WALRecord struct {
	Timestamp int64           `json:"ts"`
	Tenant    string          `json:"tenant"`
	Action    WALAction       `json:"action"`
	Payload   json.RawMessage `json:"payload"`
}

// PrunePayload is the payload for ActionPruneVersions.
type PrunePayload struct {
	PolicyID  string `json:"policy_id"`
	KeepCount int    `json:"keep_count"`
}

// FileStoreConfig configures directory paths and durability options.
type FileStoreConfig struct {
	Dir             string
	Fsync           FsyncPolicy
	FsyncInterval   time.Duration
	SnapshotEveryN  int // automatically snapshot after N mutations (0 disables auto snapshot)
}

// FilePolicyStore implements durable PolicyStore with append-only JSONL WAL and periodic snapshots.
type FilePolicyStore struct {
	cfg        FileStoreConfig
	mu         sync.RWMutex
	mem        *MemPolicyStore
	walFile    *os.File
	walWriter  *bufio.Writer
	mutCount   int
	closed     bool
	stopTicker chan struct{}
}

// NewFilePolicyStore initializes the file store, recovering from snapshot and WAL replay.
func NewFilePolicyStore(cfg FileStoreConfig) (*FilePolicyStore, error) {
	if cfg.Dir == "" {
		return nil, errors.New(errors.ErrCodeConfigInvalid, "filestore directory cannot be empty")
	}
	if cfg.Fsync == "" {
		cfg.Fsync = FsyncAlways
	}
	if cfg.FsyncInterval <= 0 {
		cfg.FsyncInterval = 50 * time.Millisecond
	}

	if err := os.MkdirAll(cfg.Dir, 0o750); err != nil {
		return nil, errors.Wrap(errors.ErrCodeInternal, "failed to create filestore directory", err)
	}

	fs := &FilePolicyStore{
		cfg:        cfg,
		mem:        NewMemPolicyStore(),
		stopTicker: make(chan struct{}),
	}

	// 1. Recover from snapshot if present
	if err := fs.recoverSnapshot(); err != nil {
		return nil, err
	}

	// 2. Replay WAL up to last valid entry, tolerating truncated final records
	if err := fs.recoverWAL(); err != nil {
		return nil, err
	}

	// 3. Open WAL for appending
	walPath := filepath.Join(cfg.Dir, "wal.jsonl")
	f, err := os.OpenFile(walPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, errors.Wrap(errors.ErrCodeInternal, "failed to open wal file", err)
	}
	fs.walFile = f
	fs.walWriter = bufio.NewWriter(f)

	if cfg.Fsync == FsyncPeriodic {
		go fs.periodicSyncer()
	}

	return fs, nil
}

type snapshotData struct {
	Policies  map[string]PolicyRecord    `json:"policies"`
	Versions  map[string][]VersionRecord `json:"versions"`
	Overrides map[string]OverrideRecord  `json:"overrides"`
	Templates map[string]TemplateRecord  `json:"templates"`
}

func (fs *FilePolicyStore) recoverSnapshot() error {
	snapPath := filepath.Join(fs.cfg.Dir, "snapshot.json")
	data, err := os.ReadFile(snapPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to read snapshot file", err)
	}

	var snap snapshotData
	if err := json.Unmarshal(data, &snap); err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to unmarshal snapshot file", err)
	}

	fs.mem.mu.Lock()
	defer fs.mem.mu.Unlock()
	if snap.Policies != nil {
		fs.mem.policies = snap.Policies
	}
	if snap.Versions != nil {
		fs.mem.versions = snap.Versions
	}
	if snap.Overrides != nil {
		fs.mem.overrides = snap.Overrides
	}
	if snap.Templates != nil {
		fs.mem.templates = snap.Templates
	}

	return nil
}

func (fs *FilePolicyStore) recoverWAL() error {
	walPath := filepath.Join(fs.cfg.Dir, "wal.jsonl")
	f, err := os.Open(walPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to open wal for recovery", err)
	}
	defer f.Close()

	reader := bufio.NewReader(f)
	var validOffset int64 = 0

	ctx := context.Background()

	for {
		line, isPrefix, err := reader.ReadLine()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.Wrap(errors.ErrCodeInternal, "error reading wal during recovery", err)
		}
		if isPrefix {
			// Extremely long line, continue reading remaining chunks
			var fullLine bytes.Buffer
			fullLine.Write(line)
			for isPrefix {
				chunk, prefix, err := reader.ReadLine()
				if err != nil {
					break
				}
				fullLine.Write(chunk)
				isPrefix = prefix
			}
			line = fullLine.Bytes()
		}

		if len(bytes.TrimSpace(line)) == 0 {
			validOffset += int64(len(line)) + 1
			continue
		}

		var rec WALRecord
		if err := json.Unmarshal(line, &rec); err != nil {
			// Corrupt or truncated final record. Stop replay and truncate at valid offset.
			break
		}

		// Replay into memory
		if err := fs.replayRecord(ctx, rec); err != nil {
			// Mutation conflict or replay error: stop replay
			break
		}

		// Record valid line offset
		validOffset += int64(len(line)) + 1 // +1 for \n
	}

	// Truncate any incomplete or corrupt trailing bytes to ensure clean append-only log
	if fi, err := f.Stat(); err == nil && fi.Size() > validOffset {
		_ = os.Truncate(walPath, validOffset)
	}

	return nil
}

func (fs *FilePolicyStore) replayRecord(ctx context.Context, rec WALRecord) error {
	switch rec.Action {
	case ActionSavePolicy:
		var pol PolicyRecord
		if err := json.Unmarshal(rec.Payload, &pol); err != nil {
			return err
		}
		// Direct memory assign to preserve exact revision from WAL
		fs.mem.mu.Lock()
		k := policyKey(rec.Tenant, pol.Policy.ID)
		fs.mem.policies[k] = pol
		fs.mem.mu.Unlock()

	case ActionDeletePolicy:
		var polID string
		if err := json.Unmarshal(rec.Payload, &polID); err != nil {
			return err
		}
		fs.mem.mu.Lock()
		k := policyKey(rec.Tenant, polID)
		if existing, ok := fs.mem.policies[k]; ok {
			existing.Deleted = true
			existing.Revision++
			fs.mem.policies[k] = existing
		}
		fs.mem.mu.Unlock()

	case ActionSaveVersion:
		var ver VersionRecord
		if err := json.Unmarshal(rec.Payload, &ver); err != nil {
			return err
		}
		_ = fs.mem.SaveVersion(ctx, rec.Tenant, ver)

	case ActionPruneVersions:
		var prune PrunePayload
		if err := json.Unmarshal(rec.Payload, &prune); err != nil {
			return err
		}
		_ = fs.mem.PruneVersions(ctx, rec.Tenant, prune.PolicyID, prune.KeepCount)

	case ActionSaveOverride:
		var ov OverrideRecord
		if err := json.Unmarshal(rec.Payload, &ov); err != nil {
			return err
		}
		_ = fs.mem.SaveOverride(ctx, rec.Tenant, ov)

	case ActionRevokeOverride:
		var ovID string
		if err := json.Unmarshal(rec.Payload, &ovID); err != nil {
			return err
		}
		_ = fs.mem.RevokeOverride(ctx, rec.Tenant, ovID)

	case ActionSaveTemplate:
		var tmpl TemplateRecord
		if err := json.Unmarshal(rec.Payload, &tmpl); err != nil {
			return err
		}
		_ = fs.mem.SaveTemplate(ctx, rec.Tenant, tmpl)

	case ActionDeleteTemplate:
		var tmplID string
		if err := json.Unmarshal(rec.Payload, &tmplID); err != nil {
			return err
		}
		_ = fs.mem.DeleteTemplate(ctx, rec.Tenant, tmplID)
	}

	return nil
}

func (fs *FilePolicyStore) appendWAL(tenant string, action WALAction, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to marshal wal payload", err)
	}

	rec := WALRecord{
		Timestamp: time.Now().UnixNano(),
		Tenant:    tenant,
		Action:    action,
		Payload:   raw,
	}

	line, err := json.Marshal(rec)
	if err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to marshal wal record", err)
	}
	line = append(line, '\n')

	if _, err := fs.walWriter.Write(line); err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to write to wal buffer", err)
	}

	if fs.cfg.Fsync == FsyncAlways {
		if err := fs.walWriter.Flush(); err != nil {
			return errors.Wrap(errors.ErrCodeInternal, "failed to flush wal writer", err)
		}
		if err := fs.walFile.Sync(); err != nil {
			return errors.Wrap(errors.ErrCodeInternal, "failed to fsync wal", err)
		}
	}

	fs.mutCount++
	if fs.cfg.SnapshotEveryN > 0 && fs.mutCount >= fs.cfg.SnapshotEveryN {
		fs.mutCount = 0
		_ = fs.createSnapshotLocked()
	}

	return nil
}

func (fs *FilePolicyStore) periodicSyncer() {
	ticker := time.NewTicker(fs.cfg.FsyncInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			fs.mu.Lock()
			if !fs.closed && fs.walWriter != nil {
				_ = fs.walWriter.Flush()
				_ = fs.walFile.Sync()
			}
			fs.mu.Unlock()
		case <-fs.stopTicker:
			return
		}
	}
}

// Snapshot creates an atomic snapshot and resets the WAL file.
func (fs *FilePolicyStore) Snapshot() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	return fs.createSnapshotLocked()
}

func (fs *FilePolicyStore) createSnapshotLocked() error {
	if fs.closed {
		return errors.New(errors.ErrCodeInternal, "filestore is closed")
	}

	// 1. Flush current WAL writer
	if err := fs.walWriter.Flush(); err != nil {
		return err
	}
	if err := fs.walFile.Sync(); err != nil {
		return err
	}

	// 2. Dump in-memory state
	fs.mem.mu.RLock()
	snap := snapshotData{
		Policies:  make(map[string]PolicyRecord, len(fs.mem.policies)),
		Versions:  make(map[string][]VersionRecord, len(fs.mem.versions)),
		Overrides: make(map[string]OverrideRecord, len(fs.mem.overrides)),
		Templates: make(map[string]TemplateRecord, len(fs.mem.templates)),
	}
	for k, v := range fs.mem.policies {
		snap.Policies[k] = v
	}
	for k, v := range fs.mem.versions {
		snap.Versions[k] = v
	}
	for k, v := range fs.mem.overrides {
		snap.Overrides[k] = v
	}
	for k, v := range fs.mem.templates {
		snap.Templates[k] = v
	}
	fs.mem.mu.RUnlock()

	data, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to marshal snapshot", err)
	}

	// 3. Write temp file and atomically rename
	tmpSnap := filepath.Join(fs.cfg.Dir, "snapshot.json.tmp")
	if err := os.WriteFile(tmpSnap, data, 0o600); err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to write temp snapshot", err)
	}
	finalSnap := filepath.Join(fs.cfg.Dir, "snapshot.json")
	if err := os.Rename(tmpSnap, finalSnap); err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to rename snapshot", err)
	}

	// 4. Truncate WAL file
	_ = fs.walFile.Close()
	walPath := filepath.Join(fs.cfg.Dir, "wal.jsonl")
	f, err := os.OpenFile(walPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to truncate wal after snapshot", err)
	}
	fs.walFile = f
	fs.walWriter = bufio.NewWriter(f)

	return nil
}

func (fs *FilePolicyStore) SavePolicy(ctx context.Context, tenant string, record PolicyRecord) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.mem.SavePolicy(ctx, tenant, record); err != nil {
		return err
	}
	// Fetch the saved record with the updated revision
	saved, _ := fs.mem.GetPolicy(ctx, tenant, record.Policy.ID)
	return fs.appendWAL(tenant, ActionSavePolicy, saved)
}

func (fs *FilePolicyStore) GetPolicy(ctx context.Context, tenant string, id string) (PolicyRecord, error) {
	return fs.mem.GetPolicy(ctx, tenant, id)
}

func (fs *FilePolicyStore) ListPolicies(ctx context.Context, tenant string, filter ListFilter, page Pagination) (ListResult, error) {
	return fs.mem.ListPolicies(ctx, tenant, filter, page)
}

func (fs *FilePolicyStore) DeletePolicy(ctx context.Context, tenant string, id string, revision int64) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.mem.DeletePolicy(ctx, tenant, id, revision); err != nil {
		return err
	}
	return fs.appendWAL(tenant, ActionDeletePolicy, id)
}

func (fs *FilePolicyStore) SaveVersion(ctx context.Context, tenant string, ver VersionRecord) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.mem.SaveVersion(ctx, tenant, ver); err != nil {
		return err
	}
	return fs.appendWAL(tenant, ActionSaveVersion, ver)
}

func (fs *FilePolicyStore) GetVersion(ctx context.Context, tenant string, policyID string, version int64) (VersionRecord, error) {
	return fs.mem.GetVersion(ctx, tenant, policyID, version)
}

func (fs *FilePolicyStore) ListVersions(ctx context.Context, tenant string, policyID string) ([]VersionRecord, error) {
	return fs.mem.ListVersions(ctx, tenant, policyID)
}

func (fs *FilePolicyStore) PruneVersions(ctx context.Context, tenant string, policyID string, keepCount int) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.mem.PruneVersions(ctx, tenant, policyID, keepCount); err != nil {
		return err
	}
	return fs.appendWAL(tenant, ActionPruneVersions, PrunePayload{PolicyID: policyID, KeepCount: keepCount})
}

func (fs *FilePolicyStore) SaveOverride(ctx context.Context, tenant string, ov OverrideRecord) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.mem.SaveOverride(ctx, tenant, ov); err != nil {
		return err
	}
	return fs.appendWAL(tenant, ActionSaveOverride, ov)
}

func (fs *FilePolicyStore) GetOverride(ctx context.Context, tenant string, id string) (OverrideRecord, error) {
	return fs.mem.GetOverride(ctx, tenant, id)
}

func (fs *FilePolicyStore) ListOverrides(ctx context.Context, tenant string) ([]OverrideRecord, error) {
	return fs.mem.ListOverrides(ctx, tenant)
}

func (fs *FilePolicyStore) RevokeOverride(ctx context.Context, tenant string, id string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.mem.RevokeOverride(ctx, tenant, id); err != nil {
		return err
	}
	return fs.appendWAL(tenant, ActionRevokeOverride, id)
}

func (fs *FilePolicyStore) SaveTemplate(ctx context.Context, tenant string, tmpl TemplateRecord) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.mem.SaveTemplate(ctx, tenant, tmpl); err != nil {
		return err
	}
	return fs.appendWAL(tenant, ActionSaveTemplate, tmpl)
}

func (fs *FilePolicyStore) GetTemplate(ctx context.Context, tenant string, id string) (TemplateRecord, error) {
	return fs.mem.GetTemplate(ctx, tenant, id)
}

func (fs *FilePolicyStore) ListTemplates(ctx context.Context, tenant string) ([]TemplateRecord, error) {
	return fs.mem.ListTemplates(ctx, tenant)
}

func (fs *FilePolicyStore) DeleteTemplate(ctx context.Context, tenant string, id string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if err := fs.mem.DeleteTemplate(ctx, tenant, id); err != nil {
		return err
	}
	return fs.appendWAL(tenant, ActionDeleteTemplate, id)
}

func (fs *FilePolicyStore) Close() error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	if fs.closed {
		return nil
	}
	fs.closed = true

	close(fs.stopTicker)

	if fs.walWriter != nil {
		_ = fs.walWriter.Flush()
	}
	if fs.walFile != nil {
		_ = fs.walFile.Sync()
		_ = fs.walFile.Close()
	}

	return nil
}
