package policy

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rlgw/internal/errors"
)

var paramTokenRegex = regexp.MustCompile(`\{\{([a-zA-Z0-9_\-\.]+)\}\}`)

// InstantiateTemplate validates provided parameters against the template specification,
// substitutes variables strictly without code execution, and validates the resulting Policy.
func InstantiateTemplate(tmpl TemplateRecord, params map[string]string) (Policy, error) {
	// 1. Validate required parameters and types
	resolvedParams := make(map[string]string)
	paramDefs := make(map[string]TemplateParam)
	for _, p := range tmpl.Parameters {
		paramDefs[p.Name] = p
	}

	for _, p := range tmpl.Parameters {
		val, provided := params[p.Name]
		if !provided || strings.TrimSpace(val) == "" {
			if p.Required {
				return Policy{}, errors.New(errors.ErrCodeTemplateInvalid,
					fmt.Sprintf("missing required template parameter %q", p.Name))
			}
			val = p.Default
		}

		// Typed validation
		if val != "" {
			if err := validateParamType(p.Name, val, p.Type); err != nil {
				return Policy{}, err
			}
		}
		resolvedParams[p.Name] = val
	}

	// 2. Perform safe token substitution
	var replaceErr error
	rendered := paramTokenRegex.ReplaceAllStringFunc(tmpl.Body, func(match string) string {
		name := strings.TrimSuffix(strings.TrimPrefix(match, "{{"), "}}")
		val, ok := resolvedParams[name]
		if !ok {
			replaceErr = errors.New(errors.ErrCodeTemplateInvalid,
				fmt.Sprintf("unresolved template token %q in body", match))
			return match
		}
		return val
	})

	if replaceErr != nil {
		return Policy{}, replaceErr
	}

	// 3. Unmarshal rendered text into Policy
	var p Policy
	if err := json.Unmarshal([]byte(rendered), &p); err != nil {
		return Policy{}, errors.Wrap(errors.ErrCodeTemplateInvalid,
			fmt.Sprintf("failed to parse instantiated policy JSON from template %q", tmpl.ID), err)
	}

	// Ensure tenant is pinned to template tenant if not explicitly set
	if p.Tenant == "" {
		p.Tenant = tmpl.Tenant
	}
	if p.Version <= 0 {
		p.Version = 1
	}

	// 4. Validate the resulting policy
	if valErrs := p.Validate(); len(valErrs) > 0 {
		return Policy{}, errors.Wrap(errors.ErrCodePolicyInvalid,
			fmt.Sprintf("instantiated policy from template %q failed validation: %s", tmpl.ID, valErrs.Error()), nil)
	}

	return p, nil
}

func validateParamType(name, val, expectedType string) error {
	switch strings.ToLower(expectedType) {
	case "int", "integer":
		if _, err := strconv.ParseInt(val, 10, 64); err != nil {
			return errors.New(errors.ErrCodeTemplateInvalid,
				fmt.Sprintf("parameter %q value %q is not a valid integer", name, val))
		}
	case "duration":
		if _, err := time.ParseDuration(val); err != nil {
			return errors.New(errors.ErrCodeTemplateInvalid,
				fmt.Sprintf("parameter %q value %q is not a valid duration", name, val))
		}
	case "bool", "boolean":
		if _, err := strconv.ParseBool(val); err != nil {
			return errors.New(errors.ErrCodeTemplateInvalid,
				fmt.Sprintf("parameter %q value %q is not a valid boolean", name, val))
		}
	case "string", "":
		if strings.ContainsAny(val, "\"\n\r\t") {
			return errors.New(errors.ErrCodeTemplateInvalid,
				fmt.Sprintf("parameter %q contains illegal characters (quotes or control characters)", name))
		}
	default:
		return errors.New(errors.ErrCodeTemplateInvalid,
			fmt.Sprintf("parameter %q has unknown type %q", name, expectedType))
	}
	return nil
}
