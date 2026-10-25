package errors

import (
	"errors"
	"fmt"
)

// ErrorCode represents a stable, machine-readable error classification.
type ErrorCode string

const (
	ErrCodePolicyInvalid     ErrorCode = "ERR_POLICY_INVALID"
	ErrCodeMissingDimension  ErrorCode = "ERR_MISSING_DIMENSION"
	ErrCodeUntrustedHeader   ErrorCode = "ERR_UNTRUSTED_HEADER"
	ErrCodeInvalidAPIKey     ErrorCode = "ERR_INVALID_API_KEY"
	ErrCodeKeyNotFound       ErrorCode = "ERR_KEY_NOT_FOUND"
	ErrCodeUnknownAlgorithm  ErrorCode = "ERR_UNKNOWN_ALGORITHM"
	ErrCodeUnknownScope      ErrorCode = "ERR_UNKNOWN_SCOPE"
	ErrCodeRegexTooComplex   ErrorCode = "ERR_REGEX_TOO_COMPLEX"
	ErrCodeStoreUnavailable  ErrorCode = "ERR_STORE_UNAVAILABLE"
	ErrCodeRateLimitExceeded ErrorCode = "ERR_RATE_LIMIT_EXCEEDED"
	ErrCodeInternal          ErrorCode = "ERR_INTERNAL"
	ErrCodeNotFound          ErrorCode = "ERR_NOT_FOUND"
	ErrCodeConflict          ErrorCode = "ERR_CONFLICT"
	ErrCodeUnauthorized      ErrorCode = "ERR_UNAUTHORIZED"
	ErrCodeForbidden         ErrorCode = "ERR_FORBIDDEN"
	ErrCodePolicyCycle       ErrorCode = "ERR_POLICY_CYCLE"
	ErrCodeRelaxationExceeded ErrorCode = "ERR_RELAXATION_EXCEEDED"
	ErrCodeTemplateInvalid     ErrorCode = "ERR_TEMPLATE_INVALID"
	ErrCodeVersionIncompatible ErrorCode = "ERR_VERSION_INCOMPATIBLE"
	ErrCodeConfigInvalid       ErrorCode = "ERR_CONFIG_INVALID"
	ErrCodeBadRequest          ErrorCode = "ERR_BAD_REQUEST"
	ErrCodeBadGateway         ErrorCode = "ERR_BAD_GATEWAY"
	ErrCodeGatewayTimeout      ErrorCode = "ERR_GATEWAY_TIMEOUT"
	ErrCodePayloadTooLarge     ErrorCode = "ERR_PAYLOAD_TOO_LARGE"
)

// Error represents a structured domain error adhering to the rlgw error policy:
// machine-readable code, non-leaking message, optional field path, and private internal cause.
type Error struct {
	Code        ErrorCode `json:"code"`
	Message     string    `json:"message"`
	Field       string    `json:"field,omitempty"`
	InternalErr error     `json:"-"`
}

// Error implements the error interface.
func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	if e.Field != "" {
		return fmt.Sprintf("[%s] %s: %s", e.Code, e.Field, e.Message)
	}
	return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

// Unwrap allows standard errors.Unwrap chaining.
func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.InternalErr
}

// PublicMessage returns a safe string stripped of internal system error messages.
func (e *Error) PublicMessage() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// New creates a new typed Error.
func New(code ErrorCode, message string) *Error {
	return &Error{
		Code:    code,
		Message: message,
	}
}

// WithField creates a typed Error associated with a specific struct or config field path.
func WithField(code ErrorCode, field string, message string) *Error {
	return &Error{
		Code:    code,
		Field:   field,
		Message: message,
	}
}

// Wrap creates a typed Error wrapping an internal error without exposing the internal message publicly.
func Wrap(code ErrorCode, publicMessage string, internalErr error) *Error {
	return &Error{
		Code:        code,
		Message:     publicMessage,
		InternalErr: internalErr,
	}
}

// IsCode tests if err contains the specified ErrorCode.
func IsCode(err error, code ErrorCode) bool {
	if err == nil {
		return false
	}
	var domainErr *Error
	if errors.As(err, &domainErr) {
		return domainErr.Code == code
	}
	return false
}

// Is reports whether any error in err's tree matches target.
func Is(err, target error) bool {
	return errors.Is(err, target)
}

// As finds the first error in err's tree that matches target, and if one is found, sets
// target to that error value and returns true.
func As(err error, target any) bool {
	return errors.As(err, target)
}

// Common sentinel errors
var (
	ErrMissingDimension = New(ErrCodeMissingDimension, "required identity dimension is missing for scope")
	ErrUntrustedHeader  = New(ErrCodeUntrustedHeader, "untrusted header identity source rejected")
	ErrInvalidAPIKey    = New(ErrCodeInvalidAPIKey, "malformed or invalid API key format")
	ErrKeyNotFound      = New(ErrCodeKeyNotFound, "api key not found")
	ErrUnknownAlgorithm = New(ErrCodeUnknownAlgorithm, "unknown rate limit algorithm")
	ErrUnknownScope     = New(ErrCodeUnknownScope, "unknown policy scope")
	ErrRegexTooComplex  = New(ErrCodeRegexTooComplex, "route pattern regular expression exceeds complexity limit")
	ErrStoreUnavailable = New(ErrCodeStoreUnavailable, "backend store unavailable")
)
