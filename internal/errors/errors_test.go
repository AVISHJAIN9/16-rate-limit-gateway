package errors

import (
	"fmt"
	"testing"
)

func TestErrorFormattingAndUnwrap(t *testing.T) {
	rootCause := fmt.Errorf("connection refused: dial tcp 127.0.0.1:6379")
	err := Wrap(ErrCodeStoreUnavailable, "storage backend temporarily unavailable", rootCause)

	if !IsCode(err, ErrCodeStoreUnavailable) {
		t.Fatalf("expected ErrCodeStoreUnavailable")
	}

	if err.Error() != "[ERR_STORE_UNAVAILABLE] storage backend temporarily unavailable" {
		t.Fatalf("unexpected Error() string: %s", err.Error())
	}

	if err.PublicMessage() != "storage backend temporarily unavailable" {
		t.Fatalf("unexpected PublicMessage(): %s", err.PublicMessage())
	}

	if err.Unwrap() != rootCause {
		t.Fatalf("expected root cause to be preserved")
	}
}

func TestErrorWithField(t *testing.T) {
	err := WithField(ErrCodePolicyInvalid, "match.route_pattern", "pattern exceeds maximum length 256")
	if !IsCode(err, ErrCodePolicyInvalid) {
		t.Fatalf("expected ErrCodePolicyInvalid")
	}
	expected := "[ERR_POLICY_INVALID] match.route_pattern: pattern exceeds maximum length 256"
	if err.Error() != expected {
		t.Fatalf("expected %q, got %q", expected, err.Error())
	}
}

func TestSentinelErrors(t *testing.T) {
	if !IsCode(ErrMissingDimension, ErrCodeMissingDimension) {
		t.Fatalf("expected ErrCodeMissingDimension")
	}
	if IsCode(nil, ErrCodeMissingDimension) {
		t.Fatalf("expected false on nil error")
	}
}
