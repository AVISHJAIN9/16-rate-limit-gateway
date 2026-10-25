package identity

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"rlgw/internal/errors"
)

// APIKey represents parsed metadata for a gateway API key.
type APIKey struct {
	KeyID    string
	Secret   string
	ClientID string
	Tenant   string
}

// String implements fmt.Stringer and guarantees the API key secret is NEVER printed in logs.
func (k APIKey) String() string {
	if k.KeyID == "" {
		return "rlk_***REDACTED***"
	}
	return fmt.Sprintf("rlk_%s_***REDACTED***", k.KeyID)
}

// ParseAPIKey parses a raw API key in format "rlk_<keyid>_<secret>".
// It extracts keyid and secret without allocations and without validating the secret signature (Set 6 validates).
func ParseAPIKey(raw string) (APIKey, error) {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, "rlk_") {
		return APIKey{}, errors.Wrap(errors.ErrCodeInvalidAPIKey, "api key must begin with prefix 'rlk_'", nil)
	}

	rest := trimmed[4:]
	idx := strings.IndexByte(rest, '_')
	if idx <= 0 || idx == len(rest)-1 {
		return APIKey{}, errors.Wrap(errors.ErrCodeInvalidAPIKey, "api key format must be 'rlk_<keyid>_<secret>'", nil)
	}

	// Verify no additional underscores exist in <secret>
	if strings.IndexByte(rest[idx+1:], '_') != -1 {
		return APIKey{}, errors.Wrap(errors.ErrCodeInvalidAPIKey, "api key format must be 'rlk_<keyid>_<secret>'", nil)
	}

	keyID := rest[:idx]
	secret := rest[idx+1:]

	return APIKey{
		KeyID:  keyID,
		Secret: secret,
	}, nil
}

// KeyLookup defines the contract to resolve an APIKey's metadata from its key ID.
type KeyLookup interface {
	LookupKey(ctx context.Context, keyID string) (APIKey, error)
}

// InMemoryKeyLookup provides a thread-safe in-memory store for APIKey lookups.
type InMemoryKeyLookup struct {
	mu   sync.RWMutex
	keys map[string]APIKey
}

// NewInMemoryKeyLookup creates an initialized InMemoryKeyLookup.
func NewInMemoryKeyLookup() *InMemoryKeyLookup {
	return &InMemoryKeyLookup{
		keys: make(map[string]APIKey, 128),
	}
}

// RegisterKey registers an API key metadata record in memory.
func (m *InMemoryKeyLookup) RegisterKey(key APIKey) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.keys[key.KeyID] = key
}

// LookupKey returns the APIKey associated with keyID or ErrKeyNotFound.
func (m *InMemoryKeyLookup) LookupKey(_ context.Context, keyID string) (APIKey, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	k, exists := m.keys[keyID]
	if !exists {
		return APIKey{}, errors.ErrKeyNotFound
	}
	return k, nil
}
