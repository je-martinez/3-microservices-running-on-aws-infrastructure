package redis_test

import (
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	miniserver "github.com/alicebob/miniredis/v2/server"
	goredis "github.com/redis/go-redis/v9"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func TestInvalidateTrackingDeletesTheReadKeyAndTheIndex(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	sub, userID, orderID := "sub-1", "usr_1", "ord_9"

	single, _ := cache.TrackingOrderKey(sub, userID, orderID)
	list, _ := cache.TrackingListKey(sub, userID, []string{"ord_9", "ord_8"})
	indexKey := cache.UserIndexKey(sub, userID)

	gw.Set(ctx, single, map[string]string{"a": "b"}, time.Minute, indexKey)
	gw.Set(ctx, list, []string{"x"}, time.Minute, indexKey)

	cache.InvalidateTracking(ctx, gw, quiet(), orderID, sub, userID)

	for _, key := range []string{single, list, indexKey} {
		if server.Exists(key) {
			t.Errorf("%s survived InvalidateTracking", key)
		}
	}
}

// The list key embeds a sha256 of an arbitrary caller-supplied id list and is
// therefore NOT reconstructible at invalidation time. It is reachable only
// through the per-user index SET, so an implementation that deletes the single
// read key and stops leaves it serving stale data for its full TTL.
func TestInvalidateTrackingClearsTheUnreconstructibleListKey(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	sub, userID := "sub-1", "usr_1"

	list, _ := cache.TrackingListKey(sub, userID, []string{"ord_9", "ord_8", "ord_7"})
	indexKey := cache.UserIndexKey(sub, userID)
	gw.Set(ctx, list, []string{"x"}, time.Minute, indexKey)

	cache.InvalidateTracking(ctx, gw, quiet(), "ord_9", sub, userID)

	if server.Exists(list) {
		t.Error("the hashed list key survived; it is reachable only through the index SET")
	}
}

// Invalidation sweeps through the per-user index with SMEMBERS + DEL, and never
// KEYS or SCAN: both are O(N) over the ENTIRE keyspace and KEYS blocks the
// server, so either on a write path makes every carrier callback pay for the
// size of the whole cache.
func TestInvalidateTrackingUsesTheIndexNeverKEYSOrSCAN(t *testing.T) {
	gw, server, commands := recorded(t)
	ctx := t.Context()
	sub, userID := "sub-1", "usr_1"

	list, _ := cache.TrackingListKey(sub, userID, []string{"ord_9"})
	indexKey := cache.UserIndexKey(sub, userID)
	gw.Set(ctx, list, []string{"x"}, time.Minute, indexKey)

	cache.InvalidateTracking(ctx, gw, quiet(), "ord_9", sub, userID)

	if server.Exists(list) {
		t.Fatal("the list key survived, so this test cannot speak to HOW it was swept")
	}
	if !commands.saw("smembers") {
		t.Error("no SMEMBERS issued; the sweep must go through the per-user index")
	}
	for _, forbidden := range []string{"keys", "scan"} {
		if commands.saw(forbidden) {
			t.Errorf("%s reached Redis on a write path: %v", strings.ToUpper(forbidden), commands.names())
		}
	}
}

// An empty sub is a NO-OP, and safe: a row with a NULL cognito_sub is
// unreachable over both user-scoped reads, so it can never have been cached.
func TestInvalidateTrackingSkipsWithoutASub(t *testing.T) {
	gw, server := live(t)
	var buf strings.Builder
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// A key owned by SOMEBODY ELSE, whose index key is what an implementation
	// that formatted the empty sub into a key would collide with.
	orphan := cache.UserIndexKey("", "usr_1")
	if err := server.Set(orphan, "someone else's"); err != nil {
		t.Fatalf("seeding failed: %v", err)
	}

	cache.InvalidateTracking(t.Context(), gw, log, "ord_9", "", "usr_1")

	out := buf.String()
	if !strings.Contains(out, "cache_invalidation_skipped") {
		t.Errorf("no cache_invalidation_skipped line: %s", out)
	}
	if !strings.Contains(out, "no_owner_sub") {
		t.Errorf("reason must be no_owner_sub: %s", out)
	}
	if !server.Exists(orphan) {
		t.Error("an empty sub was formatted into a key and deleted somebody else's data")
	}
}

func TestInvalidateTrackingSkipsWithoutAUserID(t *testing.T) {
	gw, server := live(t)
	var buf strings.Builder
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	// Building tracking:index:v1:<sub>: would delete a key nobody ever wrote,
	// which reads as a successful invalidation while evicting nothing.
	orphan := cache.UserIndexKey("sub-1", "")
	if err := server.Set(orphan, "never written by a real request"); err != nil {
		t.Fatalf("seeding failed: %v", err)
	}

	cache.InvalidateTracking(t.Context(), gw, log, "ord_9", "sub-1", "")

	out := buf.String()
	if !strings.Contains(out, "cache_invalidation_skipped") {
		t.Errorf("no cache_invalidation_skipped line: %s", out)
	}
	if !strings.Contains(out, "no_owner_user_id") {
		t.Errorf("reason must be no_owner_user_id: %s", out)
	}
	if !server.Exists(orphan) {
		t.Error("an empty user_id was formatted into a key and swept")
	}
}

// A skip must never be mistaken for an eviction by whoever reads the logs.
func TestInvalidateTrackingSkipDoesNotLogSuccess(t *testing.T) {
	gw, _ := live(t)
	var buf strings.Builder
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	cache.InvalidateTracking(t.Context(), gw, log, "ord_9", "", "usr_1")

	if strings.Contains(buf.String(), "cache_invalidated\"") {
		t.Errorf("a skipped invalidation logged success: %s", buf.String())
	}
}

// The cascade sweeps BOTH identifiers in the FIRST key position. Sweeping only
// the canonical pair leaked deleted-account data for its full TTL — verified
// live in Orders.
func TestInvalidateUserSweepsBothIdentifiers(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	sub, userID := "sub-uuid", "usr_x"

	// The client authenticated with the SUB on some requests...
	subIndex := cache.UserIndexKey(sub, userID)
	subEntry, _ := cache.TrackingOrderKey(sub, userID, "ord_1")
	gw.Set(ctx, subEntry, map[string]string{"a": "b"}, time.Minute, subIndex)

	// ...and with the usr_ id on others (the E2E suite's direct path).
	idIndex := cache.UserIndexKey(userID, userID)
	idEntry, _ := cache.TrackingOrderKey(userID, userID, "ord_1")
	gw.Set(ctx, idEntry, map[string]string{"a": "b"}, time.Minute, idIndex)

	// Both identity mappings are live too.
	gw.Set(ctx, cache.IdentityKey(sub), userID, time.Hour, "")
	gw.Set(ctx, cache.IdentityKey(userID), userID, time.Hour, "")

	cache.InvalidateUser(ctx, gw, quiet(), sub, userID)

	for _, key := range []string{
		subIndex, subEntry, idIndex, idEntry,
		cache.IdentityKey(sub), cache.IdentityKey(userID),
	} {
		if server.Exists(key) {
			t.Errorf("%s survived InvalidateUser; a deleted account's data stays readable for its full TTL", key)
		}
	}
}

// The list key under the usr_-id-keyed index is the exact shape that leaked in
// Orders: unreconstructible, and reachable only through an index a
// canonical-pair-only sweep never opens.
func TestInvalidateUserSweepsTheUsrIDKeyedListEntry(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	sub, userID := "sub-uuid", "usr_x"

	idIndex := cache.UserIndexKey(userID, userID)
	idList, _ := cache.TrackingListKey(userID, userID, []string{"ord_1", "ord_2"})
	gw.Set(ctx, idList, []string{"x"}, time.Minute, idIndex)

	cache.InvalidateUser(ctx, gw, quiet(), sub, userID)

	if server.Exists(idList) {
		t.Error("the usr_-id-keyed list entry survived; this is the Orders leak verbatim")
	}
}

// On the direct path both fields hold the SAME value. Issuing the same DELETE
// twice is pointless noise on a write path.
func TestInvalidateUserDeduplicatesIdenticalIdentifiers(t *testing.T) {
	gw, server, commands := recorded(t)
	ctx := t.Context()

	indexKey := cache.UserIndexKey("usr_x", "usr_x")
	entry, _ := cache.TrackingOrderKey("usr_x", "usr_x", "ord_1")
	gw.Set(ctx, entry, map[string]string{"a": "b"}, time.Minute, indexKey)
	gw.Set(ctx, cache.IdentityKey("usr_x"), "usr_x", time.Hour, "")

	commands.reset()
	cache.InvalidateUser(ctx, gw, quiet(), "usr_x", "usr_x")

	for _, key := range []string{indexKey, entry, cache.IdentityKey("usr_x")} {
		if server.Exists(key) {
			t.Errorf("%s survived InvalidateUser", key)
		}
	}
	if got := commands.count("smembers"); got != 1 {
		t.Errorf("SMEMBERS issued %d times for one identifier, want 1 — identical identifiers must dedupe", got)
	}
}

// Empty values are dropped rather than formatted into a key: UserIndexKey("","")
// and IdentityKey("") are real, well-formed keys somebody else could own.
func TestInvalidateUserNeverFormatsAnEmptyIdentifier(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()

	orphanIndex := cache.UserIndexKey("", "usr_x")
	orphanIdentity := cache.IdentityKey("")
	for _, key := range []string{orphanIndex, orphanIdentity} {
		if err := server.Set(key, "not ours"); err != nil {
			t.Fatalf("seeding %s failed: %v", key, err)
		}
	}

	cache.InvalidateUser(ctx, gw, quiet(), "", "usr_x")

	if !server.Exists(orphanIndex) {
		t.Errorf("%s was swept; an empty identifier must never be formatted into a key", orphanIndex)
	}
	if !server.Exists(orphanIdentity) {
		t.Errorf("%s was swept; an empty identifier must never be formatted into a key", orphanIdentity)
	}
}

// The cascade sweeps through the index too — never KEYS or SCAN.
func TestInvalidateUserUsesTheIndexNeverKEYSOrSCAN(t *testing.T) {
	gw, _, commands := recorded(t)
	ctx := t.Context()

	idIndex := cache.UserIndexKey("usr_x", "usr_x")
	idEntry, _ := cache.TrackingOrderKey("usr_x", "usr_x", "ord_1")
	gw.Set(ctx, idEntry, map[string]string{"a": "b"}, time.Minute, idIndex)

	commands.reset()
	cache.InvalidateUser(ctx, gw, quiet(), "sub-uuid", "usr_x")

	if !commands.saw("smembers") {
		t.Error("no SMEMBERS issued; the cascade must sweep through the per-user index")
	}
	for _, forbidden := range []string{"keys", "scan"} {
		if commands.saw(forbidden) {
			t.Errorf("%s reached Redis on the cascade: %v", strings.ToUpper(forbidden), commands.names())
		}
	}
}

// Never fails the caller: the deletion has already COMMITTED by the time this
// runs, so raising would tell Users the cascade failed when it did not.
func TestInvalidateUserNeverFailsWithRedisDown(t *testing.T) {
	cache.InvalidateUser(t.Context(), cache.NewNullGateway(), quiet(), "sub-1", "usr_1")
	cache.InvalidateTracking(t.Context(), cache.NewNullGateway(), quiet(), "ord_1", "sub-1", "usr_1")
}

// A nil logger must not panic on a write path.
func TestInvalidationToleratesANilLogger(t *testing.T) {
	gw, _ := live(t)
	ctx := t.Context()
	cache.InvalidateTracking(ctx, gw, nil, "ord_1", "sub-1", "usr_1")
	cache.InvalidateTracking(ctx, gw, nil, "ord_1", "", "usr_1")
	cache.InvalidateUser(ctx, gw, nil, "sub-1", "usr_1")
}

// Identity is redacted out of every telemetry surface, and a cascade log is one.
func TestInvalidationLogsNoRawKeys(t *testing.T) {
	gw, _ := live(t)
	var buf strings.Builder
	log := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	cache.InvalidateUser(t.Context(), gw, log, "sub-1", "usr_1")
	cache.InvalidateTracking(t.Context(), gw, log, "ord_1", "sub-1", "usr_1")

	if strings.Contains(buf.String(), "tracking:index:v1:sub-1") {
		t.Errorf("a full cache key reached the log: %s", buf.String())
	}
}

// commandLog records what actually reached Redis, so a test can assert HOW a
// sweep was performed and not merely that it worked. KEYS would pass every
// outcome assertion in this file while being the wrong implementation.
type commandLog struct{ seen []string }

func (c *commandLog) reset() { c.seen = nil }

func (c *commandLog) names() []string { return c.seen }

func (c *commandLog) saw(name string) bool { return c.count(name) > 0 }

func (c *commandLog) count(name string) int {
	total := 0
	for _, got := range c.seen {
		if strings.EqualFold(got, name) {
			total++
		}
	}
	return total
}

// recorded is live(t) plus a command recorder on the miniredis server.
func recorded(t *testing.T) (cache.Gateway, *miniredis.Miniredis, *commandLog) {
	t.Helper()
	server := miniredis.RunT(t)
	log := &commandLog{}
	server.Server().SetPreHook(func(_ *miniserver.Peer, name string, _ ...string) bool {
		log.seen = append(log.seen, name)
		return false // fall through to the real handler
	})
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return cache.NewGateway(client, cache.NewNoopMetrics(), quiet()), server, log
}
