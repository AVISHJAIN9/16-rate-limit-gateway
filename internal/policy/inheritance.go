package policy

import (
	"encoding/json"
	"fmt"
	"strings"

	"rlgw/internal/errors"
)

// InheritanceLayer identifies the conceptual tier in the hierarchical inheritance model.
type InheritanceLayer string

const (
	LayerGlobal      InheritanceLayer = "global"
	LayerTenant      InheritanceLayer = "tenant"
	LayerEnvironment InheritanceLayer = "environment"
	LayerRouteGroup  InheritanceLayer = "route-group"
	LayerRoute       InheritanceLayer = "route"
)

// Standard field names tracked for presence and provenance.
const (
	FieldAlgorithm         = "algorithm"
	FieldScope             = "scope"
	FieldLimit             = "limit"
	FieldWindow            = "window"
	FieldBurst             = "burst"
	FieldCostSpec          = "cost_spec"
	FieldOnReject          = "on_reject"
	FieldOnMissingIdentity = "on_missing_identity"
	FieldPriority          = "priority"
	FieldEnabled           = "enabled"
	FieldLabels            = "labels"
	FieldMatch             = "match"
)

// PolicyNode represents a policy participating in an inheritance hierarchy.
type PolicyNode struct {
	ID        string           `json:"id"`
	ParentID  string           `json:"parent_id,omitempty"`
	Layer     InheritanceLayer `json:"layer"`
	Policy    Policy           `json:"policy"`
	Specified map[string]bool  `json:"specified"` // Explicitly provided fields
}

// EffectivePolicy encapsulates a fully resolved policy with field-level provenance metadata.
type EffectivePolicy struct {
	Policy     Policy            `json:"policy"`
	Provenance map[string]string `json:"provenance"` // field -> "layer:id"
}

// ComputeEffectivePolicy resolves inheritance from root (global) down to leaf (route).
// Returns ErrCodePolicyCycle if circular inheritance is discovered.
func ComputeEffectivePolicy(leafID string, nodeMap map[string]*PolicyNode) (*EffectivePolicy, error) {
	// 1. Build chain from leaf up to root with cycle detection
	var chain []*PolicyNode
	visited := make(map[string]bool)

	currID := leafID
	for currID != "" {
		if visited[currID] {
			return nil, errors.New(errors.ErrCodePolicyCycle,
				fmt.Sprintf("inheritance cycle detected at policy %q", currID))
		}
		visited[currID] = true

		node, ok := nodeMap[currID]
		if !ok {
			return nil, errors.New(errors.ErrCodeNotFound,
				fmt.Sprintf("referenced parent policy %q not found in inheritance tree", currID))
		}
		chain = append(chain, node)
		currID = node.ParentID
	}

	// 2. Reverse chain so we apply from root (e.g. global) down to leaf (e.g. route)
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}

	// 3. Fold policies
	eff := &EffectivePolicy{
		Policy:     Policy{Labels: make(map[string]string)},
		Provenance: make(map[string]string),
	}

	// Default base ID and Tenant from leaf
	leaf := chain[len(chain)-1]
	eff.Policy.ID = leaf.Policy.ID
	eff.Policy.Name = leaf.Policy.Name
	eff.Policy.Tenant = leaf.Policy.Tenant
	eff.Policy.Version = leaf.Policy.Version

	for _, node := range chain {
		src := fmt.Sprintf("%s:%s", node.Layer, node.ID)

		if node.Specified[FieldAlgorithm] || eff.Policy.Algorithm == "" {
			eff.Policy.Algorithm = node.Policy.Algorithm
			eff.Provenance[FieldAlgorithm] = src
		}
		if node.Specified[FieldScope] || eff.Policy.Scope == "" {
			eff.Policy.Scope = node.Policy.Scope
			eff.Provenance[FieldScope] = src
		}
		if node.Specified[FieldLimit] || eff.Policy.Limit == 0 {
			eff.Policy.Limit = node.Policy.Limit
			eff.Provenance[FieldLimit] = src
		}
		if node.Specified[FieldWindow] || eff.Policy.Window == 0 {
			eff.Policy.Window = node.Policy.Window
			eff.Provenance[FieldWindow] = src
		}
		if node.Specified[FieldBurst] || eff.Policy.Burst == 0 {
			eff.Policy.Burst = node.Policy.Burst
			eff.Provenance[FieldBurst] = src
		}
		if node.Specified[FieldCostSpec] || eff.Policy.CostSpec.Mode == "" {
			eff.Policy.CostSpec = node.Policy.CostSpec
			eff.Provenance[FieldCostSpec] = src
		}
		if node.Specified[FieldOnReject] || eff.Policy.OnReject.Status == 0 {
			eff.Policy.OnReject = node.Policy.OnReject
			eff.Provenance[FieldOnReject] = src
		}
		if node.Specified[FieldOnMissingIdentity] || eff.Policy.OnMissingIdentity == "" {
			eff.Policy.OnMissingIdentity = node.Policy.OnMissingIdentity
			eff.Provenance[FieldOnMissingIdentity] = src
		}
		if node.Specified[FieldPriority] || eff.Policy.Priority == 0 {
			eff.Policy.Priority = node.Policy.Priority
			eff.Provenance[FieldPriority] = src
		}
		if node.Specified[FieldEnabled] {
			eff.Policy.Enabled = node.Policy.Enabled
			eff.Provenance[FieldEnabled] = src
		} else if _, ok := eff.Provenance[FieldEnabled]; !ok {
			eff.Policy.Enabled = node.Policy.Enabled
			eff.Provenance[FieldEnabled] = src
		}

		if node.Specified[FieldMatch] {
			eff.Policy.Match = node.Policy.Match
			eff.Provenance[FieldMatch] = src
		}

		// Labels merge: child values take precedence, new labels added
		if len(node.Policy.Labels) > 0 {
			for k, v := range node.Policy.Labels {
				eff.Policy.Labels[k] = v
				eff.Provenance[FieldLabels+"."+k] = src
			}
		}
	}

	return eff, nil
}

// LayerPrecedenceOrder returns layers ordered by precedence from highest to lowest.
func LayerPrecedenceOrder() []InheritanceLayer {
	return []InheritanceLayer{
		LayerRoute,
		LayerRouteGroup,
		LayerEnvironment,
		LayerTenant,
		LayerGlobal,
	}
}

// ParseSpecifiedFields detects which fields in a raw JSON object were explicitly defined.
func ParseSpecifiedFields(rawJSON []byte) (map[string]bool, error) {
	var m map[string]any
	if err := json.Unmarshal(rawJSON, &m); err != nil {
		return nil, err
	}
	res := make(map[string]bool)
	for k := range m {
		res[strings.ToLower(k)] = true
	}
	return res, nil
}
