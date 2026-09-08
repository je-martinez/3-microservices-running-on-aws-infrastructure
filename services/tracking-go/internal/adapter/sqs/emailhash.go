package sqs

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// HashEmail returns a non-reversible id for an email, safe to log.
//
// CONTRACT: SHA-256 of the TRIMMED, LOWERCASED address, hex, first 16 chars —
// identical to Users' hashEmail and Orders' EmailHash.Compute. Drift makes
// filtering one user's lines across services return NOTHING, silently.
// See [[logging-context]]
func HashEmail(email string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:])[:16]
}
