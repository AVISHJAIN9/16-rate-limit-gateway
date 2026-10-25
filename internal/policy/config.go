package policy

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
	"rlgw/internal/errors"
)

// BundleSchemaVersion tracks the supported policy bundle schema version.
const CurrentBundleSchemaVersion = 1

// PolicyBundle defines the structured configuration schema for declarative policy packs.
type PolicyBundle struct {
	Version   int               `yaml:"version" json:"version"`
	Env       string            `yaml:"env,omitempty" json:"env,omitempty"`
	Includes  []string          `yaml:"includes,omitempty" json:"includes,omitempty"`
	Policies  []BundlePolicy    `yaml:"policies,omitempty" json:"policies,omitempty"`
	Templates []TemplateRecord  `yaml:"templates,omitempty" json:"templates,omitempty"`
	Overrides []OverrideRecord  `yaml:"overrides,omitempty" json:"overrides,omitempty"`
}

// BundlePolicy defines policy fields in config files with human-friendly string durations.
type BundlePolicy struct {
	ID                string                  `yaml:"id" json:"id"`
	Name              string                  `yaml:"name" json:"name"`
	Version           int64                   `yaml:"version" json:"version"`
	Tenant            string                  `yaml:"tenant" json:"tenant"`
	Scope             Scope                   `yaml:"scope" json:"scope"`
	Algorithm         Algorithm               `yaml:"algorithm" json:"algorithm"`
	Limit             int64                   `yaml:"limit" json:"limit"`
	Window            string                  `yaml:"window" json:"window"` // e.g. "1m", "10s", "1h"
	Burst             int64                   `yaml:"burst" json:"burst"`
	Priority          int                     `yaml:"priority,omitempty" json:"priority,omitempty"`
	Enabled           bool                    `yaml:"enabled" json:"enabled"`
	Match             MatchSpec               `yaml:"match,omitempty" json:"match,omitempty"`
	CostSpec          CostSpec                `yaml:"cost_spec,omitempty" json:"cost_spec,omitempty"`
	OnReject          OnRejectSpec            `yaml:"on_reject,omitempty" json:"on_reject,omitempty"`
	OnMissingIdentity MissingIdentityBehavior `yaml:"on_missing_identity,omitempty" json:"on_missing_identity,omitempty"`
	Labels            map[string]string       `yaml:"labels,omitempty" json:"labels,omitempty"`
}

// ToPolicy converts a parsed BundlePolicy into the core validated Policy domain model.
func (bp BundlePolicy) ToPolicy() (Policy, error) {
	windowDur, err := time.ParseDuration(bp.Window)
	if err != nil {
		return Policy{}, errors.New(errors.ErrCodeConfigInvalid,
			fmt.Sprintf("invalid duration %q for policy %q window: %v", bp.Window, bp.ID, err))
	}

	p := Policy{
		ID:                bp.ID,
		Name:              bp.Name,
		Version:           bp.Version,
		Tenant:            bp.Tenant,
		Scope:             bp.Scope,
		Algorithm:         bp.Algorithm,
		Limit:             bp.Limit,
		Window:            windowDur,
		Burst:             bp.Burst,
		Priority:          bp.Priority,
		Enabled:           bp.Enabled,
		Match:             bp.Match,
		CostSpec:          bp.CostSpec,
		OnReject:          bp.OnReject,
		OnMissingIdentity: bp.OnMissingIdentity,
		Labels:            bp.Labels,
	}

	if p.Version <= 0 {
		p.Version = 1
	}

	return p, nil
}

// ParseBundleStrict parses a YAML or JSON policy bundle with strict schema enforcement (unknown fields rejected).
func ParseBundleStrict(data []byte) (*PolicyBundle, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)

	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, errors.Wrap(errors.ErrCodeConfigInvalid, "failed to parse bundle yaml structure", err)
	}

	// Validate against unknown fields with line/column positions
	var bundle PolicyBundle
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&bundle); err != nil {
		return nil, errors.Wrap(errors.ErrCodeConfigInvalid, formatYamlError(err), err)
	}

	if bundle.Version <= 0 {
		return nil, errors.New(errors.ErrCodeConfigInvalid, "missing or invalid bundle 'version' (must be >= 1)")
	}
	if bundle.Version > CurrentBundleSchemaVersion {
		return nil, errors.New(errors.ErrCodeVersionIncompatible,
			fmt.Sprintf("unsupported bundle schema version %d (current supported version is %d)", bundle.Version, CurrentBundleSchemaVersion))
	}

	return &bundle, nil
}

func formatYamlError(err error) string {
	msg := err.Error()
	// Format as clean error with positions
	return fmt.Sprintf("bundle validation error: %s", msg)
}

// ResolveSecret resolves references like "env:VAR_NAME" or "file:/path/to/secret".
func ResolveSecret(ref string) (string, error) {
	if strings.HasPrefix(ref, "env:") {
		varName := strings.TrimPrefix(ref, "env:")
		val, ok := os.LookupEnv(varName)
		if !ok {
			return "", errors.New(errors.ErrCodeConfigInvalid, fmt.Sprintf("environment variable %q referenced in config not found", varName))
		}
		return val, nil
	}
	if strings.HasPrefix(ref, "file:") {
		filePath := strings.TrimPrefix(ref, "file:")
		b, err := os.ReadFile(filePath)
		if err != nil {
			return "", errors.Wrap(errors.ErrCodeConfigInvalid, fmt.Sprintf("secret file %q could not be read", filePath), err)
		}
		return strings.TrimSpace(string(b)), nil
	}
	return ref, nil
}

// LoadBundleWithIncludes recursively loads and merges a bundle and all included files.
func LoadBundleWithIncludes(baseFile string, visited map[string]bool) (*PolicyBundle, error) {
	absPath, err := filepath.Abs(baseFile)
	if err != nil {
		return nil, errors.Wrap(errors.ErrCodeConfigInvalid, "invalid bundle file path", err)
	}

	if visited == nil {
		visited = make(map[string]bool)
	}
	if visited[absPath] {
		return nil, errors.New(errors.ErrCodeConfigInvalid, fmt.Sprintf("circular include detected for file %q", absPath))
	}
	visited[absPath] = true

	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil, errors.Wrap(errors.ErrCodeConfigInvalid, fmt.Sprintf("failed to read bundle %q", absPath), err)
	}

	bundle, err := ParseBundleStrict(data)
	if err != nil {
		return nil, err
	}

	dir := filepath.Dir(absPath)
	for _, inc := range bundle.Includes {
		incPath := inc
		if !filepath.IsAbs(incPath) {
			incPath = filepath.Join(dir, inc)
		}
		incBundle, err := LoadBundleWithIncludes(incPath, visited)
		if err != nil {
			return nil, err
		}
		// Merge policies and templates
		bundle.Policies = append(bundle.Policies, incBundle.Policies...)
		bundle.Templates = append(bundle.Templates, incBundle.Templates...)
		bundle.Overrides = append(bundle.Overrides, incBundle.Overrides...)
	}

	return bundle, nil
}

// ProcessConfig captures 12-factor environment mappings with documented precedence.
type ProcessConfig struct {
	Env            string
	ConfigPath     string
	Fsync          FsyncPolicy
	DataPort       int
	AdminPort      int
	MaxRelaxFactor float64
}

// LoadProcessConfig extracts process configurations adhering to 12-factor precedence:
// Environment variables (RLGW_*) > Defaults.
func LoadProcessConfig() ProcessConfig {
	cfg := ProcessConfig{
		Env:            "prod",
		ConfigPath:     "config/policies.yaml",
		Fsync:          FsyncAlways,
		DataPort:       8080,
		AdminPort:      8081,
		MaxRelaxFactor: DefaultMaxRelaxFactor,
	}

	if env := os.Getenv("RLGW_ENV"); env != "" {
		cfg.Env = strings.ToLower(env)
	}
	if path := os.Getenv("RLGW_CONFIG_PATH"); path != "" {
		cfg.ConfigPath = path
	}
	if fsync := os.Getenv("RLGW_FSYNC"); fsync != "" {
		cfg.Fsync = FsyncPolicy(strings.ToLower(fsync))
	}

	return cfg
}
