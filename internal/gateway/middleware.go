package gateway

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"runtime/debug"

	"rlgw/internal/identity"
)

// Middleware is a composable function that wraps an http.Handler.
type Middleware func(http.Handler) http.Handler

// Chain combines multiple middlewares into a single middleware adhering to canonical execution order:
// recovery → request-id → normalize → identity → limit → circuit-breaker → proxy
func Chain(middlewares ...Middleware) Middleware {
	return func(final http.Handler) http.Handler {
		for i := len(middlewares) - 1; i >= 0; i-- {
			final = middlewares[i](final)
		}
		return final
	}
}

// RecoveryMiddleware catches panics, logs stack traces, and safely emits a 500 JSON error.
func RecoveryMiddleware(logger *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					stack := debug.Stack()
					if logger != nil {
						logger.Error("Unhandled panic in HTTP gateway pipeline", "panic", rec, "stack", string(stack))
					} else {
						slog.Error("Unhandled panic in HTTP gateway pipeline", "panic", rec)
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusInternalServerError)
					_, _ = w.Write([]byte(`{"error":"internal_server_error","message":"An unexpected panic occurred"}`))
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// RequestIDMiddleware ensures every request has a validated, sanitized X-Request-Id header.
func RequestIDMiddleware(parser *HeaderParser) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			reqID := parser.ExtractOrGenerateRequestID(r)
			w.Header().Set("X-Request-Id", reqID)
			next.ServeHTTP(w, r)
		})
	}
}

// NormalizeMiddleware enforces path canonicalization before routing and key derivation.
// Rejects path traversal beyond root, NUL bytes, and invalid UTF-8 with 400 Bad Request.
func NormalizeMiddleware(norm *Normalizer) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			canonical, err := norm.Normalize(r.URL.Path)
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"bad_request","message":%q}`, err.Error())))
				return
			}

			// If preserve raw path is disabled, mutate URL.Path to canonical
			if !norm.PreserveRawPath() {
				r.URL.Path = canonical
			}

			next.ServeHTTP(w, r)
		})
	}
}

// IdentityMiddleware extracts caller identity (API key, User ID, IP fallback) into context.
func IdentityMiddleware(resolver *identity.Resolver) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var id identity.Identity
			if err := resolver.Resolve(r.Context(), r, &id); err != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"unauthorized","message":%q}`, err.Error())))
				return
			}

			ctx := context.WithValue(r.Context(), contextKeyIdentity, &id)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// LimiterMiddleware intercepts requests and enforces multi-policy two-phase rate limits.
func LimiterMiddleware(limiter *RateLimiter) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, _ := r.Context().Value(contextKeyIdentity).(*identity.Identity)
			if id == nil {
				// Fallback blank identity
				id = &identity.Identity{}
			}
			limiter.ServeHTTPOrDeny(w, r, id, next)
		})
	}
}

// CircuitBreakerMiddleware guards upstreams and refunds rate limit tokens if the breaker trips.
func CircuitBreakerMiddleware(proxy *ProxyManager) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Find route and cluster
			canonical := r.URL.Path
			route := proxy.FindRoute(r.Method, canonical)
			if route != nil {
				cluster := proxy.GetUpstream(route.UpstreamID)
				if cluster != nil && cluster.Breaker != nil {
					if !cluster.Breaker.Allow() {
						// Breaker tripped: refund any rate limit quota debited for this request!
						if refundFn, ok := r.Context().Value(contextKeyRefundFn).(func()); ok && refundFn != nil {
							refundFn()
						}
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(http.StatusServiceUnavailable)
						_, _ = w.Write([]byte(fmt.Sprintf(`{"error":"service_unavailable","message":"Circuit breaker open for upstream %s"}`, cluster.ID)))
						return
					}
				}
			}

			next.ServeHTTP(w, r)
		})
	}
}

// NewStandaloneLimiterMiddleware creates a rate-limiting middleware suitable for embedding
// as a library inside any third-party Go HTTP web service.
func NewStandaloneLimiterMiddleware(opts LimiterOptions, resolver *identity.Resolver) Middleware {
	limiter := NewRateLimiter(opts)
	parser := opts.HeaderParser
	if parser == nil {
		parser = NewHeaderParser(nil, "X-Request-Id")
	}
	norm := NewNormalizer(DefaultNormalizerConfig())

	return Chain(
		RecoveryMiddleware(nil),
		RequestIDMiddleware(parser),
		NormalizeMiddleware(norm),
		IdentityMiddleware(resolver),
		LimiterMiddleware(limiter),
	)
}
