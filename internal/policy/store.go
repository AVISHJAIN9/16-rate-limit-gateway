package policy

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"rlgw/internal/errors"
)

// AuthSubject represents an authenticated caller in tenant authorization hooks.
type AuthSubject struct {
	ID           string   `json:"id"`
	Tenant       string   `json:"tenant"`
	Roles        []string `json:"roles"`
	IsSuperAdmin bool     `json:"is_super_admin"`
}

// Authorizer enforces tenant-scoped access control on policy service operations.
type Authorizer interface {
	Authorize(ctx context.Context, subject AuthSubject, action string, tenant string, resource string) error
}

// AllowAllAuthorizer is the permissive default authorizer (replaced in Set 6 by RBAC).
type AllowAllAuthorizer struct{}

func (a AllowAllAuthorizer) Authorize(_ context.Context, _ AuthSubject, _ string, _ string, _ string) error {
	return nil
}

// PolicyRecord encapsulates a managed policy document in storage with revision metadata.
type PolicyRecord struct {
	Policy        Policy    `json:"policy"`
	Revision      int64     `json:"revision"`
	ActiveVersion int64     `json:"active_version"`
	ActiveAt      time.Time `json:"active_at"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	Deleted       bool      `json:"deleted"`
}

// VersionRecord stores an immutable historical snapshot of a policy revision.
type VersionRecord struct {
	Version       int64     `json:"version"`
	PolicyID      string    `json:"policy_id"`
	Tenant        string    `json:"tenant"`
	Policy        Policy    `json:"policy"`
	ContentHash   string    `json:"content_hash"`
	Author        string    `json:"author"`
	Reason        string    `json:"reason"`
	CreatedAt     time.Time `json:"created_at"`
	ParentVersion int64     `json:"parent_version"`
	SchemaVersion int       `json:"schema_version"`
}

// OverrideRecord represents a temporary TTL-bound operational override.
type OverrideRecord struct {
	ID         string    `json:"id"`
	Tenant     string    `json:"tenant"`
	PolicyID   string    `json:"policy_id"`
	Owner      string    `json:"owner"`
	Reason     string    `json:"reason"`
	CreatedAt  time.Time `json:"created_at"`
	ExpiresAt  time.Time `json:"expires_at"`
	Limit      *int64    `json:"limit,omitempty"`
	Burst      *int64    `json:"burst,omitempty"`
	Revoked    bool      `json:"revoked"`
	ForceRelax bool      `json:"force_relax"`
}

// TemplateParam defines a typed parameter for policy templating.
type TemplateParam struct {
	Name        string `json:"name"`
	Type        string `json:"type"` // "string", "int", "duration", "bool"
	Required    bool   `json:"required"`
	Default     string `json:"default,omitempty"`
	Description string `json:"description,omitempty"`
}

// TemplateRecord encapsulates a reusable parameterized policy blueprint.
type TemplateRecord struct {
	ID          string          `json:"id"`
	Tenant      string          `json:"tenant"`
	Name        string          `json:"name"`
	Version     int64           `json:"version"`
	Parameters  []TemplateParam `json:"parameters"`
	Body        string          `json:"body"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

// ListFilter provides search criteria when listing policies.
type ListFilter struct {
	Tenant    string    `json:"tenant"`
	Env       string    `json:"env,omitempty"`
	Scope     Scope     `json:"scope,omitempty"`
	Algorithm Algorithm `json:"algorithm,omitempty"`
	Enabled   *bool     `json:"enabled,omitempty"`
	Prefix    string    `json:"prefix,omitempty"`
}

// Pagination parameters.
type Pagination struct {
	Page  int `json:"page"`
	Limit int `json:"limit"`
}

// ListResult holds a page of policies and count metadata.
type ListResult struct {
	Policies []PolicyRecord `json:"policies"`
	Total    int            `json:"total"`
	Page     int            `json:"page"`
	Limit    int            `json:"limit"`
}

// PolicyStore defines the persistence contract for policies, versions, overrides, and templates.
type PolicyStore interface {
	SavePolicy(ctx context.Context, tenant string, record PolicyRecord) error
	GetPolicy(ctx context.Context, tenant string, id string) (PolicyRecord, error)
	ListPolicies(ctx context.Context, tenant string, filter ListFilter, page Pagination) (ListResult, error)
	DeletePolicy(ctx context.Context, tenant string, id string, revision int64) error

	SaveVersion(ctx context.Context, tenant string, ver VersionRecord) error
	GetVersion(ctx context.Context, tenant string, policyID string, version int64) (VersionRecord, error)
	ListVersions(ctx context.Context, tenant string, policyID string) ([]VersionRecord, error)
	PruneVersions(ctx context.Context, tenant string, policyID string, keepCount int) error

	SaveOverride(ctx context.Context, tenant string, ov OverrideRecord) error
	GetOverride(ctx context.Context, tenant string, id string) (OverrideRecord, error)
	ListOverrides(ctx context.Context, tenant string) ([]OverrideRecord, error)
	RevokeOverride(ctx context.Context, tenant string, id string) error

	SaveTemplate(ctx context.Context, tenant string, tmpl TemplateRecord) error
	GetTemplate(ctx context.Context, tenant string, id string) (TemplateRecord, error)
	ListTemplates(ctx context.Context, tenant string) ([]TemplateRecord, error)
	DeleteTemplate(ctx context.Context, tenant string, id string) error

	Close() error
}

// MemPolicyStore provides a thread-safe, in-memory reference implementation of PolicyStore.
type MemPolicyStore struct {
	mu        sync.RWMutex
	policies  map[string]PolicyRecord           // key: tenant + "\x00" + policyID
	versions  map[string][]VersionRecord        // key: tenant + "\x00" + policyID
	overrides map[string]OverrideRecord         // key: tenant + "\x00" + overrideID
	templates map[string]TemplateRecord         // key: tenant + "\x00" + templateID
}

// NewMemPolicyStore creates an empty in-memory store.
func NewMemPolicyStore() *MemPolicyStore {
	return &MemPolicyStore{
		policies:  make(map[string]PolicyRecord),
		versions:  make(map[string][]VersionRecord),
		overrides: make(map[string]OverrideRecord),
		templates: make(map[string]TemplateRecord),
	}
}

func policyKey(tenant, id string) string {
	return tenant + "\x00" + id
}

func (m *MemPolicyStore) SavePolicy(_ context.Context, tenant string, record PolicyRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := policyKey(tenant, record.Policy.ID)
	existing, ok := m.policies[k]
	if ok && !existing.Deleted {
		if record.Revision != existing.Revision {
			return errors.Wrap(errors.ErrCodeConflict,
				fmt.Sprintf("optimistic lock revision conflict: expected %d, got %d", existing.Revision, record.Revision), nil)
		}
	}
	record.Revision++
	m.policies[k] = record
	return nil
}

func (m *MemPolicyStore) GetPolicy(_ context.Context, tenant string, id string) (PolicyRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	k := policyKey(tenant, id)
	rec, ok := m.policies[k]
	if !ok || rec.Deleted {
		return PolicyRecord{}, errors.New(errors.ErrCodeNotFound, fmt.Sprintf("policy %q not found for tenant %q", id, tenant))
	}
	return rec, nil
}

func (m *MemPolicyStore) ListPolicies(_ context.Context, tenant string, filter ListFilter, page Pagination) (ListResult, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var matching []PolicyRecord
	for k, rec := range m.policies {
		if rec.Deleted {
			continue
		}
		parts := strings.Split(k, "\x00")
		if tenant != "" && (len(parts) != 2 || parts[0] != tenant) {
			continue
		}
		if filter.Env != "" && rec.Policy.Match.Env != "" && rec.Policy.Match.Env != filter.Env {
			continue
		}
		if filter.Scope != "" && rec.Policy.Scope != filter.Scope {
			continue
		}
		if filter.Algorithm != "" && rec.Policy.Algorithm != filter.Algorithm {
			continue
		}
		if filter.Enabled != nil && rec.Policy.Enabled != *filter.Enabled {
			continue
		}
		if filter.Prefix != "" && !strings.HasPrefix(rec.Policy.ID, filter.Prefix) {
			continue
		}
		matching = append(matching, rec)
	}

	sort.Slice(matching, func(i, j int) bool {
		return matching[i].Policy.ID < matching[j].Policy.ID
	})

	total := len(matching)
	if page.Limit <= 0 {
		page.Limit = 50
	}
	if page.Page <= 0 {
		page.Page = 1
	}

	start := (page.Page - 1) * page.Limit
	if start >= total {
		return ListResult{Policies: []PolicyRecord{}, Total: total, Page: page.Page, Limit: page.Limit}, nil
	}
	end := start + page.Limit
	if end > total {
		end = total
	}

	return ListResult{
		Policies: matching[start:end],
		Total:    total,
		Page:     page.Page,
		Limit:    page.Limit,
	}, nil
}

func (m *MemPolicyStore) DeletePolicy(_ context.Context, tenant string, id string, revision int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := policyKey(tenant, id)
	existing, ok := m.policies[k]
	if !ok || existing.Deleted {
		return errors.New(errors.ErrCodeNotFound, fmt.Sprintf("policy %q not found for tenant %q", id, tenant))
	}
	if revision != 0 && existing.Revision != revision {
		return errors.Wrap(errors.ErrCodeConflict,
			fmt.Sprintf("optimistic lock revision conflict on delete: expected %d, got %d", existing.Revision, revision), nil)
	}
	existing.Deleted = true
	existing.Revision++
	existing.UpdatedAt = time.Now()
	m.policies[k] = existing
	return nil
}

func (m *MemPolicyStore) SaveVersion(_ context.Context, tenant string, ver VersionRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := policyKey(tenant, ver.PolicyID)
	vers := m.versions[k]
	for _, v := range vers {
		if v.Version == ver.Version {
			return errors.New(errors.ErrCodeConflict, fmt.Sprintf("version %d already exists for policy %s", ver.Version, ver.PolicyID))
		}
	}
	m.versions[k] = append(vers, ver)
	return nil
}

func (m *MemPolicyStore) GetVersion(_ context.Context, tenant string, policyID string, version int64) (VersionRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	k := policyKey(tenant, policyID)
	for _, v := range m.versions[k] {
		if v.Version == version {
			return v, nil
		}
	}
	return VersionRecord{}, errors.New(errors.ErrCodeNotFound, fmt.Sprintf("version %d not found for policy %s", version, policyID))
}

func (m *MemPolicyStore) ListVersions(_ context.Context, tenant string, policyID string) ([]VersionRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	k := policyKey(tenant, policyID)
	vers := m.versions[k]
	res := make([]VersionRecord, len(vers))
	copy(res, vers)
	sort.Slice(res, func(i, j int) bool {
		return res[i].Version < res[j].Version
	})
	return res, nil
}

func (m *MemPolicyStore) PruneVersions(_ context.Context, tenant string, policyID string, keepCount int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := policyKey(tenant, policyID)
	vers := m.versions[k]
	if len(vers) <= keepCount || keepCount <= 0 {
		return nil
	}
	sort.Slice(vers, func(i, j int) bool {
		return vers[i].Version < vers[j].Version
	})
	// Keep the most recent keepCount versions
	m.versions[k] = vers[len(vers)-keepCount:]
	return nil
}

func (m *MemPolicyStore) SaveOverride(_ context.Context, tenant string, ov OverrideRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := policyKey(tenant, ov.ID)
	m.overrides[k] = ov
	return nil
}

func (m *MemPolicyStore) GetOverride(_ context.Context, tenant string, id string) (OverrideRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	k := policyKey(tenant, id)
	ov, ok := m.overrides[k]
	if !ok || ov.Revoked {
		return OverrideRecord{}, errors.New(errors.ErrCodeNotFound, fmt.Sprintf("override %q not found for tenant %q", id, tenant))
	}
	return ov, nil
}

func (m *MemPolicyStore) ListOverrides(_ context.Context, tenant string) ([]OverrideRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var matching []OverrideRecord
	for k, ov := range m.overrides {
		if ov.Revoked {
			continue
		}
		parts := strings.Split(k, "\x00")
		if len(parts) == 2 && parts[0] == tenant {
			matching = append(matching, ov)
		}
	}
	return matching, nil
}

func (m *MemPolicyStore) RevokeOverride(_ context.Context, tenant string, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := policyKey(tenant, id)
	ov, ok := m.overrides[k]
	if !ok || ov.Revoked {
		return errors.New(errors.ErrCodeNotFound, fmt.Sprintf("override %q not found for tenant %q", id, tenant))
	}
	ov.Revoked = true
	m.overrides[k] = ov
	return nil
}

func (m *MemPolicyStore) SaveTemplate(_ context.Context, tenant string, tmpl TemplateRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := policyKey(tenant, tmpl.ID)
	m.templates[k] = tmpl
	return nil
}

func (m *MemPolicyStore) GetTemplate(_ context.Context, tenant string, id string) (TemplateRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	k := policyKey(tenant, id)
	tmpl, ok := m.templates[k]
	if !ok {
		return TemplateRecord{}, errors.New(errors.ErrCodeNotFound, fmt.Sprintf("template %q not found for tenant %q", id, tenant))
	}
	return tmpl, nil
}

func (m *MemPolicyStore) ListTemplates(_ context.Context, tenant string) ([]TemplateRecord, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var matching []TemplateRecord
	for k, tmpl := range m.templates {
		parts := strings.Split(k, "\x00")
		if len(parts) == 2 && parts[0] == tenant {
			matching = append(matching, tmpl)
		}
	}
	return matching, nil
}

func (m *MemPolicyStore) DeleteTemplate(_ context.Context, tenant string, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	k := policyKey(tenant, id)
	if _, ok := m.templates[k]; !ok {
		return errors.New(errors.ErrCodeNotFound, fmt.Sprintf("template %q not found for tenant %q", id, tenant))
	}
	delete(m.templates, k)
	return nil
}

func (m *MemPolicyStore) Close() error {
	return nil
}
