package http

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// The two request flags, and the ONE value that activates each (compared
// case-insensitively after trimming). A flag that switches on for several
// spellings is one a caller enables by accident, so there is no 1 and no yes.
const (
	E2ESourceHeader = "x-e2e-source"
	TestModeHeader  = "x-test-mode"
	activeValue     = "true"
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
)

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
