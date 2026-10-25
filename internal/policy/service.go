package policy

import (
	"context"
	"fmt"
	"reflect"
	"time"

	"rlgw/internal/clock"
	"rlgw/internal/errors"
)

// PolicyDiffField details a specific field variance between two policy versions.
type PolicyDiffField struct {
	Field    string `json:"field"`
	OldValue any    `json:"old_value"`
	NewValue any    `json:"new_value"`
	Action   string `json:"action"` // "modified", "added", "removed"
}

// PolicyDiff summarizes changes between two policy revisions.
type PolicyDiff struct {
	PolicyID    string            `json:"policy_id"`
	FromVersion int64             `json:"from_version"`
	ToVersion   int64             `json:"to_version"`
	Fields      []PolicyDiffField `json:"fields"`
}

// ServiceConfig defines parameters for PolicyService execution.
type ServiceConfig struct {
	MaxVersionsPerPolicy int
	MaxRelaxFactor       float64
}

// PolicyService orchestrates policy CRUD, versioning, activations, rollbacks, overrides, and templates.
type PolicyService struct {
	store      PolicyStore
	auth       Authorizer
	clk        clock.Clock
	cfg        ServiceConfig
	nodeMap    map[string]*PolicyNode // for inheritance resolution
}

// NewPolicyService creates an initialized PolicyService.
func NewPolicyService(store PolicyStore, auth Authorizer, clk clock.Clock, cfg ServiceConfig) *PolicyService {
	if auth == nil {
		auth = AllowAllAuthorizer{}
	}
	if clk == nil {
		clk = clock.NewRealClock()
	}
	if cfg.MaxVersionsPerPolicy <= 0 {
		cfg.MaxVersionsPerPolicy = 50
	}
	if cfg.MaxRelaxFactor <= 1.0 {
		cfg.MaxRelaxFactor = DefaultMaxRelaxFactor
	}

	return &PolicyService{
		store:   store,
		auth:    auth,
		clk:     clk,
		cfg:     cfg,
		nodeMap: make(map[string]*PolicyNode),
	}
}

// CreatePolicy validates and creates a new policy, publishing its initial version (v1).
func (s *PolicyService) CreatePolicy(ctx context.Context, sub AuthSubject, p Policy, author, reason string) (PolicyRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "create", p.Tenant, p.ID); err != nil {
		return PolicyRecord{}, err
	}

	p.Version = 1
	if valErrs := p.Validate(); len(valErrs) > 0 {
		return PolicyRecord{}, errors.Wrap(errors.ErrCodePolicyInvalid, valErrs.Error(), nil)
	}

	hash, err := p.ContentHash()
	if err != nil {
		return PolicyRecord{}, err
	}

	now := s.clk.Now()
	rec := PolicyRecord{
		Policy:        p,
		Revision:      0,
		ActiveVersion: 1,
		ActiveAt:      now,
		CreatedAt:     now,
		UpdatedAt:     now,
	}

	if err := s.store.SavePolicy(ctx, p.Tenant, rec); err != nil {
		return PolicyRecord{}, err
	}

	ver := VersionRecord{
		Version:       1,
		PolicyID:      p.ID,
		Tenant:        p.Tenant,
		Policy:        p,
		ContentHash:   hash,
		Author:        author,
		Reason:        reason,
		CreatedAt:     now,
		ParentVersion: 0,
		SchemaVersion: 1,
	}

	if err := s.store.SaveVersion(ctx, p.Tenant, ver); err != nil {
		return PolicyRecord{}, err
	}

	saved, err := s.store.GetPolicy(ctx, p.Tenant, p.ID)
	if err == nil {
		return saved, nil
	}
	return rec, nil
}

// GetPolicy retrieves a policy for a tenant.
func (s *PolicyService) GetPolicy(ctx context.Context, sub AuthSubject, tenant, id string) (PolicyRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "read", tenant, id); err != nil {
		return PolicyRecord{}, err
	}
	return s.store.GetPolicy(ctx, tenant, id)
}

// ListPolicies lists policies matching filter criteria.
func (s *PolicyService) ListPolicies(ctx context.Context, sub AuthSubject, filter ListFilter, page Pagination) (ListResult, error) {
	if err := s.auth.Authorize(ctx, sub, "list", filter.Tenant, ""); err != nil {
		return ListResult{}, err
	}
	return s.store.ListPolicies(ctx, filter.Tenant, filter, page)
}

// UpdatePolicy updates a policy with optimistic concurrency revision checking and monotonic versioning.
func (s *PolicyService) UpdatePolicy(ctx context.Context, sub AuthSubject, p Policy, expectedRevision int64, author, reason string) (PolicyRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "update", p.Tenant, p.ID); err != nil {
		return PolicyRecord{}, err
	}

	existing, err := s.store.GetPolicy(ctx, p.Tenant, p.ID)
	if err != nil {
		return PolicyRecord{}, err
	}

	if existing.Revision != expectedRevision {
		return PolicyRecord{}, errors.Wrap(errors.ErrCodeConflict,
			fmt.Sprintf("revision conflict: current revision is %d, expected %d", existing.Revision, expectedRevision), nil)
	}

	// Bump monotonic version
	newVerNum := existing.Policy.Version + 1
	p.Version = newVerNum

	if valErrs := p.Validate(); len(valErrs) > 0 {
		return PolicyRecord{}, errors.Wrap(errors.ErrCodePolicyInvalid, valErrs.Error(), nil)
	}

	hash, err := p.ContentHash()
	if err != nil {
		return PolicyRecord{}, err
	}

	now := s.clk.Now()
	rec := PolicyRecord{
		Policy:        p,
		Revision:      existing.Revision,
		ActiveVersion: newVerNum,
		ActiveAt:      now,
		CreatedAt:     existing.CreatedAt,
		UpdatedAt:     now,
	}

	if err := s.store.SavePolicy(ctx, p.Tenant, rec); err != nil {
		return PolicyRecord{}, err
	}

	ver := VersionRecord{
		Version:       newVerNum,
		PolicyID:      p.ID,
		Tenant:        p.Tenant,
		Policy:        p,
		ContentHash:   hash,
		Author:        author,
		Reason:        reason,
		CreatedAt:     now,
		ParentVersion: existing.Policy.Version,
		SchemaVersion: 1,
	}

	if err := s.store.SaveVersion(ctx, p.Tenant, ver); err != nil {
		return PolicyRecord{}, err
	}

	// Apply retention policy
	_ = s.store.PruneVersions(ctx, p.Tenant, p.ID, s.cfg.MaxVersionsPerPolicy)

	saved, err := s.store.GetPolicy(ctx, p.Tenant, p.ID)
	if err == nil {
		return saved, nil
	}
	return rec, nil
}

// DeletePolicy deletes a policy subject to optimistic concurrency revision checks.
func (s *PolicyService) DeletePolicy(ctx context.Context, sub AuthSubject, tenant, id string, revision int64) error {
	if err := s.auth.Authorize(ctx, sub, "delete", tenant, id); err != nil {
		return err
	}
	return s.store.DeletePolicy(ctx, tenant, id, revision)
}

// GetVersion retrieves a specific version record.
func (s *PolicyService) GetVersion(ctx context.Context, sub AuthSubject, tenant, policyID string, version int64) (VersionRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "read", tenant, policyID); err != nil {
		return VersionRecord{}, err
	}
	return s.store.GetVersion(ctx, tenant, policyID, version)
}

// ListVersions lists all historical versions for a policy.
func (s *PolicyService) ListVersions(ctx context.Context, sub AuthSubject, tenant, policyID string) ([]VersionRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "list_versions", tenant, policyID); err != nil {
		return nil, err
	}
	return s.store.ListVersions(ctx, tenant, policyID)
}

// ActivateVersion atomically updates the active version pointer of a policy.
func (s *PolicyService) ActivateVersion(ctx context.Context, sub AuthSubject, tenant, policyID string, version int64, activateAt time.Time) error {
	if err := s.auth.Authorize(ctx, sub, "activate", tenant, policyID); err != nil {
		return err
	}

	ver, err := s.store.GetVersion(ctx, tenant, policyID, version)
	if err != nil {
		return err
	}

	rec, err := s.store.GetPolicy(ctx, tenant, policyID)
	if err != nil {
		return err
	}

	if activateAt.IsZero() {
		activateAt = s.clk.Now()
	}

	rec.Policy = ver.Policy
	rec.ActiveVersion = version
	rec.ActiveAt = activateAt
	rec.UpdatedAt = s.clk.Now()

	return s.store.SavePolicy(ctx, tenant, rec)
}

// DiffVersions computes a dry-run diff between two policy versions.
func (s *PolicyService) DiffVersions(ctx context.Context, sub AuthSubject, tenant, policyID string, fromVer, toVer int64) (PolicyDiff, error) {
	if err := s.auth.Authorize(ctx, sub, "diff", tenant, policyID); err != nil {
		return PolicyDiff{}, err
	}

	vFrom, err := s.store.GetVersion(ctx, tenant, policyID, fromVer)
	if err != nil {
		return PolicyDiff{}, err
	}
	vTo, err := s.store.GetVersion(ctx, tenant, policyID, toVer)
	if err != nil {
		return PolicyDiff{}, err
	}

	diff := PolicyDiff{
		PolicyID:    policyID,
		FromVersion: fromVer,
		ToVersion:   toVer,
	}

	p1, p2 := vFrom.Policy, vTo.Policy
	checkField := func(name string, val1, val2 any) {
		if !reflect.DeepEqual(val1, val2) {
			diff.Fields = append(diff.Fields, PolicyDiffField{
				Field:    name,
				OldValue: val1,
				NewValue: val2,
				Action:   "modified",
			})
		}
	}

	checkField(FieldAlgorithm, p1.Algorithm, p2.Algorithm)
	checkField(FieldScope, p1.Scope, p2.Scope)
	checkField(FieldLimit, p1.Limit, p2.Limit)
	checkField(FieldWindow, p1.Window, p2.Window)
	checkField(FieldBurst, p1.Burst, p2.Burst)
	checkField(FieldPriority, p1.Priority, p2.Priority)
	checkField(FieldEnabled, p1.Enabled, p2.Enabled)
	checkField(FieldCostSpec, p1.CostSpec, p2.CostSpec)
	checkField(FieldOnReject, p1.OnReject, p2.OnReject)
	checkField(FieldMatch, p1.Match, p2.Match)
	checkField(FieldLabels, p1.Labels, p2.Labels)

	return diff, nil
}

// RollbackPolicy rolls back to a previous version by committing it as a new revision.
func (s *PolicyService) RollbackPolicy(ctx context.Context, sub AuthSubject, tenant, policyID string, targetVersion int64, author, reason string) (PolicyRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "rollback", tenant, policyID); err != nil {
		return PolicyRecord{}, err
	}

	targetVer, err := s.store.GetVersion(ctx, tenant, policyID, targetVersion)
	if err != nil {
		return PolicyRecord{}, err
	}

	// Schema version compatibility check
	if targetVer.SchemaVersion > 1 {
		return PolicyRecord{}, errors.New(errors.ErrCodeVersionIncompatible,
			fmt.Sprintf("cannot roll back to version %d with incompatible schema version %d", targetVersion, targetVer.SchemaVersion))
	}

	rec, err := s.store.GetPolicy(ctx, tenant, policyID)
	if err != nil {
		return PolicyRecord{}, err
	}

	// Clone policy and update as new version
	rollbackPolicy := targetVer.Policy
	newVerNum := rec.Policy.Version + 1
	rollbackPolicy.Version = newVerNum

	hash, err := rollbackPolicy.ContentHash()
	if err != nil {
		return PolicyRecord{}, err
	}

	now := s.clk.Now()
	rec.Policy = rollbackPolicy
	rec.ActiveVersion = newVerNum
	rec.ActiveAt = now
	rec.UpdatedAt = now

	if err := s.store.SavePolicy(ctx, tenant, rec); err != nil {
		return PolicyRecord{}, err
	}

	newVerRecord := VersionRecord{
		Version:       newVerNum,
		PolicyID:      policyID,
		Tenant:        tenant,
		Policy:        rollbackPolicy,
		ContentHash:   hash,
		Author:        author,
		Reason:        fmt.Sprintf("Rollback to version %d: %s", targetVersion, reason),
		CreatedAt:     now,
		ParentVersion: rec.Policy.Version,
		SchemaVersion: targetVer.SchemaVersion,
	}

	if err := s.store.SaveVersion(ctx, tenant, newVerRecord); err != nil {
		return PolicyRecord{}, err
	}

	saved, err := s.store.GetPolicy(ctx, tenant, policyID)
	if err == nil {
		return saved, nil
	}
	return rec, nil
}

// CreateOverride creates a temporary operational override with relaxation safeguards.
func (s *PolicyService) CreateOverride(ctx context.Context, sub AuthSubject, ov OverrideRecord) error {
	if err := s.auth.Authorize(ctx, sub, "override", ov.Tenant, ov.PolicyID); err != nil {
		return err
	}

	orig, err := s.store.GetPolicy(ctx, ov.Tenant, ov.PolicyID)
	if err != nil {
		return err
	}

	// Validate relaxation limit
	if err := ValidateRelaxation(orig.Policy, ov, s.cfg.MaxRelaxFactor); err != nil {
		return err
	}

	if ov.CreatedAt.IsZero() {
		ov.CreatedAt = s.clk.Now()
	}

	return s.store.SaveOverride(ctx, ov.Tenant, ov)
}

// RevokeOverride revokes an active override.
func (s *PolicyService) RevokeOverride(ctx context.Context, sub AuthSubject, tenant, id string) error {
	if err := s.auth.Authorize(ctx, sub, "revoke_override", tenant, id); err != nil {
		return err
	}
	return s.store.RevokeOverride(ctx, tenant, id)
}

// ListOverrides returns all unrevoked overrides for a tenant.
func (s *PolicyService) ListOverrides(ctx context.Context, sub AuthSubject, tenant string) ([]OverrideRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "list_overrides", tenant, ""); err != nil {
		return nil, err
	}
	return s.store.ListOverrides(ctx, tenant)
}

// CreateTemplate creates a reusable parameterized blueprint.
func (s *PolicyService) CreateTemplate(ctx context.Context, sub AuthSubject, tmpl TemplateRecord) error {
	if err := s.auth.Authorize(ctx, sub, "create_template", tmpl.Tenant, tmpl.ID); err != nil {
		return err
	}
	if tmpl.CreatedAt.IsZero() {
		tmpl.CreatedAt = s.clk.Now()
	}
	tmpl.UpdatedAt = s.clk.Now()
	return s.store.SaveTemplate(ctx, tmpl.Tenant, tmpl)
}

// GetTemplate retrieves a template.
func (s *PolicyService) GetTemplate(ctx context.Context, sub AuthSubject, tenant, id string) (TemplateRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "read_template", tenant, id); err != nil {
		return TemplateRecord{}, err
	}
	return s.store.GetTemplate(ctx, tenant, id)
}

// ListTemplates lists all templates for a tenant.
func (s *PolicyService) ListTemplates(ctx context.Context, sub AuthSubject, tenant string) ([]TemplateRecord, error) {
	if err := s.auth.Authorize(ctx, sub, "list_templates", tenant, ""); err != nil {
		return nil, err
	}
	return s.store.ListTemplates(ctx, tenant)
}

// InstantiateTemplate creates a new Policy from a parameterized template.
func (s *PolicyService) InstantiateTemplate(ctx context.Context, sub AuthSubject, tenant, tmplID string, params map[string]string, author, reason string) (PolicyRecord, error) {
	tmpl, err := s.GetTemplate(ctx, sub, tenant, tmplID)
	if err != nil {
		return PolicyRecord{}, err
	}

	p, err := InstantiateTemplate(tmpl, params)
	if err != nil {
		return PolicyRecord{}, err
	}

	return s.CreatePolicy(ctx, sub, p, author, reason)
}
