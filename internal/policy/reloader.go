package policy

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/fsnotify/fsnotify"
	"rlgw/internal/clock"
	"rlgw/internal/errors"
)

// DynamicReloader monitors policy configuration files and orchestrates zero-downtime,
// atomic snapshot recompilation on file changes, SIGHUP signals, or explicit API triggers.
type DynamicReloader struct {
	configPath  string
	env         string
	clk         clock.Clock
	snapshot    atomic.Pointer[PolicySnapshot]
	lastErr     atomic.Pointer[string]
	versionSeq  atomic.Int64
	watcher     *fsnotify.Watcher
	stopCh      chan struct{}
	mu          sync.Mutex
	onReload    func(snap *PolicySnapshot)
}

// NewDynamicReloader loads the initial configuration snapshot and initializes the reloader.
func NewDynamicReloader(configPath string, env string, clk clock.Clock) (*DynamicReloader, error) {
	if clk == nil {
		clk = clock.NewRealClock()
	}

	r := &DynamicReloader{
		configPath: configPath,
		env:        env,
		clk:        clk,
		stopCh:     make(chan struct{}),
	}

	// Perform initial load and compilation
	if err := r.Reload(); err != nil {
		return nil, errors.Wrap(errors.ErrCodeConfigInvalid, "initial policy configuration reload failed", err)
	}

	return r, nil
}

// Snapshot returns the current active immutable PolicySnapshot.
// Callers hold a direct pointer; concurrent reloads perform an atomic pointer swap,
// ensuring in-flight requests finish on their snapshot without mixed state.
func (r *DynamicReloader) Snapshot() *PolicySnapshot {
	return r.snapshot.Load()
}

// LastError returns the error from the most recent reload attempt, if any.
func (r *DynamicReloader) LastError() error {
	p := r.lastErr.Load()
	if p == nil || *p == "" {
		return nil
	}
	return errors.New(errors.ErrCodeConfigInvalid, *p)
}

// SetOnReloadHook registers an optional callback invoked whenever a new snapshot is successfully installed.
func (r *DynamicReloader) SetOnReloadHook(fn func(snap *PolicySnapshot)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.onReload = fn
}

// Reload parses the configuration bundle, validates all policies, compiles the radix tree,
// and atomically updates the active snapshot pointer.
func (r *DynamicReloader) Reload() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	// 1. Parse bundle and includes
	bundle, err := LoadBundleWithIncludes(r.configPath, nil)
	if err != nil {
		errStr := err.Error()
		r.lastErr.Store(&errStr)
		return err
	}

	// 2. Validate all policies and templates
	var policies []Policy
	for _, bp := range bundle.Policies {
		p, err := bp.ToPolicy()
		if err != nil {
			errStr := err.Error()
			r.lastErr.Store(&errStr)
			return err
		}
		if valErrs := p.Validate(); len(valErrs) > 0 {
			errStr := fmt.Sprintf("policy %q validation failed: %s", p.ID, valErrs.Error())
			r.lastErr.Store(&errStr)
			return errors.New(errors.ErrCodePolicyInvalid, errStr)
		}
		policies = append(policies, p)
	}

	// Resolve active env
	activeEnv := r.env
	if activeEnv == "" {
		activeEnv = bundle.Env
	}

	// 3. Compile immutable snapshot
	nextVer := r.versionSeq.Add(1)
	newSnap, err := CompileSnapshot(activeEnv, nextVer, policies, bundle.Overrides, r.clk)
	if err != nil {
		errStr := err.Error()
		r.lastErr.Store(&errStr)
		return err
	}

	// 4. Single atomic pointer swap
	r.snapshot.Store(newSnap)
	emptyErr := ""
	r.lastErr.Store(&emptyErr)

	if r.onReload != nil {
		r.onReload(newSnap)
	}

	return nil
}

// StartWatcher starts background fsnotify watching on the configuration file and directory.
func (r *DynamicReloader) StartWatcher() error {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return errors.Wrap(errors.ErrCodeInternal, "failed to initialize fsnotify watcher", err)
	}
	r.watcher = w

	dir := filepath.Dir(r.configPath)
	if err := w.Add(dir); err != nil {
		_ = w.Close()
		return errors.Wrap(errors.ErrCodeInternal, "failed to watch config directory", err)
	}

	go r.watchLoop()
	return nil
}

func (r *DynamicReloader) watchLoop() {
	var debounceTimer *time.Timer
	var debounceCh <-chan time.Time

	for {
		select {
		case <-r.stopCh:
			return
		case event, ok := <-r.watcher.Events:
			if !ok {
				return
			}
			if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
				if debounceTimer != nil {
					debounceTimer.Stop()
				}
				debounceTimer = time.NewTimer(50 * time.Millisecond)
				debounceCh = debounceTimer.C
			}
		case <-debounceCh:
			_ = r.Reload()
		case _, ok := <-r.watcher.Errors:
			if !ok {
				return
			}
		}
	}
}

// StartSignalHandler registers a listener for SIGHUP to trigger configuration reload.
func (r *DynamicReloader) StartSignalHandler() {
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGHUP)

	go func() {
		for {
			select {
			case <-r.stopCh:
				signal.Stop(sigCh)
				return
			case <-sigCh:
				_ = r.Reload()
			}
		}
	}()
}

// Close terminates file watchers and signal listeners.
func (r *DynamicReloader) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	select {
	case <-r.stopCh:
		return nil
	default:
		close(r.stopCh)
	}

	if r.watcher != nil {
		return r.watcher.Close()
	}
	return nil
}
