package policy

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"rlgw/internal/clock"
)

func TestDynamicReloadAtomicityConcurrentResolvers(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "policies.yaml")

	// Initial configuration with version 1
	yamlV1 := `
version: 1
env: prod
policies:
  - id: "pol-concurrent-test"
    name: "Concurrent Test V1"
    tenant: "acme"
    algorithm: "token_bucket"
    scope: "client"
    limit: 100
    burst: 100
    window: "1m"
    enabled: true
    match:
      route_pattern: "/api/v1/test"
      methods: ["GET"]
`
	if err := os.WriteFile(configPath, []byte(yamlV1), 0o600); err != nil {
		t.Fatalf("failed to write initial config: %v", err)
	}

	clk := clock.NewRealClock()
	reloader, err := NewDynamicReloader(configPath, "prod", clk)
	if err != nil {
		t.Fatalf("failed to create reloader: %v", err)
	}
	defer reloader.Close()

	const concurrentResolvers = 100
	const requestsPerResolver = 1000

	var wg sync.WaitGroup
	wg.Add(concurrentResolvers)

	stopCh := make(chan struct{})

	// Background worker repeatedly updating the configuration file and reloading
	var reloadWg sync.WaitGroup
	reloadWg.Add(1)
	go func() {
		defer reloadWg.Done()
		iteration := 1
		for {
			select {
			case <-stopCh:
				return
			default:
				time.Sleep(5 * time.Millisecond)
				iteration++
				limit := 100 + iteration
				updatedYAML := fmt.Sprintf(`
version: 1
env: prod
policies:
  - id: "pol-concurrent-test"
    name: "Concurrent Test V%d"
    tenant: "acme"
    algorithm: "token_bucket"
    scope: "client"
    limit: %d
    burst: %d
    window: "1m"
    enabled: true
    match:
      route_pattern: "/api/v1/test"
      methods: ["GET"]
`, iteration, limit, limit)
				_ = os.WriteFile(configPath, []byte(updatedYAML), 0o600)
				_ = reloader.Reload()
			}
		}
	}()

	// 100 concurrent resolvers
	for i := 0; i < concurrentResolvers; i++ {
		go func(workerID int) {
			defer wg.Done()
			req := RouteRequest{
				Method: "GET",
				Path:   "/api/v1/test",
			}
			id := RequestIdentity{
				Tenant:   "acme",
				ClientID: fmt.Sprintf("client-%d", workerID),
			}

			for j := 0; j < requestsPerResolver; j++ {
				snap := reloader.Snapshot()
				if snap == nil {
					t.Errorf("worker %d: snapshot is nil", workerID)
					return
				}

				res, err := snap.Resolve(req, id)
				if err != nil {
					t.Errorf("worker %d: resolve error: %v", workerID, err)
					return
				}
				if len(res) != 1 {
					t.Errorf("worker %d: expected 1 resolved policy, got %d", workerID, len(res))
					return
				}

				// Consistency check: policy limit and burst must match (no torn reads or mixed state)
				p := res[0].Policy
				if p.Limit != p.Burst {
					t.Errorf("worker %d: INCONSISTENT MIXED STATE! Limit (%d) != Burst (%d)", workerID, p.Limit, p.Burst)
					return
				}
				if len(res[0].BinaryKey) == 0 || res[0].RedisKey() == "" {
					t.Errorf("worker %d: prebuilt keys missing", workerID)
					return
				}
			}
		}(i)
	}

	wg.Wait()
	close(stopCh)
	reloadWg.Wait()
}

func BenchmarkSnapshotResolve1000Policies(b *testing.B) {
	const totalPolicies = 1000
	policies := make([]Policy, totalPolicies)

	for i := 0; i < totalPolicies; i++ {
		policies[i] = Policy{
			ID:        fmt.Sprintf("pol-bench-%04d", i),
			Name:      fmt.Sprintf("Benchmark Policy %d", i),
			Tenant:    fmt.Sprintf("tenant-%02d", i%20),
			Algorithm: AlgorithmTokenBucket,
			Scope:     ScopeClient,
			Limit:     100,
			Burst:     150,
			Window:    time.Minute,
			Enabled:   true,
			Priority:  i,
			Match: MatchSpec{
				RoutePattern: fmt.Sprintf("/api/v1/routes/%d/{id}", i/20),
				Methods:      []string{"GET", "POST"},
			},
		}
	}

	clk := clock.NewRealClock()
	snap, err := CompileSnapshot("prod", 1, policies, nil, clk)
	if err != nil {
		b.Fatalf("failed to compile snapshot: %v", err)
	}

	req := RouteRequest{
		Method: "GET",
		Path:   "/api/v1/routes/25/item-999",
	}
	id := RequestIdentity{
		Tenant:   "tenant-05",
		ClientID: "client-vip-123",
	}

	// Warmup
	res, err := snap.Resolve(req, id)
	if err != nil || len(res) == 0 {
		b.Fatalf("resolve failed during warmup: %v, len=%d", err, len(res))
	}

	b.ResetTimer()
	b.ReportAllocs()

	for i := 0; i < b.N; i++ {
		_, _ = snap.Resolve(req, id)
	}
}
