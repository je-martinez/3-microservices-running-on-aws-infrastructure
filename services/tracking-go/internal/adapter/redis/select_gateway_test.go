package redis_test

import (
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

// TestSelectGatewayConstructsNoClientWhenDisabled is the point of this seam.
//
// "CACHE_ENABLED=false uses the null gateway" is the WEAK claim, and a service
// could satisfy it while still dialling Redis at startup and holding a pool open
// for nothing. The STRONG claim — that no client is constructed AT ALL — is what
// makes the flag a real kill switch: a runtime with the cache off then needs no
// reachable Redis to boot, which is exactly what the local suite and any
// cache-less environment depend on.
//
// Asserted by counting factory invocations, because "was a client built?" is not
// otherwise observable from outside the composition root.
func TestSelectGatewayConstructsNoClientWhenDisabled(t *testing.T) {
	built := 0
	factory := func() *goredis.Client {
		built++
		return goredis.NewClient(&goredis.Options{Addr: "127.0.0.1:1"})
	}

	gateway, closer := cache.SelectGateway(false, factory, nil, nil)

	if built != 0 {
		t.Fatalf("the client factory ran %d time(s) with CACHE_ENABLED=false; it must not run at all", built)
	}
	if gateway == nil {
		t.Fatal("gateway is nil; a disabled cache must still yield the NULL gateway, never nil")
	}
	if closer != nil {
		t.Fatal("a closer was returned though no client was built")
	}

	// The null gateway must be USABLE, not merely non-nil: every read and
	// invalidation path calls straight through it with no flag check of its own,
	// so a nil here would panic on the first request rather than skip the cache.
	if entry := gateway.Get(t.Context(), "tracking:order:sub-1:usr_1:ord_1"); entry.Hit {
		t.Fatal("the null gateway reported a hit")
	}
	gateway.Set(t.Context(), "k", "v", time.Minute, "")
	gateway.Invalidate(t.Context(), "k")
	gateway.InvalidateIndex(t.Context(), "idx")
}

// TestSelectGatewayBuildsExactlyOneClientWhenEnabled pins the other direction,
// and the COUNT.
//
// One client for the process. The go-redis client IS a connection pool, so
// building one per caller would multiply the pools and leak sockets.
func TestSelectGatewayBuildsExactlyOneClientWhenEnabled(t *testing.T) {
	server := miniredis.RunT(t)

	built := 0
	factory := func() *goredis.Client {
		built++
		return goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	}

	gateway, closer := cache.SelectGateway(true, factory, nil, nil)

	if built != 1 {
		t.Fatalf("the client factory ran %d time(s) with CACHE_ENABLED=true, want exactly 1", built)
	}
	if gateway == nil {
		t.Fatal("gateway is nil with the cache enabled")
	}
	if closer == nil {
		t.Fatal("no closer was returned; the client's connection pool would be leaked at shutdown")
	}

	// A REAL round trip, so the returned gateway is proven to be the Redis-backed
	// one rather than the null gateway with a closer bolted on — which would pass
	// every other assertion here.
	const key = "tracking:order:sub-1:usr_1:ord_1"
	gateway.Set(t.Context(), key, map[string]string{"order_id": "ord_1"}, time.Minute, "")
	if entry := gateway.Get(t.Context(), key); !entry.Hit {
		t.Fatal("the gateway missed a key it had just written; it is not backed by the client")
	}

	if err := closer(); err != nil {
		t.Fatalf("closer: %v", err)
	}
}
