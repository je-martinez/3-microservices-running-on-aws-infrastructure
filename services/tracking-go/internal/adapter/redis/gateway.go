package redis

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	goredis "github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	oteltrace "go.opentelemetry.io/otel/trace"

	tracing "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/otel"
)

// The cache result vocabulary. The lowercase forms are the metric dimension and
// span attribute values; the uppercase ones are the X-Cache header, exactly as
// it appears on the wire.
//
// THREE values, not two, and that is the point. A MISS means "Redis answered,
// and had nothing"; a BYPASS means "Redis did not answer". Collapsing them would
// make an outage read as a poor hit rate on the dashboard, which is the one
// reading that would send an operator to look at the wrong system.
//
// When the cache is DISABLED no header is emitted at all — not MISS, not BYPASS.
// That distinction lives in the route, which reads the flag; see nullGateway.
const (
	ResultHit    = "hit"
	ResultMiss   = "miss"
	ResultBypass = "bypass"

	HeaderHit    = "HIT"
	HeaderMiss   = "MISS"
	HeaderBypass = "BYPASS"
)

// Metric names, shared with the collector's queries and the dashboards.
//
// Declared HERE rather than imported from the cloudwatch adapter, together with
// the Metrics port below: this package must not depend on the publisher that
// happens to satisfy it. The names match the cloudwatch package's constants by
// contract, not by import.
const (
	MetricCacheRequests          = "cache_requests_total"
	MetricCacheOperationDuration = "cache_operation_duration_ms"
)

// ServiceDimension is the Service dimension value every metric from this service
// carries.
const ServiceDimension = "tracking"

// TTLs. The index SET's is deliberately LONGER than any entry it tracks: an
// index that expired FIRST would leave orphaned entries no invalidation could
// ever reach, and they would then serve stale data for the remainder of their
// own TTL. Short enough that a user who stops reading does not leave a SET
// behind forever.
const (
	EntryTTL    = 60 * time.Second
	IdentityTTL = time.Hour
	IndexTTL    = time.Hour
)

// RedisLike is the subset of the go-redis API this gateway uses, declared here
// by the consumer so a real client, a miniredis-backed one and a hand-written
// double all satisfy it structurally.
type RedisLike interface {
	Get(ctx context.Context, key string) *goredis.StringCmd
	Set(ctx context.Context, key string, value any, ttl time.Duration) *goredis.StatusCmd
	Del(ctx context.Context, keys ...string) *goredis.IntCmd
	TTL(ctx context.Context, key string) *goredis.DurationCmd
	SAdd(ctx context.Context, key string, members ...any) *goredis.IntCmd
	SMembers(ctx context.Context, key string) *goredis.StringSliceCmd
	Expire(ctx context.Context, key string, ttl time.Duration) *goredis.BoolCmd
}

// Metrics is the metrics port, declared BY THIS PACKAGE and kept to the one
// method it calls. The CloudWatch publisher satisfies it structurally, so the
// cache never imports the metrics adapter and the dependency points the right
// way.
type Metrics interface {
	Publish(ctx context.Context, name string, value float64, dimensions [][2]string)
}

type noopMetrics struct{}

// NewNoopMetrics returns a Metrics that discards everything — for suites and for
// runtimes that must not reach CloudWatch.
func NewNoopMetrics() Metrics { return noopMetrics{} }

func (noopMetrics) Publish(context.Context, string, float64, [][2]string) {}

// Entry is the outcome of a Get.
type Entry struct {
	Hit   bool
	Value []byte
	// TTLRemaining in seconds. ZERO means UNKNOWN: Redis answers -1 for a key
	// with no expiry and -2 for one that no longer exists, and neither is a
	// duration — the route then omits X-Cache-TTL entirely rather than
	// publishing a negative number as a header.
	TTLRemaining int
	Bypassed     bool
}

// Gateway reads, writes and invalidates cache entries. NO METHOD RETURNS AN
// ERROR, and that is structural rather than incidental: a cache is an
// optimization, and an optimization that can fail a request is a liability.
type Gateway interface {
	Get(ctx context.Context, key string) Entry
	Set(ctx context.Context, key string, value any, ttl time.Duration, indexKey string)
	Invalidate(ctx context.Context, keys ...string)
	InvalidateIndex(ctx context.Context, indexKey string)
}

type gateway struct {
	client  RedisLike
	metrics Metrics
	log     *slog.Logger
}

// NewGateway builds the real gateway.
//
// The spans below are hand-written rather than taken from an instrumentation
// package, and deliberately: cache.result and cache.ttl_remaining are BUSINESS
// facts, not transport facts, and no instrumentation can know them.
//
// The full key never leaves this file. Every response key embeds cognito_sub and
// user_id; a span attribute, a metric dimension and a log field are all export
// destinations, so all three receive PrefixOf(key) and nothing more. The rule is
// enforced by there being exactly one place — this file — holding both the key
// and a telemetry call.
func NewGateway(client RedisLike, metrics Metrics, log *slog.Logger) Gateway {
	if log == nil {
		log = slog.Default()
	}
	if metrics == nil {
		metrics = NewNoopMetrics()
	}
	return &gateway{client: client, metrics: metrics, log: log}
}

func (g *gateway) Get(ctx context.Context, key string) Entry {
	prefix := PrefixOf(key)
	started := time.Now()

	ctx, span := tracing.Tracer(tracing.TracerCache).Start(ctx, "cache.get",
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(attribute.String("cache.key_prefix", prefix)),
	)
	defer span.End()

	raw, err := g.client.Get(ctx, key).Bytes()
	switch {
	case errors.Is(err, goredis.Nil):
		span.SetAttributes(attribute.String("cache.result", ResultMiss))
		g.record(ctx, ResultMiss, prefix, "get", started)
		return Entry{}
	case err != nil:
		span.SetAttributes(attribute.String("cache.result", ResultBypass))
		g.warnUnavailable(ctx, "get", prefix)
		g.record(ctx, ResultBypass, prefix, "get", started)
		return Entry{Bypassed: true}
	}

	// A payload Redis returned but JSON cannot parse: a truncated write, a key
	// someone else wrote, a shape predating a version bump. Treated as a MISS,
	// NOT a BYPASS — Redis is fine, the ENTRY is not, so the right answer is to
	// recompute and overwrite it.
	if !json.Valid(raw) {
		span.SetAttributes(attribute.String("cache.result", ResultMiss))
		g.log.WarnContext(ctx, "cache_entry_unreadable",
			slog.String("app_event", "cache_entry_unreadable"),
			slog.String("reason", "malformed_payload"),
			slog.String("cache_key_prefix", prefix),
		)
		g.record(ctx, ResultMiss, prefix, "get", started)
		return Entry{}
	}

	ttl := g.readTTL(ctx, key)
	span.SetAttributes(attribute.String("cache.result", ResultHit))
	if ttl > 0 {
		span.SetAttributes(attribute.Int("cache.ttl_remaining", ttl))
	}
	g.record(ctx, ResultHit, prefix, "get", started)
	return Entry{Hit: true, Value: raw, TTLRemaining: ttl}
}

func (g *gateway) Set(ctx context.Context, key string, value any, ttl time.Duration, indexKey string) {
	prefix := PrefixOf(key)
	started := time.Now()

	ctx, span := tracing.Tracer(tracing.TracerCache).Start(ctx, "cache.set",
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(
			attribute.String("cache.key_prefix", prefix),
			attribute.Int("cache.ttl_remaining", int(ttl.Seconds())),
		),
	)
	defer span.End()
	defer g.record(ctx, "", prefix, "set", started)

	encoded, err := json.Marshal(value)
	if err != nil {
		g.warnUnavailable(ctx, "set", prefix)
		return
	}
	if err := g.client.Set(ctx, key, encoded, ttl).Err(); err != nil {
		g.warnUnavailable(ctx, "set", prefix)
		return
	}
	if indexKey == "" {
		return
	}
	if err := g.client.SAdd(ctx, indexKey, key).Err(); err != nil {
		g.warnUnavailable(ctx, "set", prefix)
		return
	}
	// Deliberately longer than any entry it indexes — see IndexTTL.
	if err := g.client.Expire(ctx, indexKey, IndexTTL).Err(); err != nil {
		g.warnUnavailable(ctx, "set", prefix)
	}
}

func (g *gateway) Invalidate(ctx context.Context, keys ...string) {
	if len(keys) == 0 {
		return
	}
	prefix := PrefixOf(keys[0])
	started := time.Now()

	ctx, span := tracing.Tracer(tracing.TracerCache).Start(ctx, "cache.invalidate",
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(
			attribute.String("cache.key_prefix", prefix),
			attribute.Int("cache.key_count", len(keys)),
		),
	)
	defer span.End()
	defer g.record(ctx, "", prefix, "invalidate", started)

	// Deleting an absent key is fine, and not an error.
	if err := g.client.Del(ctx, keys...).Err(); err != nil {
		g.warnUnavailable(ctx, "invalidate", prefix)
	}
}

// InvalidateIndex deletes every key the index names, then the index itself.
//
// This is the answer to "the list key embeds a hash I cannot reconstruct".
// KEYS/SCAN would be the other answer and is the wrong one: both are O(N) over
// the ENTIRE keyspace, KEYS blocks the server for the duration of the sweep, and
// neither is acceptable on a write path — every carrier callback would pay for
// the size of the whole cache.
func (g *gateway) InvalidateIndex(ctx context.Context, indexKey string) {
	prefix := PrefixOf(indexKey)
	started := time.Now()

	ctx, span := tracing.Tracer(tracing.TracerCache).Start(ctx, "cache.invalidate_index",
		oteltrace.WithSpanKind(oteltrace.SpanKindClient),
		oteltrace.WithAttributes(attribute.String("cache.key_prefix", prefix)),
	)
	defer span.End()
	defer g.record(ctx, "", prefix, "invalidate_index", started)

	members, err := g.client.SMembers(ctx, indexKey).Result()
	if err != nil {
		g.warnUnavailable(ctx, "invalidate_index", prefix)
		return
	}
	span.SetAttributes(attribute.Int("cache.key_count", len(members)))

	if len(members) > 0 {
		if err := g.client.Del(ctx, members...).Err(); err != nil {
			g.warnUnavailable(ctx, "invalidate_index", prefix)
			return
		}
	}
	if err := g.client.Del(ctx, indexKey).Err(); err != nil {
		g.warnUnavailable(ctx, "invalidate_index", prefix)
	}
}

// readTTL returns the seconds left on key, or 0 when Redis will not say.
//
// go-redis maps Redis's -1 (no expiry) and -2 (gone) onto negative durations;
// neither is a duration the caller can publish, so both become 0 and the route
// simply omits X-Cache-TTL.
func (g *gateway) readTTL(ctx context.Context, key string) int {
	ttl, err := g.client.TTL(ctx, key).Result()
	if err != nil || ttl <= 0 {
		return 0
	}
	return int(ttl.Seconds())
}

// warnUnavailable emits one WARN per failed operation, with a machine-readable
// reason.
//
// app_event=cache_unavailable is the token a dashboard alerts on. A stack trace
// is deliberately omitted: a Redis outage produces one of these per request, and
// a trace per request buries every other signal in the stream.
func (g *gateway) warnUnavailable(ctx context.Context, operation, prefix string) {
	g.log.WarnContext(ctx, "cache_unavailable",
		slog.String("app_event", "cache_unavailable"),
		slog.String("reason", "redis_unavailable"),
		slog.String("cache_operation", operation),
		slog.String("cache_key_prefix", prefix),
	)
}

// record publishes the two metrics for one operation. The port's contract is
// that Publish never fails, so there is no error handling here.
//
// An empty result means "this operation has no hit/miss/bypass outcome" (a write
// or an invalidation), and then only the duration is published — a Result
// dimension with an empty value would be a real, queryable series meaning
// nothing.
func (g *gateway) record(ctx context.Context, result, prefix, operation string, started time.Time) {
	if result != "" {
		g.metrics.Publish(ctx, MetricCacheRequests, 1, [][2]string{
			{"Service", ServiceDimension},
			{"KeyPrefix", prefix},
			{"Result", result},
		})
	}
	g.metrics.Publish(ctx, MetricCacheOperationDuration,
		float64(time.Since(started).Microseconds())/1000.0,
		[][2]string{
			{"Service", ServiceDimension},
			{"Operation", operation},
		})
}

// nullGateway is the binding used when CACHE_ENABLED=false.
//
// NOT a gateway with a flag inside it: a null object means the routes have
// exactly one code path, and "the cache is off" is expressed by which object is
// bound rather than by a branch in every handler. Its Get returns a plain MISS
// with Bypassed=false, and the routes read the flag to decide whether to emit a
// header at all — so a disabled cache emits NO X-Cache header, never MISS and
// never BYPASS.
type nullGateway struct{}

// NewNullGateway returns the no-op gateway.
func NewNullGateway() Gateway { return nullGateway{} }

func (nullGateway) Get(context.Context, string) Entry                       { return Entry{} }
func (nullGateway) Set(context.Context, string, any, time.Duration, string) {}
func (nullGateway) Invalidate(context.Context, ...string)                   {}
func (nullGateway) InvalidateIndex(context.Context, string)                 {}
