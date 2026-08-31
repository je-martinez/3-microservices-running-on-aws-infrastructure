package redis_test

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// live starts a miniredis and returns a gateway over it.
func live(t *testing.T) (cache.Gateway, *miniredis.Miniredis) {
	t.Helper()
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return cache.NewGateway(client, cache.NewNoopMetrics(), quiet()), server
}

func TestGetMissThenSetThenHit(t *testing.T) {
	gw, _ := live(t)
	ctx := t.Context()
	key := "tracking:order:v1:sub:usr_1:ord_1"

	if entry := gw.Get(ctx, key); entry.Hit || entry.Bypassed {
		t.Fatalf("cold key: Hit=%v Bypassed=%v, want a plain MISS", entry.Hit, entry.Bypassed)
	}

	gw.Set(ctx, key, map[string]string{"order_id": "ord_1"}, 60*time.Second, "")

	entry := gw.Get(ctx, key)
	if !entry.Hit {
		t.Fatal("expected a HIT after Set")
	}
	if !strings.Contains(string(entry.Value), `"order_id":"ord_1"`) {
		t.Errorf("Value = %s", entry.Value)
	}
	if entry.TTLRemaining <= 0 || entry.TTLRemaining > 60 {
		t.Errorf("TTLRemaining = %d, want 1..60", entry.TTLRemaining)
	}
}

// Redis -1 (no expiry) and -2 (gone) both mean "unknown": omit X-Cache-TTL.
func TestTTLUnknownIsZero(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	key := "tracking:order:v1:sub:usr_1:ord_1"

	// Written with no expiry at all -> Redis answers -1.
	if err := server.Set(key, `{"order_id":"ord_1"}`); err != nil {
		t.Fatalf("seeding the key failed: %v", err)
	}

	entry := gw.Get(ctx, key)
	if !entry.Hit {
		t.Fatal("expected a HIT")
	}
	if entry.TTLRemaining != 0 {
		t.Errorf("TTLRemaining = %d for a key with no expiry, want 0 (unknown, header omitted)", entry.TTLRemaining)
	}
}

// A malformed payload is a MISS, not a BYPASS: Redis is fine, the ENTRY is not,
// so the right answer is to recompute and overwrite it.
func TestMalformedPayloadIsAMissNotABypass(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	key := "tracking:order:v1:sub:usr_1:ord_1"

	if err := server.Set(key, "{not json"); err != nil {
		t.Fatalf("seeding the malformed payload failed: %v", err)
	}

	entry := gw.Get(ctx, key)
	if entry.Hit {
		t.Error("a malformed payload must not be a HIT")
	}
	if entry.Bypassed {
		t.Error("a malformed payload is a MISS, not a BYPASS: collapsing them makes an outage read as a poor hit rate")
	}
}

// A malformed payload is logged with its own machine-readable reason, distinct
// from the Redis-outage one.
func TestMalformedPayloadIsLoggedWithItsOwnReason(t *testing.T) {
	var buf strings.Builder
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	gw := cache.NewGateway(client, cache.NewNoopMetrics(),
		slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))

	if err := server.Set("tracking:order:v1:sub-abc:usr_1:ord_1", "{not json"); err != nil {
		t.Fatalf("seeding the malformed payload failed: %v", err)
	}
	gw.Get(t.Context(), "tracking:order:v1:sub-abc:usr_1:ord_1")

	out := buf.String()
	if !strings.Contains(out, "cache_entry_unreadable") {
		t.Errorf("no cache_entry_unreadable line in: %s", out)
	}
	if !strings.Contains(out, "malformed_payload") {
		t.Errorf("no reason=malformed_payload in: %s", out)
	}
	if strings.Contains(out, "sub-abc") || strings.Contains(out, "usr_1") {
		t.Errorf("the log line leaked identity from the key: %s", out)
	}
}

// Any OTHER Redis failure is a BYPASS.
func TestRedisFailureIsABypass(t *testing.T) {
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	gw := cache.NewGateway(client, cache.NewNoopMetrics(), quiet())

	server.Close() // the server is now unreachable

	entry := gw.Get(t.Context(), "tracking:order:v1:sub:usr_1:ord_1")
	if entry.Hit {
		t.Error("an unreachable Redis must not report a HIT")
	}
	if !entry.Bypassed {
		t.Error("an unreachable Redis must report a BYPASS, distinguishable from a MISS")
	}
}

// The gateway never returns an error to the handler — every method's signature
// makes that structural, and none of them may panic against a dead server.
func TestGatewayNeverFailsTheCaller(t *testing.T) {
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	gw := cache.NewGateway(client, cache.NewNoopMetrics(), quiet())
	server.Close()

	ctx := t.Context()
	gw.Get(ctx, "tracking:order:v1:s:u:o")
	gw.Set(ctx, "tracking:order:v1:s:u:o", map[string]string{"a": "b"}, time.Minute, "tracking:index:v1:s:u")
	gw.Invalidate(ctx, "tracking:order:v1:s:u:o")
	gw.InvalidateIndex(ctx, "tracking:index:v1:s:u")
}

// Set records the key in the per-user index SET and gives the SET its own,
// LONGER TTL — an index that expired first would orphan the entries it is the
// only handle on.
func TestSetRecordsTheKeyInTheIndexWithALongerTTL(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	key := "tracking:list:v1:sub:usr_1:abcdef0123456789"
	indexKey := "tracking:index:v1:sub:usr_1"

	gw.Set(ctx, key, []string{"ord_1"}, 60*time.Second, indexKey)

	members, err := server.SMembers(indexKey)
	if err != nil {
		t.Fatalf("index SET missing: %v", err)
	}
	if len(members) != 1 || members[0] != key {
		t.Errorf("index members = %v, want [%s]", members, key)
	}

	entryTTL := server.TTL(key)
	indexTTL := server.TTL(indexKey)
	if indexTTL <= entryTTL {
		t.Errorf("index TTL %v is not longer than the entry TTL %v; the index must never expire first", indexTTL, entryTTL)
	}
	if indexTTL != time.Hour {
		t.Errorf("index TTL = %v, want 1h", indexTTL)
	}
}

// InvalidateIndex deletes every member and then the SET, using SMEMBERS+DEL —
// never KEYS/SCAN, both of which are O(N) over the whole keyspace.
func TestInvalidateIndexDeletesMembersAndTheSet(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	indexKey := "tracking:index:v1:sub:usr_1"
	a := "tracking:list:v1:sub:usr_1:aaaaaaaaaaaaaaaa"
	b := "tracking:order:v1:sub:usr_1:ord_2"

	gw.Set(ctx, a, []string{"x"}, time.Minute, indexKey)
	gw.Set(ctx, b, map[string]string{"y": "z"}, time.Minute, indexKey)

	gw.InvalidateIndex(ctx, indexKey)

	for _, key := range []string{a, b, indexKey} {
		if server.Exists(key) {
			t.Errorf("%s survived InvalidateIndex", key)
		}
	}
}

func TestInvalidateDeletesNamedKeysAndToleratesAbsentOnes(t *testing.T) {
	gw, server := live(t)
	ctx := t.Context()
	key := "tracking:order:v1:sub:usr_1:ord_1"

	gw.Set(ctx, key, map[string]string{"a": "b"}, time.Minute, "")
	gw.Invalidate(ctx, key, "tracking:order:v1:sub:usr_1:never_written")

	if server.Exists(key) {
		t.Error("the named key survived Invalidate")
	}
}

func TestInvalidateWithNoKeysIsANoop(t *testing.T) {
	gw, _ := live(t)
	gw.Invalidate(t.Context())
}

// The null gateway is what CACHE_ENABLED=false binds. Its Get is a plain MISS
// with Bypassed=false, and the routes read the flag to decide whether to emit a
// header at all — so a disabled cache emits NO X-Cache header.
func TestNullGateway(t *testing.T) {
	gw := cache.NewNullGateway()
	ctx := t.Context()

	entry := gw.Get(ctx, "tracking:order:v1:s:u:o")
	if entry.Hit {
		t.Error("the null gateway must never report a HIT")
	}
	if entry.Bypassed {
		t.Error("the null gateway reports a plain MISS, not a BYPASS")
	}
	gw.Set(ctx, "k", "v", time.Minute, "i")
	gw.Invalidate(ctx, "k")
	gw.InvalidateIndex(ctx, "i")
}

// Both timeouts share one budget, and retries are DISABLED: a retry would spend
// the budget twice, turning a 50ms fail-open guarantee into a 100ms one.
func TestNewClientTimeoutsAndRetries(t *testing.T) {
	client := cache.NewClient("localhost", 6379, 50)
	t.Cleanup(func() { _ = client.Close() })

	opts := client.Options()
	want := 50 * time.Millisecond
	if opts.DialTimeout != want {
		t.Errorf("DialTimeout = %v, want %v", opts.DialTimeout, want)
	}
	if opts.ReadTimeout != want {
		t.Errorf("ReadTimeout = %v, want %v", opts.ReadTimeout, want)
	}
	if opts.WriteTimeout != want {
		t.Errorf("WriteTimeout = %v, want %v", opts.WriteTimeout, want)
	}
	// NewClient must PASS -1, which is how go-redis spells "disabled" (passing 0
	// would mean "use the default of 3" — the trap this asserts against).
	//
	// It is asserted as 0 because the sentinel is consumed at construction:
	// goredis.NewClient clones the Options and runs init(), which rewrites -1 to
	// 0 ("zero retries") and 0 to 3. Options() returns that post-init clone, so
	// -1 is unobservable here and 0 is the observable proof that retries are off.
	// Asserting -1 would fail against a CORRECT implementation, and asserting
	// nothing would let the 0-means-3 default through silently.
	if opts.MaxRetries != 0 {
		t.Errorf("MaxRetries = %d, want 0 (retries disabled after init); a retry doubles the timeout budget", opts.MaxRetries)
	}
	if opts.Addr != "localhost:6379" {
		t.Errorf("Addr = %q", opts.Addr)
	}
}

// Redis errors reach the caller as a BYPASS and are logged with a
// machine-readable reason, but never with a stack trace: an outage produces one
// of these per request.
func TestBypassIsLoggedWithAReason(t *testing.T) {
	var buf strings.Builder
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	gw := cache.NewGateway(client, cache.NewNoopMetrics(),
		slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	server.Close()

	gw.Get(t.Context(), "tracking:order:v1:sub-abc:usr_1:ord_1")

	out := buf.String()
	if !strings.Contains(out, "cache_unavailable") {
		t.Errorf("no cache_unavailable line in: %s", out)
	}
	if !strings.Contains(out, "redis_unavailable") {
		t.Errorf("no reason=redis_unavailable in: %s", out)
	}
	// The full key embeds identity; only the prefix may be logged.
	if strings.Contains(out, "sub-abc") || strings.Contains(out, "usr_1") {
		t.Errorf("the log line leaked identity from the key: %s", out)
	}
	if !strings.Contains(out, "tracking:order:v1") {
		t.Errorf("the log line should carry the redacted prefix: %s", out)
	}
}

// The metrics port is declared BY THIS PACKAGE, narrow, so the CloudWatch
// publisher satisfies it structurally without this package importing it.
func TestGatewayPublishesResultMetrics(t *testing.T) {
	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })

	spy := &recordingMetrics{}
	gw := cache.NewGateway(client, spy, quiet())
	ctx := t.Context()
	key := "tracking:order:v1:sub-abc:usr_1:ord_1"

	gw.Get(ctx, key) // miss
	gw.Set(ctx, key, map[string]string{"a": "b"}, time.Minute, "")
	gw.Get(ctx, key) // hit

	results := spy.resultsFor(cache.MetricCacheRequests)
	if len(results) != 2 || results[0] != cache.ResultMiss || results[1] != cache.ResultHit {
		t.Errorf("Result dimensions = %v, want [miss hit]", results)
	}
	// A dimension VALUE is billed cardinality and an export destination: never
	// the full key.
	for _, dims := range spy.dims {
		for _, dim := range dims {
			if strings.Contains(dim[1], "sub-abc") || strings.Contains(dim[1], "usr_1") {
				t.Errorf("metric dimension %v leaked identity", dim)
			}
		}
	}
	if !spy.sawMetric(cache.MetricCacheOperationDuration) {
		t.Errorf("no %s published; metrics = %v", cache.MetricCacheOperationDuration, spy.names)
	}
}

type recordingMetrics struct {
	names []string
	dims  [][][2]string
}

func (r *recordingMetrics) Publish(_ context.Context, name string, _ float64, dimensions [][2]string) {
	r.names = append(r.names, name)
	r.dims = append(r.dims, dimensions)
}

func (r *recordingMetrics) sawMetric(name string) bool {
	for _, got := range r.names {
		if got == name {
			return true
		}
	}
	return false
}

func (r *recordingMetrics) resultsFor(name string) []string {
	var out []string
	for i, got := range r.names {
		if got != name {
			continue
		}
		for _, dim := range r.dims[i] {
			if dim[0] == "Result" {
				out = append(out, dim[1])
			}
		}
	}
	return out
}
