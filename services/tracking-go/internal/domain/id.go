package domain

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
)

// ─── Nano ID: the machine identifier (trk_…) ─────────────────────────────────

const (
	// CONTRACT: Letters and digits ONLY, in this exact order — nanoid's default
	// adds '_' and '-', and a leading '-' reads as a shell flag while '_' hides
	// against an underscored column name. Alphabet, length and prefixes are
	// declared identically in Users and Orders, and ids cross service boundaries
	// in headers, envelopes and foreign keys: a service that disagrees produces
	// ids the others reject. Changing any of these changes all three services.
	// See [[nano-id]]
	NanoIDAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

	// NanoIDLength is the RANDOM portion only. A stored id is
	// PrefixLength + NanoIDLength = 28 characters, which is what every
	// id-bearing database column is sized for.
	NanoIDLength = 24

	// PrefixLength is the width of an entity prefix, including its underscore.
	PrefixLength = 4

	// TrackingPrefix prefixes a Tracking row's id.
	//
	// Only ONE entity prefix exists for persisted rows. TrackingHistory has a
	// composite primary key (tracking_id, status) and no id column at all, so it
	// gets no prefix and no generated id.
	TrackingPrefix = "trk_"

	// RequestPrefix prefixes the cross-service correlation id. Same format by
	// design: a second alphabet or a second notion of "how long" is exactly what
	// these constants exist to prevent.
	RequestPrefix = "req_"
)

// Compile-time assertion that domain.IDLength (the column width in tracking.go)
// stays tied to what the generator actually produces. If someone widens the
// random portion without widening the column, this fails to build — which is
// the only safe failure, because MySQL TRUNCATES an over-long value silently
// rather than erroring.
const _ = uint(IDLength - (PrefixLength + NanoIDLength))
const _ = uint((PrefixLength + NanoIDLength) - IDLength)

// ─── Tracking number: the human-readable identifier (3MRAI-…) ────────────────

const (
	// TrackingNumberPrefix says the number is OURS, not a carrier's. A tracking
	// row is created at PLACED, long before any carrier is involved, so there is
	// no carrier number to record. The day a real carrier number arrives it is a
	// second, differently-named column, not a silent overwrite of this one.
	TrackingNumberPrefix = "3MRAI"

	// TrackingNumberAlphabet is the 36 uppercase alphanumerics MINUS I, O, 0 and
	// 1 — the pairs a reader confuses when transcribing from an email or reading
	// aloud. A tracking number's whole job is to survive exactly that trip.
	// 32 symbols.
	TrackingNumberAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

	TrackingNumberGroupSize  = 4
	TrackingNumberGroupCount = 3
	TrackingNumberSeparator  = "-"

	// TrackingNumberLength is 5 + 3*(1+4) = 20, the width of the
	// tracking.tracking_number column. Twelve characters over 32 symbols is 60
	// bits, a 50% birthday bound at ~1.3e9 rows. No checksum: tracking_number is
	// UNIQUE, so a collision is a failed INSERT, not two shipments sharing one.
	TrackingNumberLength = len(TrackingNumberPrefix) +
		TrackingNumberGroupCount*(len(TrackingNumberSeparator)+TrackingNumberGroupSize)
)

// ─── Generation ──────────────────────────────────────────────────────────────

// randomString returns n characters drawn uniformly from alphabet.
//
// CONTRACT: crypto/rand, NEVER math/rand — a deterministic PRNG's state is
// reconstructable from a handful of outputs, and a guessable tracking number
// lets somebody enumerate other people's shipments. rand.Int over a big.Int
// bound, not modulo: neither 62 nor 32 divides 256, so modulo favours the
// alphabet's first symbols. See [[nano-id]]
func randomString(alphabet string, n int) (string, error) {
	bound := big.NewInt(int64(len(alphabet)))
	var builder strings.Builder
	builder.Grow(n)
	for i := 0; i < n; i++ {
		index, err := rand.Int(rand.Reader, bound)
		if err != nil {
			return "", fmt.Errorf("draw random symbol: %w", err)
		}
		builder.WriteByte(alphabet[index.Int64()])
	}
	return builder.String(), nil
}

// mint is the single generation path for prefixed nano IDs.
func mint(prefix string) (string, error) {
	random, err := randomString(NanoIDAlphabet, NanoIDLength)
	if err != nil {
		return "", err
	}
	return prefix + random, nil
}

// NewTrackingID returns a fresh trk_-prefixed id for a Tracking row,
// e.g. trk_7gK3mP1vXz9wLq2bN8rRt4Yc.
func NewTrackingID() (string, error) {
	return mint(TrackingPrefix)
}

// NewRequestID returns a fresh req_-prefixed cross-service correlation id.
func NewRequestID() (string, error) {
	return mint(RequestPrefix)
}

// NewTrackingNumber returns a fresh customer-facing number,
// e.g. 3MRAI-K7P2-9WXM-4TQB.
func NewTrackingNumber() (string, error) {
	parts := make([]string, 0, TrackingNumberGroupCount+1)
	parts = append(parts, TrackingNumberPrefix)
	for i := 0; i < TrackingNumberGroupCount; i++ {
		group, err := randomString(TrackingNumberAlphabet, TrackingNumberGroupSize)
		if err != nil {
			return "", fmt.Errorf("mint tracking number: %w", err)
		}
		parts = append(parts, group)
	}
	return strings.Join(parts, TrackingNumberSeparator), nil
}
