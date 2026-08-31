package sqs_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/sqs"
)

// The CROSS-SERVICE contract: sha256 of the trimmed, lowercased address, hex,
// first 16 chars — identical to Users' hashEmail and Orders' EmailHash.Compute.
// If the three drift, filtering one user's lines across services silently
// returns nothing instead of erroring.
func TestHashEmail(t *testing.T) {
	// Precomputed: sha256("person@example.com")[:16] in hex.
	const want = "542d240129883c01"

	for _, in := range []string{
		"person@example.com",
		"PERSON@EXAMPLE.COM",
		"  person@example.com  ",
		"\tPerson@Example.Com\n",
	} {
		if got := sqs.HashEmail(in); got != want {
			t.Errorf("HashEmail(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHashEmailLength(t *testing.T) {
	if got := sqs.HashEmail("a@b.com"); len(got) != 16 {
		t.Errorf("HashEmail returned %d chars, want 16", len(got))
	}
}
