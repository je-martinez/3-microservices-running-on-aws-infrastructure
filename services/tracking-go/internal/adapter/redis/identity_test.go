package redis_test

import (
	"context"
	"errors"
	"testing"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func TestIdentityCacheMissThenLoadThenHit(t *testing.T) {
	gw, _ := live(t)
	ic := cache.NewIdentityCache(gw)
	ctx := t.Context()

	calls := 0
	loader := func(context.Context) (string, error) {
		calls++
		return "usr_abc", nil
	}

	if got := ic.Resolve(ctx, "sub-1", loader); got != "usr_abc" {
		t.Fatalf("first Resolve = %q, want usr_abc", got)
	}
	if got := ic.Resolve(ctx, "sub-1", loader); got != "usr_abc" {
		t.Fatalf("second Resolve = %q, want usr_abc", got)
	}
	if calls != 1 {
		t.Errorf("the loader ran %d times, want 1 — the second call must hit the cache", calls)
	}
}

// NEGATIVES ARE NEVER CACHED. Caching one would keep a real user's user_id out
// of their keys for an hour after the cause cleared, silently disabling the
// response cache for that caller.
func TestIdentityCacheNeverCachesANegative(t *testing.T) {
	gw, server := live(t)
	ic := cache.NewIdentityCache(gw)
	ctx := t.Context()

	calls := 0
	failing := func(context.Context) (string, error) {
		calls++
		return "", errors.New("users is unreachable")
	}

	if got := ic.Resolve(ctx, "sub-1", failing); got != "" {
		t.Fatalf("Resolve = %q, want empty on a failed load", got)
	}
	if server.Exists(cache.IdentityKey("sub-1")) {
		t.Fatal("a negative answer was written to Redis; negatives are never cached")
	}

	// Re-asked next request.
	ic.Resolve(ctx, "sub-1", failing)
	if calls != 2 {
		t.Errorf("the loader ran %d times, want 2 — a negative must be re-asked", calls)
	}
}

// A loader returning "not found" with no error is also a negative.
func TestIdentityCacheEmptyAnswerIsNotCached(t *testing.T) {
	gw, server := live(t)
	ic := cache.NewIdentityCache(gw)

	ic.Resolve(t.Context(), "sub-1", func(context.Context) (string, error) { return "", nil })

	if server.Exists(cache.IdentityKey("sub-1")) {
		t.Fatal("an empty answer was cached")
	}
}

// The stored value is a BARE JSON string, so redis-cli shows "usr_abc".
func TestIdentityCacheStoresABareJSONString(t *testing.T) {
	gw, server := live(t)
	ic := cache.NewIdentityCache(gw)

	ic.Resolve(t.Context(), "sub-1", func(context.Context) (string, error) { return "usr_abc", nil })

	got, err := server.Get(cache.IdentityKey("sub-1"))
	if err != nil {
		t.Fatalf("identity key missing: %v", err)
	}
	if got != `"usr_abc"` {
		t.Errorf("stored %q, want a bare JSON string %q", got, `"usr_abc"`)
	}
}

// The identity entry gets the IDENTITY TTL (1h), not an entry TTL (60s): a sub
// never resolves to a different usr_ id while the account exists, so the short
// read TTL would only buy repeated gRPC calls for no correctness gain.
func TestIdentityCacheUsesTheIdentityTTL(t *testing.T) {
	gw, server := live(t)
	ic := cache.NewIdentityCache(gw)

	ic.Resolve(t.Context(), "sub-1", func(context.Context) (string, error) { return "usr_abc", nil })

	if got := server.TTL(cache.IdentityKey("sub-1")); got != cache.IdentityTTL {
		t.Errorf("identity TTL = %v, want %v", got, cache.IdentityTTL)
	}
}

// The identity entry is NOT recorded in a per-user index SET. The index exists
// to sweep response entries; the identity key is deleted by name in the cascade,
// and indexing it under a key built from the same raw identifier would add a SET
// whose only member is a key the cascade already deletes directly.
func TestIdentityCacheWritesNoIndexEntry(t *testing.T) {
	gw, server := live(t)
	ic := cache.NewIdentityCache(gw)

	ic.Resolve(t.Context(), "sub-1", func(context.Context) (string, error) { return "usr_abc", nil })

	for _, key := range server.Keys() {
		if key != cache.IdentityKey("sub-1") {
			t.Errorf("Resolve wrote an unexpected key %q; only the identity key belongs here", key)
		}
	}
}

// A gateway BYPASS still resolves through the loader — the cache never fails a
// request.
func TestIdentityCacheFallsBackWhenRedisIsDown(t *testing.T) {
	ic := cache.NewIdentityCache(cache.NewNullGateway())

	got := ic.Resolve(t.Context(), "sub-1",
		func(context.Context) (string, error) { return "usr_abc", nil })
	if got != "usr_abc" {
		t.Errorf("Resolve = %q, want usr_abc via the loader", got)
	}
}

// A HIT must still VALIDATE the stored value before trusting it. A key holding
// a JSON null, an empty string, or a non-string shape is not a resolution — it
// is a corrupt entry, and returning it would put an empty user_id into every key
// the request builds, silently disabling caching for that caller.
func TestIdentityCacheRejectsAnUntrustworthyHit(t *testing.T) {
	for name, stored := range map[string]string{
		"empty string": `""`,
		"json null":    `null`,
		"a number":     `42`,
		"an object":    `{"user_id":"usr_abc"}`,
	} {
		t.Run(name, func(t *testing.T) {
			gw, server := live(t)
			ic := cache.NewIdentityCache(gw)

			if err := server.Set(cache.IdentityKey("sub-1"), stored); err != nil {
				t.Fatalf("seeding the entry failed: %v", err)
			}

			calls := 0
			got := ic.Resolve(t.Context(), "sub-1", func(context.Context) (string, error) {
				calls++
				return "usr_abc", nil
			})

			if got != "usr_abc" {
				t.Errorf("Resolve = %q, want the loader's usr_abc; the stored %s must not be trusted", got, name)
			}
			if calls != 1 {
				t.Errorf("the loader ran %d times, want 1 — an untrustworthy hit must fall through to it", calls)
			}
		})
	}
}
