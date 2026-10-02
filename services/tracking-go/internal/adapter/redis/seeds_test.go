package redis_test

import (
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	goredis "github.com/redis/go-redis/v9"

	cache "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/redis"
)

func dimsKey(dims [][2]string) string { return fmt.Sprint(dims) }

func TestCacheRequestDimensionsAreEveryPrefixTimesEveryResult(t *testing.T) {
	var got []string
	for _, dims := range cache.CacheRequestDimensions() {
		got = append(got, dimsKey(dims))
	}
	var want []string
	for _, prefix := range []string{"tracking:order:v1", "tracking:list:v1", "identity:sub-to-user:v1"} {
		for _, result := range []string{"hit", "miss", "bypass"} {
			want = append(want, dimsKey([][2]string{
				{"Service", "tracking"}, {"KeyPrefix", prefix}, {"Result", result},
			}))
		}
	}
	sort.Strings(got)
	sort.Strings(want)
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("CacheRequestDimensions() =\n%v\nwant\n%v", got, want)
	}
}

// A seeded set Get never publishes is a second, always-zero series beside the
// real one, and a card querying the real set still throws. So every set Get
// ACTUALLY publishes, per key builder and per result, must be seeded.
func TestEveryDimensionSetGetPublishesIsSeeded(t *testing.T) {
	seeded := map[string]bool{}
	for _, dims := range cache.CacheRequestDimensions() {
		seeded[dimsKey(dims)] = true
	}

	orderKey, _ := cache.TrackingOrderKey("sub-a", "usr_b", "ord_1")
	listKey, _ := cache.TrackingListKey("sub-a", "usr_b", []string{"ord_1", "ord_2"})
	keys := []string{orderKey, listKey, cache.IdentityKey("sub-a")}

	server := miniredis.RunT(t)
	client := goredis.NewClient(&goredis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	spy := &recordingMetrics{}
	gw := cache.NewGateway(client, spy, quiet())
	ctx := t.Context()

	for _, key := range keys {
		gw.Get(ctx, key) // miss
		gw.Set(ctx, key, "v", time.Minute, "")
		gw.Get(ctx, key) // hit
	}
	server.Close()
	for _, key := range keys {
		gw.Get(ctx, key) // bypass
	}

	published := 0
	for i, name := range spy.names {
		if name != cache.MetricCacheRequests {
			continue
		}
		published++
		if !seeded[dimsKey(spy.dims[i])] {
			t.Errorf("Get published %s under %v, which is not seeded", name, spy.dims[i])
		}
	}
	if published != 9 {
		t.Fatalf("Get published %d %s data, want 9 (3 keys x hit/miss/bypass)", published, cache.MetricCacheRequests)
	}
}
