package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/identity"
	"rlgw/internal/obs"
	"rlgw/internal/policy"
	"rlgw/internal/store/memory"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	slog.Info("Starting Rate-Limit Gateway (rlgw) Foundation data plane", "version", "0.1.0")

	// Global injectable clock
	clk := clock.NewRealClock()
	recorder := obs.NewNoOpRecorder()

	// Initialize API key lookup and sample keys
	keyStore := identity.NewInMemoryKeyLookup()
	keyStore.RegisterKey(identity.APIKey{
		KeyID:    "admin",
		ClientID: "client_root",
		Tenant:   "system",
	})

	// Identity resolver pipeline: API Key -> User Header -> IP Fallback
	apiSource := identity.NewAPIKeySource(keyStore, "X-API-Key")
	userSource := identity.NewUserIDSource("X-User-ID", false)
	ipSource := identity.NewIPSource(identity.NewUntrustedProxyChecker(), identity.DefaultIPv6PrefixBits)
	resolver := identity.NewResolver([]identity.IdentitySource{apiSource, userSource}, ipSource, recorder)

	// In-memory counter store (Set 5 wires Redis)
	memStore := memory.NewMemoryStore(100_000)

	// Key builder with collision-free binary and Redis cluster hash-tag strings
	keyBuilder := identity.NewKeyBuilder(identity.KeyBuilderOptions{
		IncludePolicyVersion: false,
		Namespace:            "rl",
	})

	// Root gateway router
	gwMux := http.NewServeMux()
	gwMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"healthy","uptime_monotonic":true}`))
	})

	gwMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		var id identity.Identity
		if err := resolver.Resolve(r.Context(), r, &id); err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = fmt.Fprintf(w, `{"error":"unauthorized","detail":"%s"}`, err.Error())
			return
		}

		w.Header().Set("X-Gateway-Identity-Source", id.Source)
		w.Header().Set("X-Gateway-Client", id.ClientID)
		w.Header().Set("X-Gateway-Tenant", id.Tenant)
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"status":"ok","source":"%s","tenant":"%s","client_id":"%s"}`, id.Source, id.Tenant, id.ClientID)
	})

	// Admin listener router
	adminMux := http.NewServeMux()
	adminMux.HandleFunc("/admin/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"admin_ok"}`))
	})
	adminMux.HandleFunc("/admin/policies/sample", func(w http.ResponseWriter, r *http.Request) {
		samplePolicy := policy.Policy{
			ID:        "pol-default",
			Name:      "Default Ingress Rate Limit",
			Version:   1,
			Tenant:    "global",
			Scope:     policy.ScopeClient,
			Algorithm: policy.AlgorithmTokenBucket,
			Limit:     1000,
			Window:    time.Minute,
			Burst:     1500,
			Enabled:   true,
		}
		canon, err := samplePolicy.CanonicalJSON()
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		hash, _ := samplePolicy.ContentHash()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", hash)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(canon)
	})

	gwPort := os.Getenv("GATEWAY_PORT")
	if gwPort == "" {
		gwPort = "8080"
	}
	adminPort := os.Getenv("ADMIN_PORT")
	if adminPort == "" {
		adminPort = "8081"
	}

	gwServer := &http.Server{
		Addr:              ":" + gwPort,
		Handler:           gwMux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	adminServer := &http.Server{
		Addr:              ":" + adminPort,
		Handler:           adminMux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("Gateway listener starting", "addr", gwServer.Addr)
		if err := gwServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Gateway server error", "error", err)
		}
	}()

	go func() {
		slog.Info("Admin listener starting", "addr", adminServer.Addr)
		if err := adminServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Admin server error", "error", err)
		}
	}()

	_ = clk
	_ = memStore
	_ = keyBuilder

	<-ctx.Done()
	slog.Info("Shutdown signal received, initiating graceful drain")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := gwServer.Shutdown(shutdownCtx); err != nil {
		slog.Error("Gateway shutdown error", "error", err)
	}
	if err := adminServer.Shutdown(shutdownCtx); err != nil {
		slog.Error("Admin shutdown error", "error", err)
	}
	slog.Info("All listeners safely shut down")
}
