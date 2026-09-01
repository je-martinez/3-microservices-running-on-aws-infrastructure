package sqs

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// HashEmail returns a non-reversible id for an email, safe to log.
//
// The CROSS-SERVICE contract: SHA-256 of the TRIMMED, LOWERCASED address, hex,
// first 16 chars — identical to Users' hashEmail and Orders' EmailHash.Compute.
// If the three ever drift, filtering one user's lines across services silently
// returns NOTHING instead of erroring, which is the failure mode worth a test of
// its own.
func HashEmail(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])[:16]
}
