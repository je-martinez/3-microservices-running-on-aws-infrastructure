package http

import (
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// The two request flags, and the ONE value that activates each (compared
// case-insensitively after trimming). A flag that switches on for several
// spellings is one a caller enables by accident, so there is no 1 and no yes.
const (
	E2ESourceHeader = "x-e2e-source"
	TestModeHeader  = "x-test-mode"
	// RunIDHeader identifies the Playwright invocation that created a row, so a
	// teardown can delete ITS OWN fixtures instead of everyone's. Minted once per
	// run in e2e/support/global-setup.ts and sent by both E2E HTTP clients.
	RunIDHeader = "x-e2e-run-id"
	activeValue = "true"
)

// E2ESourceTag is the tag persisted on a row the E2E harness created, and the
// exact predicate DELETE /v1/trackings/e2e-cleanup selects on.
//
// EXACTLY "E2E Source": capital E, capital S, one space. Shared verbatim with
// Users (user.tags contains "E2E Source"); a near-miss like "e2e-source" would
// clean up nothing while looking correct.
const E2ESourceTag = "E2E Source"

const (
	e2eSourceKey = "e2e_source"
	testModeKey  = "test_mode"
	runIDKey     = "e2e_run_id"
)

// E2ERunTagPrefix builds the SECOND tag a run-scoped row carries, alongside
// E2ESourceTag. A tag rather than a column because `tags` is already a JSON array
// the delete predicate selects on with JSON_CONTAINS — requiring both tags needs
// one more predicate and no migration.
const E2ERunTagPrefix = "E2E Run "

// The same shape Users and the Cognito OTP trigger each validate independently.
// A value one end accepts and another rejects would be dropped on exactly one
// path, which is the kind of asymmetry that reads as data loss.
var runIDPattern = regexp.MustCompile(`^run_[A-Za-z0-9_:.-]{1,64}$`)

// E2ERunTag returns the run tag for a run id, or "" when there is none.
func E2ERunTag(runID string) string {
	if runID == "" {
		return ""
	}
	return E2ERunTagPrefix + runID
}

// ValidRunID returns the run id when it is well-formed, otherwise "".
//
// Shape-checked rather than trusted: it arrives from a caller-controlled header
// and becomes part of a stored tag AND a delete predicate. An arbitrary string
// would let a caller write whatever it liked into that key.
func ValidRunID(candidate string) string {
	if runIDPattern.MatchString(candidate) {
		return candidate
	}
	return ""
}

// E2ESourceMiddleware decides whether this request's row should be tagged as an
// E2E fixture.
//
// # The flag is half of the condition, and it is the security half
//
//	e2e_source = headerSaysTrue AND E2E_TESTING_ENABLED
//
// Without the conjunction, any client anywhere could tag its own rows by sending
// one header — and while a tag is harmless on its own, it is the exact predicate
// a mass soft-delete endpoint selects on. In an environment where the flag is on
// but the caller is untrusted, self-tagging would let a client enlist its rows
// for deletion by somebody else's teardown.
//
// BOTH HALVES ARE EVALUATED HERE, in the middleware, so a handler cannot tag a
// row on the header alone and a second endpoint that ever wants the tag cannot
// acquire the header check without the flag check that makes it safe.
//
// Never returns an error: an unrecognized value means "not an E2E row", never a
// 400, because failing the creation of a real shipment over a malformed
// test-harness header would be the worse trade.
func E2ESourceMiddleware(e2eEnabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(e2eSourceKey, headerIsTrue(c.GetHeader(E2ESourceHeader)) && e2eEnabled)
		c.Next()
	}
}

// RunIDMiddleware resolves this request's E2E run id.
//
// Gated on E2E_TESTING_ENABLED for the same reason E2ESourceMiddleware is: the id
// becomes half of a mass-delete predicate, so a client must not be able to supply
// one where the harness is not in charge.
func RunIDMiddleware(e2eEnabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		runID := ""
		if e2eEnabled {
			runID = ValidRunID(c.GetHeader(RunIDHeader))
		}
		c.Set(runIDKey, runID)
		c.Next()
	}
}

// E2ERunID reports this request's run id, or "" when absent, malformed, or the
// flag is off. Absent is a normal shape: production traffic carries none.
func E2ERunID(c *gin.Context) string {
	value, _ := c.Get(runIDKey)
	runID, _ := value.(string)
	return runID
}

// IsE2ESource reports whether the row this request creates carries E2ESourceTag.
func IsE2ESource(c *gin.Context) bool {
	value, _ := c.Get(e2eSourceKey)
	flag, _ := value.(bool)
	return flag
}

// TestModeMiddleware parses x-test-mode.
//
// # No E2E_TESTING_ENABLED guard in THIS service
//
// Orders guards its equivalent header with that flag. This middleware
// deliberately does not, and the reason is that the guard is not implemented here
// to be dropped: Tracking has never had the setting on this path, and adding one
// is a change to the generated env files and therefore to infra/**, outside this
// task. Recording it rather than silently doing nothing — the flag remains a
// KNOWN OPEN ITEM. Do not "fix" it during the migration; that would be a
// behavioural change the equivalence gate would flag.
func TestModeMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(testModeKey, headerIsTrue(c.GetHeader(TestModeHeader)))
		c.Next()
	}
}

// IsTestMode reports whether this request asked for the automatic progression.
func IsTestMode(c *gin.Context) bool {
	value, _ := c.Get(testModeKey)
	flag, _ := value.(bool)
	return flag
}

// headerIsTrue accepts only the exact string "true", case-insensitively after
// trimming. Case-insensitive because a header value is not a wire enum and `True`
// from a hand-written curl should not silently mean false — but nothing beyond
// that: no 1, no yes.
func headerIsTrue(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), activeValue)
}
